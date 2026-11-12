import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// The repository folder as the app's database (server/durable.ts), against a
// stand-in for the GitHub API (its Git Data API: blobs, trees, commits, refs):
//  - defaults, a booklet and a screenshot survive a wiped disk (a free
//    host's restart), all waiting files going up in one commit;
//  - a device holding an older copy cannot overwrite newer defaults;
//  - GitHub failing at wake-up is "unknown", never "empty": nothing is served
//    or saved over the stored booklet until it answers again;
//  - uploads GitHub refuses (rate limits) are kept and sent once it takes them;
//  - a change made in the folder reaches the running app, also when GitHub
//    cuts the folder's listing short;
//  - files nothing uses any more, and removed PDFs, leave the folder;
//  - a library id naming impossible verses is refused, not run out of memory;
//  - a library verse never rendered on the server can be opened to crop.
await mkdir('work', { recursive: true });
const body = (req: IncomingMessage) => new Promise<Buffer>((done) => { const parts: Buffer[] = []; req.on('data', (c) => parts.push(c)); req.on('end', () => done(Buffer.concat(parts))); });
const sha1 = (s: string | Buffer) => createHash('sha1').update(s).digest('hex');
const blobSha = (b: Buffer) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

// ---- a tiny git ----
const blobs = new Map<string, Buffer>();
const trees = new Map<string, Map<string, string>>(); // tree sha → every path → blob sha
const commitsById = new Map<string, { tree: string; parents: string[] }>();
const treeOf = (files: Map<string, string>) => {
  const sha = sha1(JSON.stringify([...files].sort()));
  trees.set(sha, files);
  return sha;
};
const commitOf = (tree: string, parents: string[]) => {
  const sha = sha1(`${tree}:${parents.join(',')}:${commitsById.size}`);
  commitsById.set(sha, { tree, parents });
  return sha;
};
const readme = Buffer.from('app'); blobs.set(blobSha(readme), readme);
const mainHead = commitOf(treeOf(new Map([['README.md', blobSha(readme)]])), []);
let head: string | null = null; // the storage branch
let commits = 0;
const storageFiles = () => {
  const out = new Map<string, Buffer>();
  if (!head) return out;
  for (const [p, sha] of trees.get(commitsById.get(head)!.tree)!) if (p.startsWith('storage/')) out.set(p.slice(8), blobs.get(sha)!);
  return out;
};
/** Another device's save, made straight in the repository folder. */
const direct = (changes: Record<string, string>) => {
  const files = new Map(trees.get(commitsById.get(head!)!.tree)!);
  for (const [name, text] of Object.entries(changes)) { const b = Buffer.from(text); blobs.set(blobSha(b), b); files.set(`storage/${name}`, blobSha(b)); }
  head = commitOf(treeOf(files), [head!]);
};
const chain = (sha: string | null) => { let n = 0; while (sha) { n++; sha = commitsById.get(sha)!.parents[0] ?? null; } return n; };

// Switches for trouble.
let down = false;           // every request fails (an outage, a revoked token)
let throttled = false;      // content-creating requests are refused (rate limit)
let truncate = false;       // recursive listings come back cut short
let requests = 0;

