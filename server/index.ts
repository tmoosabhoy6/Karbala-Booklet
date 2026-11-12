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
import { addMedia, cleanUp, currentLibraryMedia, DATA, editMedia, ensureFixedMedia, ensureMediaFile, ensureOriginal, getMedia, MEDIA, pngName, pngSize, readJson, reinstateMedia, removeFile, storeLibraryMedia, writeJson, type MediaMeta } from './store';
import type { ExportRequest, PrintPayload } from '../src/booklet/print';
import { mediaSrc, openingSrc } from '../src/booklet/media';
import { paginate } from '../src/booklet/paginate';
import { mergeDuplicateStreams } from './pdf';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { PROCESSOR_VERSION, svgWrapper } from './ink';
import { abortRecognition, closeRecognition } from './recognize';
import { restorationJob, restorationStatus, startRestoration } from './restore';
import { beforeOtherHeavyWork, heavyWaiting, heavyWork, whenHeavyWorkIsStuck } from './resources';
import { validScript } from './lettering';
import { durableStatus, ensureLocal, flushDurable, mirror, requireStorage, settled, squashHistory, startRepoSync, StorageUnavailable } from './durable';
import { abortLibrary, closeLibrary, isLibraryMedia, libraryAvailable, libraryGeometry, libraryPlan, libraryPreview, librarySource } from './library';

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
app.get('/api/version', (_req, res) => res.json({ processorVersion: PROCESSOR_VERSION, revision: process.env.RENDER_GIT_COMMIT ?? 'local', storage: durableStatus() }));

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
      // Storage that could not be checked: try again later (the editor says so).
      if (e instanceof StorageUnavailable) return res.status(503).send(e.message);
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
    // `existing`: only a library verse already made (the browser makes it otherwise).
    const m = req.query.existing && isLibraryMedia(req.params.id) ? await currentLibraryMedia(req.params.id) : await getMedia(req.params.id);
    if (!m) return res.status(404).end();
    res.json(m);
  }),
);
// The untouched upload, for the crop/erase editor.
app.get(
  '/api/media/:id/original',
  route(async (req, res) => {
    if (!/^[\w-]+$/.test(req.params.id)) return res.status(400).end();
    // A library verse made in the browser has no original yet: rendered here.
    if (!(await ensureOriginal(req.params.id))) return res.status(404).end();
    const png = await sharp(path.join(MEDIA, `${req.params.id}.orig`)).rotate().png().toBuffer();
    res.type('png').send(png);
  }),
);
// ---- Zikre Husain library ----
app.get('/api/library', (_req, res) => res.json({ available: libraryAvailable() }));
// The PDF and its geometry, for the browser to render verses itself
// (src/library/client.ts). Each version's URL never changes content.
app.get('/api/library/source.pdf', (req, res) => {
  const file = librarySource(), lib = libraryGeometry();
  if (!file || !lib) return res.status(404).send('The kalam library is not available on this server.');
  if (req.query.v === lib.sha) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('application/pdf').sendFile(file);
});
app.get('/api/library/geometry', (req, res) => {
  const lib = libraryGeometry();
  if (!lib) return res.status(404).send('The kalam library is not available on this server.');
  if (req.query.v === lib.build) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.json(lib);
});
// A library verse finished in the browser. Body: 4-byte length, JSON
// { build, meta, sizes: [png, opening] }, then the two files back to back.
app.post(
  '/api/library/media/:id',
  express.raw({ type: () => true, limit: '60mb' }),
  route(async (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length < 4) return res.status(400).send('No image received.');
    const headerEnd = 4 + body.readUInt32BE(0);
    const header = JSON.parse(body.subarray(4, headerEnd).toString()) as { build: string; meta: Partial<MediaMeta>; sizes: number[] };
    const [pngLength, openingLength] = header.sizes ?? [];
    if (headerEnd + pngLength + openingLength !== body.length) return res.status(400).send('Incomplete verse image.');
    const png = body.subarray(headerEnd, headerEnd + pngLength), opening = body.subarray(headerEnd + pngLength);
    try {
      res.json(await storeLibraryMedia(req.params.id, header.build, header.meta, png, opening));
    } catch (error) {
      res.status(409).send((error as Error).message);
    }
  }),
);
app.post('/api/library/:n/plan', route(async (req, res) => {
  const verses = req.body?.verses;
  res.json(libraryPlan(Number(req.params.n), Array.isArray(verses) ? verses.map(Number) : null));
}));
// Previews never change for a given library build (the URL carries its version).
app.get(/^\/api\/library\/(\d+)\/(title|verse-(\d+)(?:-(\d+))?)\.png$/, route(async (req, res) => {
  const first = Number(req.params[2]), last = req.params[3] === undefined ? first : Number(req.params[3]);
  const png = await heavyWork(() => libraryPreview(Number(req.params[0]), req.params[2] !== undefined ? [first, last] : 'title'));
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('png').send(png);
}));
// A library verse image the server no longer has is made again, identically.
app.use('/media', (req, res, next) => {
  const match = /^\/(lib[\w-]+?)\.\d+\.(png|opening\.png)$/.exec(req.path);
  if (!match || !isLibraryMedia(match[1]) || existsSync(path.join(MEDIA, req.path.slice(1)))) return next();
  getMedia(match[1]).then(() => next(), next);
});

