// Working-booklet state: load, autosave (debounced), undo/redo, and pinned defaults.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TextEdits } from '../booklet/Editable';
import {
  Block,
  Booklet,
  Category,
  Defaults,
  Kalam,
  MATAM_MEDIA_ID,
  MediaMeta,
  TEXT_COLORS,
  Venue,
  cloneBlocks,
  createBooklet,
  templateOverrides,
  uid,
} from '../booklet/model';
import { api } from './api';
import { loadBookletBackup, loadDefaultsBackup, saveBookletBackup } from './cache';

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const HISTORY = 60;
const imageGeometry = (m: MediaMeta) => ({ mediaId: m.id, rev: m.rev, width: m.width, height: m.height, bands: m.bands, lineHeight: m.lineHeight, regions: m.regions, opening: m.opening, openingImage: m.openingImage, format: m.format, suggestedName: m.suggestedName, warnings: m.warnings });

const mapKalams = (d: Booklet, fn: (k: Kalam) => Kalam): Booklet => ({
  ...d,
  kalams: Object.fromEntries(Object.entries(d.kalams).map(([c, ks]) => [c, ks.map(fn)])) as Booklet['kalams'],
});

const replaceLine = (text: string, i: number, line: string) => text.split('\n').map((l, j) => (j === i ? line : l)).join('\n');

