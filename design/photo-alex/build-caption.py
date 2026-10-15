"""Regenerate outlined print lettering with fontTools; no runtime font dependency."""
from pathlib import Path
from html import escape
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

root = Path(__file__).resolve().parents[2]
font = TTFont(root / 'apps/kiosk/node_modules/@expo-google-fonts/golos-text/500Medium/GolosText_500Medium.ttf')
glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
scale = 20 / font['head'].unitsPerEm
lines = [
    ('kk', 'Қытырлақ сәт - тәтті естелік.', 23),
    ('kk', 'Ас болсын!', 47),
    ('ru', 'Хрустящий момент на память.', 83),
    ('ru', 'Приятного аппетита!', 107),
    ('en', 'A crispy moment to remember.', 143),
    ('en', 'Enjoy your meal!', 167),
]
parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="336" height="180" viewBox="0 0 336 180">',
         '<title>PickChick photo souvenir - Kazakh, Russian, English</title>',
         '<rect width="336" height="180" fill="white"/>']
for lang, text, baseline in lines:
    names = [cmap[ord(c)] for c in text]
    width = sum(glyphs[name].width for name in names) * scale
    assert width <= 328, (text, width)
    x = (336 - width) / 2
    pen = SVGPathPen(glyphs)
    for name in names:
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
        x += glyphs[name].width * scale
    parts.append(f'<g xml:lang="{lang}" aria-label="{escape(text)}"><path fill="black" d="{pen.getCommands()}"/></g>')
parts.append('</svg>')
(Path(__file__).parent / 'print-caption.svg').write_text('\n'.join(parts) + '\n', encoding='utf-8')
