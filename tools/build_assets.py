"""Builds the booklet's static artwork from the master reference PDF.

Run once (outputs are committed):
    python3 -m venv .venv && .venv/bin/pip install pymupdf pillow numpy
    .venv/bin/python tools/build_assets.py

Everything here is derived from references/HA_5mi Raat Majlis 1448h.pdf:
the purple accents (and the cover bar) become a lively blood-red maroon
(#8C1A24); gold and the grid background are left untouched.
"""
from pathlib import Path

import fitz
import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
REF = ROOT / "references" / "HA_5mi Raat Majlis 1448h.pdf"
OUT = ROOT / "public" / "assets"

A4_PX = (2480, 3508)  # 300 dpi
MAROON_HUE = 355 / 360  # base colour rgb(140,26,36) = #8C1A24

# Image xrefs inside the reference PDF.
XREF_COVER = 1100
XREF_BORDER = 338
XREF_ORNAMENT, XREF_ORNAMENT_MASK = 345, 341
XREF_BULLET = 10


def rgb_to_hsv(a):
    a = a / 255.0
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a.max(-1), a.min(-1)
    d = mx - mn
    h = np.zeros_like(mx)
    m = d > 1e-6
    rm = m & (mx == r)
    gm = m & (mx == g) & ~rm
    bm = m & ~rm & ~gm
    h[rm] = ((g - b)[rm] / d[rm]) % 6
    h[gm] = (b - r)[gm] / d[gm] + 2
    h[bm] = (r - g)[bm] / d[bm] + 4
    h /= 6
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    return np.stack([h, s, mx], -1)


def hsv_to_rgb(a):
    h, s, v = a[..., 0], a[..., 1], a[..., 2]
    i = np.floor(h * 6).astype(int) % 6
    f = h * 6 - np.floor(h * 6)
    p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
    choices = [
        np.stack([v, t, p], -1), np.stack([q, v, p], -1), np.stack([p, v, t], -1),
        np.stack([p, q, v], -1), np.stack([t, p, v], -1), np.stack([v, p, q], -1),
    ]
    out = np.zeros(h.shape + (3,))
    for k in range(6):
        out[i == k] = choices[k][i == k]
    return np.clip(out * 255, 0, 255)


def purple_to_maroon(rgb, region=None, min_sat=0.08, s_mul=1.29, v_mul=1.69, v_cap=0.6, hues=(260, 345)):
    """Re-hue pixels in the `hues` range (purple by default) to the base maroon;
    gold/cream/white are untouched. Defaults map the cover's purple rgb(83,31,77)
    onto the base rgb(140,26,36)."""
    hsv = rgb_to_hsv(rgb.astype(float))
    h, s = hsv[..., 0] * 360, hsv[..., 1]
    lo, hi = hues
    in_range = ((h >= lo) & (h <= hi)) if lo <= hi else ((h >= lo) | (h <= hi))
    mask = in_range & (s >= min_sat)
    if region is not None:
        mask &= region
    # Purple sits darker than the target red; lift V so the strip lands on the
    # base colour instead of a muddy brown.
    new = hsv.copy()
    new[..., 0] = np.where(mask, MAROON_HUE, hsv[..., 0])
    new[..., 1] = np.where(mask, np.clip(s * s_mul, 0, 1), s)
    dark = hsv[..., 2] < v_cap
    lifted = np.where(dark, np.minimum(hsv[..., 2] * v_mul, v_cap), hsv[..., 2])
    new[..., 2] = np.where(mask, lifted, hsv[..., 2])
    out = rgb.astype(float).copy()
    out[mask] = hsv_to_rgb(new)[mask]
    return out


def box(shape, x0, y0, x1, y1):
    m = np.zeros(shape[:2], bool)
    m[y0:y1, x0:x1] = True
    return m


