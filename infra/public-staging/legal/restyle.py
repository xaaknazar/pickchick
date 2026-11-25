#!/usr/bin/env python3
"""Put a published legal page (terms, privacy, offer) into the shared public-site design.

The approved legal text is never touched: the script takes the inner HTML of <main> as it is,
only adds ids to section headings (for the contents list) and, where a page has no <h1>, turns
its first heading into the title. It then checks that the visible text and every link of <main>
are identical before and after, and refuses to write otherwise.

Usage: restyle.py --kind terms|privacy|offer --input live.html --output new.html

Requisites stay on the server: run this on the published files, never commit their output.
"""
import argparse
import html
from html.parser import HTMLParser
from pathlib import Path
import re

DOCS = [
    ('support', '/support/', 'Поддержка'),
    ('terms', '/legal/terms', 'Условия'),
    ('privacy', '/legal/privacy', 'Конфиденциальность'),
    ('offer', '/legal/offer', 'Оферта'),
]
CSS = Path(__file__).with_name('legal.css')


class Text(HTMLParser):
    """Visible text and link targets of a fragment."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.links, self.skip = [], [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ('style', 'script'):
            self.skip += 1
        if tag == 'a':
            self.links.append(dict(attrs).get('href'))

    def handle_endtag(self, tag):
        if tag in ('style', 'script'):
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def read(fragment):
    parser = Text()
    parser.feed(fragment)
    return ' '.join(''.join(parser.parts).split()), parser.links


def plain(fragment):
    return ' '.join(html.unescape(re.sub(r'<[^>]+>', '', fragment)).split())


def restyle(kind, source):
    found = re.search(r'<main[^>]*>(.*)</main>', source, re.S)
    assert found and source.count('<main') == 1, 'Expected exactly one <main>'
    inner = found.group(1)
    title = re.search(r'<title>(.*?)</title>', source, re.S)
    assert title, 'Page has no <title>'

    body = inner
    if '<h1' not in body:
        # Terms open with the title as their first <h2>; it becomes the page's <h1>.
        body = re.sub(r'<h2>(.*?)</h2>', r'<h1 class="doc-title">\1</h1>', body, count=1, flags=re.S)
    heading = re.search(r'<h1[^>]*>(.*?)</h1>', body, re.S)
    assert heading, 'Page has no title heading'

    toc, count = [], 0

    def anchor(match):
        nonlocal count
        attrs, text = match.group(1), match.group(2)
        if 'id=' in attrs:
            ident = re.search(r'id="([^"]+)"', attrs).group(1)
            toc.append((ident, plain(text)))
            return match.group(0)
        count += 1
        ident = f'section-{count}'
        toc.append((ident, plain(text)))
        return f'<h2{attrs} id="{ident}">{text}</h2>'

    body = re.sub(r'<h2([^>]*)>(.*?)</h2>', anchor, body, flags=re.S)

    before, after = read(inner), read(body)
    assert before == after, 'Legal text or links changed; refusing to write'

    e = html.escape
    nav = ''.join(
        f'<a href="{href}"' + (' aria-current="page"' if key == kind else '') + f'>{label}</a>'
        for key, href, label in DOCS
    )
    contents = ''.join(f'<li><a href="#{ident}">{e(text)}</a></li>' for ident, text in toc)
    # Wide screens keep the contents beside the text; phones get it folded above the text.
    toc_html = (
        f'<nav class="toc toc-side" aria-label="Содержание"><p>Содержание</p><ol>{contents}</ol></nav>'
        f'<details class="toc toc-fold"><summary>Содержание</summary><ol>{contents}</ol></details>'
        if toc else ''
    )
    css = CSS.read_text()
    page = f'''<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title.group(1)}</title><meta name="description" content="{e(plain(heading.group(1)))}">
<style>
{css}</style></head>
<body><a class="skip" href="#text">К тексту</a>
<header class="site-head"><a class="brand" href="/support/" aria-label="PickChick">Pick<span>Chick</span></a><nav class="docs" aria-label="Документы">{nav}</nav></header>
<div class="doc">{toc_html}<main id="text">{body}</main></div>
<footer class="site-foot"><p>© 2026 PickChick</p><a href="/support/">Поддержка</a></footer>
</body></html>
'''
    return page, before


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--kind', required=True, choices=[d[0] for d in DOCS if d[0] != 'support'])
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    page, (text, links) = restyle(args.kind, args.input.read_text())
    args.output.write_text(page)
    print(f'{args.kind}: {len(text)} characters of legal text and {len(links)} links kept as published')


if __name__ == '__main__':
    main()
