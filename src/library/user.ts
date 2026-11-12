// PDFs of kalams added in the editor: kept in this device's storage with what
// was found in them (src/library/analyze.ts) and the names given to each
// kalam, so they can be searched and added like the Zikre Husain library.
// Each is also kept on the server (server/index.ts /api/pdfs), so a PDF added
// on the laptop is on the phone too (syncUserPdfs).
import { analyzeUserPdf, closeUser } from './client';
import type { FoundKalam } from './analyze';
import type { Library } from './geometry';
import { deleteFile, deleteMeta, readFile, readMeta, writeFile, writeMeta } from './store';

export interface UserPdf { key: string; name: string; size: number; added: number; pages: number }
/** One kalam of an added PDF: its name (typed by you) and what it holds. */
export interface UserKalam extends FoundKalam { title: string }

const LIST = 'user-pdfs';
const listeners = new Set<() => void>();
let version = 0;
/** Changes whenever an added PDF or a kalam's name changes. */
export const userVersion = () => version;
export function onUserChange(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
const changed = () => { version++; for (const l of listeners) l(); };

export const listUserPdfs = async () => (await readMeta<UserPdf[]>(LIST).catch(() => undefined)) ?? [];
export const userKalams = async (key: string) => (await readMeta<UserKalam[]>(`kalams:${key}`)) ?? [];
const userLibrary = async (key: string) => {
  const lib = await readMeta<Library>(`lib:${key}`);
  if (!lib) throw new Error('This PDF is no longer on this device.');
  return lib;
};

/** A short digest of the file, so the same PDF added twice is found again. */
async function digest(bytes: ArrayBuffer): Promise<string> {
  if (crypto.subtle) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(hash.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Plain http on a local network has no crypto.subtle: FNV-1a over the bytes.
  const data = new Uint8Array(bytes);
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ data.length;
  for (let i = 0; i < data.length; i++) { h1 = Math.imul(h1 ^ data[i], 0x01000193); h2 = Math.imul(h2 ^ data[i], 0x5bd1e995); }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

// ---- sharing with the server ----
type Shared = { key: string; updated: number; deleted?: boolean };
const enc = encodeURIComponent;
const updatedAt = async (key: string) => (await readMeta<number>(`updated:${key}`).catch(() => undefined)) ?? 0;
// Changes not yet on the server, kept until it has them: PDFs whose details
// (names, splits) still have to go up, and PDFs removed here whose removal
// still has to reach it. Each sync tries them again.
const UNSHARED = 'user-pdfs-unshared';
const REMOVED = 'user-pdfs-removed';
const unsharedKeys = async () => (await readMeta<string[]>(UNSHARED).catch(() => undefined)) ?? [];
const removedKeys = async () => (await readMeta<{ key: string; at: number }[]>(REMOVED).catch(() => undefined)) ?? [];
const setUnshared = async (key: string, waiting: boolean) => {
  const keys = (await unsharedKeys()).filter((k) => k !== key);
  await writeMeta(UNSHARED, waiting ? [...keys, key] : keys);
};

/** Send this device's copy of a PDF's details (and the file, the first time).
 * Its time stamp moves only once the server has it, and until then it stays
 * marked to be sent again. */
async function share(key: string, withFile = false) {
  await setUnshared(key, true);
  try {
    const [list, lib, kalams] = await Promise.all([listUserPdfs(), readMeta<Library>(`lib:${key}`), userKalams(key)]);
    const pdf = list.find((p) => p.key === key);
    if (!pdf || !lib) return void (await setUnshared(key, false));
    if (withFile) {
      const blob = await readFile(key);
      if (!blob) return void (await setUnshared(key, false));
      const sent = await fetch(`/api/pdfs/${enc(key)}/file`, { method: 'PUT', body: blob });
      if (!sent.ok) throw new Error(await sent.text());
    }
    const updated = Date.now();
    const res = await fetch(`/api/pdfs/${enc(key)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pdf, lib, kalams, updated }) });
    if (!res.ok && res.status !== 409) throw new Error(await res.text());
    // 409: another device saved newer details, which the next sync brings here.
    if (res.ok) await writeMeta(`updated:${key}`, updated);
    await setUnshared(key, false);
  } catch (error) {
    console.warn('This PDF could not be shared with your other devices yet:', error);
  }
}

/** Tell the server a PDF was removed here; true once it knows. */
async function sendRemoval(key: string, at: number) {
  const res = await fetch(`/api/pdfs/${enc(key)}?updated=${at}`, { method: 'DELETE' }).catch(() => null);
  if (!res?.ok) return false;
  await writeMeta(REMOVED, (await removedKeys()).filter((r) => r.key !== key));
  return true;
}

let syncing: Promise<void> | null = null;
/** Bring this device's PDFs in line with the server's: PDFs added or named
 * on another device come here; PDFs only here (added before sharing, or
 * offline) go there; removed ones go. Once per page load. */
export function syncUserPdfs(): Promise<void> {
  return syncing ??= (async () => {
    const res = await fetch('/api/pdfs', { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) return;
    let remote = (await res.json()) as Shared[];
    // This device's own changes the server has not had yet go first: removals
    // (a PDF removed here never comes back), then details (names).
    const removed = await removedKeys();
    for (const r of removed) {
      if (await sendRemoval(r.key, r.at)) remote = [...remote.filter((x) => x.key !== r.key), { key: r.key, updated: r.at, deleted: true }];
    }
    const gone = new Set(removed.map((r) => r.key));
    for (const key of await unsharedKeys()) if (!gone.has(key)) await share(key);
    let list = await listUserPdfs();
    let touched = false;
    for (const r of remote) {
      if (gone.has(r.key)) continue;
      const have = list.some((p) => p.key === r.key);
      const mine = await updatedAt(r.key);
      if (r.deleted) {
        if (have && mine <= r.updated) { await dropLocal(r.key); list = list.filter((p) => p.key !== r.key); touched = true; }
        continue;
      }
      if (have && mine >= r.updated) continue;
      try {
        const details = await fetch(`/api/pdfs/${enc(r.key)}`).then((x) => (x.ok ? x.json() : null)) as { pdf: UserPdf; lib: Library; kalams: UserKalam[]; updated: number } | null;
        if (!details) continue;
        if (!(await readFile(r.key))) {
          const file = await fetch(`/api/pdfs/${enc(r.key)}/file`);
          if (!file.ok) continue;
          await writeFile(r.key, await file.blob());
        }
        await Promise.all([writeMeta(`lib:${r.key}`, details.lib), writeMeta(`kalams:${r.key}`, details.kalams), writeMeta(`updated:${r.key}`, details.updated)]);
        list = [...list.filter((p) => p.key !== r.key), details.pdf];
        await writeMeta(LIST, list);
        closeUser(r.key);
        touched = true;
      } catch (error) {
        console.warn('A PDF from your other devices could not be brought here:', error);
      }
    }
    for (const p of list) if (!remote.some((r) => r.key === p.key)) await share(p.key, true);
    if (touched) changed();
  })().catch((error) => console.warn('PDF sync failed:', error));
}

async function dropLocal(key: string) {
  closeUser(key);
  await writeMeta(LIST, (await listUserPdfs()).filter((p) => p.key !== key));
  await Promise.all([deleteFile(key), deleteMeta(`lib:${key}`), deleteMeta(`kalams:${key}`), deleteMeta(`updated:${key}`)]);
}

/** Keep a PDF on this device and find its kalams. */
export async function addUserPdf(file: File, progress: (done: number, total: number) => void): Promise<UserPdf> {
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) throw new Error('Choose a PDF file.');
  const bytes = await file.arrayBuffer();
  const key = `u:${await digest(bytes)}`;
  const list = await listUserPdfs();
  const existing = list.find((p) => p.key === key);
  if (existing) return existing;
  const name = file.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || 'My PDF';
  await writeFile(key, new Blob([bytes], { type: 'application/pdf' }));
  try {
    const { library, found } = await analyzeUserPdf(key, name, key.slice(2), progress);
    if (!found.length) throw new Error('No lettering was found in this PDF.');
    await writeMeta(`lib:${key}`, library);
    await writeMeta(`kalams:${key}`, found.map((f) => ({ ...f, title: '' })));
    const pdf: UserPdf = { key, name, size: file.size, added: Date.now(), pages: Math.max(...found.map((f) => f.pages[1])) + 1 };
    await writeMeta(LIST, [...list, pdf]);
    // Added again after being removed: no longer a removal to send.
    await writeMeta(REMOVED, (await removedKeys()).filter((r) => r.key !== key));
    void navigator.storage?.persist?.().catch(() => undefined);
    changed();
    void share(key, true);
    return pdf;
  } catch (error) {
    await deleteFile(key).catch(() => undefined);
    throw error;
  }
}

export async function removeUserPdf(key: string) {
  const at = Date.now();
  // Remembered until the server knows, so a sync never brings it back.
  await writeMeta(REMOVED, [...(await removedKeys()).filter((r) => r.key !== key), { key, at }]);
  await setUnshared(key, false);
  await dropLocal(key);
  changed();
  void sendRemoval(key, at);
}

export async function renameUserPdf(key: string, name: string) {
  await writeMeta(LIST, (await listUserPdfs()).map((p) => (p.key === key ? { ...p, name } : p)));
  changed();
  void share(key);
}

/** Name the kalams of an added PDF (English letters, for the search). */
export async function nameKalams(key: string, titles: string[]) {
  const kalams = await userKalams(key);
  await writeMeta(`kalams:${key}`, kalams.map((k, i) => ({ ...k, title: titles[i] ?? k.title })));
  changed();
  void share(key);
}

/** Fix how the PDF was split: kalam `n` is really the rest of the one before
 * it (`join`), not a kalam at all (`remove`), or two kalams, the second
 * starting at its verse `at` (`split`). */
export async function editKalams(key: string, n: number, edit: 'join' | 'remove' | 'split', at = 0) {
  const [lib, kalams] = await Promise.all([userLibrary(key), userKalams(key)]);
  if (!lib.kalams[n] || (edit === 'join' && n === 0)) return;
  if (edit === 'split') {
    const k = lib.kalams[n], info = kalams[n];
    if (at <= 0 || at >= k.st.length) return;
    const g = k.g ?? k.st.map((_, i) => i);
    const first = { ...k, st: k.st.slice(0, at), g: g.slice(0, at) };
    const base = g[at];
    // The second part's title preview is its own first row.
    const [page, y0] = k.st[at][0];
    const second = { ...k, st: k.st.slice(at), g: g.slice(at).map((x) => x - base), tr: [page, k.tr[1], y0, k.tr[3], y0 + k.lh * 1.4] as typeof k.tr };
    const rows = Math.round((info.r * at) / k.st.length);
    const pages = (st: typeof k.st): [number, number] => [st[0][0][0], st.at(-1)!.at(-1)![0]];
    lib.kalams.splice(n, 1, first, second);
    kalams.splice(n, 1, { ...info, v: at, r: rows, pages: pages(first.st) }, { ...info, title: '', v: k.st.length - at, r: info.r - rows, pages: pages(second.st) });
    await Promise.all([writeMeta(`lib:${key}`, lib), writeMeta(`kalams:${key}`, kalams)]);
    closeUser(key);
    changed();
    void share(key);
    return;
  }
  if (edit === 'join') {
    const a = lib.kalams[n - 1], b = lib.kalams[n];
    const shift = Math.max(-1, ...(a.g ?? a.st.map((_, i) => i))) + 1;
    lib.kalams[n - 1] = { ...a, st: [...a.st, ...b.st], g: [...(a.g ?? a.st.map((_, i) => i)), ...(b.g ?? b.st.map((_, i) => i)).map((g) => g + shift)] };
    const ka = kalams[n - 1], kb = kalams[n];
    kalams[n - 1] = { ...ka, v: ka.v + kb.v, r: ka.r + kb.r, c: ka.c === kb.c ? ka.c : undefined, pages: [ka.pages[0], kb.pages[1]], title: ka.title || kb.title };
  }
  lib.kalams.splice(n, 1);
  kalams.splice(n, 1);
  await Promise.all([writeMeta(`lib:${key}`, lib), writeMeta(`kalams:${key}`, kalams)]);
  closeUser(key); // the worker reads the new geometry next time
  changed();
  void share(key);
}
