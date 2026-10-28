"""Prepares the default Dua page (Karbala) from its scan.

    pip install pillow numpy pypdf
    python tools/prepare_dua.py

Reads the phone scan in references/ and writes
public/fixed/dua-allahumma-anta-thiqati.png, which the server cleans like any
screenshot. The scan is cropped inside the lavender page edge and above the
slanted bottom rule; the double rule under the heading (the cleaner left its
soft edges) and the bottom rule's raised left end are whitened. Then the
paper's tint and grain are lifted to pure white: each pixel's darkness against the paper is reduced by a small
floor and stretched back, in proportion across its channels, so black stays
black, the red heading and stars keep their hue and no grey haze prints.
"""
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent.parent
SCAN = ROOT / "references" / "Dua Allahumma anta thiqati (scan).pdf"
OUT = ROOT / "public" / "fixed" / "dua-allahumma-anta-thiqati.png"
CROP = (135, 0, 2576, 2250)  # left, top, right, bottom in scan px
RULE = (510, 559)  # rows of the double rule under the heading, after the crop
RULE_TIP = (0, 2226, 140, 2250)  # left, top, right, bottom: the bottom rule's raised left end
FLOOR = 0.12  # darkness at or below this is paper


def main():
    page = PdfReader(SCAN).pages[0]
    scan = max(page.images, key=lambda i: len(i.data))  # the page, not the scanner's badge
    img = Image.open(BytesIO(scan.data)).convert("RGB").crop(CROP)
    c = np.asarray(img, float)
    paper = np.median(c.reshape(-1, 3), axis=0)
    dark = np.clip((paper - c) / paper, 0, 1)
    cover = dark.max(axis=-1, keepdims=True)
    lifted = np.clip((cover - FLOOR) / (1 - FLOOR), 0, 1)
    out = 255 * (1 - dark * np.where(cover > 0, lifted / np.maximum(cover, 1e-6), 0))
    out[RULE[0]:RULE[1]] = 255
    out[RULE_TIP[1]:RULE_TIP[3], RULE_TIP[0]:RULE_TIP[2]] = 255
    Image.fromarray(np.round(out).astype(np.uint8)).save(OUT, optimize=True)
    print(f"{OUT.relative_to(ROOT)}: {img.width}x{img.height}, paper {paper.round().astype(int).tolist()}")


if __name__ == "__main__":
    main()
