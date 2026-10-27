// Screenshot → print-quality ink.
//
// 1. Find the screenshot's background colour (median of its edge pixels), so
//    cream, coloured or dark-mode screenshots all work.
// 2. Turn every pixel into ink coverage (alpha) by its distance from that
//    background, then "un-mix" the background out to recover the true ink
//    colour. Neutral ink becomes pure black; coloured ink (e.g. a red line)
//    keeps its colour.
// 3. Apply the user's erase boxes and crop, trim to the ink, and find the
//    text lines (bands) so pages can break between lines.
// 4. Trace each colour layer with potrace into one SVG: razor-sharp at any
//    size, on a clean white page, with the letters exactly as in the source.
import sharp from 'sharp';
import potrace from 'potrace';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Edits {
  crop?: Rect;
  erase?: Rect[];
}

export interface InkResult {
  width: number;
  height: number;
  /** Text-line bands [top, bottom] in output pixels. */
  bands: [number, number][];
  /** Median line height in px, used to normalise text size. */
  lineHeight: number;
  png: Buffer;
  svg: string;
}

const ALPHA_LO = 22; // colour distance below which a pixel is background
const ALPHA_HI = 120; // distance at which a pixel is solid ink
const COLOUR_CHROMA = 70; // un-mixed chroma above which ink keeps its colour

export async function cleanScreenshot(input: Buffer, edits: Edits = {}): Promise<InkResult> {
  const { data, info } = await sharp(input)
    .rotate()
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let W = info.width;
  let H = info.height;
  let rgb: Uint8Array = data;

  if (edits.crop) {
    const c = clampRect(edits.crop, W, H);
    const out = new Uint8Array(c.w * c.h * 3);
    for (let y = 0; y < c.h; y++) {
      out.set(rgb.subarray(((c.y + y) * W + c.x) * 3, ((c.y + y) * W + c.x + c.w) * 3), y * c.w * 3);
    }
    rgb = out;
    W = c.w;
    H = c.h;
  }

  const bg = backgroundColour(rgb, W, H);
  const n = W * H;
  const alpha = new Float32Array(n);
  const ink = new Uint8Array(n * 3);
  const coloured = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    const d = Math.hypot(r - bg[0], g - bg[1], b - bg[2]);
    const a = Math.min(1, Math.max(0, (d - ALPHA_LO) / (ALPHA_HI - ALPHA_LO)));
    alpha[i] = a;
    if (a <= 0) continue;
    // Un-mix: observed = a·ink + (1−a)·bg  →  ink = (observed − (1−a)·bg) / a
    const ur = clamp255((r - (1 - a) * bg[0]) / a);
    const ug = clamp255((g - (1 - a) * bg[1]) / a);
    const ub = clamp255((b - (1 - a) * bg[2]) / a);
    const chroma = Math.max(ur, ug, ub) - Math.min(ur, ug, ub);
    if (chroma > COLOUR_CHROMA && a > 0.35) {
      coloured[i] = 1;
      ink[i * 3] = ur;
      ink[i * 3 + 1] = ug;
      ink[i * 3 + 2] = ub;
    }
  }

  // Erase boxes are in original-screenshot pixels; shift them into the crop.
  const ox = edits.crop ? clampRect(edits.crop, info.width, info.height).x : 0;
  const oy = edits.crop ? clampRect(edits.crop, info.width, info.height).y : 0;
  for (const e of edits.erase ?? []) {
    const x0 = Math.max(0, Math.round(e.x - ox));
    const y0 = Math.max(0, Math.round(e.y - oy));
    const x1 = Math.min(W, Math.round(e.x - ox + e.w));
    const y1 = Math.min(H, Math.round(e.y - oy + e.h));
    for (let y = y0; y < y1; y++) if (x1 > x0) alpha.fill(0, y * W + x0, y * W + x1);
  }

  // Trim to the ink with a small margin.
  const box = inkBox(alpha, W, H);
  if (!box) throw new Error('No text found in this screenshot.');
  const pad = Math.round(Math.max(4, (box.h > 0 ? box.h : H) * 0.02));
  const t = clampRect({ x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad }, W, H);

  const OW = t.w;
  const OH = t.h;
  const outA = new Float32Array(OW * OH);
  const outRGBA = Buffer.alloc(OW * OH * 4);
  const colourHist = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let y = 0; y < OH; y++) {
    for (let x = 0; x < OW; x++) {
      const si = (t.y + y) * W + (t.x + x);
      const oi = y * OW + x;
      const a = alpha[si];
      outA[oi] = a;
      if (coloured[si]) {
        outRGBA[oi * 4] = ink[si * 3];
        outRGBA[oi * 4 + 1] = ink[si * 3 + 1];
        outRGBA[oi * 4 + 2] = ink[si * 3 + 2];
        // Bucket by coarse hue so each ink colour becomes one vector layer.
        const key = hueBucket(ink[si * 3], ink[si * 3 + 1], ink[si * 3 + 2]);
        const h = colourHist.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
        h.n++;
        h.r += ink[si * 3];
        h.g += ink[si * 3 + 1];
        h.b += ink[si * 3 + 2];
        colourHist.set(key, h);
      }
      outRGBA[oi * 4 + 3] = Math.round(a * 255);
    }
  }

  const bands = findBands(outA, OW, OH);
  const heights = bands.map(([a, b]) => b - a).sort((p, q) => p - q);
  const lineHeight = heights.length ? heights[heights.length >> 1] : OH;

  const png = await sharp(outRGBA, { raw: { width: OW, height: OH, channels: 4 } }).png().toBuffer();
  const svg = await traceLayers(outA, outRGBA, OW, OH, colourHist);
  return { width: OW, height: OH, bands, lineHeight, png, svg };
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

