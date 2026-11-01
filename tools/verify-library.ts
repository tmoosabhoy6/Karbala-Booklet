import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';

// The kalam library in a real browser, against the production build
// (`npm run build` first): verses of a kalam printed without stanza gaps,
// previews and verse images made on the device from its own copy of the PDF
// (and identical to what the server makes), and a PDF added on the device:
// split into kalams and verses, named, searched and added to the booklet.
// CHROMIUM_PATH points at a Chromium build when Playwright's own is missing.
await mkdir('work', { recursive: true });
const data = await mkdtemp('work/verify-library-');
const port = String(20000 + randomInt(30000));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['build/server.js'], {
  env: { ...process.env, NODE_ENV: 'production', PORT: port, APP_URL: origin, DATA_DIR: data },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let log = '';
server.stdout.on('data', (b) => { log += b; }); server.stderr.on('data', (b) => { log += b; });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const step = (s: string) => console.log(`· ${s}`);
try {
  for (let i = 0; i < 150; i++) {
    if (await fetch(origin + '/api/health').then((r) => r.ok).catch(() => false)) break;
    if (server.exitCode !== null) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const serverMade: string[] = [];
  page.on('request', (r) => { if (/\/api\/library\/\d+\/(title|verse)/.test(r.url())) serverMade.push(r.url()); });
  await page.goto(origin);
  await page.waitForSelector('.lib-search input');

  // 1. Mere Baba ko na maqtal mein: one opening line, then stanzas of three
  // rows that alternate sides with no gap between them: 9 verses, not 25.
  const search = page.locator('.category .lib-search input').first();
  await search.fill('Mere Baba ko na maqtal');
  await page.locator('.lib-results li', { hasText: 'Duldul' }).first().click();
  await page.waitForSelector('.verse-list li');
  assert.equal(await page.locator('.verse-list li').count(), 9, 'Mere Baba ko na maqtal mein must offer its 9 stanzas, not one verse per line.');
  step('Duldul: 9 verses (1 opening line + 8 stanzas of 3)');

  // 2. The PDF is saved on the device once; previews are then made locally.
  const t0 = Date.now();
  await page.waitForFunction(() => document.querySelector('.verse-sheet')?.getAttribute('data-local') === 'ready', null, { timeout: 180_000 });
  step(`PDF saved and opened on this device in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.locator('.verse-backdrop').click({ position: { x: 1400, y: 500 } });
  serverMade.length = 0;
  await search.fill('Mere Baba ko na maqtal');
  await page.locator('.lib-results li', { hasText: 'Duldul' }).first().click();
  const t1 = Date.now();
  const allLocal = async () => {
    // The ones on screen first, then scrolling down through the rest.
    await page.waitForFunction(() => document.querySelector('.verse-list img')?.getAttribute('src')?.startsWith('blob:'), null, { timeout: 30_000 });
    for (let i = 0; i < 300; i++) {
      await page.locator('.verse-list').evaluate((el) => { el.scrollTop += 400; });
      if (await page.evaluate(() => document.querySelectorAll('.verse-list img[src^="blob:"]').length === document.querySelectorAll('.verse-list img').length)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Previews were not made on the device: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.verse-list img')].map((i) => (i as HTMLImageElement).src.slice(0, 60) + ' ' + i.className)))}`);
  };
  await allLocal();
  step(`9 previews made on the device in ${Date.now() - t1} ms`);
  assert.equal(serverMade.filter((u) => u.includes('/verse')).length, 0, 'Previews must be made on the device once its copy is ready.');

  // 3. Add verses 2 and 3: made and cleaned on the device, stored as is.
  await page.locator('.verse-list li').nth(1).click();
  await page.locator('.verse-list li').nth(2).click({ modifiers: ['Shift'] });
  const t2 = Date.now();
  await page.locator('.verse-foot .primary').click();
  const thumb = page.locator('.kalam img.thumb[src*="/media/lib3-"]').first();
  await thumb.waitFor({ timeout: 60_000 });
  step(`2 verses added in ${Date.now() - t2} ms`);
  const src = (await thumb.getAttribute('src'))!;
  const id = /\/media\/(lib3-[\w-]+?)\.\d+\.png/.exec(src)![1];
  const meta = await fetch(`${origin}/api/media/${id}?existing=1`).then((r) => r.json());
  assert(meta.library, 'The verse must be stored for the current library build.');
  assert(!log.includes('Making the verse'), 'The device must make the verse itself.');
  // The server makes the very same image from the same id.
  const local = await sharp(Buffer.from(await fetch(origin + src).then((r) => r.arrayBuffer()))).raw().toBuffer();
  process.env.DATA_DIR = path.join(data, 'server-made');
  const { getMedia, MEDIA } = await import('../server/store');
  const made = (await getMedia(id))!;
  const remote = await sharp(path.join(MEDIA, `${id}.${made.rev}.png`)).raw().toBuffer();
  assert.equal(made.rev, meta.rev, 'Same id, same revision.');
  assert(local.equals(remote), 'A verse made on the device must be identical to the one the server makes.');
  assert.deepEqual(made.regions, meta.regions, 'Same rows and stanzas.');
  step('device-made verse is pixel-identical to the server-made one');

  // 4. A PDF added on the device: two kalams found (one closed by its
  // ornament, one under its title box), the second in 9 verses.
  await page.locator('.my-pdfs input[type=file]').setInputFiles('tests/fixtures/library/two-kalams.pdf');
  await page.waitForSelector('.name-sheet .name-list > li', { timeout: 60_000 });
  const found = await page.locator('.name-sheet .name-list > li').count();
  assert.equal(found, 2, `The added PDF holds two kalams (found ${found}).`);
  // Splitting a kalam and joining it back gives the same kalam.
  await page.locator('.name-sheet .name-list > li').nth(1).getByText('Split…').click();
  await page.locator('.split-list li').nth(3).getByText('New kalam from here').click();
  await page.waitForFunction(() => document.querySelectorAll('.name-sheet .name-list > li').length === 3);
  await page.locator('.name-sheet .name-list > li').nth(2).getByText('Join above').click();
  await page.waitForFunction(() => document.querySelectorAll('.name-sheet .name-list > li').length === 2);
  await page.locator('.name-sheet .name-list > li').nth(1).locator('.name-body > input').fill('Mere Baba test copy');
  await page.locator('.name-sheet .verse-foot .primary').click();
  await page.waitForSelector('.pdf-row');
  step('added PDF: 2 kalams found; split and joined back; named');
  await search.fill('mere baba test');
  await page.locator('.lib-results li', { hasText: 'Your PDF' }).first().click();
  await page.waitForSelector('.verse-list li');
  assert.equal(await page.locator('.verse-list li').count(), 9, 'The added copy splits into the same 9 verses.');
  await allLocal();
  await page.locator('.verse-foot .ghost').click(); // whole kalam
  await page.locator('.kalam img.thumb:not([src*="/media/lib"])').first().waitFor({ timeout: 60_000 });
  step('a kalam from the added PDF went into the booklet');
  assert.deepEqual(errors, [], `No page errors: ${errors.join('; ')}`);
  console.log('Library checks passed.');
} finally {
  await browser.close();
  try { process.kill(-server.pid!); } catch { /* already gone */ }
}
process.exit(0);
