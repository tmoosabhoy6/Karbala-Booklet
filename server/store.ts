// On-disk storage under data/ (git-ignored): processed screenshots, the
// working booklet, and pinned defaults.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanScreenshot, Edits, PROCESSOR_VERSION, Region } from './ink';
import { heavyWork } from './resources';

export const DATA = path.resolve(process.env.DATA_DIR ?? 'data');
export const MEDIA = path.join(DATA, 'media');
mkdirSync(MEDIA, { recursive: true });
/** The fixed Matam page, already cleaned by `npm run build`. */
export const FIXED_BUILD = path.resolve('build/fixed');
const FIXED: [string, string][] = [['fixed-matam', 'public/fixed/matam-husain-panjatan.png']];

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
  /** `<id>.<rev>.opening.png` holds the opening words, already navy. */
  openingImage?: boolean;
  restoration?: { sourceId: string; sourceRev: number; model: string; referenceVersion: number };
}

const metaPath = (id: string) => path.join(MEDIA, `${id}.json`);
const safeId = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error('bad id');
  return id;
};
/** The finished files of one revision: the print lettering and the fihrist's opening words. */
export const pngName = (id: string, rev: number) => `${id}.${rev}.png`;
export const openingName = (id: string, rev: number) => `${id}.${rev}.opening.png`;

/** Width and height from a PNG's header, without decoding it. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  const signature = '89504e470d0a1a0a';
  if (png.length < 24 || png.subarray(0, 8).toString('hex') !== signature || png.subarray(12, 16).toString() !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// Write-then-rename keeps a file whole if the app is closed mid-save.
async function writeWhole(file: string, data: string | Buffer) {
  await writeFile(`${file}.tmp`, data);
  await rename(`${file}.tmp`, file);
}

function writeProcessed(id: string, original: Buffer, edits: Edits, rev: number, restoration?: MediaMeta['restoration']): Promise<MediaMeta> {
  return heavyWork(() => processImage(id, original, edits, rev, restoration));
}
/** Clean a screenshot into its finished files and metadata (no disk writes). */
export async function cleanMedia(id: string, original: Buffer, edits: Edits, rev: number, restoration?: MediaMeta['restoration']) {
  const { png, openingPng, ...geometry } = await cleanScreenshot(original, edits, { ocr: !id.startsWith('fixed-') && !restoration });
  // A 50% tracing threshold erased faint hairlines and small dots. Export the
  // antialiased ink itself, including high-resolution generated drafts.
  const meta: MediaMeta = { id, rev, ...geometry, edits, restoration, processorVersion: PROCESSOR_VERSION, format: 'png', openingImage: !!openingPng };
  return { meta, png, openingPng };
}
async function processImage(id: string, original: Buffer, edits: Edits, rev: number, restoration?: MediaMeta['restoration']): Promise<MediaMeta> {
  const { meta, png, openingPng } = await cleanMedia(id, original, edits, rev, restoration);
  // Only the versioned PNG and the opening words are ever read; old SVG
  // entries are rebuilt on request (see svgWrapper).
  await Promise.all([
    writeFile(path.join(MEDIA, pngName(id, rev)), png),
    ...(openingPng ? [writeFile(path.join(MEDIA, openingName(id, rev)), openingPng)] : []),
  ]);
  await writeWhole(metaPath(id), JSON.stringify(meta));
  return meta;
}

export async function addMedia(original: Buffer, id: string = randomUUID(), options: { edits?: Edits; restoration?: MediaMeta['restoration'] } = {}): Promise<MediaMeta> {
  safeId(id);
  await writeFile(path.join(MEDIA, `${id}.orig`), original);
  return writeProcessed(id, original, options.edits ?? {}, Date.now(), options.restoration);
}

export async function editMedia(id: string, edits: Edits): Promise<MediaMeta> {
  safeId(id);
  const prev: MediaMeta = JSON.parse(await readFile(metaPath(id), 'utf8'));
  const original = await readFile(path.join(MEDIA, `${id}.orig`));
  // Timestamp revisions keep cached files (served immutable) from going stale.
  return writeProcessed(id, original, edits, Math.max(Date.now(), prev.rev + 1), prev.restoration);
}

const processing = new Map<string, Promise<MediaMeta>>();
export async function getMedia(id: string): Promise<MediaMeta | null> {
  safeId(id);
  if (!existsSync(metaPath(id))) return null;
  const meta: MediaMeta = JSON.parse(await readFile(metaPath(id), 'utf8'));
  if (meta.processorVersion === PROCESSOR_VERSION) return meta;
  if (!processing.has(id)) processing.set(id, readFile(path.join(MEDIA, `${id}.orig`))
    .then((original) => writeProcessed(id, original, meta.edits ?? {}, Math.max(Date.now(), meta.rev + 1), meta.restoration))
    .finally(() => processing.delete(id)));
  return processing.get(id)!;
}

