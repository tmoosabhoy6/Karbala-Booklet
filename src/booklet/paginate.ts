// Lays the booklet's content out onto A4 pages. All units are PDF points.
import { Booklet, Block, CATEGORY_FLOW, CATEGORY_LABEL, Category, Entry, Kalam } from './model';

export const PAGE = { width: 595.32, height: 841.92 };
export const CONTENT = { left: 72, right: 523.32, top: 72, bottom: 772 };
export const CONTENT_WIDTH = CONTENT.right - CONTENT.left;

const HEADING_H = 50;
const BLOCK_GAP = 10;
const SEPARATOR_H = 24;
const ORNAMENT_H = 26 + 28;

export type PlacedItem =
  | { kind: 'heading'; label: string; anchor?: string }
  | { kind: 'block'; block: Block; anchor?: string; height: number }
  | { kind: 'separator' }
  | { kind: 'ornament' };

export type Page =
  | { kind: 'cover' }
  | { kind: 'fihrist'; number: number }
  | { kind: 'content'; number: number; items: PlacedItem[] }
  | { kind: 'back' };

export interface FihristRow {
  category: Category;
  entryAnchor: string;
  kalams: { name: string; anchor: string; page: number }[];
}

export interface Layout {
  pages: Page[];
  fihrist: { title: string; rows: FihristRow[] }[];
}

export const kalamAnchor = (k: Kalam) => `k-${k.id}`;

export function blockHeight(b: Block): number {
  if (b.kind === 'image') return (b.widthPt * b.height) / b.width;
  return b.sizePt * 2.1 * Math.max(1, b.text.split('\n').length);
}

const hasContent = (k: Kalam) => k.blocks.length > 0;

export function paginate(doc: Booklet): Layout {
  const pages: Page[] = [{ kind: 'cover' }, { kind: 'fihrist', number: 1 }];
  const anchorPage = new Map<string, number>();
  let pageNo = 1;
  let cur: { kind: 'content'; number: number; items: PlacedItem[] } | null = null;
  let y = 0;

  const newPage = () => {
    pageNo += 1;
    cur = { kind: 'content', number: pageNo, items: [] };
    pages.push(cur);
    y = CONTENT.top;
  };
  const fits = (h: number) => cur !== null && y + h <= CONTENT.bottom;
  const place = (item: PlacedItem, h: number) => {
    if (!fits(h)) newPage();
    cur!.items.push(item);
    y += h;
  };
  // The end ornament closes a page's content; it is dropped rather than left
  // alone on a fresh page (the reference does the same on its Marathi page).
  const placeOrnament = () => {
    if (fits(ORNAMENT_H)) place({ kind: 'ornament' }, ORNAMENT_H);
  };

  const placeKalam = (entry: Entry, kalam: Kalam, withHeading: boolean) => {
    const anchor = kalamAnchor(kalam);
    if (withHeading) {
      // Keep the heading with at least the first block.
      const first = kalam.blocks[0] ? blockHeight(kalam.blocks[0]) : 0;
      if (!fits(HEADING_H + first)) newPage();
      place({ kind: 'heading', label: CATEGORY_LABEL[entry.category], anchor }, HEADING_H);
      anchorPage.set(anchor, pageNo);
    }
    kalam.blocks.forEach((block, i) => {
      const h = blockHeight(block);
      const isFirst = i === 0 && !withHeading;
      place({ kind: 'block', block, height: h, anchor: isFirst ? anchor : undefined }, h + BLOCK_GAP);
      if (isFirst) anchorPage.set(anchor, pageNo);
    });
  };

  const fihrist: Layout['fihrist'] = [];

  for (const section of doc.sections) {
    const rows: FihristRow[] = [];
    for (const entry of section.entries) {
      const kalams = entry.kalams.filter(hasContent);
      if (!kalams.length) continue;
      const flow = CATEGORY_FLOW[entry.category] === 'flow';
      kalams.forEach((kalam, i) => {
        if (flow) {
          if (i === 0) {
            newPage();
            placeKalam(entry, kalam, true);
          } else {
            place({ kind: 'separator' }, SEPARATOR_H);
            placeKalam(entry, kalam, false);
          }
          if (i === kalams.length - 1) placeOrnament();
        } else {
          newPage();
          placeKalam(entry, kalam, true);
          placeOrnament();
        }
      });
      rows.push({
        category: entry.category,
        entryAnchor: kalamAnchor(kalams[0]),
        kalams: kalams.map((k) => ({ name: k.name, anchor: kalamAnchor(k), page: 0 })),
      });
    }
    if (rows.length) fihrist.push({ title: section.title, rows });
  }

  for (const s of fihrist) for (const r of s.rows) for (const k of r.kalams) k.page = anchorPage.get(k.anchor) ?? 0;

  pages.push({ kind: 'back' });
  return { pages, fihrist };
}
