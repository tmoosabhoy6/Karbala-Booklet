import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { cleanScreenshot } from '../server/ink';
import { closeRecognition } from '../server/recognize';
import { letteringReferences, referenceBank, restorationCanvas } from '../server/lettering';

const counts = [1, 2, 4, 6, 11, 9, 9, 7, 2, 2];
try {
  const files = (await readdir('tests/fixtures/lettering')).filter((f) => f.startsWith('Screenshot')).sort();
  assert.equal(files.length, counts.length);
  for (let i = 0; i < files.length; i++) {
    const r = await cleanScreenshot(await readFile('tests/fixtures/lettering/' + files[i]));
    assert.equal(r.bands.length, counts[i], files[i] + ': all verse rows must remain');
    assert(r.regions.every((region) => region.y >= 0 && region.y + region.h <= r.height));
  }
  const dawat = await cleanScreenshot(await readFile('tests/fixtures/lettering/dawat-refrains.png'));
  assert.equal(dawat.bands.length, 6, 'Both three-line Lisan al-Dawat stanzas must survive.');
  const pixels = await sharp(dawat.png).raw().toBuffer();
  assert(pixels.some((v,i) => i%4 === 0 && v > 180 && pixels[i+1] < 100 && pixels[i+3] > 150), 'Keep the red refrain.');

  // A hairline with only 35% coverage vanished under the former 50% tracer.
  // A detached dot, separated from the main body, must survive pagination too.
  const fixture = Buffer.from('<svg width="200" height="140"><rect width="200" height="140" fill="white"/><path d="M30 70H160V100H30Z" fill="black"/><path d="M50 70V40" stroke="#aaaaaa" stroke-width="1"/><rect x="80" y="18" width="3" height="3" fill="black"/></svg>');
  const result = await cleanScreenshot(fixture, { autoClean: false }, { ocr: false });
  const { data, info } = await sharp(result.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = Array.from({ length: info.width * info.height }, (_, i) => data[i*4+3]);
  assert(alpha.some((a) => a > 20 && a < 128), 'Faint stroke coverage must remain in the exported ink.');
  assert.equal(result.bands.length, 1);
  const row = result.regions[0];
  let firstInk = info.height;
  for (let y=0; y<info.height; y++) for (let x=0; x<info.width; x++) if(alpha[y*info.width+x]>40) firstInk=Math.min(firstInk,y);
  assert(row.y <= firstInk, 'The isolated dot must be inside the placed row crop.');
  for (const [w,h] of [[638,876],[628,112],[508,406],[300,2000],[2000,300]]) {
    const c=restorationCanvas(w,h);
    assert(c.width%16===0 && c.height%16===0);
    assert(c.width*c.height>=655360 && c.width*c.height<=8294400);
    assert(Math.max(c.width/c.height,c.height/c.width)<=3);
    assert((w<h)===(c.width<c.height), 'Keep portrait/landscape orientation.');
  }
  assert.equal(referenceBank.documents,6);assert.equal(referenceBank.pages,153);
  assert.equal((await letteringReferences('auto')).length,6);
  assert.equal((await letteringReferences('urdu')).length,2);
  console.log('Passed: 11 real screenshot cases, faint strokes, detached dots, red refrains, portrait/strip sizing, six-PDF reference bank.');
} finally { await closeRecognition(); }
