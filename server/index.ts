// Local server: stores and cleans screenshots, autosaves the working booklet,
// and turns it into a PDF with headless Chromium, which renders exactly what
// the preview shows.
import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, Browser } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { addMedia, editMedia, ensureFixedMedia, getMedia, MEDIA, readJson, writeJson } from './store';

const PORT = Number(process.env.PORT ?? 3001);
const PROD = process.env.NODE_ENV === 'production';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// In dev the page is served by Vite; in production by this server.
const APP_URL = process.env.APP_URL ?? (PROD ? `http://127.0.0.1:${PORT}` : 'http://127.0.0.1:5173');

const app = express();
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
const getBrowser = () => (browser ??= chromium.launch());

app.post(
  '/api/export',
  route(async (req, res) => {
    const { doc, filename, title } = req.body as { doc: unknown; filename: string; title: string };
    const id = randomUUID();
    pending.set(id, doc);
    const page = await (await getBrowser()).newPage();
    try {
      await page.goto(`${APP_URL}/?print=${id}`);
      await page.waitForFunction(() => window.__BOOKLET_READY__ === true, null, { timeout: 60_000 });
      const raw = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      const pdf = await PDFDocument.load(raw);
      pdf.setTitle(title, { showInWindowTitleBar: true });
      pdf.setAuthor('Faiz-e-Husaini Society (Iraq)');
      pdf.setCreator('Karbala Booklet');
      pdf.setLanguage('ar');
      const out = await pdf.save();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.end(Buffer.from(out));
    } finally {
      pending.delete(id);
      await page.close();
    }
  }),
);

if (PROD) {
  app.use(express.static(path.join(ROOT, 'dist')));
}

await ensureFixedMedia();
app.listen(PORT, '127.0.0.1', () => console.log(`server on http://127.0.0.1:${PORT}`));
