"""Extract the owner's original vector packaging, without redrawing its logos.

Usage: python pick-box-assets.py /path/to/box.pdf
Requires pypdfium2 and Pillow. Coordinates are fractions of the supplied dieline.
The photo specifies 23 x 23 x 10 cm; the physics uses this width/height ratio.
"""
import hashlib
import json
import sys
from pathlib import Path

import pypdfium2 as pdfium

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'apps/mobile/assets/games/pick-box'
source = Path(sys.argv[1])
pdf = pdfium.PdfDocument(source)
regions = {
    'lid.png': (0, (340 / 1600, 340 / 1600, 1262 / 1600, 1262 / 1600)),
    'front.png': (1, (492 / 1600, 92 / 1600, 1108 / 1600, 489 / 1600)),
}
for name, (page, bounds) in regions.items():
    bitmap = pdf[page].render(scale=2).to_pil()
    w, h = bitmap.size
    crop = bitmap.crop(tuple(round(value * (w if i % 2 == 0 else h)) for i, value in enumerate(bounds)))
    crop.save(OUT / name, optimize=True)
(OUT / 'packaging-source.json').write_text(json.dumps({
    'source': 'Owner-supplied box.pdf, 12 November 2026',
    'sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
    'referenceDimensionsCm': [23, 23, 10],
    'regions': regions,
    'note': 'Original PDF artwork. 2D orthographic body uses photo dimensions; no generated logo in gameplay.',
}, indent=2) + '\n')