const github = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  requests++;
  const url = new URL(req.url!, 'http://x');
  const send = (status: number, value?: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, headers); res.end(value === undefined ? '' : JSON.stringify(value)); };
  if (req.headers.authorization !== 'Bearer gh-token') return send(401);
  if (down) return send(503, { message: 'Service unavailable' });
  const write = req.method !== 'GET';
  if (write && throttled) return send(403, { message: 'You have exceeded a secondary rate limit.' }, { 'retry-after': '1' });
  const p = url.pathname.replace('/repos/owner/repo', '');
  if (p === '') return send(200, { default_branch: 'main' });
  if (p === '/git/ref/heads/main') return send(200, { object: { sha: mainHead } });
  if (p === '/git/refs' && req.method === 'POST') { head ??= mainHead; return send(201, {}); }
  if (p === '/branches/storage') return head ? send(200, { commit: { sha: head, commit: { tree: { sha: commitsById.get(head)!.tree } } } }) : send(404);
  if (p === '/git/ref/heads/storage') return head ? send(200, { object: { sha: head } }) : send(404);
  if (p === '/commits') {
    const n = chain(head);
    return send(200, [{}], n > 1 ? { link: `<http://x/commits?sha=storage&per_page=1&page=2>; rel="next", <http://x/commits?sha=storage&per_page=1&page=${n}>; rel="last"` } : {});
  }
  const tree = /^\/git\/trees\/(.+)$/.exec(p);
  if (tree && req.method === 'GET') {
    // A tree is a commit's tree or `<tree>:<folder>` below it.
    const [root, folder = ''] = decodeURIComponent(tree[1]).split(':');
    const files = trees.get(root);
    if (!files) return send(404);
    const prefix = folder ? `${folder}/` : '';
    const under = [...files].filter(([path]) => path.startsWith(prefix)).map(([path, sha]) => [path.slice(prefix.length), sha] as const);
    if (url.searchParams.get('recursive')) {
      const all = under.map(([path, sha]) => ({ path, type: 'blob', sha }));
      return send(200, truncate ? { tree: all.slice(0, 2), truncated: true } : { tree: all, truncated: false });
    }
    const level = new Map<string, { path: string; type: string; sha: string }>();
    for (const [path, sha] of under) {
      const [first, ...rest] = path.split('/');
      level.set(first, rest.length ? { path: first, type: 'tree', sha: `${root}:${prefix}${first}` } : { path: first, type: 'blob', sha });
    }
    return send(200, { tree: [...level.values()], truncated: false });
  }
  if (p === '/git/blobs' && req.method === 'POST') {
    const { content, encoding } = JSON.parse((await body(req)).toString());
    assert.equal(encoding, 'base64');
    const data = Buffer.from(content, 'base64');
    blobs.set(blobSha(data), data);
    return send(201, { sha: blobSha(data) });
  }
  if (p === '/git/trees' && req.method === 'POST') {
    const { base_tree, tree: entries } = JSON.parse((await body(req)).toString()) as { base_tree: string; tree: { path: string; sha: string | null }[] };
    const files = new Map(trees.get(base_tree)!);
    for (const e of entries) {
      if (e.sha === null) { if (!files.delete(e.path)) return send(422, { message: 'path not in tree' }); }
      else { if (!blobs.has(e.sha)) return send(422, { message: 'no such blob' }); files.set(e.path, e.sha); }
    }
    return send(201, { sha: treeOf(files) });
  }
  const commit = /^\/git\/commits\/(.+)$/.exec(p);
  if (commit) return commitsById.has(commit[1]) ? send(200, { tree: { sha: commitsById.get(commit[1])!.tree } }) : send(404);
  if (p === '/git/commits' && req.method === 'POST') {
    const { tree: t, parents } = JSON.parse((await body(req)).toString());
    return send(201, { sha: commitOf(t, parents) });
  }
  if (p === '/git/refs/heads/storage' && req.method === 'PATCH') {
    const { sha, force } = JSON.parse((await body(req)).toString());
    if (!force && commitsById.get(sha)!.parents[0] !== head) return send(422, { message: 'Update is not a fast forward' });
    head = sha; commits++;
    return send(200, {});
  }
  const m = /^\/contents\/storage\/(.+)$/.exec(p);
  if (m && req.method === 'GET') {
    if (!head || url.searchParams.get('ref') !== 'storage') return send(404);
    const file = storageFiles().get(decodeURIComponent(m[1]));
    if (!file) return send(404);
    return res.end(file);
  }
  return send(404);
}).listen(23501);

