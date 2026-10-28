"""Builds the kalam library from Zikre Husain AS 1446 (references/).

The PDF lists every kalam on its index pages (title + page link). Each
kalam starts under a pink title box (or at its index link) and ends with a
red ٭٭٭٭٭ ornament. This finds every kalam, its verse rows and stanzas, and
what must never print (page numbers, title boxes, navigation bars, verse
numbers, the ornament), so the server can render any kalam, or chosen
stanzas of a long one, straight from the PDF's vector lettering.

Output:
  server/library/analysis.json  every kalam found (intermediate)
  server/library/library.json   geometry the server renders from
  public/library/index.json     search index (transliterated titles, kinds)

Needs PyMuPDF, numpy and Pillow:  python3 tools/build_library.py
Transliterated titles come from tools/library_titles.txt (one per kalam, in
PDF order). `--finalize` rebuilds only the two app files from analysis.json.
"""
import json, os, re, sys, hashlib
from collections import Counter, defaultdict

import numpy as np
import pymupdf as fitz
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'references', 'Zikre Husain AS 1446.pdf')
OUT_SERVER = os.path.join(ROOT, 'server', 'library')
OUT_PUBLIC = os.path.join(ROOT, 'public', 'library')

# Index pages (1-based): the master menu, the two verse indexes of the long
# marasi, and every section's index.
INDEX_RANGES = [(1, 3), (62, 110), (1156, 1156), (1173, 1174), (1278, 1279), (1316, 1317),
                (1376, 1404), (2279, 2292), (2711, 2738), (3648, 3667), (4186, 4217)]
VERSE_INDEX = {2, 3}
# Groups of the master menu: first index page (1-based) → kind, label.
GROUPS = [
    (1, 'marathi', 'Marasi'),
    (62, 'naat', 'Rasulullah SAW – Naat'),
    (66, 'noha', 'Rasulullah SAW – Noha & Nasaih'),
    (67, 'manqabat', 'Amirul Mumineen AS – Manqabat'),
    (71, 'noha', 'Amirul Mumineen AS – Noha & Nasaih'),
    (73, 'noha', 'Maulatona Fatema AS'),
    (75, 'noha', 'Imam Hasan AS'),
    (76, 'dua', 'Iltija'),
    (79, 'kalam', 'Imam Husain AS na Mojizaat'),
    (96, 'nasihat', 'Nasiha'),
    (99, 'nasihat', "Nasaih fi Madh Maulana al-Mun'im"),
    (101, 'nasihat', 'Nasaih – Mutafarriq'),
    (103, 'marathi', 'Awliya Kiram'),
    (105, 'kalam', 'Mutafarriq Manzumat'),
    (106, 'kalam', 'Hifz al-Quran & Mutafarriq'),
    (108, 'qasida', 'Mutafarriq Qasaid'),
    (109, 'marathi', 'Marasi Sayyid al-Shuhada (Arabic)'),
    (1156, 'marathi', 'Chehlum Imam Husain AS'),
    (1173, 'marathi', 'Dars ni Majlis'),
    (1278, 'marathi', 'Mithi Shitabi'),
    (1316, 'kalam', 'Karbala ni Shaadi'),
    (1376, 'salam', 'Salam Noha'),
    (2279, 'noha', 'Ahle Bait e Imam Husain AS'),
    (2711, 'noha', 'Matami Noha'),
    (3648, 'madh', 'Madaih – Syedna Mufaddal Saifuddin TUS'),
    (4186, 'madh', 'Madaih – Syedna Mohammed Burhanuddin RA'),
]

PINK = (0.95, 0.86, 0.86)
SCALE = 2  # analysis raster, px per pt
PAGE_TOP = 36  # page number above this line


def rgb(c):
    return ((c >> 16) & 255, (c >> 8) & 255, c & 255)


def near(f, ref, tol=0.03):
    return f is not None and len(f) == 3 and all(abs(a - b) <= tol for a, b in zip(f, ref))


