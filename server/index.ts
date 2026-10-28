// Local server: stores and cleans screenshots, autosaves the working booklet,
// and turns it into a PDF with headless Chromium, which renders exactly what
// the preview shows.
import compression from 'compression';
import express from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright';
import sharp from 'sharp';
import { addMedia, editMedia, ensureFixedMedia, getMedia, MEDIA, pngName, pngSize, readJson, reinstateMedia, writeJson, type MediaMeta } from './store';
import type { ExportRequest, PrintPayload } from '../src/booklet/print';
import { mediaSrc, openingSrc } from '../src/booklet/media';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { PROCESSOR_VERSION, svgWrapper } from './ink';
import { closeRecognition } from './recognize';
import { restorationJob, restorationStatus, startRestoration } from './restore';
import { heavyWork } from './resources';
import { validScript } from './lettering';

const PORT = Number(process.env.PORT ?? 3001);
// 0.0.0.0 when hosted (or to reach it from a phone on the same Wi-Fi).
const HOST = process.env.HOST ?? '127.0.0.1';
const PROD = process.env.NODE_ENV === 'production';
// When set, every page and API call asks for this password (any username).
const PASSWORD = process.env.APP_PASSWORD ?? '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// In dev the page is served by Vite; in production by this server.
const APP_URL = process.env.APP_URL ?? (PROD ? `http://127.0.0.1:${PORT}` : 'http://127.0.0.1:5173');

const app = express();
// Bound native image caches on the free host; keep OCR and the PDF renderer
// from holding their peak allocations at the same time.
sharp.cache({ memory: 16, files: 0, items: 16 });
sharp.concurrency(1);

// For the host's uptime checks; the only route open without the password.
app.get('/api/health', (_req, res) => res.send('ok'));
app.get('/api/version', (_req, res) => res.json({ processorVersion: PROCESSOR_VERSION, revision: process.env.RENDER_GIT_COMMIT ?? 'local' }));

const passwordOk = (header = '') => {
  const [scheme, encoded = ''] = header.split(' ');
  if (scheme !== 'Basic') return false;
  const given = Buffer.from(Buffer.from(encoded, 'base64').toString().replace(/^[^:]*:/, ''));
  const want = Buffer.from(PASSWORD);
  return given.length === want.length && timingSafeEqual(given, want);
};
if (PASSWORD) {
  app.use((req, res, next) => {
    if (passwordOk(req.headers.authorization)) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="Matam Majlis Booklet", charset="UTF-8"');
    res.status(401).send('Password required.');
  });
}

// Code, JSON and HTML travel compressed; images are already compressed. The
// print snapshot only goes to the local Chromium, so it is left as is.
app.use(compression({ filter: (req, res) => !req.path.startsWith('/api/print/') && compression.filter(req, res) }));
app.use(express.json({ limit: '50mb' }));

const route =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e: Error) => {
      console.error(e);
      res.status(500).send(e.message);
    });

app.get('/api/ai/status', (_req, res) => res.json(restorationStatus()));
app.post('/api/media/:id/restore', route(async (req, res) => {
  const script = req.body?.script ?? 'auto';
  if (!validScript(script)) return res.status(400).send('Choose a supported lettering style.');
  res.json(await startRestoration(req.params.id, script));
}));
app.get('/api/ai/jobs/:id', (req, res) => {
  const job = restorationJob(req.params.id);
  if (!job) return res.status(404).send('Restoration not found.');
  res.json(job);
});

