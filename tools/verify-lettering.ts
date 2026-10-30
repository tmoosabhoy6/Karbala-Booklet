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
  // A stroke thinner than the row test (the 2px tail of a Nastaliq م) is
  // inside its row's crop, so it is never cut off in print.
  const tail = Buffer.from(`<svg width="2000" height="400" xmlns="http://www.w3.org/2000/svg"><rect width="2000" height="400" fill="white"/>
    ${[0, 1, 2].map((i) => Array.from({ length: 10 }, (_, j) => `<rect x="${200 + j * 160}" y="${40 + i * 120}" width="130" height="50" fill="black"/>`).join('')).join('')}
    <rect x="900" y="90" width="2" height="28" fill="black"/></svg>`);
  const tailed = await cleanScreenshot(tail, {}, { ocr: false });
  const [tailRow] = tailed.regions;
  assert(tailed.regions.length === 3 && tailRow.bottom - tailRow.top >= 50 + 28 - 1 && tailRow.lineHeight === 50, 'A thin tail stays inside its row; the lettering size ignores it.');
  // A refrain of one repeated word (حسين حسين … حسينا) across justified
  // gaps: its outermost words sit level with the row, so they are lettering,
  // not margin numbers. The former cleaner removed them (6% of the ink).
  const refrain = await readFile('tests/fixtures/lettering/refrain-margin-words.png');
  const refrainRaw = await sharp(refrain).removeAlpha().raw().toBuffer();
  let rawInk = 0;
  for (let i = 0; i < refrainRaw.length; i += 3) if (255 - Math.min(refrainRaw[i], refrainRaw[i + 1], refrainRaw[i + 2]) > 100) rawInk++;
  const refrainClean = await sharp((await cleanScreenshot(refrain, {}, { ocr: false })).png).ensureAlpha().raw().toBuffer();
  let cleanInk = 0;
  for (let i = 3; i < refrainClean.length; i += 4) if (refrainClean[i] > 100) cleanInk++;
  assert(cleanInk >= rawInk * 0.98, `Refrain words at the margins must stay (${cleanInk} of ${rawInk} ink pixels).`);
  // Cover logos: one solid ink colour, fully transparent around it, and solid
  // strokes fully opaque so the cover's plaid can never tint the letters.
  for (const logo of ['logo-karbala.png', 'logo-faiz-husaini.png']) {
    const { data: px, info: li } = await sharp('public/assets/' + logo).raw().toBuffer({ resolveWithObject: true });
    assert.equal(li.channels, 4, logo + ' must be transparent');
    const colours = new Set<number>(), alphas: number[] = [];
    for (let i = 0; i < px.length; i += 4) { colours.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]); alphas.push(px[i + 3]); }
    assert.equal(colours.size, 1, logo + ': no background colour may remain in the logo');
    const corners = [0, li.width - 1, (li.height - 1) * li.width, li.height * li.width - 1].map((i) => px[i * 4 + 3]);
    assert(corners.every((a) => a === 0), logo + ': the background must be fully transparent');
    const strong = alphas.filter((a) => a >= 128);
    assert(strong.filter((a) => a === 255).length / strong.length > 0.75, logo + ': solid strokes must be fully opaque');
  }
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
  console.log('Passed: 11 real screenshot cases, margin numbers/badges, refrain words at the margins kept, thin tails inside their rows, unmerged uniform rows, navy fihrist openings, opaque cover logos, faint strokes, detached dots, red refrains, portrait/strip sizing, six-PDF reference bank.');
} finally { await closeRecognition(); }
