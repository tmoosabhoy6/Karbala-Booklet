import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookletView } from '../booklet/Booklet';
import { stripMarkup } from '../booklet/RichText';
import { Block, CATEGORY_ADDABLE, CATEGORY_HINT, CATEGORY_LABEL, Category, ImageBlock, VENUES, Venue, uid } from '../booklet/model';
import { paginate } from '../booklet/paginate';
import { dateLine, raatTitle, raatTitleLatin } from '../lib/hijri';
import { ImageEditor } from './ImageEditor';
import { KalamCard, uploadInto } from './KalamCard';
import { useBooklet } from './useBooklet';
import './editor.css';

export function Editor() {
  const state = useBooklet();
  const { doc, setDoc, defaults, saved, undo, redo, updateKalams, updateKalam, replaceMedia, reset, textEdits, addTextBox } = state;
  const [active, setActive] = useState<{ category: Category; id: string } | null>(null);
  const [uploads, setUploads] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<ImageBlock | null>(null);
  const [zoom, setZoom] = useState(0.8);
  const [busy, setBusy] = useState(false);
  // Typing on the pages: click text to retype it; `placing` waits for a click to drop a text box.
  const [typing, setTyping] = useState(false);
  const [placing, setPlacing] = useState(false);

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

  if (!doc || !layout) return <div className="loading">Loading…</div>;
  const d = new Date(`${doc.date}T12:00:00`);
  const pageCount = layout.pages.length;

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
      .filter((k) => k.blocks.length && !stripMarkup(k.name));
    if (missing.length && !confirm(`${missing.length} kalam(s) have no fihrist name yet. Download anyway?`)) return;
    setBusy(true);
    try {
      const filename = `${raatTitleLatin(d)} Matam Majlis.pdf`;
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc, filename, title: `${raatTitle(d)} – ماتم مجلس` }),
      });
      if (!res.ok) throw new Error(await res.text());
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: filename });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      alert(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor">
      <aside className="inputs">
        <header className="inputs-head">
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
          <div className="seg venue">
            {(Object.keys(VENUES) as Venue[]).map((v) => (
              <button key={v} className={doc.venue === v ? 'on' : ''} onClick={() => setDoc((x) => ({ ...x, venue: v }))}>
                {VENUES[v].label}
              </button>
            ))}
          </div>
        </header>

        <div className="sections">
          {VENUES[doc.venue].sections.map((section) => (
            <section key={section.title} className="section">
              <h2 dir="rtl">{section.title}</h2>
              {section.categories.map((category) => {
                const kalams = doc.kalams[category];
                const filled = kalams.filter((k) => k.blocks.length).length;
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
                        uploads={uploads[k.id] ?? 0}
                        onUpload={(files) => upload(category, k.id, files)}
                      />
                    ))}
                    {CATEGORY_ADDABLE[category] && (
                      <button className="add" onClick={() => addKalam(category)}>
                        + Add {CATEGORY_HINT[category].replace(/ \(.*\)$/, '')}
                      </button>
                    )}
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
            <input type="range" min={0.4} max={1.4} step={0.05} value={zoom} onChange={(e) => setZoom(+e.target.value)} />
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
          <button className="primary" onClick={exportPdf} disabled={busy}>
            {busy ? 'Building PDF…' : 'Download PDF'}
          </button>
        </div>
        <div className="pages" style={{ zoom }}>
          <BookletView
            doc={doc}
            layout={layout}
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
    </div>
  );
}
