// Working-booklet state: load, autosave (debounced), undo/redo, and pinned defaults.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TextEdits } from '../booklet/Editable';
import {
  BUILTIN_MEDIA,
  Block,
  Booklet,
  CITIES,
  CITY_SLOTS,
  Category,
  City,
  Defaults,
  Kalam,
  MediaMeta,
  TEXT_COLORS,
  Venue,
  builtinDefaults,
  cityOf,
  cloneBlocks,
  createBooklet,
  defaultPosition,
  effectiveDefaults,
  isBuiltinMedia,
  isLibraryMedia,
  kalamFrom,
  moveCategory,
  templateOverrides,
  uid,
  upgradeBooklet,
} from '../booklet/model';
import { api } from './api';
import { cityKey, loadBookletBackup, loadDefaultsBackup, readBackup, saveBackup, saveBookletBackup } from './cache';

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const HISTORY = 60;
const imageGeometry = (m: MediaMeta) => ({ mediaId: m.id, rev: m.rev, width: m.width, height: m.height, bands: m.bands, lineHeight: m.lineHeight, regions: m.regions, opening: m.opening, openingImage: m.openingImage, format: m.format, suggestedName: m.suggestedName, warnings: m.warnings, continues: m.continues });

const mapKalams = (d: Booklet, fn: (k: Kalam) => Kalam): Booklet => ({
  ...d,
  kalams: Object.fromEntries(Object.entries(d.kalams).map(([c, ks]) => [c, ks.map(fn)])) as Booklet['kalams'],
});

/** Only default content: nothing added to the booklet yet. */
const untouched = (d: Booklet) =>
  !d.textBoxes?.length &&
  Object.values(d.kalams).every((ks) => ks.every((k) => k.fixed === 'all' || k.blocks.every((b) => (b.kind === 'image' ? isBuiltinMedia(b.mediaId) : k.slot === 'salamArz'))));

/** Same printed content (pins compare this way, whatever the block ids). */
export const sameBlocks = (a: Block[], b: Block[]) =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i];
    if (x.kind !== y.kind) return false;
    if (x.kind === 'image' && y.kind === 'image') return x.mediaId === y.mediaId && x.rev === y.rev && x.scale === y.scale;
    return x.kind === 'text' && y.kind === 'text' && x.text === y.text;
  });

/**
 * Najaf starts with Karbala's pinned kalams, copied once (its own pins win
 * over Karbala's). The copy is marked in the browser, so unpinning one in
 * Najaf later does not bring it back.
 */
async function withKarbalaPins(city: City, own: Defaults, basedOn: number): Promise<{ merged: Defaults; savedAt: number } | null> {
  const marker = cityKey('pins-copied', city);
  if (city === 'karbala' || (await readBackup(marker))) return null;
  const [remote, local] = await Promise.all([api.loadDefaults('karbala'), loadDefaultsBackup('karbala')]);
  const karbala = Object.keys(remote).length ? remote : local ?? {};
  // Nothing pinned in Karbala (on this device) yet: try again next time.
  if (!Object.keys(karbala).length) return null;
  // Karbala's Matam, Dua and Salam Arz are its own; Najaf has its defaults.
  const shared = Object.fromEntries(Object.entries(karbala).filter(([slot, d]) => !d.off && !CITY_SLOTS.includes(slot)));
  const merged = { ...shared, ...own };
  const saved = await api.saveDefaults(merged, city, basedOn);
  if (!saved.ok) return null;
  await saveBackup(marker, true);
  return { merged, savedAt: saved.savedAt };
}

const replaceLine = (text: string, i: number, line: string) => text.split('\n').map((l, j) => (j === i ? line : l)).join('\n');

