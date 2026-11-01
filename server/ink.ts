// Screenshot cleaning on the server: decode with sharp, clean with the shared
// ink code (src/library/ink.ts, which the browser runs too), encode PNGs.
import sharp from 'sharp';
import { recognize } from './recognize';
import { cleanPixels, type Edits, type InkGeometry, type Pixels } from '../src/library/ink';

export { PROCESSOR_VERSION, findBands } from '../src/library/ink';
export type { Edits, Rect, Region } from '../src/library/ink';

export interface InkResult extends InkGeometry { png: Buffer; openingPng: Buffer | null }

const encode = (p: Pixels) => sharp(p.data, { raw: { width: p.width, height: p.height, channels: p.channels } }).png().toBuffer();

export async function cleanScreenshot(input: Buffer, edits: Edits = {}, options: { ocr?: boolean; marks?: boolean } = {}): Promise<InkResult> {
  const { data, info } = await sharp(input, { limitInputPixels: 20_000_000 }).rotate().flatten({ background: '#fff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const source: Pixels = { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height, channels: 3 };
  const { image, openingImage, ...geometry } = await cleanPixels(source, edits, {
    marks: options.marks,
    recognize: options.ocr !== false ? async (white) => recognize(await encode(white)) : undefined,
  });
  const [png, openingPng] = await Promise.all([encode(image), encode(openingImage)]);
  return { ...geometry, png, openingPng };
}

/** Old booklet entries without a format point at `<id>.svg`: lossless source
 * ink wrapped in an SVG, now built only when such an entry asks for it. */
export const svgWrapper = (png: Buffer, width: number, height: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`;
