// Screenshot cleaning on the server: decode with sharp, clean with the shared
// ink code (src/library/ink.ts, which the browser runs too), then bring the
// lettering up to print resolution (enhance below), encode PNGs.
import sharp from 'sharp';
import { recognize } from './recognize';
import { cleanPixels, type Edits, type InkGeometry, type Pixels, type Recognized, type Rect } from '../src/library/ink';

export { PROCESSOR_VERSION, findBands } from '../src/library/ink';
export type { Edits, Rect, Region } from '../src/library/ink';

export interface InkResult extends InkGeometry { png: Buffer; openingPng: Buffer | null }

const encode = (p: Pixels) => sharp(p.data, { raw: { width: p.width, height: p.height, channels: p.channels } }).png().toBuffer();

/** Rows come out about this tall (px): ~230 DPI at the booklet's 34 pt line,
 * close to the library verses rendered from vector PDFs. */
const TARGET_ROW = 110;
const MAX_SCALE = 4;
/** Pixels of the finished image at most (the free host has 512 MB). */
const MAX_PIXELS = 8_000_000;
/** Ink coverage kept below/above which the upscaled edge is clear/solid. */
const EDGE_LOW = 0.2, EDGE_HIGH = 0.8;
/** Ink this strong is lettering; fainter ink counts only beside it. */
const STRONG = 90, FAINT = 14;
/** Fihrist navy, as the shared cleaner colours the opening words. */
const NAVY = [58, 69, 106];

/**
 * HD lettering from a low-resolution or washed-out screenshot, without
 * redrawing a single letter: only the source's own ink is used.
 *  1. Faint, washed-out ink is brought up to full strength (one gain for the
 *     whole image, so every word and dot keeps its relative weight).
 *  2. Small rows are upscaled with a Lanczos filter to ~110 px, and each
 *     soft upscaled edge is sharpened into a crisp, smooth contour. Faint
 *     specks of grain and JPEG noise below 10% fall away; strokes and dots
 *     keep their shape (the edge sits slightly outside the old 50% line, so
 *     hairlines stay connected rather than thinning out).
 * The geometry is scaled with it, so the printed size does not change.
 */