export function useBooklet(city: City) {
  const [doc, setDocState] = useState<Booklet | null>(null);
  // Your pins (and unpinned built-ins); `defaults` below is what new booklets get.
  const [own, setOwn] = useState<Defaults>({});
  const [builtin, setBuiltin] = useState<Defaults>({});
  const defaults = useMemo(() => effectiveDefaults(builtin, own), [builtin, own]);
  const [saved, setSaved] = useState(true);
  const [loadError, setLoadError] = useState('');
  const past = useRef<Booklet[]>([]);
  const future = useRef<Booklet[]>([]);
  // Stamps of the server copies this editor's booklet and defaults replace
  // (server/index.ts). Saves go one at a time, each over the last one's stamp.
  const docAt = useRef(0);
  const defsAt = useRef(0);
  const docSaves = useRef<Promise<unknown>>(Promise.resolve());
  const docInFlight = useRef(0);
  const defsSaves = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    (async () => {
      const [remoteDoc, remoteDefs, builtinMedia, localDoc, localDefs, localDocAt = 0, localDefsAt = 0] = await Promise.all([
        api.loadBooklet(city),
        api.loadDefaultsStamped(city),
        Promise.all(BUILTIN_MEDIA[city].map(async (id) => [id, await api.media(id)] as const)),
        loadBookletBackup(city),
        loadDefaultsBackup(city),
        readBackup<number>(cityKey('booklet-at', city)),
        readBackup<number>(cityKey('defaults-at', city)),
      ]);
      // The newest copy wins: this device's, when the server lost its own (a
      // restart on a free host) or holds an older one; else the server's,
      // which another device may have changed since this one last opened.
      const docLocal = !!localDoc && (localDocAt > remoteDoc.savedAt || !remoteDoc.value);
      const kept = docLocal ? localDoc : remoteDoc.value;
      docAt.current = docLocal ? localDocAt : remoteDoc.savedAt;
      const remoteDefsValue = remoteDefs.value ?? {};
      const defsLocal = !!localDefs && Object.keys(localDefs).length > 0 && (localDefsAt > remoteDefs.savedAt || (!remoteDefs.savedAt && !Object.keys(remoteDefsValue).length));
      const ownDefs = defsLocal ? localDefs : remoteDefsValue;
      defsAt.current = defsLocal ? localDefsAt : remoteDefs.savedAt;
      if (defsLocal) {
        // Hand the server back this device's newer copy, under its own stamp.
        const restored = await api.saveDefaults(ownDefs, city, localDefsAt, localDefsAt > 0);
        if (restored.ok) defsAt.current = restored.savedAt;
      } else await Promise.all([saveBackup(cityKey('defaults', city), ownDefs), saveBackup(cityKey('defaults-at', city), defsAt.current)]);
      if (docLocal && localDocAt > 0) {
        const restored = await api.saveBooklet(localDoc, localDocAt, true).catch(() => null);
        if (restored?.ok) docAt.current = restored.savedAt;
      }
      const copied = await withKarbalaPins(city, ownDefs, defsAt.current);
      if (copied) defsAt.current = copied.savedAt;
      let defs = copied?.merged ?? ownDefs;
      // A booklet with nothing added yet starts over with the copied pins in it.
      const stored = kept && cityOf(kept.venue) === city && !(copied && untouched(kept)) ? kept : null;
      const builtinDefs = builtinDefaults(city, Object.fromEntries(builtinMedia));
      setBuiltin(builtinDefs);
      // An older booklet's fixed content becomes default content it owns.
      const upgraded = stored && (stored.version === 2 || stored.version === 3) ? upgradeBooklet(stored, effectiveDefaults(builtinDefs, defs), builtinDefs) : null;
      if (upgraded && Object.keys(upgraded.pins).length) defs = { ...defs, ...upgraded.pins };
      const docBlocks = Object.values(upgraded?.doc.kalams ?? {}).flatMap((ks) => ks.flatMap((k) => k.blocks));
      const allBlocks = [...docBlocks, ...Object.values(defs).flatMap((d) => d.blocks)];
      const ids = new Set(allBlocks.flatMap((b) => (b.kind === 'image' ? [b.mediaId] : [])));
      // Library verses are made again from the PDF when a page asks for them:
      // they are checked in the background instead of holding up the editor.
      const libraryIds = [...ids].filter(isLibraryMedia);
      const media = new Map((await Promise.all([...ids].filter((id) => !isLibraryMedia(id)).map(async (id) => {
        let meta: MediaMeta | null = await api.media(id);
        const block = allBlocks.find((b) => b.kind === 'image' && b.mediaId === id);
        if (!meta && block?.kind === 'image') meta = await api.recover(block).catch(() => null);
        return [id, meta] as const;
      }))));
      const refresh = (blocks: Block[]) => blocks.map((b): Block => {
        if (b.kind !== 'image') return b;
        if (isLibraryMedia(b.mediaId)) return b;
        const meta = media.get(b.mediaId);
        return meta ? { ...b, ...imageGeometry(meta) } : { ...b, warnings: ['The original screenshot is missing. Please add it again.'] };
      });
      const refreshedDefaults = Object.fromEntries(Object.entries(defs).map(([key, value]) => [key, { ...value, blocks: refresh(value.blocks) }]));
      setOwn(refreshedDefaults);
      if (JSON.stringify(ownDefs) !== JSON.stringify(refreshedDefaults)) {
        const saved = await api.saveDefaults(refreshedDefaults, city, defsAt.current);
        if (saved.ok) defsAt.current = saved.savedAt;
      }
      // Each session starts on today's date; content carries over from last time.
      if (upgraded) {
        setDocState({ ...mapKalams(upgraded.doc, (k) => ({ ...k, blocks: refresh(k.blocks) })), date: todayIso() });
      } else {
        const fresh = createBooklet(todayIso(), CITIES[city].venues[0], effectiveDefaults(builtinDefs, refreshedDefaults));
        setDocState(copied && kept?.overrides ? { ...fresh, overrides: kept.overrides } : fresh);
      }
      for (const id of libraryIds) {
        const meta = await api.libraryMedia(id).catch(() => null);
        const block = allBlocks.find((b) => b.kind === 'image' && b.mediaId === id);
        if (!meta || (block?.kind === 'image' && block.rev === meta.rev)) continue;
        // Cleaned again by a newer cleaner: follow its files.
        const patch = (b: Block): Block => (b.kind === 'image' && b.mediaId === id ? { ...b, ...imageGeometry(meta) } : b);
        setDocState((d) => (d ? mapKalams(d, (k) => ({ ...k, blocks: k.blocks.map(patch) })) : d));
      }
    })().catch((error: Error) => setLoadError(error.message));
  }, [city]);

  // Autosave half a second after the last change. A change still waiting
  // when the editor closes (switching city) is saved straight away.
  const unsaved = useRef<Booklet | null>(null);
  const saveDoc = useCallback((d: Booklet) => {
    docInFlight.current++;
    const job = docSaves.current.catch(() => undefined).then(async () => {
      let result = await api.saveBooklet(d, docAt.current);
      // Changed on another device since this one loaded it.
      if (!result.ok && confirm('This booklet was changed on another device. Keep the version on this screen? (Cancel loads the other device\'s version.)')) {
        result = await api.saveBooklet(d, result.savedAt);
      } else if (!result.ok) {
        location.reload();
        return false;
      }
      docAt.current = result.savedAt;
      await saveBackup(cityKey('booklet-at', city), result.savedAt);
      return result.ok;
    });
    docSaves.current = job;
    void job.finally(() => { docInFlight.current--; }).catch(() => undefined);
    return job;
  }, [city]);
  useEffect(() => {
    if (!doc) return;
    setSaved(false);
    unsaved.current = doc;
    void saveBookletBackup(doc);
    const t = setTimeout(() => {
      if (unsaved.current === doc) unsaved.current = null;
      saveDoc(doc).then((ok) => { if (ok) setSaved(true); }).catch(console.error);
    }, 500);
    return () => clearTimeout(t);
  }, [doc, saveDoc]);
  useEffect(() => () => {
    if (unsaved.current) void saveDoc(unsaved.current).catch(console.error);
  }, [saveDoc]);

  // Changes saved from another device reach this one while it is open:
  // checked when the app comes back into view and every minute. Newer
  // defaults are taken at once; a newer booklet is loaded when nothing typed
  // here is still waiting to be saved.
  useEffect(() => {
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState !== 'visible' || !current.current) return;
      busy = true;
      try {
        const [defs, booklet] = await Promise.all([api.loadDefaultsStamped(city), api.loadBooklet(city)]);
        if (defs.savedAt > defsAt.current) {
          defsAt.current = defs.savedAt;
          setOwn(defs.value ?? {});
          await Promise.all([saveBackup(cityKey('defaults', city), defs.value ?? {}), saveBackup(cityKey('defaults-at', city), defs.savedAt)]);
        }
        if (booklet.value && booklet.savedAt > docAt.current && !unsaved.current && !docInFlight.current) {
          await Promise.all([saveBackup(cityKey('booklet', city), booklet.value), saveBackup(cityKey('booklet-at', city), booklet.savedAt)]);
          location.reload();
        }
      } catch { /* offline: next time */ } finally { busy = false; }
    };
    document.addEventListener('visibilitychange', check);
    const timer = setInterval(check, 60_000);
    return () => { document.removeEventListener('visibilitychange', check); clearInterval(timer); };
  }, [city]);

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
    setOwn(next);
    defsSaves.current = defsSaves.current.catch(() => undefined).then(async () => {
      const saved = await api.saveDefaults(next, city, defsAt.current);
      if (saved.ok) { defsAt.current = saved.savedAt; return; }
      // Another device pinned since: take its defaults, then ask to pin again.
      const remote = await api.loadDefaultsStamped(city);
      defsAt.current = remote.savedAt;
      setOwn(remote.value ?? {});
      await Promise.all([saveBackup(cityKey('defaults', city), remote.value ?? {}), saveBackup(cityKey('defaults-at', city), remote.savedAt)]);
      alert('Your defaults were changed on another device, so this screen now shows those. Pin or unpin again if needed.');
    }).catch(console.error);
  }, [city]);

  /** ★: this kalam as it is now fills its slot in new booklets. Pinning a
   * built-in default back to its original content just drops your copy. */
  const pin = useCallback(
    (category: Category, kalam: Kalam) => {
      const slot = kalam.slot ?? `${category}:x${kalam.id}`;
      if (!kalam.slot) updateKalam(category, kalam.id, (k) => ({ ...k, slot }));
      const next = { ...own };
      const base = builtin[slot];
      if (base && base.name === kalam.name && sameBlocks(base.blocks, kalam.blocks)) delete next[slot];
      else next[slot] = { category, name: kalam.name, blocks: cloneBlocks(kalam.blocks) };
      persistDefaults(next);
    },
    [builtin, own, persistDefaults, updateKalam],
  );

  /** Unpinning a built-in default keeps it out of new booklets until pinned again. */
  const unpin = useCallback(
    (slot: string) => {
      const next = { ...own };
      const base = builtin[slot];
      if (base) next[slot] = { category: base.category, name: base.name, blocks: [], off: true };
      else delete next[slot];
      persistDefaults(next);
    },
    [builtin, own, persistDefaults],
  );

  /** Put a removed default kalam back: your pinned version, else the built-in one. */
  const restoreDefault = useCallback(
    (slot: string) => {
      const d = defaults[slot] ?? builtin[slot];
      if (!d) return;
      updateKalams(d.category, (ks) => {
        const i = defaultPosition(ks, slot);
        return [...ks.slice(0, i), kalamFrom(slot, d), ...ks.slice(i)];
      });
    },
    [builtin, defaults, updateKalams],
  );

  const moveSection = useCallback((category: Category, dir: -1 | 1) => setDoc((d) => moveCategory(d, category, dir)), [setDoc]);

  /** After a crop/erase, every copy of that screenshot (here and in defaults) takes the new version. */
  const replaceMedia = useCallback(
    (m: MediaMeta, originalId = m.id) => {
      const patch = (b: Block): Block =>
        b.kind === 'image' && b.mediaId === originalId ? { ...b, ...imageGeometry(m) } : b;
      setDoc((d) => mapKalams(d, (k) => ({ ...k, blocks: k.blocks.map(patch) })));
      const touched = Object.values(own).some((v) => v.blocks.some((b) => b.kind === 'image' && b.mediaId === originalId));
      if (touched) {
        persistDefaults(Object.fromEntries(Object.entries(own).map(([s, v]) => [s, { ...v, blocks: v.blocks.map(patch) }])));
      }
    },
    [own, persistDefaults, setDoc],
  );

  // The section order is kept like the cover and fihrist wording.
  const reset = useCallback(
    (venue: Venue) => setDoc((d) => ({ ...createBooklet(d.date, venue, defaults), overrides: templateOverrides(d.overrides), order: d.order })),
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
      const box = { id: uid(), page, x, y: Math.max(0, Math.round(y - sizePt * 0.8)), text: '', sizePt, color: TEXT_COLORS[city][1] };
      setDoc((d) => ({ ...d, textBoxes: [...(d.textBoxes ?? []), box] }));
    },
    [city, setDoc],
  );

  return { doc, loadError, setDoc, defaults, builtin, saved, undo, redo, updateKalams, updateKalam, pin, unpin, restoreDefault, moveSection, replaceMedia, reset, textEdits, addTextBox };
}

export type BookletState = ReturnType<typeof useBooklet>;
