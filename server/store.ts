// On-disk storage under data/ (git-ignored): processed screenshots, the
// working booklet, and pinned defaults.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { copyFile, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanScreenshot, Edits, PROCESSOR_VERSION, Region } from './ink';
import type { Recognized } from '../src/library/ink';
import { heavyWork } from './resources';
import { isLibraryMedia, libraryBuild, libraryContinues, libraryGeometry, libraryImage } from './library';
import { ensureLocal, forget, mirror, storedNames } from './durable';
import { BLOCK_GEOMETRY, type Block, type Booklet, type Defaults, type MediaMeta as BrowserMediaMeta } from '../src/booklet/model';

export const DATA = path.resolve(process.env.DATA_DIR ?? 'data');
export const MEDIA = path.join(DATA, 'media');
mkdirSync(MEDIA, { recursive: true });
/** The built-in default pages, already cleaned by `npm run build`. */
export const FIXED_BUILD = path.resolve('build/fixed');
/** Built-in default content (src/booklet/model.ts BUILTIN_MEDIA): id, source,
 * and crop/erase applied to the untouched source (a clipped line, verse numbers). */
const FIXED: [string, string, Edits?][] = [
  ['fixed-matam', 'public/fixed/matam-husain-panjatan.png'],
  ['fixed-matam-najaf', 'public/fixed/matam-husain-panjatan-najaf.png'],
  // Made from the scan in references/ by tools/prepare_dua.py.
  ['fixed-dua', 'public/fixed/dua-allahumma-anta-thiqati.png'],
  ['fixed-sawari', 'public/fixed/sawari-gham-ni-avi.webp', { erase: [{ x: 208, y: 728, w: 60, h: 60 }, { x: 202, y: 865, w: 16, h: 16 }, { x: 926, y: 955, w: 18, h: 20 }] }],
  ['fixed-qasida', 'public/fixed/qasida-fuzto-fawzan.png', { crop: { x: 0, y: 6, w: 1094, h: 1380 } }],
  ['fixed-manqabat', 'public/fixed/manqabat-mazhar-che-bhala.png'],
  ['fixed-salam-arz-najaf', 'public/fixed/salam-arz-najaf.png'],
];

/** A screenshot's metadata: what the browser sees (src/booklet/model.ts)
 * and what only the server keeps. */
export interface MediaMeta extends BrowserMediaMeta {
  regions?: Region[];
  edits: Edits;
  processorVersion?: number;
  restoration?: { sourceId: string; sourceRev: number; model: string; referenceVersion: number };
  /** The HD pass's enlargement of the cleaned source (server/ink.ts). */
  scale?: number;
  /** OCR of the original, reused by every later clean of it. */
  ocr?: Recognized;
  /** The library build a library image was made from (library.ts libraryBuild). */
  library?: string;
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

// Write-then-rename keeps a file whole if the app is closed mid-save. Writes
// to one file take turns, in the order they came: two saves at once shared
// the .tmp file, and the second rename found it already gone (ENOENT).
const writing = new Map<string, Promise<void>>();
async function writeWhole(file: string, data: string | Buffer) {
  const turn = (writing.get(file) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
    mirror(DATA, file, data);
  });
  writing.set(file, turn);
  try { await turn; } finally { if (writing.get(file) === turn) writing.delete(file); }
}

/** A media file written (and copied to durable storage, server/durable.ts). */
async function saveFile(file: string, data: Buffer) {
  await writeFile(file, data);
  mirror(DATA, file, data);
}
/** A media file (`<id>.json`, `<id>.<rev>.png`, …) on disk, fetched back from
 * durable storage when a restart lost it. */
export const ensureMediaFile = (name: string) => ensureLocal(DATA, path.join(MEDIA, name));

