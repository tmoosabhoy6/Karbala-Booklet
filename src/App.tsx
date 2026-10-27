import { useEffect, useMemo, useState } from 'react';
import { BookletView } from './booklet/Booklet';
import { paginate } from './booklet/paginate';
import { Editor } from './editor/Editor';
import type { PrintPayload } from './booklet/print';

declare global {
  interface Window {
    __BOOKLET_READY__?: boolean;
    __BOOKLET_ERROR__?: string;
  }
}

/** Chromium loads `/?print=<id>` to render the booklet alone for PDF export. */
function PrintView({ id }: { id: string }) {
  const [payload, setPayload] = useState<PrintPayload | null>(null);
  const doc = payload?.doc;
  useEffect(() => {
    window.__BOOKLET_READY__ = false;
    delete window.__BOOKLET_ERROR__;
    fetch(`/api/print/${id}`).then((r) => {
      if (!r.ok) throw new Error('The print snapshot could not be loaded.');
      return r.json();
    }).then(setPayload).catch((e: Error) => { window.__BOOKLET_ERROR__ = e.message; });
  }, [id]);
  const layout = useMemo(() => (doc ? paginate(doc) : null), [doc]);
  useEffect(() => {
    if (!layout) return;
    const imgs = Array.from(document.images);
    let cancelled = false;
    Promise.all([document.fonts.load('22pt "Kanz al-Marjaan"'), ...imgs.map(async (i) => {
      await i.decode();
      if (!i.naturalWidth) throw new Error('A page image did not load.');
    })]).then(() => document.fonts.ready).then(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!cancelled) window.__BOOKLET_READY__ = true;
      }));
    }).catch(() => { if (!cancelled) window.__BOOKLET_ERROR__ = 'A verse image or font failed to load. Re-add the missing screenshot and retry.'; });
    return () => { cancelled = true; };
  }, [layout]);
  return doc && layout ? <BookletView doc={doc} layout={layout} assets={payload?.assets} /> : null;
}

export default function App() {
  const printId = new URLSearchParams(location.search).get('print');
  return printId ? <PrintView id={printId} /> : <Editor />;
}
