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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY_FILE = path.join(ROOT, 'server/library/library.json');

/** [page, y0, y1, centre of first row, centre of last row] in PDF points. */
type Part = [number, number, number, number, number];
/** `st`: each verse's parts. `g`: each verse's stanza, when verses are rows or
 * pieces of stanzas (a ghazal, an oversized stanza; tools/build_library.py
 * verse_plan); without it every verse is a stanza of its own. */
interface LibraryKalam { st: Part[][]; g?: number[]; lh: number; pitch: number; tr: [number, number, number, number, number] }
interface Marks { w?: number[][]; z?: number[][]; t?: [number, number, number, number, number[]][] }
interface Library { v: number; source: string; sha: string; kalams: LibraryKalam[]; marks: Record<string, Marks> }

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

/** Library media ids: lib<version>-<kalam>-<verses>-<block>, e.g. lib1-0-0t9_12-0.
 * Everything about the image follows from the id, so a server that lost the
 * files makes the same ones again. */
const ID = /^lib(\d+)-(\d+)-(all|[\dt_]+)-(\d+)$/;
export const isLibraryMedia = (id: string) => ID.test(id);

const encode = (verses: number[] | null, count: number) => {
  if (!verses || (verses.length === count && verses.every((v, i) => v === i))) return 'all';
  const out: string[] = [];
  for (let i = 0; i < verses.length; i++) {
    let j = i;
    while (j + 1 < verses.length && verses[j + 1] === verses[j] + 1) j++;
    out.push(j > i ? `${verses[i]}t${verses[j]}` : `${verses[i]}`);
    i = j;
  }
  return out.join('_');
};
const decode = (sel: string, count: number): number[] => {
  if (sel === 'all') return Array.from({ length: count }, (_, i) => i);
  return sel.split('_').flatMap((r) => {
    const [a, b = a] = r.split('t').map(Number);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
};

/** Render scale: the kalam's verse rows come out about 128 px tall, around
 * 270 DPI at the booklet's 34 pt line, sharper than any screenshot. */
const zoomOf = (k: LibraryKalam) => Math.min(5, Math.max(2.5, 128 / Math.max(10, k.lh)));
const X0 = 18, X1 = 594;
/** Pixels per rendered block; the screenshot cleaner's margin-mark pass runs up to 12M. */
const MAX_PIXELS = 10_000_000;

interface Placed { part: Part; dy: number }
interface Block { placed: Placed[]; height: number; continues: boolean }

/** Chosen verses as stanzas to print, each a list of parts. Chosen verses of
 * the same stanza print together as one, at line pitch; neighbouring ones on
 * a page join into one crop, so a whole stanza prints exactly as it stands. */
function stanzasOf(k: LibraryKalam, verses: number[]): Part[][] {
  const out: Part[][] = [];
  let group: number | null = null, last = -2;
  for (const v of verses) {
    const parts = k.st[v];
    if (!parts) continue;
    const g = k.g?.[v] ?? null;
    const run = out[out.length - 1];
    if (g === null || g !== group || !run) out.push(parts.map((p) => [...p] as Part));
    else {
      const prev = run[run.length - 1];
      const [first, ...rest] = parts;
      if (v === last + 1 && prev[0] === first[0]) run[run.length - 1] = [prev[0], prev[1], first[2], prev[3], first[4]];
      else run.push([...first] as Part);
      run.push(...rest.map((p) => [...p] as Part));
    }
    group = g;
    last = v;
  }
  return out;
}

/** Chosen verses laid out into blocks of whole stanzas (a stanza taller than a
 * block continues in the next, marked `continues`). Inside a block a stanza's
 * pieces from consecutive pages join at its own line pitch; stanzas are kept a
 * clear stanza gap apart, which the cleaner reads as the stanza break. */
function layout(k: LibraryKalam, verses: number[]): Block[] {
  const z = zoomOf(k);
  const maxH = MAX_PIXELS / ((X1 - X0) * z * z); // in points
  const blocks: Block[] = [];
  let cur: Block | null = null;
  const start = (continues: boolean) => { cur = { placed: [], height: 0, continues }; blocks.push(cur); };
  for (const parts of stanzasOf(k, verses)) {
    const total = parts.reduce((h, p) => h + p[2] - p[1], 0) + (parts.length - 1) * k.pitch;
    if (!cur || (cur as Block).height + k.pitch * 1.2 + total > maxH) start(false);
    parts.forEach((part, i) => {
      const b = cur as Block;
      const h = part[2] - part[1];
      if (b.placed.length && b.height + h > maxH) start(true);
      const c = cur as Block;
      let dy = c.height;
      if (c.placed.length) {
        const prev = c.placed[c.placed.length - 1];
        // The same stanza going on (on the next page, or at a chosen verse
        // further down): its first row one line pitch below the last row
        // before it. A new stanza: a stanza gap below.
        const prevLast = prev.dy + prev.part[4] - prev.part[1];
        dy = i > 0 ? prevLast + k.pitch - (part[3] - part[1]) : Math.max(c.height + k.pitch * 0.9, prevLast + k.pitch * 2 - (part[3] - part[1]));
      }
      c.placed.push({ part, dy });
      c.height = dy + h;
    });
  }
  return blocks;
}

export function libraryPlan(n: number, verses: number[] | null) {
  const lib = load();
  const k = lib?.kalams[n];
  if (!lib || !k) throw new Error('No such kalam in the library.');
  const chosen = verses ? [...new Set(verses)].filter((v) => v >= 0 && v < k.st.length).sort((a, b) => a - b) : null;
  if (chosen && !chosen.length) throw new Error('Choose at least one verse.');
  const sel = encode(chosen, k.st.length);
  const blocks = layout(k, decode(sel, k.st.length));
  return { ids: blocks.map((_, i) => `lib${lib.v}-${n}-${sel}-${i}`) };
}

// ---- rendering worker -----------------------------------------------------

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
let doc;
const ready = import(workerData.mupdf).then((mupdf) => {
  doc = mupdf.Document.openDocument(require('node:fs').readFileSync(workerData.file), 'application/pdf');
  return mupdf;
});
parentPort.on('message', async ({ id, jobs, width, height, zoom, white }) => {
  try {
    const mupdf = await ready;
    const out = new Uint8Array(width * height * 3).fill(255);
    for (const { page, x0, y0, x1, y1, dy, marks } of jobs) {
      const p = doc.loadPage(page);
      const bx = Math.floor(x0 * zoom), by = Math.floor(y0 * zoom);
      const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [bx, by, Math.ceil(x1 * zoom), Math.ceil(y1 * zoom)], false);
      pix.clear(255);
      const dev = new mupdf.DrawDevice(mupdf.Matrix.scale(zoom, zoom), pix);
      p.run(dev, mupdf.Matrix.identity);
      dev.close(); dev.destroy();
      const w = pix.getWidth(), h = pix.getHeight(), stride = pix.getStride();
      const px = pix.getPixels();
      const fill = (rx0, ry0, rx1, ry1, fn) => {
        const a = Math.max(0, Math.floor(rx0 * zoom) - bx), b = Math.min(w, Math.ceil(rx1 * zoom) - bx);
        const c = Math.max(0, Math.floor(ry0 * zoom) - by), d = Math.min(h, Math.ceil(ry1 * zoom) - by);
        for (let y = c; y < d; y++) for (let x = a; x < b; x++) fn(y * stride + x * 3);
      };
      // A highlight behind text is un-blended back to paper; marks go white.
      for (const [tx0, ty0, tx1, ty1, t] of marks.t || []) fill(tx0, ty0, tx1, ty1, (o) => {
        let a = 0;
        for (let c = 0; c < 3; c++) a = Math.max(a, (t[c] - px[o + c]) / Math.max(1, t[c]));
        a = Math.min(1, Math.max(0, a));
        for (let c = 0; c < 3; c++) px[o + c] = Math.min(255, px[o + c] + (1 - a) * (255 - t[c]));
      });
      for (const [rx0, ry0, rx1, ry1] of marks.w || []) fill(rx0, ry0, rx1, ry1, (o) => { px[o] = px[o + 1] = px[o + 2] = 255; });
      for (const [ry0, ry1] of marks.z || []) fill(0, ry0, 1e4, ry1, (o) => { px[o] = px[o + 1] = px[o + 2] = 255; });
      const oy = Math.round(dy * zoom);
      for (let y = 0; y < h; y++) {
        const ty = oy + y;
        if (ty < 0 || ty >= height) continue;
        // Overlapping crops (a verse joined across pages) keep the darker ink.
        const row = ty * width * 3;
        for (let x = 0; x < Math.min(w, width) * 3; x++) {
          const v = px[y * stride + x];
          if (v < out[row + x]) out[row + x] = v;
        }
      }
      pix.destroy(); p.destroy();
    }
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

async function render(jobs: { page: number; x0: number; y0: number; x1: number; y1: number; dy: number }[], width: number, height: number, zoom: number) {
  const lib = load()!;
  clearTimeout(idleTimer);
  const id = nextJob++;
  const data = await new Promise<Uint8Array>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ id, width, height, zoom, jobs: jobs.map((j) => ({ ...j, marks: lib.marks[j.page] ?? {} })) });
  });
  idleTimer = setTimeout(() => void closeLibrary(), 45_000);
  idleTimer.unref();
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 3 } });
}