function writeProcessed(id: string, original: Buffer, edits: Edits, rev: number, restoration?: MediaMeta['restoration'], library?: string, known?: Recognized): Promise<MediaMeta> {
  return heavyWork(() => processImage(id, original, edits, rev, restoration, library, known));
}
/** Clean a screenshot into its finished files and metadata (no disk writes). */
export async function cleanMedia(id: string, original: Buffer, edits: Edits, rev: number, restoration?: MediaMeta['restoration'], known?: Recognized) {
  // Built-in pages and library verses need no OCR: no page numbers to find,
  // and the fihrist shows their own opening words.
  const { png, openingPng, ...geometry } = await cleanScreenshot(original, edits, { ocr: !id.startsWith('fixed-') && !isLibraryMedia(id) && !restoration, marks: !isLibraryMedia(id), enhance: !isLibraryMedia(id), known });
  // A 50% tracing threshold erased faint hairlines and small dots. Export the
  // antialiased ink itself, including high-resolution generated drafts.
  const meta: MediaMeta = { id, rev, ...geometry, edits, restoration, processorVersion: PROCESSOR_VERSION, format: 'png', openingImage: !!openingPng };
  if (isLibraryMedia(id) && libraryContinues(id)) meta.continues = true;
  return { meta, png, openingPng };
}
async function processImage(id: string, original: Buffer, edits: Edits, rev: number, restoration?: MediaMeta['restoration'], library?: string, known?: Recognized): Promise<MediaMeta> {
  const { meta, png, openingPng } = await cleanMedia(id, original, edits, rev, restoration, known);
  if (library) meta.library = library;
  // Only the versioned PNG and the opening words are ever read; old SVG
  // entries are rebuilt on request (see svgWrapper).
  await Promise.all([
    saveFile(path.join(MEDIA, pngName(id, rev)), png),
    ...(openingPng ? [saveFile(path.join(MEDIA, openingName(id, rev)), openingPng)] : []),
  ]);
  await writeWhole(metaPath(id), JSON.stringify(meta));
  return meta;
}

export async function addMedia(original: Buffer, id: string = randomUUID(), options: { edits?: Edits; restoration?: MediaMeta['restoration'] } = {}): Promise<MediaMeta> {
  safeId(id);
  await (id.startsWith('fixed-') ? writeFile(path.join(MEDIA, `${id}.orig`), original) : saveFile(path.join(MEDIA, `${id}.orig`), original));
  return writeProcessed(id, original, options.edits ?? {}, Date.now(), options.restoration);
}

const makingOriginal = new Map<string, Promise<boolean>>();
/**
 * The untouched source of a screenshot on disk (`<id>.orig`), fetched back
 * from durable storage when a restart lost it. A library verse finished in
 * the browser never had one here: it is rendered from the PDF, as the server
 * would have. False when there is none to be had.
 */
export function ensureOriginal(id: string): Promise<boolean> {
  safeId(id);
  const file = path.join(MEDIA, `${id}.orig`);
  if (!makingOriginal.has(id)) makingOriginal.set(id, (async () => {
    if (await ensureMediaFile(`${id}.orig`)) return true;
    if (!isLibraryMedia(id)) return false;
    const png = await heavyWork(() => libraryImage(id));
    if (!existsSync(file)) await saveFile(file, png);
    return true;
  })().finally(() => makingOriginal.delete(id)));
  return makingOriginal.get(id)!;
}

export async function editMedia(id: string, edits: Edits): Promise<MediaMeta> {
  safeId(id);
  if (!(await ensureLocal(DATA, metaPath(id)))) throw new Error('This screenshot is no longer on the server. Add it again.');
  const prev: MediaMeta = JSON.parse(await readFile(metaPath(id), 'utf8'));
  if (!(await ensureOriginal(id))) throw new Error('The original screenshot is missing. Add it again.');
  const original = await readFile(path.join(MEDIA, `${id}.orig`));
  // Timestamp revisions keep cached files (served immutable) from going stale.
  // A library verse keeps its build, so its crop and erase edits stay.
  return writeProcessed(id, original, edits, Math.max(Date.now(), prev.rev + 1), prev.restoration, isLibraryMedia(id) ? prev.library : undefined, prev.ocr);
}

const processing = new Map<string, Promise<MediaMeta>>();

/** A library verse image: rendered from the PDF and cleaned, under a name
 * fixed by its id, so a lost one is simply made again, identically. */
