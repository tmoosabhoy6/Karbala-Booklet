// Booklet document model, the two cities and their venue templates.
//
// Content is stored per category, not per section: the venue only decides
// which sections exist and in what order (the booklet can reorder them), so
// switching venue keeps every screenshot you have added. Each city keeps its
// own working booklet and pinned defaults; the city decides the artwork
// (Karbala maroon, Najaf green) and its built-in default content.

export type City = 'karbala' | 'najaf';
export type Venue = 'haram' | 'najmi' | 'najaf';

export type Category = 'quran' | 'qasida' | 'naat' | 'manqabat' | 'marathi' | 'nasihat' | 'salam' | 'noha' | 'matam' | 'dua' | 'salamArz' | 'ratha' | 'madh';

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
  format?: 'png' | 'svg';
  regions?: ImageRegion[];
  suggestedName?: string;
  warnings?: string[];
  opening?: { x: number; y: number; w: number; h: number };
  /** The opening words exist as a ready navy image (see openingSrc). */
  openingImage?: boolean;
  /** Zikre Husain library: this image's first verse runs on from the image
   * before it (a verse longer than one image), so no stanza gap between them. */
  continues?: boolean;
}

export interface ImageRegion {
  x: number; y: number; w: number; h: number; lineHeight: number; group: number;
  /** Ink band and ink mass centre of the row, in px (older media lack them). */
  top?: number; bottom?: number; center?: number;
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
  /** Version 2 only, replaced by default content on load (see upgradeBooklet):
   * 'name' fixed a Marathi name, 'all' made the kalam unchangeable. */
  fixed?: 'name' | 'all';
  /** Key under which this kalam can be pinned as a default for new booklets
   * (built-in defaults use BUILTIN_SLOTS). */
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
  version: 2 | 3;
  /** ISO date (yyyy-mm-dd) of the day the majlis is held. */
  date: string;
  venue: Venue;
  kalams: Record<Category, Kalam[]>;
  /** Edits to generated page text, keyed by where the text sits (see Booklet.tsx). */
  overrides?: Record<string, TextOverride>;
  textBoxes?: TextBox[];
  /** Category order per venue, one list per section (see sectionsOf). */
  order?: Partial<Record<Venue, Category[][]>>;
}

/** Text box colours: the booklet's black, heading maroon (Najaf: green), fihrist navy and gold. */
export const TEXT_COLORS: Record<City, string[]> = {
  karbala: ['#000000', '#8c1a24', '#3a456a', '#c18144'],
  najaf: ['#000000', '#164d2c', '#3a456a', '#c18144'],
};

/**
 * Edits that belong to the template rather than to one night's booklet (cover
 * wording, fihrist labels). A new booklet keeps these and drops the rest
 * (page headings, page numbers, text boxes). Default content such as the
 * Salam Arz keeps its edits by being pinned (★).
 */
export const templateOverrides = (o: Booklet['overrides'] = {}) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => /^(cover|fihrist)\./.test(k)));

/** A pinned default: what a slot is pre-filled with in every new booklet.
 * `off` unpins a built-in default (see effectiveDefaults). */
export type Defaults = Record<string, { category: Category; name: string; blocks: Block[]; off?: boolean }>;

/** Heading used on the content page and in the fihrist's ترتيب column. */
export const CATEGORY_LABEL: Record<Category, string> = {
  quran: 'القرآن الكريم',
  qasida: 'القصيدة المباركة',
  naat: 'النعت',
  manqabat: 'منقبة',
  marathi: 'المراثي المباركة',
  nasihat: 'النصيحة الشريفة',
  salam: 'سلام',
  noha: 'ماتمي نوحه',
  matam: 'ماتم',
  dua: 'دعاء',
  salamArz: 'سلام عرض',
  ratha: 'رثاء',
  madh: 'مدح',
};

export const CATEGORY_HINT: Record<Category, string> = {
  quran: 'Quran Kareem (optional)',
  qasida: 'Qasida Mubaraka (optional)',
  naat: 'Naat (optional)',
  manqabat: 'Manqabat (optional)',
  marathi: 'Marathi Mubaraka',
  nasihat: 'Nasihat Sharifa (optional)',
  salam: 'Salam',
  noha: 'Matami Noha',
  matam: 'Matam (default: Husain Husain, Panjatan)',
  dua: 'Dua (default: Allahumma anta thiqati)',
  salamArz: 'Salam Arz (default)',
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
  qasida: 'page',
  naat: 'page',
  manqabat: 'page',
  marathi: 'flow',
  nasihat: 'page',
  salam: 'page',
  noha: 'page',
  matam: 'page',
  dua: 'page',
  salamArz: 'page',
  ratha: 'page',
  madh: 'page',
};

