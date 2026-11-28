"""Outline the slip fonts into tools/photo-printer/glyphs.json (no runtime font dependency).

Usage: python3 design/photo-slip/build-glyphs.py <Montserrat_800ExtraBold.ttf> <GolosText_600SemiBold.ttf>
Both fonts are SIL OFL 1.1 (@expo-google-fonts/montserrat, @expo-google-fonts/golos-text 0.4.2).
"""
import json, sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

root = Path(__file__).resolve().parents[2]
chars = (''.join(chr(c) for c in range(0x20, 0x7f))
         + ''.join(chr(c) for c in range(0x410, 0x450)) + 'Ёё'
         + 'ӘәҒғҚқҢңӨөҰұҮүҺһІі' + '·—–«»№•…’')
out = {}
for face, path in zip(['title', 'text'], sys.argv[1:3]):
    font = TTFont(path)
    glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
    em = font['head'].unitsPerEm
    table = {}
    for ch in chars:
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs, ntos=lambda v: ('%.1f' % v).rstrip('0').rstrip('.'))
        # Unit em = 1000, y down, baseline at 0.
        glyphs[name].draw(TransformPen(pen, (1000 / em, 0, 0, -1000 / em, 0, 0)))
        table[ch] = [round(glyphs[name].width * 1000 / em, 1), pen.getCommands()]
    out[face] = table
(root / 'tools/photo-printer/glyphs.json').write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
