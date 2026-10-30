// Recover source ink without tracing, smoothing, or inventing letter shapes.
// Each verse row gets its own geometry, independent of screenshot zoom.
import sharp from 'sharp';
import { recognize } from './recognize';

export const PROCESSOR_VERSION = 10;
/** Fihrist navy (#3a456a): opening words are delivered already coloured. */
const NAVY = [58, 69, 106];
export interface Rect { x: number; y: number; w: number; h: number }
export interface Edits { crop?: Rect; erase?: Rect[]; autoClean?: boolean }
/** `top`/`bottom` are the row's ink band and `center` its ink mass centre
 * (close to the baseline zone), all in px of the final image. */
export interface Region extends Rect { lineHeight: number; group: number; top: number; bottom: number; center: number }
export interface InkResult {
  width: number; height: number; bands: [number, number][]; lineHeight: number;
  regions: Region[]; opening: Rect; suggestedName: string; recognitionConfidence: number;
  warnings: string[]; png: Buffer; openingPng: Buffer | null;
}
const median = (a: number[]) => a.length ? [...a].sort((p, q) => p - q)[a.length >> 1] : 1;
const lowerMedian = (a: number[]) => a.length ? [...a].sort((p, q) => p - q)[(a.length - 1) >> 1] : 1;
const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
function clampRect(r: Rect, W: number, H: number): Rect {
  const x = Math.min(W - 1, Math.max(0, Math.round(r.x)));
  const y = Math.min(H - 1, Math.max(0, Math.round(r.y)));
  return { x, y, w: Math.max(1, Math.min(W - x, Math.round(r.w))), h: Math.max(1, Math.min(H - y, Math.round(r.h))) };
}
function background(rgb: Uint8Array, W: number, H: number): number[] {
  const edges: number[] = [];
  for (let x = 0; x < W; x++) edges.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) edges.push(y * W, y * W + W - 1);
  return [0, 1, 2].map((c) => median(edges.map((i) => rgb[i * 3 + c])));
}
function box(alpha: Uint8Array, W: number, H: number, top = 0, bottom = H): Rect | null {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = top; y < bottom; y++) for (let x = 0; x < W; x++) if (alpha[y * W + x] > 40) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
function erase(alpha: Uint8Array, W: number, H: number, r: Rect) {
  const x0 = Math.max(0, Math.floor(r.x)), x1 = Math.min(W, Math.ceil(r.x + r.w));
  for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(H, Math.ceil(r.y + r.h)); y++) if (x1 > x0) alpha.fill(0, y * W + x0, y * W + x1);
}
/** Only long uninterrupted strokes qualify as rules. */
function removeRules(alpha: Uint8Array, W: number, H: number) {
  const vertical = Math.max(50, H * 0.23), horizontal = Math.max(100, W * 0.52);
  const clear: Rect[] = [];
  for (let x = 0; x < W; x++) {
    let start = -1;
    for (let y = 0; y <= H; y++) {
      if (y < H && alpha[y * W + x] > 25) { if (start < 0) start = y; }
      else if (start >= 0) { if (y - start > vertical) clear.push({ x: x - 1, y: start, w: 3, h: y - start }); start = -1; }
    }
  }
  for (let y = 0; y < H; y++) {
    let start = -1;
    for (let x = 0; x <= W; x++) {
      if (x < W && alpha[y * W + x] > 25) { if (start < 0) start = x; }
      else if (start >= 0) { if (x - start > horizontal) clear.push({ x: start, y: y - 1, w: x - start, h: 3 }); start = -1; }
    }
  }
  // Confirm each candidate is an isolated thin component. A long kashida
  // connected to real Arabic letters must not be mistaken for a page rule.
  const visited = new Uint8Array(W * H);
  for (const r of clear) {
    const seed = r.h > r.w ? r.y * W + Math.min(W - 1, r.x + 1) : Math.min(H - 1, r.y + 1) * W + r.x;
    if (visited[seed] || alpha[seed] <= 25) continue;
    const pixels = [seed]; visited[seed] = 1;
    let x0 = seed % W, x1 = x0, y0 = Math.floor(seed / W), y1 = y0;
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i], x = p % W, y = Math.floor(p / W);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (q >= 0 && !visited[q] && alpha[q] > 25) { visited[q] = 1; pixels.push(q); }
      }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if ((h > vertical && h / w > 25) || (w > horizontal && w / h > 25)) for (const p of pixels) alpha[p] = 0;
  }
}
/** Attach detached dots/harakat only to nearby ink. */
export function findBands(alpha: Uint8Array, W: number, H: number, attachMarks = true): [number, number][] {
  const raw: [number, number][] = [];
  let start = -1;
  for (let y = 0; y <= H; y++) {
    let count = 0;
    if (y < H) for (let x = 0; x < W; x++) if (alpha[y * W + x] > 55) count++;
    const on = count >= Math.max(2, W * 0.0015);
    if (on && start < 0) start = y;
    if (!on && start >= 0) { raw.push([start, y]); start = -1; }
  }
  if (!attachMarks) return raw;
  const tall = raw.map(([a, b]) => b - a).filter((h) => h >= 4).sort((a, b) => a - b);
  const typical = tall[Math.floor(tall.length * 0.7)] ?? 10;
  const main = raw.filter(([a, b]) => b - a >= typical * 0.4).map(([a, b]) => [a, b] as [number, number]);
  if (!main.length) return raw;
  for (const [a, b] of raw) {
    if (b - a >= typical * 0.4) continue;
    const nearest = main.map((l) => ({ l, gap: Math.max(0, a - l[1], l[0] - b) })).sort((a, b) => a.gap - b.gap)[0];
    // Detached dots and vowel marks are part of the lettering. Geometry may
    // attach them to the nearest row, but must never silently discard them.
    nearest.l[0] = Math.min(nearest.l[0], a); nearest.l[1] = Math.max(nearest.l[1], b);
  }
  const merged: [number, number][] = [];
  for (const band of main.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && band[0] <= last[1]) last[1] = Math.max(last[1], band[1]); else merged.push(band);
  }
  return merged;
}
/** Vertical ink mass centre of rows [a, b). */
function centre(alpha: Uint8Array, W: number, a: number, b: number) {
  let mass = 0, moment = 0;
  for (let y = a; y < b; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) row += alpha[y * W + x];
    mass += row; moment += row * y;
  }
  return mass ? moment / mass : (a + b) / 2;
}
/**
 * Verse/stanza numbers (٢٧, ٧, a numbered badge) sit apart from the lettering:
 * in the margin beside a couplet, usually between its two rows, or as a solid
 * badge. They must go before rows are measured: a number between two rows
 * joins them into one "giant line", which then prints as a shrunken stanza.
 * Lettering is protected: a word inside a row, a lone centred word and
 * anything without lettering beside it are never candidates.
 */
