// Working-booklet state: load, autosave (debounced), undo/redo, and pinned defaults.
//
// Only a change made here is ever saved: opening the booklet, or taking in a
// copy another device saved, saves nothing (each would otherwise count as a
// newer copy and make every other open device reload). Every change is kept
// in this browser at once, marked unsaved until a save goes through; a save
// that fails is tried again, so nothing typed is lost to a closed tab or a
// dropped connection (src/editor/sync.ts decides which copy opens).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TextEdits } from '../booklet/Editable';
import {
  BUILTIN_MEDIA,
  Block,
  BoxAnchor,
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
  blockGeometry,
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
import { anchorBoxes } from '../booklet/paginate';
import { api, type StorageState } from './api';
import { cityKey, loadBookletCopy, loadDefaultsBackup, readBackup, saveBackup, saveBookletCopy } from './cache';
import { chooseCopy, retryDelay, sessionDate } from './sync';

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const HISTORY = 60;
const imageGeometry = blockGeometry;

const mapKalams = (d: Booklet, fn: (k: Kalam) => Kalam): Booklet => ({
  ...d,
  kalams: Object.fromEntries(Object.entries(d.kalams).map(([c, ks]) => [c, ks.map(fn)])) as Booklet['kalams'],
});
const blocksOf = (d: Booklet | undefined | null) => Object.values(d?.kalams ?? {}).flatMap((ks) => ks.flatMap((k) => k.blocks));

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

/** Screenshot details as the server has them now (a newer cleaner may have
 * cleaned one again since); a screenshot the server lost is handed back
 * from this browser's copy. Library verses are followed separately. */
async function currentMedia(blocks: Block[]) {
  const ids = [...new Set(blocks.flatMap((b) => (b.kind === 'image' && !isLibraryMedia(b.mediaId) ? [b.mediaId] : [])))];
  return new Map(await Promise.all(ids.map(async (id) => {
    let meta: MediaMeta | null = await api.media(id);
    const block = blocks.find((b) => b.kind === 'image' && b.mediaId === id);
    if (!meta && block?.kind === 'image') meta = await api.recover(block).catch(() => null);
    return [id, meta] as const;
  })));
}
const refreshWith = (media: Map<string, MediaMeta | null>) => (blocks: Block[]) => blocks.map((b): Block => {
  if (b.kind !== 'image' || isLibraryMedia(b.mediaId)) return b;
  const meta = media.get(b.mediaId);
  return meta ? { ...b, ...imageGeometry(meta) } : { ...b, warnings: ['The original screenshot is missing. Please add it again.'] };
});

const replaceLine = (text: string, i: number, line: string) => text.split('\n').map((l, j) => (j === i ? line : l)).join('\n');

/** The "Saved" label: `retrying` after a save failed (it is tried again),
 * `pending`/`failing`: the server's copy to durable storage (server/durable.ts). */
export interface SaveStatus extends StorageState { state: 'saved' | 'saving' | 'retrying'; error?: string }

export function useBooklet(city: City) {
  const [doc, setDocState] = useState<Booklet | null>(null);
  // Your pins (and unpinned built-ins); `defaults` below is what new booklets get.
  const [own, setOwn] = useState<Defaults>({});
  const [builtin, setBuiltin] = useState<Defaults>({});
  const defaults = useMemo(() => effectiveDefaults(builtin, own), [builtin, own]);
  const [status, setStatus] = useState<SaveStatus>({ state: 'saved', pending: 0, failing: false });
  const [loadError, setLoadError] = useState('');
  const past = useRef<Booklet[]>([]);
  const future = useRef<Booklet[]>([]);
  // Stamps of the server copies this editor's booklet and defaults replace
  // (server/index.ts).
  const docAt = useRef(0);
  const defsAt = useRef(0);
  const defsSaves = useRef<Promise<unknown>>(Promise.resolve());
  // History is kept outside React's updaters (which may run twice in dev).
  const current = useRef<Booklet | null>(null);
  current.current = doc;
  const builtinRef = useRef(builtin);
  builtinRef.current = builtin;
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  // A change made here that no save has confirmed yet.
  const dirty = useRef(false);
  const saving = useRef(false);
  const again = useRef(false);
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  /** Show a booklet that is not a change made here (loaded, or saved on
   * another device): nothing is saved, and undo starts over. */
  const show = useCallback((next: Booklet) => {
    past.current = [];
    future.current = [];
    current.current = next;
    setDocState(next);
  }, []);

  /** A stored booklet as the editor shows it: brought to the current version,
   * its screenshots' details refreshed, its text boxes anchored, on this
   * session's date. Library verses made again since follow in the background. */
  const finish = (d: Booklet, refresh: (blocks: Block[]) => Block[]): Booklet =>
    anchorBoxes({ ...mapKalams(d, (k) => ({ ...k, blocks: refresh(k.blocks) })), date: sessionDate(d.date, todayIso()) });
  const followLibrary = useCallback(async (blocks: Block[]) => {
    const ids = [...new Set(blocks.flatMap((b) => (b.kind === 'image' && isLibraryMedia(b.mediaId) ? [b.mediaId] : [])))];
    for (const id of ids) {
      const meta = await api.libraryMedia(id).catch(() => null);
      const block = blocks.find((b) => b.kind === 'image' && b.mediaId === id);
      if (!meta || (block?.kind === 'image' && block.rev === meta.rev)) continue;
      // Made again by a newer build: follow its files (not a change made here).
      const patch = (b: Block): Block => (b.kind === 'image' && b.mediaId === id ? { ...b, ...imageGeometry(meta) } : b);
      const d = current.current;
      if (!d) continue;
      const next = mapKalams(d, (k) => ({ ...k, blocks: k.blocks.map(patch) }));
      current.current = next;
      setDocState(next);
    }
  }, []);

  /** Take in the server's copy (saved on another device), in place. */
  const adopt = useCallback(async (value: Booklet, savedAt: number) => {
    dirty.current = false;
    docAt.current = savedAt;
    await saveBookletCopy(city, { doc: value, basedOn: savedAt, dirty: false });
    if (value.version !== 2 && value.version !== 3) return;
    const upgraded = upgradeBooklet(value, defaultsRef.current, builtinRef.current).doc;
    const blocks = blocksOf(upgraded);
    show(finish(upgraded, refreshWith(await currentMedia(blocks))));
    setStatus((s) => ({ ...s, state: 'saved', error: undefined }));
    void followLibrary(blocks);
  }, [city, show, followLibrary]);

  // ---- saving ----
  /** Save the booklet as it is now, if it holds a change no save has
   * confirmed. One save at a time; a failed one is tried again with growing
   * pauses, and whenever the page comes back online or into view. */
  const flush = useCallback(async (): Promise<void> => {
    clearTimeout(timer.current);
    const d = current.current;
    if (!dirty.current || !d) return;
    if (saving.current) { again.current = true; return; }
    saving.current = true;
    setStatus((s) => (s.state === 'retrying' ? s : { ...s, state: 'saving' }));
    try {
      let result = await api.saveBooklet(d, docAt.current);
      if (!result.ok) {
        // Another device saved changes since this one's copy: a real conflict.
        if (!confirm('This booklet was changed on another device. Keep the version on this screen? (Cancel opens the other device\'s version.)')) {
          const remote = await api.loadBooklet(city);
          if (remote.value) return void (await adopt(remote.value, remote.savedAt));
        }
        result = await api.saveBooklet(d, result.savedAt);
        if (!result.ok) throw new Error('The booklet was changed on another device again.');
      }
      failures.current = 0;
      docAt.current = result.savedAt;
      // Changed again while saving: still unsaved, now over the new copy.
      const done = current.current === d;
      if (done) dirty.current = false;
      await saveBookletCopy(city, { basedOn: result.savedAt, dirty: !done || dirty.current });
      setStatus({ state: dirty.current ? 'saving' : 'saved', ...result.storage });
      if (dirty.current) again.current = true;
    } catch (error) {
      failures.current++;
      console.warn('Saving the booklet failed; trying again:', error);
      setStatus((s) => ({ ...s, state: 'retrying', error: (error as Error).message }));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), retryDelay(failures.current));
    } finally {
      saving.current = false;
      if (again.current) {
        again.current = false;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void flush(), 500);
      }
    }
  }, [city, adopt]);

  /** A change made here: kept in this browser at once (marked unsaved), and
   * saved half a second after the last one. */
  const changed = useCallback((next: Booklet) => {
    current.current = next;
    setDocState(next);
    dirty.current = true;
    void saveBookletCopy(city, { doc: next, basedOn: docAt.current, dirty: true });
    setStatus((s) => (s.state === 'retrying' ? s : { ...s, state: 'saving' }));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 500);
  }, [city, flush]);

  // Unsaved changes go when the page goes: at once when it is hidden or
  // closed (a phone switching apps), when the connection returns, and when
  // the editor closes (switching city). A page being closed can only send a
  // small booklet; a larger one stays marked unsaved in this browser and is
  // saved when the booklet next opens.
  useEffect(() => {
    const online = () => void flush();
    const hidden = () => { if (document.visibilityState === 'hidden') void flush(); };
    const leaving = () => {
      const d = current.current;
      if (dirty.current && d && !saving.current) void api.saveBooklet(d, docAt.current, false, true).catch(() => undefined);
    };
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leaving);
    return () => {
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leaving);
      clearTimeout(timer.current);
      void flush();
    };
  }, [flush]);

  // ---- loading ----
  useEffect(() => {
    let alive = true;
    (async () => {
      const [remoteDoc, remoteDefs, builtinMedia, localDoc, localDefs, localDefsAt = 0] = await Promise.all([
        api.loadBooklet(city),
        api.loadDefaultsStamped(city),
        Promise.all(BUILTIN_MEDIA[city].map(async (id) => [id, await api.media(id)] as const)),
        loadBookletCopy(city),
        loadDefaultsBackup(city),
        readBackup<number>(cityKey('defaults-at', city)),
      ]);
      // Defaults: the newest copy wins; this device's goes back to a server
      // that lost its own (one without durable storage).
      const remoteDefsValue = remoteDefs.value ?? {};
      const defsLocal = !!localDefs && Object.keys(localDefs).length > 0 && (localDefsAt > remoteDefs.savedAt || (!remoteDefs.savedAt && !Object.keys(remoteDefsValue).length));
      const ownDefs = defsLocal ? localDefs : remoteDefsValue;
      defsAt.current = defsLocal ? localDefsAt : remoteDefs.savedAt;
      if (defsLocal) {
        const restored = await api.saveDefaults(ownDefs, city, localDefsAt, localDefsAt > 0);
        if (restored.ok) defsAt.current = restored.savedAt;
      } else await Promise.all([saveBackup(cityKey('defaults', city), ownDefs), saveBackup(cityKey('defaults-at', city), defsAt.current)]);

      // The booklet: which copy opens (src/editor/sync.ts).
      const choice = chooseCopy(localDoc, remoteDoc);
      let kept: Booklet | null = null;
      let unsaved = false;
      if (choice.use === 'ask') {
        const keepMine = confirm('This device has changes to the booklet that were never saved, but the booklet was changed on another device since.\n\nOK keeps this device\'s version (it replaces the other one). Cancel opens the other device\'s version.');
        if (keepMine) { kept = localDoc!.value; docAt.current = remoteDoc.savedAt; unsaved = true; }
        else { kept = remoteDoc.value; docAt.current = remoteDoc.savedAt; await saveBookletCopy(city, { doc: remoteDoc.value!, basedOn: remoteDoc.savedAt, dirty: false }); }
      } else if (choice.use === 'local') {
        kept = localDoc!.value;
        if (choice.save === 'restore') {
          // Handed back under its own stamp, to a server that lost it.
          docAt.current = localDoc!.basedOn;
          const restored = await api.saveBooklet(kept, localDoc!.basedOn, true).catch(() => null);
          if (restored?.ok) docAt.current = restored.savedAt;
          else unsaved = true;
        } else {
          docAt.current = remoteDoc.savedAt;
          unsaved = true;
        }
      } else if (choice.use === 'remote') {
        kept = remoteDoc.value;
        docAt.current = remoteDoc.savedAt;
        await saveBookletCopy(city, { doc: remoteDoc.value!, basedOn: remoteDoc.savedAt, dirty: false });
      } else docAt.current = remoteDoc.savedAt;
      setStatus({ state: 'saved', ...remoteDoc.storage });

      const copied = await withKarbalaPins(city, ownDefs, defsAt.current);
      if (copied) defsAt.current = copied.savedAt;
      let defs = copied?.merged ?? ownDefs;
      // A booklet with nothing added yet starts over with the copied pins in it
      // (and is saved, since the copy happens only once).
      const restart = !!(copied && kept && untouched(kept));
      if (restart) unsaved = true;
      const stored = kept && cityOf(kept.venue) === city && !restart ? kept : null;
      const builtinDefs = builtinDefaults(city, Object.fromEntries(builtinMedia));
      // An older booklet's fixed content becomes default content it owns.
      const upgraded = stored && (stored.version === 2 || stored.version === 3) ? upgradeBooklet(stored, effectiveDefaults(builtinDefs, defs), builtinDefs) : null;
      if (upgraded && Object.keys(upgraded.pins).length) defs = { ...defs, ...upgraded.pins };
      const allBlocks = [...blocksOf(upgraded?.doc), ...Object.values(defs).flatMap((d) => d.blocks)];
      const refresh = refreshWith(await currentMedia(allBlocks));
      const refreshedDefaults = Object.fromEntries(Object.entries(defs).map(([key, value]) => [key, { ...value, blocks: refresh(value.blocks) }]));
      if (!alive) return;
      setBuiltin(builtinDefs);
      setOwn(refreshedDefaults);
      if (JSON.stringify(ownDefs) !== JSON.stringify(refreshedDefaults)) {
        const saved = await api.saveDefaults(refreshedDefaults, city, defsAt.current);
        if (saved.ok) defsAt.current = saved.savedAt;
      }
      let shown: Booklet;
      if (upgraded) shown = finish(upgraded.doc, refresh);
      else {
        const fresh = createBooklet(todayIso(), CITIES[city].venues[0], effectiveDefaults(builtinDefs, refreshedDefaults));
        shown = copied && kept?.overrides ? { ...fresh, overrides: kept.overrides } : fresh;
      }
      if (!alive) return;
      show(shown);
      if (unsaved) {
        // This device's unsaved changes (or the one-time restart) go now.
        dirty.current = true;
        await saveBookletCopy(city, { doc: shown, basedOn: docAt.current, dirty: true });
        void flush();
      }
      void followLibrary(allBlocks);
    })().catch((error: Error) => setLoadError(error.message));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city]);

  // Changes saved from another device reach this one while it is open:
  // checked when the app comes back into view and every minute. Newer
  // defaults are taken at once; a newer booklet is taken in place when
  // nothing changed here is waiting to be saved.
  useEffect(() => {
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState !== 'visible' || !current.current) return;
      busy = true;
      try {
        if (dirty.current && !saving.current) void flush();
        const [defs, booklet] = await Promise.all([api.loadDefaultsStamped(city), api.loadBooklet(city)]);
        if (defs.savedAt > defsAt.current) {
          defsAt.current = defs.savedAt;
          setOwn(defs.value ?? {});
          await Promise.all([saveBackup(cityKey('defaults', city), defs.value ?? {}), saveBackup(cityKey('defaults-at', city), defs.savedAt)]);
        }
        if (booklet.value && booklet.savedAt > docAt.current && !dirty.current && !saving.current) await adopt(booklet.value, booklet.savedAt);
        setStatus((s) => ({ ...s, ...booklet.storage }));
      } catch { /* offline, or storage not reachable: next time */ } finally { busy = false; }
    };
    document.addEventListener('visibilitychange', check);
    const t = setInterval(check, 60_000);
    return () => { document.removeEventListener('visibilitychange', check); clearInterval(t); };
  }, [city, adopt, flush]);

  const setDoc = useCallback((fn: (d: Booklet) => Booklet) => {
    const d = current.current;
    if (!d) return;
    const next = fn(d);
    if (next === d) return;
    past.current = [...past.current.slice(-HISTORY + 1), d];
    future.current = [];
    changed(next);
  }, [changed]);

  const undo = useCallback(() => {
    const d = current.current;
    const prev = past.current.pop();
    if (!d || !prev) return;
    future.current.push(d);
    changed(prev);
  }, [changed]);

  const redo = useCallback(() => {
    const d = current.current;
    const next = future.current.pop();
    if (!d || !next) return;
    past.current.push(d);
    changed(next);
  }, [changed]);

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

  /** A new, empty text box centred on (x, y) of `page`; it opens for typing.
   * `place` says what it belongs to (paginate.ts anchorAt), and turns the
   * box's top into the y it keeps. */
  const addTextBox = useCallback(
    (page: number, x: number, y: number, place: (top: number) => { anchor?: BoxAnchor; y: number } = (top) => ({ y: top })) => {
      const sizePt = 24;
      const at = place(Math.max(0, Math.round(y - sizePt * 0.8)));
      const box = { id: uid(), page, x, y: at.y, ...(at.anchor ? { anchor: at.anchor } : {}), text: '', sizePt, color: TEXT_COLORS[city][1] };
      setDoc((d) => ({ ...d, textBoxes: [...(d.textBoxes ?? []), box] }));
    },
    [city, setDoc],
  );

  return { doc, loadError, setDoc, defaults, builtin, status, undo, redo, updateKalams, updateKalam, pin, unpin, restoreDefault, moveSection, replaceMedia, reset, textEdits, addTextBox };
}

export type BookletState = ReturnType<typeof useBooklet>;