export const VENUES: Record<Venue, { city: City; label: string; location: string; sections: { title: string; categories: Category[] }[] }> = {
  haram: {
    city: 'karbala',
    label: 'Imam Husain AS Haram Mubarak',
    location: 'امام حسين {as} حرم مبارك (Gate no.6)',
    sections: [
      { title: 'بيٹهي نے تلاوة', categories: ['quran', 'qasida', 'naat', 'manqabat', 'marathi', 'nasihat', 'salam', 'noha', 'matam', 'dua'] },
      { title: 'كهڑا رهي نے تلاوة (فقط مردو كهڑا تهائي)', categories: ['salamArz', 'ratha', 'madh'] },
    ],
  },
  najmi: {
    city: 'karbala',
    label: 'Najmi Masjid',
    location: 'نجمي مسجد',
    sections: [
      { title: 'بيٹهي نے تلاوة', categories: ['quran', 'qasida', 'naat', 'manqabat', 'marathi', 'nasihat', 'salam'] },
      { title: 'كهڑا رهي نے ماتم درميان تلاوة', categories: ['noha', 'matam', 'dua', 'salamArz', 'ratha', 'madh'] },
    ],
  },
  // The Haram order (without the Dua), with the Najmi Masjid's heading for the standing part.
  najaf: {
    city: 'najaf',
    label: 'Amirul Mumineen AS Haram Mubarak',
    location: 'امير المؤمنين {as} نا حرم مبارك',
    sections: [
      { title: 'بيٹهي نے تلاوة', categories: ['quran', 'qasida', 'naat', 'manqabat', 'marathi', 'nasihat', 'salam', 'noha', 'matam'] },
      { title: 'كهڑا رهي نے ماتم درميان تلاوة', categories: ['salamArz', 'ratha', 'madh'] },
    ],
  },
};

export const CITIES: Record<City, { label: string; venues: Venue[] }> = {
  karbala: { label: 'Karbala', venues: ['haram', 'najmi'] },
  najaf: { label: 'Najaf', venues: ['najaf'] },
};

export const cityOf = (venue: Venue): City => VENUES[venue]?.city ?? 'karbala';

export const ALL_CATEGORIES: Category[] = ['quran', 'qasida', 'naat', 'manqabat', 'marathi', 'nasihat', 'salam', 'noha', 'matam', 'dua', 'salamArz', 'ratha', 'madh'];

/** The venue's sections in the booklet's own category order (↑ ↓ in the
 * editor). A category missing from a saved order (added to the template
 * since) takes its template place after its predecessor. */
export function sectionsOf(doc: Pick<Booklet, 'venue' | 'order'>): { title: string; categories: Category[] }[] {
  const template = VENUES[doc.venue].sections;
  const saved = doc.order?.[doc.venue];
  if (!saved || saved.length !== template.length) return template;
  const known = template.flatMap((s) => s.categories);
  const placed = new Set<Category>();
  const order = saved.map((cs) => cs.filter((c) => known.includes(c) && !placed.has(c) && placed.add(c)));
  known.forEach((c, i) => {
    if (placed.has(c)) return;
    const before = known.slice(0, i).reverse().find((p) => placed.has(p));
    const si = before ? order.findIndex((cs) => cs.includes(before)) : template.findIndex((s) => s.categories.includes(c));
    order[si].splice(before ? order[si].indexOf(before) + 1 : 0, 0, c);
    placed.add(c);
  });
  return template.map((s, i) => ({ title: s.title, categories: order[i] }));
}

