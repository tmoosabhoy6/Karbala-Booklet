// Booklet document model and the two venue templates.

export type Venue = 'haram' | 'najmi';

export type Category =
  | 'quran'
  | 'marathi'
  | 'nasihat'
  | 'salam'
  | 'noha'
  | 'matam'
  | 'salamArz'
  | 'ratha'
  | 'madh';

export interface ImageBlock {
  kind: 'image';
  id: string;
  src: string;
  /** Natural pixel size, used for pagination. */
  width: number;
  height: number;
  /** Rendered width in pt; height follows the aspect ratio. */
  widthPt: number;
}

export interface TextBlock {
  kind: 'text';
  id: string;
  text: string;
  sizePt: number;
  color?: string;
}

export type Block = ImageBlock | TextBlock;

export interface Kalam {
  id: string;
  /** Name shown in the fihrist's كلام column. */
  name: string;
  blocks: Block[];
}

export interface Entry {
  id: string;
  category: Category;
  kalams: Kalam[];
}

export interface Section {
  id: string;
  title: string;
  entries: Entry[];
}

export interface Booklet {
  /** ISO date (yyyy-mm-dd) of the day the majlis is held. */
  date: string;
  venue: Venue;
  sections: Section[];
}

/** Heading used both on the content page and in the fihrist's ترتيب column. */
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

/**
 * How kalams inside one entry are joined: `flow` keeps them on the same page
 * separated by a thin line (Marathi); `page` starts each kalam on a new page
 * and closes it with the end ornament (Salam, Noha, …).
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

export const VENUES: Record<Venue, { location: string; sections: { title: string; categories: Category[] }[] }> = {
  haram: {
    location: 'امام حسين {as} حرم مبارك (Gate no.6)',
    sections: [
      { title: 'بيٹهي نے تلاوة', categories: ['quran', 'marathi', 'nasihat', 'salam', 'noha', 'matam'] },
      { title: 'كهڑا رهي نے تلاوة (فقط مردو كهڑا تهائے)', categories: ['salamArz', 'ratha', 'madh'] },
    ],
  },
  najmi: {
    location: 'نجمي مسجد',
    sections: [
      { title: 'بيٹهي نے تلاوة', categories: ['quran', 'marathi', 'nasihat', 'salam'] },
      { title: 'كهڑا رهي نے ماتم درميان تلاوة', categories: ['noha', 'matam', 'salamArz', 'ratha', 'madh'] },
    ],
  },
};

export const MARATHI_FIXED = ['يا سيد الشهداء', 'فلك الحسين بكربلاء', 'ذكر الحسين خير زاد الذاكرين'];
