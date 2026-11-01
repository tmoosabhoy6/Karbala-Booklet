// A small PNG encoder for the browser: exact RGBA (a canvas would
// premultiply alpha and change the colours of faint antialiased edges).
// Deflate comes from the browser's own CompressionStream.

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array, start = 0, end = bytes.length) => {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** RGB (3 channels) or RGBA (4) pixels as a PNG file. Each row is filtered
 * with "Up" (the difference from the row above), which suits lettering. */
export async function encodePng(data: Uint8Array, width: number, height: number, channels: 3 | 4): Promise<Blob> {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = y ? 2 : 0;
    const row = data.subarray(y * stride, (y + 1) * stride);
    if (!y) raw.set(row, o + 1);
    else {
      const above = y * stride - stride;
      for (let x = 0; x < stride; x++) raw[o + 1 + x] = (row[x] - data[above + x]) & 255;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bits per channel
  header[9] = channels === 4 ? 6 : 2; // RGBA or RGB
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return new Blob([signature, chunk('IHDR', header), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array())], { type: 'image/png' });
}
