import { useEffect, useRef, useState } from 'react';
import type { Category } from '../booklet/model';
import { KIND_LABEL, LibraryHit, searchLibrary, titleSrc } from './library';

interface Props {
  category: Category;
  placeholder: string;
  onPick: (hit: LibraryHit) => void;
}

/** Type a kalam's opening words in English letters; the list narrows as you type. */
export function LibrarySearch({ category, placeholder, onPick }: Props) {
  const [text, setText] = useState('');
  const [hits, setHits] = useState<LibraryHit[]>([]);
  // The text `hits` were found for (the search waits for typing to pause).
  const [found, setFound] = useState('');
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      searchLibrary(text, category)
        .then((h) => { if (live) { setHits(h); setFound(text); setAt(0); setError(''); } })
        .catch((e: Error) => live && setError(e.message));
    }, 60);
    return () => { live = false; clearTimeout(t); };
  }, [text, category]);

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
    <div className={`lib-search${showing ? ' open' : ''}`} ref={box} onMouseDown={(e) => e.stopPropagation()}>
      <span className="lib-icon" aria-hidden>⌕</span>
      <input
        value={text}
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
      {showing && (
        <ul className="lib-results" role="listbox">
          {error && <li className="lib-empty">{error}</li>}
          {!error && !hits.length && <li className="lib-empty">Nothing in Zikre Husain matches “{text.trim()}” yet. Keep typing, or try another spelling.</li>}
          {hits.map((hit, i) => (
            <li
              key={hit.n}
              role="option"
              aria-selected={i === at}
              className={i === at ? 'on' : ''}
              onMouseEnter={() => setAt(i)}
              onClick={() => pick(hit)}
            >
              <div className="lib-text">
                <b>{hit.name}</b>
                <small>
                  {KIND_LABEL[hit.entry.k] ?? 'Kalam'} · {hit.entry.g}
                  {hit.entry.v > 1 && (hit.entry.c ?? 1) > 1 ? <> · {Math.ceil(hit.entry.v / hit.entry.c!)} couplets</> : hit.entry.v > 1 && <> · {hit.entry.v} verses</>}
                  {hit.name !== hit.entry.t && <> · also “{hit.entry.t}”</>}
                </small>
              </div>
              <img className="lib-title" src={titleSrc(hit.n)} alt="" loading="lazy" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
