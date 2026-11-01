// Stanzas and verses from a kalam's rows: the same rules tools/build_library.py
// uses for Zikre Husain, for PDFs added in the browser (src/library/analyze.ts).
import type { Part } from './geometry';

/** One row of lettering, in PDF points: top, bottom, ink centre, left and
 * right ink edges, the share of coloured ink, and its page. */
export interface Row { t: number; b: number; c: number; x0: number; x1: number; col: number; page: number }

const median = (a: number[]) => [...a].sort((p, q) => p - q)[a.length >> 1] ?? 0;

/** Rows grouped into stanzas: a break is a pitch or gap clearly wider than
 * the kalam's line spacing, or (where whole rows in colour close each
 * stanza) after each refrain. A stanza cut by a page break is joined again
 * when together the pieces make the usual stanza length. */
export function stanzasOf(rows: Row[]): { stanzas: Row[][]; pitch: number; lh: number } {
  const lh = median(rows.map((r) => r.b - r.t)) || 10;
  const pitches = rows.slice(1).flatMap((r, j) => (r.page === rows[j].page ? [r.c - rows[j].c] : [])).sort((a, b) => a - b);
  const pitch = pitches.length ? pitches[(pitches.length - 1) >> 2] : lh * 1.4;
  let brk = rows.map((r, j) => !j || r.page !== rows[j - 1].page || r.c - rows[j - 1].c > pitch * 1.3 || r.t - rows[j - 1].b > Math.max(pitch * 0.62, lh * 0.55));
  const refrain = rows.map((r) => r.col > 0.75);
  const ends = rows.flatMap((_, j) => (refrain[j] && (j + 1 === rows.length || !refrain[j + 1]) ? [j] : []));
  if (ends.length >= 3 && rows.length / ends.length >= 2.5 && !refrain[0]) {
    brk = rows.map((_, j) => !j || ends.includes(j - 1));
  }
  let groups: Row[][] = [];
  rows.forEach((r, j) => (brk[j] || !groups.length ? groups.push([r]) : groups[groups.length - 1].push(r)));
  const inner = groups.filter((g, i) => i > 0 && i < groups.length - 1 && g[0].page === groups[i - 1].at(-1)!.page && g.at(-1)!.page === groups[i + 1][0].page).map((g) => g.length);
  const counts = new Map<number, number>();
  for (const n of inner.length ? inner : groups.map((g) => g.length)) counts.set(n, (counts.get(n) ?? 0) + 1);
  const mode = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 1;
  const out: Row[][] = [];
  for (const g of groups) {
    const last = out.at(-1);
    if (last && g[0].page !== last.at(-1)!.page && last.length < mode && g.length < mode && last.length + g.length <= mode) out[out.length - 1] = [...last, ...g];
    else out.push(g);
  }
  // Evenly spaced rows with no break inside any page: one continuous run.
  groups = out.length > 1 && out.every((g, j) => !j || g[0].page !== out[j - 1].at(-1)!.page) ? [out.flat()] : out;
  return { stanzas: groups, pitch, lh };
}

// Rows of one stanza share both edges; where stanzas run on without a gap,
// the block moves instead (tools/build_library.py layout_runs).
const EDGE = 14;
function layoutRuns(rows: Row[]): number[] {
  const runs: number[] = [];
  rows.forEach((r, j) => {
    const p = rows[j - 1];
    if (p && Math.abs(r.x0 - p.x0) < EDGE && Math.abs(r.x1 - p.x1) < EDGE) runs[runs.length - 1]++;
    else runs.push(1);
  });
  return runs;
}

function splitMultiples(sizes: number[]): number[] {
  const counts = new Map<number, number>();
  for (const s of sizes) if (s >= 2) counts.set(s, (counts.get(s) ?? 0) + 1);
  const [typical, seen] = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] ?? [0, 0];
  if (seen < 3) return sizes;
  return sizes.flatMap((s) => (s >= 2 * typical && s % typical === 0 ? Array(s / typical).fill(typical) : [s]));
}

