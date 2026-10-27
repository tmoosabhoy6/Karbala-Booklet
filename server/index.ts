// Local server: stores and cleans screenshots, autosaves the working booklet,
// and turns it into a PDF with headless Chromium, which renders exactly what
// the preview shows.
import express from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, Browser } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { addMedia, editMedia, ensureFixedMedia, getMedia, MEDIA, readJson, writeJson } from './store';
import type { PrintPayload } from '../src/booklet/print';
import { mediaSrc } from '../src/booklet/media';
import { readFile } from 'node:fs/promises';
import { PROCESSOR_VERSION } from './ink';
import { closeRecognition } from './recognize';

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

// For the host's uptime checks; the only route open without the password.
app.get('/api/health', (_req, res) => res.send('ok'));
app.get('/api/version', (_req, res) => res.json({ processorVersion: PROCESSOR_VERSION }));

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

app.use(express.json({ limit: '50mb' }));

const route =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e: Error) => {
      console.error(e);
      res.status(500).send(e.message);
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

// ---- working booklet & pinned defaults ----
app.get('/api/booklet', route(async (_req, res) => res.json(await readJson('booklet.json'))));
app.put('/api/booklet', route(async (req, res) => res.json(await writeJson('booklet.json', req.body))));
app.get('/api/defaults', route(async (_req, res) => res.json((await readJson('defaults.json')) ?? {})));
app.put('/api/defaults', route(async (req, res) => res.json(await writeJson('defaults.json', req.body))));

// ---- PDF export ----
const pending = new Map<string, unknown>();
app.get('/api/print/:id', (req, res) => {
  const doc = pending.get(req.params.id);
  if (!doc) return res.status(404).end();
  res.json(doc);
});

// One warm browser keeps exports fast.
let browser: Promise<Browser> | null = null;
const getBrowser = () => (browser ??= chromium.launch().then((b) => {
  b.on('disconnected', () => { browser = null; });
  return b;
}).catch((e) => { browser = null; throw e; }));

// Finished PDFs are fetched by a plain link, which phones download more
// reliably than a script-made file. Each is kept for 15 minutes.
const pdfs = new Map<string, Buffer>();
const PDF_TTL = 15 * 60_000;
const completed = new Map<string, { id: string; expires: number }>();
const exporting = new Map<string, Promise<string>>();
app.get('/api/pdf/:id/:filename', (req, res) => {
  const pdf = pdfs.get(req.params.id);
  if (!pdf) return res.status(404).send('This PDF has expired. Download it again from the editor.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(req.params.filename)}`);
  res.end(pdf);
});

app.post(
  '/api/export',
  route(async (req, res) => {
    const { doc, assets: supplied = {}, filename, title } = req.body as PrintPayload & { filename: string; title: string };
    if (!doc || doc.version !== 2 || !doc.kalams) return res.status(400).send('No booklet received.');
    const assets: Record<string, string> = {};
    const blocks = Object.values(doc.kalams).flatMap((ks) => ks.flatMap((k) => k.blocks)).filter((b) => b.kind === 'image');
    for (const block of blocks) {
      const src = mediaSrc(block);
      if (assets[src]) continue;
      if (supplied[src]?.startsWith('data:image/')) assets[src] = supplied[src];
      else {
        if (!/^[\w-]+$/.test(block.mediaId)) return res.status(400).send('Invalid screenshot ID.');
        try {
          const name = block.format === 'png' ? `${block.mediaId}.${Number(block.rev)}.png` : `${block.mediaId}.svg`;
          const bytes = await readFile(path.join(MEDIA, name));
          assets[src] = `data:image/${block.format === 'png' ? 'png' : 'svg+xml'};base64,${bytes.toString('base64')}`;
        } catch { return res.status(422).send('A verse image is missing. Re-add its original screenshot before downloading.'); }
      }
    }
    const key = createHash('sha256').update(JSON.stringify({ doc, assets, title })).digest('hex');
    const cached = completed.get(key);
    if (cached && cached.expires > Date.now() && pdfs.has(cached.id)) return res.json({ url: `/api/pdf/${cached.id}/${encodeURIComponent(filename)}` });
    if (!exporting.has(key)) exporting.set(key, (async () => {
      const id = randomUUID();
      pending.set(id, { doc, assets });
      const context = await (await getBrowser()).newContext(PASSWORD ? { httpCredentials: { username: 'print', password: PASSWORD } } : {});
      const page = await context.newPage();
      try {
      await page.goto(`${APP_URL}/?print=${id}`);
      await page.waitForFunction(() => window.__BOOKLET_READY__ === true || !!window.__BOOKLET_ERROR__, null, { timeout: 30_000 });
      const error = await page.evaluate(() => window.__BOOKLET_ERROR__);
      if (error) throw new Error(error);
      const raw = await page.pdf({ preferCSSPageSize: true, printBackground: true });
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
        await context.close();
      }
    })().finally(() => exporting.delete(key)));
    const id = await exporting.get(key)!;
    res.json({ url: `/api/pdf/${id}/${encodeURIComponent(filename)}` });
  }),
);

if (PROD) {
  app.use(express.static(path.join(ROOT, 'dist')));
}

await ensureFixedMedia();
const http = app.listen(PORT, HOST, () => console.log(`server on http://${HOST}:${PORT}${PASSWORD ? ' (password on)' : ''}`));
void getBrowser().catch((e) => console.error('PDF browser warm-up:', e.message));
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
