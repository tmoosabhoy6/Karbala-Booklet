// Lays the booklet's content out onto A4 pages. All units are PDF points.
import { Block, Booklet, BoxAnchor, CATEGORY_FLOW, CATEGORY_LABEL, Category, ImageBlock, Kalam, TextBox, sectionsOf } from './model';

export const PAGE = { width: 595.32, height: 841.92 };
export const CONTENT = { left: 72, right: 523.32, top: 66, bottom: 780 };
export const CONTENT_WIDTH = CONTENT.right - CONTENT.left;

/** Standard height of one verse line, matched to the 5mi Raat reference. */
export const TARGET_LINE_PT = 34;

const HEADING_H = 58;
const BLOCK_GAP = 8;
/** Extra space between stanzas, as a fraction of the kalam's line pitch. */
const STANZA_EXTRA = 0.55;
/** Clear space above and below a stanza's ink inside its crop (pt). */
const CROP_PAD = 3;
const SEPARATOR_H = 28;
/** A kalam's last lines this tall (pt) or less never go on to a page of
 * their own: the stanza gaps on the page tighten to keep them (to no less
 * than TIGHTEST of their size). */
const TAIL_MAX = 150;
const TIGHTEST = 0.6;
const ORNAMENT_H = 68;
const PAGE_ROOM = CONTENT.bottom - CONTENT.top;

// Fihrist geometry (pt), from the reference.
const FIHRIST_TOP = 49;
const FIHRIST_BOTTOM = 772;
const F_HEAD = 41;
const F_BAR = 36;
const F_COLS = 50;
const F_ROW = 34.7;
const F_END = 46;

/** A full-page image (the default Matam page) carries its own title instead of a heading. */
const selfTitled = (k: Kalam) => k.blocks[0]?.kind === 'image' && !!k.blocks[0].fixedWidthPt;

export type PlacedItem =
  | { kind: 'heading'; label: string; anchor: string }
  | { kind: 'block'; block: Block; height: number; anchor?: string; crop?: [number, number]; imageRect?: { x: number; y: number; w: number; h: number }; imageScale?: number; gap?: number; lead?: number; titleLink?: boolean; textStart?: number; textEnd?: number }
  | { kind: 'separator' }
  | { kind: 'ornament' };

export interface FihristGroup {
  category: Category;
  anchor: string;
  /** False on a continuation chunk, where the label is repeated lightly. */
  first: boolean;
  /** `name` is the kalam's name with its markup; the fihrist shows it plain. */
  kalams: { id: string; name: string; opening?: ImageBlock; anchor: string; page: number }[];
}

export type FihristItem =
  | { kind: 'head' }
  | { kind: 'section'; title: string; index: number }
  | { kind: 'cols' }
  | { kind: 'group'; group: FihristGroup }
  | { kind: 'end' };

export type Page =
  | { kind: 'cover' }
  /** `scale`: below 1 when the fihrist is shrunk to stay on its one page. */
  | { kind: 'fihrist'; number: number; items: FihristItem[]; first: boolean; scale?: number }
  /** `kalams`: each kalam printed on the page, with where it starts on it (pt). */
  | { kind: 'content'; number: number; items: PlacedItem[]; kalams: { id: string; top: number }[] }
  | { kind: 'back' };

export interface Layout {
  pages: Page[];
}

export const kalamAnchor = (k: Kalam) => `k-${k.id}`;

/** Rendered width of an image block in pt. */
export function imageWidthPt(b: ImageBlock): number {
  if (b.fixedWidthPt) return b.fixedWidthPt;
  const natural = (b.width * TARGET_LINE_PT) / Math.max(1, b.lineHeight);
  return Math.min(CONTENT_WIDTH, natural * b.scale);
}

export const ptPerPx = (b: ImageBlock) => imageWidthPt(b) / b.width;

export function textHeight(b: { text: string; sizePt: number }) {
  return b.sizePt * 2.1 * b.text.split('\n').length;
}

const hasContent = (k: Kalam) => k.blocks.length > 0;

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1] ?? 1;

interface Row { top: number; bottom: number; center: number; group: number }

/** Row geometry in px. Media processed before row centres existed fall back
 * to the middle of each row's crop. */
const rowsOf = (b: ImageBlock): Row[] =>
  (b.regions ?? []).map((r) => ({ top: r.top ?? r.y, bottom: r.bottom ?? r.y + r.h, center: r.center ?? r.y + r.h / 2, group: r.group }));

