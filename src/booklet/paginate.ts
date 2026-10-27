// Lays the booklet's content out onto A4 pages. All units are PDF points.
import { Block, Booklet, CATEGORY_FLOW, CATEGORY_LABEL, Category, ImageBlock, Kalam, VENUES } from './model';

export const PAGE = { width: 595.32, height: 841.92 };
export const CONTENT = { left: 72, right: 523.32, top: 66, bottom: 780 };
export const CONTENT_WIDTH = CONTENT.right - CONTENT.left;

/** Standard height of one verse line, matched to the 5mi Raat reference. */
export const TARGET_LINE_PT = 34;

const HEADING_H = 58;
const BLOCK_GAP = 8;
const SEPARATOR_H = 26;
const ORNAMENT_H = 54;

// Fihrist geometry (pt), from the reference.
const FIHRIST_TOP = 49;
const FIHRIST_BOTTOM = 772;
const F_HEAD = 41;
const F_BAR = 36;
const F_COLS = 50;
const F_ROW = 34.7;
const F_END = 46;

/** Categories whose fixed content carries its own title instead of a heading. */
const NO_HEADING: Partial<Record<Category, boolean>> = { matam: true };

export type PlacedItem =
  | { kind: 'heading'; label: string; anchor: string }
  | { kind: 'block'; block: Block; height: number; anchor?: string; crop?: [number, number]; imageRect?: { x: number; y: number; w: number; h: number }; imageScale?: number; gap?: number; titleLink?: boolean; fixed?: boolean; textStart?: number; textEnd?: number }
  | { kind: 'separator' }
  | { kind: 'ornament' };

export interface FihristGroup {
  category: Category;
  anchor: string;
  /** False on a continuation chunk, where the label is repeated lightly. */
  first: boolean;
  /** `name` is the kalam's name with its markup; the fihrist shows it plain. */
  kalams: { id: string; name: string; opening?: ImageBlock; fixed?: Kalam['fixed']; anchor: string; page: number }[];
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

export function paginate(doc: Booklet): Layout {
  const sections = VENUES[doc.venue].sections
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
      const rows = e.kalams.map((k) => ({ id: k.id, name: k.name, opening: !k.name.trim() && k.blocks[0]?.kind === 'image' ? k.blocks[0] : undefined, fixed: k.fixed, anchor: kalamAnchor(k), page: 0 }));
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

  const newPage = () => {
    pageNo += 1;
    cur = { kind: 'content', number: pageNo, items: [] };
    pages.push(cur);
    y = CONTENT.top;
  };
  const room = () => (cur ? CONTENT.bottom - y : 0);
  const fits = (h: number) => h <= room();
  const place = (item: PlacedItem, h: number) => {
    if (!fits(h)) newPage();
    cur!.items.push(item);
    y += h;
  };
  // The ornament closes a page's content; it is dropped rather than left
  // alone on a fresh page (the reference does the same).
  const placeOrnament = () => {
    if (fits(ORNAMENT_H)) place({ kind: 'ornament' }, ORNAMENT_H);
  };

  const placeImage = (block: ImageBlock, anchor?: string, titleLink?: boolean) => {
    if (block.regions?.length && !block.fixedWidthPt) {
      const groups = new Map<number, typeof block.regions>();
      for (const r of block.regions) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
      let first = true;
      for (const rows of groups.values()) {
        const sizes = rows.map((r) => Math.min(CONTENT_WIDTH / r.w, TARGET_LINE_PT * block.scale / Math.max(1, r.lineHeight)));
        const total = rows.reduce((h, r, i) => h + r.h * sizes[i] + BLOCK_GAP, 0);
        // Even an unusually tall couplet must fit within the printable page.
        const afterHeading = first && (cur as { items: PlacedItem[] } | null)?.items.at(-1)?.kind === 'heading';
        const shrink = Math.min(1, (CONTENT.bottom - CONTENT.top - (afterHeading ? HEADING_H : 0)) / total);
        if (!fits(total * shrink)) newPage();
        rows.forEach((r, i) => {
          const s = sizes[i] * shrink;
          const h = r.h * s;
          place({ kind: 'block', block, height: h, imageRect: r, imageScale: s, gap: BLOCK_GAP * shrink, anchor: first ? anchor : undefined, titleLink: first && titleLink }, h + BLOCK_GAP * shrink);
          if (first && anchor) anchorPage.set(anchor, pageNo);
          first = false;
        });
      }
      return;
    }
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

  const placeKalam = (category: Category, kalam: Kalam, withHeading: boolean) => {
    const anchor = kalamAnchor(kalam);
    if (withHeading) {
      // Keep the heading with at least one line of the first block.
      const b = kalam.blocks[0];
      const firstLine = b.kind === 'image' ? (b.regions?.length ? b.regions.filter((r) => r.group === b.regions![0].group).reduce((h, r) => h + r.h * Math.min(CONTENT_WIDTH / r.w, TARGET_LINE_PT * b.scale / r.lineHeight) + BLOCK_GAP, 0) : Math.min(b.height * ptPerPx(b), TARGET_LINE_PT * 2.8)) : b.sizePt * 4.2;
      if (!fits(HEADING_H + firstLine) && cur?.items.length) newPage();
      place({ kind: 'heading', label: CATEGORY_LABEL[category], anchor }, HEADING_H);
      anchorPage.set(anchor, pageNo);
    }
    kalam.blocks.forEach((block, i) => {
      const a = i === 0 && !withHeading ? anchor : undefined;
      if (block.kind === 'image') placeImage(block, a, NO_HEADING[category] && i === 0);
      else {
        const lines = block.text.split('\n');
        for (let start = 0; start < lines.length;) {
          const perLine = block.sizePt * 2.1;
          let count = Math.min(lines.length - start, Math.floor((room() - BLOCK_GAP) / perLine));
          if (count < Math.min(2, lines.length - start)) { newPage(); continue; }
          if (lines.length - start - count === 1 && count > 2) count--;
          const h = count * perLine;
          place({ kind: 'block', block, height: h, anchor: start === 0 ? a : undefined, fixed: kalam.fixed === 'all', textStart: start, textEnd: start + count }, h + BLOCK_GAP);
          if (start === 0 && a) anchorPage.set(a, pageNo);
          start += count;
        }
      }
    });
  };

  for (const s of sections) {
    for (const e of s.entries) {
      const flow = CATEGORY_FLOW[e.category] === 'flow';
      const heading = !NO_HEADING[e.category];
      e.kalams.forEach((kalam, i) => {
        if (flow && i > 0) {
          const b = kalam.blocks[0];
          const lead = b.kind === 'image' ? TARGET_LINE_PT * 2.8 : b.sizePt * 4.2;
          if (fits(SEPARATOR_H + lead)) place({ kind: 'separator' }, SEPARATOR_H);
          else newPage();
          placeKalam(e.category, kalam, false);
        } else {
          newPage();
          placeKalam(e.category, kalam, heading);
        }
        if (!flow || i === e.kalams.length - 1) placeOrnament();
      });
    }
  }

  for (const g of groups) for (const k of g.kalams) k.page = anchorPage.get(k.anchor) ?? 0;

  pages.push({ kind: 'back' });
  return { pages };
}