class Book:
    def __init__(self, path):
        self.doc = fitz.open(path)
        self.n = len(self.doc)
        self.index = {p - 1 for a, b in INDEX_RANGES for p in range(a, b + 1)}
        self._spans = {}

    def spans(self, i):
        if i not in self._spans:
            out = []
            for b in self.doc[i].get_text('dict')['blocks']:
                for l in b.get('lines', []):
                    for s in l['spans']:
                        if s['text'].strip():
                            out.append(s)
            self._spans[i] = out
        return self._spans[i]

    # ---- kalam starts ---------------------------------------------------
    def index_rows(self):
        rows = []
        for i in sorted(self.index):
            for l in self.doc[i].get_links():
                if l['kind'] != 1 or l['from'].width <= 100:
                    continue
                to = l.get('to')
                rows.append({'ip': i, 'rect': list(l['from']), 't': l['page'], 'y': to.y if to else 0})
        return rows

    def title_boxes(self, i):
        out = []
        for x in self.doc[i].get_drawings():
            r = x['rect']
            if near(x.get('fill'), PINK) and r.width > 120 and r.height > 20:
                out.append(r)
        return out

    def ornaments(self, i):
        # ٭٭٭٭٭, sometimes with the kalam's verse count in the middle (٭٭٭١٣٭٭٭).
        return [s['bbox'] for s in self.spans(i) if re.fullmatch(r'[٭*\s\d\u0660-\u0669\u06f0-\u06f9]+', s['text']) and s['text'].count('٭') + s['text'].count('*') >= 3]


def group_of(page_1based):
    g = GROUPS[0]
    for first, kind, label in GROUPS:
        if page_1based >= first:
            g = (first, kind, label)
    return g


def find_kalams(book):
    rows = book.index_rows()
    starts = defaultdict(list)  # page -> [(y, source)]
    row_of = {}
    for r in rows:
        t = r['t']
        if t in book.index or not (0 <= t < book.n):
            continue
        if r['ip'] + 1 in VERSE_INDEX:
            continue
        starts[t].append(r['y'])
        row_of.setdefault((t, round(r['y'] / 40)), r)
    # The two long marasi of the menu start at the first verse of their verse index.
    for vi in VERSE_INDEX:
        ts = [l['page'] for l in book.doc[vi - 1].get_links() if l['kind'] == 1 and l['page'] not in book.index]
        if ts:
            starts[min(ts)].append(0)
    for i in range(book.n):
        if i in book.index:
            continue
        for r in book.title_boxes(i):
            starts[i].append(r.y0)
    # Cluster starts on a page: one kalam per title box / link target.
    kalams = []
    for p in sorted(starts):
        ys = sorted(starts[p])
        boxes = sorted(book.title_boxes(p), key=lambda r: r.y0)
        clusters = []
        for y in ys:
            if clusters and y - clusters[-1][-1] < 60:
                clusters[-1].append(y)
            else:
                clusters.append([y])
        for c in clusters:
            y = min(c)
            # Snap to the title box that starts there, if any.
            box = next((b for b in boxes if abs(b.y0 - y) < 70 or (y < 60 and b.y0 < 160)), None)
            kalams.append({'p': p, 'y': box.y0 if box else (0 if y < 60 else y), 'box': list(box) if box else None})
    # Dedupe (a box and a link at the same place).
    kalams.sort(key=lambda k: (k['p'], k['y']))
    out = []
    for k in kalams:
        if out and out[-1]['p'] == k['p'] and abs(out[-1]['y'] - k['y']) < 60:
            if k['box'] and not out[-1]['box']:
                out[-1] = k
            continue
        out.append(k)
    # Index rows give each kalam its title cell and group.
    by_page = defaultdict(list)
    for r in rows:
        if r['ip'] + 1 not in VERSE_INDEX and r['ip'] != 0:
            by_page[r['t']].append(r)
    for k in out:
        cands = by_page.get(k['p'], [])
        best = None
        for r in cands:
            dy = abs(r['y'] - k['y']) if k['y'] > 60 else (0 if r['y'] < 100 else r['y'])
            if best is None or dy < best[0]:
                best = (dy, r)
        if best and best[0] < 80:
            k['row'] = best[1]
    # Group: the index the row came from; otherwise the kalam before it.
    prev = (1, 'marathi', 'Marasi')
    for k in out:
        if k.get('row'):
            prev = group_of(k['row']['ip'] + 1)
        k['group'] = prev
    return out


# ---- raster rows ----------------------------------------------------------