/** Move a category one place up or down; past a section's edge it joins the neighbouring section. */
export function moveCategory(doc: Booklet, category: Category, dir: -1 | 1): Booklet {
  const order = sectionsOf(doc).map((s) => [...s.categories]);
  const si = order.findIndex((cs) => cs.includes(category));
  if (si < 0) return doc;
  const cs = order[si];
  const ci = cs.indexOf(category);
  if (dir < 0 ? ci > 0 : ci < cs.length - 1) {
    cs.splice(ci, 1);
    cs.splice(ci + dir, 0, category);
  } else {
    const to = order[si + dir];
    if (!to) return doc;
    cs.splice(ci, 1);
    if (dir < 0) to.push(category);
    else to.unshift(category);
  }
  return { ...doc, order: { ...doc.order, [doc.venue]: order } };
}

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
/** Najaf's Matam page has its headings in green (tools/build_najaf.py). */
export const matamMediaId = (city: City) => (city === 'najaf' ? 'fixed-matam-najaf' : MATAM_MEDIA_ID);
export const DUA_NAME = 'اللهم انت ثقتي في كل كرب';
export const QASIDA_NAME = 'فزت فوزا اذ انادي يا علي';
export const MANQABAT_NAME = 'مظهر چهے بهلا كون';

/** Built-in screenshots (cleaned at build time, server/store.ts) each city's defaults use. */
export const BUILTIN_MEDIA: Record<City, string[]> = {
  karbala: ['fixed-matam', 'fixed-sawari', 'fixed-dua'],
  najaf: ['fixed-matam-najaf', 'fixed-sawari', 'fixed-qasida', 'fixed-manqabat', 'fixed-salam-arz-najaf'],
};
export const isBuiltinMedia = (id: string) => id.startsWith('fixed-');
/** Verses from the Zikre Husain library (server/library.ts). */
export const isLibraryMedia = (id: string) => /^lib\d+-/.test(id);

/** Slots of the built-in defaults, in the order they fill a new booklet. */
export const BUILTIN_SLOTS = ['marathi:1', 'marathi:2', 'marathi:3', 'marathi:sawari', 'qasida', 'manqabat', 'matam', 'dua', 'salamArz'];
/** Built-in slots whose content differs by city: never copied from Karbala to Najaf. */
export const CITY_SLOTS = ['qasida', 'manqabat', 'matam', 'dua', 'salamArz'];

/**
 * Default content a new booklet starts with. Nothing is locked: the booklet
 * can add to it, change it or remove it, and pinning (★) a changed version
 * or unpinning replaces the built-in default (see effectiveDefaults).
 */
export function builtinDefaults(city: City, media: Record<string, MediaMeta | null>): Defaults {
  const image = (id: string, extra: Partial<ImageBlock> = {}): Block[] => (media[id] ? [imageBlockFrom(media[id]!, extra)] : []);
  const d: Defaults = {};
  MARATHI_FIXED.forEach((name, i) => (d[`marathi:${i + 1}`] = { category: 'marathi', name, blocks: [] }));
  d['marathi:sawari'] = { category: 'marathi', name: SAWARI_NAME, blocks: image('fixed-sawari') };
  d.matam = { category: 'matam', name: MATAM_NAME, blocks: image(matamMediaId(city), { fixedWidthPt: 426 }) };
  if (city === 'karbala') {
    // Tall vowel stacks (Dua) and the ornamented علي (Qasida) make their rows
    // read small at the standard line height: they start larger (− / + adjusts).
    d.dua = { category: 'dua', name: DUA_NAME, blocks: image('fixed-dua', { scale: 1.4 }) };
    d.salamArz = { category: 'salamArz', name: 'سلام عرض', blocks: [{ kind: 'text', id: 'salam-arz', text: SALAM_ARZ_TEXT, sizePt: 22 }] };
  } else {
    d.qasida = { category: 'qasida', name: QASIDA_NAME, blocks: image('fixed-qasida', { scale: 1.4 }) };
    d.manqabat = { category: 'manqabat', name: MANQABAT_NAME, blocks: image('fixed-manqabat') };
    d.salamArz = { category: 'salamArz', name: 'سلام عرض', blocks: image('fixed-salam-arz-najaf') };
  }
  return d;
}

/** Your pins over the built-in defaults; an unpinned built-in (`off`) drops out. */
export const effectiveDefaults = (builtin: Defaults, own: Defaults): Defaults =>
  Object.fromEntries(Object.entries({ ...builtin, ...own }).filter(([, d]) => !d.off));

export const uid = () => Math.random().toString(36).slice(2, 10);

export interface MediaMeta {
  id: string;
  rev: number;
  width: number;
  height: number;
  bands: [number, number][];
  lineHeight: number;
  format?: 'png' | 'svg';
  regions?: ImageRegion[];
  suggestedName?: string;
  recognitionConfidence?: number;
  warnings?: string[];
  opening?: { x: number; y: number; w: number; h: number };
  openingImage?: boolean;
  continues?: boolean;
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
  format: m.format,
  regions: m.regions,
  suggestedName: m.suggestedName,
  warnings: m.warnings,
  opening: m.opening,
  openingImage: m.openingImage,
  continues: m.continues,
  scale: 1,
  ...extra,
});

