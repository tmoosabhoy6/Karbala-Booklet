/// <reference lib="webworker" />
// The browser's own kalam renderer: MuPDF (WebAssembly) on this device's copy
// of each PDF. Previews and verse images are made here, without waiting for
// the server, and verse images are cleaned here with the same code the server
// uses (src/library/ink.ts), so the server only stores the finished files.
import { analyzePdf } from './analyze';
import { blockOf, blockRequest, inkBounds, layout, planIds, previewRequest, spanOf, type Library, type RenderRequest } from './geometry';
import { cleanPixels, type InkGeometry } from './ink';
import { encodePng } from './png';
import { renderPixels } from './render';
import { readFile, readMeta } from './store';

declare const self: DedicatedWorkerGlobalScope;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mupdf = any;
let mupdfModule: Promise<Mupdf> | null = null;
const mupdf = () => (mupdfModule ??= import('mupdf'));

interface Source { lib: Library; doc: unknown }
const sources = new Map<string, Promise<Source>>();

export type WorkerRequest =
  | { type: 'open'; source: string; geometry?: string; file: string }
  | { type: 'plan'; source: string; n: number; verses: number[] | null }
  | { type: 'preview'; source: string; n: number; what: 'title' | [number, number] }
  | { type: 'block'; source: string; id: string }
  | { type: 'blocks'; source: string; n: number; verses: number[] | null }
  | { type: 'analyze'; file: string; name: string; sha: string }
  | { type: 'close'; source: string };

export interface MadeVerse { png: Blob; opening: Blob; original?: Blob; geometry: InkGeometry; continues: boolean }

/** A source: Zikre Husain (`zh`, its geometry from the server) or a PDF added
 * on this device (its geometry kept with it). The PDF itself is already in
 * this device's storage under `file`. */
function open(source: string, file: string, geometry?: string): Promise<Source> {
  let s = sources.get(source);
  if (!s) {
    s = (async () => {
      const [m, blob, lib] = await Promise.all([
        mupdf(),
        readFile(file),
        geometry ? fetch(geometry).then((r) => { if (!r.ok) throw new Error('The library geometry could not be loaded.'); return r.json() as Promise<Library>; }) : readMeta<Library>(`lib:${file}`),
      ]);
      if (!blob) throw new Error('This PDF is not on this device yet.');
      if (!lib) throw new Error('This PDF has not been read yet.');
      const doc = m.Document.openDocument(new Uint8Array(await blob.arrayBuffer()), 'application/pdf');
      return { lib, doc };
    })();
    s.catch(() => sources.delete(source));
    sources.set(source, s);
  }
  return s;
}
const opened = async (source: string) => {
  const s = sources.get(source);
  if (!s) throw new Error('This source is not open.');
  return s;
};

async function draw(s: Source, request: RenderRequest) {
  return renderPixels(await mupdf(), s.doc, request);
}

/** A trimmed, opaque preview PNG. */
async function preview(s: Source, n: number, what: 'title' | [number, number]) {
  const request = previewRequest(s.lib, n, what);
  const rgb = await draw(s, request);
  const box = inkBounds(rgb, request.width, request.height, what === 'title' ? 40 : 30);
  const out = new Uint8Array(box.w * box.h * 3);
  for (let y = 0; y < box.h; y++) out.set(rgb.subarray(((y + box.y) * request.width + box.x) * 3, ((y + box.y) * request.width + box.x + box.w) * 3), y * box.w * 3);
  return encodePng(out, box.w, box.h, 3);
}

/** One verse image, rendered and cleaned. Zikre Husain verses come from the
 * PDF with numbers and marks already removed exactly (no margin guesswork);
 * a PDF added here gets the screenshot cleaner's margin pass, and keeps its
 * untouched render as the original. */
async function make(s: Source, request: RenderRequest, continues: boolean, own: boolean): Promise<MadeVerse> {
  const rgb = await draw(s, request);
  const { image, openingImage, ...geometry } = await cleanPixels({ data: rgb, width: request.width, height: request.height, channels: 3 }, {}, { marks: own });
  const [png, opening, original] = await Promise.all([
    encodePng(image.data, image.width, image.height, 4),
    encodePng(openingImage.data, openingImage.width, openingImage.height, 4),
    own ? encodePng(rgb, request.width, request.height, 3) : undefined,
  ]);
  return { png, opening, original, geometry, continues };
}

async function handle(msg: WorkerRequest, progress: (done: number, total: number) => void): Promise<unknown> {
  switch (msg.type) {
    case 'open': {
      const s = await open(msg.source, msg.file, msg.geometry);
      return { kalams: s.lib.kalams.length, build: s.lib.build };
    }
    case 'plan': return planIds((await opened(msg.source)).lib, msg.n, msg.verses);
    case 'preview': return preview(await opened(msg.source), msg.n, msg.what);
    case 'block': {
      const s = await opened(msg.source);
      const { k, block } = blockOf(s.lib, msg.id);
      return make(s, blockRequest(s.lib, k, block), block.continues, false);
    }
    case 'blocks': {
      const s = await opened(msg.source);
      const k = s.lib.kalams[msg.n];
      if (!k) throw new Error('No such kalam.');
      const verses = msg.verses ?? k.st.map((_, i) => i);
      const out: MadeVerse[] = [];
      for (const block of layout(k, verses, spanOf(s.lib))) out.push(await make(s, blockRequest(s.lib, k, block), block.continues, true));
      return out;
    }
    case 'analyze': {
      const [m, blob] = await Promise.all([mupdf(), readFile(msg.file)]);
      if (!blob) throw new Error('The PDF could not be read from this device.');
      const doc = m.Document.openDocument(new Uint8Array(await blob.arrayBuffer()), 'application/pdf');
      try {
        if (doc.needsPassword?.()) throw new Error('This PDF is password-protected.');
        return analyzePdf(m, doc, msg.name, msg.sha, progress);
      } finally {
        doc.destroy?.();
      }
    }
    case 'close': {
      const s = sources.get(msg.source);
      sources.delete(msg.source);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (s) void s.then((x) => (x.doc as any).destroy?.()).catch(() => undefined);
      return null;
    }
  }
}

// One job at a time, in order: renders are synchronous anyway, and this keeps
// a verse picker's previews in the order they were asked for.
let queue = Promise.resolve();
self.onmessage = (e: MessageEvent<{ id: number; msg: WorkerRequest }>) => {
  const { id, msg } = e.data;
  queue = queue.then(async () => {
    try {
      const result = await handle(msg, (done, total) => self.postMessage({ id, progress: { done, total } }));
      self.postMessage({ id, ok: true, result });
    } catch (error) {
      self.postMessage({ id, ok: false, error: (error as Error)?.message ?? String(error) });
    }
  });
};
