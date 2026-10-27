import type { Booklet, Defaults, MediaMeta } from '../booklet/model';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}

export const api = {
  upload: (file: Blob) => fetch('/api/media', { method: 'POST', body: file }).then((r) => json<MediaMeta>(r)),
  edit: (id: string, edits: Edits) =>
    fetch(`/api/media/${id}/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edits) }).then((r) =>
      json<MediaMeta & { edits: Edits }>(r),
    ),
  media: (id: string) => fetch(`/api/media/${id}`).then((r) => (r.ok ? json<MediaMeta & { edits: Edits }>(r) : null)),
  loadBooklet: () => fetch('/api/booklet').then((r) => json<Booklet | null>(r)),
  saveBooklet: (doc: Booklet) => fetch('/api/booklet', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) }),
  loadDefaults: () => fetch('/api/defaults').then((r) => json<Defaults>(r)),
  saveDefaults: (d: Defaults) => fetch('/api/defaults', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) }),
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Edits {
  crop?: Rect;
  erase?: Rect[];
}
