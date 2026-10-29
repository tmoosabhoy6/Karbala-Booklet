import { useEffect, useMemo, useState } from 'react';
import { BookletView } from './booklet/Booklet';
import { paginate } from './booklet/paginate';
import { Editor } from './editor/Editor';
import type { PrintPayload } from './booklet/print';
import type { City } from './booklet/model';

declare global {
  interface Window {
    __BOOKLET_READY__?: boolean;
    __BOOKLET_ERROR__?: string;
  }
}

/** Chromium loads `/?print=<id>&from=<page>&to=<page>` to render the booklet
 * alone for PDF export, a few pages at a time (laid out whole, so page
 * numbers and the fihrist stay right). */
function PrintView({ id, range }: { id: string; range?: [number, number] }) {
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
    // Loaded, not decoded: decoding every image up front held them all in
    // memory at once (a long booklet's verses decode to over a gigabyte);
    // printing decodes each as its page is drawn.
    const loaded = (i: HTMLImageElement) => (i.complete ? Promise.resolve() : new Promise<void>((done, fail) => {
      i.addEventListener('load', () => done(), { once: true });
      i.addEventListener('error', () => fail(new Error('A page image did not load.')), { once: true });
    })).then(() => {
      if (!i.naturalWidth) throw new Error('A page image did not load.');
    });
    Promise.all([document.fonts.load('22pt "Kanz al-Marjaan"'), ...imgs.map(loaded)]).then(() => document.fonts.ready).then(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!cancelled) window.__BOOKLET_READY__ = true;
      }));
    }).catch(() => { if (!cancelled) window.__BOOKLET_ERROR__ = 'A verse image or font failed to load. Re-add the missing screenshot and retry.'; });
    return () => { cancelled = true; };
  }, [layout]);
  return doc && layout ? <BookletView doc={doc} layout={layout} assets={payload?.assets} range={range} /> : null;
}

// The city tab: `?city=najaf` opens Najaf directly; otherwise the browser
// remembers the last one.
const CITY_KEY = 'booklet-city';
const isCity = (c: string | null): c is City => c === 'karbala' || c === 'najaf';
function initialCity(): City {
  const asked = new URLSearchParams(location.search).get('city');
  if (isCity(asked)) return asked;
  try {
    const kept = localStorage.getItem(CITY_KEY);
    if (isCity(kept)) return kept;
  } catch { /* storage blocked: start on Karbala */ }
  return 'karbala';
}

function Workspace() {
  const [city, setCity] = useState(initialCity);
  const choose = (c: City) => {
    setCity(c);
    try { localStorage.setItem(CITY_KEY, c); } catch { /* not remembered */ }
    const url = new URL(location.href);
    url.searchParams.set('city', c);
    history.replaceState(null, '', url);
  };
  // A fresh editor per city, so nothing of one booklet carries into the other.
  return <Editor key={city} city={city} onCity={choose} />;
}

export default function App() {
  const query = new URLSearchParams(location.search);
  const printId = query.get('print');
  const range: [number, number] | undefined = query.has('from') ? [Number(query.get('from')), Number(query.get('to') ?? Infinity)] : undefined;
  return printId ? <PrintView id={printId} range={range} /> : <Workspace />;
}