function clampRect(r: Rect, W: number, H: number): Rect {
  const x = Math.max(0, Math.min(W - 1, Math.round(r.x)));
  const y = Math.max(0, Math.min(H - 1, Math.round(r.y)));
  const w = Math.max(1, Math.min(W - x, Math.round(r.w)));
  const h = Math.max(1, Math.min(H - y, Math.round(r.h)));
  return { x, y, w, h };
}

function backgroundColour(rgb: Uint8Array, W: number, H: number): [number, number, number] {
  const idx: number[] = [];
  for (let x = 0; x < W; x++) idx.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) idx.push(y * W, y * W + W - 1);
  return [0, 1, 2].map((c) => {
    const v = idx.map((i) => rgb[i * 3 + c]).sort((a, b) => a - b);
    return v[v.length >> 1];
  }) as [number, number, number];
}

function inkBox(alpha: Float32Array, W: number, H: number): Rect | null {
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (alpha[y * W + x] > 0.3) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Rows containing ink, grouped into text lines. */
function findBands(alpha: Float32Array, W: number, H: number): [number, number][] {
  // Columns that are inked over most of the height are rules (e.g. the bar
  // between two misra columns); they would join every line, so skip them.
  const skip = new Uint8Array(W);
  for (let x = 0; x < W; x++) {
    let c = 0;
    for (let y = 0; y < H; y++) if (alpha[y * W + x] > 0.3) c++;
    if (H > 60 && c > H * 0.55) skip[x] = 1;
  }
  const counts = new Array<number>(H).fill(0);
  for (let y = 0; y < H; y++) {
    let c = 0;
    for (let x = 0; x < W; x++) if (!skip[x] && alpha[y * W + x] > 0.3) c++;
    counts[y] = c;
  }
  const sorted = [...counts].sort((a, b) => a - b);
  const busy = sorted[Math.floor(sorted.length * 0.9)] || 1;
  const minInk = Math.max(1, busy * 0.02);

  const raw: [number, number][] = [];
  let start = -1;
  for (let y = 0; y <= H; y++) {
    const on = y < H && counts[y] >= minInk;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      raw.push([start, y]);
      start = -1;
    }
  }
  if (raw.length <= 1) return raw;

  const hs = raw.map(([a, b]) => b - a).sort((p, q) => p - q);
  const typical = hs[Math.floor(hs.length * 0.75)];
  // Slivers (dots, harakat above or below a line) join whichever line is closer.
  const lines = raw.filter(([a, b]) => b - a >= typical * 0.35).map(([a, b]) => [a, b] as [number, number]);
  if (!lines.length) return raw;
  for (const [a, b] of raw) {
    if (b - a >= typical * 0.35) continue;
    let best = lines[0];
    let bestGap = Infinity;
    for (const l of lines) {
      const gap = a >= l[1] ? a - l[1] : l[0] >= b ? l[0] - b : 0;
      if (gap < bestGap) {
        bestGap = gap;
        best = l;
      }
    }
    best[0] = Math.min(best[0], a);
    best[1] = Math.max(best[1], b);
  }
  lines.sort((p, q) => p[0] - q[0]);
  // Lines that now touch or overlap become one.
  const merged: [number, number][] = [];
  for (const l of lines) {
    const last = merged[merged.length - 1];
    if (last && l[0] - last[1] < typical * 0.12) last[1] = Math.max(last[1], l[1]);
    else merged.push(l);
  }
  return merged;
}

function hueBucket(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn || 1;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return Math.round(h / 30) % 12;
}

async function traceMask(mask: Uint8Array, W: number, H: number, fill: string): Promise<string> {
  // Upscale small screenshots before tracing so curves come out smooth.
  const scale = W < 1600 ? 2 : 1;
  const buf = await sharp(Buffer.from(mask), { raw: { width: W, height: H, channels: 1 } })
    .resize(W * scale, H * scale, { kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const p = new potrace.Potrace();
  await new Promise<void>((res, rej) => p.loadImage(buf, (e: Error | null) => (e ? rej(e) : res())));
  p.setParameters({ threshold: 128, turdSize: 3 * scale, optTolerance: 0.3, alphaMax: 1.0 });
  const tag = p.getPathTag(fill);
  return scale === 1 ? tag : `<g transform="scale(${1 / scale})">${tag}</g>`;
}

async function traceLayers(
  alpha: Float32Array,
  rgba: Buffer,
  W: number,
  H: number,
  colours: Map<number, { n: number; r: number; g: number; b: number }>,
): Promise<string> {
  const n = W * H;
  // potrace traces dark-on-light, so masks are 255 = paper, 0 = ink.
  const neutral = new Uint8Array(n).fill(255);
  const layers = [...colours.entries()].filter(([, c]) => c.n > 40);
  const colourMasks = new Map(layers.map(([k]) => [k, new Uint8Array(n).fill(255)]));
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    if (a <= 0) continue;
    const v = 255 - Math.round(a * 255);
    const hasColour = rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2] > 0;
    const m = hasColour ? colourMasks.get(hueBucket(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2])) : undefined;
    (m ?? neutral)[i] = v;
  }
  const parts = [await traceMask(neutral, W, H, '#000000')];
  for (const [k, c] of layers) {
    const hex = '#' + [c.r, c.g, c.b].map((v) => Math.round(v / c.n).toString(16).padStart(2, '0')).join('');
    parts.push(await traceMask(colourMasks.get(k)!, W, H, hex));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${parts.join('')}</svg>`;
}
