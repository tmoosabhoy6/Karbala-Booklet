import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
const store = new Map<string, Buffer>();
const mock = createServer((req, res) => {
  const name = decodeURIComponent(req.url!.replace(/^\/storage\/v1\/object\/booklet\//, ''));
  if (req.headers.apikey !== 'test-key') { res.statusCode = 401; return res.end(); }
  if (req.method === 'POST') { const parts: Buffer[] = []; req.on('data', (c) => parts.push(c)); req.on('end', () => { store.set(name, Buffer.concat(parts)); res.end('{}'); }); return; }
  const v = store.get(name); if (!v) { res.statusCode = 400; return res.end('{"statusCode":"404"}'); } res.end(v);
}).listen(23501);
await (await import('node:fs/promises')).mkdir('work', { recursive: true });
const data = 'work/durable-data', port = '23502', origin = `http://127.0.0.1:${port}`;
let server: ChildProcess;
const start = async () => {
  server = spawn(process.execPath, ['build/server.js'], { env: { ...process.env, NODE_ENV: 'production', PORT: port, DATA_DIR: data, SUPABASE_URL: 'http://127.0.0.1:23501', SUPABASE_SERVICE_KEY: 'test-key' }, stdio: 'inherit' });
  for (let i = 0; i < 100; i++) { if (await fetch(origin + '/api/health').then((r) => r.ok).catch(() => false)) return; await new Promise((r) => setTimeout(r, 200)); }
};
const stop = async () => { server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r)); };
try {
  await rm(data, { recursive: true, force: true });
  await start();
  const put = (body: unknown, based: number, restore = false) => fetch(origin + '/api/defaults', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Based-On': String(based), ...(restore ? { 'X-Restore': '1' } : {}) }, body: JSON.stringify(body) });
  const first = await put({ 'noha:xA': { category: 'noha', name: 'laptop pin', blocks: [] } }, 0);
  const stamp = Number(first.headers.get('X-Saved-At'));
  assert(first.ok && stamp > 0);
  const upload = await (await fetch(origin + '/api/media', { method: 'POST', body: await readFile('tests/fixtures/lettering/' + (await import('node:fs')).readdirSync('tests/fixtures/lettering').find((f) => f.includes('9.11.12'))!) })).json();
  await stop();                                     // flushes copies on SIGTERM
  await rm(data, { recursive: true, force: true }); // the free host's restart
  await start();
  const back = await fetch(origin + '/api/defaults');
  assert.equal((await back.json())['noha:xA'].name, 'laptop pin', 'defaults come back after the disk is wiped');
  assert.equal(Number(back.headers.get('X-Saved-At')), stamp, 'with their stamp');
  const meta = await (await fetch(`${origin}/api/media/${upload.id}`)).json();
  assert.equal(meta.rev, upload.rev, 'the screenshot comes back under the same revision');
  assert((await fetch(`${origin}/media/${upload.id}.${upload.rev}.png`)).ok, 'its print file comes back');
  assert((await fetch(`${origin}/api/media/${upload.id}/original`)).ok, 'and its original');
  const stale = await put({ old: true }, stamp - 1000);
  assert.equal(stale.status, 409, 'a device with an older copy cannot overwrite newer defaults');
  const restoreOld = await put({ old: true }, stamp - 1000, true);
  assert.equal(restoreOld.status, 409, 'nor restore its older copy over them');
  assert((await put({ newer: true }, stamp)).ok, 'a save over the current copy goes through');
  console.log('durable storage checks passed:', [...store.keys()].length, 'objects');
} finally { server!.kill(); mock.close(); }
