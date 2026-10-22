"""Static, accessible help pages; no forms, scripts, analytics or private App Review inputs."""
import html
import json
from pathlib import Path
import re


def render(language, phone):
    if language not in ('ru', 'kk', 'en') or not re.fullmatch(r'\+7[0-9]{10}', phone):
        raise ValueError('Invalid public contact or language')
    c = json.loads(Path(__file__).with_name('content.json').read_text())[language]
    e = html.escape
    nav = ''.join(f'<a href="/support/{lang}.html" lang="{lang}" hreflang="{lang}"'+
                  (' aria-current="page"' if lang == language else '')+f'>{label}</a>'
                  for lang,label in [('kk','ҚАЗ'),('ru','РУС'),('en','ENG')])
    answers = ''.join(f'<details{(" open" if i == 0 else "")}><summary>{e(q)}</summary><p>{e(a)}</p></details>'
                      for i,(q,a) in enumerate(c['questions']))
    return f'''<!doctype html>
<html lang="{language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(c['title'])}</title><meta name="description" content="{e(c['intro'])}"><link rel="stylesheet" href="/support/style.css"></head>
<body><a class="skip" href="#answers">{e(c['skip'])}</a>
<header><a class="brand" href="/support/" aria-label="PickChick">Pick<span>Chick</span></a><nav aria-label="{e(c['language'])}">{nav}</nav></header>
<main><section aria-labelledby="title"><h1 id="title">{e(c['title'])}</h1><p class="intro">{e(c['intro'])}</p>
<div class="contact"><h2>{e(c['contact'])}</h2><a class="call" href="tel:{phone}">{e(c['call'])}</a><a class="phone" href="tel:{phone}">{phone}</a>
<p class="address">{e(c['address'])}</p><a class="map" href="https://2gis.kz/almaty/geo/70030076952394244">{e(c['map'])}</a></div></section>
<section id="answers" aria-labelledby="help"><h2 id="help">{e(c['help'])}</h2>{answers}<p class="prepare">{e(c['prepare'])}</p></section></main>
<footer><p>© 2026 PickChick</p><div><a href="/legal/privacy">{e(c['privacy'])}</a><a href="/legal/terms">{e(c['terms'])}</a></div></footer></body></html>'''
