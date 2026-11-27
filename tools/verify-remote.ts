import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

// Checks a deployed app end to end (Cloudflare, Render, anything):
//   npx tsx tools/verify-remote.ts https://karbala-booklet.<subdomain>.workers.dev [expected-revision]
// The editor opens, a Zikre Husain verse is rendered (MuPDF), a screenshot is
// cleaned (sharp, OCR) and the PDF downloads (Chromium). It saves no booklet
// and no defaults: only an unused screenshot and library images are stored.
const origin = (process.argv[2] ?? '').replace(/\/$/, '');
const revision = process.argv[3];
assert(/^https?:\/\//.test(origin), 'Usage: tsx tools/verify-remote.ts <url> [revision]');
// Behind an HTTPS proxy (as in a cloud session), the browser uses it too.
const proxy = /\/\/(localhost|127\.0\.0\.1)[:/]/.test(origin) ? undefined : process.env.HTTPS_PROXY ?? process.env.https_proxy;
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  ...(proxy ? { proxy: { server: proxy } } : {}),
});
const timings: Record<string, number> = {};
const timed = async <T>(name: string, fn: () => Promise<T>) => {
  const start = performance.now();
  try { return await fn(); } finally { timings[name] = Math.round(performance.now() - start); }
};
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const api = context.request;
  // A sleeping container wakes on the first request.
  await timed('wake', async () => assert.equal(await (await api.get(`${origin}/api/health`, { timeout: 180_000 })).text(), 'ok'));
  const version = await (await api.get(`${origin}/api/version`)).json();
  if (revision) assert.equal(version.revision, revision, 'The deployed revision is the expected commit.');
  assert(version.storage.ready, 'Storage is ready.');

  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await timed('editor', async () => { await page.goto(origin); await page.waitForSelector('.page', { state: 'attached', timeout: 60_000 }); });
  assert(await page.locator('.page').count() > 0, 'The booklet preview shows pages.');

  // Zikre Husain library: verses rendered from the PDF by the server.
  const library = await (await api.get(`${origin}/library/index.json`)).json();
  assert(library.kalams.length > 1000, 'The library index loads.');
  const lib = await timed('libraryVerse', async () => {
    const plan = await (await api.post(`${origin}/api/library/0/plan`, { data: { verses: [0, 1] }, timeout: 120_000 })).json();
    const meta = await (await api.get(`${origin}/api/media/${plan.ids[0]}`, { timeout: 120_000 })).json();
    const png = await (await api.get(`${origin}/media/${meta.id}.${meta.rev}.png`, { timeout: 120_000 })).body();
    return sharp(png).metadata();
  });
  assert(lib.format === 'png' && lib.width! > 500, 'A library verse renders as a PNG.');

  // A screenshot is cleaned on the server.
  const shot = await page.context().newPage();
  await shot.setViewportSize({ width: 1440, height: 1600 });
  const rows = Array.from({ length: 18 }, (_, i) => `<div style="position:absolute;top:${35 + i * 67 + Math.floor(i / 3) * 45}px;right:45px;font:36px Kanz;white-space:nowrap">السلام عليك يا أبا عبد الله</div>`).join('');
  await shot.setContent(`<style>@font-face{font-family:Kanz;src:url('${origin}/fonts/Kanz-al-Marjaan-Regular.ttf')}body{position:relative;margin:0;background:white;width:650px;height:1530px}</style>${rows}`);
  await shot.evaluate(() => document.fonts.ready);
  const input = await shot.screenshot({ clip: { x: 0, y: 0, width: 650, height: 1530 } });
  await shot.close();
  const cleaned = await timed('screenshot', async () => {
    const uploaded = await (await api.post(`${origin}/api/media`, { data: input, headers: { 'Content-Type': 'image/png' }, timeout: 180_000 })).json();
    assert(uploaded.id && uploaded.rev, `The screenshot upload returns its id: ${JSON.stringify(uploaded)}`);
    return sharp(await (await api.get(`${origin}/media/${uploaded.id}.${uploaded.rev}.png`)).body()).metadata();
  });
  assert(cleaned.format === 'png' && cleaned.width! > 100, 'The cleaned screenshot comes back as a PNG.');

  // The PDF, printed by the server's Chromium.
  const pdf = await timed('pdf', async () => {
    const download = page.waitForEvent('download', { timeout: 300_000 });
    await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
    const file = await (await download).path();
    return PDFDocument.load(await (await import('node:fs/promises')).readFile(file));
  });
  assert(pdf.getPageCount() > 0, 'The PDF has pages.');
  assert(pdf.getPages().every((p) => Math.abs(p.getWidth() - 595) < 1 && Math.abs(p.getHeight() - 842) < 1), 'Every page is A4.');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ origin, revision: version.revision, storage: version.storage.durable ? version.storage.where : 'not durable', pdfPages: pdf.getPageCount(), libraryVerse: `${lib.width}x${lib.height}`, screenshot: `${cleaned.width}x${cleaned.height}`, ms: timings }, null, 2));
} finally {
  await browser.close();
}
