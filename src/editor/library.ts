// Search over the Zikre Husain library (public/library/index.json, made by
// tools/build_library.py). Titles are transliterated Urdu, Lisan al-Dawat and
// Arabic, which nobody spells the same way twice (Husain, Hussain, Hosein;
// Sayyid, Syed; Maula, Moula, Mawla), so every word is compared three ways:
// as typed, folded to a common spelling, and as its consonant skeleton.
import type { Category } from '../booklet/model';

export interface LibraryEntry {
  /** Transliterated title, then other names the PDF's index gives it. */
  t: string;
  a?: string[];
  /** Kind of kalam and the PDF's own section. */
  k: string;
  g: string;
  /** Verses (stanzas) and rows. */
  v: number;
  r: number;
  /** Verses chosen this many at a time: 2 when each verse is one misra of a couplet. */
  c?: number;
}

export interface LibraryHit { n: number; entry: LibraryEntry; score: number; name: string }

/** Booklet sections each library kind belongs to (a match there ranks first). */
const KIND_CATEGORIES: Record<string, Category[]> = {
  marathi: ['marathi', 'ratha'],
  naat: ['naat'],
  manqabat: ['manqabat'],
  qasida: ['qasida'],
  nasihat: ['nasihat'],
  salam: ['salam', 'ratha'],
  noha: ['noha', 'ratha', 'matam'],
  madh: ['madh'],
  dua: ['dua'],
  kalam: [],
};

export const KIND_LABEL: Record<string, string> = {
  marathi: 'Marsiya', naat: 'Naat', manqabat: 'Manqabat', qasida: 'Qasida', nasihat: 'Nasihat',
  salam: 'Salam', noha: 'Noha', madh: 'Madh', dua: 'Iltija', kalam: 'Kalam',
};

/** Lower case, no accents or punctuation, one common spelling. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’‘`ʼʻ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/kh/g, 'k').replace(/gh/g, 'g').replace(/q/g, 'k').replace(/ph/g, 'f')
    .replace(/(dh|zh|dz)/g, 'z').replace(/th/g, 't').replace(/sh/g, 'x').replace(/ch/g, 'c')
    .replace(/ck/g, 'k').replace(/w/g, 'v')
    .replace(/ee|ii/g, 'i').replace(/oo|uu|ou/g, 'u').replace(/aa/g, 'a')
    .replace(/(.)\1+/g, '$1')
    .trim();
}

/** Consonants only: vowels, y, aspirate h and a v closing a diphthong drop out. */
export function skeleton(word: string): string {
  return word
    .replace(/([aeiou])v(?![aeiou])/g, '$1')
    .replace(/([bpdtjkgcr])h/g, '$1')
    .replace(/[aeiouy]/g, '')
    .replace(/(.)\1+/g, '$1');
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

/** The Arabic article as people write it: al-, ul-, ush-, as-, ad-… */
const ARTICLE = /^(a|u|e|i)(l|x|s|d|r|t|z|n)$/;

interface Name { text: string; words: string[]; skels: string[]; joined: string; starts: Set<number> }
const prepare = (text: string): Name => {
  const words = fold(text).split(' ').filter(Boolean);
  const skels = words.map(skeleton);
  // Spaces and the article's assimilated l are left out of the run of
  // consonants; `starts` are where its words begin.
  let joined = '';
  const starts = new Set<number>();
  for (const w of words) {
    if (ARTICLE.test(w)) continue;
    starts.add(joined.length);
    joined += skeleton(w).replace(/l/g, '');
  }
  return { text, words, skels, joined, starts };
};
/** The query's consonants as a run inside the name, starting at a word. */
const runMatch = (query: Name, name: Name) => {
  if (query.joined.length < 5) return false;
  for (let i = name.joined.indexOf(query.joined); i >= 0; i = name.joined.indexOf(query.joined, i + 1)) if (name.starts.has(i)) return true;
  return false;
};

/** How well query word `q` (skeleton `qs`) matches title word `w` (`ws`). */
function wordScore(q: string, qs: string, w: string, ws: string, last: boolean): number {
  if (w === q) return 1;
  if (last && w.startsWith(q)) return 0.92;
  if (qs && ws === qs) return 0.85;
  if (last && qs.length >= 1 && ws.startsWith(qs) && q.length >= 2) return 0.75;
  if (qs.length >= 3 && distance(ws, qs) <= 1) return 0.6;
  if (qs.length >= 6 && distance(ws, qs) <= 2) return 0.45;
  if (q.length >= 3 && w.includes(q)) return 0.4;
  return 0;
}

function nameScore(query: Name, name: Name): number {
  const qn = query.words.length;
  let total = 0, misses = 0, at = -1, inOrder = 0;
  query.words.forEach((q, i) => {
    const last = i === qn - 1;
    let best = 0, bestAt = -1;
    name.words.forEach((w, j) => {
      let s = wordScore(q, query.skels[i], w, name.skels[j], last);
      if (j <= at) s *= 0.7; // out of order
      if (s > best) { best = s; bestAt = j; }
    });
    if (best < 0.4) {
      // An article spelt another way (ush for al) is neither a match nor a miss.
      if (!ARTICLE.test(q)) misses++;
      return;
    }
    if (bestAt > at) inOrder++;
    at = Math.max(at, bestAt);
    total += best;
  });
  // Spaces typed differently ("alshuhada", "ya sayyid"): the run of consonants.
  const run = runMatch(query, name) ? 0.8 * qn : 0;
  if (misses > Math.floor(qn / 3)) return run;
  let score = total - misses * 0.6 + inOrder * 0.1;
  if (name.words.length && query.words.length && wordScore(query.words[0], query.skels[0], name.words[0], name.skels[0], qn === 1) >= 0.75) score += 0.3;
  return Math.max(score, run) - name.words.length * 0.004;
}

let loaded: Promise<{ entries: LibraryEntry[]; names: Name[][] }> | null = null;
/** The library build, so previews are cached for good but never go stale. */
let version = '';
export function loadLibrary() {
  return (loaded ??= fetch('/library/index.json')
    .then((r) => {
      if (!r.ok) throw new Error('The kalam library is not available.');
      return r.json() as Promise<{ sha: string; build?: string; kalams: LibraryEntry[] }>;
    })
    .then(({ sha, build, kalams }) => (version = build ?? sha, { entries: kalams, names: kalams.map((e) => [e.t, ...(e.a ?? [])].filter(Boolean).map(prepare)) }))
    .catch((error) => { loaded = null; throw error; }));
}

export async function searchLibrary(text: string, category: Category | undefined, limit = 8): Promise<LibraryHit[]> {
  const { entries, names } = await loadLibrary();
  const query = prepare(text);
  if (!query.words.length) return [];
  const hits: LibraryHit[] = [];
  entries.forEach((entry, n) => {
    let best = 0, bestName = entry.t;
    for (const name of names[n]) {
      const s = nameScore(query, name);
      if (s > best) { best = s; bestName = name.text; }
    }
    if (best <= 0.35 * query.words.length) return;
    if (category && KIND_CATEGORIES[entry.k]?.includes(category)) best += 0.25;
    hits.push({ n, entry, score: best, name: bestName });
  });
  return hits.sort((a, b) => b.score - a.score || a.n - b.n).slice(0, limit);
}

export const titleSrc = (n: number) => `/api/library/${n}/title.png?v=${version}`;
export const verseSrc = (n: number, first: number, last = first) => `/api/library/${n}/verse-${first}${last > first ? `-${last}` : ''}.png?v=${version}`;