/** Only fields the server itself writes are taken from a browser's copy. */
const META_KEYS = ['rev', 'width', 'height', 'bands', 'lineHeight', 'edits', 'processorVersion', 'format', 'regions', 'suggestedName', 'recognitionConfidence', 'warnings', 'opening', 'openingImage', 'restoration'] as const;
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

/**
 * After a restart has wiped the server's files, the browser hands back a
 * screenshot under its original name: the untouched upload and, when it kept
 * them, the finished files of that revision. Finished files are saved exactly
 * as given, so nothing is re-read, re-cleaned or downloaded again.
 */
export async function reinstateMedia(id: string, given: Partial<MediaMeta>, files: { original: Buffer; png?: Buffer; opening?: Buffer }): Promise<MediaMeta> {
  safeId(id);
  if (id.startsWith('fixed-')) throw new Error('Fixed pages are built into the app.');
  const existing = await getMedia(id);
  if (existing) return existing;
  if (!files.original.length) throw new Error('No image received.');
  const meta = { id, ...Object.fromEntries(META_KEYS.filter((k) => given[k] !== undefined).map((k) => [k, given[k]])) } as MediaMeta;
  if (!positive(meta.rev)) throw new Error('Invalid screenshot revision.');
  await writeFile(path.join(MEDIA, `${id}.orig`), files.original);
  const size = files.png && pngSize(files.png);
  const opening = files.opening && pngSize(files.opening);
  const finished = meta.format === 'png' && size && positive(meta.width) && positive(meta.height) && size.width === meta.width && size.height === meta.height
    && (!meta.openingImage || (opening && opening.width === meta.opening?.w && opening.height === meta.opening?.h));
  if (!finished) {
    // No usable finished copy: clean the original again, under the same name.
    return writeProcessed(id, files.original, meta.edits ?? {}, Math.max(Date.now(), meta.rev + 1), meta.restoration);
  }
  await Promise.all([
    writeFile(path.join(MEDIA, pngName(id, meta.rev)), files.png!),
    ...(meta.openingImage ? [writeFile(path.join(MEDIA, openingName(id, meta.rev)), files.opening!)] : []),
  ]);
  await writeWhole(metaPath(id), JSON.stringify(meta));
  // A copy from an older cleaner is brought up to date from its original.
  return (await getMedia(id))!;
}

/** Revision of a fixed page: fixed by its source and the cleaner version, so
 * every build of the same image gives the same file names. */
export const fixedRev = (source: Buffer) =>
  parseInt(createHash('sha256').update(source).update(`processor-${PROCESSOR_VERSION}`).digest('hex').slice(0, 8), 16) + 1;

/** `npm run build` cleans the fixed pages once, so a start only copies them. */
export async function buildFixedMedia(): Promise<void> {
  mkdirSync(FIXED_BUILD, { recursive: true });
  for (const [id, file] of FIXED) {
    const source = await readFile(file);
    const { meta, png, openingPng } = await cleanMedia(id, source, {}, fixedRev(source));
    await Promise.all([
      writeFile(path.join(FIXED_BUILD, pngName(id, meta.rev)), png),
      ...(openingPng ? [writeFile(path.join(FIXED_BUILD, openingName(id, meta.rev)), openingPng)] : []),
    ]);
    await writeFile(path.join(FIXED_BUILD, `${id}.json`), JSON.stringify(meta));
  }
}

/** The fixed Matam page (حسين حسين، پنجتن ماتم): copied from the build, or
 * cleaned on first start when running from source without a build. */
export async function ensureFixedMedia(): Promise<void> {
  for (const [id, file] of FIXED) {
    const built = path.join(FIXED_BUILD, `${id}.json`);
    if (!existsSync(built)) {
      if (!(await getMedia(id))) await addMedia(await readFile(file), id);
      continue;
    }
    const meta: MediaMeta = JSON.parse(await readFile(built, 'utf8'));
    const current: MediaMeta | null = existsSync(metaPath(id)) ? JSON.parse(await readFile(metaPath(id), 'utf8')) : null;
    if (current?.rev === meta.rev && current.processorVersion === meta.processorVersion) continue;
    await Promise.all([
      copyFile(file, path.join(MEDIA, `${id}.orig`)),
      copyFile(path.join(FIXED_BUILD, pngName(id, meta.rev)), path.join(MEDIA, pngName(id, meta.rev))),
      ...(meta.openingImage ? [copyFile(path.join(FIXED_BUILD, openingName(id, meta.rev)), path.join(MEDIA, openingName(id, meta.rev)))] : []),
    ]);
    await writeWhole(metaPath(id), JSON.stringify(meta));
  }
}

export async function readJson<T>(name: string): Promise<T | null> {
  const p = path.join(DATA, name);
  return existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : null;
}

export async function writeJson(name: string, value: unknown): Promise<void> {
  await writeWhole(path.join(DATA, name), JSON.stringify(value));
}
