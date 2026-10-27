import { useEffect, useMemo, useState } from 'react';
import { BookletView } from './booklet/Booklet';
import { Booklet } from './booklet/model';
import { paginate } from './booklet/paginate';
import { Editor } from './editor/Editor';

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
    Promise.all([document.fonts.ready, ...imgs.map((i) => i.decode().catch(() => null))]).then(() => {
      window.__BOOKLET_READY__ = true;
    });
  }, [layout]);
  return doc && layout ? <BookletView doc={doc} layout={layout} /> : null;
}

export default function App() {
  const printId = new URLSearchParams(location.search).get('print');
  return printId ? <PrintView id={printId} /> : <Editor />;
}