function makeLibraryMedia(id: string): Promise<MediaMeta> {
  if (!processing.has(id)) processing.set(id, heavyWork(async () => {
    const png = await libraryImage(id);
    await saveFile(path.join(MEDIA, `${id}.orig`), png);
    const build = libraryBuild();
    return processImage(id, png, {}, fixedRev(Buffer.from(`${id}:${build}`)), undefined, build);
  }).finally(() => processing.delete(id)));
  return processing.get(id)!;
}

/** A library verse the server already has, made by the current build; null
 * otherwise (nothing is made). */
export async function currentLibraryMedia(id: string): Promise<MediaMeta | null> {
  safeId(id);
  if (!isLibraryMedia(id) || !(await ensureLocal(DATA, metaPath(id)))) return null;
  const meta: MediaMeta = JSON.parse(await readFile(metaPath(id), 'utf8'));
  return meta.processorVersion === PROCESSOR_VERSION && meta.library === libraryBuild() && (await ensureMediaFile(pngName(id, meta.rev))) ? meta : null;
}

/**
 * A library verse rendered and cleaned in the browser (src/library/worker.ts,
 * the same renderer and cleaner as makeLibraryMedia): saved as given, under
 * the revision the server would give it. Only for the current library build.
 */
export async function storeLibraryMedia(id: string, build: string, given: Partial<MediaMeta>, png: Buffer, opening: Buffer): Promise<MediaMeta> {
  safeId(id);
  if (!isLibraryMedia(id)) throw new Error('Not a library verse.');
  if (build !== libraryGeometry()?.build) throw new Error('The library has been updated. Reload the page.');
  const existing = await currentLibraryMedia(id);
  if (existing) return existing;
  const size = pngSize(png), openingSize = pngSize(opening);
  const ok = (n: unknown) => Number.isFinite(n) && (n as number) >= 0;
  if (!size || !openingSize || size.width !== given.width || size.height !== given.height || openingSize.width !== given.opening?.w || openingSize.height !== given.opening?.h
    || !Array.isArray(given.bands) || !Array.isArray(given.regions) || !ok(given.lineHeight) || !given.regions.every((r) => [r.x, r.y, r.w, r.h, r.lineHeight, r.group].every(ok))) {
    throw new Error('Incomplete verse image.');
  }
  const library = libraryBuild();
  const rev = fixedRev(Buffer.from(`${id}:${library}`));
  const meta: MediaMeta = {
    id, rev, width: size.width, height: size.height, bands: given.bands, lineHeight: given.lineHeight!, regions: given.regions, opening: given.opening,
    suggestedName: '', recognitionConfidence: 0, warnings: (given.warnings ?? []).filter((w) => typeof w === 'string').slice(0, 5), edits: {},
    processorVersion: PROCESSOR_VERSION, format: 'png', openingImage: true, library, ...(libraryContinues(id) ? { continues: true } : {}),
  };
  await Promise.all([saveFile(path.join(MEDIA, pngName(id, rev)), png), saveFile(path.join(MEDIA, openingName(id, rev)), opening)]);
  await writeWhole(metaPath(id), JSON.stringify(meta));
  return meta;
}

export async function getMedia(id: string, options: { wait?: boolean } = {}): Promise<MediaMeta | null> {
  safeId(id);
  if (!id.startsWith('fixed-')) await ensureLocal(DATA, metaPath(id));
  if (!existsSync(metaPath(id)) && isLibraryMedia(id)) return makeLibraryMedia(id);
  if (!existsSync(metaPath(id))) return null;
  const meta: MediaMeta = JSON.parse(await readFile(metaPath(id), 'utf8'));
  // A library image is made again from the PDF, never re-cleaned from an
  // older render (which may lack lettering a newer build restores).
  if (isLibraryMedia(id)) return meta.processorVersion === PROCESSOR_VERSION && meta.library === libraryBuild() ? meta : makeLibraryMedia(id);
  if (meta.processorVersion === PROCESSOR_VERSION) return meta;
  if (!processing.has(id)) processing.set(id, ensureMediaFile(`${id}.orig`).then(() => readFile(path.join(MEDIA, `${id}.orig`)))
    .then((original) => writeProcessed(id, original, meta.edits ?? {}, Math.max(Date.now(), meta.rev + 1), meta.restoration, undefined, meta.ocr))
    .finally(() => processing.delete(id)));
  // Made by an older cleaner: cleaned again in the background (OCR on the
  // free host takes many seconds a screenshot) while its current files keep
  // serving; the editor picks up the new version on its next load.
  const current = meta.format === 'png' && (await ensureMediaFile(pngName(id, meta.rev)));
  if (current && !options.wait) {
    processing.get(id)!.catch((error) => console.error(`Cleaning ${id} again failed:`, error));
    return meta;
  }
  return processing.get(id)!;
}