def render(book, i, whiteouts, zones, tints=()):
    page = book.doc[i]
    pix = page.get_pixmap(matrix=fitz.Matrix(SCALE, SCALE), alpha=False)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, 3).copy()
    untint(img, tints)
    for x0, y0, x1, y1 in whiteouts:
        img[max(0, int(y0 * SCALE)):int(np.ceil(y1 * SCALE)), max(0, int(x0 * SCALE)):int(np.ceil(x1 * SCALE))] = 255
    for y0, y1 in zones:
        img[max(0, int(y0 * SCALE)):int(np.ceil(y1 * SCALE)), :] = 255
    return img


def page_marks(book, i):
    """What never prints on page i: zones (full-width y ranges), whiteouts
    (rects) and, among them, the verse numbers (which also mark stanzas)."""
    page = book.doc[i]
    zones = [(0, PAGE_TOP)]
    whiteouts, numbers, tints = [], [], []
    for x in page.get_drawings():
        r, f = x['rect'], x.get('fill')
        if f is None:
            # Stroked lines and frames (badge rings, borders) are never lettering.
            if x.get('color') and x['type'] == 's':
                for it in x['items']:
                    if it[0] == 'l':
                        a, b = it[1], it[2]
                        if abs(a.x - b.x) < 3 or abs(a.y - b.y) < 3:
                            w = (x.get('width') or 1) / 2 + 1.5
                            whiteouts.append((min(a.x, b.x) - w, min(a.y, b.y) - w, max(a.x, b.x) + w, max(a.y, b.y) + w))
            continue
        dark = max(f) < 0.5
        if dark and min(r.width, r.height) <= 2.5 and max(r.width, r.height) >= 8:
            # Table borders and rules.
            whiteouts.append((r.x0 - 1, r.y0 - 1, r.x1 + 1, r.y1 + 1))
        elif min(f) > 0.6 and max(f) < 0.99 and not near(f, PINK) and r.width > 30 and r.height > 8:
            # A light highlight behind text: printed as plain paper.
            tints.append([round(r.x0, 1), round(r.y0, 1), round(r.x1, 1), round(r.y1, 1), [round(v * 255) for v in f]])
        elif r.width > 150 and 20 < r.height < 60 and (near(f, (1, 0, 0)) or near(f, (0, 0.5, 0))):
            zones.append((r.y0 - 3, r.y1 + 3))  # navigation bar
        elif near(f, PINK) and r.width > 120 and r.height > 20:
            zones.append((r.y0 - 3, r.y1 + 3))  # title box
        elif near(f, PINK) and r.width < 60 and r.height < 60:
            # A verse number in a pink badge.
            whiteouts.append((r.x0 - 1.5, r.y0 - 1.5, r.x1 + 1.5, r.y1 + 1.5))
            numbers.append(tuple(r))
    spans = book.spans(i)
    for s in spans:
        x0, y0, x1, y1 = s['bbox']
        t = s['text'].strip()
        col = s['color']
        if col == 0xffffff:
            continue
        if re.fullmatch(r'[٭*\s\d\u0660-\u0669\u06f0-\u06f9]+', s['text']) and s['text'].count('٭') + s['text'].count('*') >= 3:
            zones.append((y0 - 2, y1 + 2))
            continue
        shadow = col in (0xc0c0c0, 0x999999, 0xa6a6a6, 0x808080, 0xbfbfbf)
        digit = re.fullmatch(r'[\d\u0660-\u0669\u06f0-\u06f9.<=;:\u060c]+', t) is not None
        # A number in the margin, or standing alone between columns, is a verse
        # number; one inside a line of verse (a year, a count) is lettering.
        alone = 'Arabic Web' in s['font'] and digit and len(t) <= 4 and (x0 > 500 or x1 < 110 or not any(
            o is not s and o['text'].strip() and o['bbox'][1] < y1 - 2 and o['bbox'][3] > y0 + 2
            and max(o['bbox'][0] - x1, x0 - o['bbox'][2]) < 14 and not (o['bbox'][0] >= x0 - 1 and o['bbox'][2] <= x1 + 1)
            for o in spans))
        if alone:
            whiteouts.append((x0 - 1.5, y0 - 1, x1 + 1.5, y1 + 1))
            header = t in ('786', '444', '٧٨٦', '۷۸۶', '٤٤٤', '۴۴۴')  # above a kalam, not a verse number
            if not header and not any(abs(n[0] - x0) < 6 and abs(n[1] - y0) < 6 for n in numbers):
                numbers.append((x0, y0, x1, y1))
        elif shadow:
            whiteouts.append((x0 - 1.5, y0 - 1, x1 + 1.5, y1 + 1))
    # The coloured copy over each shadow, same place.
    sh = list(whiteouts)
    for s in spans:
        x0, y0, x1, y1 = s['bbox']
        if x1 - x0 < 40 and any(abs(x0 - (w[0] + 1.5)) < 4 and abs(y0 - (w[1] + 1)) < 4 for w in sh):
            whiteouts.append((x0 - 1.5, y0 - 1, x1 + 1.5, y1 + 1))
    whiteouts = sorted(set(tuple(round(v, 1) for v in w) for w in whiteouts))
    zones = sorted(set(tuple(round(v, 1) for v in z) for z in zones))
    return zones, whiteouts, numbers, tints


