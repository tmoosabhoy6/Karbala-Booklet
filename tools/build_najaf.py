"""Builds the Najaf artwork: the Karbala artwork with its maroon turned green.

Run after tools/build_assets.py / tools/build-logos.mjs (outputs are committed):
    pip install pillow numpy
    python tools/build_najaf.py
then tools/optimize_assets.py for the preview copies.

Reads the finished maroon files, so every Najaf page lines up with its
Karbala twin pixel for pixel, and writes *-najaf files beside them. The green
is the Najaf logo's own colour (public/assets/logo-najaf.png) once that logo
is in; until then a dark green placeholder. Only maroon pixels move, in Lab:
the hue turns, chroma and lightness scale so the base maroon lands exactly on
the green and every lighter or deeper shade keeps its place. The plaid, the
gold and cream, the navy and the blue footer lettering are left alone; the
back page is shared and not rebuilt.
"""
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "public" / "assets"

MAROON = (140, 26, 36)  # the base colour, --maroon in booklet.css
PLACEHOLDER_GREEN = (26, 92, 58)
# Pale CSS shades that follow the green (see booklet.css :root).
CSS = {
    "--maroon": (140, 26, 36),
    "--maroon-deep": (122, 21, 32),
    "--maroon-tint": (246, 218, 221),
    "--rose-tint": (251, 236, 237),
    "--rule": (140, 26, 36),
    "--divider": (216, 147, 154),
}

WHITE = np.array([0.95047, 1.0, 1.08883])
M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])


def to_lab(rgb):
    c = np.asarray(rgb, float) / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = c @ M.T / WHITE
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def to_rgb(lab):
    fy = (lab[..., 0] + 16) / 116
    f = np.stack([fy + lab[..., 1] / 500, fy, fy - lab[..., 2] / 200], -1)
    xyz = np.where(f > 6 / 29, f ** 3, 3 * (6 / 29) ** 2 * (f - 4 / 29)) * WHITE
    c = xyz @ np.linalg.inv(M).T
    c = np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.clip(c, 0, None) ** (1 / 2.4) - 0.055)
    return np.clip(c * 255, 0, 255)


def lch(lab):
    return lab[..., 0], np.hypot(lab[..., 1], lab[..., 2]), np.degrees(np.arctan2(lab[..., 2], lab[..., 1]))


def recolour(rgb, green, region=None, chroma_from=0.0, chroma_full=6.0, darker_than=None):
    """Maroon -> green. Pixels fade in by chroma (from `chroma_from` to
    `chroma_full`), so near-neutral paper and plaid stay as they are, and by
    hue (full within 22° of the maroon, none beyond 35°), so gold stays gold.
    With `darker_than`, only pixels darker than that lightness move (fading
    over the 15 above it), which tells greyish ink from the pale plaid."""
    L0, C0, h0 = (float(v) for v in lch(to_lab(MAROON)))
    L1, C1, h1 = (float(v) for v in lch(to_lab(green)))
    lab = to_lab(rgb)
    L, C, h = lch(lab)
    off = np.abs((h - h0 + 180) % 360 - 180)
    w = np.clip((35 - off) / 13, 0, 1) * np.clip((C - chroma_from) / max(chroma_full - chroma_from, 1e-6), 0, 1)
    if darker_than is not None:
        w = w * np.clip((darker_than + 15 - L) / 15, 0, 1)
    if region is not None:
        w = w * region
    # Lightness moves with the share of maroon in the pixel, so antialiased
    # edges against white stay light.
    L2 = L + (L1 - L0) * np.clip(C / C0, 0, 1)
    C2 = C * C1 / C0
    hr = np.radians(h + h1 - h0)
    mapped = to_rgb(np.stack([L2, C2 * np.cos(hr), C2 * np.sin(hr)], -1))
    return rgb + (mapped - rgb) * w[..., None]


def logo_green():
    logo = ASSETS / "logo-najaf.png"
    if not logo.exists():
        print("logo-najaf.png not found: using the placeholder green")
        return PLACEHOLDER_GREEN
    a = np.array(Image.open(logo).convert("RGBA")).reshape(-1, 4).astype(float)
    solid = a[a[:, 3] >= 250, :3]
    lab = to_lab(solid)
    _, C, h = lch(lab)
    greens = solid[(np.abs(h - 150) < 50) & (C > 15)]
    if not len(greens):
        print("no green found in logo-najaf.png: using the placeholder green")
        return PLACEHOLDER_GREEN
    return tuple(int(v) for v in np.median(greens, axis=0))


def save_jpg(arr, name):
    Image.fromarray(np.round(arr).astype(np.uint8)).save(ASSETS / name, quality=92, subsampling=0)
    print("wrote", name)


def build_cover(green):
    src = np.array(Image.open(ASSETS / "cover-bg.jpg").convert("RGB")).astype(float)
    H, W = src.shape[:2]
    # The maroon areas of tools/build_assets.py, given there in the 991×1402
    # source: the right strip, the side ornaments, the bar and its rules.
    sx, sy = W / 991, H / 1402
    def area(*boxes):
        region = np.zeros((H, W))
        for x0, y0, x1, y1 in boxes:
            region[int(y0 * sy):int(np.ceil(y1 * sy)), int(x0 * sx):int(np.ceil(x1 * sx))] = 1
        return region

    # The plaid's own threads stay below chroma 9; the maroon accents sit above 15.
    accents = area((848, 0, 991, 1402), (10, 350, 105, 870), (750, 350, 840, 870), (0, 1052, 848, 1210))
    out = recolour(src, green, accents, chroma_from=9, chroma_full=16)
    # The rule and little ornament under the bar are a greyish maroon, as weak in colour
    # as the plaid but much darker (lightness under 60 against the plaid's 80+).
    ornament = area((0, 1152, 848, 1212))
    out = recolour(out, green, ornament, chroma_from=2, chroma_full=6, darker_than=62)
    save_jpg(out, "cover-bg-najaf.jpg")


def build_border(green):
    src = np.array(Image.open(ASSETS / "page-border.jpg").convert("RGB")).astype(float)
    save_jpg(recolour(src, green), "page-border-najaf.jpg")


def build_ornament(green):
    """The navy end ornament keeps its navy; its red drop turns green."""
    a = np.array(Image.open(ASSETS / "end-ornament.png").convert("RGBA")).astype(float)
    a[..., :3] = recolour(a[..., :3], green)
    Image.fromarray(np.round(a).astype(np.uint8)).save(ASSETS / "end-ornament-najaf.png", optimize=True)
    print("wrote end-ornament-najaf.png")


def build_faiz(green):
    """The Faiz-e-Husaini logo is one ink colour with alpha: print it in the green."""
    img = Image.open(ASSETS / "logo-faiz-husaini.png").convert("RGBA")
    a = np.array(img)
    a[..., :3] = green
    Image.fromarray(a).save(ASSETS / "logo-faiz-husaini-najaf.png", optimize=True)
    print("wrote logo-faiz-husaini-najaf.png")


if __name__ == "__main__":
    green = logo_green()
    print("green:", "#%02x%02x%02x" % green)
    build_cover(green)
    build_border(green)
    build_ornament(green)
    build_faiz(green)
    print("booklet.css .najaf colours:")
    for name, colour in CSS.items():
        out = recolour(np.array([[colour]], float), green)[0, 0]
        print(f"  {name}: #{''.join('%02x' % round(v) for v in out)};")
