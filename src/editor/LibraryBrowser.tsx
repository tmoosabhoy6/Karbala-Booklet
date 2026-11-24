import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { KIND_LABEL, loadLibrary, type LibraryEntry, type LibraryHit } from './library';
import { LibImage } from './LibImage';
import { openZh, pageUrl, supported, useLocalStatus } from '../library/client';

// Zikre Husain as the PDF lays it out (public/library/contents.json, made by
// tools/build_library.py): the coloured master menu, then each section's own
// numbered index, every entry a link, as in the PDF. A link to another index
// page turns to it; a link to a kalam opens it in the verse picker. "List"
// shows the same sections as plain tables of every kalam in the library,
// those the PDF's index leaves out included.

interface Link { r: [number, number, number, number]; p?: number; k?: number }
interface Page { w: number; h: number; l: Link[] }
interface Contents { start: number; pages: Record<string, Page>; sections: { p: number; k: string; g: string }[] }

let contents: Promise<Contents> | null = null;
const loadContents = () => (contents ??= fetch('/library/contents.json')
  .then((r) => { if (!r.ok) throw new Error('The Zikre Husain index is not available.'); return r.json() as Promise<Contents>; })
  .catch((e) => { contents = null; throw e; }));

const hitOf = (entries: LibraryEntry[], n: number): LibraryHit => ({ source: 'zh', n, entry: entries[n], score: 1, name: entries[n].t });

interface Props {
  onClose: () => void;
  onPick: (hit: LibraryHit) => void;
}