/** Baseline-to-baseline distance of consecutive rows within a stanza (px).
 * The lower quartile ignores any wider stanza spacing. */
function linePitch(rows: Row[]): number | null {
  const pitches = rows.slice(1).flatMap((r, i) => (r.group === rows[i].group ? [r.center - rows[i].center] : [])).sort((a, b) => a - b);
  return pitches.length ? pitches[Math.floor((pitches.length - 1) / 4)] : null;
}

const bandHeight = (b: ImageBlock) => median(b.regions?.map((r) => r.lineHeight) ?? [b.lineHeight]);

/**
 * One lettering size for the whole kalam. The screenshot with the most rows
 * sets the standard 34pt line; every other screenshot is matched to it by
 * line pitch (baseline-to-baseline), which follows the real font size even
 * when fonts differ in weight or ascender height. Ink height is the fallback.
 * Screenshots at the same capture zoom get exactly the same scale; no row is
 * ever sized on its own.
 */
export function kalamImageScales(kalam: Kalam): Map<string, number> {
  const blocks = kalam.blocks.filter((b): b is ImageBlock => b.kind === 'image' && !b.fixedWidthPt);
  const scales = new Map<string, number>();
  if (!blocks.length) return scales;
  const ref = blocks.reduce((a, b) => ((b.regions?.length ?? 1) > (a.regions?.length ?? 1) ? b : a));
  const refPitch = linePitch(rowsOf(ref));
  const relative = (b: ImageBlock) => {
    const byHeight = bandHeight(ref) / bandHeight(b);
    const pitch = linePitch(rowsOf(b));
    let rel = byHeight;
    if (refPitch && pitch) {
      const byPitch = refPitch / pitch;
      // Pitch also carries the source's line spacing; trust it only while it
      // roughly agrees with the ink height.
      if (Math.abs(byPitch / byHeight - 1) <= 0.3) rel = byPitch;
    }
    return Math.abs(rel - 1) < 0.07 ? 1 : rel;
  };
  const base = TARGET_LINE_PT / bandHeight(ref);
  const raw = blocks.map((b) => [b, base * relative(b)] as const);
  // A screenshot too wide for the column shrinks the whole kalam, not itself.
  const fit = Math.min(1, ...raw.map(([b, scale]) => CONTENT_WIDTH / (b.width * scale * b.scale)));
  for (const [b, scale] of raw) scales.set(b.id, scale * fit * b.scale);
  return scales;
}

/** A stanza (or the rows of one that fit on a page) cropped from its screenshot. */
interface Unit {
  block: ImageBlock;
  s: number;
  /** Crop in px. */
  top: number;
  bottom: number;
  rows: Row[];
}
const unitHeight = (u: Unit) => (u.bottom - u.top) * u.s;
const above = (u: Unit) => (u.rows[0].center - u.top) * u.s;
const below = (u: Unit) => (u.bottom - u.rows[u.rows.length - 1].center) * u.s;

/** Every stanza of the kalam, in order, with the kalam's shared pitch (pt). */
function kalamUnits(kalam: Kalam) {
  const scales = kalamImageScales(kalam);
  const units = new Map<string, Unit[]>();
  const pitches: number[] = [];
  for (const b of kalam.blocks) {
    if (b.kind !== 'image' || b.fixedWidthPt || !b.regions?.length) continue;
    const s = scales.get(b.id) ?? ptPerPx(b);
    const rows = rowsOf(b);
    const pitch = linePitch(rows);
    if (pitch) pitches.push(pitch * s);
    const list: Unit[] = [];
    for (const row of rows) {
      const last = list.at(-1);
      if (last && last.rows[0].group === row.group) last.rows.push(row);
      else list.push({ block: b, s, top: 0, bottom: 0, rows: [row] });
    }
    for (const u of list) {
      u.top = Math.max(0, Math.min(...u.rows.map((r) => r.top)) - CROP_PAD / s);
      u.bottom = Math.min(b.height, Math.max(...u.rows.map((r) => r.bottom)) + CROP_PAD / s);
    }
    units.set(b.id, list);
  }
  const pitch = pitches.length ? median(pitches) : TARGET_LINE_PT * 1.3;
  // Centre-to-centre distance across every stanza break of this kalam, so all
  // its stanza gaps are identical whatever spacing each screenshot had.
  const stanza = pitch * (1 + STANZA_EXTRA);
  // A library image that continues the verse before it joins at line pitch.
  const lead = (prev: Unit | null, next: Unit) => {
    if (!prev) return 0;
    if (next.block.continues && units.get(next.block.id)?.[0] === next) return Math.max(0, pitch - below(prev) - above(next));
    return Math.max(CROP_PAD, stanza - below(prev) - above(next));
  };
  return { scales, units, lead };
}

