import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookletView } from '../booklet/Booklet';
import { stripMarkup } from '../booklet/RichText';
import { Block, CATEGORY_HINT, CATEGORY_LABEL, CITIES, Category, City, ImageBlock, VENUES, imageBlockFrom, sectionsOf, uid } from '../booklet/model';
import { paginate } from '../booklet/paginate';
import { dateLine, raatTitle, raatTitleLatin } from '../lib/hijri';
import { ImageEditor } from './ImageEditor';
import { KalamCard, uploadInto } from './KalamCard';
import { useBooklet } from './useBooklet';
import { api } from './api';
import { AIRestore } from './AIRestore';
import { LibrarySearch } from './LibrarySearch';
import { VersePicker } from './VersePicker';
import type { LibraryHit } from './library';
import './editor.css';

export function Editor({ city, onCity }: { city: City; onCity: (city: City) => void }) {
  const state = useBooklet(city);
  const { doc, setDoc, defaults, builtin, saved, undo, redo, updateKalams, updateKalam, restoreDefault, moveSection, replaceMedia, reset, textEdits, addTextBox } = state;
  const [active, setActive] = useState<{ category: Category; id: string } | null>(null);
  const [uploads, setUploads] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<ImageBlock | null>(null);
  const [restoring, setRestoring] = useState<ImageBlock | null>(null);
  // A library kalam waiting for its verses to be chosen; `replace` when it goes into a filled card.
  const [picking, setPicking] = useState<{ category: Category; kalamId?: string; replace: boolean; hit: LibraryHit } | null>(null);
  const [fetching, setFetching] = useState<Record<string, number>>({});
  // A4 is 794 CSS px wide: start narrow screens zoomed to fit.
  const [zoom, setZoom] = useState(() => Math.max(0.3, Math.min(0.8, +((innerWidth - 32) / 794).toFixed(2))));
  // Phones show one panel at a time.
  const [pane, setPane] = useState<'inputs' | 'preview'>('inputs');
  const [busy, setBusy] = useState(false);
  // Typing on the pages: click text to retype it; `placing` waits for a click to drop a text box.
  const [typing, setTyping] = useState(false);
  const [placing, setPlacing] = useState(false);
  // On a phone the finished PDF is offered as a link to tap (see exportPdf).
  const [ready, setReady] = useState<{ url: string; filename: string } | null>(null);

  const layout = useMemo(() => (doc ? paginate(doc) : null), [doc]);

  const upload = useCallback(
    (category: Category, kalamId: string, files: File[]) =>
      uploadInto(
        files,
        (b: Block) => updateKalam(category, kalamId, (k) => ({ ...k, blocks: [...k.blocks, b] })),
        (n) => setUploads((u) => ({ ...u, [kalamId]: n })),
      ),
    [updateKalam],
  );

  /** A kalam (or chosen verses) from Zikre Husain into a kalam card: a new one
   * unless `kalamId` names the card to fill. With `replace` the card's old
   * content goes once the first new image is ready (and stays if none comes).
   * Each image is rendered from the PDF and cleaned on the server, then
   * printed like any screenshot. */
  const addFromLibrary = useCallback(
    async (category: Category, hit: LibraryHit, verses: number[] | null, kalamId?: string, replace = false) => {
      const id = kalamId ?? uid();
      if (!kalamId) updateKalams(category, (ks) => [...ks, { id, name: '', blocks: [] }]);
      setActive({ category, id });
      setFetching((f) => ({ ...f, [id]: 1 }));
      try {
        const { ids } = await api.libraryPlan(hit.n, verses);
        for (let i = 0; i < ids.length; i++) {
          setFetching((f) => ({ ...f, [id]: ids.length - i }));
          const meta = await api.media(ids[i]);
          if (!meta) throw new Error('The verses could not be made.');
          const block = imageBlockFrom(meta);
          updateKalam(category, id, (k) => ({ ...k, blocks: replace && i === 0 ? [block] : [...k.blocks, block] }));
        }
      } catch (e) {
        alert(`Could not add “${hit.name}”: ${(e as Error).message}`);
      } finally {
        setFetching((f) => ({ ...f, [id]: 0 }));
      }
    },
    [updateKalam, updateKalams],
  );
  // Every kalam opens the verse picker, so the verses can be seen and chosen first.
  const pickFromLibrary = (category: Category, hit: LibraryHit, kalamId?: string) => {
    const replace = !!kalamId && !!doc?.kalams[category].find((k) => k.id === kalamId)?.blocks.length;
    setPicking({ category, kalamId, replace, hit });
  };

  // ⌘V pastes screenshots into the selected kalam; ⌘Z / ⇧⌘Z undo and redo.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      if (!active) {
        alert('Select a kalam first (click its card), then paste.');
        return;
      }
      upload(active.category, active.id, files);
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [contenteditable]')) return;
      if (e.key === 'Escape') setPlacing(false);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener('paste', onPaste);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('keydown', onKey);
    };
  }, [active, upload, undo, redo]);

  if (!doc || !layout) return <div className="loading" role={state.loadError ? 'alert' : 'status'}>{state.loadError ? <>Could not load the booklet: {state.loadError} <button onClick={() => location.reload()}>Try again</button></> : 'Loading…'}</div>;
  const d = new Date(`${doc.date}T12:00:00`);
  const pageCount = layout.pages.length;
  const sections = sectionsOf(doc);

  const activate = (category: Category, id: string) => {
    setActive({ category, id });
    document.getElementById(`k-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const addKalam = (category: Category) => {
    const id = uid();
    updateKalams(category, (ks) => [...ks, { id, name: '', blocks: [] }]);
    setActive({ category, id });
  };

  const exportPdf = async () => {
    const missing = Object.values(doc.kalams)
      .flat()
      .filter((k) => k.blocks.length && !stripMarkup(k.name) && !(k.blocks[0].kind === 'image' && k.blocks[0].opening));
    if (missing.length && !confirm(`${missing.length} kalam(s) have no fihrist name yet. Download anyway?`)) return;
    setBusy(true);
    setReady(null);
    try {
      const filename = `${raatTitleLatin(d)} Matam Majlis.pdf`;
      const url = await api.exportPdf({ doc, filename, title: `${raatTitle(d)} – ماتم مجلس` });
      // Phones only save a download started by a tap, and building the PDF
      // takes longer than that tap counts for: they get a Save button instead.
      if (matchMedia('(pointer: coarse)').matches) setReady({ url, filename });
      else Object.assign(document.createElement('a'), { href: url, download: filename }).click();
    } catch (e) {
      alert(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`editor ${city}`} data-pane={pane}>
      <nav className="mobile-tabs">
        <button className={pane === 'inputs' ? 'on' : ''} onClick={() => setPane('inputs')}>
          Kalams
        </button>
        <button className={pane === 'preview' ? 'on' : ''} onClick={() => setPane('preview')}>
          Preview · {pageCount} pages
        </button>
      </nav>
      <aside className="inputs">
        <header className="inputs-head">
          {/* Each city is its own workspace: its own booklet, defaults and artwork. */}
          <div className="seg city">
            {(Object.keys(CITIES) as City[]).map((c) => (
              <button key={c} className={city === c ? 'on' : ''} onClick={() => onCity(c)}>
                {CITIES[c].label}
              </button>
            ))}
          </div>
          <div className="row">
            <h1>Matam Majlis Booklet</h1>
            <span className={`saved${saved ? '' : ' saving'}`}>{saved ? 'Saved' : 'Saving…'}</span>
          </div>
          <div className="row two">
            <label>
              Majlis date (evening)
              <input type="date" value={doc.date} onChange={(e) => e.target.value && setDoc((x) => ({ ...x, date: e.target.value }))} />
            </label>
            <div className="hijri" dir="rtl">
              <div className="t">{raatTitle(d)}</div>
              <div className="dl">{dateLine(d)}</div>
            </div>
          </div>
          {CITIES[city].venues.length > 1 ? (
            <div className="seg venue">
              {CITIES[city].venues.map((v) => (
                <button key={v} className={doc.venue === v ? 'on' : ''} onClick={() => setDoc((x) => ({ ...x, venue: v }))}>
                  {VENUES[v].label}
                </button>
              ))}
            </div>
          ) : (
            <div className="venue-name">{VENUES[doc.venue].label}</div>
          )}
        </header>

        <div className="sections">
          {sections.map((section, si) => (
            <section key={section.title} className="section">
              <h2 dir="rtl">{section.title}</h2>
              {section.categories.map((category, ci) => {
                const kalams = doc.kalams[category];
                const filled = kalams.filter((k) => k.blocks.length).length;
                // Built-in defaults removed from this booklet can be put back.
                const missing = Object.entries(builtin).filter(([slot, d]) => d.category === category && !kalams.some((k) => k.slot === slot));
                return (
                  <div className="category" key={category}>
                    <div className="category-head">
                      <span className="ar" dir="rtl">
                        {CATEGORY_LABEL[category]}
                      </span>
                      <span className="en">{CATEGORY_HINT[category]}</span>
                      <span className={`count${filled ? '' : ' none'}`} title="Kalams that will print">
                        {filled}
                      </span>
                      <span className="category-tools">
                        <button title="Move this section up" disabled={si === 0 && ci === 0} onClick={() => moveSection(category, -1)}>
                          ↑
                        </button>
                        <button title="Move this section down" disabled={si === sections.length - 1 && ci === section.categories.length - 1} onClick={() => moveSection(category, 1)}>
                          ↓
                        </button>
                      </span>
                    </div>
                    {kalams.map((k, i) => (
                      <KalamCard
                        key={k.id}
                        category={category}
                        kalam={k}
                        index={i}
                        count={kalams.length}
                        active={active?.id === k.id}
                        state={state}
                        defaults={defaults}
                        onActivate={() => activate(category, k.id)}
                        onEditImage={setEditing}
                        onRestoreImage={setRestoring}
                        uploads={uploads[k.id] ?? 0}
                        fetching={fetching[k.id] ?? 0}
                        onUpload={(files) => upload(category, k.id, files)}
                        onLibrary={(hit) => pickFromLibrary(category, hit, k.id)}
                      />
                    ))}
                    <LibrarySearch
                      category={category}
                      placeholder={`Add ${CATEGORY_HINT[category].replace(/ \(.*\)$/, '')} from Zikre Husain: type its first words`}
                      onPick={(hit) => pickFromLibrary(category, hit)}
                    />
                    <button className="add" onClick={() => addKalam(category)}>
                      + Add {CATEGORY_HINT[category].replace(/ \(.*\)$/, '')}
                    </button>
                    {missing.map(([slot, d]) => (
                      <button key={slot} className="add restore" title="Put this default back into the booklet" onClick={() => restoreDefault(slot)}>
                        ↺ Default: <bdi>{d.name}</bdi>
                      </button>
                    ))}
                  </div>
                );
              })}
            </section>
          ))}
          <div className="footer-tools">
            <button
              className="ghost"
              onClick={() =>
                confirm('Start a new booklet? Screenshots, page headings, page-number edits and text boxes are cleared; pinned (★) defaults and your cover/fihrist wording are kept.') &&
                reset(doc.venue)
              }
            >
              New booklet
            </button>
            <span className="hint">Kalams with no screenshots are left out of the PDF.</span>
          </div>
        </div>
      </aside>

      <main className="preview">
        <div className="preview-bar">
          <span className="pages-count">{pageCount} pages</span>
          <label className="zoom">
            Zoom
            <input type="range" min={0.3} max={1.4} step={0.05} value={zoom} onChange={(e) => setZoom(+e.target.value)} />
          </label>
          <button
            className={`ghost${typing ? ' on' : ''}`}
            title="Click any text on the pages (titles, fihrist, headings, page numbers) to retype it"
            onClick={() => {
              setTyping(!typing);
              setPlacing(false);
            }}
          >
            {typing ? '✓ Done editing' : '✎ Edit text'}
          </button>
          {typing && (
            <button className={`ghost${placing ? ' on' : ''}`} title="Then click on a page where the text should go" onClick={() => setPlacing(!placing)}>
              {placing ? 'Click on a page… (Esc)' : '+ Text box'}
            </button>
          )}
          <button className="ghost" onClick={undo} title="Undo (⌘Z)">
            ↶
          </button>
          <button className="ghost" onClick={redo} title="Redo (⇧⌘Z)">
            ↷
          </button>
          <button className="primary" onClick={exportPdf} disabled={busy || [...Object.values(uploads), ...Object.values(fetching)].some((n) => n > 0)}>
            {busy ? 'Building PDF…' : 'Download PDF'}
          </button>
        </div>
        {ready && (
          <div className="pdf-ready">
            <span>PDF ready</span>
            <a className="primary" href={ready.url} download={ready.filename} onClick={() => setTimeout(() => setReady(null), 1000)}>
              Save {ready.filename}
            </a>
            <button className="ghost" onClick={() => setReady(null)} aria-label="Close">
              ✕
            </button>
          </div>
        )}
        <div className="pages" style={{ zoom }}>
          <BookletView
            doc={doc}
            layout={layout}
            pageWidthPx={794 * zoom}
            edits={typing ? textEdits : undefined}
            onPlace={
              placing
                ? (page, x, y) => {
                    addTextBox(page, x, y);
                    setPlacing(false);
                  }
                : undefined
            }
          />
        </div>
      </main>

      {editing && <ImageEditor block={editing} onClose={() => setEditing(null)} onApplied={replaceMedia} />}
      {picking && (
        <VersePicker
          hit={picking.hit}
          replacing={picking.replace}
          onClose={() => setPicking(null)}
          onAdd={(verses) => {
            void addFromLibrary(picking.category, picking.hit, verses, picking.kalamId, picking.replace);
            setPicking(null);
          }}
        />
      )}
      {restoring && <AIRestore block={restoring} onClose={() => setRestoring(null)} onUse={(meta) => { replaceMedia(meta, restoring.mediaId); setRestoring(null); }} />}
    </div>
  );
}
