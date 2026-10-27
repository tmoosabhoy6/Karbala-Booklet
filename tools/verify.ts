import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { createBooklet, imageBlockFrom } from '../src/booklet/model';
import { CONTENT, kalamImageScales, paginate } from '../src/booklet/paginate';
import { mediaSrc } from '../src/booklet/media';

// Tests the public upload -> saved document -> browser -> PDF path, including
// lost server files and a malformed image. No existing booklet is touched.
await mkdir('work', { recursive: true });
const data = await mkdtemp('work/verify-');
const port = String(20000 + randomInt(30000));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  env: { ...process.env, NODE_ENV: 'production', PORT: port, APP_URL: origin, DATA_DIR: data },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let log = '';
server.stdout.on('data', (b) => { log += b; }); server.stderr.on('data', (b) => { log += b; });
const browser = await chromium.launch();
try {
  for (let i = 0; i < 100; i++) {
    if (await fetch(origin + '/api/health').then((r) => r.ok).catch(() => false)) break;
    if (server.exitCode !== null) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin);
  const rows = Array.from({ length: 18 }, (_, i) => `<div style="position:absolute;top:${35 + i * 67 + Math.floor(i / 3) * 45}px;right:45px;font:36px Kanz;white-space:nowrap">السلام عليك يا أبا عبد الله</div>`).join('');
  await page.setContent(`<style>@font-face{font-family:Kanz;src:url('${origin}/fonts/Kanz-al-Marjaan-Regular.ttf')}body{position:relative;margin:0;background:white;width:650px;height:1530px}</style>${rows}<div style="position:absolute;left:630px;top:0;width:2px;height:1520px;background:black"></div><div style="position:absolute;left:40px;top:0;width:100px;height:3px;background:black"></div><div style="position:absolute;top:1480px;left:300px;color:red;font:22px Arial">2269</div>`);
  await page.evaluate(() => document.fonts.ready);
  await page.setViewportSize({ width: 1440, height: 1600 });
  const input = await page.screenshot({ clip: { x: 0, y: 0, width: 650, height: 1530 } });
  const uploaded = await fetch(origin + '/api/media', { method: 'POST', body: input }).then((r) => r.json());
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(uploaded.regions.length, 18, 'Only complete verse rows should survive; clipped scraps and the standalone number must disappear.');
  assert(uploaded.regions.every((r: { y: number }, i: number) => !i || r.y >= uploaded.regions[i - 1].y + uploaded.regions[i - 1].h), 'Adjacent row crops must never repeat the neighboring verse fragments.');
  assert(uploaded.width < 600, 'The long black rule must not remain.');
  assert.equal(uploaded.format, 'svg');
  const vectors = await fetch(origin + mediaSrc(imageBlockFrom(uploaded))).then((r) => r.text());
  assert(vectors.includes('<path') && !vectors.includes('<image'), 'Verse lettering must be real vector contours, not an enlarged bitmap inside an SVG.');
  const variedA = imageBlockFrom(uploaded, { regions: [{ x: 0, y: 0, w: 274, h: 40, lineHeight: 30, group: 0 }, { x: 0, y: 45, w: 274, h: 65, lineHeight: 55, group: 0 }, { x: 0, y: 115, w: 274, h: 53, lineHeight: 43, group: 0 }] });
  const variedB = imageBlockFrom(uploaded, { regions: [{ x: 0, y: 0, w: 274, h: 42, lineHeight: 32, group: 0 }, { x: 0, y: 45, w: 274, h: 62, lineHeight: 52, group: 0 }, { x: 0, y: 115, w: 274, h: 57, lineHeight: 47, group: 0 }] });
  const common = kalamImageScales({ id: 'size-regression', name: '', blocks: [variedA, variedB] });
  assert.equal(common.get(variedA.id), common.get(variedB.id), 'Different glyph ascenders must not change font size within a kalam.');
  const fixed = await fetch(origin + '/api/media/fixed-matam').then((r) => r.json());
  const doc = createBooklet('2026-10-27', 'haram', {}, fixed);
  doc.kalams.noha = [{ id: 'regression', name: '', blocks: [imageBlockFrom(uploaded)] }];
  const layout = paginate(doc);
  const groupPages = new Map<number, Set<number>>();
  for (const [index, p] of layout.pages.entries()) if (p.kind === 'content') for (const item of p.items) {
    if (item.kind !== 'block' || item.block.id !== doc.kalams.noha[0].blocks[0].id || !item.imageRect) continue;
    const group = (item.imageRect as { group: number }).group;
    groupPages.set(group, new Set([...(groupPages.get(group) ?? []), index]));
  }
  assert(groupPages.size >= 5);
  assert([...groupPages.values()].every((p) => p.size === 1), 'A stanza must never straddle a page break.');
  await fetch(origin + '/api/booklet', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) });
  await page.goto(origin); await page.waitForSelector('.opening-words');
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all(Array.from(document.images).map((i) => i.decode())); });
  const geometry = await page.evaluate(() => {
    const pages = [...document.querySelectorAll<HTMLElement>('.page')];
    return pages.flatMap((p) => {
      const root = p.getBoundingClientRect();
      return [...p.querySelectorAll<HTMLElement>('.content .block-img, .content .block-text')].map((b) => ({ bottom: (b.getBoundingClientRect().bottom - root.top) / (root.height / 841.92), right: (b.getBoundingClientRect().right - root.left) / (root.width / 595.32) }));
    });
  });
  assert(geometry.every((b) => b.bottom <= CONTENT.bottom + 1 && b.right <= CONTENT.right + 1), 'Every verse must stay inside the printable border.');
  const marks = await page.locator('.cover-location .as-letter').evaluateAll((els) => els.map((e) => ({ size: getComputedStyle(e).fontSize, top: e.getBoundingClientRect().top })));
  assert.equal(marks[0].size, marks[1].size); assert.equal(marks[0].top, marks[1].top);
  assert.equal(await page.locator('.cover-title.date').evaluate((e) => getComputedStyle(e).fontSize), '36.6667px');
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const saved = await download; await saved.saveAs(`${data}/verified.pdf`);
  const pdf = await PDFDocument.load(await readFile(`${data}/verified.pdf`));
  assert.equal(pdf.getPageCount(), layout.pages.length);
  assert(pdf.getPages().every((p) => Math.abs(p.getWidth() - 595) < 1 && Math.abs(p.getHeight() - 842) < 1));
  const assets = await page.evaluate(async () => {
    const sources = [...new Set([...document.querySelectorAll<HTMLImageElement>('.block-img img')].map((i) => new URL(i.src).pathname))];
    return Object.fromEntries(await Promise.all(sources.map(async (src) => {
      const blob = await fetch(src).then((r) => r.blob());
      const data = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsDataURL(blob); });
      return [src, data];
    })));
  });
  // Start a genuinely different export after removing its backing server file.
  await rename(`${data}/media/${uploaded.id}.${uploaded.rev}.${uploaded.format}`, `${data}/missing.svg`);
  const another = { ...doc, date: '2026-10-26' };
  const request = { doc: another, assets, filename: 'snapshot.pdf', title: 'Snapshot regression' };
  const exportOnce = () => fetch(origin + '/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  const start = performance.now();
  const first = await exportOnce(); assert(first.ok, await first.text().then((s) => s.slice(0, 200)));
  const firstMs = performance.now() - start;
  const repeatStart = performance.now(); const repeat = await exportOnce(); assert(repeat.ok);
  const repeatMs = performance.now() - repeatStart;
  assert(repeatMs < firstMs, 'Identical downloads should reuse the completed PDF.');
  const broken = await fetch(origin + '/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc: another, assets: {}, filename: 'missing.pdf', title: 'Missing image' }) });
  assert.equal(broken.status, 422, 'A missing image must fail explicitly, never produce a blank PDF.');
  const corrupt = await fetch(origin + '/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, title: 'Corrupt image', assets: { ...assets, [mediaSrc(imageBlockFrom(uploaded))]: 'data:image/png;base64,YmFk' } }) });
  assert.equal(corrupt.status, 500, 'Undecodable image data must fail explicitly.');
  // Lose both the saved document and the original server upload. The same
  // browser must restore the original and correct its document references.
  await rename(`${data}/booklet.json`, `${data}/booklet-lost.json`);
  await rename(`${data}/media/${uploaded.id}.json`, `${data}/media-lost.json`);
  await rename(`${data}/media/${uploaded.id}.orig`, `${data}/original-lost.png`);
  await page.reload();
  await page.waitForFunction((old) => {
    const image = document.querySelector<HTMLImageElement>('.kalam .thumb');
    return image && !image.src.includes(old) && image.complete && image.naturalWidth > 0;
  }, uploaded.id);
  assert(await page.locator('.opening-words').count(), 'The recovered document must retain its automatic fihrist entry.');
  assert.equal(errors.length, 0, errors.join('\n'));
  await page.locator('.page').nth(0).screenshot({ path: `${data}/cover.png` });
  await page.locator('.page').nth(1).screenshot({ path: `${data}/fihrist.png` });
  await page.locator('.page').nth(2).screenshot({ path: `${data}/verses.png` });
  await sharp(await readFile(`${data}/media/${uploaded.id}.png`)).flatten({ background: '#fff' }).png().toFile(`${data}/cleaned.png`);
  const result = { pages: pdf.getPageCount(), firstExportMs: Math.round(firstMs), repeatExportMs: Math.round(repeatMs), data, assertions: 'upload cleanup, 18 complete lines, intact stanzas, automatic fihrist, cover typography, A4 geometry, actual download, self-contained export, missing/corrupt image rejection, original/document recovery after server file loss' };
  await writeFile(`${data}/result.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(log); throw error; }
finally {
  await browser.close(); if (server.pid) process.kill(-server.pid, 'SIGTERM');
  server.stdout.destroy(); server.stderr.destroy(); server.unref();
}
