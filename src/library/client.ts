// The page's side of the browser renderer (src/library/worker.ts): keeps this
// device's copy of the Zikre Husain PDF (downloaded once, then read from
// storage), asks the worker for previews and verse images, and falls back to
// the server whenever the local renderer is not ready or not supported.
import { useEffect, useState } from 'react';
import type { MadeVerse, WorkerRequest } from './worker';
import type { Analysis } from './analyze';
import { readFile, writeFile, zhKey } from './store';

export type { MadeVerse } from './worker';

let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; progress?: (done: number, total: number) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<{ id: number; ok?: boolean; result?: unknown; error?: string; progress?: { done: number; total: number } }>) => {
    const job = waiting.get(e.data.id);
    if (!job) return;
    if (e.data.progress) { job.progress?.(e.data.progress.done, e.data.progress.total); return; }
    waiting.delete(e.data.id);
    if (e.data.ok) job.resolve(e.data.result);
    else job.reject(new Error(e.data.error ?? 'The kalam renderer failed.'));
  };
  w.onerror = (e) => {
    e.preventDefault();
    for (const job of waiting.values()) job.reject(new Error(e.message || 'The kalam renderer could not start.'));
    waiting.clear();
    worker = null;
    zhReady = null;
    setStatus({ state: 'failed', error: e.message || 'The kalam renderer could not start on this browser.' });
  };
  worker = w;
  return w;
}

function call<T>(msg: WorkerRequest, progress?: (done: number, total: number) => void): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, progress });
    getWorker().postMessage({ id, msg });
  });
}

/** Whether this browser can run the local renderer at all. */
export const supported = typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && typeof indexedDB !== 'undefined' && typeof CompressionStream !== 'undefined';

// ---- status of this device's Zikre Husain copy ----

export interface LocalStatus { state: 'idle' | 'downloading' | 'opening' | 'ready' | 'failed'; loaded?: number; total?: number; error?: string }
let status: LocalStatus = { state: 'idle' };
const listeners = new Set<(s: LocalStatus) => void>();
function setStatus(s: LocalStatus) { status = s; for (const l of listeners) l(s); }
export const localStatus = () => status;
export function useLocalStatus() {
  const [s, set] = useState(status);
  useEffect(() => { listeners.add(set); set(status); return () => { listeners.delete(set); }; }, []);
  return s;
}

/** The library's own version (public/library/index.json). */
let info: Promise<{ sha: string; build: string }> | null = null;
const libraryInfo = () => (info ??= fetch('/library/index.json').then((r) => r.json()).then((j: { sha: string; build?: string }) => ({ sha: j.sha, build: j.build ?? j.sha })).catch((e) => { info = null; throw e; }));

/** Download the PDF once into this device's storage, with progress. */
async function downloadZh(sha: string): Promise<void> {
  if (await readFile(zhKey(sha)).catch(() => undefined)) return;
  setStatus({ state: 'downloading', loaded: 0 });
  const res = await fetch(`/api/library/source.pdf?v=${sha}`);
  if (!res.ok || !res.body) throw new Error('The Zikre Husain PDF could not be downloaded.');
  const total = Number(res.headers.get('Content-Length')) || undefined;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0, shown = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    if (loaded - shown > 256 * 1024) { shown = loaded; setStatus({ state: 'downloading', loaded, total }); }
  }
  await writeFile(zhKey(sha), new Blob(parts as BlobPart[], { type: 'application/pdf' }));
  // Ask the browser not to clear it when space runs low.
  void navigator.storage?.persist?.().catch(() => undefined);
}

let zhReady: Promise<void> | null = null;
/** Make the local Zikre Husain renderer ready (downloading the PDF the first time). */
export function openZh(): Promise<void> {
  if (!supported) return Promise.reject(new Error('This browser cannot render the library itself.'));
  return zhReady ??= (async () => {
    try {
      const { sha, build } = await libraryInfo();
      await downloadZh(sha);
      setStatus({ state: 'opening' });
      await call({ type: 'open', source: 'zh', file: zhKey(sha), geometry: `/api/library/geometry?v=${build}` });
      setStatus({ state: 'ready' });
    } catch (error) {
      zhReady = null;
      setStatus({ state: 'failed', error: (error as Error).message });
      throw error;
    }
  })();
}
const zhLocal = () => status.state === 'ready';