type Unit = [number, number, number];
/** A long block followed by a short one (a refrain sung to another tune) is one verse. */
function mergeRefrains(units: Unit[]): Unit[] {
  const sizes = units.map(([a, b]) => b - a);
  const same = units.slice(1).map((u, j) => u[2] === units[j][2]);
  const pairs = new Map<string, number>();
  sizes.slice(1).forEach((y, j) => { if (sizes[j] > y && same[j]) pairs.set(`${sizes[j]},${y}`, (pairs.get(`${sizes[j]},${y}`) ?? 0) + 1); });
  const best = [...pairs].sort((a, b) => b[1] - a[1])[0];
  if (!best) return units;
  const [big, small] = best[0].split(',').map(Number);
  const merged: Unit[] = [];
  let covered = 0, count = 0;
  for (let j = 0; j < units.length; j++) {
    if (j + 1 < units.length && same[j] && sizes[j] === big && sizes[j + 1] === small) {
      merged.push([units[j][0], units[j + 1][1], units[j][2]]);
      covered += big + small;
      count++;
      j++;
    } else merged.push(units[j]);
  }
  return count >= 2 && covered >= 0.6 * sizes.reduce((a, b) => a + b, 0) ? merged : units;
}

/** The verses a kalam is chosen by, as [first row, end row, stanza]. */
export function versePlan(stanzas: Row[][]): Unit[] {
  const rows = stanzas.map((g) => g.length);
  const real = rows.filter((n) => n >= 2).sort((a, b) => a - b);
  const typical = real.length ? real[real.length >> 1] : 1;
  let units: Unit[] = [];
  let start = 0;
  stanzas.forEach((g, si) => {
    const n = g.length;
    if (real.length >= 3 && typical >= 2 && n >= 2 * typical && n % typical === 0) {
      for (let c = 0; c < n; c += typical) units.push([start + c, start + c + typical, si]);
    } else if (n >= 2 && (rows.length === 1 || (n >= 10 && (real.length < 3 || n >= 1.5 * typical)))) {
      const runs: Unit[] = [];
      let at = start;
      for (const s of splitMultiples(layoutRuns(g))) { runs.push([at, at + s, si]); at += s; }
      const blocky = runs.length >= 2 && mergeRefrains(runs).reduce((sum, [a, b]) => sum + (b - a >= 2 ? b - a : 0), 0) >= 0.75 * n;
      if (blocky) units.push(...runs);
      else for (let r = 0; r < n; r++) units.push([start + r, start + r + 1, si]);
    } else units.push([start, start + n, si]);
    start += n;
  });
  units = mergeRefrains(units);
  return units;
}

/** Misras printed in pairs, each couplet's first row set to the right and its
 * second further left: chosen a couplet at a time. */
export function staggered(rows: Row[]): boolean {
  const pairs: [Row, Row][] = [];
  for (let i = 0; i + 1 < rows.length; i += 2) pairs.push([rows[i], rows[i + 1]]);
  if (pairs.length < 2) return false;
  return pairs.filter(([a, b]) => a.x1 - b.x1 > 12 && a.x0 - b.x0 > 12).length >= 0.8 * pairs.length;
}

/** Each row's crop [page, y0, y1, centre, centre], reaching halfway (at most
 * 8 pt) into the space around it. */
export function rowCrops(rows: Row[], pageTop: (page: number) => number, pageBottom: (page: number) => number): Part[] {
  return rows.map((r, j) => {
    const prev = rows[j - 1]?.page === r.page ? rows[j - 1].b : pageTop(r.page);
    const next = rows[j + 1]?.page === r.page ? rows[j + 1].t : pageBottom(r.page);
    const up = Math.max(1, Math.min(8, (r.t - prev) / 2)), down = Math.max(1, Math.min(8, (next - r.b) / 2));
    return [r.page, +(r.t - up).toFixed(1), +(r.b + down).toFixed(1), +r.c.toFixed(1), +r.c.toFixed(1)];
  });
}

/** Row crops of one verse in order → its parts: rows on the same page join. */
export function joinParts(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    const last = out.at(-1);
    if (last && last[0] === p[0]) out[out.length - 1] = [p[0], last[1], p[2], last[3], p[4]];
    else out.push([...p] as Part);
  }
  return out;
}
