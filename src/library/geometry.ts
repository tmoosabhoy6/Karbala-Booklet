// Library geometry shared by the server (server/library.ts) and the browser
// (src/library/worker.ts): which parts of which PDF pages make up a kalam's
// verses, and how chosen verses are laid out into images. Both sides lay out
// and render with this same code, so a verse made in the browser is the image
// the server would make.

/** [page, y0, y1, centre of first row, centre of last row] in PDF points. */
export type Part = [number, number, number, number, number];
/** `st`: each verse's parts. `g`: each verse's stanza, when verses are rows or
 * pieces of stanzas (tools/build_library.py verse_plan); without it every
 * verse is a stanza of its own. `o`: verses found above where the kalam used
 * to start, which version 1 ids do not count. */
export interface Verses { st: Part[][]; g?: number[]; o?: number }
/** `l2`: the verses of library version 2, when they differ (booklets made
 * with version 2 ids keep the verses they chose). */
export interface LibraryKalam extends Verses { lh: number; pitch: number; tr: [number, number, number, number, number]; l2?: Verses }
/** Per page: whiteouts, full-width zones, tints, `d`: text objects to
 * leave out (the shadow layers under lettering: [x0, y0, x1, y1, r, g, b,
 * glyphs, first glyph's x, y]) and `b`: title boxes [x0, y0, x1, y1] whose
 * pink and frame are left out (the heading line in them prints). */
export interface Marks { w?: number[][]; z?: number[][]; t?: [number, number, number, number, number[]][]; d?: number[][]; b?: number[][] }
/** `build`: this geometry's own digest (tools/build_library.py finalize).
 * `x`: the horizontal span every verse image covers, in points. */
export interface Library { v: number; source: string; sha: string; build?: string; x?: [number, number]; kalams: LibraryKalam[]; marks: Record<string, Marks> }

/** Library media ids: lib<version>-<kalam>-<verses>-<block>, e.g. lib3-0-0t9_12-0.
 * Everything about the image follows from the id, so a server that lost the
 * files makes the same ones again. */
export const LIBRARY_ID = /^lib(\d+)-(\d+)-(all|[\dt_]+)-(\d+)$/;

