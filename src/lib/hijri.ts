// Fatemi (Misri) tabular Hijri calendar, as used by the Dawoodi Bohra community.
// Odd months have 30 days, even months 29; the 12th month gains a day in the
// leap years of each 30-year cycle. Epoch: Thursday 15 July 622 (Julian).
// Verified: Tuesday 27 Oct 2026 = 17 Jumada al-Ula 1448.

const EPOCH_JDN = 1948439;
const LEAP_YEARS = new Set([2, 5, 8, 10, 13, 16, 19, 21, 24, 27, 29]);
const CYCLE_DAYS = 10631;

export interface HijriDate {
  year: number;
  month: number; // 1–12
  day: number;
}

function jdnFromLocalDate(d: Date): number {
  // Julian Day Number for the local calendar date (noon), ignoring time of day.
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return day + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

const isLeap = (year: number) => LEAP_YEARS.has(((year - 1) % 30) + 1);

export function toHijri(d: Date): HijriDate {
  let days = jdnFromLocalDate(d) - EPOCH_JDN;
  const cycles = Math.floor(days / CYCLE_DAYS);
  days -= cycles * CYCLE_DAYS;
  let year = cycles * 30 + 1;
  for (;;) {
    const len = isLeap(year) ? 355 : 354;
    if (days < len) break;
    days -= len;
    year++;
  }
  let month = 1;
  for (;;) {
    const len = month % 2 === 1 || (month === 12 && isLeap(year)) ? 30 : 29;
    if (days < len) break;
    days -= len;
    month++;
  }
  return { year, month, day: days + 1 };
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export const arabicNumber = (n: number) => String(n).replace(/\d/g, (c) => ARABIC_DIGITS[+c]);

export const HIJRI_MONTHS = [
  'شهر محرم الحرام',
  'صفر المظفر',
  'ربيع الاول',
  'ربيع الآخر',
  'جمادى الاولى',
  'جمادى الاخرى',
  'شهر رجب الاصب',
  'شعبان الكريم',
  'شهر رمضان المعظم',
  'شوال المكرم',
  'ذي القعدة الحرام',
  'ذي الحجة الحرام',
];

// Sunday first, matching Date.getDay().
export const WEEKDAYS = ['يوم الاحد', 'يوم الاثنين', 'يوم الثلاثاء', 'يوم الاربعاء', 'يوم الخميس', 'يوم الجمعة', 'يوم السبت'];

// Nights 1–9 are named; from 10 up the number is written in digits.
const NIGHT_NAMES = ['پهلي', 'بيجي', 'تيجي', 'چوتهي', 'پانچمي', 'چهٹي', 'ساتمي', 'اٰٹهمي', 'نومي'];

const NIGHT_LATIN = ['Pehli', 'Biji', 'Tiji', 'Chothi', 'Panchmi', 'Chatti', 'Satmi', 'Athmi', 'Nomi'];

/** The majlis is held on the evening of `date`, which is the night of the next Hijri day. */
export function nightOf(date: Date): number {
  return toHijri(addDays(date, 1)).day;
}

export function raatTitle(date: Date): string {
  const n = nightOf(date);
  return n <= 9 ? `${NIGHT_NAMES[n - 1]} رات` : `${arabicNumber(n)} مي رات`;
}

export function raatTitleLatin(date: Date): string {
  const n = nightOf(date);
  return n <= 9 ? `${NIGHT_LATIN[n - 1]} Raat` : `${n}mi Raat`;
}

/** e.g. "يوم الثلاثاء، ١٧ جمادى الاولى ١٤٤٨هـ" for the day the majlis is held. */
export function dateLine(date: Date): string {
  const h = toHijri(date);
  return `${WEEKDAYS[date.getDay()]}، ${arabicNumber(h.day)} ${HIJRI_MONTHS[h.month - 1]} ${arabicNumber(h.year)}هـ`;
}
