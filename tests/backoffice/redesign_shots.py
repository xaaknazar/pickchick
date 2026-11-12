"""Manual helper (not a test): photographs every back-office section from redesign-serve.mjs.
Usage: python redesign_shots.py <fixture.json> <out-dir> [width ...] [--only name,name]"""
import json
import sys
import os
from playwright.sync_api import sync_playwright, expect

args = sys.argv[1:]
only = None
if '--only' in args:
    i = args.index('--only')
    only = set(args[i + 1].split(','))
    args = args[:i] + args[i + 2:]
fixture = json.load(open(args[0]))
out = args[1]
widths = [int(w) for w in args[2:]] or [1440, 390]
os.makedirs(out, exist_ok=True)
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    for width in widths:
        page = browser.new_page(viewport={"width": width, "height": 900 if width > 800 else 844})
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(fixture['url'] + '#dash')
        if width == widths[0]:
            page.screenshot(path=f'{out}/login-{width}.png')
        page.get_by_test_id('credential-file').set_input_files({"name": "access.json", "mimeType": "application/json", "buffer": json.dumps(fixture['manager']).encode()})
        expect(page.locator('.navigation .nav-item').first).to_be_attached(timeout=15000)
        names = page.locator('.navigation .nav-item').evaluate_all('(xs) => xs.map(x => x.dataset.testid || x.getAttribute("data-testid"))')
        for testid in names:
            name = testid.removeprefix('nav-')
            if only and name not in only:
                continue
            if width < 801:
                page.get_by_test_id('navigation-toggle').click()
            page.get_by_test_id(testid).click()
            page.wait_for_timeout(1500)
            page.evaluate('window.scrollTo(0, 0)')
            page.screenshot(path=f'{out}/{name}-{width}.png', full_page=True)
            wide = page.evaluate('document.documentElement.scrollWidth > innerWidth')
            print(name, width, 'H-SCROLL' if wide else 'ok')
        page.close()
    browser.close()
print('errors', errors)