def untint(img, tints):
    """Ink over a highlight, re-composited over white (exact un-blending)."""
    for x0, y0, x1, y1, t in tints:
        ys, ye = max(0, int(y0 * SCALE)), int(np.ceil(y1 * SCALE))
        xs, xe = max(0, int(x0 * SCALE)), int(np.ceil(x1 * SCALE))
        sub = img[ys:ye, xs:xe].astype(float)
        tv = np.array(t, dtype=float).reshape(1, 1, 3)
        a = np.clip(((tv - sub) / np.maximum(tv, 1)).max(axis=2, keepdims=True), 0, 1)
        img[ys:ye, xs:xe] = np.clip(sub + (1 - a) * (255 - tv), 0, 255).astype(np.uint8)


def bands_of(img):
    """Ink rows like server/ink.ts findBands (marks attached to the nearest row)."""
    a = 255 - img.min(axis=2)
    on = (a > 55).sum(axis=1) >= 3
    raw = []
    start = -1
    for y, v in enumerate(list(on) + [False]):
        if v and start < 0:
            start = y
        if not v and start >= 0:
            raw.append([start, y])
            start = -1
    if not raw:
        return [], a
    tall = sorted(b - t for t, b in raw if b - t >= 4)
    typical = tall[int(len(tall) * 0.7)] if tall else 10
    main = [r for r in raw if r[1] - r[0] >= typical * 0.4]
    if not main:
        return raw, a
    for t, b in raw:
        if b - t >= typical * 0.4:
            continue
        nearest = min(main, key=lambda l: max(0, t - l[1], l[0] - b))
        nearest[0] = min(nearest[0], t)
        nearest[1] = max(nearest[1], b)
    merged = []
    for band in sorted(main):
        if merged and band[0] <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], band[1])
        else:
            merged.append(band)
    return merged, a


def band_info(img, a, t, b):
    sub = img[t:b]
    al = a[t:b]
    ink = al > 100
    n = int(ink.sum()) or 1
    spread = sub.max(axis=2).astype(int) - sub.min(axis=2).astype(int)
    colored = int(((spread > 60) & ink).sum())
    cols = np.where((al > 55).any(axis=0))[0]
    rows_mass = al.sum(axis=1).astype(float)
    centre = t + float((rows_mass * np.arange(b - t)).sum() / max(1.0, rows_mass.sum()))
    return {'t': t / SCALE, 'b': b / SCALE, 'c': centre / SCALE, 'col': colored / n,
            'x0': (cols[0] / SCALE) if len(cols) else 0, 'x1': (cols[-1] / SCALE) if len(cols) else 0}


def analyse_kalam(book, k, end_page, end_y):
    """Rows of the kalam from (k.p, k.y) to (end_page, end_y), page by page."""
    pages = []
    ended = False
    for i in range(k['p'], end_page + 1):
        if i in book.index:
            break
        zones, whiteouts, numbers, tints = page_marks(book, i)
        top = k['y'] if i == k['p'] else 0
        bottom = end_y if i == end_page else book.doc[i].rect.height
        orn = [o for o in book.ornaments(i) if o[1] >= top - 2 and o[3] <= bottom + 2]
        if orn:
            bottom = min(bottom, min(o[1] for o in orn) - 1)
            ended = True
        img = render(book, i, whiteouts, zones + [(0, top), (bottom, 1e9)], tints)
        zones = [z for z in zones if z[1] > PAGE_TOP]
        bands, a = bands_of(img)
        rows = [band_info(img, a, t, b) for t, b in bands]
        rows = [r for r in rows if r['b'] - r['t'] >= 3]
        numbers = [n for n in numbers if top <= (n[1] + n[3]) / 2 <= bottom]
        pages.append({'p': i, 'rows': rows, 'numbers': numbers, 'tints': tints, 'zones': [list(z) for z in zones], 'whiteouts': [list(map(lambda v: round(v, 1), w)) for w in whiteouts], 'top': top, 'bottom': bottom})
        if ended:
            break
    # Leading header rows (786, the kalam's title and its author, in red) are not
    # verses. Only a kalam without a title box that opens a page has them; red
    # rows under a title box, or opening a kalam mid-page, are its refrain.
    dropped = 0
    for pg in (pages if not k['box'] and k['y'] < 60 else []):
        while pg['rows'] and pg['rows'][0]['col'] > 0.8 and sum(len(p['rows']) for p in pages) > 1 and dropped < 8:
            pg['rows'].pop(0)
            dropped += 1
        if pg['rows']:
            break
    return pages, ended, dropped