type Component = { x0: number; y0: number; x1: number; y1: number; n: number };
/** 8-connected ink components; `label` holds each pixel's 1-based component. */
function components(alpha: Uint8Array, W: number, H: number) {
  const label = new Int32Array(W * H);
  const comps: Component[] = [];
  const stack: number[] = [];
  for (let start = 0; start < alpha.length; start++) {
    if (label[start] || alpha[start] <= 60) continue;
    const id = comps.length + 1;
    const c = { x0: W, y0: H, x1: -1, y1: -1, n: 0 };
    label[start] = id; stack.push(start);
    while (stack.length) {
      const p = stack.pop()!, x = p % W, y = (p - x) / W;
      c.n++; c.x0 = Math.min(c.x0, x); c.x1 = Math.max(c.x1, x); c.y0 = Math.min(c.y0, y); c.y1 = Math.max(c.y1, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (!label[q] && alpha[q] > 60) { label[q] = id; stack.push(q); }
      }
    }
    comps.push(c);
  }
  return { label, comps };
}
/** Clear a component group and its faint antialiased fringe. */
function clearComponents(alpha: Uint8Array, W: number, H: number, label: Int32Array, ids: number[], box: Rect, fringe: number) {
  const own = new Set(ids);
  for (let y = Math.max(0, box.y - fringe); y <= Math.min(H - 1, box.y + box.h - 1 + fringe); y++) for (let x = Math.max(0, box.x - fringe); x <= Math.min(W - 1, box.x + box.w - 1 + fringe); x++) {
    const p = y * W + x;
    if (!label[p] || own.has(label[p])) alpha[p] = 0;
  }
}
/** A dotted or dashed frame line down the outer edge of a screenshot (a
 * Quran page border, an app's column guide) is not lettering. */