/** Height of a whole kalam laid out from the top of a page (pt). */
function kalamHeight(kalam: Kalam, plan: ReturnType<typeof kalamUnits>) {
  let h = 0;
  let prev: Unit | null = null;
  for (const b of kalam.blocks) {
    const units = plan.units.get(b.id);
    if (units) for (const u of units) { h += plan.lead(prev, u) + unitHeight(u); prev = u; }
    else {
      h += b.kind === 'image' ? b.height * ptPerPx(b) + BLOCK_GAP : textHeight(b) + BLOCK_GAP;
      prev = null;
    }
  }
  return h;
}

export function paginate(doc: Booklet): Layout {
  const sections = sectionsOf(doc)
    .map((s) => ({
      title: s.title,
      entries: s.categories
        .map((category) => ({ category, kalams: (doc.kalams[category] ?? []).filter(hasContent) }))
        .filter((e) => e.kalams.length),
    }))
    .filter((s) => s.entries.length);

  // ---- fihrist: always exactly one page ----
  // Every entry at the reference's sizes; when they would run past the
  // bottom, the whole fihrist (rows, bars, lettering) is scaled down evenly
  // until it fits, rather than spilling a row or the closing ornament onto a
  // second, nearly blank page.
  const fihristItems: FihristItem[] = [];
  let fihristHeight = 0;
  const fpush = (item: FihristItem, h: number) => {
    fihristItems.push(item);
    fihristHeight += h;
  };
  const groups: FihristGroup[] = [];
  fpush({ kind: 'head' }, F_HEAD);
  sections.forEach((s, si) => {
    fpush({ kind: 'section', title: s.title, index: si }, F_BAR);
    if (si === 0) fpush({ kind: 'cols' }, F_COLS);
    for (const e of s.entries) {
      const kalams = e.kalams.map((k) => ({ id: k.id, name: k.name, opening: !k.name.trim() && k.blocks[0]?.kind === 'image' ? k.blocks[0] : undefined, anchor: kalamAnchor(k), page: 0 }));
      const group: FihristGroup = { category: e.category, anchor: kalams[0].anchor, first: true, kalams };
      groups.push(group);
      fpush({ kind: 'group', group }, kalams.length * F_ROW);
    }
  });
  fpush({ kind: 'end' }, F_END);
  const fihristScale = Math.min(1, (FIHRIST_BOTTOM - FIHRIST_TOP) / fihristHeight);

  const pages: Page[] = [{ kind: 'cover' }, { kind: 'fihrist', number: 1, items: fihristItems, first: true, scale: fihristScale }];

  // ---- content pages ----
  const anchorPage = new Map<string, number>();
  let pageNo = 1;
  let cur: Extract<Page, { kind: 'content' }> | null = null;
  let y = 0;
  // The kalam being placed: each page lists the kalams on it (text boxes follow them).
  let kalamId: string | null = null;
  const mark = () => {
    if (cur && kalamId && !cur.kalams.some((k) => k.id === kalamId)) cur.kalams.push({ id: kalamId, top: y });
  };
  // The stanza just placed on this page, which the next one is spaced from.
  let prevUnit: Unit | null = null;
  // Stanza gaps of the kalam being placed, below 1 once its page tightened.
  let leadScale = 1;

  const newPage = () => {
    pageNo += 1;
    cur = { kind: 'content', number: pageNo, items: [], kalams: [] };
    pages.push(cur);
    y = CONTENT.top;
    prevUnit = null;
  };
  const room = () => (cur ? CONTENT.bottom - y : 0);
  const fits = (h: number) => h <= room();
  const place = (item: PlacedItem, h: number) => {
    if (!fits(h)) newPage();
    mark();
    cur!.items.push(item);
    y += h;
    prevUnit = null;
  };
  // The ornament closes a page's content; it is dropped rather than left
  // alone on a fresh page (the reference does the same).
  const placeOrnament = () => {
    if (fits(ORNAMENT_H)) place({ kind: 'ornament' }, ORNAMENT_H);
  };

  const emitUnit = (u: Unit, lead: number, anchor?: string, titleLink?: boolean) => {
    const h = unitHeight(u);
    // The source's baseline spacing and column positions are kept: the whole
    // stanza is one crop at the kalam's scale, so no row is resized alone.
    const imageRect = { x: 0, y: u.top, w: u.block.width, h: u.bottom - u.top, group: u.rows[0].group };
    mark();
    cur!.items.push({ kind: 'block', block: u.block, height: h, imageRect, imageScale: u.s, gap: 0, lead, anchor, titleLink });
    y += lead + h;
    if (anchor) anchorPage.set(anchor, pageNo);
    prevUnit = u;
  };

  /** A stanza moves whole to the next page; only one taller than a page is
   * broken, between rows. */
  /** Room for the kalam's last `tail` pt (this stanza on) by tightening the
   * stanza gaps on this page and in the tail itself; false if they would
   * have to shrink below TIGHTEST. */
  const tighten = (lead: number, tail: number, tailLeads: number) => {
    const page = cur!.items.filter((it): it is Extract<PlacedItem, { kind: 'block' }> => it.kind === 'block' && (it.lead ?? 0) > CROP_PAD);
    const leads = page.reduce((sum, it) => sum + it.lead! - CROP_PAD, 0) + Math.max(0, lead - CROP_PAD) + tailLeads;
    const need = lead + tail - room();
    const k = leads > 0 ? 1 - need / leads : 0;
    if (k < TIGHTEST) return false;
    for (const it of page) {
      const tighter = CROP_PAD + (it.lead! - CROP_PAD) * k;
      y -= it.lead! - tighter;
      it.lead = tighter;
    }
    leadScale *= k;
    return true;
  };
  const scaledLead = (lead: number) => (lead > CROP_PAD ? CROP_PAD + (lead - CROP_PAD) * leadScale : lead);

  const placeUnit = (u: Unit, plan: ReturnType<typeof kalamUnits>, anchor?: string, titleLink?: boolean, tail?: { height: number; leads: number }) => {
    if (!cur) newPage();
    let lead = scaledLead(plan.lead(prevUnit, u));
    if (!fits(lead + unitHeight(u)) && tail && tail.height <= TAIL_MAX && cur!.items.length && tighten(lead, tail.height, tail.leads)) lead = scaledLead(plan.lead(prevUnit, u));
    if (fits(lead + unitHeight(u))) return emitUnit(u, lead, anchor, titleLink);
    // A stanza moves whole to the next page, unless all this page has is
    // its heading: then it starts here and breaks between rows, so the
    // heading is never left alone on an otherwise empty page.
    if (unitHeight(u) <= PAGE_ROOM && cur!.items.some((it) => it.kind === 'block')) {
      newPage();
      return emitUnit(u, 0, anchor, titleLink);
    }
    let rows = u.rows;
    let top = u.top;
    let first = true;
    while (rows.length) {
      const gap = first ? lead : 0;
      const cutAfter = (k: number) => (k === rows.length ? u.bottom : (rows[k - 1].bottom + rows[k].top) / 2);
      let n = rows.length;
      while (n > 0 && gap + (cutAfter(n) - top) * u.s > room()) n--;
      if (!n && cur!.items.length) {
        newPage();
        first = false;
        continue;
      }
      n = Math.max(1, n);
      const part: Unit = { ...u, top, bottom: cutAfter(n), rows: rows.slice(0, n) };
      emitUnit(part, gap, first ? anchor : undefined, first && titleLink);
      first = false;
      top = part.bottom;
      rows = rows.slice(n);
      if (rows.length) newPage();
    }
  };

  const placeImage = (block: ImageBlock, anchor?: string, titleLink?: boolean) => {
    const s = ptPerPx(block);
    let start = 0;
    let isFirst = true;
    while (start < block.height) {
      const rest = (block.height - start) * s;
      if (fits(rest + BLOCK_GAP)) {
        place({ kind: 'block', block, height: rest, crop: [start, block.height], anchor: isFirst ? anchor : undefined, titleLink }, rest + BLOCK_GAP);
        break;
      }
      // Break between lines: the last band that still fits on this page.
      const limit = start + (room() - BLOCK_GAP) / s;
      const bands = block.bands.filter(([a]) => a >= start);
      let cut = -1;
      for (let i = 0; i < bands.length; i++) {
        // Legacy documents also keep couplets together, with no lone last row.
        if ((i + 1) % 2 && i !== bands.length - 1) continue;
        if (bands.length - i - 1 === 1) continue;
        const next = bands[i + 1];
        const end = next ? Math.round((bands[i][1] + next[0]) / 2) : block.height;
        if (end <= limit && end > start) cut = end;
      }
      const pageEmpty = cur === null || (cur as { items: PlacedItem[] }).items.length === 0;
      if (cut < 0) {
        if (!pageEmpty) {
          newPage();
          continue;
        }
        throw new Error('This screenshot cannot fit on a page. Crop it into complete verses or reduce its size.');
      }
      const h = (cut - start) * s;
      place({ kind: 'block', block, height: h, crop: [start, cut], anchor: isFirst ? anchor : undefined, titleLink }, h + BLOCK_GAP);
      if (isFirst && anchor) anchorPage.set(anchor, pageNo);
      isFirst = false;
      start = cut;
      if (start < block.height) newPage();
    }
    if (isFirst && anchor) anchorPage.set(anchor, pageNo);
  };

  /** Height of the kalam's opening that must follow a heading or separator. */
  const openingHeight = (kalam: Kalam, plan: ReturnType<typeof kalamUnits>) => {
    const b = kalam.blocks[0];
    const first = plan.units.get(b.id)?.[0];
    if (first) return Math.min(unitHeight(first), PAGE_ROOM - HEADING_H);
    return b.kind === 'image' ? Math.min(b.height * ptPerPx(b), TARGET_LINE_PT * 2.8) : b.sizePt * 4.2;
  };

  const placeKalam = (category: Category, kalam: Kalam, withHeading: boolean, plan = kalamUnits(kalam)) => {
    const anchor = kalamAnchor(kalam);
    kalamId = kalam.id;
    if (withHeading) {
      // Keep the heading with the first stanza.
      if (!fits(HEADING_H + openingHeight(kalam, plan)) && cur?.items.length) newPage();
      place({ kind: 'heading', label: CATEGORY_LABEL[category], anchor }, HEADING_H);
      anchorPage.set(anchor, pageNo);
    }
    prevUnit = null;
    leadScale = 1;
    // Each stanza's share of what is left of the kalam (all stanzas only:
    // text and whole images break their own way).
    const all = kalam.blocks.flatMap((b) => plan.units.get(b.id) ?? []);
    const tails = new Map<Unit, { height: number; leads: number }>();
    if (kalam.blocks.every((b) => plan.units.has(b.id))) {
      let height = 0, leads = 0;
      for (let j = all.length - 1; j >= 0; j--) {
        height += unitHeight(all[j]);
        tails.set(all[j], { height, leads });
        if (j > 0) { const l = plan.lead(all[j - 1], all[j]); height += l; leads += Math.max(0, l - CROP_PAD); }
      }
    }
    kalam.blocks.forEach((block, i) => {
      const a = i === 0 && !withHeading ? anchor : undefined;
      const units = plan.units.get(block.id);
      if (units) units.forEach((u, j) => placeUnit(u, plan, j === 0 ? a : undefined, j === 0 && selfTitled(kalam) && i === 0, tails.get(u)));
      else if (block.kind === 'image') placeImage(block, a, selfTitled(kalam) && i === 0);
      else {
        const lines = block.text.split('\n');
        for (let start = 0; start < lines.length;) {
          const perLine = block.sizePt * 2.1;
          let count = Math.min(lines.length - start, Math.floor((room() - BLOCK_GAP) / perLine));
          if (count < Math.min(2, lines.length - start)) { newPage(); continue; }
          if (lines.length - start - count === 1 && count > 2) count--;
          const h = count * perLine;
          place({ kind: 'block', block, height: h, anchor: start === 0 ? a : undefined, textStart: start, textEnd: start + count }, h + BLOCK_GAP);
          if (start === 0 && a) anchorPage.set(a, pageNo);
          start += count;
        }
      }
    });
  };

  for (const s of sections) {
    for (const e of s.entries) {
      const flow = CATEGORY_FLOW[e.category] === 'flow';
      e.kalams.forEach((kalam, i) => {
        kalamId = kalam.id;
        if (flow && i > 0) {
          // A kalam that fits on one page is never split: it moves whole to
          // the next page instead. A longer one starts where it is.
          const plan = kalamUnits(kalam);
          const total = kalamHeight(kalam, plan);
          const together = total <= PAGE_ROOM;
          if (fits(SEPARATOR_H + (together ? total : openingHeight(kalam, plan)))) place({ kind: 'separator' }, SEPARATOR_H);
          else newPage();
          placeKalam(e.category, kalam, false, plan);
        } else {
          newPage();
          placeKalam(e.category, kalam, !selfTitled(kalam));
        }
        if (!flow || i === e.kalams.length - 1) placeOrnament();
      });
    }
  }

  // A page left with nothing on it (no heading, no lettering) is never
  // printed: it is dropped and the pages after it are numbered on.
  const renumber = new Map<number, number>();
  let printed = 1;
  const kept = pages.filter((p) => {
    if (p.kind !== 'content') return true;
    if (!p.items.some((it) => it.kind === 'heading' || it.kind === 'block')) return false;
    renumber.set(p.number, ++printed);
    p.number = printed;
    return true;
  });
  for (const g of groups) for (const k of g.kalams) k.page = renumber.get(anchorPage.get(k.anchor) ?? 0) ?? 0;

  kept.push({ kind: 'back' });
  return { pages: kept };
}

