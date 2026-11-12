// Durable browser copies survive a free hosting instance's disk being reset.
// IndexedDB holds blobs, not localStorage's small synchronous string quota.
import { type Booklet, type City, type Defaults, type MediaMeta } from '../booklet/model';
import type { Edits } from './api';
/** The untouched upload, its metadata and, once fetched, the finished files
 * of `meta.rev` (print lettering and fihrist opening words). With those the
 * server takes the screenshot back as is, without cleaning it again. */
export interface MediaBackup { original: Blob; meta: MediaMeta & { edits?: Edits }; png?: Blob; opening?: Blob }
let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('karbala-booklet-backup', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('backup');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function readBackup<T>(key: string): Promise<T | undefined> {
  try {
    const database = await db();
    return await new Promise<T | undefined>((resolve, reject) => {
      const r = database.transaction('backup').objectStore('backup').get(key);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
  } catch { return undefined; }
}
export async function saveBackup(key: string, value: unknown) {
  try {
    const database = await db();
    await new Promise<void>((resolve, reject) => {
      const t = database.transaction('backup', 'readwrite');
      t.objectStore('backup').put(value, key);
      t.oncomplete = () => resolve(); t.onerror = () => reject(t.error);
    });
  } catch (error) { console.warn('Browser backup could not be saved:', error); }
}
/** Several keys in one transaction: all of them are written, or none. */
export async function saveBackups(values: Record<string, unknown>) {
  try {
    const database = await db();
    await new Promise<void>((resolve, reject) => {
      const t = database.transaction('backup', 'readwrite');
      const store = t.objectStore('backup');
      for (const [key, value] of Object.entries(values)) store.put(value, key);
      t.oncomplete = () => resolve(); t.onerror = () => reject(t.error);
    });
  } catch (error) { console.warn('Browser backup could not be saved:', error); }
}
/** Karbala keeps the original keys; Najaf's copies are `booklet:najaf` and `defaults:najaf`. */
export const cityKey = (name: string, city: City) => (city === 'karbala' ? name : `${name}:${city}`);
/**
 * This browser's copy of the booklet (src/editor/sync.ts LocalCopy): the
 * booklet, the stamp of the server copy it started from (`booklet-at`) and
 * whether it holds changes no save has confirmed (`booklet-dirty`). Each
 * part given is written together with the others.
 */
export const saveBookletCopy = (city: City, copy: { doc?: Booklet; basedOn?: number; dirty?: boolean }) =>
  saveBackups({
    ...(copy.doc ? { [cityKey('booklet', city)]: copy.doc } : {}),
    ...(copy.basedOn !== undefined ? { [cityKey('booklet-at', city)]: copy.basedOn } : {}),
    ...(copy.dirty !== undefined ? { [cityKey('booklet-dirty', city)]: copy.dirty } : {}),
  });
export async function loadBookletCopy(city: City) {
  const [doc, basedOn = 0, dirty = false] = await Promise.all([readBackup<Booklet>(cityKey('booklet', city)), readBackup<number>(cityKey('booklet-at', city)), readBackup<boolean>(cityKey('booklet-dirty', city))]);
  return doc ? { value: doc, basedOn, dirty } : undefined;
}
export const loadDefaultsBackup = (city: City) => readBackup<Defaults>(cityKey('defaults', city));