// ---- screenshots ----
app.post(
  '/api/media',
  express.raw({ type: () => true, limit: '60mb' }),
  route(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error('No image received.');
    res.json(await addMedia(req.body));
  }),
);
app.post(
  '/api/media/:id/edit',
  route(async (req, res) => res.json(await editMedia(req.params.id, req.body ?? {}))),
);
// After a restart: the browser's copy of a screenshot, under its own name.
// Body: 4-byte length, JSON { meta, sizes: [original, png, opening] }, then
// the three files back to back.
app.post(
  '/api/media/:id/reinstate',
  express.raw({ type: () => true, limit: '60mb' }),
  route(async (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length < 4) return res.status(400).send('No image received.');
    const headerEnd = 4 + body.readUInt32BE(0);
    const header = JSON.parse(body.subarray(4, headerEnd).toString()) as { meta: Partial<MediaMeta>; sizes: number[] };
    const files: Buffer[] = [];
    let at = headerEnd;
    for (const size of header.sizes) { files.push(body.subarray(at, at + size)); at += size; }
    if (at !== body.length || !files[0]?.length) return res.status(400).send('Incomplete screenshot copy.');
    res.json(await reinstateMedia(req.params.id, header.meta, { original: files[0], png: files[1]?.length ? files[1] : undefined, opening: files[2]?.length ? files[2] : undefined }));
  }),
);
app.get(
  '/api/media/:id',
  route(async (req, res) => {
    const m = await getMedia(req.params.id);
    if (!m) return res.status(404).end();
    res.json(m);
  }),
);
// The untouched upload, for the crop/erase editor.
app.get(
  '/api/media/:id/original',
  route(async (req, res) => {
    if (!/^[\w-]+$/.test(req.params.id)) return res.status(400).end();
    const png = await sharp(path.join(MEDIA, `${req.params.id}.orig`)).rotate().png().toBuffer();
    res.type('png').send(png);
  }),
);
// Files are revisioned by ?v=rev, so they can be cached hard.
app.use('/media', express.static(MEDIA, { maxAge: '1y', immutable: true }));
// Very old booklet entries ask for `<id>.svg` or `<id>.<rev>.svg`; only the
// PNG is stored now, so the SVG around it is rebuilt on request.
async function legacySvg(id: string, rev?: number) {
  const meta = await getMedia(id);
  if (!meta) return null;
  const png = await readFile(path.join(MEDIA, pngName(id, rev ?? meta.rev))).catch(() => null);
  const size = png && pngSize(png);
  return size ? svgWrapper(png!, size.width, size.height) : null;
}
app.get(/^\/media\/([\w-]+?)(?:\.(\d+))?\.svg$/, route(async (req, res) => {
  const svg = await legacySvg(req.params[0], req.params[1] ? Number(req.params[1]) : undefined);
  if (!svg) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('svg').send(svg);
}));

// ---- working booklet & pinned defaults ----
// One of each per city: Karbala keeps the original file names, Najaf gets
// its own (?city=najaf).
const cityFile = (req: express.Request, name: string) => (req.query.city === 'najaf' ? `${name}-najaf.json` : `${name}.json`);
app.get('/api/booklet', route(async (req, res) => res.json(await readJson(cityFile(req, 'booklet')))));
app.put('/api/booklet', route(async (req, res) => res.json(await writeJson(cityFile(req, 'booklet'), req.body))));
app.get('/api/defaults', route(async (req, res) => res.json((await readJson(cityFile(req, 'defaults'))) ?? {})));
app.put('/api/defaults', route(async (req, res) => res.json(await writeJson(cityFile(req, 'defaults'), req.body))));

// ---- PDF export ----
const pending = new Map<string, unknown>();
app.get('/api/print/:id', (req, res) => {
  const doc = pending.get(req.params.id);
  if (!doc) return res.status(404).end();
  res.json(doc);
});

// Launch only while printing. Keeping Chromium resident alongside OCR can
// exceed the free host's memory even when neither request is doing work.
// The driver itself is loaded on the first download, not at every start.
let browser: Promise<Browser> | null = null;
const getBrowser = () => (browser ??= import('playwright').then(({ chromium }) => chromium.launch()).then((b) => {
  b.on('disconnected', () => { browser = null; });
  return b;
}).catch((e) => { browser = null; throw e; }));

