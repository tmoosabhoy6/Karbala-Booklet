// A durable copy of data/ in Supabase Storage, for hosts whose disk is wiped
// on every restart (Render's free plan). Every file the server writes under
// data/ is copied there in the background; a file missing on disk (after a
// restart) is fetched back the first time something asks for it. So pinned
// defaults, the open booklets and every screenshot are the same on every
// device, whenever the server last restarted.
//
// Off unless SUPABASE_URL and SUPABASE_SERVICE_KEY are set (Render →
// Environment). SUPABASE_BUCKET names the bucket (default "booklet"); it must
// exist and be private.
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.SUPABASE_URL?.replace(/\/+$/, '') ?? '';
const KEY = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_KEY ?? '';
const BUCKET = process.env.SUPABASE_BUCKET ?? 'booklet';
export const durable = !!(BASE && KEY);
export const durableStatus = () => ({ durable, bucket: durable ? BUCKET : null, pending: latest.size, failures });

const headers = () => ({ Authorization: `Bearer ${KEY}`, apikey: KEY });
const objectUrl = (name: string) => `${BASE}/storage/v1/object/${BUCKET}/${name.split('/').map(encodeURIComponent).join('/')}`;
let failures = 0;

// Uploads: one at a time per file, and only the newest content (an autosaved
// booklet changes twice a second while typing; older versions are skipped).
const latest = new Map<string, Buffer>();
const running = new Map<string, Promise<void>>();
function upload(name: string) {
  if (running.has(name)) return running.get(name)!;
  const job = (async () => {
    for (let attempt = 0; latest.has(name); attempt++) {
      const data = latest.get(name)!;
      try {
        const res = await fetch(objectUrl(name), {
          method: 'POST', signal: AbortSignal.timeout(60_000),
          headers: { ...headers(), 'x-upsert': 'true', 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-cache' },
          body: data,
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
        if (latest.get(name) === data) latest.delete(name);
      } catch (error) {
        failures++;
        console.error(`Durable copy of ${name} failed:`, (error as Error).message);
        if (attempt >= 4) { latest.delete(name); break; }
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
  })().finally(() => running.delete(name));
  running.set(name, job);
  return job;
}

/** Copy a file just written under `root` (data/) to durable storage. */
export function mirror(root: string, file: string, data: Buffer | string) {
  if (!durable) return;
  const name = path.relative(root, file).split(path.sep).join('/');
  if (name.startsWith('..') || /(^|\/)fixed-|\.tmp$|^ocr\//.test(name)) return;
  latest.set(name, Buffer.isBuffer(data) ? data : Buffer.from(data));
  void upload(name);
}

const fetching = new Map<string, Promise<boolean>>();
/** Make sure `file` (under `root`) is on disk, fetching the durable copy if
 * this server lost it. False when neither has it. */
export function ensureLocal(root: string, file: string): Promise<boolean> {
  if (existsSync(file)) return Promise.resolve(true);
  if (!durable) return Promise.resolve(false);
  const name = path.relative(root, file).split(path.sep).join('/');
  if (name.startsWith('..')) return Promise.resolve(false);
  // Not uploaded yet (written moments ago): it is still in memory.
  const pending = latest.get(name);
  if (!fetching.has(name)) fetching.set(name, (async () => {
    let data = pending ?? null;
    if (!data) {
      const res = await fetch(objectUrl(name), { headers: headers(), signal: AbortSignal.timeout(60_000) }).catch((error: Error) => {
        console.error(`Durable copy of ${name} could not be read:`, error.message);
        return null;
      });
      if (!res?.ok) return false;
      data = Buffer.from(await res.arrayBuffer());
    }
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data);
    if (!existsSync(file)) await rename(tmp, file);
    return true;
  })().finally(() => fetching.delete(name)));
  return fetching.get(name)!;
}

/** Before shutdown: finish the copies still on their way. */
export async function flushDurable(timeoutMs = 20_000) {
  if (!durable) return;
  for (const name of latest.keys()) void upload(name);
  await Promise.race([Promise.allSettled([...running.values()]), new Promise((r) => setTimeout(r, timeoutMs))]);
}
