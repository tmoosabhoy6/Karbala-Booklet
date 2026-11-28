import { useEffect, useRef, useState } from 'react';
import type { Category } from '../booklet/model';
import { KIND_LABEL, LibraryHit, searchLibrary } from './library';
import { LibImage } from './LibImage';
import { LibraryBrowser } from './LibraryBrowser';
import { onUserChange } from '../library/user';
import { Icon } from './Icon';

interface Props {
  /** Ranks kalams of this kind first; none for Quick add. */
  category?: Category;
  placeholder: string;
  onPick: (hit: LibraryHit) => void;
  autoFocus?: boolean;
  className?: string;
}

/** Type a kalam's opening words in English letters; the list narrows as you type. */
export function LibrarySearch({ category, placeholder, onPick, autoFocus, className = '' }: Props) {
  const [text, setText] = useState('');
  const [hits, setHits] = useState<LibraryHit[]>([]);
  // The text `hits` were found for (the search waits for typing to pause).
  const [found, setFound] = useState('');
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const [error, setError] = useState('');
  // Zikre Husain's own index, to find a kalam without knowing its words.
  const [browsing, setBrowsing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Search again when a PDF is added or its kalams are named.
  const [revision, setRevision] = useState(0);
  useEffect(() => onUserChange(() => setRevision((r) => r + 1)), []);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      searchLibrary(text, category)
        .then((h) => { if (live) { setHits(h); setFound(text); setAt(0); setError(''); } })
        .catch((e: Error) => live && setError(e.message));
    }, 60);
    return () => { live = false; clearTimeout(t); };
  }, [text, category, revision]);

  useEffect(() => {
    const close = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, []);

  const pick = (hit: LibraryHit) => {
    setOpen(false);
    setText('');
    onPick(hit);
  };

  const showing = open && text.trim().length > 0;
  return (
    <div className={`lib-search${showing ? ' open' : ''} ${className}`} ref={box} onMouseDown={(e) => e.stopPropagation()}>
      <span className="lib-icon" aria-hidden>
        <Icon name="search" size={15} />
      </span>
      <input
        autoFocus={autoFocus}
        value={text}
        aria-label={placeholder}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(hits.length - 1, i + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
          else if (e.key === 'Enter' && text.trim()) {
            e.preventDefault();
            // Enter before the list caught up with the typing: take the best match for what is typed.
            if (found === text && hits[at]) pick(hits[at]);
            else void searchLibrary(text, category).then((h) => h[0] && pick(h[0]));
          }
          else if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur(); }
        }}
      />
      <button type="button" className="lib-browse" title="Browse Zikre Husain by its own index, section by section" onClick={() => { setOpen(false); setBrowsing(true); }}>
        <Icon name="book" size={15} /> Browse
      </button>
      {browsing && <LibraryBrowser onClose={() => setBrowsing(false)} onPick={(hit) => { setBrowsing(false); pick(hit); }} />}
      {showing && (
        <ul className="lib-results" role="listbox">
          {error && <li className="lib-empty">{error}</li>}
          {!error && !hits.length && <li className="lib-empty">Nothing in Zikre Husain or your PDFs matches “{text.trim()}” yet. Keep typing, or try another spelling.</li>}
          {hits.map((hit, i) => (
            <li
              key={`${hit.source}:${hit.n}`}
              role="option"
              aria-selected={i === at}
              className={i === at ? 'on' : ''}
              onMouseEnter={() => setAt(i)}
              onClick={() => pick(hit)}
            >
              <div className="lib-text">
                <b>{hit.name}</b>
                <small>
                  {hit.source === 'zh' ? <>{KIND_LABEL[hit.entry.k] ?? 'Kalam'} · {hit.entry.g}</> : <>Your PDF · {hit.entry.g}</>}
                  {hit.entry.v > 1 && (hit.entry.c ?? 1) > 1 ? <> · {Math.ceil(hit.entry.v / hit.entry.c!)} couplets</> : hit.entry.v > 1 && <> · {hit.entry.v} verses</>}
                  {hit.name !== hit.entry.t && <> · also “{hit.entry.t}”</>}
                </small>
              </div>
              <LibImage className="lib-title" source={hit.source} n={hit.n} what="title" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
