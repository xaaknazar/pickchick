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
captions = {
    'kk': ['Қытырлақ сәт - тәтті естелік.', 'Ас болсын!'],
    'ru': ['Хрустящий момент на память.', 'Приятного аппетита!'],
    'en': ['A crispy moment to remember.', 'Enjoy your meal!'],
}
for lang, lines in captions.items():
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="336" height="60" viewBox="0 0 336 60">',
             f'<title>PickChick photo souvenir - {lang}</title>',
             '<rect width="336" height="60" fill="white"/>']
    for text, baseline in zip(lines, [23, 47]):
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
    (Path(__file__).parent / f'print-caption-{lang}.svg').write_text('\n'.join(parts) + '\n', encoding='utf-8')
