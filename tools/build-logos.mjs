// Cuts the two cover logos out of their high-resolution references.
// Run with `npm run assets`; outputs are committed.
// Both sources are ~2000 px (over 900 dpi at their printed size), so each
// becomes its own ink colour with the ink strength as alpha: no tracing, so
// hairline text and smooth edges survive exactly as drawn.
// Ink strength is measured as colourfulness (max − min channel). Any neutral
// background, white paper or a baked-in grey/white "transparency"
// checkerboard, has none, so none of it can reach the page.
import sharp from 'sharp';

const logos = [
  { src: 'references/Logo 1 HD.jpg', out: 'public/assets/logo-karbala.png' },
  { src: 'references/Logo 2 HD.jpg', out: 'public/assets/logo-faiz-husaini.png' },
];

const chroma = (d, i) => Math.max(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]) - Math.min(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]);

for (const logo of logos) {
  const { data, info } = await sharp(logo.src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = chroma(data, i);
  // Background noise: the colour found in pale neutral pixels (paper or
  // checker squares). Logos may touch the image edge, so the border alone
  // is not a reliable sample.
  const pale = [];
  for (let i = 0; i < n; i++) if (Math.min(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]) >= 215) pale.push(c[i]);
  pale.sort((a, b) => a - b);
  const noise = pale[Math.floor(pale.length * 0.995)] + 1;
  // The logo's own colour: the median of its most solid strokes.
  const strongest = [...c].sort((a, b) => b - a)[Math.floor(n * 0.02)];
  const solid = [];
  for (let i = 0; i < n; i++) if (c[i] >= strongest) solid.push(i);
  const colour = [0, 1, 2].map((k) => {
    const v = solid.map((i) => data[i * 3 + k]).sort((a, b) => a - b);
    return v[v.length >> 1];
  });
  // Fully opaque from the weakest part of a solid stroke: JPEG noise makes
  // stroke interiors uneven, and any partial alpha there would let the page
  // background tint the letters. Only the antialiased edge is partial.
  const full = Math.max(...colour) - Math.min(...colour);
  const core = [];
  for (let i = 0; i < n; i++) if (c[i] >= full * 0.75) core.push(c[i]);
  core.sort((a, b) => a - b);
  const opaqueAt = core[Math.floor(core.length * 0.01)];
  const rgba = Buffer.alloc(n * 4);
  let opaque = 0;
  for (let i = 0; i < n; i++) {
    rgba.set(colour, i * 4);
    const a = Math.max(0, Math.min(1, (c[i] - noise) / (opaqueAt - noise)));
    rgba[i * 4 + 3] = Math.round(a * 255);
    if (a > 0) opaque++;
  }
  await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).trim().png({ compressionLevel: 9 }).toFile(logo.out);
  const meta = await sharp(logo.out).metadata();
  console.log('wrote', logo.out, `${meta.width}×${meta.height}`, `rgb(${colour.join(',')})`, `alpha ${noise}→${opaqueAt}`, `${((opaque / n) * 100).toFixed(1)}% ink`);
}
