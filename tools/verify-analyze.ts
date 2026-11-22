// Checks how PDFs added in the editor are read (src/library/analyze.ts),
// against real booklet pages whose decorations once broke the spacing.
//
// Kufa ma ek roz: each stanza is four lines with a numbered star centred
// beside them, then a two-line refrain set further left. The star used to
// join the lines beside it into one tall "row", so stanzas came apart into
// pieces with uneven gaps and the uneven heights cut the salam into 14
// kalams; the page number on page 2 was glued onto the last line.
//
// HA 5mi Raat, page 7: a salam in two columns with upright bars between the
// halves of each line; the bars joined every line into two blocks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import { ANALYZER, analyzePdf, readPage } from '../src/library/analyze';

const open = (file: string) => mupdf.Document.openDocument(readFileSync(file), 'application/pdf');
const median = (a: number[]) => [...a].sort((p, q) => p - q)[a.length >> 1];

// ---- stanza badges ----
const kufa = open('tests/fixtures/library/kufa-ma-ek-roz-badges.pdf');
for (let i = 0; i < kufa.countPages(); i++) {
  const page = readPage(mupdf, kufa, i);
  const rows = page.rows.filter((r) => r.kind === 'verse');
  const heights = rows.map((r) => r.b - r.t);
  // Every line is a row of its own: none as tall as two lines.
  assert.ok(Math.max(...heights) < 1.5 * median(heights), `page ${i + 1}: a row ${Math.max(...heights).toFixed(0)} pt tall joins lines (median ${median(heights).toFixed(0)} pt)`);
  // The star beside each stanza is found, not read as lettering.
  const stanzas = i === kufa.countPages() - 1 ? 1 : 2;
  assert.equal(page.side.filter((m) => !m[4]).length, stanzas, `page ${i + 1}: one badge per stanza`);
  // Lines are evenly spaced within a stanza (four lines and the refrain).
  for (let j = 1; j < rows.length; j++) {
    const pitch = rows[j].c - rows[j - 1].c;
    assert.ok(pitch < 60 || pitch > 80, `page ${i + 1}: lines ${j} and ${j + 1} are ${pitch.toFixed(0)} pt apart, neither a line nor a stanza gap`);
  }
}
const { library, found } = analyzePdf(mupdf, kufa, 'Kufa ma ek roz', 'test');
assert.equal(library.an, ANALYZER, 'the reading is stamped with the analyzer version');
assert.equal(found.length, 1, `one salam, not ${found.length} kalams`);
const [k] = library.kalams;
assert.equal(k.st.length, 15, 'fifteen stanzas, each a verse');
for (const [v, parts] of k.st.entries()) {
  assert.equal(parts.length, 1, `stanza ${v + 1} is one piece of one page`);
  const h = parts[0][2] - parts[0][1];
  // Four lines and a two-line refrain, about 45 pt apart, badge included;
  // no page number or blank space below.
  assert.ok(h > 240 && h < 300, `stanza ${v + 1} crop is ${h.toFixed(0)} pt tall`);
}
// The badges print: the verse images reach far enough left to hold them.
const badges = Array.from({ length: kufa.countPages() }, (_, i) => readPage(mupdf, kufa, i).side).flat();
assert.ok(library.x && library.x[0] <= Math.min(...badges.map((m) => m[2])), 'verse images include the badges');

// ---- upright rules between half-lines ----
const ha = open('references/HA_5mi Raat Majlis 1448h.pdf');
const salam = readPage(mupdf, ha, 6);
const lines = salam.rows.filter((r) => r.kind === 'verse' && r.x1 - r.x0 > 300);
assert.equal(lines.length, 11, `two-column salam: 11 lines, not ${lines.length} blocks`);
assert.ok(salam.side.filter((m) => m[4]).length >= 2, 'the bars are found as rules');

console.log('verify-analyze: badges, page numbers and rules read correctly');
