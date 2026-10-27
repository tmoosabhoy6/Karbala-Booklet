// Cuts the two cover logos out of their high-resolution references.
// Run with `npm run assets`; outputs are committed.
// Both sources are ~2000 px (over 900 dpi at their printed size), so each
// becomes its own ink colour with the ink strength as alpha: no tracing, so
// hairline text and smooth edges survive exactly as drawn.
import sharp from 'sharp';

const logos = [
  { src: 'references/Logo 1 HD.jpg', out: 'public/assets/logo-karbala.png' },
  { src: 'references/Logo 2 HD.jpg', out: 'public/assets/logo-faiz-husaini.png' },
];

for (const logo of logos) {
  const { data, info } = await sharp(logo.src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  // Background = median of the border pixels; ink = distance from it.
  const border = [];
  for (let x = 0; x < info.width; x++) border.push(x, x + (info.height - 1) * info.width);
  for (let y = 0; y < info.height; y++) border.push(y * info.width, y * info.width + info.width - 1);
  const bg = [0, 1, 2].map((c) => {
    const v = border.map((i) => data[i * 3 + c]).sort((a, b) => a - b);
    return v[v.length >> 1];
  });
  const ink = new Float32Array(n);
  for (let i = 0; i < n; i++) ink[i] = Math.hypot(data[i * 3] - bg[0], data[i * 3 + 1] - bg[1], data[i * 3 + 2] - bg[2]);
  // The logo's own colour: the median of its most solid strokes.
  const strongest = [...ink].sort((a, b) => b - a)[Math.floor(n * 0.02)];
  const solid = [];
  for (let i = 0; i < n; i++) if (ink[i] >= strongest) solid.push(i);
  const colour = [0, 1, 2].map((c) => {
    const v = solid.map((i) => data[i * 3 + c]).sort((a, b) => a - b);
    return v[v.length >> 1];
  });
  const full = Math.hypot(colour[0] - bg[0], colour[1] - bg[1], colour[2] - bg[2]);
  const rgba = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    rgba.set(colour, i * 4);
    // JPEG noise near the paper colour becomes fully transparent.
    const a = (ink[i] / full - 0.06) / 0.94;
    rgba[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
  }
  await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).trim().png({ compressionLevel: 9 }).toFile(logo.out);
  const meta = await sharp(logo.out).metadata();
  console.log('wrote', logo.out, `${meta.width}×${meta.height}`, `rgb(${colour.join(',')})`);
}
