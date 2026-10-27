// Phase 1 review booklet: verses lifted from the 5mi Raat reference so the
// layout can be judged before the screenshot pipeline exists.
import { Booklet, Category, Entry, ImageBlock, Kalam, MARATHI_FIXED, VENUES, Venue } from './model';

let seq = 0;
const id = () => `s${++seq}`;

const img = (src: string, width: number, height: number, widthPt: number): ImageBlock => ({
  kind: 'image',
  id: id(),
  src,
  width,
  height,
  widthPt,
});

export const SALAM_ARZ_TEXT = [
  'السلام عليك يا أبا عبد الله ×٢',
  'السلام عليك يا رسول الله',
  'السلام عليك يا أمير المؤمنين',
  'السلام عليك يا فاطمة الزهراء',
  'السلام عليك يا حسن المجتبى',
  'السلام عليك يا أبا الفضل العباس',
  'السلام عليك يا مولاتنا زينب',
  'السلام عليكم يا شهداء كربلاء',
  'السلام عليك يا أبا عبد الله ×٢',
].join('\n');

const kalamsFor = (category: Category): Kalam[] => {
  switch (category) {
    case 'marathi':
      return [
        { id: id(), name: MARATHI_FIXED[0], blocks: [img('/samples/marathi-1.png', 909, 439, 297)] },
        { id: id(), name: MARATHI_FIXED[1], blocks: [img('/samples/marathi-2.png', 1197, 764, 297)] },
        { id: id(), name: MARATHI_FIXED[2], blocks: [img('/samples/marathi-3.png', 764, 574, 297)] },
      ];
    case 'salam':
      return [
        {
          id: id(),
          name: 'لے کے اک قافلہ غم زدہ ساربان',
          blocks: [img('/samples/salam-1a.png', 940, 465, 448), img('/samples/salam-1b.png', 943, 579, 451)],
        },
      ];
    case 'salamArz':
      return [{ id: id(), name: 'سلام عرض', blocks: [{ kind: 'text', id: id(), text: SALAM_ARZ_TEXT, sizePt: 21 }] }];
    default:
      return [];
  }
};

export function sampleBooklet(venue: Venue, date: string): Booklet {
  return {
    date,
    venue,
    sections: VENUES[venue].sections.map((s) => ({
      id: id(),
      title: s.title,
      entries: s.categories.map((category): Entry => ({ id: id(), category, kalams: kalamsFor(category) })),
    })),
  };
}
