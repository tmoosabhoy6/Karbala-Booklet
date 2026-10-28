// Durable browser copies survive a free hosting instance's disk being reset.
// IndexedDB holds blobs, not localStorage's small synchronous string quota.
import { cityOf, type Booklet, type City, type Defaults, type MediaMeta } from '../booklet/model';
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
/** Karbala keeps the original keys; Najaf's copies are `booklet:najaf` and `defaults:najaf`. */
export const cityKey = (name: string, city: City) => (city === 'karbala' ? name : `${name}:${city}`);
export const saveBookletBackup = (doc: Booklet) => saveBackup(cityKey('booklet', cityOf(doc.venue)), doc);
export const loadBookletBackup = (city: City) => readBackup<Booklet>(cityKey('booklet', city));
export const loadDefaultsBackup = (city: City) => readBackup<Defaults>(cityKey('defaults', city));