function removeDashedEdges(alpha: Uint8Array, W: number, H: number, label: Int32Array, comps: Component[]) {
  const thin = comps.map((c, i) => ({ c, id: i + 1, cx: (c.x0 + c.x1) / 2 }))
    .filter(({ c }) => c.x1 - c.x0 + 1 <= Math.max(4, W * 0.008) && c.y1 - c.y0 + 1 <= H * 0.08)
    .sort((a, b) => a.cx - b.cx);
  const lines: (typeof thin)[] = [];
  for (const t of thin) {
    const line = lines.at(-1);
    if (line && t.cx - line[0].cx <= 3) line.push(t); else lines.push([t]);
  }
  const ids = new Set<number>();
  for (const line of lines) {
    if (line.length < 5) continue;
    const top = Math.min(...line.map((t) => t.c.y0)), bottom = Math.max(...line.map((t) => t.c.y1));
    if (bottom - top < H * 0.4) continue;
    const x0 = Math.min(...line.map((t) => t.c.x0)), x1 = Math.max(...line.map((t) => t.c.x1));
    const own = new Set(line.map((t) => t.id));
    // Only the outermost ink on its side: never a column inside the text.
    const outerLeft = comps.every((c, i) => own.has(i + 1) || c.x1 >= x0 || c.y1 < top || c.y0 > bottom);
    const outerRight = comps.every((c, i) => own.has(i + 1) || c.x0 <= x1 || c.y1 < top || c.y0 > bottom);
    const inside = comps.some((c, i) => !own.has(i + 1) && c.x0 < x0 && c.x1 > x1 && c.y0 <= bottom && c.y1 >= top);
    if (inside || !(outerLeft || outerRight)) continue;
    // A frame line keeps clear of the text. The first letter of rows that all
    // start alike (the alif of a repeated الوداع, a superscript alif above
    // the same word) lines up just as straight, but touches its own word.
    const T = Math.max(12, lowerMedian(line.map((t) => t.c.y1 - t.c.y0 + 1)));
    const touching = line.filter((t) => comps.some((c, i) => !own.has(i + 1) && c.y0 <= t.c.y1 + T * 0.5 && c.y1 >= t.c.y0 - T * 0.5
      && Math.max(c.x0 - t.c.x1, t.c.x0 - c.x1) < T * 1.5)).length;
    if (touching > line.length * 0.2) continue;
    for (const t of line) { ids.add(t.id); clearComponents(alpha, W, H, label, [t.id], { x: t.c.x0, y: t.c.y0, w: t.c.x1 - t.c.x0 + 1, h: t.c.y1 - t.c.y0 + 1 }, 1); }
  }
  return ids;
}
/**
 * Verse/stanza numbers (٢٧, ٧, a numbered badge) sit apart from the lettering:
 * in the margin beside a couplet, usually between its two rows, or as a solid
 * badge. They must go before rows are measured: a number between two rows
 * joins them into one "giant line", which then prints as a shrunken stanza.
 * Lettering is protected: a word inside a row, a lone centred word and
 * anything without lettering beside it are never candidates.
 */