// Finished PDFs are fetched by a plain link, which phones download more
// reliably than a script-made file. Each is kept for 15 minutes.
const pdfs = new Map<string, Buffer>();
const PDF_TTL = 15 * 60_000;
const completed = new Map<string, { id: string; expires: number }>();
const exporting = new Map<string, Promise<string>>();
let printQueue = Promise.resolve();
app.get('/api/pdf/:id/:filename', (req, res) => {
  const pdf = pdfs.get(req.params.id);
  if (!pdf) return res.status(404).send('This PDF has expired. Download it again from the editor.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(req.params.filename)}`);
  res.end(pdf);
});

// Media files a print may use, and where each lives on disk.
const PRINT_FILE = /^\/media\/([\w-]+)\.(\d+)\.(png|opening\.png)$/;
// A file the server lost (a restart while the page stayed open) comes back
// from the browser once, as plain bytes, and is kept for later prints too.
app.post(
  '/api/export/asset',
  express.raw({ type: () => true, limit: '60mb' }),
  route(async (req, res) => {
    const match = PRINT_FILE.exec(String(req.query.src ?? ''));
    if (!match || !Buffer.isBuffer(req.body) || !pngSize(req.body)) return res.status(400).send('Not a verse image.');
    const file = path.join(MEDIA, `${match[1]}.${match[2]}.${match[3]}`);
    if (!existsSync(file)) { await writeFile(`${file}.tmp`, req.body); await rename(`${file}.tmp`, file); }
    res.end();
  }),
);

app.post(
  '/api/export',
  route(async (req, res) => {
    // The phone sends only the booklet; the server prints from its own copies
    // and asks for any it has lost (`missing`). `assets` (data URLs) are still
    // accepted, as from older pages.
    const { doc, assets: supplied = {}, filename, title } = req.body as ExportRequest;
    if (!doc || doc.version !== 2 || !doc.kalams) return res.status(400).send('No booklet received.');
    const assets: Record<string, string> = {};
    const missing: string[] = [];
    const blocks = Object.values(doc.kalams).flatMap((ks) => ks.flatMap((k) => k.blocks)).filter((b) => b.kind === 'image');
    for (const block of blocks) {
      if (!/^[\w-]+$/.test(block.mediaId)) return res.status(400).send('Invalid screenshot ID.');
      for (const src of [mediaSrc(block), openingSrc(block)]) {
        if (!src || assets[src] || missing.includes(src)) continue;
        if (supplied[src]?.startsWith('data:image/')) { assets[src] = supplied[src]; continue; }
        if (!block.format) {
          const svg = await legacySvg(block.mediaId);
          if (svg) assets[src] = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
          else missing.push(src);
          continue;
        }
        if (!/^\/media\/[\w-]+\.\d+\.(png|svg|opening\.png)$/.test(src)) return res.status(400).send('Invalid screenshot revision.');
        const bytes = await readFile(path.join(MEDIA, src.slice('/media/'.length))).catch(() => null);
        if (bytes) assets[src] = `data:image/${block.format === 'png' ? 'png' : 'svg+xml'};base64,${bytes.toString('base64')}`;
        else missing.push(src);
      }
    }
    if (missing.length) return res.status(422).json({ missing, error: 'A verse image is missing. Re-add its original screenshot before downloading.' });
    const key = createHash('sha256').update(JSON.stringify({ doc, assets, title })).digest('hex');
    const cached = completed.get(key);
    if (cached && cached.expires > Date.now() && pdfs.has(cached.id)) return res.json({ url: `/api/pdf/${cached.id}/${encodeURIComponent(filename)}` });
    if (!exporting.has(key)) {
      const job = printQueue.then(() => heavyWork(async () => {
      await closeRecognition();
      const id = randomUUID();
      const context = await (await getBrowser()).newContext(PASSWORD ? { httpCredentials: { username: 'print', password: PASSWORD } } : {});
      pending.set(id, { doc, assets });
      try {
      const page = await context.newPage();
      await page.goto(`${APP_URL}/?print=${id}`);
      await page.waitForFunction(() => window.__BOOKLET_READY__ === true || !!window.__BOOKLET_ERROR__, null, { timeout: 30_000 });
      const error = await page.evaluate(() => window.__BOOKLET_ERROR__);
      if (error) throw new Error(error);
      const raw = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      const { PDFDocument } = await import('pdf-lib');
      const pdf = await PDFDocument.load(raw);
      pdf.setTitle(title, { showInWindowTitleBar: true });
      pdf.setAuthor('Faiz-e-Husaini Society (Iraq)');
      pdf.setCreator('Karbala Booklet');
      pdf.setLanguage('ar');
      pdfs.set(id, Buffer.from(await pdf.save()));
      completed.set(key, { id, expires: Date.now() + PDF_TTL });
      while (completed.size > 2) {
        const oldest = completed.keys().next().value!;
        pdfs.delete(completed.get(oldest)!.id); completed.delete(oldest);
      }
      setTimeout(() => pdfs.delete(id), PDF_TTL).unref();
      return id;
      } finally {
        pending.delete(id);
        const current = browser;
        browser = null;
        try { await context.close(); }
        finally { if (current) await (await current).close(); }
      }
      }));
      printQueue = job.then(() => undefined, () => undefined);
      exporting.set(key, job.finally(() => exporting.delete(key)));
    }
    const id = await exporting.get(key)!;
    res.json({ url: `/api/pdf/${id}/${encodeURIComponent(filename)}` });
  }),
);

if (PROD) {
  // Built code and styles carry a content hash in their names (dist/app/), so
  // the browser keeps them for good; everything else is checked each visit.
  app.use('/app', express.static(path.join(ROOT, 'dist/app'), { maxAge: '1y', immutable: true }));
  app.use(express.static(path.join(ROOT, 'dist')));
}

await ensureFixedMedia();
const http = app.listen(PORT, HOST, () => console.log(`server on http://${HOST}:${PORT}${PASSWORD ? ' (password on)' : ''}`));
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  http.close();
  await Promise.allSettled([browser?.then((b) => b.close()), closeRecognition()]);
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
