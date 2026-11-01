// Finds the kalams, stanzas and verses in a PDF added in the browser, from
// how its pages look (any PDF: typed, InPage exports, scans). A kalam starts
// at a title box or a centred heading in colour, or after a wide gap; it ends
// at a centred ornament (٭٭٭٭٭). Headers, footers and page numbers never
// print. Verses follow the same rules as the Zikre Husain library
// (src/library/plan.ts). The result has the library's own geometry format,
// so the same code lays out and renders it.
import type { Library, LibraryKalam, Marks } from './geometry';
import { joinParts, rowCrops, stanzasOf, staggered, versePlan, type Row } from './plan';

/** Analysis raster, px per point. */
const S = 1.5;

export interface FoundKalam { v: number; r: number; c?: number; pages: [number, number] }
export interface Analysis { library: Library; found: FoundKalam[] }

interface PageRows { rows: (Row & { kind: 'verse' | 'title' | 'ornament' | 'heading' })[]; width: number; height: number; boxes: number[][] }

/** A decorative page border (booklets made in Word): columns and rows near
 * the edges with ink down most of their length are blanked, leaving the
 * lettering inside. Pages without one are left as they are. */
function blankBorder(px: Uint8ClampedArray | Uint8Array, w: number, h: number, stride: number) {
  const inked = (o: number) => 255 - Math.min(px[o], px[o + 1], px[o + 2]) > 55;
  const cols = new Float32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inked(y * stride + x * 3)) cols[x]++;
  let left = 0, right = w;
  for (let x = 0; x < w * 0.25; x++) if (cols[x] / h > 0.35) left = x + 1;
  for (let x = w - 1; x > w * 0.75; x--) if (cols[x] / h > 0.35) right = x;
  let top = 0, bottom = h;
  const rowShare = (y: number) => { let n = 0; for (let x = left; x < right; x++) if (inked(y * stride + x * 3)) n++; return n / Math.max(1, right - left); };
  for (let y = 0; y < h * 0.2; y++) if (rowShare(y) > 0.35) top = y + 1;
  for (let y = h - 1; y > h * 0.8; y--) if (rowShare(y) > 0.35) bottom = y;
  if (!left && right === w && !top && bottom === h) return;
  // A little inside the border, past its antialiased edge.
  const pad = 3;
  left = left ? left + pad : 0; right = right < w ? right - pad : w; top = top ? top + pad : 0; bottom = bottom < h ? bottom - pad : h;
  for (let y = 0; y < h; y++) {
    if (y < top || y >= bottom) { px.fill(255, y * stride, y * stride + w * 3); continue; }
    if (left) px.fill(255, y * stride, y * stride + left * 3);
    if (right < w) px.fill(255, y * stride + right * 3, y * stride + w * 3);
  }
}

/** Runs of pixel rows with ink (three or more inked pixels). */
function rawBands(px: Uint8ClampedArray | Uint8Array, w: number, h: number, stride: number): [number, number][] {
  const raw: [number, number][] = [];
  let start = -1;
  for (let y = 0; y <= h; y++) {
    let on = false;
    if (y < h) {
      let n = 0;
      for (let x = 0; x < w && n < 3; x++) {
        const o = y * stride + x * 3;
        if (255 - Math.min(px[o], px[o + 1], px[o + 2]) > 55) n++;
      }
      on = n >= 3;
    }
    if (on && start < 0) start = y;
    if (!on && start >= 0) { raw.push([start, y]); start = -1; }
  }
  return raw;
}
const typicalOf = (raw: [number, number][]) => {
  const tall = raw.map(([t, b]) => b - t).filter((v) => v >= 4).sort((a, b) => a - b);
  return tall.length ? tall[Math.floor(tall.length * 0.7)] : 10;
};

/** Ink rows, like tools/build_library.py bands_of: marks smaller than a row
 * (dots, vowel marks) join the nearest row. */
function bandsOf(raw: [number, number][]): [number, number][] {
  if (!raw.length) return [];
  const typical = typicalOf(raw);
  const main = raw.filter(([t, b]) => b - t >= typical * 0.4).map(([t, b]) => [t, b] as [number, number]);
  if (!main.length) return raw;
  for (const [t, b] of raw) {
    if (b - t >= typical * 0.4) continue;
    const nearest = main.reduce((best, l) => (Math.max(0, t - l[1], l[0] - b) < Math.max(0, t - best[1], best[0] - b) ? l : best));
    nearest[0] = Math.min(nearest[0], t);
    nearest[1] = Math.max(nearest[1], b);
  }
  main.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const band of main) {
    const last = merged.at(-1);
    if (last && band[0] <= last[1]) last[1] = Math.max(last[1], band[1]);
    else merged.push([...band]);
  }
  return merged;
}

