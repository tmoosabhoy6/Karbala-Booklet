// The Zikre Husain kalam library: any kalam (or chosen verses of a long one)
// rendered straight from the PDF's vector lettering, then cleaned like a
// screenshot, so it prints exactly like the rest of the booklet.
//
// tools/build_library.py found every kalam, its verses and what must never
// print (page numbers, title boxes, verse numbers); server/library/library.json
// holds that geometry. Rendering runs in a worker thread with MuPDF, which is
// closed when idle and before printing: WebAssembly memory never shrinks, and
// the free host has 512 MB.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import { blockOf, blockRequest, LIBRARY_ID, planIds, previewRequest, type Library, type RenderRequest } from '../src/library/geometry';
import { renderPixels } from '../src/library/render';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY_FILE = path.join(ROOT, 'server/library/library.json');

let library: Library | null | undefined;
const load = (): Library | null => {
  if (library !== undefined) return library;
  try {
    library = JSON.parse(readFileSync(LIBRARY_FILE, 'utf8')) as Library;
    if (!existsSync(path.join(ROOT, library.source))) throw new Error(`${library.source} is missing`);
  } catch (error) {
    console.error('Kalam library unavailable:', (error as Error).message);
    library = null;
  }
  return library;
};
export const libraryAvailable = () => !!load();
/** The geometry, for the browser to render verses itself (src/library/worker.ts). */
export const libraryGeometry = () => load();
/** The PDF the library renders from. */
export const librarySource = () => { const lib = load(); return lib ? path.join(ROOT, lib.source) : null; };
/** What a library image is made from: the geometry and this renderer. An
 * image made by an older build is made again, under a new revision. */
const RENDERER = 2;
export const libraryBuild = () => `${load()?.build ?? load()?.sha ?? 'none'}-r${RENDERER}`;

export const isLibraryMedia = (id: string) => LIBRARY_ID.test(id);

export function libraryPlan(n: number, verses: number[] | null) {
  const lib = load();
  if (!lib) throw new Error('No such kalam in the library.');
  return { ids: planIds(lib, n, verses) };
}

// ---- rendering worker -----------------------------------------------------

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
// tsx (dev) keeps function names with an __name helper the source may call.
const __name = (f) => f;
const renderPixels = (${renderPixels.toString()});
let doc;
const ready = import(workerData.mupdf).then((mupdf) => {
  doc = mupdf.Document.openDocument(require('node:fs').readFileSync(workerData.file), 'application/pdf');
  return mupdf;
});
parentPort.on('message', async ({ id, request }) => {
  try {
    const out = renderPixels(await ready, doc, request);
    parentPort.postMessage({ id, data: out }, [out.buffer]);
  } catch (error) {
    parentPort.postMessage({ id, error: String(error && error.message || error) });
  }
});
`;

let worker: Worker | null = null;
let idleTimer: NodeJS.Timeout | undefined;
let nextJob = 0;
const waiting = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }>();

function getWorker() {
  if (worker) return worker;
  const lib = load();
  if (!lib) throw new Error('The kalam library is not available on this server.');
  const w = new Worker(WORKER, { eval: true, workerData: { file: path.join(ROOT, lib.source), mupdf: import.meta.resolve('mupdf') } });
  w.on('message', (m: { id: number; data?: Uint8Array; error?: string }) => {
    const job = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.error || !m.data) job?.reject(new Error(m.error ?? 'Rendering failed.'));
    else job?.resolve(m.data);
  });
  const fail = (error: Error) => {
    if (worker === w) worker = null;
    for (const job of waiting.values()) job.reject(error);
    waiting.clear();
  };
  w.on('error', fail);
  w.on('exit', () => fail(new Error('The library renderer stopped.')));
  worker = w;
  return w;
}

/** Close the renderer (idle, or before Chromium prints). */
export async function closeLibrary() {
  clearTimeout(idleTimer);
  const w = worker;
  worker = null;
  if (w && !waiting.size) await w.terminate();
  else if (w) worker = w;
}

/** Stop the renderer at once, mid-render too (a job that overran its time). */
export async function abortLibrary() {
  clearTimeout(idleTimer);
  const w = worker;
  worker = null;
  await w?.terminate();
}

async function render(request: RenderRequest) {
  clearTimeout(idleTimer);
  const id = nextJob++;
  const data = await new Promise<Uint8Array>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ id, request });
  });
  idleTimer = setTimeout(() => void closeLibrary(), 45_000);
  idleTimer.unref();
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width: request.width, height: request.height, channels: 3 } });
}

const blockOfId = (id: string) => {
  const lib = load();
  if (!lib) throw new Error('The kalam library is not available on this server.');
  return { lib, ...blockOf(lib, id) };
};

/** Whether a library image's first verse runs on from the image before it. */
export const libraryContinues = (id: string) => {
  try { return blockOfId(id).block.continues; } catch { return false; }
};

/** The image a library media id stands for, ready for the screenshot cleaner. */
export async function libraryImage(id: string, options: { keepOpen?: boolean } = {}): Promise<Buffer> {
  const { lib, k, block } = blockOfId(id);
  const png = await (await render(blockRequest(lib, k, block))).png({ compressionLevel: 6 }).toBuffer();
  // The cleaner comes next and needs the memory more than MuPDF does.
  if (!options.keepOpen) await closeLibrary();
  return png;
}

/** Small previews for the search list (the original title) and the verse
 * picker: one verse, or a couplet's verses [first, last] together. */
export async function libraryPreview(n: number, what: 'title' | [number, number]): Promise<Buffer> {
  const lib = load();
  if (!lib) throw new Error('No such kalam in the library.');
  const image = await render(previewRequest(lib, n, what));
  return what === 'title'
    ? image.trim({ background: '#ffffff', threshold: 40 }).png().toBuffer()
    : image.trim({ background: '#ffffff', threshold: 30 }).png({ palette: true, quality: 90 }).toBuffer();
}