// ---- text boxes ----

/** Each kalam's pages: the page index and where it starts on that page. */
function kalamPages(layout: Layout) {
  const out = new Map<string, { index: number; top: number }[]>();
  layout.pages.forEach((p, index) => {
    if (p.kind !== 'content') return;
    for (const k of p.kalams) out.set(k.id, [...(out.get(k.id) ?? []), { index, top: k.top }]);
  });
  return out;
}

const fixedPage = (layout: Layout, page: 'cover' | 'fihrist' | 'back') =>
  page === 'cover' ? 0 : page === 'back' ? layout.pages.length - 1 : layout.pages.findIndex((p) => p.kind === 'fihrist');

/**
 * Where each text box shows: with the kalam it annotates (on the same page
 * of that kalam, the same distance below where the kalam starts there), or
 * on its own page (cover, fihrist, back). `orphans`: boxes whose kalam is no
 * longer printed (removed, or emptied), which show nowhere until it is back.
 */
export function placeBoxes(boxes: TextBox[] | undefined, layout: Layout) {
  const byPage = new Map<number, { box: TextBox; offset: number }[]>();
  const orphans: TextBox[] = [];
  const pages = kalamPages(layout);
  for (const box of boxes ?? []) {
    let index: number, offset = 0;
    if (box.anchor && 'kalam' in box.anchor) {
      const list = pages.get(box.anchor.kalam);
      if (!list) { orphans.push(box); continue; }
      const at = list[Math.min(box.anchor.part, list.length - 1)];
      index = at.index;
      offset = at.top;
    } else if (box.anchor) index = fixedPage(layout, box.anchor.page);
    else index = box.page;
    if (index < 0 || index >= layout.pages.length) { orphans.push(box); continue; }
    byPage.set(index, [...(byPage.get(index) ?? []), { box, offset }]);
  }
  return { byPage, orphans };
}

/** What a box placed at `y` (pt from the page's top) on page `index`
 * belongs to, and the y it then keeps (from where its kalam starts). */
export function anchorAt(layout: Layout, index: number, y: number): { anchor?: BoxAnchor; y: number } {
  const page = layout.pages[index];
  if (!page) return { y };
  if (page.kind !== 'content') return { anchor: { page: page.kind }, y };
  const on = page.kalams;
  if (!on.length) return { y };
  const kalam = [...on].reverse().find((k) => k.top <= y) ?? on[0];
  const part = (kalamPages(layout).get(kalam.id) ?? []).findIndex((p) => p.index === index);
  return { anchor: { kalam: kalam.id, part: Math.max(0, part) }, y: +(y - kalam.top).toFixed(1) };
}

/** Boxes from before anchors were kept get one, from where they show now. */
export function anchorBoxes(doc: Booklet): Booklet {
  if (!doc.textBoxes?.some((b) => !b.anchor)) return doc;
  const layout = paginate(doc);
  return { ...doc, textBoxes: doc.textBoxes.map((b) => (b.anchor ? b : { ...b, ...anchorAt(layout, b.page, b.y) })) };
}