export function LibraryBrowser({ onClose, onPick }: Props) {
  const [data, setData] = useState<{ contents: Contents; entries: LibraryEntry[] } | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'pdf' | 'list'>(() => { try { return localStorage.getItem('zh-browse') === 'list' ? 'list' : 'pdf'; } catch { return 'pdf'; } });
  const [shown, setShown] = useState(false);
  // The index pages turned through, to step back along them.
  const [trail, setTrail] = useState<number[]>([0]);
  const page = trail[trail.length - 1];
  const [group, setGroup] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([loadContents(), loadLibrary()]).then(([c, lib]) => setData({ contents: c, entries: lib.entries }), (e: Error) => setError(e.message));
    // Browsing is the moment to make this device's copy ready (once).
    if (supported) openZh().catch(() => undefined);
  }, []);
  useEffect(() => {
    const t = requestAnimationFrame(() => setShown(true));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => { cancelAnimationFrame(t); window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  useEffect(() => { try { localStorage.setItem('zh-browse', mode); } catch { /* per-device nicety only */ } }, [mode]);

  const pick = (n: number) => data && onPick(hitOf(data.entries, n));
  const go = (p: number) => setTrail((t) => (t[t.length - 1] === p ? t : [...t, p]));
  const back = () => setTrail((t) => (t.length > 1 ? t.slice(0, -1) : t));

  // On the page itself, not inside the card it was opened from (its styles
  // and its own stacking would reach in).
  return createPortal(
    <div className={`verse-backdrop${shown ? ' shown' : ''}`} onMouseDown={onClose}>
      <aside className="verse-sheet browse-sheet" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Browse Zikre Husain">
        <header className="verse-head browse-head">
          <div>
            <h2>Zikre Husain</h2>
            <small>{mode === 'pdf' ? 'The index as the PDF has it: tap a section, then a kalam' : 'Every kalam, section by section'}</small>
          </div>
          <div className="seg browse-seg" role="tablist">
            <button role="tab" aria-selected={mode === 'pdf'} className={mode === 'pdf' ? 'on' : ''} onClick={() => setMode('pdf')}>PDF index</button>
            <button role="tab" aria-selected={mode === 'list'} className={mode === 'list' ? 'on' : ''} onClick={() => setMode('list')}>List</button>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </header>
        {error && <p className="browse-empty">{error}</p>}
        {!error && !data && <p className="browse-empty"><span className="spinner" /> Opening the index…</p>}
        {data && mode === 'pdf' && <PdfIndex contents={data.contents} entries={data.entries} page={page} canBack={trail.length > 1} onBack={back} onGo={go} onPick={pick} />}
        {data && mode === 'list' && <SectionList contents={data.contents} entries={data.entries} group={group} onGroup={setGroup} onPick={pick} />}
      </aside>
    </div>,
    document.body,
  );
}

/** Which section an index page belongs to. */
const sectionOf = (c: Contents, p: number) => [...c.sections].reverse().find((s) => s.p <= p) ?? c.sections[0];

function PdfIndex({ contents, entries, page, canBack, onBack, onGo, onPick }: {
  contents: Contents; entries: LibraryEntry[]; page: number; canBack: boolean;
  onBack: () => void; onGo: (p: number) => void; onPick: (n: number) => void;
}) {
  const info = contents.pages[String(page)];
  const [src, setSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const local = useLocalStatus().state === 'ready';
  const scroller = useRef<HTMLDivElement>(null);
  const linked = useMemo(() => new Set(Object.values(contents.pages).flatMap((pg) => pg.l.map((l) => l.k).filter((k): k is number => k !== undefined))), [contents]);

  useEffect(() => {
    let live = true;
    setSrc(null);
    setLoaded(false);
    setFailed(false);
    pageUrl(page, info.w, info.h).then((u) => live && setSrc(u), () => live && setFailed(true));
    scroller.current?.scrollTo({ top: 0 });
    // The pages either side, ready for turning.
    const t = setTimeout(() => {
      for (const p of [page + 1, page - 1]) { const pg = contents.pages[String(p)]; if (pg) void pageUrl(p, pg.w, pg.h).then((u) => { new Image().src = u; }).catch(() => undefined); }
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [page, info.w, info.h, contents, local]);

  const prev = contents.pages[String(page - 1)] ? page - 1 : null;
  const next = contents.pages[String(page + 1)] ? page + 1 : null;
  const section = page === contents.start ? null : sectionOf(contents, page);
  // Kalams of this section that no index entry links to: listed under the page.
  const unlisted = section ? entries.map((e, n) => ({ e, n })).filter(({ e, n }) => e.g === section.g && !linked.has(n)) : [];

  return (
    <>
      <div className="verse-tools browse-tools">
        <button className="ghost" onClick={onBack} disabled={!canBack} title="Back to the page before">← Back</button>
        <button className="ghost" onClick={() => onGo(contents.start)} disabled={page === contents.start} title="The master menu">☰ Contents</button>
        <span className="browse-where">{section ? section.g : 'Contents'} · page {page + 1}</span>
        <button className="ghost" onClick={() => prev !== null && onGo(prev)} disabled={prev === null} title="Previous index page">‹</button>
        <button className="ghost" onClick={() => next !== null && onGo(next)} disabled={next === null} title="Next index page">›</button>
      </div>
      <div className="browse-scroll" ref={scroller}>
        <div className={`browse-page${loaded ? '' : ' loading'}`} style={{ aspectRatio: `${info.w} / ${info.h}` }}>
          {src && <img src={src} alt={`Index page ${page + 1}`} draggable={false} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}
          {!loaded && !failed && <span className="browse-wait"><span className="spinner" /></span>}
          {failed && <span className="browse-wait">This page could not be shown. Try again in a moment.</span>}
          {info.l.map((l, i) => {
            const [x0, y0, x1, y1] = l.r;
            const title = l.k !== undefined ? `${entries[l.k]?.t ?? 'Kalam'} · select this` : `Open page ${(l.p ?? 0) + 1}`;
            return (
              <button
                key={i}
                className={`browse-link${l.k !== undefined ? ' kalam' : ''}`}
                style={{ left: `${(100 * x0) / info.w}%`, top: `${(100 * y0) / info.h}%`, width: `${(100 * (x1 - x0)) / info.w}%`, height: `${(100 * (y1 - y0)) / info.h}%` }}
                title={title}
                aria-label={title}
                onClick={() => (l.k !== undefined ? onPick(l.k) : l.p !== undefined && onGo(l.p))}
              />
            );
          })}
        </div>
        {unlisted.length > 0 && (
          <div className="browse-unlisted">
            <h3>Also in {section!.g}, not on the PDF’s index</h3>
            <KalamTable entries={entries} rows={unlisted.map(({ n }) => n)} onPick={onPick} />
          </div>
        )}
      </div>
    </>
  );
}

function SectionList({ contents, entries, group, onGroup, onPick }: {
  contents: Contents; entries: LibraryEntry[]; group: string | null; onGroup: (g: string | null) => void; onPick: (n: number) => void;
}) {
  const [filter, setFilter] = useState('');
  // Sections in the PDF's order, with every kalam the library has in each.
  const groups = useMemo(() => {
    const by = new Map<string, number[]>();
    entries.forEach((e, n) => { const list = by.get(e.g) ?? []; list.push(n); by.set(e.g, list); });
    const order = contents.sections.map((s) => s.g);
    return [...by.entries()]
      .map(([g, ns]) => ({ g, ns, kind: entries[ns[0]].k, at: Math.min(...ns) }))
      .sort((a, b) => a.at - b.at || order.indexOf(a.g) - order.indexOf(b.g));
  }, [contents, entries]);
  const open = groups.find((x) => x.g === group);
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = open ? open.ns.filter((n) => words.every((w) => [entries[n].t, ...(entries[n].a ?? [])].some((t) => t.toLowerCase().includes(w)))) : [];

  if (!open) {
    return (
      <div className="browse-scroll">
        <ul className="browse-groups">
          {groups.map((x) => (
            <li key={x.g}>
              <button onClick={() => { setFilter(''); onGroup(x.g); }}>
                <b>{x.g}</b>
                <small>{KIND_LABEL[x.kind] ?? 'Kalam'} · {x.ns.length} kalam{x.ns.length === 1 ? '' : 's'}</small>
                <span aria-hidden>›</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <>
      <div className="verse-tools browse-tools">
        <button className="ghost" onClick={() => onGroup(null)}>← Sections</button>
        <span className="browse-where">{open.g} · {open.ns.length}</span>
        <input className="browse-filter" value={filter} placeholder="Filter" spellCheck={false} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="browse-scroll">
        {rows.length ? <KalamTable entries={entries} rows={rows} numbered onPick={onPick} /> : <p className="browse-empty">Nothing here matches “{filter}”.</p>}
      </div>
    </>
  );
}

function KalamTable({ entries, rows, numbered, onPick }: { entries: LibraryEntry[]; rows: number[]; numbered?: boolean; onPick: (n: number) => void }) {
  return (
    <ol className="browse-table">
      {rows.map((n, i) => {
        const e = entries[n];
        const per = Math.max(1, e.c ?? 1);
        const count = Math.ceil(e.v / per);
        return (
          <li key={n}>
            <button onClick={() => onPick(n)} title="Select this kalam">
              {numbered && <span className="browse-no">{i + 1}</span>}
              <span className="lib-text">
                <b>{e.t}</b>
                <small>{count} {per > 1 ? 'couplet' : 'verse'}{count === 1 ? '' : 's'}</small>
              </span>
              <LibImage className="lib-title" source="zh" n={n} what="title" />
            </button>
          </li>
        );
      })}
    </ol>
  );
}