/** Only fields the server itself writes are taken from a browser's copy. */
const META_KEYS = [...BLOCK_GEOMETRY, 'edits', 'processorVersion', 'recognitionConfidence', 'restoration', 'scale', 'ocr'] as const;
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
  await saveFile(path.join(MEDIA, `${id}.orig`), files.original);
  const size = files.png && pngSize(files.png);
  const opening = files.opening && pngSize(files.opening);
  const finished = meta.format === 'png' && size && positive(meta.width) && positive(meta.height) && size.width === meta.width && size.height === meta.height
    && (!meta.openingImage || (opening && opening.width === meta.opening?.w && opening.height === meta.opening?.h));
  if (!finished) {
    // No usable finished copy: clean the original again, under the same name.
    return writeProcessed(id, files.original, meta.edits ?? {}, Math.max(Date.now(), meta.rev + 1), meta.restoration);
  }
  await Promise.all([
    saveFile(path.join(MEDIA, pngName(id, meta.rev)), files.png!),
    ...(meta.openingImage ? [saveFile(path.join(MEDIA, openingName(id, meta.rev)), files.opening!)] : []),
  ]);
  await writeWhole(metaPath(id), JSON.stringify(meta));
  // A copy from an older cleaner is brought up to date from its original.
  return (await getMedia(id, { wait: true }))!;
}

/** Revision of a fixed page: fixed by its source and the cleaner version, so
 * every build of the same image gives the same file names. */
export const fixedRev = (source: Buffer, edits: Edits = {}) =>
  parseInt(createHash('sha256').update(source).update(`processor-${PROCESSOR_VERSION}`).update(JSON.stringify(edits)).digest('hex').slice(0, 8), 16) + 1;

/** `npm run build` cleans the fixed pages once, so a start only copies them. */
export async function buildFixedMedia(): Promise<void> {
  mkdirSync(FIXED_BUILD, { recursive: true });
  for (const [id, file, edits = {}] of FIXED) {
    const source = await readFile(file);
    const { meta, png, openingPng } = await cleanMedia(id, source, edits, fixedRev(source, edits));
    await Promise.all([
      writeFile(path.join(FIXED_BUILD, pngName(id, meta.rev)), png),
      ...(openingPng ? [writeFile(path.join(FIXED_BUILD, openingName(id, meta.rev)), openingPng)] : []),
    ]);
    await writeFile(path.join(FIXED_BUILD, `${id}.json`), JSON.stringify(meta));
  }
}

/** The built-in default pages (the Matam, Najaf's in green; Dua, Sawari, Qasida…): copied
 * from the build, or cleaned on first start when running from source without a build. */
