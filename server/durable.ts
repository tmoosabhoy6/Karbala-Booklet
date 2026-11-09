// A durable copy of data/, for hosts whose disk is wiped on every restart
// (Render's free plan). Every file the server writes under data/ is copied
// there in the background; a file missing on disk (after a restart) is
// fetched back the first time something asks for it. So pinned defaults, the
// open booklets, every screenshot and every added kalam PDF are the same on
// every device, whenever the server last restarted.
//
// Where (Render → Environment), the first one set:
//  - GitHub: GITHUB_STORAGE_TOKEN, a fine-grained token with "Contents: read
//    and write" on the repository. Files go into the folder GITHUB_STORAGE_DIR
//    (default "storage") on the branch GITHUB_STORAGE_BRANCH (default
//    "storage", made from the default branch the first time) of
//    GITHUB_STORAGE_REPO (default: the repository Render deploys). Not main:
//    every save would be a commit that redeploys and restarts the app.
//    In a public repository the stored files are public too.
//  - Supabase Storage: SUPABASE_URL and SUPABASE_SERVICE_KEY, bucket
//    SUPABASE_BUCKET (default "booklet", private).
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface Backend {
  where: string;
  /** The stored copy of `name`, or null when there is none. */
  get(name: string): Promise<Buffer | null>;
  put(name: string, data: Buffer): Promise<void>;
  /** How long a file must stay unchanged before it is sent (ms). */
  quiet: number;
}

const segments = (name: string) => name.split('/').map(encodeURIComponent).join('/');

