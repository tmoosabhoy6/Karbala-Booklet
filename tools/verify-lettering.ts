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
  // Six evenly spaced rows. A verse number sits in the margin between rows 1
  // and 2 and a numbered badge beside row 4; a short word inside row 3 sits
  // across a wide justified gap. The numbers must go without joining rows,
  // the short word must stay, and uniform rows must stay one group.
  const words = (y: number, xs: number[], h = 26) => xs.map((x) => `<rect x="${x}" y="${y}" width="70" height="${h}" fill="black"/>`).join('');
  const verse = Buffer.from(`<svg width="560" height="420" xmlns="http://www.w3.org/2000/svg"><rect width="560" height="420" fill="white"/>
    ${[0, 1, 2, 3, 4, 5].map((i) => words(30 + i * 60, i === 2 ? [150, 240, 330, 420] : [130, 220, 310, 400])).join('')}
    <rect x="80" y="47" width="22" height="20" fill="black"/>
    <rect x="20" y="70" width="5" height="17" fill="black"/><rect x="30" y="70" width="8" height="17" fill="black"/>
    <path d="M30 213 Q42 205 46 216 Q42 228 30 224 Z" fill="#c0263a"/></svg>`);
  const numbered = await cleanScreenshot(verse, {}, { ocr: false });
  assert.equal(numbered.bands.length, 6, 'A number between two rows must never merge them.');
  assert(numbered.regions.every((r) => r.group === 0), 'Evenly spaced rows are one stanza; rows are never paired artificially.');
  const ink = await sharp(numbered.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const inkAt = (x0: number, y0: number, x1: number, y1: number) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (ink.data[(y * ink.info.width + x) * 4 + 3] > 60) n++; return n; };
  // Ink spans x 20-482 with the margin marks and 80-482 without them.
  assert(numbered.width < 430, 'Margin verse numbers and badges must be removed.');
  assert(inkAt(0, 0, 30, 45) > 300, 'Lettering inside a verse row must stay.');
  const pitch = numbered.regions.slice(1).map((r, i) => r.center - numbered.regions[i].center);
  assert(pitch.every((p) => Math.abs(p - 60) < 2), 'Row centres must follow the source baselines.');
  assert(numbered.openingPng, 'The fihrist opening is delivered as its own image.');
  const opening = await sharp(numbered.openingPng!).raw().toBuffer();
  assert(opening.every((v, i) => i % 4 === 3 || [58, 69, 106][i % 4] === v), 'Opening words are pre-coloured navy, with no CSS masking.');
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
  console.log('Passed: 11 real screenshot cases, margin numbers/badges, unmerged uniform rows, navy fihrist openings, faint strokes, detached dots, red refrains, portrait/strip sizing, six-PDF reference bank.');
} finally { await closeRecognition(); }