function blockOf(id: string) {
  const m = ID.exec(id);
  const lib = load();
  if (!m || !lib || Number(m[1]) !== lib.v) throw new Error('This library verse is from an older library version. Add it again.');
  const k = lib.kalams[Number(m[2])];
  if (!k) throw new Error('No such kalam in the library.');
  const block = layout(k, decode(m[3], k.st.length))[Number(m[4])];
  if (!block) throw new Error('No such part of the kalam.');
  return { k, block };
}

/** Whether a library image's first verse runs on from the image before it. */
export const libraryContinues = (id: string) => {
  try { return blockOf(id).block.continues; } catch { return false; }
};

/** The image a library media id stands for, ready for the screenshot cleaner. */
export async function libraryImage(id: string): Promise<Buffer> {
  const { k, block } = blockOf(id);
  const zoom = zoomOf(k);
  const width = Math.ceil((X1 - X0) * zoom), height = Math.ceil(block.height * zoom) + 2;
  const jobs = block.placed.map(({ part, dy }) => ({ page: part[0], x0: X0, y0: part[1], x1: X1, y1: part[2], dy }));
  const png = await (await render(jobs, width, height, zoom)).png({ compressionLevel: 6 }).toBuffer();
  // The cleaner comes next and needs the memory more than MuPDF does.
  await closeLibrary();
  return png;
}