function rowOf(px: Uint8ClampedArray | Uint8Array, w: number, stride: number, t: number, b: number, page: number, oy: number, ox: number): Row {
  let ink = 0, colored = 0, mass = 0, moment = 0, x0 = w, x1 = -1;
  for (let y = t; y < b; y++) {
    let rowMass = 0;
    for (let x = 0; x < w; x++) {
      const o = y * stride + x * 3;
      const lo = Math.min(px[o], px[o + 1], px[o + 2]), a = 255 - lo;
      if (a > 55) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
      if (a > 100) { ink++; if (Math.max(px[o], px[o + 1], px[o + 2]) - lo > 60) colored++; }
      rowMass += a;
    }
    mass += rowMass;
    moment += rowMass * (y - t);
  }
  const centre = t + moment / Math.max(1, mass);
  return { t: oy + t / S, b: oy + b / S, c: oy + centre / S, x0: ox + Math.max(0, x0) / S, x1: ox + Math.max(0, x1) / S, col: colored / Math.max(1, ink), page };
}

const rgbOf = (c: number[]) => (c.length === 1 ? [c[0], c[0], c[0]] : c.length === 4 ? [0, 1, 2].map((i) => (1 - c[i]) * (1 - c[3])) : c);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readPage(mupdf: any, doc: any, i: number): PageRows {
  const page = doc.loadPage(i);
  try {
    const [bx0, by0, bx1, by1] = page.getBounds();
    const width = bx1 - bx0, height = by1 - by0;
    // Title boxes: wide, light, coloured fills behind a heading.
    const boxes: number[][] = [];
    const dev = new mupdf.Device({
      fillPath: (path: { getBounds: (s: null, m: unknown) => number[] }, _eo: boolean, ctm: unknown, _cs: unknown, color: number[]) => {
        const f = rgbOf(color);
        const r = path.getBounds(null, ctm);
        const w = r[2] - r[0], h = r[3] - r[1];
        if (Math.min(...f) > 0.55 && Math.max(...f) < 0.985 && Math.max(...f) - Math.min(...f) > 0.03 && w > width * 0.3 && w < width * 0.95 && h > 14 && h < 100) boxes.push(r);
      },
    });
    page.run(dev, mupdf.Matrix.identity);
    dev.close(); dev.destroy();
    const pix = page.toPixmap(mupdf.Matrix.scale(S, S), mupdf.ColorSpace.DeviceRGB, false);
    const w = pix.getWidth(), h = pix.getHeight(), stride = pix.getStride(), px = pix.getPixels();
    // Page numbers, headers and footers, and ornaments (٭٭٭٭٭): small runs of
    // ink standing apart from the lettering. They are blanked before rows are
    // read, or the nearest row would take them in; ornaments are kept as
    // markers where a kalam ends.
    blankBorder(px, w, h, stride);
    const raw = rawBands(px, w, h, stride);
    const typical = typicalOf(raw);
    const markers: PageRows['rows'] = [];
    raw.forEach(([t, b], j) => {
      // Dots and vowel marks sit a few pixels from their row; these stand apart.
      const gap = Math.min(j ? t - raw[j - 1][1] : Infinity, j + 1 < raw.length ? raw[j + 1][0] - b : Infinity);
      if (gap <= typical * 0.25) return;
      const r = rowOf(px, w, stride, t, b, i, by0, bx0);
      const wide = r.x1 - r.x0, centred = Math.abs((r.x0 + r.x1) / 2 - (bx0 + width / 2)) < width * 0.12;
      const furniture = (r.b - by0 < height * 0.08 || r.t - by0 > height * 0.92) && wide < width * 0.35;
      const ornament = gap > typical * 0.5 && centred && wide < width * 0.3 && wide > width * 0.03 && b - t < typical * 1.2 && r.col > 0.4;
      if (!furniture && !ornament) return;
      if (ornament && !furniture) markers.push({ ...r, kind: 'ornament' });
      for (let y = t; y < b; y++) px.fill(255, y * stride, y * stride + w * 3);
    });
    const rows = bandsOf(rawBands(px, w, h, stride)).map(([t, b]) => rowOf(px, w, stride, t, b, i, by0, bx0)).filter((r) => r.b - r.t >= 3);
    pix.destroy();
    return { width, height, boxes, rows: [...rows.map((r) => ({ ...r, kind: 'verse' as const })), ...markers].sort((a, b) => a.t - b.t) };
  } finally {
    page.destroy();
  }
}