function removeMarginMarks(alpha: Uint8Array, colors: Uint8Array, W: number, H: number) {
  const { label, comps: found } = components(alpha, W, H);
  const dashed = removeDashedEdges(alpha, W, H, label, found);
  // Removed dashes stay out of every later comparison.
  const comps = found.map((c, i) => (dashed.has(i + 1) ? { ...c, x0: -1e9, x1: -1e9, y0: -1e9, y1: -1e9 } : c));
  if (comps.length < 2) return;
  const T = lowerMedian(findBands(alpha, W, H).map(([a, b]) => b - a).filter((h) => h >= 4));
  // Join components into words: dots, harakat and letters of one word overlap
  // vertically and sit within a small horizontal gap.
  const parent = comps.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const order = comps.map((_, i) => i).sort((a, b) => comps[a].x0 - comps[b].x0);
  for (let i = 0; i < order.length; i++) {
    const a = comps[order[i]];
    for (let j = i + 1; j < order.length && comps[order[j]].x0 <= a.x1 + T * 0.3; j++) {
      const b = comps[order[j]];
      if (a.y0 <= b.y1 + T * 0.15 && b.y0 <= a.y1 + T * 0.15) parent[find(order[i])] = find(order[j]);
    }
  }
  const clusters = new Map<number, { x0: number; y0: number; x1: number; y1: number; n: number; ids: number[] }>();
  comps.forEach((c, i) => {
    const r = find(i);
    const k = clusters.get(r);
    if (!k) clusters.set(r, { ...c, ids: [i + 1] });
    else { k.x0 = Math.min(k.x0, c.x0); k.x1 = Math.max(k.x1, c.x1); k.y0 = Math.min(k.y0, c.y0); k.y1 = Math.max(k.y1, c.y1); k.n += c.n; k.ids.push(i + 1); }
  });
  const all = [...clusters.values()];
  const candidates = all.filter((c) => {
    const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
    if (h > T * 0.85 || h < T * 0.2 || w > T * 1.5 || c.ids.length > 4) return false;
    // Compare with single components: word clusters can chain across rows
    // through their harakat, so a cluster's box says little about its row.
    let left = -Infinity, right = Infinity;
    const own = new Set(c.ids);
    for (const [i, o] of comps.entries()) {
      if (own.has(i + 1) || o.y1 < c.y0 - T * 0.2 || o.y0 > c.y1 + T * 0.2) continue;
      if (o.x1 < c.x0) left = Math.max(left, o.x1);
      else if (o.x0 > c.x1) right = Math.min(right, o.x0);
      else return false;
    }
    // Outermost in its strip, well clear of the lettering beside it.
    return (left === -Infinity && right - c.x1 >= T * 0.45) || (right === Infinity && c.x0 - left >= T * 0.45);
  });
  if (!candidates.length) return;
  // Measure the rows without the candidates, so a number cannot bridge them.
  const rest = alpha.slice();
  const clear = (c: typeof candidates[number], target: Uint8Array) =>
    clearComponents(target, W, H, label, c.ids, { x: c.x0, y: c.y0, w: c.x1 - c.x0 + 1, h: c.y1 - c.y0 + 1 }, 2);
  for (const c of candidates) clear(c, rest);
  const rows = findBands(rest, W, H).filter(([a, b]) => b - a >= T * 0.4);
  const centres = rows.map(([a, b]) => centre(rest, W, a, b));
  const pitch = centres.length > 1 ? lowerMedian(centres.slice(1).map((c, i) => c - centres[i])) : 0;
  for (const c of candidates) {
    const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1, cy = (c.y0 + c.y1) / 2;
    // A badge is a filled, roughly round, coloured shape (a red drop around
    // the number). Black lettering is never treated as one.
    let coloured = 0;
    for (const id of c.ids) {
      const k = comps[id - 1];
      for (let y = k.y0; y <= k.y1; y++) for (let x = k.x0; x <= k.x1; x++) {
        const p = y * W + x;
        if (label[p] === id && colors[p * 3] + colors[p * 3 + 1] + colors[p * 3 + 2] > 0) coloured++;
      }
    }
    const badge = c.n / (w * h) >= 0.5 && h >= T * 0.3 && w / h >= 0.5 && w / h <= 2 && coloured >= c.n * 0.5;
    // Level with the lettering beside it, a mark is a word of that row (the
    // last حسين of a refrain across a justified gap); a number set between
    // two rows overlaps neither by much.
    const own = new Set(c.ids);
    const level = comps.some((o, i) => !own.has(i + 1) && o.y1 - o.y0 + 1 >= T * 0.25 && Math.max(o.x0 - c.x1, c.x0 - o.x1) < T * 3
      && Math.min(o.y1, c.y1) - Math.max(o.y0, c.y0) >= Math.min(h, o.y1 - o.y0 + 1) * 0.6);
    const between = pitch > 0 && Math.min(...centres.map((r) => Math.abs(r - cy))) > pitch * 0.3 && !level;
    if (badge || between) clear(c, alpha);
  }
}
/** A band far taller than its neighbours is two rows touching (often through
 * a mark between them). Split it at a clear valley rather than treating it as
 * one huge line. */
