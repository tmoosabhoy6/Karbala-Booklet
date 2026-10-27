// Recover source ink without tracing, smoothing, or inventing letter shapes.
// Each verse row gets its own geometry, independent of screenshot zoom.
import sharp from 'sharp';
import { recognize } from './recognize';

export const PROCESSOR_VERSION = 4;
export interface Rect { x: number; y: number; w: number; h: number }
export interface Edits { crop?: Rect; erase?: Rect[]; autoClean?: boolean }
export interface Region extends Rect { lineHeight: number; group: number }
export interface InkResult {
  width: number; height: number; bands: [number, number][]; lineHeight: number;
  regions: Region[]; opening: Rect; suggestedName: string; recognitionConfidence: number;
  warnings: string[]; png: Buffer; svg: string;
}
const median = (a: number[]) => a.length ? [...a].sort((p, q) => p - q)[a.length >> 1] : 1;
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
export function findBands(alpha: Uint8Array, W: number, H: number): [number, number][] {
  const raw: [number, number][] = [];
  let start = -1;
  for (let y = 0; y <= H; y++) {
    let count = 0;
    if (y < H) for (let x = 0; x < W; x++) if (alpha[y * W + x] > 55) count++;
    const on = count >= Math.max(2, W * 0.0015);
    if (on && start < 0) start = y;
    if (!on && start >= 0) { raw.push([start, y]); start = -1; }
  }
  const tall = raw.map(([a, b]) => b - a).filter((h) => h >= 4).sort((a, b) => a - b);
  const typical = tall[Math.floor(tall.length * 0.7)] ?? 10;
  const main = raw.filter(([a, b]) => b - a >= typical * 0.4).map(([a, b]) => [a, b] as [number, number]);
  if (!main.length) return raw;
  for (const [a, b] of raw) {
    if (b - a >= typical * 0.4) continue;
    const nearest = main.map((l) => ({ l, gap: Math.max(0, a - l[1], l[0] - b) })).sort((a, b) => a.gap - b.gap)[0];
    if (nearest.gap <= typical * 0.5) { nearest.l[0] = Math.min(nearest.l[0], a); nearest.l[1] = Math.max(nearest.l[1], b); }
  }
  const merged: [number, number][] = [];
  for (const band of main.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && band[0] <= last[1]) last[1] = Math.max(last[1], band[1]); else merged.push(band);
  }
  return merged;
}
export async function cleanScreenshot(input: Buffer, edits: Edits = {}): Promise<InkResult> {
  const { data, info } = await sharp(input, { limitInputPixels: 20_000_000 }).rotate().flatten({ background: '#fff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const crop = clampRect(edits.crop ?? { x: 0, y: 0, w: info.width, h: info.height }, info.width, info.height);
  const W = crop.w, H = crop.h;
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) rgb.set(data.subarray(((y + crop.y) * info.width + crop.x) * 3, ((y + crop.y) * info.width + crop.x + W) * 3), y * W * 3);
  const bg = background(rgb, W, H), dark = Math.max(...bg) < 128;
  const alpha = new Uint8Array(W * H), colors = new Uint8Array(W * H * 3);
  for (let i = 0; i < alpha.length; i++) {
    const channels = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
    // True coverage preserves grey antialiased edges rather than turning them
    // all solid black (the former crayon effect).
    const coverage = Math.max(...channels.map((v, c) => dark ? (v - bg[c]) / Math.max(1, 255 - bg[c]) : (bg[c] - v) / Math.max(1, bg[c])));
    if (coverage < 0.045) continue;
    alpha[i] = clamp(coverage * 255);
    if (Math.max(...channels) - Math.min(...channels) > 45) {
      const a = Math.max(coverage, 0.01);
      for (let c = 0; c < 3; c++) colors[i * 3 + c] = clamp((channels[c] - (1 - a) * bg[c]) / a);
    }
  }
  for (const r of edits.erase ?? []) erase(alpha, W, H, { ...r, x: r.x - crop.x, y: r.y - crop.y });
  if (edits.autoClean !== false) removeRules(alpha, W, H);
  const warnings: string[] = [];
  let bands = findBands(alpha, W, H);
  const typical = median(bands.map(([a, b]) => b - a));
  if (edits.autoClean !== false) for (const [a, b] of bands) {
    if ((a <= 1 || b >= H - 1) && b - a < typical * 0.55) erase(alpha, W, H, { x: 0, y: a, w: W, h: b - a });
  }
  const makePng = async (white: boolean) => {
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < alpha.length; i++) {
      const a = alpha[i] / 255;
      for (let c = 0; c < 3; c++) rgba[i * 4 + c] = white ? clamp(colors[i * 3 + c] * a + 255 * (1 - a)) : colors[i * 3 + c];
      rgba[i * 4 + 3] = white ? 255 : alpha[i];
    }
    return sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  };
  let suggestedName = '', recognitionConfidence = 0;
  try {
    const recognized = await recognize(await makePng(true));
    suggestedName = recognized.name; recognitionConfidence = recognized.confidence;
    if (edits.autoClean !== false) for (const r of recognized.numbers) erase(alpha, W, H, { x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 });
  } catch (error) {
    console.error('Index recognition unavailable:', error);
    warnings.push('Automatic page-number detection was unavailable. Check for screenshot page numbers.');
  }
  bands = findBands(alpha, W, H);
  if (edits.autoClean !== false && bands.length) {
    const keep = new Uint8Array(H);
    for (const [a, b] of bands) keep.fill(1, a, b);
    for (let y = 0; y < H; y++) if (!keep[y]) erase(alpha, W, H, { x: 0, y, w: W, h: 1 });
  }
  const bounds = box(alpha, W, H);
  if (!bounds) throw new Error('No complete text found. Try a screenshot containing a complete verse.');
  const padding = Math.max(3, Math.round(typical * 0.09));
  const t = clampRect({ x: bounds.x - padding, y: bounds.y - padding, w: bounds.w + padding * 2, h: bounds.h + padding * 2 }, W, H);
  const png = await sharp(await makePng(false)).extract({ left: t.x, top: t.y, width: t.w, height: t.h }).png().toBuffer();
  const finalBands = bands.map(([a, b]) => [Math.max(0, a - t.y), Math.min(t.h, b - t.y)] as [number, number]).filter(([a, b]) => b > a);
  const gaps = finalBands.slice(1).map(([a], i) => a - finalBands[i][1]);
  const normalGap = median(gaps.filter((g) => g > 0));
  const paragraphBreaks = gaps.some((g) => g > normalGap * 1.8);
  let group = 0, inGroup = 0;
  const regions = finalBands.map(([a, b], i): Region => {
    if (i && ((!paragraphBreaks && inGroup >= 2) || a - finalBands[i - 1][1] > normalGap * 1.8)) { group++; inGroup = 0; }
    inGroup++;
    const ink = box(alpha, W, H, a + t.y, b + t.y)!;
    const x = Math.max(0, ink.x - t.x - padding), y = Math.max(0, a - padding);
    return { x, y, w: Math.min(t.w - x, ink.w + padding * 2), h: Math.min(t.h, b + padding) - y, lineHeight: b - a, group };
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
  const selected = words.length > 6 ? words.slice(-4) : words;
  const opening: Rect = selected.length ? { x: Math.max(0, selected[0][0] - padding), y: first.y, w: Math.min(t.w, selected.at(-1)![1] + padding) - Math.max(0, selected[0][0] - padding), h: first.h } : first;
  if (median(finalBands.map(([a, b]) => b - a)) < 20) warnings.push('Low-resolution source: a larger original screenshot or PDF will print more clearly.');
  // Compatibility for old thumbnails; lossless source ink, no curve fitting.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${t.w}" height="${t.h}" viewBox="0 0 ${t.w} ${t.h}"><image width="${t.w}" height="${t.h}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`;
  return { width: t.w, height: t.h, bands: finalBands, lineHeight: median(finalBands.map(([a, b]) => b - a)), regions, opening, suggestedName, recognitionConfidence, warnings, png, svg };
}
