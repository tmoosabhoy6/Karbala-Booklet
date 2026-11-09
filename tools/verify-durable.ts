import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';

// Durable storage (server/durable.ts) against stand-ins for the GitHub and
// Supabase APIs: defaults, a screenshot and its files survive a wiped disk
// (a free host's restart), and a device holding an older copy cannot
// overwrite newer defaults.
await mkdir('work', { recursive: true });
const body = (req: IncomingMessage) => new Promise<Buffer>((done) => { const parts: Buffer[] = []; req.on('data', (c) => parts.push(c)); req.on('end', () => done(Buffer.concat(parts))); });

const files = new Map<string, Buffer>();
let branch = false, commits = 0;
const github = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  const send = (status: number, value?: unknown) => { res.statusCode = status; res.end(value === undefined ? '' : JSON.stringify(value)); };
  if (req.headers.authorization !== 'Bearer gh-token') return send(401);
  const p = url.pathname.replace('/repos/owner/repo', '');
  if (p === '/branches/storage') return branch ? send(200, {}) : send(404);
  if (p === '') return send(200, { default_branch: 'main' });
  if (p === '/git/ref/heads/main') return send(200, { object: { sha: 'base' } });
  if (p === '/git/refs' && req.method === 'POST') { branch = true; return send(201, {}); }
  const m = /^\/contents\/storage\/(.+)$/.exec(p);
  if (!m) return send(404);
  const name = decodeURIComponent(m[1]);
  const sha = (b: Buffer) => createHash('sha1').update(b).digest('hex');
  if (req.method === 'GET') {
    if (!branch || url.searchParams.get('ref') !== 'storage') return send(404);
    const file = files.get(name);
    if (!file) return send(404);
    if (req.headers.accept === 'application/vnd.github.raw+json') return res.end(file);
    return send(200, { sha: sha(file) });
  }
  const { content, sha: given, branch: to } = JSON.parse((await body(req)).toString());
  if (to !== 'storage' || !branch) return send(404);
  const existing = files.get(name);
  if (existing && !given) return send(422, { message: '"sha" wasn\'t supplied.' });
  if (existing && given !== sha(existing)) return send(409, { message: 'does not match' });
  const data = Buffer.from(content, 'base64');
  files.set(name, data); commits++;
  return send(existing ? 200 : 201, { content: { sha: sha(data) } });
}).listen(23501);

const objects = new Map<string, Buffer>();
const supabase = createServer(async (req, res) => {
  const name = decodeURIComponent(req.url!.replace(/^\/storage\/v1\/object\/booklet\//, ''));
  if (req.headers.apikey !== 'test-key') { res.statusCode = 401; return res.end(); }
  if (req.method === 'POST') { objects.set(name, await body(req)); return res.end('{}'); }
  const v = objects.get(name); if (!v) { res.statusCode = 400; return res.end('{"statusCode":"404"}'); } res.end(v);
}).listen(23503);

const data = 'work/durable-data', port = '23502', origin = `http://127.0.0.1:${port}`;
let server: ChildProcess | undefined;
const screenshot = 'tests/fixtures/lettering/' + readdirSync('tests/fixtures/lettering').find((f) => f.includes('9.11.12'))!;

async function scenario(label: string, env: Record<string, string>) {
  const start = async () => {
    server = spawn(process.execPath, ['build/server.js'], { env: { ...process.env, NODE_ENV: 'production', PORT: port, DATA_DIR: data, ...env }, stdio: 'inherit' });
    for (let i = 0; i < 100; i++) { if (await fetch(origin + '/api/health').then((r) => r.ok).catch(() => false)) return; await new Promise((r) => setTimeout(r, 200)); }
  };
  const stop = async () => { server!.kill('SIGTERM'); await new Promise((r) => server!.once('exit', r)); };
  const put = (value: unknown, based: number, restore = false) => fetch(origin + '/api/defaults', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Based-On': String(based), ...(restore ? { 'X-Restore': '1' } : {}) }, body: JSON.stringify(value) });
  await rm(data, { recursive: true, force: true });
  await start();
  const first = await put({ 'noha:xA': { category: 'noha', name: 'laptop pin', blocks: [] } }, 0);
  const stamp = Number(first.headers.get('X-Saved-At'));
  assert(first.ok && stamp > 0);
  // Saved again at once: only the newest content needs to arrive.
  const second = await put({ 'noha:xA': { category: 'noha', name: 'laptop pin 2', blocks: [] } }, stamp);
  const stamp2 = Number(second.headers.get('X-Saved-At'));
  const upload = await (await fetch(origin + '/api/media', { method: 'POST', body: await readFile(screenshot) })).json();
  await stop();                                     // copies still waiting go on SIGTERM
  await rm(data, { recursive: true, force: true }); // the free host's restart
  await start();
  const back = await fetch(origin + '/api/defaults');
  assert.equal((await back.json())['noha:xA'].name, 'laptop pin 2', `${label}: defaults come back after the disk is wiped`);
  assert.equal(Number(back.headers.get('X-Saved-At')), stamp2, `${label}: with their stamp`);
  const meta = await (await fetch(`${origin}/api/media/${upload.id}`)).json();
  assert.equal(meta.rev, upload.rev, `${label}: the screenshot comes back under the same revision`);
  assert((await fetch(`${origin}/media/${upload.id}.${upload.rev}.png`)).ok, `${label}: its print file comes back`);
  assert((await fetch(`${origin}/api/media/${upload.id}/original`)).ok, `${label}: and its original`);
  assert.equal((await put({ old: true }, stamp - 1000)).status, 409, `${label}: a device with an older copy cannot overwrite newer defaults`);
  assert.equal((await put({ old: true }, stamp - 1000, true)).status, 409, `${label}: nor restore its older copy over them`);
  assert((await put({ newer: true }, stamp2)).ok, `${label}: a save over the current copy goes through`);
  await stop();
  const version = env.GITHUB_STORAGE_TOKEN ? 'GitHub' : 'Supabase';
  console.log(`${label}: passed (${version === 'GitHub' ? `${files.size} files, ${commits} commits` : `${objects.size} objects`})`);
}

try {
  await scenario('GitHub folder', { GITHUB_STORAGE_TOKEN: 'gh-token', GITHUB_STORAGE_REPO: 'owner/repo', GITHUB_API_URL: 'http://127.0.0.1:23501' });
  assert(branch, 'The storage branch is made the first time.');
  assert([...files.keys()].some((k) => k === 'defaults.json'), 'Files go into the storage folder by their data/ names.');
  await scenario('Supabase bucket', { SUPABASE_URL: 'http://127.0.0.1:23503', SUPABASE_SERVICE_KEY: 'test-key' });
  console.log('durable storage checks passed');
} finally { server?.kill(); github.close(); supabase.close(); }