// A file a restart wiped comes back from durable storage (server/durable.ts).
app.use('/media', (req, res, next) => {
  const name = req.path.slice(1);
  if (!/^[\w-]+\.\d+\.(png|opening\.png)$/.test(name) || existsSync(path.join(MEDIA, name))) return next();
  ensureMediaFile(name).then(() => next(), next);
});
// Files are revisioned by ?v=rev, so they can be cached hard.
app.use('/media', express.static(MEDIA, { maxAge: '1y', immutable: true }));
// Very old booklet entries ask for `<id>.svg` or `<id>.<rev>.svg`; only the
// PNG is stored now, so the SVG around it is rebuilt on request.
async function legacySvg(id: string, rev?: number) {
  const meta = await getMedia(id);
  if (!meta) return null;
  await ensureMediaFile(pngName(id, rev ?? meta.rev));
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
// Every saved copy has a stamp (X-Saved-At). A save names the copy it
// replaces: a phone still holding an older copy never overwrites the laptop's
// newer defaults or booklet; it is told to take the newer copy instead (409).
const stampFile = (file: string) => file.replace(/\.json$/, '.stamp.json');
const savedAt = async (file: string) => (await readJson<{ savedAt: number }>(stampFile(file)))?.savedAt ?? 0;
const saves = new Map<string, Promise<unknown>>();
// How the copy to durable storage is doing, for the editor's "Saved" label.
const storageHeaders = (res: express.Response) => {
  const s = durableStatus();
  res.setHeader('X-Storage-Pending', String(s.pending));
  if (s.retrying) res.setHeader('X-Storage-Failing', '1');
};
for (const [name, empty] of [['booklet', null], ['defaults', {}]] as const) {
  app.get(`/api/${name}`, route(async (req, res) => {
    // Until the stored copy is known (the first sync after a wake-up), there
    // is nothing to answer: an empty booklet here would be taken for the
    // real one and saved over it.
    requireStorage();
    const file = cityFile(req, name);
    const [value, stamp] = await Promise.all([readJson(file), savedAt(file)]);
    res.setHeader('X-Saved-At', String(stamp));
    res.setHeader('Cache-Control', 'no-store');
    storageHeaders(res);
    res.json(value ?? empty);
  }));
  app.put(`/api/${name}`, route(async (req, res) => {
    requireStorage();
    const file = cityFile(req, name);
    // One save per file at a time, so the stamp check and the write go together.
    const turn = (saves.get(file) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      // X-Based-On: the saved copy this one replaces (a page from before
      // stamps sends none and always saves). X-Restore: this is that copy
      // itself, handed back after a restart, so it keeps its stamp.
      const stored = await savedAt(file);
      const based = Number(req.get('X-Based-On') ?? Infinity);
      if (!(based >= stored)) return { stale: true, stored };
      // The very copy already saved: nothing changed, so the stamp stays and
      // no other device is told of a newer copy.
      const body = JSON.stringify(req.body);
      if (stored && (await readFile(path.join(DATA, file), 'utf8').catch(() => null)) === body) return { stale: false, stored };
      const stamp = req.get('X-Restore') === '1' && Number.isFinite(based) ? based : Math.max(Date.now(), stored + 1);
      await writeJson(file, req.body);
      await writeJson(stampFile(file), { savedAt: stamp });
      return { stale: false, stored: stamp };
    });
    saves.set(file, turn);
    const result = await turn;
    res.setHeader('X-Saved-At', String(result.stored));
    storageHeaders(res);
    if (result.stale) return res.status(409).json({ error: 'A newer copy was saved from another device.', savedAt: result.stored });
    res.json(null);
  }));
}

