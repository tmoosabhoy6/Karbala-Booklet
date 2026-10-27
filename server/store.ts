// On-disk storage under data/ (git-ignored): processed screenshots, the
// working booklet, and pinned defaults.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanScreenshot, Edits, PROCESSOR_VERSION, Region } from './ink';
import { vectorInk } from './vector';

export const DATA = path.resolve(process.env.DATA_DIR ?? 'data');
export const MEDIA = path.join(DATA, 'media');
mkdirSync(MEDIA, { recursive: true });

export interface MediaMeta {
  id: string;
  rev: number;
  width: number;
  height: number;
  bands: [number, number][];
  lineHeight: number;
  edits: Edits;
  processorVersion?: number;
  format?: 'png' | 'svg';
  regions?: Region[];
  suggestedName?: string;
  recognitionConfidence?: number;
  warnings?: string[];
  opening?: { x: number; y: number; w: number; h: number };
}

const metaPath = (id: string) => path.join(MEDIA, `${id}.json`);
const safeId = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error('bad id');
  return id;
};

let processQueue = Promise.resolve();
function writeProcessed(id: string, original: Buffer, edits: Edits, rev: number): Promise<MediaMeta> {
  const job = processQueue.then(() => processImage(id, original, edits, rev));
  processQueue = job.then(() => undefined, () => undefined);
  return job;
}
async function processImage(id: string, original: Buffer, edits: Edits, rev: number): Promise<MediaMeta> {
  const r = await cleanScreenshot(original, edits, { ocr: id !== 'fixed-matam' });
  const { png, svg: rasterSvg, ...geometry } = r;
  const svg = id === 'fixed-matam' ? rasterSvg : await vectorInk(png);
  const meta: MediaMeta = { id, rev, ...geometry, edits, processorVersion: PROCESSOR_VERSION, format: id === 'fixed-matam' ? 'png' : 'svg' };
  await Promise.all([
    writeFile(path.join(MEDIA, `${id}.png`), png),
    writeFile(path.join(MEDIA, `${id}.svg`), svg),
    writeFile(path.join(MEDIA, `${id}.${rev}.png`), png),
    writeFile(path.join(MEDIA, `${id}.${rev}.svg`), svg),
  ]);
  await writeFile(`${metaPath(id)}.tmp`, JSON.stringify(meta));
  await (await import('node:fs/promises')).rename(`${metaPath(id)}.tmp`, metaPath(id));
  return meta;
}

export async function addMedia(original: Buffer, id: string = randomUUID()): Promise<MediaMeta> {
  safeId(id);
  await writeFile(path.join(MEDIA, `${id}.orig`), original);
  return writeProcessed(id, original, {}, Date.now());
}

export async function editMedia(id: string, edits: Edits): Promise<MediaMeta> {
  safeId(id);
  const prev: MediaMeta = JSON.parse(await readFile(metaPath(id), 'utf8'));
  const original = await readFile(path.join(MEDIA, `${id}.orig`));
  // Timestamp revisions keep cached files (served immutable) from going stale.
  return writeProcessed(id, original, edits, Math.max(Date.now(), prev.rev + 1));
}

const processing = new Map<string, Promise<MediaMeta>>();
export async function getMedia(id: string): Promise<MediaMeta | null> {
  safeId(id);
  if (!existsSync(metaPath(id))) return null;
  const meta: MediaMeta = JSON.parse(await readFile(metaPath(id), 'utf8'));
  if (meta.processorVersion === PROCESSOR_VERSION) return meta;
  if (!processing.has(id)) processing.set(id, readFile(path.join(MEDIA, `${id}.orig`))
    .then((original) => writeProcessed(id, original, meta.edits ?? {}, Math.max(Date.now(), meta.rev + 1)))
    .finally(() => processing.delete(id)));
  return processing.get(id)!;
}

/** The fixed Matam page (حسين حسين، پنجتن ماتم) is cleaned once on first start. */
export async function ensureFixedMedia(): Promise<void> {
  const fixed: [string, string][] = [['fixed-matam', 'public/fixed/matam-husain-panjatan.png']];
  for (const [id, file] of fixed) {
    if (!(await getMedia(id))) await addMedia(await readFile(file), id);
  }
}

export async function readJson<T>(name: string): Promise<T | null> {
  const p = path.join(DATA, name);
  return existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : null;
}

export async function writeJson(name: string, value: unknown): Promise<void> {
  const p = path.join(DATA, name);
  // Write-then-rename keeps the file whole if the app is closed mid-save.
  await writeFile(`${p}.tmp`, JSON.stringify(value));
  await (await import('node:fs/promises')).rename(`${p}.tmp`, p);
}
