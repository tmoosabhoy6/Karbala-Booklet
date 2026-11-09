// The app's database is a folder in its GitHub repository: every file the
// server keeps under data/ (pinned defaults, the open booklets, screenshots,
// added kalam PDFs) is committed there, and the server keeps itself in step
// with that folder, so the free host's wiped disk (every restart) loses
// nothing and every device sees the same work.
//
//  - App → repo: a file written under data/ is committed a few seconds after
//    it stops changing (one commit at a time; on shutdown, at once).
//  - Repo → app: at start, and then every GITHUB_STORAGE_SYNC_SECONDS (60),
//    files changed in the folder are brought down: the booklets, defaults and
//    PDF lists always, screenshots and PDFs the server already holds when
//    they change, and any other file the first time something asks for it.
//
// Set GITHUB_STORAGE_TOKEN (Render → Environment): a fine-grained token with
// "Contents: read and write" on the repository. The folder is
// GITHUB_STORAGE_DIR ("storage") on the branch GITHUB_STORAGE_BRANCH
// ("storage", made from the default branch the first time) of
// GITHUB_STORAGE_REPO (default: the repository Render deploys). Not main:
// every save would be a commit that redeploys and restarts the app.
import { existsSync } from 'node:fs';
import { readFile as readLocal, mkdir, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

interface Backend {
  where: string;
  /** The stored copy of `name`, or null when there is none. */
  get(name: string): Promise<Buffer | null>;
  put(name: string, data: Buffer): Promise<void>;
  /** Every file in the folder with its git blob sha, or null when the folder
   * has not changed since `since` (a commit). */
  list(since: string | null): Promise<{ head: string; files: Map<string, string> } | null>;
  /** Blob shas the backend knows (from its own commits). */
  known: Map<string, string>;
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
    known: shas,
    async list(since) {
      await ensureBranch();
      const res = await call(`/branches/${encodeURIComponent(branch)}`);
      if (!res.ok) throw await failed(res);
      const head = ((await res.json()) as { commit: { sha: string } }).commit.sha;
      if (head === since) return null;
      const tree = await call(`/git/trees/${head}?recursive=1`);
      if (!tree.ok) throw await failed(tree);
      const files = new Map<string, string>();
      const prefix = dir ? `${dir}/` : '';
      for (const entry of ((await tree.json()) as { tree: { path: string; type: string; sha: string }[] }).tree) {
        if (entry.type === 'blob' && entry.path.startsWith(prefix)) files.set(entry.path.slice(prefix.length), entry.sha);
      }
      return { head, files };
    },
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

const backend = github();
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

// ---- repo → app ----
/** Git's own id for some content: a file whose content is already here is
 * never downloaded again. */
const blobSha = (data: Buffer) => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
/** Files brought down whenever they change, held here or not: what the
 * editor opens with (booklets, defaults, their stamps, the added PDFs list). */
const always = (name: string) => /^[^/]+\.json$/.test(name) || /^pdfs\/[^/]+\.json$/.test(name);
let head: string | null = null;
let syncing: Promise<void> | null = null;

/** Bring changes in the repository folder down to `root` (data/). */
export function syncFromRepo(root: string): Promise<void> {
  if (!backend) return Promise.resolve();
  return syncing ??= (async () => {
    const found = await backend.list(head);
    if (!found) return;
    let fetched = 0;
    for (const [name, sha] of found.files) {
      // This server's own newer copy is on its way up.
      if (latest.has(name) || backend.known.get(name) === sha) continue;
      const file = path.join(root, ...name.split('/'));
      if (path.relative(root, file).startsWith('..')) continue;
      const here = existsSync(file);
      if (here && blobSha(await readLocal(file)) === sha) { backend.known.set(name, sha); continue; }
      if (!here && !always(name)) continue; // fetched when first asked for
      const data = await backend.get(name);
      if (!data || latest.has(name)) continue;
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, file);
      backend.known.set(name, sha);
      fetched++;
    }
    head = found.head;
    if (fetched) console.log(`storage: ${fetched} file(s) brought down from ${backend.where}`);
  })().catch((error) => console.error('Sync from the repository failed:', (error as Error).message)).finally(() => { syncing = null; });
}

/** Sync at start (waiting at most `wait` ms, so the first visit sees the
 * stored work), then every GITHUB_STORAGE_SYNC_SECONDS. */
export async function startRepoSync(root: string, wait = 20_000) {
  if (!backend) return;
  console.log(`storage: ${backend.where}`);
  await Promise.race([syncFromRepo(root), new Promise((r) => setTimeout(r, wait))]);
  const every = Math.max(5, Number(process.env.GITHUB_STORAGE_SYNC_SECONDS ?? 60)) * 1000;
  setInterval(() => void syncFromRepo(root), every).unref();
}