def stanzas_of(pages):
    """Rows grouped into stanzas (the units a long kalam's verses are chosen by).

    Verse numbers decide where they exist: a number at the start of a row
    (right margin) opens a stanza there; a number beside a stanza (a label)
    owns the rows nearest to it. Otherwise the source's spacing decides: a
    break is a pitch or gap clearly wider than the kalam's line spacing."""
    seq = [(pi, r) for pi, pg in enumerate(pages) for r in pg['rows']]
    if not seq:
        return None
    heights = sorted(r['b'] - r['t'] for _, r in seq)
    hmed = heights[len(heights) // 2]
    pitches = sorted(seq[j + 1][1]['c'] - seq[j][1]['c'] for j in range(len(seq) - 1) if seq[j][0] == seq[j + 1][0])
    base = pitches[(len(pitches) - 1) // 4] if pitches else hmed * 1.4
    nums = [(pi, n) for pi, pg in enumerate(pages) for n in pg['numbers']]
    brk = [False] * len(seq)
    brk[0] = True
    for j in range(1, len(seq)):
        pi, r = seq[j]
        ppi, pr = seq[j - 1]
        brk[j] = pi != ppi or (r['c'] - pr['c'] > base * 1.3) or (r['t'] - pr['b'] > max(base * 0.62, hmed * 0.55))
    # Refrains: whole rows in red (or blue) that close each stanza.
    refrain = [r['col'] > 0.75 for _, r in seq]
    ends = [j for j in range(len(seq)) if refrain[j] and (j + 1 == len(seq) or not refrain[j + 1])]
    use_refrain = len(ends) >= 3 and len(seq) / max(1, len(ends)) >= 2.5 and not refrain[0]
    leading = []
    if nums:
        def overlaps(n, r):
            cy = (n[1] + n[3]) / 2
            return r['t'] - 2 <= cy <= r['b'] + 2
        leading = [(pi, n) for pi, n in nums if any(p2 == pi and overlaps(n, r) and n[0] >= r['x1'] - 25 for p2, r in seq)]
    if use_refrain and len(leading) < max(1, len(nums) * 0.6):
        brk = [False] * len(seq)
        brk[0] = True
        for j in ends:
            if j + 1 < len(seq):
                brk[j + 1] = True
        nums = nums or [None]
    elif nums:
        def overlaps(n, r):
            cy = (n[1] + n[3]) / 2
            return r['t'] - 2 <= cy <= r['b'] + 2
        leading = [(pi, n) for pi, n in nums if any(p2 == pi and overlaps(n, r) and n[0] >= r['x1'] - 25 for p2, r in seq)]
        if len(leading) >= max(1, len(nums) * 0.6):
            # Each numbered row opens a verse; a verse runs on across a page break.
            brk = [False] * len(seq)
            brk[0] = True
            for j, (pi, r) in enumerate(seq):
                if any(p2 == pi and overlaps(n, r) for p2, n in leading):
                    brk[j] = True
        else:
            # Labels: each sits beside its stanza. Between two labels the stanza
            # break is the widest gap; rows above a page's first label continue
            # the stanza before them when a stanza-sized gap separates them.
            brk = [False] * len(seq)
            brk[0] = True
            gap = lambda j: seq[j][1]['c'] - seq[j - 1][1]['c']
            half = lambda j: (seq[j][1]['b'] - seq[j][1]['t']) / 2
            for pi, pg in enumerate(pages):
                idx = [j for j, (p2, _) in enumerate(seq) if p2 == pi]
                labels = sorted((n[1] + n[3]) / 2 for n in pg['numbers'])
                if not idx or not labels:
                    continue
                for a, b in zip(labels, labels[1:]):
                    between = [j for j in idx[1:] if seq[j - 1][1]['c'] >= a - half(j - 1) and seq[j][1]['c'] <= b + half(j)]
                    if between:
                        brk[max(between, key=gap)] = True
                if idx[0] == 0:
                    continue
                above = [j for j in idx[1:] if seq[j][1]['c'] <= labels[0] + half(j)]
                cut = max(above, key=gap) if above else None
                if cut is not None and gap(cut) > base * 1.3:
                    brk[cut] = True
                else:
                    brk[idx[0]] = True
    groups = []
    for j, item in enumerate(seq):
        if brk[j]:
            groups.append([item])
        else:
            groups[-1].append(item)
    if nums:
        return groups, base, hmed, None
    # A stanza cut by a page break: join the pieces when together they make
    # the kalam's usual stanza length and neither piece does alone.
    inner = [len(g) for gi, g in enumerate(groups) if 0 < gi < len(groups) - 1 and g[0][0] == groups[gi - 1][-1][0] and g[-1][0] == groups[gi + 1][0][0]]
    mode = Counter(inner or [len(g) for g in groups]).most_common(1)[0][0]
    out = [groups[0]]
    for g in groups[1:]:
        last = out[-1]
        if g[0][0] != last[-1][0] and len(last) < mode and len(g) < mode and len(last) + len(g) <= mode:
            out[-1] = last + g
        else:
            out.append(g)
    # Evenly spaced verses with no stanza break inside any page: page breaks
    # are not stanza breaks either, so the kalam is one continuous run.
    if len(out) > 1 and all(out[j][0][0] != out[j - 1][-1][0] for j in range(1, len(out))):
        out = [[item for g in out for item in g]]
    return out, base, hmed, mode


def crops_for(pages, stanzas):
    """Each stanza as [[page, y0, y1], ...] (pt); cuts sit in the blank space between stanzas."""
    flat = []
    for g in stanzas:
        parts = []
        for pi in sorted(set(pi for pi, _ in g)):
            rs = [r for p, r in g if p == pi]
            parts.append([pi, min(r['t'] for r in rs), max(r['b'] for r in rs), round(rs[0]['c'], 1), round(rs[-1]['c'], 1)])
        flat.append(parts)
    # Expand each part into the gap around it, halfway to its neighbours on the page.
    for si, parts in enumerate(flat):
        for part in parts:
            pi, t, b = part[:3]
            pg = pages[pi]
            ys = [(p2[1], p2[2]) for sj, ps in enumerate(flat) if sj != si for p2 in ps if p2[0] == pi]
            above = [bb for tt, bb in ys if bb <= t]
            below = [tt for tt, bb in ys if tt >= b]
            lo = max(above) if above else pg['top']
            hi = min(below) if below else pg['bottom']
            pad_top = min(8, (t - lo) / 2)
            pad_bot = min(8, (hi - b) / 2)
            part[1] = round(t - max(1, pad_top), 1)
            part[2] = round(b + max(1, pad_bot), 1)
    # [page, y0, y1, centre of the first row, centre of the last row]
    return [[[pages[pi]['p'], y0, y1, c0, c1] for pi, y0, y1, c0, c1 in parts] for parts in flat]


_book = None


def analyse_one(args):
    """One kalam, from its start up to where the next one starts."""
    global _book
    n, k, nxt = args
    if _book is None:
        _book = Book(SRC)
    book = _book
    if nxt is None:
        end_page, end_y = book.n - 1, 1e9
    elif nxt['y'] > 60:
        end_page, end_y = nxt['p'], nxt['y']
    else:
        end_page, end_y = nxt['p'] - 1, 1e9
    pages, ended, dropped = analyse_kalam(book, k, end_page, end_y)
    st = stanzas_of(pages)
    if not st:
        return n, None, {}
    stanzas, base, hmed, mode = st
    crops = crops_for(pages, stanzas)
    used = {part[0] for s in crops for part in s}
    marks = {}
    for pg in pages:
        if pg['p'] in used:
            m = {'w': pg['whiteouts'], 'z': pg['zones'], 't': pg['tints']}
            marks[pg['p']] = {k2: v for k2, v in m.items() if v}
    return n, {
        'n': n,
        'p': k['p'], 'y': round(k['y'], 1), 'box': k['box'] and [round(v, 1) for v in k['box']],
        'row': k.get('row') and {'ip': k['row']['ip'], 'rect': [round(v, 1) for v in k['row']['rect']]},
        'kind': k['group'][1], 'group': k['group'][2],
        'stanzas': crops, 'rows': [len(g) for g in stanzas],
        'lh': round(hmed, 1), 'pitch': round(base, 1), 'ended': ended, 'dropped': dropped,
        'pages': sorted(used),
    }, marks


def main():
    from multiprocessing import Pool
    book = Book(SRC)
    kalams = find_kalams(book)
    only = [int(a) for a in sys.argv[1:]]
    print(f'{len(kalams)} kalam starts', file=sys.stderr)
    jobs = [(n, k, kalams[n + 1] if n + 1 < len(kalams) else None) for n, k in enumerate(kalams) if not only or n in only]
    results, whiteouts, pending_alias = [], {}, []
    with Pool(os.cpu_count() or 2) as pool:
        for i, (n, result, marks) in enumerate(pool.imap(analyse_one, jobs, chunksize=8)):
            if result is None:
                # An index entry that points just above its kalam (the end of the
                # page before, or a second name over the same title): an alias.
                pending_alias.append(n)
                continue
            results.append({**result, 'aliases': pending_alias})
            pending_alias = []
            whiteouts.update(marks)
            if i % 100 == 0:
                print(f'  {i}/{len(jobs)}', file=sys.stderr)
    os.makedirs(OUT_SERVER, exist_ok=True)
    tmp = os.path.join(OUT_SERVER, 'analysis.json')
    with open(tmp, 'w') as f:
        json.dump({'kalams': results, 'whiteouts': {str(k): v for k, v in whiteouts.items()}}, f)
    print('wrote', tmp, file=sys.stderr)


def finalize():
    """analysis.json + the transliterated titles → the files the app reads."""
    with open(os.path.join(OUT_SERVER, 'analysis.json')) as f:
        A = json.load(f)
    titles = {}
    with open(os.path.join(ROOT, 'tools', 'library_titles.txt')) as f:
        for line in f:
            if re.match(r'^\d+\|', line):
                n, t = line.rstrip('\n').split('|', 1)
                titles[int(n)] = t.strip()
    kalams, index = [], []
    for k in A['kalams']:
        if k.get('row'):
            tr = [k['row']['ip']] + k['row']['rect']
        elif k.get('box'):
            tr = [k['p']] + k['box']
        else:
            s0 = k['stanzas'][0][0]
            tr = [s0[0], 30, s0[1], 582, min(s0[2], s0[1] + k['pitch'] * 1.2)]
        kalams.append({'st': k['stanzas'], 'lh': k['lh'], 'pitch': k['pitch'], 'tr': [round(v, 1) for v in tr]})
        title = titles.get(k['n'], '')
        aliases = [titles[a] for a in k['aliases'] if titles.get(a, '-') not in ('-', '', title)]
        index.append({'t': title, **({'a': aliases} if aliases else {}), 'k': k['kind'], 'g': k['group'],
                      'v': len(k['stanzas']), 'r': sum(k['rows'])})
    used = {part[0] for k in kalams for s in k['st'] for part in s} | {k['tr'][0] for k in kalams}
    marks = {p: m for p, m in A['whiteouts'].items() if int(p) in used}
    with open(SRC, 'rb') as f:
        digest = hashlib.sha256(f.read()).hexdigest()[:16]
    lib = {'v': 1, 'source': 'references/Zikre Husain AS 1446.pdf', 'sha': digest, 'kalams': kalams, 'marks': marks}
    os.makedirs(OUT_PUBLIC, exist_ok=True)
    with open(os.path.join(OUT_SERVER, 'library.json'), 'w') as f:
        json.dump(lib, f, separators=(',', ':'), ensure_ascii=False)
    with open(os.path.join(OUT_PUBLIC, 'index.json'), 'w') as f:
        json.dump({'v': 1, 'sha': digest, 'kalams': index}, f, separators=(',', ':'), ensure_ascii=False)
    print(len(kalams), 'kalams;', sum(1 for i in index if not i['t']), 'without a title', file=sys.stderr)


if __name__ == '__main__':
    if sys.argv[1:] == ['--finalize']:
        finalize()
    else:
        main()
        if len(sys.argv) == 1:
            finalize()
