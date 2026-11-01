// Renders library verses from the PDF's own vector lettering with MuPDF. The
// server runs this function in a worker thread (its source is sent to the
// worker, so it must not use anything from outside its own body); the browser
// runs it in src/library/worker.ts. Same function, same MuPDF: same pixels.
import type { RenderRequest } from './geometry';

/** RGB pixels of `request`: each job's page crop drawn at `zoom`, whiteouts
 * and zones painted white, highlights un-blended to paper, shadow layers left
 * out, and the crop placed `dy` points down. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderPixels(mupdf: any, doc: any, request: RenderRequest): Uint8Array {
  const { jobs, width, height, zoom } = request;
  // A device that draws everything into `draw` except the listed text objects:
  // same colour, same number of glyphs, first glyph at the same origin.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leaveOut = (draw: any, drops: number[][]) => {
    const rgb = (c: number[]) => (c.length === 1 ? [c[0], c[0], c[0]] : c.length === 4 ? [0, 1, 2].map((i) => (1 - c[i]) * (1 - c[3])) : c);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dropped = (text: any, ctm: number[], color: number[]) => {
      const [r, g, b] = rgb(color);
      const near = drops.filter((d) => Math.abs(d[4] - r) < 0.03 && Math.abs(d[5] - g) < 0.03 && Math.abs(d[6] - b) < 0.03);
      if (!near.length) return false;
      let n = 0;
      let first: number[] | null = null;
      text.walk({ showGlyph: (_font: unknown, trm: number[]) => { if (!first) first = trm; n++; } });
      if (!first) return false;
      const f = first as number[];
      const x = f[4] * ctm[0] + f[5] * ctm[2] + ctm[4], y = f[4] * ctm[1] + f[5] * ctm[3] + ctm[5];
      return near.some((d) => d[7] === n && Math.abs(d[8] - x) < 0.6 && Math.abs(d[9] - y) < 0.6);
    };
    const names = ['fillPath', 'strokePath', 'clipPath', 'clipStrokePath', 'strokeText', 'clipText', 'clipStrokeText', 'ignoreText',
      'fillShade', 'fillImage', 'fillImageMask', 'clipImageMask', 'popClip', 'beginMask', 'endMask', 'beginGroup', 'endGroup',
      'beginTile', 'endTile', 'beginLayer', 'endLayer'];
    const callbacks: Record<string, (...args: unknown[]) => unknown> = {};
    for (const name of names) callbacks[name] = (...args: unknown[]) => draw[name](...args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callbacks.fillText = (text: any, ctm: any, cs: any, color: any, alpha: any) => { if (!dropped(text, ctm, color)) draw.fillText(text, ctm, cs, color, alpha); };
    return new mupdf.Device(callbacks);
  };
  const out = new Uint8Array(width * height * 3).fill(255);
  for (const { page, x0, y0, x1, y1, dy, marks } of jobs) {
    const p = doc.loadPage(page);
    const bx = Math.floor(x0 * zoom), by = Math.floor(y0 * zoom);
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [bx, by, Math.ceil(x1 * zoom), Math.ceil(y1 * zoom)], false);
    pix.clear(255);
    const draw = new mupdf.DrawDevice(mupdf.Matrix.scale(zoom, zoom), pix);
    const dev = marks.d && marks.d.length ? leaveOut(draw, marks.d) : draw;
    p.run(dev, mupdf.Matrix.identity);
    if (dev !== draw) { dev.close(); dev.destroy(); }
    draw.close(); draw.destroy();
    const w = pix.getWidth(), h = pix.getHeight(), stride = pix.getStride();
    const px: Uint8Array = pix.getPixels();
    const fill = (rx0: number, ry0: number, rx1: number, ry1: number, fn: (o: number) => void) => {
      const a = Math.max(0, Math.floor(rx0 * zoom) - bx), b = Math.min(w, Math.ceil(rx1 * zoom) - bx);
      const c = Math.max(0, Math.floor(ry0 * zoom) - by), d = Math.min(h, Math.ceil(ry1 * zoom) - by);
      for (let y = c; y < d; y++) for (let x = a; x < b; x++) fn(y * stride + x * 3);
    };
    // A highlight behind text is un-blended back to paper; marks go white.
    for (const [tx0, ty0, tx1, ty1, t] of marks.t || []) fill(tx0, ty0, tx1, ty1, (o) => {
      let a = 0;
      for (let c = 0; c < 3; c++) a = Math.max(a, (t[c] - px[o + c]) / Math.max(1, t[c]));
      a = Math.min(1, Math.max(0, a));
      for (let c = 0; c < 3; c++) px[o + c] = Math.min(255, px[o + c] + (1 - a) * (255 - t[c]));
    });
    for (const [rx0, ry0, rx1, ry1] of marks.w || []) fill(rx0, ry0, rx1, ry1, (o) => { px[o] = px[o + 1] = px[o + 2] = 255; });
    for (const [ry0, ry1] of marks.z || []) fill(0, ry0, 1e4, ry1, (o) => { px[o] = px[o + 1] = px[o + 2] = 255; });
    const oy = Math.round(dy * zoom);
    for (let y = 0; y < h; y++) {
      const ty = oy + y;
      if (ty < 0 || ty >= height) continue;
      // Overlapping crops (a verse joined across pages) keep the darker ink.
      const row = ty * width * 3;
      for (let x = 0; x < Math.min(w, width) * 3; x++) {
        const v = px[y * stride + x];
        if (v < out[row + x]) out[row + x] = v;
      }
    }
    pix.destroy(); p.destroy();
  }
  return out;
}
