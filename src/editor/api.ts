import type { Booklet, Defaults, MediaMeta } from '../booklet/model';
import { mediaSrc } from '../booklet/media';
import type { ImageBlock } from '../booklet/model';
import { readBackup, saveBackup, type MediaBackup } from './cache';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}

export const api = {
  aiStatus: () => fetch('/api/ai/status').then((r) => json<{ configured: boolean; model: string }>(r)),
  restore: (id: string) => fetch(`/api/media/${id}/restore`, { method: 'POST' }).then((r) => json<RestorationJob>(r)),
  restorationJob: (id: string) => fetch(`/api/ai/jobs/${id}`).then((r) => json<RestorationJob>(r)),
  upload: async (file: Blob) => {
    const meta = await fetch('/api/media', { method: 'POST', body: file }).then((r) => json<MediaMeta>(r));
    await saveBackup(`media:${meta.id}`, { original: file, meta } satisfies MediaBackup);
    return meta;
  },
  edit: async (id: string, edits: Edits) => {
    const meta = await fetch(`/api/media/${id}/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edits) }).then((r) => json<MediaMeta & { edits: Edits }>(r));
    const previous = await readBackup<MediaBackup>(`media:${id}`);
    if (previous) await saveBackup(`media:${id}`, { ...previous, meta });
    return meta;
  },
  recover: async (block: ImageBlock) => {
    const backup = await readBackup<MediaBackup>(`media:${block.mediaId}`);
    if (backup) {
      const restored = await api.upload(backup.original);
      const meta = backup.meta.edits ? await api.edit(restored.id, backup.meta.edits) : restored;
      await saveBackup(`media:${block.mediaId}`, { original: backup.original, meta });
      return meta;
    }
    // Old versions had no durable backup. A cached preview can still rescue
    // the lettering, although it cannot recover detail lost by old tracing.
    const response = await fetch(mediaSrc(block), { cache: 'force-cache' });
    if (!response.ok) return null;
    return api.upload(await response.blob());
  },
  media: async (id: string) => {
    const r = await fetch(`/api/media/${id}`);
    if (r.status === 404) return null;
    const meta = await json<MediaMeta & { edits: Edits }>(r);
    if (!(await readBackup<MediaBackup>(`media:${id}`))) {
      const original = await fetch(`/api/media/${id}/original`);
      if (original.ok) await saveBackup(`media:${id}`, { original: await original.blob(), meta });
    }
    return meta;
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
