// Booklet document model and the two venue templates.
//
// Content is stored per category, not per section: the venue only decides
// which sections exist and in what order, so switching venue keeps every
// screenshot you have added.

export type Venue = 'haram' | 'najmi';

export type Category = 'quran' | 'marathi' | 'nasihat' | 'salam' | 'noha' | 'matam' | 'salamArz' | 'ratha' | 'madh';

export interface ImageBlock {
  kind: 'image';
  id: string;
  /** Processed screenshot on the server: /media/<mediaId>.svg?v=<rev> */
  mediaId: string;
  rev: number;
  width: number;
  height: number;
  /** Text-line bands [top, bottom] in px; pages break between them. */
  bands: [number, number][];
  /** Median line height in px, used to give every screenshot the same text size. */
  lineHeight: number;
  /** User size adjustment, 1 = standard text size. */
  scale: number;
  /** Fixed width in pt (used by fixed full-page content instead of line-height sizing). */
  fixedWidthPt?: number;
}

export interface TextBlock {
  kind: 'text';
  id: string;
  /** Lines separated by \n; {as} and {saw} insert the small honorifics. */
  text: string;
  sizePt: number;
}

export type Block = ImageBlock | TextBlock;

export interface Kalam {
  id: string;
  /** Name in the fihrist's كلام column. */
  name: string;
  blocks: Block[];
  /** 'name': the name is fixed (the three Marathi); 'all': the whole kalam is fixed content. */
  fixed?: 'name' | 'all';
  /** Key under which this kalam can be pinned as a default for new booklets. */
  slot?: string;
}

/**
 * Typed replacement for a piece of generated page text (a heading, a fihrist
 * label, a page number…). It applies only while the generated text is still
 * `from`, so an edited title lapses by itself when the date changes.
 */
export interface TextOverride {
  from: string;
  text: string;
  /** Font size relative to the generated text, 1 = unchanged. */
  scale?: number;
}

/** A free text box placed on a page. */
export interface TextBox {
  id: string;
  /** Index into the laid-out pages (0 = cover). */
  page: number;
  /** Centre of the box's top edge, in pt from the page's top-left corner. */
  x: number;
  y: number;
  /** Lines separated by \n; same markup as typed text. */
  text: string;
  sizePt: number;
  color: string;
}

export interface Booklet {
  version: 2;
  /** ISO date (yyyy-mm-dd) of the day the majlis is held. */
  date: string;
  venue: Venue;
  kalams: Record<Category, Kalam[]>;
  /** Edits to generated page text, keyed by where the text sits (see Booklet.tsx). */
  overrides?: Record<string, TextOverride>;
  textBoxes?: TextBox[];
}

/** Text box colours: the booklet's black, heading maroon, fihrist navy and gold. */
export const TEXT_COLORS = ['#000000', '#8c1a24', '#3a456a', '#c18144'];

/**
 * Edits that belong to the template rather than to one night's booklet (cover
 * wording, fihrist labels, Salam Arz lines). A new booklet keeps these and
 * drops the rest (page headings, page numbers, text boxes).
 */
export const templateOverrides = (o: Booklet['overrides'] = {}) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => /^(cover|fihrist|line)\./.test(k)));

/** A pinned default: what a slot is pre-filled with in every new booklet. */
export type Defaults = Record<string, { category: Category; name: string; blocks: Block[] }>;

/** Heading used on the content page and in the fihrist's ترتيب column. */
export const CATEGORY_LABEL: Record<Category, string> = {
  quran: 'القرآن الكريم',
  marathi: 'المراثي المباركة',
  nasihat: 'النصيحة الشريفة',
  salam: 'سلام',
  noha: 'ماتمي نوحه',
  matam: 'ماتم',
  salamArz: 'سلام عرض',
  ratha: 'رثاء',
  madh: 'مدح',
};

export const CATEGORY_HINT: Record<Category, string> = {
  quran: 'Quran Kareem (optional)',
  marathi: 'Marathi Mubaraka',
  nasihat: 'Nasihat Sharifa (optional)',
  salam: 'Salam',
  noha: 'Matami Noha',
  matam: 'Matam: Husain Husain, Panjatan (fixed)',
  salamArz: 'Salam Arz (fixed)',
  ratha: 'Ratha',
  madh: 'Madh',
};

/**
 * `flow`: kalams in this category share pages, separated by a thin line,
 * under one heading (Marathi). `page`: each kalam starts a new page with its
 * own heading and ends with the ornament.
 */
export const CATEGORY_FLOW: Record<Category, 'flow' | 'page'> = {
  quran: 'page',
  marathi: 'flow',
  nasihat: 'page',
  salam: 'page',
  noha: 'page',
  matam: 'page',
  salamArz: 'page',
  ratha: 'page',
  madh: 'page',
};