const median = (a: number[]) => [...a].sort((p, q) => p - q)[a.length >> 1] ?? 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function analyzePdf(mupdf: any, doc: any, name: string, sha: string, progress?: (done: number, total: number) => void): Analysis {
  const count = doc.countPages();
  const pages: PageRows[] = [];
  for (let i = 0; i < count; i++) {
    pages.push(readPage(mupdf, doc, i));
    progress?.(i + 1, count);
  }
  const all = pages.flatMap((p) => p.rows);
  const lettering = all.filter((r) => r.kind === 'verse');
  const lh = median(lettering.map((r) => r.b - r.t)) || 12;
  const pitches = pages.flatMap((p) => { const v = p.rows.filter((r) => r.kind === 'verse'); return v.slice(1).map((r, j) => r.c - v[j].c); }).filter((v) => v > lh * 0.8).sort((a, b) => a - b);
  const pitch = pitches.length ? pitches[(pitches.length - 1) >> 2] : lh * 1.5;
  const marks: Record<string, Marks> = {};
  for (const [i, pg] of pages.entries()) {
    const zones: number[][] = [];
    pg.rows.forEach((r, j) => {
      if (r.kind === 'ornament') { zones.push([r.t - 2, r.b + 2]); return; }
      const centred = Math.abs((r.x0 + r.x1) / 2 - pg.width / 2) < pg.width * 0.12;
      const box = pg.boxes.find((b) => r.c >= b[1] - 3 && r.c <= b[3] + 3);
      if (box) { r.kind = 'title'; zones.push([box[1] - 3, box[3] + 3]); return; }
      const above = j ? r.t - pg.rows[j - 1].b : Infinity;
      if (centred && r.col > 0.6 && r.x1 - r.x0 < pg.width * 0.75 && above > pitch * 2.2 && pg.rows[j + 1] && pg.rows[j + 1].col < 0.5) r.kind = 'heading';
    });
    if (zones.length) marks[i] = { z: zones.map((z) => z.map((v) => +v.toFixed(1))) };
  }
  // Kalams in reading order. Besides titles and ornaments, a kalam also
  // starts after a gap far wider than a stanza break, or where the lettering
  // changes size (the next screenshot pasted into a booklet): the median row
  // height of the next three rows differs from the last three by a third.
  const flow = pages.flatMap((p) => p.rows);
  const heightAround = (j: number, dir: 1 | -1) => {
    const hs: number[] = [];
    for (let k = j; k >= 0 && k < flow.length && hs.length < 3; k += dir) if (flow[k].kind === 'verse') hs.push(flow[k].b - flow[k].t);
    return hs.length === 3 ? median(hs) : 0;
  };
  const resized = new Set<Row>();
  flow.forEach((r, j) => {
    if (r.kind !== 'verse') return;
    const before = heightAround(j - 1, -1), after = heightAround(j, 1);
    if (before && after && Math.abs(after - before) / Math.min(after, before) > 0.33) resized.add(r);
  });
  // Only the first row of each change of size counts.
  for (const r of [...resized]) { const j = flow.indexOf(r as (typeof flow)[number]); if (j > 0 && resized.has(flow[j - 1])) resized.delete(r); }
  const kalams: { title?: Row; rows: Row[] }[] = [];
  let cur: { title?: Row; rows: Row[] } | null = null;
  for (const pg of pages) {
    for (const r of pg.rows) {
      if (r.kind === 'title' || r.kind === 'heading') {
        if (cur && !cur.rows.length && cur.title?.page === r.page && r.t - cur.title.b < pitch) {
          cur.title = { ...cur.title, b: r.b, x0: Math.min(cur.title.x0, r.x0), x1: Math.max(cur.title.x1, r.x1) };
        } else kalams.push(cur = { title: r, rows: [] });
      } else if (r.kind === 'ornament') cur = null;
      else {
        const last = cur?.rows.at(-1);
        if (!cur || (last && ((last.page === r.page && r.t - last.b > pitch * 2.6) || resized.has(r)))) kalams.push(cur = { rows: [] });
        cur.rows.push(r);
      }
    }
  }
  const verses = all.filter((r) => r.kind === 'verse');
  const pad = 10;
  const maxWidth = Math.max(...pages.map((p) => p.width), 1);
  const x: [number, number] = verses.length
    ? [Math.max(0, Math.min(...verses.map((r) => r.x0)) - pad), Math.min(maxWidth, Math.max(...verses.map((r) => r.x1)) + pad)]
    : [0, maxWidth];
  const out: LibraryKalam[] = [];
  const found: FoundKalam[] = [];
  for (const k of kalams) {
    if (!k.rows.length) continue;
    const { stanzas, pitch: kp, lh: kh } = stanzasOf(k.rows);
    const rows = stanzas.flat();
    const crops = rowCrops(rows, () => 0, (p) => pages[p].height);
    const plan = versePlan(stanzas);
    const st = plan.map(([a, b]) => joinParts(crops.slice(a, b)));
    const t = k.title ?? rows[0];
    const couplets = stanzas.length === 1 && plan.every(([a, b]) => b - a === 1) && staggered(rows);
    // Print groups (tools/build_library.py print_groups): single rows of one
    // run print together; a staggered ghazal's couplet is one group; any verse
    // of two rows or more is a group of its own.
    const ids = new Map<string, number>();
    const g = plan.map(([a, b, si], i) => {
      const key = couplets ? `c${i >> 1}` : b - a === 1 ? `s${si}` : `v${i}`;
      if (!ids.has(key)) ids.set(key, ids.size);
      return ids.get(key)!;
    });
    out.push({ st, g, lh: +kh.toFixed(1), pitch: +kp.toFixed(1), tr: [t.page, +Math.max(0, t.x0 - 6).toFixed(1), +(t.t - 3).toFixed(1), +(t.x1 + 6).toFixed(1), +(t.b + 3).toFixed(1)] });
    found.push({ v: st.length, r: rows.length, ...(couplets ? { c: 2 } : {}), pages: [rows[0].page, rows.at(-1)!.page] });
  }
  return { library: { v: 1, source: name, sha, x, kalams: out, marks }, found };
}
