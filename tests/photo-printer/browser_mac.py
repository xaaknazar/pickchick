"""Real camera UI and print service, synthetic camera and an inert USB transport."""
import json
import subprocess
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

server = subprocess.Popen(['node', 'tests/photo-printer/mac-browser-fixture.mjs'], stdout=subprocess.PIPE, text=True)
try:
    config = json.loads(server.stdout.readline())
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'])
        page = browser.new_page(viewport={'width': 1440, 'height': 900}, permissions=['camera'])
        external = []
        page.on('request', lambda r: external.append(r.url) if r.url.startswith('http') and not r.url.startswith(config['origin'] + '/') else None)
        page.goto(config['origin'] + '/#photo-key=' + config['token'])
        expect(page.get_by_test_id('photo-open')).to_be_visible(timeout=20000)
        page.evaluate('() => document.fonts.ready')
        page.wait_for_timeout(1800)  # The welcome entrance finishes before visual evidence.
        Path('.local/photo-mac-check').mkdir(exist_ok=True)
        page.screenshot(path='.local/photo-mac-check/welcome.png')
        page.get_by_test_id('photo-open').click()
        expect(page.get_by_test_id('photo-capture')).to_be_enabled(timeout=15000)
        page.get_by_test_id('photo-capture').click()
        expect(page.get_by_test_id('photo-print')).to_be_enabled(timeout=15000)
        page.screenshot(path='.local/photo-mac-check/preview.png')
        page.get_by_test_id('photo-retake').click()
        expect(page.get_by_test_id('photo-capture')).to_be_enabled(timeout=15000)
        page.get_by_test_id('photo-capture').click()
        expect(page.get_by_test_id('photo-print')).to_be_enabled(timeout=15000)
        page.get_by_test_id('photo-print').click()
        expect(page.get_by_test_id('photo-open')).to_be_visible(timeout=20000)
        expect(page.get_by_test_id('photo-preview')).to_have_count(0)
        assert json.load(urlopen(config['origin'] + '/test-writes')) == {'writes': 1}
        assert not external, external
        assert page.evaluate('Object.keys(localStorage).length') == 0
        browser.close()
    print('PASS: camera, thermal preview, retake, one print dispatch, automatic welcome, no external requests')
finally:
    server.terminate()
    server.wait(timeout=10)