/** On a quiet moment after the editor opens: fetch the PDF in the background
 * if this device does not have it yet (not on a data-saving connection). */
export function prefetchZh() {
  if (!supported) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((navigator as any).connection?.saveData) return;
  const start = () => void libraryInfo().then(({ sha }) => readFile(zhKey(sha))).then((have) => (have ? undefined : openZh())).catch(() => undefined);
  if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 8000 }); else setTimeout(start, 3000);
}

// ---- previews ----

const previews = new Map<string, Promise<string>>();
const previewKey = (source: string, n: number, what: 'title' | [number, number]) => `${source}:${n}:${what === 'title' ? 't' : what.join('-')}`;
const serverPreview = async (n: number, what: 'title' | [number, number]) => {
  const { build } = await libraryInfo();
  return what === 'title' ? `/api/library/${n}/title.png?v=${build}` : `/api/library/${n}/verse-${what[0]}${what[1] > what[0] ? `-${what[1]}` : ''}.png?v=${build}`;
};

/** An image URL for a preview: made on this device when its copy is ready,
 * from the server until then (Zikre Husain only; added PDFs are always local). */
export function previewUrl(source: string, n: number, what: 'title' | [number, number]): Promise<string> {
  const key = previewKey(source, n, what);
  const kept = previews.get(key);
  if (kept) return kept;
  if (source === 'zh' && !zhLocal()) return serverPreview(n, what);
  const made = (source === 'zh' ? openZh() : openUser(source))
    .then(() => call<Blob>({ type: 'preview', source, n, what }))
    .then((blob) => URL.createObjectURL(blob));
  made.catch((error) => { previews.delete(key); console.warn('Preview made on this device failed:', error); });
  previews.set(key, made);
  // Zikre Husain falls back to the server's preview if the local one fails.
  return source === 'zh' ? made.catch(() => serverPreview(n, what)) : made;
}

// ---- verse images ----

/** Whether verses can be made on this device now: its copy is open, or
 * stored and quick to open (a download still going on does not count). */
async function zhUsable(): Promise<boolean> {
  if (zhLocal()) return true;
  if (!supported || status.state === 'downloading' || status.state === 'failed') return false;
  const { sha } = await libraryInfo();
  if (!(await readFile(zhKey(sha)).catch(() => undefined))) return false;
  return openZh().then(() => true, () => false);
}
/** The library build the local geometry belongs to. */
export const zhBuild = async () => (await libraryInfo()).build;
/** Zikre Husain: the media ids of a kalam or chosen verses (same as the server's plan). */
export async function zhPlan(n: number, verses: number[] | null): Promise<string[] | null> {
  if (!(await zhUsable())) return null;
  return call<string[]>({ type: 'plan', source: 'zh', n, verses }).catch(() => null);
}
/** Zikre Husain: one verse image made on this device, or null (not ready). */
export async function zhVerse(id: string): Promise<MadeVerse | null> {
  if (!(await zhUsable())) return null;
  return call<MadeVerse>({ type: 'block', source: 'zh', id });
}

// ---- PDFs added on this device ----

const userOpen = new Map<string, Promise<void>>();
export function openUser(source: string): Promise<void> {
  let p = userOpen.get(source);
  if (!p) {
    p = call<unknown>({ type: 'open', source, file: source }).then(() => undefined);
    p.catch(() => userOpen.delete(source));
    userOpen.set(source, p);
  }
  return p;
}
export function closeUser(source: string) {
  userOpen.delete(source);
  for (const key of [...previews.keys()]) if (key.startsWith(`${source}:`)) previews.delete(key);
  if (worker) void call({ type: 'close', source });
}
export const analyzeUserPdf = (file: string, name: string, sha: string, progress: (done: number, total: number) => void) =>
  call<Analysis>({ type: 'analyze', file, name, sha }, progress);
export async function userVerses(source: string, n: number, verses: number[] | null): Promise<MadeVerse[]> {
  await openUser(source);
  return call<MadeVerse[]>({ type: 'blocks', source, n, verses });
}
