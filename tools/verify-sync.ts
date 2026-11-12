// Checks the decisions that keep two devices' booklets apart from the
// network and React: which copy an editor opens with (src/editor/sync.ts),
// the session date, library ids that name impossible verses, and text boxes
// that stay with their kalam when pages before it change.
import assert from 'node:assert/strict';
import { chooseCopy, retryDelay, sessionDate } from '../src/editor/sync';
import { decodeVerses } from '../src/library/geometry';
import { createBooklet, type Booklet, type Kalam } from '../src/booklet/model';
import { anchorAt, anchorBoxes, paginate, placeBoxes } from '../src/booklet/paginate';

// ---- which copy opens ----
const A = { v: 'A' }, B = { v: 'B' };
assert.deepEqual(chooseCopy(undefined, { value: null, savedAt: 0 }), { use: 'none' }, 'nothing anywhere: a fresh booklet');
assert.deepEqual(chooseCopy(undefined, { value: A, savedAt: 5 }), { use: 'remote' }, 'a new device opens the server copy');
assert.deepEqual(chooseCopy({ value: A, basedOn: 5, dirty: false }, { value: B, savedAt: 9 }), { use: 'remote' }, 'nothing unsaved here: the newer server copy wins');
assert.deepEqual(chooseCopy({ value: A, basedOn: 5, dirty: false }, { value: A, savedAt: 5 }), { use: 'remote' }, 'the same copy');
// Finding: edits typed just before the tab closed were overwritten on reopen.
assert.deepEqual(chooseCopy({ value: A, basedOn: 5, dirty: true }, { value: B, savedAt: 5 }), { use: 'local', save: 'normal' }, 'unsaved edits on the current server copy win and are saved');
assert.deepEqual(chooseCopy({ value: A, basedOn: 5, dirty: true }, { value: B, savedAt: 9 }), { use: 'ask' }, 'unsaved edits on an older copy: ask');
assert.deepEqual(chooseCopy({ value: A, basedOn: 5, dirty: true }, { value: A, savedAt: 9 }), { use: 'remote' }, 'a save sent as the page closed went through: nothing to ask');
assert.deepEqual(chooseCopy({ value: A, basedOn: 7, dirty: false }, { value: null, savedAt: 0 }), { use: 'local', save: 'restore' }, 'a server that lost its copy gets it back under its stamp');
assert.deepEqual(chooseCopy({ value: A, basedOn: 0, dirty: true }, { value: null, savedAt: 0 }), { use: 'local', save: 'normal' }, 'never saved: saved now');
assert.deepEqual(chooseCopy({ value: A, basedOn: 9, dirty: false }, { value: B, savedAt: 5 }), { use: 'local', save: 'restore' }, 'a server holding an older copy gets the newer one back');

// ---- the session date ----
assert.equal(sessionDate('2026-11-01', '2026-11-12'), '2026-11-12', 'a past booklet opens on today');
assert.equal(sessionDate('2026-11-13', '2026-11-12'), '2026-11-13', "tomorrow's booklet keeps its date");
assert.equal(sessionDate('2026-11-12', '2026-11-12'), '2026-11-12');
assert.equal(sessionDate(undefined, '2026-11-12'), '2026-11-12');
assert.equal(sessionDate('garbage', '2026-11-12'), '2026-11-12');
assert(retryDelay(1) < retryDelay(3) && retryDelay(50) === 60_000, 'saves are retried with growing pauses, at most a minute apart');

// ---- library ids ----
assert.deepEqual(decodeVerses('0t2_5', 10), [0, 1, 2, 5]);
assert.deepEqual(decodeVerses('all', 3), [0, 1, 2]);
const started = Date.now();
for (const bad of ['0t999999999', '5t2', '10', '-1', '1t2t3', 'x', '0t9007199254740993']) assert.throws(() => decodeVerses(bad, 10), /No such verses/, `${bad} is refused`);
assert(Date.now() - started < 100, 'an impossible range is refused before anything is made of it');

// ---- text boxes stay with their kalam ----
const kalam = (id: string, lines: number): Kalam => ({ id, name: id, blocks: [{ kind: 'text', id: `t-${id}`, text: Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n'), sizePt: 22 }] });
const base: Booklet = { ...createBooklet('2026-11-12', 'haram', {}), date: '2026-11-12' };
base.kalams = { ...base.kalams, noha: [kalam('n1', 4), kalam('n2', 30)] };
const before = paginate(base);
const n2page = before.pages.findIndex((p) => p.kind === 'content' && p.kalams.some((k) => k.id === 'n2'));
assert(n2page > 0, 'the layout lists the kalams on each page');
const top = (before.pages[n2page] as { kalams: { id: string; top: number }[] }).kalams.find((k) => k.id === 'n2')!.top;
const placed = anchorAt(before, n2page, top + 100);
assert.deepEqual(placed.anchor, { kalam: 'n2', part: 0 }, 'a box placed beside a kalam belongs to it');
assert.equal(placed.y, 100, 'and keeps its distance from where the kalam starts');
const withBox: Booklet = { ...base, textBoxes: [{ id: 'b', page: n2page, ...placed, x: 300, text: 'note', sizePt: 20, color: '#000' }] };
// A kalam added before it pushes it on by a page or more.
const longer: Booklet = { ...withBox, kalams: { ...withBox.kalams, quran: [kalam('q1', 40)] } };
const after = paginate(longer);
const now = placeBoxes(longer.textBoxes, after).byPage;
const moved = [...now].find(([, bs]) => bs.some((b) => b.box.id === 'b'))!;
const n2now = after.pages.findIndex((p) => p.kind === 'content' && p.kalams.some((k) => k.id === 'n2'));
assert(n2now > n2page, 'the kalam moved later in the booklet');
assert.equal(moved[0], n2now, 'the box moved with it');
// The kalam removed: the box is listed, not left over other content.
const removed: Booklet = { ...withBox, kalams: { ...withBox.kalams, noha: [kalam('n1', 4)] } };
const gone = placeBoxes(removed.textBoxes, paginate(removed));
assert.equal(gone.orphans.length, 1, 'a box whose kalam is gone is listed');
assert(![...gone.byPage.values()].flat().length, 'and shown on no page');
// A box from before anchors gets one from where it shows now.
const legacy: Booklet = { ...base, textBoxes: [{ id: 'old', page: n2page, x: 200, y: top + 50, text: 'old', sizePt: 20, color: '#000' }] };
assert.deepEqual(anchorBoxes(legacy).textBoxes![0].anchor, { kalam: 'n2', part: 0 }, 'old boxes are anchored on load');
assert.deepEqual(anchorAt(before, 0, 10).anchor, { page: 'cover' }, 'a box on the cover stays on the cover');

console.log('sync checks passed');
