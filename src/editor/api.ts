import type { Booklet, Defaults, MediaMeta } from '../booklet/model';
import { mediaSrc } from '../booklet/media';
import type { ImageBlock } from '../booklet/model';
import type { ExportRequest } from '../booklet/print';
import { readBackup, saveBackup, type MediaBackup } from './cache';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}

/** Fixed pages are built into the app and need no browser copy. */
const builtIn = (id: string) => id.startsWith('fixed-');
const finishedSrc = (m: MediaMeta) => ({
  png: m.format === 'png' ? `/media/${m.id}.${m.rev}.png` : null,
  opening: m.format === 'png' && m.openingImage ? `/media/${m.id}.${m.rev}.opening.png` : null,
});

// Finished files join the browser copy quietly, one at a time and after the
// preview has loaded them, so they come from the browser's own cache.
let keeping = Promise.resolve();
const idle = () => new Promise<void>((resolve) => ('requestIdleCallback' in window ? requestIdleCallback(() => resolve(), { timeout: 5000 }) : setTimeout(resolve, 2000)));
function keepFinished(meta: MediaMeta) {
  keeping = keeping.then(idle).then(async () => {
    const { png, opening } = finishedSrc(meta);
    if (!png) return;
    const fetchBlob = async (src: string | null) => {
      if (!src) return undefined;
      const r = await fetch(src);
      if (!r.ok) throw new Error(`${src}: ${r.status}`);
      return r.blob();
    };
    const files = { png: await fetchBlob(png), opening: await fetchBlob(opening) };
    const backup = await readBackup<MediaBackup>(`media:${meta.id}`);
    // Only files of the revision the copy describes; a newer edit wins.
    if (backup?.meta.rev === meta.rev) await saveBackup(`media:${meta.id}`, { ...backup, ...files });
  }).catch((error) => console.warn('Browser copy of a finished screenshot could not be kept:', error));
}

/** Hand a screenshot back to a server that lost it, under its own name. */
async function reinstate(id: string, meta: Partial<MediaMeta> & { edits?: Edits }, original: Blob, png?: Blob, opening?: Blob) {
  const header = new TextEncoder().encode(JSON.stringify({ meta, sizes: [original.size, png?.size ?? 0, opening?.size ?? 0] }));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, header.length);
  const body = new Blob([length, header, original, ...(png ? [png] : []), ...(opening ? [opening] : [])]);
  return fetch(`/api/media/${id}/reinstate`, { method: 'POST', body }).then((r) => json<MediaMeta & { edits: Edits }>(r));
}

/** The browser's copy of one finished file, for a print the server lost it from. */
async function finishedCopy(src: string): Promise<Blob | null> {
  const match = /^\/media\/([\w-]+)\.(\d+)\.(png|opening\.png)$/.exec(src);
  if (!match) return null;
  const backup = await readBackup<MediaBackup>(`media:${match[1]}`);
  const kept = backup?.meta.rev === Number(match[2]) ? (match[3] === 'png' ? backup.png : backup.opening) : undefined;
  if (kept) return kept;
  const cached = await fetch(src, { cache: 'force-cache' }).catch(() => null);
  return cached?.ok ? cached.blob() : null;
}

const errorText = async (res: Response) => {
  const text = await res.text();
  try { return (JSON.parse(text) as { error?: string }).error ?? text; } catch { return text || res.statusText; }
};

