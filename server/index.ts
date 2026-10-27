// Local server: serves the app and turns a booklet into a PDF with headless
// Chromium, which renders exactly what the preview shows.
import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, Browser } from 'playwright';
import { PDFDocument } from 'pdf-lib';

const PORT = Number(process.env.PORT ?? 3001);
const PROD = process.env.NODE_ENV === 'production';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// In dev the page is served by Vite; in production by this server.
const APP_URL = process.env.APP_URL ?? (PROD ? `http://127.0.0.1:${PORT}` : 'http://127.0.0.1:5173');

const app = express();
app.use(express.json({ limit: '200mb' }));

const pending = new Map<string, unknown>();
app.get('/api/print/:id', (req, res) => {
  const doc = pending.get(req.params.id);
  if (!doc) return res.status(404).end();
  res.json(doc);
});

// One warm browser keeps exports fast.
let browser: Promise<Browser> | null = null;
const getBrowser = () => (browser ??= chromium.launch());

app.post('/api/export', async (req, res) => {
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
  } catch (e) {
    console.error(e);
    res.status(500).send((e as Error).message);
  } finally {
    pending.delete(id);
    await page.close();
  }
});

if (PROD) {
  app.use(express.static(path.join(ROOT, 'dist')));
}

app.listen(PORT, '127.0.0.1', () => console.log(`server on http://127.0.0.1:${PORT}`));
