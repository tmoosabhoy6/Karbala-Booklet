"""Rebuild the checked-in visual reference bank from the six supplied PDFs.
Requires PyMuPDF. Rendering preserves the PDFs' actual letter shapes and colours.
"""
import hashlib
import json
from pathlib import Path
import pymupdf as fitz

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'server' / 'lettering-bank'
# One-based PDF pages, PDF-point crops: exclude headings, decorations and numbers.
SAMPLES = [
 ('urdu-nastaliq-1', 'HA_5mi Raat Majlis 1448h.pdf', 10, [55, 110, 545, 250], 'Urdu Nastaliq'),
 ('urdu-nastaliq-2', 'Ai_Chehlum 1448H.pdf', 10, [72, 150, 524, 430], 'Urdu Nastaliq'),
 ('arabic-naskh-1', 'Ai_Shahadat Imam Hasan AS.pdf', 6, [72, 110, 524, 400], 'Arabic Naskh, Kanz'),
 ('arabic-naskh-2', 'Ai_Milad un Nabi SAW 1448h.pdf', 6, [72, 90, 524, 450], 'Arabic Naskh with diacritics'),
 ('dawat-1', 'Ai_Milad Imam al-Zaman AS.pdf', 10, [72, 105, 524, 390], 'Lisan al-Dawat, Kanz'),
 ('dawat-2', 'Ai_15mi Raat Urs SMB RA 1448h.pdf', 37, [72, 160, 524, 425], 'Lisan al-Dawat, Kanz'),
]

def main():
 OUT.mkdir(parents=True, exist_ok=True)
 inventory = []
 for src in sorted((ROOT / 'references').glob('*.pdf')):
  doc = fitz.open(src)
  fonts = sorted({font[3] for page in doc for font in page.get_fonts()})
  inventory.append(dict(file=src.name, sha256=hashlib.sha256(src.read_bytes()).hexdigest(), pages=len(doc), fonts=fonts))
 samples = []
 for name, filename, number, box, script in SAMPLES:
  doc = fitz.open(ROOT / 'references' / filename)
  box = [55, box[1], 545, box[3]]
  pix = doc[number-1].get_pixmap(matrix=fitz.Matrix(3,3), clip=fitz.Rect(box), alpha=False)
  # Tight initial crops may intersect a neighbouring row. Move the vertical
  # edges inward to genuine 8pt whitespace, so examples contain whole lines.
  from PIL import Image
  im = Image.frombytes('RGB', [pix.width, pix.height], pix.samples)
  rows = [sum(min(im.getpixel((x,y))) < 200 for x in range(im.width)) for y in range(im.height)]
  def trim_edge(values):
   if not any(v > 2 for v in values[:24]): return 0
   blank = 0
   for y,v in enumerate(values):
    blank = blank+1 if v <= 2 else 0
    if blank >= 24: return y-11
   return 0
  top, bottom = trim_edge(rows), trim_edge(rows[::-1])
  box[1] += top/3; box[3] -= bottom/3
  pix = doc[number-1].get_pixmap(matrix=fitz.Matrix(3,3), clip=fitz.Rect(box), alpha=False)
  pix.save(OUT / (name + '.png'))
  samples.append(dict(id=name, file=name+'.png', source=filename, page=number, crop=box, dpi=216, script=script))
 manifest = dict(version=1, kind='visual-reference-context', training=False,
   instructions='Use samples only for script-specific lettering clarity. Source screenshot alone supplies wording, colour, dots, diacritics and layout. Never copy reference wording or mix Urdu Nastaliq with Arabic Naskh.',
   documents=inventory, samples=samples)
 (OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')
 print(f"Reference bank: {len(inventory)} PDFs, {sum(d['pages'] for d in inventory)} pages, {len(samples)} script samples")

if __name__ == '__main__': main()