def build_cover(doc):
    raw = doc.extract_image(XREF_COVER)
    src = np.array(Image.open(__import__("io").BytesIO(raw["image"])).convert("RGB")).astype(float)
    H, W = src.shape[:2]  # 1402 x 991

    clean = src.copy()
    # 1) Remove old logos: borrow the clean grid directly below (same columns keep
    #    the vertical plaid lines continuous).
    clean[30:200, 245:600] = src[230:400, 245:600]
    # 2) Remove "الحضرة العالية" from the bar: the bar is uniform horizontally.
    bar = slice(1066, 1154)
    patch = src[bar, 12:242]
    x = 242
    while x < 640:
        w = min(patch.shape[1], 640 - x)
        clean[bar, x:x + w] = patch[:, :w]
        x += w

    # 3) Purple -> maroon: right strip, side ornaments, the rules around the bar
    #    and the little ornament beneath it. The grid itself is left alone.
    region = (
        box(src.shape, 848, 0, W, H)
        | box(src.shape, 10, 350, 105, 870)
        | box(src.shape, 750, 350, 840, 870)
        | box(src.shape, 0, 1052, 848, 1066)
        | box(src.shape, 0, 1152, 848, 1210)
    )
    cover = purple_to_maroon(clean, region, min_sat=0.04)
    # The bar itself was a greyish maroon rgb(127,52,59); bring it to the base.
    bar_region = box(src.shape, 0, 1066, 848, 1154)
    cover = purple_to_maroon(cover, bar_region, min_sat=0.2, s_mul=1.37, v_mul=1.1, v_cap=0.7, hues=(330, 20))

    img = Image.fromarray(cover.astype(np.uint8)).resize(A4_PX, Image.LANCZOS)
    img = img.filter(ImageFilter.UnsharpMask(radius=2, percent=60, threshold=2))
    img.save(OUT / "cover-bg.jpg", quality=92, subsampling=0)

    # Back page: grid only. Mirror the clean left half across the strip area,
    # and paint over the side ornaments with grid from neighbouring columns.
    back = src.copy()
    back[0:1052, 0:110] = src[0:1052, 115:225]
    back[0:1052, 740:848] = src[0:1052, 620:728]
    back[0:220, 230:620] = src[400:620, 230:620]
    back[1052:1215, 0:848] = back[860:1023, 0:848]  # bar band -> plain grid
    back[:, 848:W] = back[:, 848 - (W - 848):848][:, ::-1]
    img = Image.fromarray(back.astype(np.uint8)).resize(A4_PX, Image.LANCZOS)
    img = img.filter(ImageFilter.UnsharpMask(radius=2, percent=60, threshold=2))
    img.save(OUT / "back-bg.jpg", quality=92, subsampling=0)


def build_border(doc):
    raw = doc.extract_image(XREF_BORDER)
    src = np.array(Image.open(__import__("io").BytesIO(raw["image"])).convert("RGB")).astype(float)
    # A light, lively red-maroon: the base hue at roughly twice the lavender's
    # saturation, a shade deeper.
    out = purple_to_maroon(src, None, min_sat=0.03, s_mul=2.0, v_mul=0.93, v_cap=1.0)
    Image.fromarray(out.astype(np.uint8)).save(OUT / "page-border.jpg", quality=92, subsampling=0)


def build_ornaments(doc):
    import io
    base = Image.open(io.BytesIO(doc.extract_image(XREF_ORNAMENT)["image"])).convert("RGB")
    mask = Image.open(io.BytesIO(doc.extract_image(XREF_ORNAMENT_MASK)["image"])).convert("L")
    base.putalpha(mask.resize(base.size))
    base.save(OUT / "end-ornament.png")
    bullet = doc.extract_image(XREF_BULLET)
    smask = doc.xref_get_key(XREF_BULLET, "SMask")[1].split()[0]
    b = Image.open(io.BytesIO(bullet["image"])).convert("RGB")
    b.putalpha(Image.open(io.BytesIO(doc.extract_image(int(smask))["image"])).convert("L"))
    b.save(OUT / "fihrist-bullet.png")


def build_sanat_vector(doc):
    """Lift the blue 'سنة الشكر والبركات البديعة / سنة ١٤٤٨هـ' vectors verbatim."""
    page = doc[0]
    paths = [d for d in page.get_drawings() if d.get("fill")]
    rect = fitz.Rect()
    for d in paths:
        rect |= d["rect"]
    pad = 2
    x0, y0 = rect.x0 - pad, rect.y0 - pad
    parts = []
    def pt(p):
        return f"{p.x - x0:.2f},{p.y - y0:.2f}"

    for d in paths:
        seg, cur = [], None
        for it in d["items"]:
            op = it[0]
            if op in ("l", "c"):
                start = it[1]
                # Only open a new subpath when the pen actually jumps.
                if cur is None or abs(start.x - cur.x) > 0.01 or abs(start.y - cur.y) > 0.01:
                    if cur is not None:
                        seg.append("Z")
                    seg.append("M" + pt(start))
                if op == "l":
                    seg.append("L" + pt(it[2]))
                    cur = it[2]
                else:
                    seg.append(f"C{pt(it[2])} {pt(it[3])} {pt(it[4])}")
                    cur = it[4]
            elif op == "re":
                r = it[1]
                seg.append(f"M{r.x0 - x0:.2f},{r.y0 - y0:.2f}h{r.width:.2f}v{r.height:.2f}h{-r.width:.2f}Z")
                cur = None
            elif op == "qu":
                q = it[1]
                seg.append("M" + "L".join(pt(p) for p in (q.ul, q.ur, q.lr, q.ll)) + "Z")
                cur = None
        if cur is not None:
            seg.append("Z")
        rule = "evenodd" if d.get("even_odd") else "nonzero"
        parts.append(f'<path fill-rule="{rule}" d="{"".join(seg)}"/>')
    w, h = rect.width + 2 * pad, rect.height + 2 * pad
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.2f} {h:.2f}" '
        f'width="{w:.2f}pt" height="{h:.2f}pt"><g fill="#424E75" fill-rule="nonzero">'
        + "".join(parts) + "</g></svg>"
    )
    (OUT / "sanat-1448.svg").write_text(svg)
    print("sanat bbox (pt):", [round(v, 2) for v in rect])


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(REF)
    build_cover(doc)
    build_border(doc)
    build_ornaments(doc)
    build_sanat_vector(doc)
    print("assets written to", OUT)