export const encodeVerses = (verses: number[] | null, count: number) => {
  if (!verses || (verses.length === count && verses.every((v, i) => v === i))) return 'all';
  const out: string[] = [];
  for (let i = 0; i < verses.length; i++) {
    let j = i;
    while (j + 1 < verses.length && verses[j + 1] === verses[j] + 1) j++;
    out.push(j > i ? `${verses[i]}t${verses[j]}` : `${verses[i]}`);
    i = j;
  }
  return out.join('_');
};
export const decodeVerses = (sel: string, count: number): number[] => {
  if (sel === 'all') return Array.from({ length: count }, (_, i) => i);
  return sel.split('_').flatMap((r) => {
    const [a, b = a] = r.split('t').map(Number);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
};

/** Render scale: the kalam's verse rows come out about 128 px tall, around
 * 270 DPI at the booklet's 34 pt line, sharper than any screenshot. */
export const zoomOf = (k: { lh: number }) => Math.min(5, Math.max(2.5, 128 / Math.max(10, k.lh)));
/** Pixels per rendered block; the screenshot cleaner's margin-mark pass runs up to 12M. */
const MAX_PIXELS = 10_000_000;
export const spanOf = (lib: Pick<Library, 'x'>): [number, number] => lib.x ?? [18, 594];

export interface Placed { part: Part; dy: number }
export interface Block { placed: Placed[]; height: number; continues: boolean }

/** Chosen verses as stanzas to print, each a list of parts. Chosen verses of
 * the same stanza print together as one, at line pitch; neighbouring ones on
 * a page join into one crop, so a whole stanza prints exactly as it stands. */
function stanzasOf(k: Verses, verses: number[]): Part[][] {
  const out: Part[][] = [];
  let group: number | null = null, last = -2;
  for (const v of verses) {
    const parts = k.st[v];
    if (!parts) continue;
    const g = k.g?.[v] ?? null;
    const run = out[out.length - 1];
    if (g === null || g !== group || !run) out.push(parts.map((p) => [...p] as Part));
    else {
      const prev = run[run.length - 1];
      const [first, ...rest] = parts;
      if (v === last + 1 && prev[0] === first[0]) run[run.length - 1] = [prev[0], prev[1], first[2], prev[3], first[4]];
      else run.push([...first] as Part);
      run.push(...rest.map((p) => [...p] as Part));
    }
    group = g;
    last = v;
  }
  return out;
}

/** Chosen verses laid out into blocks of whole stanzas (a stanza taller than a
 * block continues in the next, marked `continues`). Inside a block a stanza's
 * pieces from consecutive pages join at its own line pitch; stanzas are kept a
 * clear stanza gap apart, which the cleaner reads as the stanza break. */
export function layout(k: Verses & { lh: number; pitch: number }, verses: number[], span: [number, number] = [18, 594]): Block[] {
  const z = zoomOf(k);
  const maxH = MAX_PIXELS / ((span[1] - span[0]) * z * z); // in points
  const blocks: Block[] = [];
  let cur: Block | null = null;
  const start = (continues: boolean) => { cur = { placed: [], height: 0, continues }; blocks.push(cur); };
  for (const parts of stanzasOf(k, verses)) {
    const total = parts.reduce((h, p) => h + p[2] - p[1], 0) + (parts.length - 1) * k.pitch;
    if (!cur || (cur as Block).height + k.pitch * 1.2 + total > maxH) start(false);
    parts.forEach((part, i) => {
      const b = cur as Block;
      const h = part[2] - part[1];
      if (b.placed.length && b.height + h > maxH) start(true);
      const c = cur as Block;
      let dy = c.height;
      if (c.placed.length) {
        const prev = c.placed[c.placed.length - 1];
        // The same stanza going on (on the next page, or at a chosen verse
        // further down): its first row one line pitch below the last row
        // before it. A new stanza: a stanza gap below.
        const prevLast = prev.dy + prev.part[4] - prev.part[1];
        dy = i > 0 ? prevLast + k.pitch - (part[3] - part[1]) : Math.max(c.height + k.pitch * 0.9, prevLast + k.pitch * 2 - (part[3] - part[1]));
      }
      c.placed.push({ part, dy });
      c.height = dy + h;
    });
  }
  return blocks;
}

/** The media ids that make up a kalam, or chosen verses of it. */
export function planIds(lib: Library, n: number, verses: number[] | null): string[] {
  const k = lib.kalams[n];
  if (!k) throw new Error('No such kalam in the library.');
  const chosen = verses ? [...new Set(verses)].filter((v) => v >= 0 && v < k.st.length).sort((a, b) => a - b) : null;
  if (chosen && !chosen.length) throw new Error('Choose at least one verse.');
  const sel = encodeVerses(chosen, k.st.length);
  return layout(k, decodeVerses(sel, k.st.length), spanOf(lib)).map((_, i) => `lib${lib.v}-${n}-${sel}-${i}`);
}

/** The block a library media id stands for. Older ids name the verses of
 * their own library version: version 2 counted every row of a run without
 * gaps as a verse (`l2`), version 1 also left out `o` verses at the start. */
export function blockOf(lib: Library, id: string): { k: LibraryKalam; block: Block } {
  const m = LIBRARY_ID.exec(id);
  const version = m ? Number(m[1]) : 0;
  if (!m || version < 1 || version > lib.v) throw new Error('This library verse is from an older library version. Add it again.');
  const k = lib.kalams[Number(m[2])];
  if (!k) throw new Error('No such kalam in the library.');
  const verses: Verses = version < lib.v && version <= 2 && k.l2 ? k.l2 : k;
  const offset = version === 1 ? verses.o ?? k.o ?? 0 : 0;
  const chosen = decodeVerses(m[3], verses.st.length).map((v) => (m[3] === 'all' ? v : v + offset));
  const block = layout({ ...verses, lh: k.lh, pitch: k.pitch }, chosen, spanOf(lib))[Number(m[4])];
  if (!block) throw new Error('No such part of the kalam.');
  return { k, block };
}

/** One render: crops of PDF pages placed into one image. */
export interface RenderJob { page: number; x0: number; y0: number; x1: number; y1: number; dy: number; marks: Marks }
export interface RenderRequest { jobs: RenderJob[]; width: number; height: number; zoom: number }

/** What to render for a block, at the kalam's print zoom. */
export function blockRequest(lib: Library, k: LibraryKalam, block: Block, zoom = zoomOf(k)): RenderRequest {
  const [x0, x1] = spanOf(lib);
  return {
    jobs: block.placed.map(({ part, dy }) => ({ page: part[0], x0, y0: part[1], x1, y1: part[2], dy, marks: lib.marks[part[0]] ?? {} })),
    width: Math.ceil((x1 - x0) * zoom), height: Math.ceil(block.height * zoom) + 2, zoom,
  };
}

/** Small previews: the original title, or one verse (a couplet's verses
 * [first, last] together). */
export function previewRequest(lib: Library, n: number, what: 'title' | [number, number]): RenderRequest {
  const k = lib.kalams[n];
  if (!k) throw new Error('No such kalam in the library.');
  if (what === 'title') {
    const [page, x0, y0, x1, y1] = k.tr;
    const zoom = 2.2;
    return { jobs: [{ page, x0, y0, x1, y1, dy: 0, marks: lib.marks[page] ?? {} }], width: Math.ceil((x1 - x0) * zoom), height: Math.ceil((y1 - y0) * zoom), zoom };
  }
  const [first, last] = what;
  if (!k.st[first] || !k.st[last] || last < first || last - first > 3) throw new Error('No such verse.');
  const zoom = Math.min(2, Math.max(1.2, 40 / Math.max(10, k.lh)));
  const block = layout(k, Array.from({ length: last - first + 1 }, (_, i) => first + i), spanOf(lib))[0];
  return blockRequest(lib, k, block, zoom);
}

/** Bounds of what is not paper in an RGB image (`threshold`: how far from
 * white counts), like sharp's trim. */
export function inkBounds(rgb: Uint8Array, width: number, height: number, threshold: number) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      if (255 - Math.min(rgb[o], rgb[o + 1], rgb[o + 2]) > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? { x: 0, y: 0, w: width, h: height } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
