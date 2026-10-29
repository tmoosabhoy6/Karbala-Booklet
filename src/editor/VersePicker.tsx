import { useEffect, useState } from 'react';
import { LibraryHit, titleSrc, verseSrc } from './library';

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
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const t = requestAnimationFrame(() => setShown(true));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => { cancelAnimationFrame(t); window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const toggle = (i: number, range: boolean) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (range && anchor !== null) {
        const on = !prev.has(i) || prev.has(anchor);
        for (let v = Math.min(anchor, i); v <= Math.max(anchor, i); v++) on ? next.add(v) : next.delete(v);
      } else if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
    setAnchor(i);
  };

  const list = [...chosen].sort((a, b) => a - b);
  return (
    <div className={`verse-backdrop${shown ? ' shown' : ''}`} onMouseDown={onClose}>
      <aside className="verse-sheet" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={`Choose verses of ${hit.name}`}>
        <header className="verse-head">
          <div>
            <h2>{hit.name}</h2>
            <small>
              {count} verse{count === 1 ? '' : 's'} · {TOUCH ? 'tap the verses to print' : 'click to choose, Shift-click for a range'}
              {replacing && ' · replaces what this kalam has now'}
            </small>
          </div>
          <img className="verse-title" src={titleSrc(hit.n)} alt="" />
          <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="verse-tools">
          <button className="ghost" onClick={() => setChosen(new Set(Array.from({ length: count }, (_, i) => i)))}>Select all</button>
          <button className="ghost" onClick={() => setChosen(new Set())} disabled={!chosen.size}>Clear</button>
          <span>{chosen.size ? `${chosen.size} chosen` : 'None chosen yet'}</span>
        </div>
        <ol className="verse-list">
          {Array.from({ length: count }, (_, i) => (
            <li key={i} className={chosen.has(i) ? 'on' : ''} onClick={(e) => toggle(i, e.shiftKey)}>
              <span className="verse-no">{chosen.has(i) ? '✓' : i + 1}</span>
              <img src={verseSrc(hit.n, i)} alt={`Verse ${i + 1}`} loading="lazy" draggable={false} />
            </li>
          ))}
        </ol>
        <footer className="verse-foot">
          <button className="ghost" onClick={() => onAdd(null)}>{replacing ? 'Replace with' : 'Add'} whole kalam</button>
          <button className="primary" disabled={!chosen.size} onClick={() => onAdd(list)}>
            {replacing ? 'Replace with' : 'Add'} {chosen.size || ''} verse{chosen.size === 1 ? '' : 's'}
          </button>
        </footer>
      </aside>
    </div>
  );
}