/** Small previews for the search list (the original title) and the verse picker. */
export async function libraryPreview(n: number, what: 'title' | number): Promise<Buffer> {
  const lib = load();
  const k = lib?.kalams[n];
  if (!k) throw new Error('No such kalam in the library.');
  if (what === 'title') {
    const [page, x0, y0, x1, y1] = k.tr;
    const zoom = 2.2;
    const width = Math.ceil((x1 - x0) * zoom), height = Math.ceil((y1 - y0) * zoom);
    const image = await render([{ page, x0, y0, x1, y1, dy: 0 }], width, height, zoom);
    return image.trim({ background: '#ffffff', threshold: 40 }).png().toBuffer();
  }
  const parts = k.st[what];
  if (!parts) throw new Error('No such verse.');
  const zoom = Math.min(2, Math.max(1.2, 40 / Math.max(10, k.lh)));
  const block = layout(k, [what])[0];
  const width = Math.ceil((X1 - X0) * zoom), height = Math.ceil(block.height * zoom) + 2;
  const image = await render(block.placed.map(({ part, dy }) => ({ page: part[0], x0: X0, y0: part[1], x1: X1, y1: part[2], dy })), width, height, zoom);
  return image.trim({ background: '#ffffff', threshold: 30 }).png({ palette: true, quality: 90 }).toBuffer();
}
