import { useEffect, useState } from 'react';
import type { LibraryHit } from './library';
import { LibImage } from './LibImage';
import { openZh, previewUrl, supported, useLocalStatus } from '../library/client';

const TOUCH = matchMedia('(pointer: coarse)').matches;

interface Props {
  hit: LibraryHit;
  /** The card already has content, which this replaces. */
  replacing?: boolean;
  onClose: () => void;
  /** Chosen verses in order; null = the whole kalam. */
  onAdd: (verses: number[] | null) => void;
}

/** Any library kalam: see its verses and choose which print.
 * Click a verse to choose it; Shift-click chooses everything in between. */
export function VersePicker({ hit, replacing, onClose, onAdd }: Props) {
  const count = hit.entry.v;
  // Each item is one verse, or a couplet of `per` verses chosen together.
  const per = Math.max(1, hit.entry.c ?? 1);
  const items = Math.ceil(count / per);
  const versesOf = (i: number) => Array.from({ length: Math.min(per, count - i * per) }, (_, j) => i * per + j);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [shown, setShown] = useState(false);
  const local = useLocalStatus();
  // Opening a Zikre Husain kalam makes this device's copy ready (downloading
  // it the first time); until then the server makes the previews.
  useEffect(() => { if (hit.source === 'zh' && supported) openZh().catch(() => undefined); }, [hit.source]);
  // Once previews are made on this device, make the rest in the background
  // (after the ones on screen, which ask first), so scrolling finds them ready.
  const localReady = hit.source !== 'zh' || local.state === 'ready';
  useEffect(() => {
    if (!localReady) return;
    const t = setTimeout(() => {
      for (let i = 0; i < items; i++) void previewUrl(hit.source, hit.n, [i * per, Math.min(count, (i + 1) * per) - 1]).catch(() => undefined);
    }, 50);
    return () => clearTimeout(t);
  }, [localReady, hit.source, hit.n, items, per, count]);

  useEffect(() => {
    const t = requestAnimationFrame(() => setShown(true));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => { cancelAnimationFrame(t); window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const toggle = (i: number, range: boolean) => {
    setChosen((prev) => {
      const next = new Set(prev);
      const set = (item: number, on: boolean) => versesOf(item).forEach((v) => (on ? next.add(v) : next.delete(v)));
      if (range && anchor !== null) {
        const on = !prev.has(i * per) || prev.has(anchor * per);
        for (let item = Math.min(anchor, i); item <= Math.max(anchor, i); item++) set(item, on);
      } else set(i, !next.has(i * per));
      return next;
    });
    setAnchor(i);
  };

  const list = [...chosen].sort((a, b) => a - b);
  return (
    <div className={`verse-backdrop${shown ? ' shown' : ''}`} onMouseDown={onClose}>
      <aside className="verse-sheet" data-local={local.state} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={`Choose verses of ${hit.name}`}>
        <header className="verse-head">
          <div>
            <h2>{hit.name}</h2>
            <small>
              {items} {per > 1 ? 'couplet' : 'verse'}{items === 1 ? '' : 's'} · {TOUCH ? 'tap the verses to print' : 'click to choose, Shift-click for a range'}
              {replacing && ' · replaces what this kalam has now'}
            </small>
            {hit.source === 'zh' && local.state === 'downloading' && (
              <small className="local-note">
                Saving Zikre Husain on this device{local.total ? ` · ${Math.round((100 * (local.loaded ?? 0)) / local.total)}%` : '…'} (once; then verses appear instantly)
              </small>
            )}
            {hit.source !== 'zh' && <small className="local-note">From your PDF: {hit.entry.g}</small>}
          </div>
          <LibImage className="verse-title" source={hit.source} n={hit.n} what="title" />
          <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="verse-tools">
          <button className="ghost" onClick={() => setChosen(new Set(Array.from({ length: count }, (_, i) => i)))}>Select all</button>
          <button className="ghost" onClick={() => setChosen(new Set())} disabled={!chosen.size}>Clear</button>
          <span>{chosen.size ? `${Math.ceil(chosen.size / per)} chosen` : 'None chosen yet'}</span>
        </div>
        <ol className="verse-list">
          {Array.from({ length: items }, (_, i) => {
            const vs = versesOf(i), on = chosen.has(vs[0]);
            return (
              <li key={i} className={on ? 'on' : ''} onClick={(e) => toggle(i, e.shiftKey)}>
                <span className="verse-no">{on ? '✓' : i + 1}</span>
                <LibImage source={hit.source} n={hit.n} what={[vs[0], vs[vs.length - 1]]} alt={`${per > 1 ? 'Couplet' : 'Verse'} ${i + 1}`} />
              </li>
            );
          })}
        </ol>
        <footer className="verse-foot">
          <button className="ghost" onClick={() => onAdd(null)}>{replacing ? 'Replace with' : 'Add'} whole kalam</button>
          <button className="primary" disabled={!chosen.size} onClick={() => onAdd(list)}>
            {replacing ? 'Replace with' : 'Add'} {Math.ceil(chosen.size / per) || ''} {per > 1 ? 'couplet' : 'verse'}{Math.ceil(chosen.size / per) === 1 ? '' : 's'}
          </button>
        </footer>
      </aside>
    </div>
  );
}