// ---- kalam PDFs added in the editor (src/library/user.ts) ----
// Each device finds the kalams in a PDF itself; the PDF and what was found
// in it (with the names given to each kalam) are kept here too, so every
// device has every added PDF. `pdfs/index.json` lists them, removed ones
// included (so a device that still has one drops it).
const PDFS = path.join(DATA, 'pdfs');
const pdfFile = (key: string, ext: string) => (/^u:[0-9a-f]{16}$/.test(key) ? path.join(PDFS, `${key.slice(2)}.${ext}`) : null);
type SharedPdf = { key: string; updated: number; deleted?: boolean };
await mkdir(PDFS, { recursive: true });
const pdfIndex = async () => (await readJson<SharedPdf[]>('pdfs/index.json')) ?? [];
let pdfTurn = Promise.resolve();
const updateIndex = (entry: SharedPdf) => (pdfTurn = pdfTurn.catch(() => undefined).then(async () => {
  const list = (await pdfIndex()).filter((p) => p.key !== entry.key);
  await writeJson('pdfs/index.json', [...list, entry]);
}));
app.get('/api/pdfs', route(async (_req, res) => { requireStorage(); res.setHeader('Cache-Control', 'no-store'); res.json(await pdfIndex()); }));
app.get('/api/pdfs/:key', route(async (req, res) => {
  const file = pdfFile(req.params.key, 'json');
  if (!file || !(await ensureLocal(DATA, file))) return res.status(404).end();
  res.type('json').sendFile(file);
}));
app.get('/api/pdfs/:key/file', route(async (req, res) => {
  const file = pdfFile(req.params.key, 'pdf');
  if (!file || !(await ensureLocal(DATA, file))) return res.status(404).end();
  res.type('application/pdf').sendFile(file);
}));
app.put('/api/pdfs/:key/file', express.raw({ type: () => true, limit: '80mb' }), route(async (req, res) => {
  const file = pdfFile(req.params.key, 'pdf');
  const body = req.body as Buffer;
  if (!file || !Buffer.isBuffer(body) || body.subarray(0, 5).toString() !== '%PDF-') return res.status(400).send('Not a PDF.');
  await mkdir(PDFS, { recursive: true });
  if (!existsSync(file)) { await writeFile(`${file}.tmp`, body); await rename(`${file}.tmp`, file); mirror(DATA, file, body); }
  res.end();
}));
app.put('/api/pdfs/:key', route(async (req, res) => {
  const file = pdfFile(req.params.key, 'json');
  const updated = Number(req.body?.updated);
  if (!file || !req.body?.pdf || !req.body?.lib || !Array.isArray(req.body?.kalams) || !Number.isFinite(updated)) return res.status(400).send('Incomplete PDF details.');
  requireStorage();
  const known = (await pdfIndex()).find((p) => p.key === req.params.key);
  if (known && known.updated > updated) return res.status(409).json(known);
  await mkdir(PDFS, { recursive: true });
  await writeJson(path.relative(DATA, file), req.body);
  await updateIndex({ key: req.params.key, updated });
  res.json(null);
}));
app.delete('/api/pdfs/:key', route(async (req, res) => {
  if (!pdfFile(req.params.key, 'json')) return res.status(400).end();
  requireStorage();
  await updateIndex({ key: req.params.key, updated: Number(req.query.updated) || Date.now(), deleted: true });
  // The index keeps the removal (so other devices drop it too); the PDF and
  // its details go from the folder at once, rather than staying public.
  const key = req.params.key.slice(2);
  await Promise.all([removeFile(`pdfs/${key}.pdf`), removeFile(`pdfs/${key}.json`)]);
  res.json(null);
}));

