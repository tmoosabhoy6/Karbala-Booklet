"""Shrink what the phone downloads, without changing a single pixel or glyph.

- JPEG and PNG files in public/ are recompressed losslessly (mozjpeg's
  lossless optimiser, oxipng). Each result is decoded and compared with the
  original: a file is replaced only if every pixel is identical.
- The page backgrounds (2480x3508, print size) get preview-sized copies
  (*.preview.jpg) for the on-screen preview; the PDF always uses the full ones.
- The font gets a WOFF2 copy: the same font, compressed.

Run after tools/build_assets.py or tools/build-logos.mjs:
    pip install pillow fonttools brotli pyoxipng mozjpeg-lossless-optimization
    python tools/optimize_assets.py
"""
from io import BytesIO
from pathlib import Path

import mozjpeg_lossless_optimization
import oxipng
from fontTools.ttLib import TTFont
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
BACKGROUNDS = ["cover-bg", "back-bg", "page-border"]
PREVIEW_WIDTH = 1240  # half of print size: 150 dpi across an A4 page


def pixels(data: bytes):
    """Every pixel as 8-bit RGBA (or the raw 16-bit samples), plus the colour profile."""
    img = Image.open(BytesIO(data))
    img.load()
    deep = img.mode.startswith("I")
    return img.size, img.tobytes() if deep else img.convert("RGBA").tobytes(), img.info.get("icc_profile")


def lossless(path: Path) -> None:
    data = path.read_bytes()
    if path.suffix == ".jpg":
        smaller = mozjpeg_lossless_optimization.optimize(data)
    else:
        # "safe" keeps every chunk that affects how the image looks.
        smaller = oxipng.optimize_from_memory(data, level=6, strip=oxipng.StripChunks.safe())
    if len(smaller) >= len(data):
        return
    if pixels(smaller) != pixels(data):
        print(f"{path.relative_to(ROOT)}: recompression would change pixels; left as is")
        return
    path.write_bytes(smaller)
    print(f"{path.relative_to(ROOT)}: {len(data):,} -> {len(smaller):,} bytes")


def preview(name: str) -> None:
    full = Image.open(PUBLIC / "assets" / f"{name}.jpg")
    height = round(full.height * PREVIEW_WIDTH / full.width)
    out = BytesIO()
    full.convert("RGB").resize((PREVIEW_WIDTH, height), Image.LANCZOS).save(out, "JPEG", quality=86, subsampling=0, optimize=True)
    target = PUBLIC / "assets" / f"{name}.preview.jpg"
    target.write_bytes(mozjpeg_lossless_optimization.optimize(out.getvalue()))
    print(f"{target.relative_to(ROOT)}: {PREVIEW_WIDTH}x{height}, {target.stat().st_size:,} bytes")


def woff2() -> None:
    source = PUBLIC / "fonts" / "Kanz-al-Marjaan-Regular.ttf"
    font = TTFont(source)
    font.flavor = "woff2"
    target = source.with_suffix(".woff2")
    font.save(target)
    print(f"{target.relative_to(ROOT)}: {source.stat().st_size:,} -> {target.stat().st_size:,} bytes")


if __name__ == "__main__":
    for path in sorted(PUBLIC.rglob("*")):
        if path.suffix in (".jpg", ".png") and not path.stem.endswith(".preview"):
            lossless(path)
    for name in BACKGROUNDS:
        preview(name)
    woff2()