function splitMergedRows(alpha: Uint8Array, W: number, bands: [number, number][]): [number, number][] {
  if (bands.length < 2) return bands;
  const normal = lowerMedian(bands.map(([a, b]) => b - a));
  const out: [number, number][] = [];
  const pending = [...bands].reverse();
  while (pending.length) {
    const [a, b] = pending.pop()!;
    if (b - a < normal * 1.7) { out.push([a, b]); continue; }
    const profile: number[] = [];
    for (let y = a; y < b; y++) { let n = 0; for (let x = 0; x < W; x++) if (alpha[y * W + x] > 55) n++; profile.push(n); }
    const peak = Math.max(...profile);
    let cut = -1;
    for (let i = Math.round((b - a) * 0.3); i <= Math.round((b - a) * 0.7); i++) if (cut < 0 || profile[i] < profile[cut]) cut = i;
    if (cut < 0 || profile[cut] > peak * 0.12) { out.push([a, b]); continue; }
    pending.push([a + cut + 1, b], [a, a + cut]);
  }
  return out;
}
/** `marks: false` skips the margin-number and dashed-line passes: library
 * verses come from the PDF with those already removed exactly, and the
 * guesswork can only cost them lettering. */
export async function cleanScreenshot(input: Buffer, edits: Edits = {}, options: { ocr?: boolean; marks?: boolean } = {}): Promise<InkResult> {
  const { data, info } = await sharp(input, { limitInputPixels: 20_000_000 }).rotate().flatten({ background: '#fff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const crop = clampRect(edits.crop ?? { x: 0, y: 0, w: info.width, h: info.height }, info.width, info.height);
  const W = crop.w, H = crop.h;
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) rgb.set(data.subarray(((y + crop.y) * info.width + crop.x) * 3, ((y + crop.y) * info.width + crop.x + W) * 3), y * W * 3);
  const bg = background(rgb, W, H), dark = Math.max(...bg) < 128;
  const alpha = new Uint8Array(W * H), colors = new Uint8Array(W * H * 3);
  // Plain arithmetic per pixel (no temporary arrays): this loop runs millions
  // of times per screenshot. Same formula, so the same pixels.
  const [b0, b1, b2] = bg;
  const d0 = Math.max(1, dark ? 255 - b0 : b0), d1 = Math.max(1, dark ? 255 - b1 : b1), d2 = Math.max(1, dark ? 255 - b2 : b2);
  for (let i = 0; i < alpha.length; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    // True coverage preserves grey antialiased edges rather than turning them
    // all solid black (the former crayon effect).
    const coverage = dark
      ? Math.max((r - b0) / d0, (g - b1) / d1, (b - b2) / d2)
      : Math.max((b0 - r) / d0, (b1 - g) / d1, (b2 - b) / d2);
    if (coverage < 0.045) continue;
    alpha[i] = clamp(coverage * 255);
    if (Math.max(r, g, b) - Math.min(r, g, b) > 45) {
      const a = Math.max(coverage, 0.01);
      colors[i * 3] = clamp((r - (1 - a) * b0) / a);
      colors[i * 3 + 1] = clamp((g - (1 - a) * b1) / a);
      colors[i * 3 + 2] = clamp((b - (1 - a) * b2) / a);
    }
  }
  for (const r of edits.erase ?? []) erase(alpha, W, H, { ...r, x: r.x - crop.x, y: r.y - crop.y });
  if (edits.autoClean !== false) removeRules(alpha, W, H);
  if (edits.autoClean !== false) {
    const raw = findBands(alpha, W, H, false);
    const typical = median(raw.map(([a, b]) => b - a).filter((h) => h >= 10));
    for (const [a, b] of raw) {
      if ((a <= 1 || b >= H - 1) && b - a < typical * 0.55) erase(alpha, W, H, { x: 0, y: a, w: W, h: b - a });
    }
  }
  if (edits.autoClean !== false && options.marks !== false && W * H <= 12_000_000) removeMarginMarks(alpha, colors, W, H);
  const warnings: string[] = [];
  let bands = findBands(alpha, W, H);
  const typical = median(bands.map(([a, b]) => b - a));
  /** The ink inside `r` (default: all of it) as one PNG; `white` flattens it
   * onto white for OCR. Cropping before encoding means one PNG pass. */
  const makePng = async (white: boolean, r: Rect = { x: 0, y: 0, w: W, h: H }) => {
    const rgba = Buffer.alloc(r.w * r.h * 4);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const i = (y + r.y) * W + x + r.x, o = (y * r.w + x) * 4;
      if (white) {
        const a = alpha[i] / 255;
        rgba[o] = clamp(colors[i * 3] * a + 255 * (1 - a));
        rgba[o + 1] = clamp(colors[i * 3 + 1] * a + 255 * (1 - a));
        rgba[o + 2] = clamp(colors[i * 3 + 2] * a + 255 * (1 - a));
        rgba[o + 3] = 255;
      } else {
        rgba[o] = colors[i * 3]; rgba[o + 1] = colors[i * 3 + 1]; rgba[o + 2] = colors[i * 3 + 2];
        rgba[o + 3] = alpha[i];
      }
    }
    return sharp(rgba, { raw: { width: r.w, height: r.h, channels: 4 } }).png().toBuffer();
  };
  let suggestedName = '', recognitionConfidence = 0;
  try { if (options.ocr !== false) {
    const recognized = await recognize(await makePng(true));
    suggestedName = recognized.name; recognitionConfidence = recognized.confidence;
    if (edits.autoClean !== false) for (const r of recognized.numbers) erase(alpha, W, H, { x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 });
  } } catch (error) {
    console.error('Index recognition unavailable:', error);
    warnings.push('Automatic page-number detection was unavailable. Check for screenshot page numbers.');
  }
  bands = splitMergedRows(alpha, W, findBands(alpha, W, H));
  // Row detection controls pagination, not which pixels are allowed to exist.
  // Erasing everything outside detected rows destroyed isolated Urdu dots.
  const bounds = box(alpha, W, H);
  if (!bounds) throw new Error('No complete text found. Try a screenshot containing a complete verse.');
  const padding = Math.max(3, Math.round(typical * 0.09));
  const t = clampRect({ x: bounds.x - padding, y: bounds.y - padding, w: bounds.w + padding * 2, h: bounds.h + padding * 2 }, W, H);
  const png = await makePng(false, t);
  // A band split at an empty valley can keep no ink of its own: not a row.
  const finalBands = bands.map(([a, b]) => [Math.max(0, a - t.y), Math.min(t.h, b - t.y)] as [number, number])
    .filter(([a, b]) => b > a && box(alpha, W, H, a + t.y, b + t.y));
  // Stanza breaks come only from the source's own spacing: a baseline pitch
  // clearly above the screenshot's normal line pitch. Uniformly spaced rows
  // stay one group; rows are never paired up artificially.
  const centres = finalBands.map(([a, b]) => centre(alpha, W, a + t.y, b + t.y) - t.y);
  const pitches = centres.slice(1).map((c, i) => c - centres[i]);
  const sortedPitches = [...pitches].sort((p, q) => p - q);
  const basePitch = pitches.length >= 2 ? sortedPitches[Math.floor((sortedPitches.length - 1) / 4)] : Infinity;
  let group = 0;
  // A stroke thinner than the row test (the 2px tail of a Nastaliq م) still
  // belongs to its row: the row's edges reach over any ink touching them, at
  // most halfway to the next row, so the printed crop never cuts it off.
  const inkAt = (y: number) => { for (let x = 0; x < t.w; x++) if (alpha[(y + t.y) * W + x + t.x] > 55) return true; return false; };
  const reach = (i: number): [number, number] => {
    let [a, b] = finalBands[i];
    const above = i ? Math.ceil((finalBands[i - 1][1] + a) / 2) : 0, below = i + 1 < finalBands.length ? Math.floor((b + finalBands[i + 1][0]) / 2) : t.h;
    while (a > above && inkAt(a - 1)) a--;
    while (b < below && inkAt(b)) b++;
    return [a, b];
  };
  const regions = finalBands.map(([core0, core1], i): Region => {
    if (i && pitches[i - 1] > basePitch * 1.25) group++;
    const [a, b] = reach(i);
    const ink = box(alpha, W, H, a + t.y, b + t.y)!;
    const previous = finalBands[i - 1], next = finalBands[i + 1];
    const y = Math.max(0, a - padding, previous ? Math.ceil((previous[1] + a) / 2) : 0);
    const end = Math.min(t.h, b + padding, next ? Math.floor((b + next[0]) / 2) : t.h);
    const x = Math.max(0, ink.x - t.x - padding);
    const unresolvedRows = core1 - core0 > 80 && ink.w / (core1 - core0) < 2.5;
    if (unresolvedRows) warnings.push('Some closely joined lines could not be separated. Check their size; crop into complete verses if needed.');
    // A dense multi-line image must never be mistaken for one giant glyph and
    // shrunk to a 34pt thumbnail. Preserve it as a readable, intact group.
    // Lettering size follows the row test's band, not the thin tails.
    const lineHeight = unresolvedRows ? Math.min(core1 - core0, Math.max(20, ink.w / 12)) : core1 - core0;
    return { x, y, w: Math.min(t.w - x, ink.w + padding * 2), h: end - y, lineHeight, group, top: a, bottom: b, center: Math.round(centres[i] * 10) / 10 };
  });
  const first = regions[0];
  // The index can use the actual opening words as a transparent image. This
  // fills Urdu names faithfully even when OCR cannot transcribe Nastaliq.
  const columns: [number, number][] = [];
  let run = -1;
  for (let x = first.x; x <= first.x + first.w; x++) {
    let ink = 0;
    if (x < first.x + first.w) for (let y = first.y; y < first.y + first.h; y++) if (alpha[(y + t.y) * W + x + t.x] > 55) ink++;
    if (ink && run < 0) run = x;
    if (!ink && run >= 0) { columns.push([run, x]); run = -1; }
  }
  const words: [number, number][] = [];
  for (const c of columns) {
    const previous = words.at(-1);
    if (previous && c[0] - previous[1] < first.lineHeight * 0.16) previous[1] = c[1]; else words.push([...c]);
  }
  const selected = words.length > 6 ? words.slice(-5) : words;
  const opening: Rect = selected.length ? { x: Math.max(0, selected[0][0] - padding), y: first.y, w: Math.min(t.w, selected.at(-1)![1] + padding) - Math.max(0, selected[0][0] - padding), h: first.h } : first;
  // The fihrist shows these words as a plain navy image. CSS masks and hidden
  // overlay images print as solid boxes on many printers and PDF viewers.
  const ow = Math.max(1, Math.min(t.w - opening.x, Math.round(opening.w))), oh = Math.max(1, Math.min(t.h - opening.y, Math.round(opening.h)));
  const ox = Math.round(opening.x), oy = Math.round(opening.y);
  const navy = Buffer.alloc(ow * oh * 4);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const o = (y * ow + x) * 4;
    navy[o] = NAVY[0]; navy[o + 1] = NAVY[1]; navy[o + 2] = NAVY[2];
    navy[o + 3] = alpha[(y + oy + t.y) * W + x + ox + t.x];
  }
  const openingPng = await sharp(navy, { raw: { width: ow, height: oh, channels: 4 } }).png().toBuffer();
  if (median(finalBands.map(([a, b]) => b - a)) < 20) warnings.push('Low-resolution source: a larger original screenshot or PDF will print more clearly.');
  return { width: t.w, height: t.h, bands: finalBands, lineHeight: median(finalBands.map(([a, b]) => b - a)), regions, opening: { x: ox, y: oy, w: ow, h: oh }, suggestedName, recognitionConfidence, warnings, png, openingPng };
}

/** Old booklet entries without a format point at `<id>.svg`: lossless source
 * ink wrapped in an SVG, now built only when such an entry asks for it. */
export const svgWrapper = (png: Buffer, width: number, height: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`;
