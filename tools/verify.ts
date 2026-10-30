import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { BUILTIN_MEDIA, Booklet, builtinDefaults, createBooklet, effectiveDefaults, imageBlockFrom, moveCategory, sectionsOf, upgradeBooklet } from '../src/booklet/model';
import { CONTENT, kalamImageScales, paginate } from '../src/booklet/paginate';
import { mediaSrc } from '../src/booklet/media';

// Tests the public upload -> saved document -> browser -> PDF path, including
// lost server files and a malformed image. No existing booklet is touched.
await mkdir('work', { recursive: true });
const data = await mkdtemp('work/verify-');
const port = String(20000 + randomInt(30000));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['build/server.js'], {
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
  assert.equal(uploaded.format, 'png', 'Keep antialiased strokes instead of threshold tracing.');
  const lettering = Buffer.from(await fetch(origin + mediaSrc(imageBlockFrom(uploaded))).then((r) => r.arrayBuffer()));
  assert((await sharp(lettering).metadata()).hasAlpha, 'Print lettering must have a real transparent background.');
  const variedA = imageBlockFrom(uploaded, { regions: [{ x: 0, y: 0, w: 274, h: 40, lineHeight: 30, group: 0 }, { x: 0, y: 45, w: 274, h: 65, lineHeight: 55, group: 0 }, { x: 0, y: 115, w: 274, h: 53, lineHeight: 43, group: 0 }] });
  const variedB = imageBlockFrom(uploaded, { regions: [{ x: 0, y: 0, w: 274, h: 42, lineHeight: 32, group: 0 }, { x: 0, y: 45, w: 274, h: 62, lineHeight: 52, group: 0 }, { x: 0, y: 115, w: 274, h: 57, lineHeight: 47, group: 0 }] });
  const common = kalamImageScales({ id: 'size-regression', name: '', blocks: [variedA, variedB] });
  assert.equal(common.get(variedA.id), common.get(variedB.id), 'Different glyph ascenders must not change font size within a kalam.');
  // Two screenshots of one kalam in different fonts/zooms: rows 60px apart
  // with 40px ink, and 90px apart with 52px ink (a bolder face). They must
  // print with one line pitch, and every stanza gap must be identical.
  const rowsAt = (pitch: number, ink: number, count: number, breakAfter = -1) => Array.from({ length: count }, (_, i) => {
    const center = 30 + i * pitch + (i > breakAfter && breakAfter >= 0 ? pitch * 0.6 : 0);
    return { x: 0, y: center - ink / 2 - 4, w: 274, h: ink + 8, lineHeight: ink, group: i > breakAfter && breakAfter >= 0 ? 1 : 0, top: center - ink / 2, bottom: center + ink / 2, center };
  });
  const thin = imageBlockFrom(uploaded, { height: 700, regions: rowsAt(60, 40, 6, 2) });
  const bold = imageBlockFrom(uploaded, { height: 700, regions: rowsAt(90, 52, 4, 1) });
  const mixed = { id: 'pitch-regression', name: '', blocks: [thin, bold] };
  const mixedScales = kalamImageScales(mixed);
  assert(Math.abs(60 * mixedScales.get(thin.id)! - 90 * mixedScales.get(bold.id)!) < 0.01, 'Screenshots of one kalam must share one line pitch.');
  const pitchDoc = createBooklet('2026-10-27', 'haram', {});
  pitchDoc.kalams.noha = [mixed];
  const units = paginate(pitchDoc).pages.flatMap((p) => (p.kind === 'content' ? p.items : [])).filter((i): i is Extract<typeof i, { kind: 'block' }> => i.kind === 'block' && !!i.imageRect);
  assert.equal(units.length, 4, 'Only real source stanza breaks split a screenshot.');
  const centres: number[] = [];
  let at = 0;
  for (const u of units) {
    at += u.lead ?? 0;
    const rows = u.block.regions!.filter((r) => r.group === u.imageRect!.group);
    centres.push(at + (rows[0].center! - u.imageRect!.y) * u.imageScale!);
    at += u.height + (u.gap ?? 0);
    centres.push(at - (u.gap ?? 0) - (u.imageRect!.y + u.imageRect!.h - rows.at(-1)!.center!) * u.imageScale!);
  }
  const breaks = [1, 3, 5].map((i) => centres[i + 1] - centres[i]);
  assert(breaks.every((b) => Math.abs(b - breaks[0]) < 0.01), `Every stanza gap in a kalam must be identical (${breaks.map((b) => b.toFixed(2))}).`);
  // A marathi kalam that fits on a page must never straddle a page break.
  const flowDoc = createBooklet('2026-10-27', 'haram', builtinDefaults('karbala', {}));
  flowDoc.kalams.marathi.forEach((k, i) => { k.blocks = [imageBlockFrom(uploaded, { height: 700, regions: rowsAt(110, 80, i === 2 ? 6 : 5) })]; });
  const flowPages = paginate(flowDoc).pages.filter((p) => p.kind === 'content').map((p) => new Set((p as { items: { kind: string; block?: { id: string } }[] }).items.flatMap((i) => (i.block ? [i.block.id] : []))));
  for (const k of flowDoc.kalams.marathi.filter((m) => m.blocks.length)) assert.equal(flowPages.filter((p) => p.has(k.blocks[0].id)).length, 1, 'A kalam that fits on one page must stay together.');
  // Built-in default pages: cleaned at build time into complete rows.
  const builtinRows: Record<string, number> = { 'fixed-sawari': 12, 'fixed-dua': 8, 'fixed-qasida': 8, 'fixed-manqabat': 8, 'fixed-salam-arz-najaf': 4 };
  const builtinMedia = Object.fromEntries(await Promise.all([...new Set(Object.values(BUILTIN_MEDIA).flat())].map(async (id) => [id, await fetch(`${origin}/api/media/${id}`).then((r) => r.json())])));
  for (const [id, rows] of Object.entries(builtinRows)) assert.equal(builtinMedia[id].regions.length, rows, `${id} must clean into ${rows} complete rows.`);
  // Zikre Husain library: Ya Sayyid al-Shuhada's verses 1, 2 and 4, straight
  // from the PDF: four rows each, one stanza each, verse numbers gone.
  const libIndex = await fetch(`${origin}/library/index.json`).then((r) => r.json());
  assert(libIndex.kalams.length > 1800 && libIndex.kalams[0].v === 51, 'The library lists every kalam; Ya Sayyid al-Shuhada has 51 verses.');
  const plan = await fetch(`${origin}/api/library/0/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verses: [0, 1, 3] }) }).then((r) => r.json());
  assert.deepEqual(plan.ids, ['lib2-0-0t1_3-0'], 'Chosen verses make one image.');
  const verses = await fetch(`${origin}/api/media/${plan.ids[0]}`).then((r) => r.json());
  assert.equal(verses.regions.length, 12, 'Three verses of four rows each.');
  assert.deepEqual([...new Set(verses.regions.map((r: { group: number }) => r.group))], [0, 1, 2], 'Each verse is its own stanza.');
  const versesPng = await readFile(`${data}/media/${verses.id}.${verses.rev}.png`);
  for (const f of await readdir(`${data}/media`)) if (f.startsWith(verses.id)) await rename(`${data}/media/${f}`, `${data}/lost-${f}`);
  const remade = Buffer.from(await fetch(`${origin}/media/${verses.id}.${verses.rev}.png`).then((r) => r.arrayBuffer()));
  assert(remade.equals(versesPng), 'A lost library image is made again, byte for byte, under the same name.');
  const whole = await fetch(`${origin}/api/library/0/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verses: null }) }).then((r) => r.json());
  assert(whole.ids.length > 3 && whole.ids.every((id: string, i: number) => id === `lib2-0-all-${i}`), 'A long kalam comes in several images.');
  // Lettering printed with a drop shadow keeps every line: Ae Allah na Dai's
  // opening line and its اے مولى محمد ! refrain line were whited out with
  // their shadows, leaving six of a verse's seven rows.
  const dai = libIndex.kalams.findIndex((k: { t: string }) => k.t === 'Ae Allah na Dai Nabi na pyaara');
  const daiPlan = await fetch(`${origin}/api/library/${dai}/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verses: [0, 1] }) }).then((r) => r.json());
  const daiMeta = await fetch(`${origin}/api/media/${daiPlan.ids[0]}`).then((r) => r.json());
  assert.equal(daiMeta.regions.length, 14, 'Both verses keep all seven rows, shadowed lines included.');
  // Verses the index link skipped (it points a page late): Ya Sayyid
  // al-Shuhada in Mithi Shitabi opens a page earlier, with eight verses; a
  // booklet's version 1 id still names the verse it named before.
  const mithi = libIndex.kalams.findIndex((k: { t: string }) => k.t === 'Ya Sayyid al-Shuhada (Mithi Shitabi)');
  assert.equal(libIndex.kalams[mithi].v, 8, 'Mithi Shitabi Ya Sayyid al-Shuhada has all eight verses.');
  const legacyMeta = await fetch(`${origin}/api/media/lib1-${mithi}-0-0`).then((r) => r.json());
  const current = await fetch(`${origin}/api/media/lib2-${mithi}-4-0`).then((r) => r.json());
  const [legacyPng, currentPng] = await Promise.all([legacyMeta, current].map((m) => readFile(`${data}/media/${m.id}.${m.rev}.png`)));
  assert(legacyPng.equals(currentPng), 'An older id keeps naming the same verse.');
  // Single misras set in staggered pairs are chosen a couplet at a time.
  const staggered = libIndex.kalams.find((k: { t: string }) => k.t === 'Main Saif-ul-Huda par chhoon sadqe ne waari');
  assert(staggered.c === 2 && staggered.v === 22, 'Staggered misras are chosen as couplets of two rows.');
  const pair = await fetch(`${origin}/api/library/${libIndex.kalams.indexOf(staggered)}/verse-0-1.png`);
  assert(pair.ok, 'The verse picker previews a whole couplet.');
  // A ghazal (couplets with no stanza gaps): every couplet is a verse to
  // choose, and chosen couplets print as one run, with no stanza gaps.
  const ghazal = libIndex.kalams.findIndex((k: { t: string }) => k.t === 'Le ja baad-e-saba bandagi kamtar ki');
  assert(ghazal >= 0 && libIndex.kalams[ghazal].v === libIndex.kalams[ghazal].r && libIndex.kalams[ghazal].v > 20, 'Each couplet of a ghazal is its own verse.');
  const couplets = await fetch(`${origin}/api/library/${ghazal}/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verses: [0, 1, 4] }) }).then((r) => r.json());
  const coupletMeta = await fetch(`${origin}/api/media/${couplets.ids[0]}`).then((r) => r.json());
  assert(couplets.ids.length === 1 && coupletMeta.regions.length === 3, 'Three chosen couplets make three rows.');
  assert.deepEqual([...new Set(coupletMeta.regions.map((r: { group: number }) => r.group))], [0], 'Chosen couplets print as one run.');
  const title = await fetch(`${origin}/api/library/0/title.png`);
  assert(title.ok && (await sharp(Buffer.from(await title.arrayBuffer())).metadata()).width! > 50, 'The search list shows each original title.');
  // Saves that arrive together (typing while the page saves) both land.
  const saves = await Promise.all(Array.from({ length: 6 }, (_, i) => fetch(`${origin}/api/defaults?city=najaf`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n: i }) })));
  assert(saves.every((r) => r.ok), 'Saves at the same moment must all succeed.');
  assert.deepEqual(await fetch(`${origin}/api/defaults?city=najaf`).then((r) => r.json()), { n: 5 }, 'The last save wins.');
  await fetch(`${origin}/api/defaults?city=najaf`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  // Section order: Dua after the Matam (Karbala only), Qasida, Naat and Manqabat after the Quran.
  const order = (venue: Booklet['venue'], o?: Booklet['order']) => sectionsOf({ venue, order: o }).map((s) => s.categories.join(' '));
  assert.deepEqual(order('haram'), ['quran qasida naat manqabat marathi nasihat salam noha matam dua', 'salamArz ratha madh']);
  assert.deepEqual(order('najmi'), ['quran qasida naat manqabat marathi nasihat salam', 'noha matam dua salamArz ratha madh']);
  assert.deepEqual(order('najaf'), ['quran qasida naat manqabat marathi nasihat salam noha matam', 'salamArz ratha madh']);
  const moved = moveCategory(moveCategory(createBooklet('2026-10-27', 'haram', {}), 'dua', 1), 'quran', -1);
  assert.deepEqual(order('haram', moved.order), ['quran qasida naat manqabat marathi nasihat salam noha matam', 'dua salamArz ratha madh'], 'A section moves across the section edge, never past the ends.');
  assert.deepEqual(order('haram', { haram: [['quran', 'qasida', 'madh'], ['salamArz', 'ratha']] })[0], 'quran qasida naat manqabat marathi nasihat salam noha matam dua madh', 'A category missing from a saved order takes its template place.');
  // A version 2 booklet: its fixed content becomes default content it owns.
  const karbalaDefaults = builtinDefaults('karbala', builtinMedia);
  const najafDefaults = builtinDefaults('najaf', builtinMedia);
  const old = { version: 2, date: '2026-10-27', venue: 'haram', overrides: { 'line.salam-arz.1': { from: karbalaDefaults.salamArz.blocks[0].kind === 'text' ? karbalaDefaults.salamArz.blocks[0].text.split('\n')[1] : '', text: 'edited' } },
    kalams: { marathi: [{ id: 'm1', name: 'يا سيد الشهداء', fixed: 'name', slot: 'marathi:1', blocks: [] }, { id: 's', name: 'x', slot: 'marathi:sawari', blocks: [] }], matam: [{ id: 'matam', name: 'm', fixed: 'all', blocks: [] }], salamArz: [{ id: 'salam-arz', name: 'سلام عرض', fixed: 'all', blocks: karbalaDefaults.salamArz.blocks }] } } as unknown as Booklet;
  const up = upgradeBooklet(old, karbalaDefaults, karbalaDefaults);
  assert.equal(up.doc.version, 3);
  assert(Object.values(up.doc.kalams).flat().every((k) => !k.fixed), 'Nothing stays locked after the upgrade.');
  assert.equal((up.doc.kalams.salamArz[0].blocks[0] as { text: string }).text.split('\n')[1], 'edited', 'A typed-over Salam Arz line moves into the text.');
  assert(up.pins.salamArz && !up.doc.overrides?.['line.salam-arz.1'], 'The edited Salam Arz becomes the pinned default.');
  assert.equal(up.doc.kalams.dua.length, 1, 'The Dua default is added once.');
  assert.equal(up.doc.kalams.marathi[1].blocks[0]?.kind, 'image', 'An empty Sawari gets its default screenshot.');
  const najafUp = upgradeBooklet({ ...old, venue: 'najaf' }, najafDefaults, najafDefaults).doc;
  assert(najafUp.kalams.salamArz[0].blocks[0].kind === 'image' && najafUp.kalams.qasida.length === 1 && najafUp.kalams.manqabat.length === 1 && !najafUp.kalams.dua.length, 'Najaf takes its own Salam Arz, Qasida and Manqabat, and no Dua.');
  assert.equal(Object.keys(effectiveDefaults(karbalaDefaults, { dua: { ...karbalaDefaults.dua, off: true } })).includes('dua'), false, 'An unpinned built-in default leaves new booklets.');
  const doc = createBooklet('2026-10-27', 'haram', karbalaDefaults);
  assert(doc.kalams.dua[0].blocks.length && doc.kalams.marathi[3].blocks.length, 'A new Karbala booklet starts with the Dua and Sawari pages.');
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
  const opening = await page.locator('img.opening-words').evaluate((i: HTMLImageElement) => ({ src: i.src, w: i.naturalWidth }));
  assert(opening.src.endsWith('.opening.png') && opening.w > 0, 'The fihrist opening must be a plain decoded image.');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.booklet *')].filter((e) => { const st = getComputedStyle(e); return st.maskImage !== 'none' || st.webkitMaskImage !== 'none' || st.opacity === '0'; }).length), 0, 'No masks or invisible overlays: printers show them as solid boxes.');
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
  // Only the booklet goes up: no image data in the request.
  const sent: number[] = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/export')) sent.push(r.postData()?.length ?? 0); });
  // Start a genuinely different export after removing its backing server file.
  await rename(`${data}/media/${uploaded.id}.${uploaded.rev}.${uploaded.format}`, `${data}/missing.svg`);
  // The server asks for the lost file; the browser sends it once, as bytes.
  const again = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  await (await again).saveAs(`${data}/verified-again.pdf`);
  assert(sent.length && sent.every((n) => n < 200_000), `Download PDF must send only the booklet (${sent}).`);
  assert((await readFile(`${data}/media/${uploaded.id}.${uploaded.rev}.png`)).equals(lettering), 'A file the server lost comes back byte-for-byte.');
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
  assert.deepEqual((await broken.json()).missing, [mediaSrc(imageBlockFrom(uploaded))], 'The server names exactly the files it lacks.');
  const corrupt = await fetch(origin + '/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, title: 'Corrupt image', assets: { ...assets, [mediaSrc(imageBlockFrom(uploaded))]: 'data:image/png;base64,YmFk' } }) });
  assert.equal(corrupt.status, 500, 'Undecodable image data must fail explicitly.');
  // The browser keeps the finished files of each screenshot in the background.
  await page.waitForFunction((id) => new Promise((resolve) => {
    const open = indexedDB.open('karbala-booklet-backup', 1);
    open.onsuccess = () => { const r = open.result.transaction('backup').objectStore('backup').get(`media:${id}`); r.onsuccess = () => resolve(!!r.result?.png && !!r.result?.opening); };
  }), uploaded.id, { timeout: 20_000 });
  // Lose the saved document and every server file of the screenshot (a
  // restart on the free host). The same browser hands the finished files
  // back under the original name: nothing is cleaned again or renamed.
  await rename(`${data}/booklet.json`, `${data}/booklet-lost.json`);
  await rename(`${data}/media/${uploaded.id}.json`, `${data}/media-lost.json`);
  await rename(`${data}/media/${uploaded.id}.orig`, `${data}/original-lost.png`);
  await rename(`${data}/media/${uploaded.id}.${uploaded.rev}.opening.png`, `${data}/opening-lost.png`);
  await page.reload();
  await page.waitForFunction((id) => {
    // Default pages (the Sawari screenshot) come first in the panel.
    const image = [...document.querySelectorAll<HTMLImageElement>('.kalam .thumb')].find((i) => i.src.includes(id));
    return image && image.complete && image.naturalWidth > 0;
  }, uploaded.id);
  const back = await fetch(`${origin}/api/media/${uploaded.id}`).then((r) => r.json());
  assert.equal(back.rev, uploaded.rev, 'A restored screenshot keeps its name and revision.');
  assert((await readFile(`${data}/media/${uploaded.id}.${uploaded.rev}.png`)).equals(lettering), 'Restored lettering is byte-for-byte the finished file.');
  assert((await readFile(`${data}/media/${uploaded.id}.${uploaded.rev}.opening.png`)).equals(await readFile(`${data}/opening-lost.png`)), 'Restored opening words are byte-for-byte too.');
  // Only the versioned PNG and opening words are stored; old SVG links still work.
  const stored = (await readdir(`${data}/media`)).filter((f) => f.startsWith(uploaded.id)).sort();
  assert.deepEqual(stored, [`${uploaded.id}.${uploaded.rev}.opening.png`, `${uploaded.id}.${uploaded.rev}.png`, `${uploaded.id}.json`, `${uploaded.id}.orig`]);
  const legacy = await fetch(`${origin}/media/${uploaded.id}.svg?v=${uploaded.rev}`);
  assert(legacy.ok && (await legacy.text()).includes(lettering.toString('base64')), 'An old SVG entry is rebuilt around the stored PNG.');
  assert(await page.locator('.opening-words').count(), 'The recovered document must retain its automatic fihrist entry.');
  assert.equal(errors.length, 0, errors.join('\n'));
  await page.locator('.page').nth(0).screenshot({ path: `${data}/cover.png` });
  await page.locator('.page').nth(1).screenshot({ path: `${data}/fihrist.png` });
  await page.locator('.page').nth(2).screenshot({ path: `${data}/verses.png` });
  await sharp(lettering).flatten({ background: '#fff' }).png().toFile(`${data}/cleaned.png`);
  const result = { pages: pdf.getPageCount(), firstExportMs: Math.round(firstMs), repeatExportMs: Math.round(repeatMs), data, assertions: 'built-in default pages, Zikre Husain library (index, chosen verses, stanzas, identical remake, titles, shadowed lettering, skipped opening verses, legacy ids, staggered couplets), section order and moves, version 2 upgrade, upload cleanup, 18 complete lines, intact stanzas, shared kalam pitch, identical stanza gaps, whole marathi kalams, unmasked fihrist openings, automatic fihrist, cover typography, A4 geometry, actual download, self-contained export, missing/corrupt image rejection, booklet-only PDF request with lost-file upload, byte-identical same-name restore after server file loss, versioned-PNG-only storage, legacy SVG fallback' };
  await writeFile(`${data}/result.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(log); throw error; }
finally {
  await browser.close(); if (server.pid) process.kill(-server.pid, 'SIGTERM');
  server.stdout.destroy(); server.stderr.destroy(); server.unref();
}
