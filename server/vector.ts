// Fit source contours only after recovering a linear, antialiased ink matte.
// Keep edge coverage linear and disable the tracer's small-component removal.
import sharp from 'sharp';
import potrace from 'potrace';

async function paths(mask: Buffer, width: number, height: number, color: string) {
  const scale = Math.max(1, Math.min(4, Math.sqrt(4_000_000 / (width * height))));
  const w = Math.round(width * scale), h = Math.round(height * scale);
  const image = await sharp(mask, { raw: { width, height, channels: 1 } }).resize(w, h, { kernel: 'lanczos3' }).png().toBuffer();
  const tracer = new potrace.Potrace();
  await new Promise<void>((resolve, reject) => tracer.loadImage(image, (error: Error | null) => error ? reject(error) : resolve()));
  tracer.setParameters({ threshold: 128, turdSize: 0, optTolerance: 0.04, alphaMax: 1 });
  return `<g transform="scale(${width / w} ${height / h})">${tracer.getPathTag(color)}</g>`;
}

export async function vectorInk(png: Buffer): Promise<string> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const black = Buffer.alloc(info.width * info.height, 255), red = Buffer.from(black);
  let redPixels = 0;
  for (let i = 0; i < black.length; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
    if (r > g + 35 && r > b + 35) { red[i] = 255 - a; redPixels++; }
    else black[i] = 255 - a;
  }
  const ink = await paths(black, info.width, info.height, '#000000');
  const refrain = redPixels ? await paths(red, info.width, info.height, '#ef0000') : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}" viewBox="0 0 ${info.width} ${info.height}">${ink}${refrain}</svg>`;
}
