// The browser's own copies of kalam PDFs and what was found in them, in
// IndexedDB (works in the page and in workers, also on plain http). The
// Zikre Husain PDF is downloaded once and kept; PDFs you add live only here,
// on this device.

const DB = 'karbala-booklet-library';
let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('files');
      request.result.createObjectStore('meta');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(store: 'files' | 'meta', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('Storage was aborted (the device may be out of space).'));
  });
}

export const readFile = (key: string) => run<Blob>('files', 'readonly', (s) => s.get(key));
export const writeFile = (key: string, blob: Blob) => run('files', 'readwrite', (s) => { s.put(blob, key); });
export const deleteFile = (key: string) => run('files', 'readwrite', (s) => { s.delete(key); });
export const readMeta = <T>(key: string) => run<T>('meta', 'readonly', (s) => s.get(key) as IDBRequest<T>);
export const writeMeta = (key: string, value: unknown) => run('meta', 'readwrite', (s) => { s.put(value, key); });
export const deleteMeta = (key: string) => run('meta', 'readwrite', (s) => { s.delete(key); });

/** The Zikre Husain PDF's key: its own digest, so a new edition is fetched again. */
export const zhKey = (sha: string) => `zh:${sha}`;