const emptyKalams = () => Object.fromEntries(ALL_CATEGORIES.map((c) => [c, [] as Kalam[]])) as Record<Category, Kalam[]>;
export const kalamFrom = (slot: string, d: Defaults[string]): Kalam => ({ id: uid(), slot, name: d.name, blocks: cloneBlocks(d.blocks) });

/** A fresh booklet for `date`/`venue`, filled with the (effective) defaults:
 * built-in slots first, in their order, then any other pinned kalam (e.g. a
 * regular Salam) in its category. */
export function createBooklet(date: string, venue: Venue, defaults: Defaults): Booklet {
  const kalams = emptyKalams();
  for (const slot of BUILTIN_SLOTS) if (defaults[slot]) kalams[defaults[slot].category].push(kalamFrom(slot, defaults[slot]));
  for (const [slot, d] of Object.entries(defaults)) if (!BUILTIN_SLOTS.includes(slot)) kalams[d.category].push(kalamFrom(slot, d));
  return { version: 3, date, venue, kalams };
}

/** Where a restored built-in default goes: before the first kalam that is not an earlier built-in. */
export function defaultPosition(kalams: Kalam[], slot: string) {
  const rank = (s?: string) => (s ? BUILTIN_SLOTS.indexOf(s) : -1);
  const i = kalams.findIndex((k) => rank(k.slot) < 0 || rank(k.slot) > rank(slot));
  return i < 0 ? kalams.length : i;
}

/**
 * Brings a saved booklet to version 3. Version 2's fixed content (Matam,
 * Salam Arz, the three Marathi names) becomes default content the booklet
 * owns: typed-over Salam Arz lines and fihrist names move into the kalam
 * itself, and Najaf's Salam Arz becomes its own default. Defaults new in
 * version 3 (Dua, Qasida, Manqabat, the Sawari screenshot) are added once.
 * `pins` are Salam Arz edits that the old booklet kept for new booklets:
 * they become a pinned default.
 */
export function upgradeBooklet(doc: Booklet, defaults: Defaults, builtin: Defaults): { doc: Booklet; pins: Defaults } {
  const kalams = { ...emptyKalams(), ...doc.kalams };
  if (doc.version === 3) return { doc: { ...doc, kalams }, pins: {} };
  const overrides = { ...doc.overrides };
  const pins: Defaults = {};
  const fold = (key: string, from: string) => {
    const o = overrides[key];
    delete overrides[key];
    return o && o.from === from ? o.text : from;
  };
  for (const category of ALL_CATEGORIES) {
    kalams[category] = kalams[category].map((k): Kalam => {
      const { fixed, ...kalam } = k;
      if (fixed !== 'all') return kalam;
      const slot = category === 'matam' ? 'matam' : 'salamArz';
      const name = fold(`fihrist.name.${k.id}`, k.name);
      // Fixed content was rebuilt on every load: start from the current
      // default (Najaf's Salam Arz is its own screenshot now).
      const base = builtin[slot]?.blocks ?? k.blocks;
      const blocks = cloneBlocks(base.map((b) => (b.kind === 'text' ? { ...b, text: b.text.split('\n').map((line, i) => fold(`line.${b.id}.${i}`, line)).join('\n') } : b)));
      if (blocks.some((b, i) => b.kind === 'text' && b.text !== (base[i] as TextBlock).text)) pins[slot] = { category, name, blocks };
      return { ...kalam, slot, name, blocks };
    });
  }
  for (const slot of ['qasida', 'manqabat', 'dua']) {
    const d = defaults[slot];
    if (d && !kalams[d.category].some((k) => k.slot === slot)) kalams[d.category] = [...kalams[d.category], kalamFrom(slot, d)];
  }
  const sawari = defaults['marathi:sawari'];
  if (sawari) kalams.marathi = kalams.marathi.map((k) => (k.slot === 'marathi:sawari' && !k.blocks.length ? { ...k, blocks: cloneBlocks(sawari.blocks) } : k));
  return { doc: { ...doc, version: 3, kalams, overrides }, pins };
}

export const cloneBlocks = (blocks: Block[]): Block[] => blocks.map((b) => ({ ...b, id: uid() }));