async function enhance(result: InkGeometry & { image: Pixels }): Promise<{ geometry: InkGeometry; image: Pixels; opening: Pixels } | null> {
  const { image } = result;
  const n = image.width * image.height;
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) alpha[i] = image.data[i * 4 + 3];
  // 1. Ink strength: the 95th percentile of clearly inked pixels is a stroke's core.
  const histogram = new Uint32Array(256);
  let inked = 0;
  for (let i = 0; i < n; i++) if (alpha[i] > 40) { histogram[alpha[i]]++; inked++; }
  let core = 255;
  for (let v = 255, seen = 0; v > 40; v--) { seen += histogram[v]; if (seen >= inked * 0.05) { core = v; break; } }
  const gain = core < 230 && inked > 50 ? Math.min(4, 245 / Math.max(1, core)) : 1;
  // 2. Resolution.
  const rows = result.regions.map((r) => r.lineHeight).filter((h) => h > 0).sort((a, b) => a - b);
  const row = rows.length ? rows[rows.length >> 1] : result.lineHeight;
  let scale = Math.min(MAX_SCALE, TARGET_ROW / Math.max(1, row), Math.sqrt(MAX_PIXELS / n));
  if (scale < 1.25) scale = 1;
  if (scale === 1 && gain === 1) return null;
  for (let i = 0; i < n; i++) alpha[i] = Math.min(255, Math.round(alpha[i] * gain));
  // Grain: faint ink is kept only where it joins clear lettering (a thin
  // connecting stroke, the soft edge of a letter), and strengthened there;
  // faint specks on their own (paper texture, JPEG noise) are dropped. Every
  // dot and mark with a clear core stays, however small.
  const joined = new Uint8Array(n);
  const stack: number[] = [];
  for (let i = 0; i < n; i++) if (alpha[i] >= STRONG) { joined[i] = 1; stack.push(i); }
  const w = image.width;
  while (stack.length) {
    const p = stack.pop()!, x = p % w;
    for (let dy = -w; dy <= w; dy += w) for (let dx = -1; dx <= 1; dx++) {
      if ((dx < 0 && x === 0) || (dx > 0 && x === w - 1)) continue;
      const q = p + dy + dx;
      if (q >= 0 && q < n && !joined[q] && alpha[q] >= FAINT) { joined[q] = 1; stack.push(q); }
    }
  }
  for (let i = 0; i < n; i++) if (alpha[i] < STRONG) alpha[i] = joined[i] ? Math.min(255, Math.round(alpha[i] * 1.5)) : 0;
  const W = Math.round(image.width * scale), H = Math.round(image.height * scale);
  let big: Uint8Array = alpha, colors: Uint8Array;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { rgb[i * 3] = image.data[i * 4]; rgb[i * 3 + 1] = image.data[i * 4 + 1]; rgb[i * 3 + 2] = image.data[i * 4 + 2]; }
  if (scale > 1) {
    const raw = { width: image.width, height: image.height };
    const scaled = await sharp(Buffer.from(alpha), { raw: { ...raw, channels: 1 } }).resize(W, H, { kernel: 'lanczos3', fit: 'fill' }).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
    if (scaled.info.width !== W || scaled.info.height !== H || scaled.info.channels !== 1) throw new Error('Lettering upscale failed.');
    big = new Uint8Array(scaled.data);
    // Colour only tints the ink (black or the source's red): its own edges never show.
    colors = new Uint8Array(await sharp(Buffer.from(rgb), { raw: { ...raw, channels: 3 } }).resize(W, H, { kernel: 'nearest', fit: 'fill' }).raw().toBuffer());
    const lo = EDGE_LOW * 255, span = (EDGE_HIGH - EDGE_LOW) * 255;
    const curve = new Uint8Array(256);
    for (let v = 0; v < 256; v++) { const t = Math.min(1, Math.max(0, (v - lo) / span)); curve[v] = Math.round(255 * t * t * (3 - 2 * t)); }
    for (let i = 0; i < big.length; i++) big[i] = curve[big[i]];
  } else colors = rgb;
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { out[i * 4] = colors[i * 3]; out[i * 4 + 1] = colors[i * 3 + 1]; out[i * 4 + 2] = colors[i * 3 + 2]; out[i * 4 + 3] = big[i]; }
  const s = (v: number) => v * W / image.width, sy = (v: number) => v * H / image.height;
  const box = (r: Rect, w: number, h: number): Rect => {
    const x = Math.max(0, Math.floor(s(r.x))), y = Math.max(0, Math.floor(sy(r.y)));
    return { x, y, w: Math.max(1, Math.min(w - x, Math.ceil(s(r.x + r.w)) - x)), h: Math.max(1, Math.min(h - y, Math.ceil(sy(r.y + r.h)) - y)) };
  };
  const opening = box(result.opening, W, H);
  const navy = new Uint8Array(opening.w * opening.h * 4);
  for (let y = 0; y < opening.h; y++) for (let x = 0; x < opening.w; x++) {
    const o = (y * opening.w + x) * 4;
    navy[o] = NAVY[0]; navy[o + 1] = NAVY[1]; navy[o + 2] = NAVY[2];
    navy[o + 3] = big[(y + opening.y) * W + x + opening.x];
  }
  const round = (v: number) => Math.round(v * 10) / 10;
  const { image: _image, openingImage: _opening, ...rest } = result as InkGeometry & { image: Pixels; openingImage?: Pixels };
  const geometry: InkGeometry = {
    ...rest,
    scale: Math.round(W / image.width * 1000) / 1000,
    width: W, height: H,
    bands: result.bands.map(([a, b]) => [Math.floor(sy(a)), Math.min(H, Math.ceil(sy(b)))] as [number, number]),
    lineHeight: Math.round(sy(result.lineHeight)),
    regions: result.regions.map((r) => ({
      ...box(r, W, H), lineHeight: Math.round(sy(r.lineHeight)), group: r.group,
      top: Math.floor(sy(r.top)), bottom: Math.min(H, Math.ceil(sy(r.bottom))), center: round(sy(r.center)),
    })),
    opening,
  };
  return { geometry, image: { data: out, width: W, height: H, channels: 4 }, opening: { data: navy, width: opening.w, height: opening.h, channels: 4 } };
}

export async function cleanScreenshot(input: Buffer, edits: Edits = {}, options: { ocr?: boolean; marks?: boolean; enhance?: boolean; known?: Recognized } = {}): Promise<InkResult> {
  const { data, info } = await sharp(input, { limitInputPixels: 20_000_000 }).rotate().flatten({ background: '#fff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const source: Pixels = { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height, channels: 3 };
  const cleaned = await cleanPixels(source, edits, {
    marks: options.marks,
    known: options.known,
    recognize: options.ocr !== false ? async (white) => recognize(await encode(white)) : undefined,
  });
  const { image, openingImage, ...geometry } = cleaned;
  // `enhance: false` keeps the source pixels exactly (an AI draft's check, the
  // library verses that already come at print resolution).
  const hd = options.enhance !== false && edits.autoClean !== false ? await enhance(cleaned) : null;
  const [png, openingPng] = await Promise.all([encode(hd?.image ?? image), encode(hd?.opening ?? openingImage)]);
  return { ...(hd?.geometry ?? geometry), png, openingPng };
}

/** Old booklet entries without a format point at `<id>.svg`: lossless source
 * ink wrapped in an SVG, now built only when such an entry asks for it. */
export const svgWrapper = (png: Buffer, width: number, height: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`;
