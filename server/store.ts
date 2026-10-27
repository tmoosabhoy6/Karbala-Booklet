// On-disk storage under data/ (git-ignored): processed screenshots, the
// working booklet, and pinned defaults.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanScreenshot, Edits } from './ink';

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
}

const metaPath = (id: string) => path.join(MEDIA, `${id}.json`);
const safeId = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error('bad id');
  return id;
};

async function writeProcessed(id: string, original: Buffer, edits: Edits, rev: number): Promise<MediaMeta> {
  const r = await cleanScreenshot(original, edits);
  const meta: MediaMeta = { id, rev, width: r.width, height: r.height, bands: r.bands, lineHeight: r.lineHeight, edits };
  await Promise.all([
    writeFile(path.join(MEDIA, `${id}.png`), r.png),
    writeFile(path.join(MEDIA, `${id}.svg`), r.svg),
    writeFile(metaPath(id), JSON.stringify(meta)),
  ]);
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

export async function getMedia(id: string): Promise<MediaMeta | null> {
  safeId(id);
  return existsSync(metaPath(id)) ? JSON.parse(await readFile(metaPath(id), 'utf8')) : null;
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