export const api = {
  aiStatus: () => fetch('/api/ai/status').then((r) => json<{ configured: boolean; model: string; referenceBank: { documents: number; pages: number } }>(r)),
  restore: (id: string, script = 'auto') => fetch(`/api/media/${id}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ script }) }).then((r) => json<RestorationJob>(r)),
  restorationJob: (id: string) => fetch(`/api/ai/jobs/${id}`).then((r) => json<RestorationJob>(r)),
  upload: async (file: Blob) => {
    const meta = await fetch('/api/media', { method: 'POST', body: file }).then((r) => json<MediaMeta>(r));
    await saveBackup(`media:${meta.id}`, { original: file, meta } satisfies MediaBackup);
    keepFinished(meta);
    return meta;
  },
  edit: async (id: string, edits: Edits) => {
    const meta = await fetch(`/api/media/${id}/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edits) }).then((r) => json<MediaMeta & { edits: Edits }>(r));
    const previous = await readBackup<MediaBackup>(`media:${id}`);
    if (previous) {
      await saveBackup(`media:${id}`, { original: previous.original, meta } satisfies MediaBackup);
      keepFinished(meta);
    }
    return meta;
  },
  /** The server lost this screenshot: give it back under the same name, so
   * the booklet's references and the browser's cached files stay valid. */
  recover: async (block: ImageBlock) => {
    const backup = await readBackup<MediaBackup>(`media:${block.mediaId}`);
    if (backup) {
      const meta = await reinstate(block.mediaId, backup.meta, backup.original, backup.png, backup.opening);
      if (meta.rev !== backup.meta.rev) {
        // Cleaned again (no finished copy, or a newer cleaner): keep the new files.
        await saveBackup(`media:${block.mediaId}`, { original: backup.original, meta } satisfies MediaBackup);
        keepFinished(meta);
      }
      return meta;
    }
    // Old versions had no durable backup. A cached preview can still rescue
    // the lettering, although it cannot recover detail lost by old tracing.
    const response = await fetch(mediaSrc(block), { cache: 'force-cache' });
    if (!response.ok) return null;
    const original = await response.blob();
    const meta = await reinstate(block.mediaId, { rev: block.rev, edits: {} }, original);
    await saveBackup(`media:${meta.id}`, { original, meta } satisfies MediaBackup);
    keepFinished(meta);
    return meta;
  },
  media: async (id: string) => {
    const r = await fetch(`/api/media/${id}`);
    if (r.status === 404) return null;
    const meta = await json<MediaMeta & { edits: Edits }>(r);
    if (builtIn(id)) return meta;
    const backup = await readBackup<MediaBackup>(`media:${id}`);
    if (!backup) {
      const original = await fetch(`/api/media/${id}/original`);
      if (original.ok) await saveBackup(`media:${id}`, { original: await original.blob(), meta } satisfies MediaBackup);
      keepFinished(meta);
    } else if (backup.meta.rev !== meta.rev) {
      // The server cleaned it again (a newer cleaner): follow its revision.
      await saveBackup(`media:${id}`, { original: backup.original, meta } satisfies MediaBackup);
      keepFinished(meta);
    } else if (!backup.png) keepFinished(meta); // An older copy: add its finished files.
    return meta;
  },
  /** Only the booklet travels; the server asks for any image it has lost,
   * which goes back once as plain bytes before the request is repeated. */
  exportPdf: async (request: ExportRequest): Promise<string> => {
    const post = () => fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    let res = await post();
    if (res.status === 422) {
      const { missing = [], error = 'A verse image is missing.' } = await res.clone().json().catch(() => ({})) as { missing?: string[]; error?: string };
      if (missing.length) {
        for (const src of missing) {
          const blob = await finishedCopy(src);
          const sent = blob && (await fetch(`/api/export/asset?src=${encodeURIComponent(src)}`, { method: 'POST', body: blob })).ok;
          if (!sent) throw new Error(error);
        }
        res = await post();
      }
    }
    if (!res.ok) throw new Error(await errorText(res));
    return ((await res.json()) as { url: string }).url;
  },
  loadBooklet: () => fetch('/api/booklet').then((r) => json<Booklet | null>(r)),
  saveBooklet: (doc: Booklet) => fetch('/api/booklet', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) }),
  loadDefaults: () => fetch('/api/defaults').then((r) => json<Defaults>(r)),
  saveDefaults: async (d: Defaults) => {
    await saveBackup('defaults', d);
    return fetch('/api/defaults', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
  },
};

export interface RestorationJob {
  id: string;
  status: 'queued' | 'restoring' | 'ready' | 'failed';
  result?: MediaMeta;
  error?: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Edits {
  crop?: Rect;
  erase?: Rect[];
  autoClean?: boolean;
}