// ---- PDF export ----
const pending = new Map<string, unknown>();
app.get('/api/print/:id', (req, res) => {
  const doc = pending.get(req.params.id);
  if (!doc) return res.status(404).end();
  res.json(doc);
});

// Launched for the first download, then kept warm for a little while (a
// second download after a small fix starts at once): closed after
// BROWSER_IDLE, and straight away before any other heavy work (cleaning a
// screenshot, OCR), since keeping Chromium resident alongside them can exceed
// the free host's memory.
let browser: Promise<Browser> | null = null;
let browserIdle: NodeJS.Timeout | undefined;
const BROWSER_IDLE = Number(process.env.BROWSER_IDLE_MS ?? 120_000);
const getBrowser = () => {
  clearTimeout(browserIdle);
  return (browser ??= import('playwright').then(({ chromium }) => chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})).then((b) => {
    b.on('disconnected', () => { browser = null; });
    return b;
  }).catch((e) => { browser = null; throw e; }));
};
async function closeBrowser() {
  clearTimeout(browserIdle);
  const current = browser;
  browser = null;
  if (current) await (await current.catch(() => null))?.close().catch(() => undefined);
}
beforeOtherHeavyWork(closeBrowser);
whenHeavyWorkIsStuck(closeBrowser);
whenHeavyWorkIsStuck(abortRecognition);
whenHeavyWorkIsStuck(abortLibrary);

// Finished PDFs are fetched by a plain link, which phones download more
// reliably than a script-made file. Each is kept for 15 minutes.
const pdfs = new Map<string, Buffer>();
/** Pages per Chromium print (see the export below). */
const PRINT_CHUNK = Number(process.env.PRINT_CHUNK ?? 6);
/** Pieces printed from one page before a fresh one. */
const PAGE_REUSE = Number(process.env.PRINT_PAGE_REUSE ?? 4);
const PDF_TTL = 15 * 60_000;
const completed = new Map<string, { id: string; expires: number }>();
const exporting = new Map<string, ExportJob>();
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
    if (!existsSync(file)) { await writeFile(`${file}.tmp`, req.body); await rename(`${file}.tmp`, file); mirror(DATA, file, req.body); }
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
    if (!doc || (doc.version !== 2 && doc.version !== 3) || !doc.kalams) return res.status(400).send('No booklet received.');
    const assets: Record<string, string> = {};
    const missing: string[] = [];
    let outdated = false;
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
        if (isLibraryMedia(block.mediaId) && !(await ensureMediaFile(src.slice('/media/'.length)))) {
          const meta = await getMedia(block.mediaId).catch(() => null);
          if (meta && meta.rev !== block.rev) outdated = true;
        }
        // Files the server has are loaded by the print page from /media, by
        // their revisioned name: inlined as data URLs they were copied into
        // the snapshot, its JSON and every page that shows a slice of them,
        // which ran a long booklet out of the free host's memory.
        if (!(await ensureMediaFile(src.slice('/media/'.length)))) missing.push(src);
      }
    }
    if (outdated) return res.status(409).json({ missing, error: 'The Zikre Husain verses have been updated. Reload the page, then download again.' });
    if (missing.length) return res.status(422).json({ missing, error: 'A verse image is missing. Re-add its original screenshot before downloading.' });
    const key = createHash('sha256').update(JSON.stringify({ doc, assets, title })).digest('hex');
    const cached = completed.get(key);
    if (cached && cached.expires > Date.now() && pdfs.has(cached.id)) return res.json({ url: `/api/pdf/${cached.id}/${encodeURIComponent(filename)}` });
    const prepare = !!(req.body as { prepare?: boolean }).prepare;
    const start = () => {
      // A download asked for now outranks every PDF being made ahead.
      const job: ExportJob = { wanted: !prepare, generation: ++latestPrepare, promise: null! };
      job.promise = printQueue.then(() => heavyWork(() => printBooklet(job, doc, assets, title, key), { print: true }));
      printQueue = job.promise.then(() => undefined, () => undefined);
      exporting.set(key, job);
      job.promise.finally(() => { if (exporting.get(key) === job) exporting.delete(key); }).catch(() => undefined);
      return job;
    };
    const running = exporting.get(key) ?? start();
    running.wanted ||= !prepare;
    // Made ahead while the booklet sits unchanged (see Editor): no download.
    if (prepare) return res.status(202).json(null);
    const made = (job: ExportJob) => job.promise.catch((error) => { if (error instanceof Superseded) return null; throw error; });
    const id = (await made(running)) ?? (await made(start()));
    if (!id) throw new Error('The PDF could not be made. Try again.');
    res.json({ url: `/api/pdf/${id}/${encodeURIComponent(filename)}` });
  }),
);

