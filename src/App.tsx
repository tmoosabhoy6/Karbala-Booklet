import { useEffect, useMemo, useState } from 'react';
import { BookletView } from './booklet/Booklet';
import { Booklet, Venue } from './booklet/model';
import { paginate } from './booklet/paginate';
import { sampleBooklet } from './booklet/sample';
import { dateLine, raatTitle, raatTitleLatin } from './lib/hijri';
import './app.css';

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

declare global {
  interface Window {
    __BOOKLET_READY__?: boolean;
  }
}

/** Chromium loads `/?print=<id>` to render the booklet alone for PDF export. */
function PrintView({ id }: { id: string }) {
  const [doc, setDoc] = useState<Booklet | null>(null);
  useEffect(() => {
    fetch(`/api/print/${id}`).then((r) => r.json()).then(setDoc);
  }, [id]);
  const layout = useMemo(() => (doc ? paginate(doc) : null), [doc]);
  useEffect(() => {
    if (!layout) return;
    const imgs = Array.from(document.images);
    Promise.all([document.fonts.ready, ...imgs.map((i) => (i.complete ? null : i.decode().catch(() => null)))]).then(() => {
      window.__BOOKLET_READY__ = true;
    });
  }, [layout]);
  return doc && layout ? <BookletView doc={doc} layout={layout} /> : null;
}

function Editor() {
  const [date, setDate] = useState(todayIso);
  const [venue, setVenue] = useState<Venue>('haram');
  const [zoom, setZoom] = useState(0.75);
  const [busy, setBusy] = useState(false);
  const doc = useMemo(() => sampleBooklet(venue, date), [venue, date]);
  const layout = useMemo(() => paginate(doc), [doc]);
  const d = new Date(`${date}T12:00:00`);

  const exportPdf = async () => {
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
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <aside className="panel">
        <h1>Matam Majlis Booklet</h1>
        <label>
          Majlis date (evening)
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
        <div className="hijri" dir="rtl">
          <div className="t">{raatTitle(d)}</div>
          <div>{dateLine(d)}</div>
        </div>
        <label>
          Venue
          <select value={venue} onChange={(e) => setVenue(e.target.value as Venue)}>
            <option value="haram">Imam Husain AS Haram Mubarak</option>
            <option value="najmi">Najmi Masjid</option>
          </select>
        </label>
        <label>
          Zoom
          <input type="range" min={0.4} max={1.5} step={0.05} value={zoom} onChange={(e) => setZoom(+e.target.value)} />
        </label>
        <button onClick={exportPdf} disabled={busy}>
          {busy ? 'Building PDF…' : 'Download PDF'}
        </button>
        <p className="note">Phase 1 preview: verses are samples from the 5mi Raat reference.</p>
      </aside>
      <main className="preview">
        <div className="pages" style={{ zoom }}>
          <BookletView doc={doc} layout={layout} />
        </div>
      </main>
    </div>
  );
}

export default function App() {
  const printId = new URLSearchParams(location.search).get('print');
  return printId ? <PrintView id={printId} /> : <Editor />;
}