const data = 'work/durable-data', port = '23502', origin = `http://127.0.0.1:${port}`;
let server: ChildProcess | undefined;
const screenshot = 'tests/fixtures/lettering/' + readdirSync('tests/fixtures/lettering').find((f) => f.includes('9.11.12'))!;
const env = { GITHUB_STORAGE_TOKEN: 'gh-token', GITHUB_STORAGE_REPO: 'owner/repo', GITHUB_API_URL: 'http://127.0.0.1:23501', GITHUB_STORAGE_SYNC_SECONDS: '5', GITHUB_STORAGE_START_WAIT_SECONDS: '3' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const start = async (extra: Record<string, string> = {}) => {
  server = spawn(process.execPath, ['build/server.js'], { env: { ...process.env, NODE_ENV: 'production', PORT: port, DATA_DIR: data, ...env, ...extra }, stdio: 'inherit' });
  for (let i = 0; i < 150; i++) { if (await fetch(origin + '/api/health').then((r) => r.ok).catch(() => false)) return; await sleep(200); }
  throw new Error('The server did not start.');
};
const stop = async () => { server!.kill('SIGTERM'); await new Promise((r) => server!.once('exit', r)); };
const wipe = () => rm(data, { recursive: true, force: true }); // the free host's restart
const until = async (what: string, test: () => Promise<boolean>, seconds = 30) => {
  for (let i = 0; i < seconds * 4; i++) { if (await test().catch(() => false)) return; await sleep(250); }
  throw new Error(`Timed out waiting: ${what}`);
};
const put = (name: string, value: unknown, based: number, restore = false) => fetch(`${origin}/api/${name}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Based-On': String(based), ...(restore ? { 'X-Restore': '1' } : {}) }, body: JSON.stringify(value) });
const stampOf = (res: Response) => Number(res.headers.get('X-Saved-At'));
const status = async () => ((await (await fetch(`${origin}/api/version`)).json()) as { storage: { ready: boolean; pending: number; retrying: boolean; failures: number } }).storage;
const stored = (name: string) => storageFiles().get(name)?.toString();

try {
  // ---- survives a wiped disk; one commit for everything waiting ----
  await wipe();
  await start();
  const first = await put('defaults', { 'noha:xA': { category: 'noha', name: 'laptop pin', blocks: [] } }, 0);
  const stamp = stampOf(first);
  assert(first.ok && stamp > 0);
  const stamp2 = stampOf(await put('defaults', { 'noha:xA': { category: 'noha', name: 'laptop pin 2', blocks: [] } }, stamp));
  const upload = await (await fetch(origin + '/api/media', { method: 'POST', body: await readFile(screenshot) })).json() as { id: string; rev: number };
  const kept = await (await fetch(origin + '/api/media', { method: 'POST', body: await readFile(screenshot) })).json() as { id: string; rev: number; width: number };
  const booklet = { version: 3, date: '2026-11-12', venue: 'haram', kalams: { noha: [{ id: 'k', name: 'A WEEK OF WORK', blocks: [{ kind: 'image', id: 'b', mediaId: kept.id, rev: kept.rev }] }] } };
  const saved = await put('booklet', booklet, 0);
  const bookletStamp = stampOf(saved);
  // Saving the very same booklet again is no newer copy (opening a page
  // used to count as a save, and every other device reloaded).
  assert.equal(stampOf(await put('booklet', booklet, bookletStamp)), bookletStamp, 'an identical save keeps its stamp');
  const before = commits;
  await stop();                                     // copies still waiting go on SIGTERM
  assert(commits - before < storageFiles().size / 2, `the waiting files go up together (${commits - before} commits for ${storageFiles().size} files)`);
  assert(storageFiles().has(`media/${upload.id}.${upload.rev}.png`) && stored('booklet.json')?.includes('A WEEK OF WORK'));
  await wipe();
  await start();
  const back = await fetch(origin + '/api/defaults');
  assert.equal((await back.json())['noha:xA'].name, 'laptop pin 2', 'defaults come back after the disk is wiped');
  assert.equal(stampOf(back), stamp2, 'with their stamp');
  const meta = await (await fetch(`${origin}/api/media/${upload.id}`)).json();
  assert.equal(meta.rev, upload.rev, 'the screenshot comes back under the same revision');
  assert((await fetch(`${origin}/media/${upload.id}.${upload.rev}.png`)).ok, 'its print file comes back');
  assert((await fetch(`${origin}/api/media/${upload.id}/original`)).ok, 'and its original');
  assert.equal((await put('defaults', { old: true }, stamp - 1000)).status, 409, 'a device with an older copy cannot overwrite newer defaults');
  assert.equal((await put('defaults', { old: true }, stamp - 1000, true)).status, 409, 'nor restore its older copy over them');
  const third = await put('defaults', { 'noha:xA': { category: 'noha', name: 'laptop pin 3', blocks: [] } }, stamp2);
  assert(third.ok, 'a save over the current copy goes through');

  // ---- a change made in the folder reaches the app, even with a cut-short listing ----
  await until('this server’s own copy goes up first', async () => (await status()).pending === 0);
  truncate = true;
  const later = stampOf(third) + 5000;
  direct({ 'defaults.json': JSON.stringify({ 'noha:xB': { category: 'noha', name: 'phone pin', blocks: [] } }), 'defaults.stamp.json': JSON.stringify({ savedAt: later }) });
  await until('a change in the repository folder reaches the running app', async () => {
    const now = await fetch(origin + '/api/defaults');
    return stampOf(now) === later && !!(await now.json())['noha:xB'];
  });
  truncate = false;

  // ---- uploads GitHub refuses are kept, and sent once it takes them ----
  throttled = true;
  const during = await put('booklet', { ...booklet, kalams: { noha: [{ ...booklet.kalams.noha[0], name: 'TYPED DURING THE LIMIT' }] } }, bookletStamp);
  assert(during.ok, 'the editor’s save is taken by the server');
  await until('the upload is retried', async () => (await status()).retrying, 20);
  await sleep(6000);
  assert((await status()).pending > 0, 'nothing waiting is dropped while GitHub refuses it');
  throttled = false;
  await until('the waiting upload goes up once GitHub takes it', async () => (await status()).pending === 0 && !!stored('booklet.json')?.includes('TYPED DURING THE LIMIT'), 30);
  const bookletStamp2 = stampOf(during);

  // ---- a library id naming impossible verses ----
  const t0 = Date.now();
  const bad = await fetch(`${origin}/api/media/lib4-0-0t999999999-0`);
  assert(!bad.ok && Date.now() - t0 < 5000, `an impossible verse range is refused (${bad.status})`);
  assert((await fetch(origin + '/api/health')).ok, 'and the server keeps running');

  // ---- a library verse never rendered here can be opened to crop ----
  const plan = await (await fetch(`${origin}/api/library/0/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verses: [0] }) })).json() as { ids: string[] };
  const original = await fetch(`${origin}/api/media/${plan.ids[0]}/original`);
  assert(original.ok && original.headers.get('content-type')?.includes('png'), 'its original is rendered for the crop editor');

  // ---- a removed PDF leaves the folder ----
  const key = 'u:0123456789abcdef';
  assert((await fetch(`${origin}/api/pdfs/${key}/file`, { method: 'PUT', body: Buffer.from('%PDF-1.4 test') })).ok);
  assert((await fetch(`${origin}/api/pdfs/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pdf: { key }, lib: {}, kalams: [], updated: 1 }) })).ok);
  await until('the PDF is stored', async () => storageFiles().has('pdfs/0123456789abcdef.pdf'));
  assert((await fetch(`${origin}/api/pdfs/${key}?updated=2`, { method: 'DELETE' })).ok);
  await until('the removed PDF leaves the folder', async () => !storageFiles().has('pdfs/0123456789abcdef.pdf') && !storageFiles().has('pdfs/0123456789abcdef.json'));
  assert(stored('pdfs/index.json')?.includes('"deleted":true'), 'the index keeps the removal for other devices');
  await stop();

  // ---- GitHub failing at wake-up: unknown, not empty ----
  await wipe();
  down = true;
  await start();
  const asleep = await fetch(origin + '/api/booklet');
  assert.equal(asleep.status, 503, 'the booklet is not served while storage cannot be read');
  assert.equal((await put('booklet', { version: 3, date: '2026-11-12', venue: 'haram', kalams: {}, note: 'EMPTY NEW BOOKLET' }, 0)).status, 503, 'nor saved over');
  assert.equal((await fetch(origin + '/api/defaults')).status, 503, 'nor the defaults');
  down = false;
  await until('the stored booklet is served once GitHub answers', async () => {
    const r = await fetch(origin + '/api/booklet');
    return r.ok && stampOf(r) === bookletStamp2 && JSON.stringify(await r.json()).includes('TYPED DURING THE LIMIT');
  });
  assert(stored('booklet.json')?.includes('TYPED DURING THE LIMIT') && !stored('booklet.json')?.includes('EMPTY NEW BOOKLET'), 'the stored booklet was never replaced');
  await stop();

  // ---- files nothing uses leave the folder ----
  await wipe();
  await start({ STORAGE_CLEANUP_DELAY_SECONDS: '2', STORAGE_CLEANUP_GRACE_DAYS: '0', GITHUB_STORAGE_MAX_COMMITS: '3' });
  await until('unused files are removed', async () => !storageFiles().has(`media/${upload.id}.json`) && (await status()).pending === 0, 40);
  assert(!storageFiles().has(`media/${upload.id}.${upload.rev}.png`) && !storageFiles().has(`media/${upload.id}.orig`), 'all of an unused screenshot’s files go');
  assert(storageFiles().has(`media/${kept.id}.json`) && storageFiles().has(`media/${kept.id}.${kept.rev}.png`), 'a screenshot the booklet uses stays');
  await until('the long history is dropped', async () => chain(head) === 1, 20);
  assert(stored('booklet.json')?.includes('TYPED DURING THE LIMIT'), 'the folder is unchanged by dropping its history');
  await stop();
  console.log(`durable storage checks passed (${storageFiles().size} files, ${commits} commits, ${requests} requests)`);
} finally { server?.kill(); github.close(); }