export async function ensureFixedMedia(): Promise<void> {
  for (const [id, file, edits = {}] of FIXED) {
    const built = path.join(FIXED_BUILD, `${id}.json`);
    if (!existsSync(built)) {
      if (!(await getMedia(id))) await addMedia(await readFile(file), id, { edits });
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

/** A JSON file under data/, or null when there is none. Throws
 * StorageUnavailable (server/durable.ts) when that could not be checked:
 * unknown is never taken for absent. */
export async function readJson<T>(name: string): Promise<T | null> {
  const p = path.join(DATA, name);
  if (!(await ensureLocal(DATA, p))) return null;
  return JSON.parse(await readFile(p, 'utf8'));
}

export async function writeJson(name: string, value: unknown): Promise<void> {
  await writeWhole(path.join(DATA, name), JSON.stringify(value));
}

/** Remove a file under data/, here and in durable storage. */
export async function removeFile(name: string) {
  const file = path.join(DATA, name);
  if (path.relative(DATA, file).startsWith('..')) throw new Error('bad name');
  await unlink(file).catch(() => undefined);
  forget(DATA, file);
}

// ---- cleaning up ----
// Every crop, every newer cleaner and every library build writes new files,
// and a removed PDF stays in the folder: none of it is ever read again.
// Files no booklet or default (either city) uses are listed in
// cleanup.json when first found unused, and removed once they have stayed
// unused for STORAGE_CLEANUP_GRACE_DAYS (14): long enough for a device that
// was away to come back and hand in its own copy.
const BOOKLET_FILES = ['booklet.json', 'booklet-najaf.json', 'defaults.json', 'defaults-najaf.json'];
const GRACE = Number(process.env.STORAGE_CLEANUP_GRACE_DAYS ?? 14) * 86_400_000;
const MEDIA_FILE = /^media\/([\w-]+?)(?:\.(\d+)\.(png|opening\.png|svg)|\.(json|orig))$/;
export async function cleanUp(): Promise<{ removed: number; waiting: number }> {
  // What the booklets and defaults use: each screenshot, and each revision.
  const used = new Set<string>();
  const blocks: Block[] = [];
  for (const name of BOOKLET_FILES) {
    const value = await readJson<Booklet | Defaults>(name);
    if (!value) continue;
    if ('kalams' in value && value.kalams) blocks.push(...Object.values(value.kalams).flatMap((ks) => (ks as { blocks: Block[] }[]).flatMap((k) => k.blocks)));
    else blocks.push(...Object.values(value as Defaults).flatMap((d) => d.blocks ?? []));
  }
  for (const b of blocks) if (b.kind === 'image') { used.add(b.mediaId); used.add(`${b.mediaId}.${b.rev}`); }
  // A used screenshot's current revision is what the server serves.
  for (const id of [...used].filter((u) => !u.includes('.'))) {
    if (id.startsWith('fixed-')) continue;
    const meta = await ensureLocal(DATA, metaPath(id)).then((ok) => (ok ? readFile(metaPath(id), 'utf8') : null)).catch(() => null);
    if (meta) used.add(`${id}.${(JSON.parse(meta) as MediaMeta).rev}`);
    else used.add(`${id}.*`); // unknown: keep every revision
  }
  const local = (await readdir(MEDIA).catch(() => [] as string[])).filter((f) => !f.endsWith('.tmp')).map((f) => `media/${f}`);
  const pdfIndex = (await readJson<{ key: string; deleted?: boolean }[]>('pdfs/index.json')) ?? [];
  const removedPdfs = new Set(pdfIndex.filter((p) => p.deleted).map((p) => p.key.slice(2)));
  const unused = new Set<string>();
  for (const name of new Set([...storedNames(), ...local])) {
    const pdf = /^pdfs\/([0-9a-f]{16})\.(pdf|json)$/.exec(name);
    if (pdf) { if (removedPdfs.has(pdf[1])) unused.add(name); continue; }
    const m = MEDIA_FILE.exec(name);
    if (!m || m[1].startsWith('fixed-')) continue;
    const [, id, rev] = m;
    if (!used.has(id)) unused.add(name);
    else if (rev && !used.has(`${id}.${rev}`) && !used.has(`${id}.*`)) unused.add(name);
  }
  const now = Date.now();
  const seen = (await readJson<Record<string, number>>('cleanup.json')) ?? {};
  const next: Record<string, number> = {};
  let removed = 0;
  for (const name of unused) {
    const since = seen[name] ?? now;
    if (now - since >= GRACE) { await removeFile(name); removed++; }
    else next[name] = since;
  }
  if (JSON.stringify(next) !== JSON.stringify(seen)) await writeJson('cleanup.json', next);
  return { removed, waiting: Object.keys(next).length };
}