export function useBooklet() {
  const [doc, setDocState] = useState<Booklet | null>(null);
  const [defaults, setDefaults] = useState<Defaults>({});
  const [saved, setSaved] = useState(true);
  const [loadError, setLoadError] = useState('');
  const past = useRef<Booklet[]>([]);
  const future = useRef<Booklet[]>([]);
  const matam = useRef<MediaMeta | null>(null);

  useEffect(() => {
    (async () => {
      const [remoteDoc, remoteDefs, m, localDoc, localDefs] = await Promise.all([api.loadBooklet(), api.loadDefaults(), api.media(MATAM_MEDIA_ID), loadBookletBackup(), loadDefaultsBackup()]);
      const stored = remoteDoc ?? localDoc;
      const defs = Object.keys(remoteDefs).length ? remoteDefs : localDefs ?? remoteDefs;
      matam.current = m;
      const ids = new Set(Object.values(stored?.kalams ?? {}).flatMap((ks) => ks.flatMap((k) => k.blocks.filter((b) => b.kind === 'image').map((b) => b.mediaId))));
      Object.values(defs).forEach((v) => v.blocks.forEach((b) => { if (b.kind === 'image') ids.add(b.mediaId); }));
      const allBlocks = [...Object.values(stored?.kalams ?? {}).flatMap((ks) => ks.flatMap((k) => k.blocks)), ...Object.values(defs).flatMap((d) => d.blocks)];
      const media = new Map((await Promise.all([...ids].map(async (id) => {
        let meta: MediaMeta | null = await api.media(id);
        const block = allBlocks.find((b) => b.kind === 'image' && b.mediaId === id);
        if (!meta && block?.kind === 'image') meta = await api.recover(block).catch(() => null);
        return [id, meta] as const;
      }))));
      const refresh = (blocks: Block[]) => blocks.map((b): Block => {
        if (b.kind !== 'image') return b;
        const meta = media.get(b.mediaId);
        return meta ? { ...b, ...imageGeometry(meta) } : { ...b, warnings: ['The original screenshot is missing. Please add it again.'] };
      });
      const refreshedDefaults = Object.fromEntries(Object.entries(defs).map(([key, value]) => [key, { ...value, blocks: refresh(value.blocks) }]));
      setDefaults(refreshedDefaults);
      if (JSON.stringify(defs) !== JSON.stringify(refreshedDefaults)) await api.saveDefaults(refreshedDefaults);
      // Each session starts on today's date; content carries over from last time.
      if (stored?.version === 2) {
        // Fixed content always follows the current version on disk.
        const fresh = createBooklet(todayIso(), stored.venue, {}, m);
        const refreshed = mapKalams(stored, (k) => {
          const blocks = refresh(k.blocks);
          return { ...k, blocks };
        });
        setDocState({ ...refreshed, date: todayIso(), kalams: { ...refreshed.kalams, matam: fresh.kalams.matam, salamArz: fresh.kalams.salamArz } });
      } else {
        setDocState(createBooklet(todayIso(), 'haram', refreshedDefaults, m));
      }
    })().catch((error: Error) => setLoadError(error.message));
  }, []);

  // Autosave half a second after the last change.
  useEffect(() => {
    if (!doc) return;
    setSaved(false);
    void saveBookletBackup(doc);
    const t = setTimeout(() => api.saveBooklet(doc).then((r) => { if (r.ok) setSaved(true); }).catch(console.error), 500);
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
    (m: MediaMeta, originalId = m.id) => {
      const patch = (b: Block): Block =>
        b.kind === 'image' && b.mediaId === originalId ? { ...b, ...imageGeometry(m) } : b;
      setDoc((d) => mapKalams(d, (k) => ({ ...k, blocks: k.blocks.map(patch) })));
      const touched = Object.values(defaults).some((v) => v.blocks.some((b) => b.kind === 'image' && b.mediaId === originalId));
      if (touched) {
        persistDefaults(Object.fromEntries(Object.entries(defaults).map(([s, v]) => [s, { ...v, blocks: v.blocks.map(patch) }])));
      }
    },
    [defaults, persistDefaults, setDoc],
  );

  const reset = useCallback(
    (venue: Venue) => setDoc((d) => ({ ...createBooklet(d.date, venue, defaults, matam.current), overrides: templateOverrides(d.overrides) })),
    [defaults, setDoc],
  );

  /** Typing on the pages: edits to generated text and the free text boxes. */
  const textEdits = useMemo<TextEdits>(
    () => ({
      override: (key, from, text, scale) =>
        setDoc((d) => {
          const overrides = { ...d.overrides };
          if (text === from && scale === 1) {
            if (!(key in overrides)) return d;
            delete overrides[key];
          } else overrides[key] = scale === 1 ? { from, text } : { from, text, scale };
          return { ...d, overrides };
        }),
      kalamName: (id, name) => setDoc((d) => mapKalams(d, (k) => (k.id === id ? { ...k, name } : k))),
      textLine: (blockId, line, text) =>
        setDoc((d) =>
          mapKalams(d, (k) =>
            k.blocks.some((b) => b.id === blockId)
              ? { ...k, blocks: k.blocks.map((b) => (b.id === blockId && b.kind === 'text' ? { ...b, text: replaceLine(b.text, line, text) } : b)) }
              : k,
          ),
        ),
      box: (id, patch) =>
        setDoc((d) => {
          const boxes = d.textBoxes ?? [];
          if (!boxes.some((b) => b.id === id)) return d;
          return { ...d, textBoxes: patch ? boxes.map((b) => (b.id === id ? { ...b, ...patch } : b)) : boxes.filter((b) => b.id !== id) };
        }),
    }),
    [setDoc],
  );

  /** A new, empty text box centred on (x, y) of `page`; it opens for typing. */
  const addTextBox = useCallback(
    (page: number, x: number, y: number) => {
      const sizePt = 24;
      const box = { id: uid(), page, x, y: Math.max(0, Math.round(y - sizePt * 0.8)), text: '', sizePt, color: TEXT_COLORS[1] };
      setDoc((d) => ({ ...d, textBoxes: [...(d.textBoxes ?? []), box] }));
    },
    [setDoc],
  );

  return { doc, loadError, setDoc, defaults, saved, undo, redo, updateKalams, updateKalam, pin, unpin, replaceMedia, reset, textEdits, addTextBox };
}

export type BookletState = ReturnType<typeof useBooklet>;
