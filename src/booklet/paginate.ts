// Lays the booklet's content out onto A4 pages. All units are PDF points.
import { Block, Booklet, CATEGORY_FLOW, CATEGORY_LABEL, Category, ImageBlock, Kalam, sectionsOf } from './model';

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
  | { kind: 'fihrist'; number: number; items: FihristItem[]; first: boolean }
  | { kind: 'content'; number: number; items: PlacedItem[] }
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

  // ---- fihrist pages (their count fixes where content numbering starts) ----
  const fihristPages: FihristItem[][] = [[]];
  let fy = FIHRIST_TOP;
  const fpush = (item: FihristItem, h: number) => {
    if (fy + h > FIHRIST_BOTTOM) {
      fihristPages.push([]);
      fy = FIHRIST_TOP;
    }
    fihristPages[fihristPages.length - 1].push(item);
    fy += h;
  };
  const groups: FihristGroup[] = [];
  fpush({ kind: 'head' }, F_HEAD);
  sections.forEach((s, si) => {
    fpush({ kind: 'section', title: s.title, index: si }, F_BAR);
    if (si === 0) fpush({ kind: 'cols' }, F_COLS);
    for (const e of s.entries) {
      const rows = e.kalams.map((k) => ({ id: k.id, name: k.name, opening: !k.name.trim() && k.blocks[0]?.kind === 'image' ? k.blocks[0] : undefined, anchor: kalamAnchor(k), page: 0 }));
      let first = true;
      while (rows.length) {
        const room = Math.floor((FIHRIST_BOTTOM - fy) / F_ROW);
        if (room < 1) {
          fihristPages.push([]);
          fy = FIHRIST_TOP;
          continue;
        }
        const chunk = rows.splice(0, room);
        const group: FihristGroup = { category: e.category, anchor: chunk[0].anchor, first, kalams: chunk };
        groups.push(group);
        fpush({ kind: 'group', group }, chunk.length * F_ROW);
        first = false;
      }
    }
  });
  fpush({ kind: 'end' }, F_END);

  const pages: Page[] = [{ kind: 'cover' }];
  fihristPages.forEach((items, i) => pages.push({ kind: 'fihrist', number: i + 1, items, first: i === 0 }));

  // ---- content pages ----
  const anchorPage = new Map<string, number>();
  let pageNo = fihristPages.length;
  let cur: { kind: 'content'; number: number; items: PlacedItem[] } | null = null;
  let y = 0;
  // The stanza just placed on this page, which the next one is spaced from.
  let prevUnit: Unit | null = null;

  const newPage = () => {
    pageNo += 1;
    cur = { kind: 'content', number: pageNo, items: [] };
    pages.push(cur);
    y = CONTENT.top;
    prevUnit = null;
  };
  const room = () => (cur ? CONTENT.bottom - y : 0);
  const fits = (h: number) => h <= room();
  const place = (item: PlacedItem, h: number) => {
    if (!fits(h)) newPage();
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
    cur!.items.push({ kind: 'block', block: u.block, height: h, imageRect, imageScale: u.s, gap: 0, lead, anchor, titleLink });
    y += lead + h;
    if (anchor) anchorPage.set(anchor, pageNo);
    prevUnit = u;
  };

  /** A stanza moves whole to the next page; only one taller than a page is
   * broken, between rows. */
  const placeUnit = (u: Unit, plan: ReturnType<typeof kalamUnits>, anchor?: string, titleLink?: boolean) => {
    if (!cur) newPage();
    const lead = plan.lead(prevUnit, u);
    if (fits(lead + unitHeight(u))) return emitUnit(u, lead, anchor, titleLink);
    if (unitHeight(u) <= PAGE_ROOM) {
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
    if (withHeading) {
      // Keep the heading with the first stanza.
      if (!fits(HEADING_H + openingHeight(kalam, plan)) && cur?.items.length) newPage();
      place({ kind: 'heading', label: CATEGORY_LABEL[category], anchor }, HEADING_H);
      anchorPage.set(anchor, pageNo);
    }
    prevUnit = null;
    kalam.blocks.forEach((block, i) => {
      const a = i === 0 && !withHeading ? anchor : undefined;
      const units = plan.units.get(block.id);
      if (units) units.forEach((u, j) => placeUnit(u, plan, j === 0 ? a : undefined, j === 0 && selfTitled(kalam) && i === 0));
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

  for (const g of groups) for (const k of g.kalams) k.page = anchorPage.get(k.anchor) ?? 0;

  pages.push({ kind: 'back' });
  return { pages };
}