// ---- GitHub: a folder on a branch of the repository ----
function github(): Backend | null {
  const token = process.env.GITHUB_STORAGE_TOKEN ?? '';
  const repo = process.env.GITHUB_STORAGE_REPO ?? process.env.RENDER_GIT_REPO_SLUG ?? '';
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const branch = process.env.GITHUB_STORAGE_BRANCH ?? 'storage';
  const dir = (process.env.GITHUB_STORAGE_DIR ?? 'storage').replace(/^\/+|\/+$/g, '');
  const api = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');
  const call = (route: string, init: RequestInit & { accept?: string } = {}) => fetch(`${api}/repos/${repo}${route}`, {
    ...init, signal: AbortSignal.timeout(90_000),
    headers: { Authorization: `Bearer ${token}`, Accept: init.accept ?? 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'karbala-booklet', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const failed = async (res: Response) => new Error(`GitHub ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const contents = (name: string) => `/contents/${segments(dir ? `${dir}/${name}` : name)}`;
  // The branch is made from the default branch the first time it is needed.
  let ready: Promise<void> | null = null;
  const ensureBranch = () => (ready ??= (async () => {
    const found = await call(`/branches/${encodeURIComponent(branch)}`);
    if (found.ok) return;
    if (found.status !== 404) throw await failed(found);
    const info = await call('');
    if (!info.ok) throw await failed(info);
    const base = (await info.json()) as { default_branch: string };
    const head = await call(`/git/ref/heads/${encodeURIComponent(base.default_branch)}`);
    if (!head.ok) throw await failed(head);
    const sha = ((await head.json()) as { object: { sha: string } }).object.sha;
    const made = await call('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }) });
    if (!made.ok && made.status !== 422) throw await failed(made); // 422: made meanwhile
  })().catch((error) => { ready = null; throw error; }));
  // Each file's current blob, which an update must name.
  const shas = new Map<string, string>();
  const currentSha = async (name: string) => {
    const res = await call(`${contents(name)}?ref=${encodeURIComponent(branch)}`);
    if (res.status === 404) { shas.delete(name); return undefined; }
    if (!res.ok) throw await failed(res);
    const sha = ((await res.json()) as { sha: string }).sha;
    shas.set(name, sha);
    return sha;
  };
  return {
    where: `github:${repo}@${branch}/${dir}`,
    // Each save is a commit: an autosaved booklet goes once it has been
    // still for a few seconds, not on every keystroke.
    quiet: 4000,
    async get(name) {
      await ensureBranch();
      const res = await call(`${contents(name)}?ref=${encodeURIComponent(branch)}`, { accept: 'application/vnd.github.raw+json' });
      if (res.status === 404) return null;
      if (!res.ok) throw await failed(res);
      return Buffer.from(await res.arrayBuffer());
    },
    async put(name, data) {
      await ensureBranch();
      for (let attempt = 0; ; attempt++) {
        const sha = shas.get(name);
        const res = await call(contents(name), { method: 'PUT', body: JSON.stringify({ message: `Save ${name}`, content: data.toString('base64'), branch, ...(sha ? { sha } : {}) }) });
        if (res.ok) { shas.set(name, ((await res.json()) as { content: { sha: string } }).content.sha); return; }
        // The file exists (or changed) and its blob was not named: look it up.
        if ((res.status === 409 || res.status === 422) && attempt < 2) { await currentSha(name); continue; }
        throw await failed(res);
      }
    },
  };
}

// ---- Supabase Storage ----
function supabase(): Backend | null {
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, '') ?? '';
  const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_KEY ?? '';
  if (!base || !key) return null;
  const bucket = process.env.SUPABASE_BUCKET ?? 'booklet';
  // A legacy key is a JWT and goes in both headers; a new secret key
  // (sb_secret_…) only in `apikey`.
  const headers: Record<string, string> = key.startsWith('eyJ') ? { Authorization: `Bearer ${key}`, apikey: key } : { apikey: key };
  const url = (name: string) => `${base}/storage/v1/object/${bucket}/${segments(name)}`;
  return {
    where: `supabase:${bucket}`,
    quiet: 0,
    async get(name) {
      const res = await fetch(url(name), { headers, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    },
    async put(name, data) {
      const res = await fetch(url(name), {
        method: 'POST', signal: AbortSignal.timeout(60_000), body: data,
        headers: { ...headers, 'x-upsert': 'true', 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-cache' },
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
    },
  };
}

const backend = github() ?? supabase();
export const durable = !!backend;
let failures = 0;
export const durableStatus = () => ({ durable, where: backend?.where ?? null, pending: latest.size, failures });

// ---- uploads: one at a time, newest content only ----
// An autosaved booklet changes twice a second while typing: only its latest
// content is sent, once it has been still for `quiet` ms.
const latest = new Map<string, { data: Buffer; at: number; attempts: number }>();
let worker: Promise<void> | null = null;
let flushing = false;
function work() {
  return worker ??= (async () => {
    while (latest.size && backend) {
      const now = Date.now();
      const due = [...latest].filter(([, v]) => flushing || now - v.at >= backend.quiet).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) { await new Promise((r) => setTimeout(r, 500)); continue; }
      const [name, entry] = due;
      try {
        await backend.put(name, entry.data);
        if (latest.get(name) === entry) latest.delete(name);
      } catch (error) {
        failures++;
        console.error(`Durable copy of ${name} failed:`, (error as Error).message);
        if (latest.get(name) !== entry) continue;
        if (++entry.attempts >= 5) latest.delete(name);
        else { entry.at = Date.now() + 2000 * 2 ** entry.attempts; }
      }
    }
  })().finally(() => { worker = null; if (latest.size) void work(); });
}

const nameOf = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');

/** Copy a file just written under `root` (data/) to durable storage. */
export function mirror(root: string, file: string, data: Buffer | string) {
  if (!backend) return;
  const name = nameOf(root, file);
  if (name.startsWith('..') || /(^|\/)fixed-|\.tmp$|^ocr\//.test(name)) return;
  latest.set(name, { data: Buffer.isBuffer(data) ? data : Buffer.from(data), at: Date.now(), attempts: 0 });
  void work();
}

const fetching = new Map<string, Promise<boolean>>();
/** Make sure `file` (under `root`) is on disk, fetching the durable copy if
 * this server lost it. False when neither has it. */
export function ensureLocal(root: string, file: string): Promise<boolean> {
  if (existsSync(file)) return Promise.resolve(true);
  if (!backend) return Promise.resolve(false);
  const name = nameOf(root, file);
  if (name.startsWith('..')) return Promise.resolve(false);
  if (!fetching.has(name)) fetching.set(name, (async () => {
    // Not sent yet (written moments ago): it is still in memory.
    let data = latest.get(name)?.data ?? null;
    if (!data) {
      data = await backend.get(name).catch((error: Error) => {
        console.error(`Durable copy of ${name} could not be read:`, error.message);
        return null;
      });
      if (!data) return false;
    }
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data);
    if (!existsSync(file)) await rename(tmp, file);
    return true;
  })().finally(() => fetching.delete(name)));
  return fetching.get(name)!;
}

/** Before shutdown: send the copies still waiting, without the quiet time. */
export async function flushDurable(timeoutMs = 25_000) {
  if (!backend || !latest.size) return;
  flushing = true;
  await Promise.race([(async () => { while (latest.size) await work(); })(), new Promise((r) => setTimeout(r, timeoutMs))]);
}
