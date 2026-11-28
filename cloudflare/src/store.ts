import { DurableObject } from 'cloudflare:workers';

// The app's database on Cloudflare: one Durable Object holding every file the
// server keeps under data/ (pinned defaults, booklets, screenshots, added
// kalam PDFs). Only the container reaches it, as http://store.internal (see
// `outboundByHost` in index.ts): it is not on the public URL, so it needs no
// password and nothing in it is public.
//
//   GET    /list?since=<rev>  → { head, files: [name, sha][] } or { head, unchanged: true }
//   GET    /file/<name>       → the file's bytes (404 when there is none)
//   PUT    /file/<name>       → store the body; header x-sha is its git blob sha
//   DELETE /file/<name>       → remove it
//
// Each write moves `rev` on by one, so the server lists again only when
// something changed. A file is kept in parts of at most 1 MB (a SQLite row
// holds 2 MB at most), written under a staging name first and swapped in at
// once, so a half-sent upload never replaces a whole file.

const PART = 1024 * 1024;

export class Store extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, sha TEXT NOT NULL, size INTEGER NOT NULL, parts INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS parts (name TEXT NOT NULL, i INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (name, i));
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
    `);
    // Staging parts of uploads cut off by a restart.
    this.sql.exec(`DELETE FROM parts WHERE name LIKE '#stage:%'`);
  }

  private rev(): number {
    return (this.sql.exec<{ v: number }>(`SELECT v FROM meta WHERE k = 'rev'`).toArray()[0]?.v ?? 0);
  }

  /** Moves the revision on; returns [before, after]. */
  private bump(): [number, number] {
    const before = this.rev();
    this.sql.exec(`INSERT INTO meta (k, v) VALUES ('rev', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, before + 1);
    return [before, before + 1];
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/list' && request.method === 'GET') {
      const head = String(this.rev());
      if (url.searchParams.get('since') === head) return Response.json({ head, unchanged: true });
      const files = this.sql.exec<{ name: string; sha: string }>(`SELECT name, sha FROM files ORDER BY name`).toArray().map((r) => [r.name, r.sha]);
      return Response.json({ head, files });
    }
    const match = /^\/file\/(.+)$/.exec(url.pathname);
    if (!match) return new Response('Not found', { status: 404 });
    const name = decodeURIComponent(match[1]);
    if (!name || name.startsWith('#') || name.split('/').some((p) => p === '..' || p === '')) return new Response('Bad name', { status: 400 });

    if (request.method === 'GET') {
      const row = this.sql.exec<{ size: number; parts: number }>(`SELECT size, parts FROM files WHERE name = ?`, name).toArray()[0];
      if (!row) return new Response('Not found', { status: 404 });
      // Sent a part at a time: a large PDF is never held whole in memory.
      let i = 0;
      const sql = this.sql;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i >= row.parts) return controller.close();
          const part = sql.exec<{ data: ArrayBuffer }>(`SELECT data FROM parts WHERE name = ? AND i = ?`, name, i++).toArray()[0];
          if (!part) return controller.error(new Error(`Part ${i - 1} of ${name} is missing.`));
          controller.enqueue(new Uint8Array(part.data));
        },
      });
      return new Response(body, { headers: { 'Content-Length': String(row.size), 'Content-Type': 'application/octet-stream' } });
    }

    if (request.method === 'PUT') {
      const sha = request.headers.get('x-sha') ?? '';
      if (!/^[0-9a-f]{40}$/.test(sha)) return new Response('x-sha missing', { status: 400 });
      const stage = `#stage:${crypto.randomUUID()}`;
      let parts = 0, size = 0;
      let buffer = new Uint8Array(PART), filled = 0;
      const flush = () => {
        if (!filled) return;
        this.sql.exec(`INSERT INTO parts (name, i, data) VALUES (?, ?, ?)`, stage, parts++, buffer.slice(0, filled).buffer);
        filled = 0;
      };
      try {
        if (request.body) {
          const reader = request.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            let at = 0;
            while (at < value.length) {
              const take = Math.min(PART - filled, value.length - at);
              buffer.set(value.subarray(at, at + take), filled);
              filled += take; at += take; size += take;
              if (filled === PART) flush();
            }
          }
        }
        flush();
      } catch (error) {
        this.sql.exec(`DELETE FROM parts WHERE name = ?`, stage);
        return new Response(`Upload cut off: ${(error as Error).message}`, { status: 400 });
      }
      const declared = Number(request.headers.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared !== size) {
        this.sql.exec(`DELETE FROM parts WHERE name = ?`, stage);
        return new Response(`Upload cut off: ${size} of ${declared} bytes`, { status: 400 });
      }
      const [parent, head] = this.ctx.storage.transactionSync(() => {
        this.sql.exec(`DELETE FROM parts WHERE name = ?`, name);
        this.sql.exec(`UPDATE parts SET name = ? WHERE name = ?`, name, stage);
        this.sql.exec(
          `INSERT INTO files (name, sha, size, parts, updated) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET sha = excluded.sha, size = excluded.size, parts = excluded.parts, updated = excluded.updated`,
          name, sha, size, parts, Date.now(),
        );
        return this.bump();
      });
      return Response.json({ parent: String(parent), head: String(head), sha });
    }

    if (request.method === 'DELETE') {
      const [parent, head] = this.ctx.storage.transactionSync(() => {
        this.sql.exec(`DELETE FROM parts WHERE name = ?`, name);
        this.sql.exec(`DELETE FROM files WHERE name = ?`, name);
        return this.bump();
      });
      return Response.json({ parent: String(parent), head: String(head), sha: null });
    }

    return new Response('Method not allowed', { status: 405 });
  }
}
