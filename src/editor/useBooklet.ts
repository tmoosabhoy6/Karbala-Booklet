// Working-booklet state: load, autosave (debounced), undo/redo, and pinned defaults.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Block, Booklet, Category, Defaults, Kalam, MATAM_MEDIA_ID, MediaMeta, Venue, cloneBlocks, createBooklet } from '../booklet/model';
import { api } from './api';

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const HISTORY = 60;

export function useBooklet() {
  const [doc, setDocState] = useState<Booklet | null>(null);
  const [defaults, setDefaults] = useState<Defaults>({});
  const [saved, setSaved] = useState(true);
  const past = useRef<Booklet[]>([]);
  const future = useRef<Booklet[]>([]);
  const matam = useRef<MediaMeta | null>(null);

  useEffect(() => {
    (async () => {
      const [stored, defs, m] = await Promise.all([api.loadBooklet(), api.loadDefaults(), api.media(MATAM_MEDIA_ID)]);
      matam.current = m;
      setDefaults(defs);
      // Each session starts on today's date; content carries over from last time.
      if (stored?.version === 2) {
        // Fixed content always follows the current version on disk.
        const fresh = createBooklet(todayIso(), stored.venue, {}, m);
        setDocState({ ...stored, date: todayIso(), kalams: { ...stored.kalams, matam: fresh.kalams.matam, salamArz: fresh.kalams.salamArz } });
      } else {
        setDocState(createBooklet(todayIso(), 'haram', defs, m));
      }
    })();
  }, []);

  // Autosave half a second after the last change.
  useEffect(() => {
    if (!doc) return;
    setSaved(false);
    const t = setTimeout(() => api.saveBooklet(doc).then(() => setSaved(true)), 500);
    return () => clearTimeout(t);
  }, [doc]);

  // History is kept outside React's updaters (which may run twice in dev).
  const current = useRef<Booklet | null>(null);
  current.current = doc;

  const setDoc = useCallback((fn: (d: Booklet) => Booklet) => {
    const d = current.current;
    if (!d) return;
    const next = fn(d);
    if (next === d) return;
    past.current = [...past.current.slice(-HISTORY + 1), d];
    future.current = [];
    current.current = next;
    setDocState(next);
  }, []);

  const undo = useCallback(() => {
    const d = current.current;
    const prev = past.current.pop();
    if (!d || !prev) return;
    future.current.push(d);
    current.current = prev;
    setDocState(prev);
  }, []);

  const redo = useCallback(() => {
    const d = current.current;
    const next = future.current.pop();
    if (!d || !next) return;
    past.current.push(d);
    current.current = next;
    setDocState(next);
  }, []);

  const updateKalams = useCallback(
    (category: Category, fn: (ks: Kalam[]) => Kalam[]) => setDoc((d) => ({ ...d, kalams: { ...d.kalams, [category]: fn(d.kalams[category]) } })),
    [setDoc],
  );

  const updateKalam = useCallback(
    (category: Category, id: string, fn: (k: Kalam) => Kalam) => updateKalams(category, (ks) => ks.map((k) => (k.id === id ? fn(k) : k))),
    [updateKalams],
  );

  const persistDefaults = useCallback((next: Defaults) => {
    setDefaults(next);
    api.saveDefaults(next);
  }, []);

  const pin = useCallback(
    (category: Category, kalam: Kalam) => {
      const slot = kalam.slot ?? `${category}:x${kalam.id}`;
      if (!kalam.slot) updateKalam(category, kalam.id, (k) => ({ ...k, slot }));
      persistDefaults({ ...defaults, [slot]: { category, name: kalam.name, blocks: cloneBlocks(kalam.blocks) } });
    },
    [defaults, persistDefaults, updateKalam],
  );

  const unpin = useCallback(
    (slot: string) => {
      const next = { ...defaults };
      delete next[slot];
      persistDefaults(next);
    },
    [defaults, persistDefaults],
  );

  /** After a crop/erase, every copy of that screenshot (here and in defaults) takes the new version. */
  const replaceMedia = useCallback(
    (m: MediaMeta) => {
      const patch = (b: Block): Block =>
        b.kind === 'image' && b.mediaId === m.id ? { ...b, rev: m.rev, width: m.width, height: m.height, bands: m.bands, lineHeight: m.lineHeight } : b;
      setDoc((d) => ({
        ...d,
        kalams: Object.fromEntries(Object.entries(d.kalams).map(([c, ks]) => [c, ks.map((k) => ({ ...k, blocks: k.blocks.map(patch) }))])) as Booklet['kalams'],
      }));
      const touched = Object.values(defaults).some((v) => v.blocks.some((b) => b.kind === 'image' && b.mediaId === m.id));
      if (touched) {
        persistDefaults(Object.fromEntries(Object.entries(defaults).map(([s, v]) => [s, { ...v, blocks: v.blocks.map(patch) }])));
      }
    },
    [defaults, persistDefaults, setDoc],
  );

  const reset = useCallback(
    (venue: Venue) => setDoc((d) => createBooklet(d.date, venue, defaults, matam.current)),
    [defaults, setDoc],
  );

  return { doc, setDoc, defaults, saved, undo, redo, updateKalams, updateKalam, pin, unpin, replaceMedia, reset };
}

export type BookletState = ReturnType<typeof useBooklet>;
