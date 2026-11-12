// The app's database is a folder in its GitHub repository: every file the
// server keeps under data/ (pinned defaults, the open booklets, screenshots,
// added kalam PDFs) is committed there, and the server keeps itself in step
// with that folder, so the free host's wiped disk (every restart) loses
// nothing and every device sees the same work.
//
//  - App → repo: files written under data/ are committed together, in one
//    commit, a few seconds after they stop changing (on shutdown, at once).
//    A commit that fails is tried again, with growing pauses (and GitHub's
//    own Retry-After), until it goes through: nothing waiting is ever dropped.
//  - Repo → app: at start, and then every GITHUB_STORAGE_SYNC_SECONDS (60),
//    files changed in the folder are brought down: the booklets, defaults and
//    PDF lists always, screenshots and PDFs the server already holds when
//    they change, and any other file the first time something asks for it.
//  - Until the first sync has gone through, the stored work is unknown, not
//    absent: the booklets and defaults are neither served nor replaced
//    (StorageUnavailable, answered 503), so a GitHub outage or an expired
//    token at wake-up never passes for an empty folder.
//
// Set GITHUB_STORAGE_TOKEN (Render → Environment): a fine-grained token with
// "Contents: read and write" on the repository. The folder is
// GITHUB_STORAGE_DIR ("storage") on the branch GITHUB_STORAGE_BRANCH
// ("storage", made from the default branch the first time) of
// GITHUB_STORAGE_REPO (default: the repository Render deploys). Not main:
// every save would be a commit that redeploys and restarts the app.
import { createReadStream, existsSync } from 'node:fs';
import { readFile as readLocal, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** The stored work could not be checked (GitHub unreachable, rate limited,
 * a bad token): unknown, which is not the same as absent. */
export class StorageUnavailable extends Error {
  readonly status = 503;
}
/** GitHub asked to wait (rate limit): `wait` ms. */
class Throttled extends Error {
  constructor(message: string, readonly wait: number) { super(message); }
}

/** A change waiting to go up: new content (in memory, or read from the file
 * when large) or a deletion. */
interface Pending { data?: Buffer; file?: string; deleted?: boolean; at: number }
interface Change { name: string; entry: Pending }

interface Backend {
  where: string;
  /** The stored copy of `name` written to `file` (a temporary name the
   * caller then renames); false when there is none. */
  download(name: string, file: string): Promise<boolean>;
  /** Every change in one commit. Returns the new head, the head it was made
   * on, and each file's new blob sha (null: deleted). */
  commit(changes: Change[]): Promise<{ head: string; parent: string; shas: Map<string, string | null> } | null>;
  /** Every file in the folder with its git blob sha, or null when the folder
   * has not changed since `since` (a commit). */
  list(since: string | null): Promise<{ head: string; files: Map<string, string> } | null>;
  /** Drop the branch's history when it has grown long (see squash below). */
  squash(maxCommits: number): Promise<string | null>;
  /** How long a file must stay unchanged before it is sent (ms). */
  quiet: number;
}

const segments = (name: string) => name.split('/').map(encodeURIComponent).join('/');
/** Git's own id for some content. */
const blobSha = (data: Buffer) => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
/** Files above this size are streamed from disk, never held whole in memory
 * (an added 80 MB PDF, base64-encoded in JSON, would not fit beside the rest
 * on a 512 MB host). */
const STREAM_ABOVE = 4 * 1024 * 1024;

// ---- GitHub: a folder on a branch of the repository ----
function github(): Backend | null {
  const token = process.env.GITHUB_STORAGE_TOKEN ?? '';
  const repo = process.env.GITHUB_STORAGE_REPO ?? process.env.RENDER_GIT_REPO_SLUG ?? '';
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const branch = process.env.GITHUB_STORAGE_BRANCH ?? 'storage';
  const dir = (process.env.GITHUB_STORAGE_DIR ?? 'storage').replace(/^\/+|\/+$/g, '');
  const api = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');
  const headers = (init: { accept?: string; json?: boolean; length?: number }) => ({
    Authorization: `Bearer ${token}`, Accept: init.accept ?? 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'karbala-booklet',
    ...(init.json ? { 'Content-Type': 'application/json' } : {}), ...(init.length !== undefined ? { 'Content-Length': String(init.length) } : {}),
  });
  const failed = async (res: Response) => {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    // Rate limits: GitHub says how long to wait (Retry-After, or when the
    // hourly allowance comes back).
    const after = Number(res.headers.get('retry-after'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (res.status === 429 || (res.status === 403 && (after > 0 || res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(text)))) {
      const wait = after > 0 ? after * 1000 : reset > 0 ? Math.max(1000, reset * 1000 - Date.now()) : 60_000;
      return new Throttled(`GitHub ${res.status} (rate limited): ${text}`, wait);
    }
    return new Error(`GitHub ${res.status}: ${text}`);
  };
  const call = (route: string, init: { method?: string; body?: unknown; accept?: string } = {}) => fetch(`${api}/repos/${repo}${route}`, {
    method: init.method, signal: AbortSignal.timeout(90_000), headers: headers({ accept: init.accept, json: init.body !== undefined }),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  // Requests that create content (blobs, trees, commits, ref moves) are
  // spaced out: GitHub limits how many a minute it takes before it refuses.
  let nextWrite = 0;
  const paced = async () => {
    const wait = nextWrite - Date.now();
    nextWrite = Math.max(Date.now(), nextWrite) + 900;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
  const ok = async <T>(res: Response): Promise<T> => {
    if (!res.ok) throw await failed(res);
    return (await res.json()) as T;
  };
  const contents = (name: string) => `/contents/${segments(dir ? `${dir}/${name}` : name)}`;
  // The branch is made from the default branch the first time it is needed.
  let ready: Promise<void> | null = null;
  const ensureBranch = () => (ready ??= (async () => {
    const found = await call(`/branches/${encodeURIComponent(branch)}`);
    if (found.ok) return;
    if (found.status !== 404) throw await failed(found);
    const base = await ok<{ default_branch: string }>(await call(''));
    const sha = (await ok<{ object: { sha: string } }>(await call(`/git/ref/heads/${encodeURIComponent(base.default_branch)}`))).object.sha;
    await paced();
    const made = await call('/git/refs', { method: 'POST', body: { ref: `refs/heads/${branch}`, sha } });
    if (!made.ok && made.status !== 422) throw await failed(made); // 422: made meanwhile
  })().catch((error) => { ready = null; throw error; }));
  const headOf = async () => (await ok<{ object: { sha: string } }>(await call(`/git/ref/heads/${encodeURIComponent(branch)}`))).object.sha;

  type TreeEntry = { path: string; type: string; sha: string };
  /** Every blob under a tree. A recursive listing GitHub cuts short
   * (`truncated`, past about 100,000 entries or 7 MB) is walked one folder at
   * a time instead, so no file is ever missed. */
  const walk = async (sha: string, prefix: string, files: Map<string, string>) => {
    const whole = await ok<{ tree: TreeEntry[]; truncated?: boolean }>(await call(`/git/trees/${sha}?recursive=1`));
    if (!whole.truncated) {
      for (const e of whole.tree) if (e.type === 'blob') files.set(prefix + e.path, e.sha);
      return;
    }
    const level = await ok<{ tree: TreeEntry[]; truncated?: boolean }>(await call(`/git/trees/${sha}`));
    if (level.truncated) throw new Error(`The storage folder ${prefix || '/'} has too many files to list.`);
    for (const e of level.tree) {
      if (e.type === 'blob') files.set(prefix + e.path, e.sha);
      else if (e.type === 'tree') await walk(e.sha, `${prefix}${e.path}/`, files);
    }
  };
  /** A blob made from one change (the file streamed when large). */
  const blob = async ({ name, entry }: Change): Promise<string> => {
    await paced();
    let res: Response;
    if (entry.data) {
      res = await fetch(`${api}/repos/${repo}/git/blobs`, { method: 'POST', signal: AbortSignal.timeout(120_000), headers: headers({ json: true }), body: JSON.stringify({ content: entry.data.toString('base64'), encoding: 'base64' }) });
    } else {
      const file = entry.file!;
      const size = (await stat(file)).size;
      const head = Buffer.from('{"encoding":"base64","content":"'), tail = Buffer.from('"}');
      const body = async function* () {
        yield head;
        let rest = Buffer.alloc(0);
        for await (const chunk of createReadStream(file, { highWaterMark: 3 * 256 * 1024 })) {
          const buf = rest.length ? Buffer.concat([rest, chunk as Buffer]) : (chunk as Buffer);
          const cut = buf.length - (buf.length % 3);
          yield Buffer.from(buf.subarray(0, cut).toString('base64'));
          rest = Buffer.from(buf.subarray(cut));
        }
        yield Buffer.concat([Buffer.from(rest.toString('base64')), tail]);
      };
      res = await fetch(`${api}/repos/${repo}/git/blobs`, {
        method: 'POST', signal: AbortSignal.timeout(600_000), headers: headers({ json: true, length: head.length + 4 * Math.ceil(size / 3) + tail.length }),
        body: body() as unknown as BodyInit, duplex: 'half',
      } as RequestInit);
    }
    return (await ok<{ sha: string }>(res)).sha;
  };

  return {
    where: `github:${repo}@${branch}/${dir}`,
    quiet: 4000,
    async list(since) {
      await ensureBranch();
      const info = await ok<{ commit: { sha: string; commit: { tree: { sha: string } } } }>(await call(`/branches/${encodeURIComponent(branch)}`));
      const head = info.commit.sha;
      if (head === since) return null;
      const files = new Map<string, string>();
      if (!dir) await walk(info.commit.commit.tree.sha, '', files);
      else {
        // Down to the folder itself, so the app's own files are never listed.
        let sha: string | undefined = info.commit.commit.tree.sha;
        for (const part of dir.split('/')) {
          const level: { tree: TreeEntry[] } = await ok(await call(`/git/trees/${sha}`));
          sha = level.tree.find((e) => e.path === part && e.type === 'tree')?.sha;
          if (!sha) break;
        }
        if (sha) await walk(sha, '', files);
      }
      return { head, files };
    },
    async download(name, file) {
      await ensureBranch();
      const res = await call(`${contents(name)}?ref=${encodeURIComponent(branch)}`, { accept: 'application/vnd.github.raw+json' });
      if (res.status === 404) return false;
      if (!res.ok || !res.body) throw await failed(res);
      await mkdir(path.dirname(file), { recursive: true });
      // Written as it arrives: a large PDF is never held whole in memory.
      await writeFile(file, res.body as unknown as AsyncIterable<Uint8Array>);
      return true;
    },
    async commit(changes) {
      await ensureBranch();
      const shas = new Map<string, string | null>();
      const tree: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = [];
      for (const c of changes) {
        const sha = c.entry.deleted ? null : await blob(c);
        shas.set(c.name, sha);
        tree.push({ path: dir ? `${dir}/${c.name}` : c.name, mode: '100644', type: 'blob', sha });
      }
      const names = changes.map((c) => c.name);
      const message = names.length === 1 ? `${changes[0].entry.deleted ? 'Remove' : 'Save'} ${names[0]}` : `Save ${names.length} files (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''})`;
      // The branch moved meanwhile (another writer): made again on its new head.
      for (let attempt = 0; ; attempt++) {
        const parent = await headOf();
        const base = (await ok<{ tree: { sha: string } }>(await call(`/git/commits/${parent}`))).tree.sha;
        await paced();
        const made = await ok<{ sha: string }>(await call('/git/trees', { method: 'POST', body: { base_tree: base, tree } }));
        if (made.sha === base) return { head: parent, parent, shas }; // nothing changed
        await paced();
        const commit = await ok<{ sha: string }>(await call('/git/commits', { method: 'POST', body: { message, tree: made.sha, parents: [parent] } }));
        await paced();
        const moved = await call(`/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
        if (moved.ok) return { head: commit.sha, parent, shas };
        if (moved.status !== 422 || attempt >= 3) throw await failed(moved);
      }
    },
    // Every stored revision stays in the branch's history (public, and
    // fetched by nobody) unless the history is dropped: once it is longer
    // than `maxCommits`, the branch becomes one commit holding what it holds now.
    async squash(maxCommits) {
      await ensureBranch();
      const res = await call(`/commits?sha=${encodeURIComponent(branch)}&per_page=1`);
      if (!res.ok) throw await failed(res);
      const last = /[?&]page=(\d+)>;\s*rel="last"/.exec(res.headers.get('link') ?? '');
      if (!last || Number(last[1]) <= maxCommits) return null;
      const head = await headOf();
      const tree = (await ok<{ tree: { sha: string } }>(await call(`/git/commits/${head}`))).tree.sha;
      await paced();
      const commit = await ok<{ sha: string }>(await call('/git/commits', { method: 'POST', body: { message: 'Storage snapshot (history dropped)', tree, parents: [] } }));
      // Only over the head just read: a commit made meanwhile is never lost.
      if ((await headOf()) !== head) return null;
      await paced();
      const moved = await call(`/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: { sha: commit.sha, force: true } });
      if (!moved.ok) throw await failed(moved);
      return commit.sha;
    },
  };
}

const backend = github();
export const durable = !!backend;

// ---- state ----
/** The first sync has gone through: what the folder holds is known. */
let synced = !backend;
let syncError = '';
/** Files in the folder as of the last listing (name → blob sha), and the
 * commit that listing was of. */
let head: string | null = null;
const stored = new Map<string, string>();
/** Changes waiting to go up, newest content only. */
const latest = new Map<string, Pending>();
let failures = 0, lastError = '', retryAt = 0, attempt = 0;
let lastStored = 0;

export const durableStatus = () => ({
  durable, where: backend?.where ?? null, ready: synced, syncError: synced ? '' : syncError,
  pending: latest.size, failures, lastError, retrying: latest.size > 0 && !!lastError, lastStored,
});
/** Throws StorageUnavailable until the stored work is known. */
export function requireStorage() {
  if (!synced) throw new StorageUnavailable(`The stored booklets could not be reached yet${syncError ? ` (${syncError})` : ''}. Try again in a minute.`);
}
/** Every file name the folder holds or is about to hold. */
export const storedNames = () => new Set([...stored.keys(), ...[...latest].filter(([, e]) => !e.deleted).map(([n]) => n)]);

// ---- uploads: all waiting changes in one commit ----
// An autosaved booklet changes twice a second while typing: only its latest
// content is sent, once it has been still for `quiet` ms.
const MAX_BATCH = 60;
const MAX_BATCH_BYTES = 40 * 1024 * 1024;
let worker: Promise<void> | null = null;
let flushing = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function work() {
  return worker ??= (async () => {
    while (latest.size && backend) {
      const now = Date.now();
      if (retryAt > now) { await sleep(Math.min(500, retryAt - now)); continue; }
      const due = [...latest].filter(([, v]) => flushing || now - v.at >= backend.quiet).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) { await sleep(500); continue; }
      const batch: Change[] = [];
      let bytes = 0;
      for (const [name, entry] of due) {
        // Unchanged content (written again as it was) needs no commit.
        if (entry.data && stored.get(name) === blobSha(entry.data)) { latest.delete(name); continue; }
        // A deletion of something never stored is already done.
        if (entry.deleted && !stored.has(name)) { latest.delete(name); continue; }
        // A large file removed here since: its removal follows as its own change.
        if (entry.file && !existsSync(entry.file)) { latest.delete(name); continue; }
        const size = entry.data?.length ?? 0;
        if (batch.length && (batch.length >= MAX_BATCH || bytes + size > MAX_BATCH_BYTES)) break;
        batch.push({ name, entry });
        bytes += size;
      }
      if (!batch.length) continue;
      try {
        const result = await backend.commit(batch);
        if (!result) continue;
        for (const { name, entry } of batch) {
          const sha = result.shas.get(name);
          if (sha) stored.set(name, sha); else stored.delete(name);
          if (latest.get(name) === entry) latest.delete(name);
        }
        // Nothing else moved the branch: no need to list it again.
        if (result.parent === head) head = result.head;
        attempt = 0; lastError = ''; lastStored = Date.now();
      } catch (error) {
        // Never dropped: tried again after a pause that grows to 5 minutes,
        // or as long as GitHub asks.
        failures++;
        attempt++;
        lastError = (error as Error).message;
        const wait = error instanceof Throttled ? error.wait : Math.min(300_000, 2000 * 2 ** Math.min(attempt, 8));
        retryAt = Date.now() + wait;
        console.error(`Durable copy of ${batch.length} file(s) failed (${batch.map((c) => c.name).slice(0, 3).join(', ')}…), trying again in ${Math.round(wait / 1000)}s:`, lastError);
      }
    }
  })().finally(() => { worker = null; if (latest.size) void work(); });
}

const nameOf = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');
const kept = (name: string) => !name.startsWith('..') && !/(^|\/)fixed-|\.tmp$|^ocr\//.test(name);

/** Copy a file just written under `root` (data/) to durable storage. A large
 * file is read back from disk when it is sent. */
export function mirror(root: string, file: string, data: Buffer | string) {
  if (!backend) return;
  const name = nameOf(root, file);
  if (!kept(name)) return;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  latest.set(name, buffer.length > STREAM_ABOVE ? { file, at: Date.now() } : { data: buffer, at: Date.now() });
  void work();
}

/** Remove a file under `root` from durable storage too. */
export function forget(root: string, file: string) {
  if (!backend) return;
  const name = nameOf(root, file);
  if (!kept(name)) return;
  latest.set(name, { deleted: true, at: Date.now() });
  void work();
}

const fetching = new Map<string, Promise<boolean>>();
/** Make sure `file` (under `root`) is on disk, fetching the durable copy if
 * this server lost it. False only when the folder has no such file; throws
 * StorageUnavailable when that could not be checked. */
export function ensureLocal(root: string, file: string): Promise<boolean> {
  if (existsSync(file)) return Promise.resolve(true);
  if (!backend) return Promise.resolve(false);
  const name = nameOf(root, file);
  if (name.startsWith('..')) return Promise.resolve(false);
  const waiting = latest.get(name);
  if (waiting?.deleted) return Promise.resolve(false);
  // Known absent: the folder was listed and has no such file.
  if (synced && !waiting && !stored.has(name)) return Promise.resolve(false);
  if (!fetching.has(name)) fetching.set(name, (async () => {
    // Not sent yet (written moments ago): it is still in memory.
    if (waiting?.data) {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, waiting.data);
      if (!existsSync(file)) await rename(tmp, file); else await unlink(tmp).catch(() => undefined);
      return true;
    }
    try {
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      if (!(await backend.download(name, tmp))) return false;
      // Written here meanwhile: this server's copy is the newer one.
      if (!existsSync(file)) await rename(tmp, file); else await unlink(tmp).catch(() => undefined);
      return true;
    } catch (error) {
      console.error(`Durable copy of ${name} could not be read:`, (error as Error).message);
      throw new StorageUnavailable(`The stored copy of ${name} could not be read: ${(error as Error).message}`);
    }
  })().finally(() => fetching.delete(name)));
  return fetching.get(name)!;
}

/** Before shutdown: send the copies still waiting, without the quiet time. */
export async function flushDurable(timeoutMs = 25_000) {
  if (!backend || !latest.size) return;
  flushing = true;
  retryAt = 0;
  await Promise.race([(async () => { while (latest.size) { await work(); if (latest.size) await sleep(200); } })(), sleep(timeoutMs)]);
}

// ---- repo → app ----
/** Files brought down whenever they change, held here or not: what the
 * editor opens with (booklets, defaults, their stamps, the added PDFs list). */
const always = (name: string) => /^[^/]+\.json$/.test(name) || /^pdfs\/[^/]+\.json$/.test(name);
let syncing: Promise<void> | null = null;

/** Bring changes in the repository folder down to `root` (data/). Rejects
 * when the folder could not be read. */
export function syncFromRepo(root: string): Promise<void> {
  if (!backend) return Promise.resolve();
  return syncing ??= (async () => {
    const found = await backend.list(head);
    if (!found) { synced = true; return; }
    let fetched = 0;
    for (const [name, sha] of found.files) {
      // This server's own newer copy is on its way up.
      if (latest.has(name) || stored.get(name) === sha) continue;
      const file = path.join(root, ...name.split('/'));
      if (path.relative(root, file).startsWith('..')) continue;
      const here = existsSync(file);
      if (here && blobSha(await readLocal(file)) === sha) continue;
      if (!here && !always(name)) continue; // fetched when first asked for
      const tmp = `${file}.sync.tmp`;
      if (!(await backend.download(name, tmp)) || latest.has(name)) { await unlink(tmp).catch(() => undefined); continue; }
      await rename(tmp, file);
      fetched++;
    }
    stored.clear();
    for (const [name, sha] of found.files) stored.set(name, sha);
    head = found.head;
    synced = true;
    syncError = '';
    if (fetched) console.log(`storage: ${fetched} file(s) brought down from ${backend.where}`);
  })().catch((error) => {
    syncError = (error as Error).message;
    console.error('Sync from the repository failed:', syncError);
    throw error;
  }).finally(() => { syncing = null; });
}

/** Sync at start (waiting at most `wait` ms, so the first visit sees the
 * stored work), then every GITHUB_STORAGE_SYNC_SECONDS; every 10 seconds
 * while the first sync has not gone through. */
export async function startRepoSync(root: string, wait = Number(process.env.GITHUB_STORAGE_START_WAIT_SECONDS ?? 20) * 1000) {
  if (!backend) return;
  console.log(`storage: ${backend.where}`);
  await Promise.race([syncFromRepo(root).catch(() => undefined), sleep(wait)]);
  const every = Math.max(5, Number(process.env.GITHUB_STORAGE_SYNC_SECONDS ?? 60)) * 1000;
  const next = () => setTimeout(() => void syncFromRepo(root).catch(() => undefined).finally(next), synced ? every : Math.min(every, 10_000)).unref();
  next();
}

/** Wait (at most `timeoutMs`) until nothing is waiting to go up. */
export async function settled(timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (latest.size && Date.now() < until) await sleep(500);
  return !latest.size;
}

/** Drop the storage branch's history once it is longer than
 * GITHUB_STORAGE_MAX_COMMITS (500; 0 never), when nothing is waiting to go up. */
export async function squashHistory() {
  const max = Number(process.env.GITHUB_STORAGE_MAX_COMMITS ?? 500);
  if (!backend || !synced || latest.size || !(max > 0)) return;
  const sha = await backend.squash(max);
  if (sha) { head = sha; console.log(`storage: history of ${backend.where} dropped (kept as one commit)`); }
}