/** A PDF made ahead of time is dropped when the booklet changes again, or
 * when other work (a new screenshot) is waiting for the server. */
interface ExportJob { wanted: boolean; generation: number; promise: Promise<string> }
let latestPrepare = 0;
class Superseded extends Error {}
const superseded = (job: ExportJob) => !job.wanted && (job.generation !== latestPrepare || heavyWaiting() > 0 || [...exporting.values()].some((j) => j !== job && j.wanted));

async function printBooklet(job: ExportJob, doc: ExportRequest['doc'], assets: Record<string, string>, title: string, key: string): Promise<string> {
  if (superseded(job)) throw new Superseded('A newer booklet replaced this one.');
  const started = Date.now();
  await Promise.all([closeRecognition(), closeLibrary()]);
  const id = randomUUID();
  const context = await (await getBrowser()).newContext(PASSWORD ? { httpCredentials: { username: 'print', password: PASSWORD } } : {});
  pending.set(id, { doc, assets });
  try {
    // A few pages at a time, the pieces joined after: Chromium keeps every
    // image a page shows, and a long booklet of library verses decodes to
    // more than the free host's memory. One print page serves several pieces
    // (it is told which pages to show next); a fresh one every few pieces
    // lets go of what the earlier ones loaded.
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.create();
    const count = paginate(doc).pages.length;
    let page: Awaited<ReturnType<typeof context.newPage>> | null = null;
    let uses = 0;
    for (let from = 0; from < count; from += PRINT_CHUNK) {
      if (superseded(job)) throw new Superseded('A newer booklet replaced this one.');
      const to = Math.min(count, from + PRINT_CHUNK);
      if (page && uses >= PAGE_REUSE) { await page.close(); page = null; }
      if (!page) {
        page = await context.newPage();
        uses = 0;
        await page.goto(`${APP_URL}/?print=${id}&from=${from}&to=${to}`);
      } else {
        await page.evaluate(([a, b]) => window.__BOOKLET_RANGE__!(a, b), [from, to] as const);
      }
      uses++;
      await page.waitForFunction(() => window.__BOOKLET_READY__ === true || !!window.__BOOKLET_ERROR__, null, { timeout: 120_000 });
      const error = await page.evaluate(() => window.__BOOKLET_ERROR__);
      if (error) throw new Error(error);
      const part = await PDFDocument.load(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
      for (const p of await pdf.copyPages(part, part.getPageIndices())) pdf.addPage(p);
      console.log(`export: pages ${from}-${to} of ${count} printed by ${Date.now() - started}ms`);
    }
    if (pdf.getPageCount() !== count) throw new Error(`The PDF came out with ${pdf.getPageCount()} pages instead of ${count}.`);
    mergeDuplicateStreams(pdf);
    pdf.setTitle(title, { showInWindowTitleBar: true });
    pdf.setAuthor('Faiz-e-Husaini Society (Iraq)');
    pdf.setCreator('Karbala Booklet');
    pdf.setLanguage('ar');
    pdfs.set(id, Buffer.from(await pdf.save({ objectsPerTick: Infinity })));
    console.log(`export: ${count} pages, ${(pdfs.get(id)!.length / 1e6).toFixed(1)} MB in ${Date.now() - started}ms${job.wanted ? '' : ' (made ahead)'}`);
    completed.set(key, { id, expires: Date.now() + PDF_TTL });
    while (completed.size > 2) {
      const oldest = completed.keys().next().value!;
      pdfs.delete(completed.get(oldest)!.id); completed.delete(oldest);
    }
    setTimeout(() => pdfs.delete(id), PDF_TTL).unref();
    return id;
  } finally {
    pending.delete(id);
    await context.close().catch(() => undefined);
    clearTimeout(browserIdle);
    browserIdle = setTimeout(() => void closeBrowser(), BROWSER_IDLE);
    browserIdle.unref();
  }
}

if (PROD) {
  // Built code and styles carry a content hash in their names (dist/app/), so
  // the browser keeps them for good; everything else is checked each visit.
  // Pre-compressed WebAssembly (scripts/build-server.mjs) for browsers that take brotli.
  app.get(/^\/app\/[\w.-]+\.wasm$/, (req, res, next) => {
    const file = path.join(ROOT, 'dist', `${req.path}.br`);
    if (!/\bbr\b/.test(String(req.headers['accept-encoding'] ?? '')) || !existsSync(file)) return next();
    res.setHeader('Content-Encoding', 'br');
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('application/wasm').sendFile(file);
  });
  app.use('/app', express.static(path.join(ROOT, 'dist/app'), { maxAge: '1y', immutable: true }));
  app.use(express.static(path.join(ROOT, 'dist')));
}

// A file a restart wiped and storage could not be asked for: try again later.
app.use((error: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(error);
  if (error instanceof StorageUnavailable) return res.status(503).send(error.message);
  console.error(error);
  res.status(500).send('Something went wrong on the server.');
});

await ensureFixedMedia();
// The stored work (server/durable.ts) is here before the first visit.
await startRepoSync(DATA);
// Files nothing uses any more go, after a grace period (store.ts cleanUp);
// the storage branch's history is dropped when it has grown long.
const CLEANUP_DELAY = Number(process.env.STORAGE_CLEANUP_DELAY_SECONDS ?? 600) * 1000;
const cleaning = async () => {
  try {
    if (!durableStatus().ready) return;
    const { removed, waiting } = await cleanUp();
    if (removed || waiting) console.log(`storage: ${removed} unused file(s) removed, ${waiting} unused and waiting`);
    // Once the removals are in, the history (which still holds them) can go.
    if (await settled()) await squashHistory();
  } catch (error) {
    console.error('Cleaning up storage failed:', (error as Error).message);
  }
};
setTimeout(() => { void cleaning(); setInterval(() => void cleaning(), 6 * 3600_000).unref(); }, CLEANUP_DELAY).unref();
const http = app.listen(PORT, HOST, () => console.log(`server on http://${HOST}:${PORT}${PASSWORD ? ' (password on)' : ''}`));
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  http.close();
  await Promise.allSettled([closeBrowser(), closeRecognition(), closeLibrary(), flushDurable()]);
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