/** Categories whose kalams you can add (the rest are fixed). */
export const CATEGORY_ADDABLE: Record<Category, boolean> = {
  quran: true,
  marathi: true,
  nasihat: true,
  salam: true,
  noha: true,
  matam: false,
  salamArz: false,
  ratha: true,
  madh: true,
};

export const VENUES: Record<Venue, { label: string; location: string; sections: { title: string; categories: Category[] }[] }> = {
  haram: {
    label: 'Imam Husain AS Haram Mubarak',
    location: 'امام حسين {as} حرم مبارك (Gate no.6)',
    sections: [
      { title: 'بيٹهي نے تلاوة', categories: ['quran', 'marathi', 'nasihat', 'salam', 'noha', 'matam'] },
      { title: 'كهڑا رهي نے تلاوة (فقط مردو كهڑا تهائي)', categories: ['salamArz', 'ratha', 'madh'] },
    ],
  },
  najmi: {
    label: 'Najmi Masjid',
    location: 'نجمي مسجد',
    sections: [
      { title: 'بيٹهي نے تلاوة', categories: ['quran', 'marathi', 'nasihat', 'salam'] },
      { title: 'كهڑا رهي نے ماتم درميان تلاوة', categories: ['noha', 'matam', 'salamArz', 'ratha', 'madh'] },
    ],
  },
};

export const ALL_CATEGORIES: Category[] = ['quran', 'marathi', 'nasihat', 'salam', 'noha', 'matam', 'salamArz', 'ratha', 'madh'];

export const MARATHI_FIXED = ['يا سيد الشهداء', 'فلك الحسين بكربلاء', 'ذكر الحسين خير زاد الذاكرين'];
export const SAWARI_NAME = 'سواري غم ني اوي كربلاء ما';

export const SALAM_ARZ_TEXT = [
  'السلام عليك يا أبا عبد الله{as} ×٢',
  'السلام عليك يا رسول الله{saw}',
  'السلام عليك يا أمير المؤمنين{as}',
  'السلام عليك يا فاطمة الزهراء{as}',
  'السلام عليك يا حسن المجتبى{as}',
  'السلام عليك يا أبا الفضل العباس{as}',
  'السلام عليك يا مولاتنا زينب{as}',
  'السلام عليكم يا شهداء كربلاء{as}',
  'السلام عليك يا أبا عبد الله{as} ×٢',
].join('\n');

export const MATAM_NAME = 'حسين حسين، پنجتن ماتم';
export const MATAM_MEDIA_ID = 'fixed-matam';

export const uid = () => Math.random().toString(36).slice(2, 10);

export interface MediaMeta {
  id: string;
  rev: number;
  width: number;
  height: number;
  bands: [number, number][];
  lineHeight: number;
}

export const imageBlockFrom = (m: MediaMeta, extra: Partial<ImageBlock> = {}): ImageBlock => ({
  kind: 'image',
  id: uid(),
  mediaId: m.id,
  rev: m.rev,
  width: m.width,
  height: m.height,
  bands: m.bands,
  lineHeight: m.lineHeight,
  scale: 1,
  ...extra,
});

/** A fresh booklet for `date`/`venue`, with fixed content and pinned defaults filled in. */
export function createBooklet(date: string, venue: Venue, defaults: Defaults, matam: MediaMeta | null): Booklet {
  const kalams = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, [] as Kalam[]])) as Record<Category, Kalam[]>;
  const fromSlot = (slot: string, name: string, fixed?: Kalam['fixed']): Kalam => {
    const d = defaults[slot];
    return { id: uid(), slot, fixed, name: d && !fixed ? d.name : name, blocks: d ? cloneBlocks(d.blocks) : [] };
  };
  kalams.marathi = [
    ...MARATHI_FIXED.map((name, i) => fromSlot(`marathi:${i + 1}`, name, 'name')),
    fromSlot('marathi:sawari', SAWARI_NAME),
  ];
  // Fixed content has fixed ids, so text edits keyed on them survive a reload.
  kalams.salamArz = [{ id: 'salam-arz', name: 'سلام عرض', fixed: 'all', blocks: [{ kind: 'text', id: 'salam-arz', text: SALAM_ARZ_TEXT, sizePt: 22 }] }];
  kalams.matam = [
    {
      id: 'matam',
      name: MATAM_NAME,
      fixed: 'all',
      blocks: matam ? [imageBlockFrom(matam, { fixedWidthPt: 426 })] : [],
    },
  ];
  // Any other pinned kalams (e.g. a regular Salam) are added to their category.
  for (const [slot, d] of Object.entries(defaults)) {
    if (slot.startsWith('marathi:') && !slot.startsWith('marathi:x')) continue;
    kalams[d.category].push({ id: uid(), slot, name: d.name, blocks: cloneBlocks(d.blocks) });
  }
  return { version: 2, date, venue, kalams };
}

export const cloneBlocks = (blocks: Block[]): Block[] => blocks.map((b) => ({ ...b, id: uid() }));
