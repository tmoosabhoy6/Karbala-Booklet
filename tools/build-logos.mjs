// Re-draws the two cover logos in maroon from the raster references.
// Run with `npm run assets`; outputs are committed.
//  - Logo 1 is tiny, so it is traced to a vector (SVG) for print sharpness.
//  - Logo 2 already exceeds 1000 dpi at its printed size and carries hairline
//    text that tracing would smear, so it becomes a maroon alpha cut-out (PNG).
import sharp from 'sharp';
import potrace from 'potrace';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const trace = promisify(potrace.trace);
const MAROON = '#8C1A24';

const logos = [
  // Logo 1 is tiny (300×159) on a beige ground: upscale hard and smooth before
  // tracing so potrace fits clean curves instead of pixel stairs.
  { src: 'references/Logo 1.jpeg', out: 'public/assets/logo-karbala.svg', scale: 8, blur: 11, threshold: 128 },
  { src: 'references/Logo 2.jpeg', out: 'public/assets/logo-faiz-husaini.png', matte: true },
];

async function inkMask({ src, scale = 1, blur = 0 }) {
  const img = sharp(src).removeAlpha();
  const { width, height } = await img.metadata();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  // Background = median of the border pixels; ink = distance from it.
  const border = [];
  for (let x = 0; x < info.width; x++) {
    border.push(x, x + (info.height - 1) * info.width);
  }
  for (let y = 0; y < info.height; y++) {
    border.push(y * info.width, y * info.width + info.width - 1);
  }
  const med = [0, 1, 2].map((c) => {
    const v = border.map((i) => data[i * 3 + c]).sort((a, b) => a - b);
    return v[v.length >> 1];
  });
  const gray = Buffer.alloc(info.width * info.height);
  for (let i = 0; i < gray.length; i++) {
    const d = Math.hypot(data[i * 3] - med[0], data[i * 3 + 1] - med[1], data[i * 3 + 2] - med[2]);
    gray[i] = 255 - Math.min(255, Math.round(d * 1.6));
  }
  const out = sharp(gray, { raw: { width: info.width, height: info.height, channels: 1 } })
    .resize(width * scale, height * scale, { kernel: 'lanczos3' });
  return (blur ? out.blur(blur) : out).png().toBuffer();
}

// Solid maroon with the ink strength as alpha, so edges keep their smoothness.
async function maroonCutout(mask, out) {
  const { data, info } = await sharp(mask).negate().raw().toBuffer({ resolveWithObject: true });
  const [r, g, b] = [0x8c, 0x1a, 0x24];
  const rgba = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = Math.min(255, Math.round(data[i * info.channels] * 1.25));
  }
  await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(out);
}

for (const logo of logos) {
  const mask = await inkMask(logo);
  if (logo.matte) {
    await maroonCutout(mask, logo.out);
    console.log('wrote', logo.out);
    continue;
  }
  const svg = await trace(mask, {
    threshold: logo.threshold,
    turdSize: 6 * logo.scale,
    optTolerance: 0.4,
    alphaMax: 1.1,
    color: MAROON,
    background: 'transparent',
  });
  await writeFile(logo.out, svg);
  console.log('wrote', logo.out, `${(svg.length / 1024).toFixed(0)} KB`);
}
