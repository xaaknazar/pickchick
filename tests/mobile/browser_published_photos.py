"""Published catalog photos and republish refresh in the mobile web build; local fixtures only.

Usage: python browser_published_photos.py <Expo web export with the default published catalog>

Checks, at 320 and 390 px:
- an uploaded back-office photo (media map) replaces the bundled photo on the menu card, the
  product page hero and the cart line, loaded from its immutable hash URL;
- every other product keeps its bundled photo;
- a missing media map (404) and an unreachable photo both fall back to the bundled photo;
- a newer X-Catalog-Version reloads the menu within 3 seconds, preserves the basket and
  displays the previous/new totals without creating an order or payment.
Every POST is refused and recorded; no VPS, SMS, order or payment is touched.
"""
from browser_network import isolated_context, route_fixture
import base64
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright

WEB = Path(sys.argv[1]).resolve()
assert (WEB / 'index.html').is_file(), 'Export the mobile web app first'
ROOT = Path(__file__).resolve().parents[2]
OUTPUT = Path(os.environ.get('PUBLISHED_PHOTOS_OUTPUT', ROOT / '.local/published-photos'))
OUTPUT.mkdir(parents=True, exist_ok=True)
API = 'https://pickchick.185.129.51.103.nip.io'
BRANCH = '10000000-0000-4000-8000-000000000003'


def seed_payload():
    code = ('import {pathToFileURL} from "node:url";'
            'const m = await import(pathToFileURL(process.argv[1]).href);'
            'process.stdout.write(JSON.stringify(m.mockupCatalogDraft));')
    seed = ROOT / 'packages/catalog-admin/dist/seed.js'
    out = subprocess.run(['node', '--input-type=module', '-e', code, str(seed)],
                         capture_output=True, text=True, check=True).stdout
    return {**json.loads(out), 'content_source': 'operator', 'content_reviewed': True}


# 16x16 lossless WebP renditions in three magenta tones: synthetic, obviously not a bundled photo.
RENDITIONS = {variant: base64.b64decode(data) for variant, data in [
    ('card', 'UklGRh4AAABXRUJQVlA4TBEAAAAvD8ADAAdQk1oXr/+BiOh/AAA='),
    ('hero', 'UklGRh4AAABXRUJQVlA4TBEAAAAvD8ADAAdQjyLXrf+BiOh/AAA='),
    ('thumb', 'UklGRh4AAABXRUJQVlA4TBEAAAAvD8ADAAdQmXJXsP+BiOh/AAA='),
]}
SHAS = {variant: hashlib.sha256(data).hexdigest() for variant, data in RENDITIONS.items()}
FILES = {f'/v1/media/catalog/{SHAS[v]}.{v}.webp': data for v, data in RENDITIONS.items()}
ENTRY = {'sha256': SHAS['card'], 'tile_color': '#FFFFFF', 'cutout': False,
         **{v: f'/v1/media/catalog/{SHAS[v]}.{v}.webp' for v in RENDITIONS}}
PAYLOAD = seed_payload()


class Spa(SimpleHTTPRequestHandler):
    def do_GET(self):
        if not (WEB / urlparse(self.path).path.lstrip('/')).is_file():
            self.path = '/index.html'
        super().do_GET()

    def log_message(self, *args):
        pass


class Fixture:
    def __init__(self, media='ok', images='ok'):
        self.media, self.images = media, images
        self.version = 6
        self.payload = copy.deepcopy(PAYLOAD)
        self.requests, self.commands, self.unexpected = [], [], []

    def publication(self):
        return {'branch': {'id': BRANCH, 'code': 'SYNTHETIC', 'name': 'Synthetic restaurant',
                           'timezone': 'Asia/Almaty', 'ordering_enabled': True},
                'channel': 'mobile', 'version': self.version,
                'published_at': '2026-10-08T00:00:00.000Z', 'payload': self.payload}

    def count(self, path):
        return sum(1 for p, _ in self.requests if p == path)

    def route(self, route):
        request = route.request
        parsed = urlparse(request.url)
        path, query = parsed.path, parse_qs(parsed.query)
        self.requests.append((path, parsed.query))
        cors = {'Access-Control-Allow-Origin': '*',
                'Access-Control-Expose-Headers': 'X-Catalog-Version, X-Availability-Signature'}
        if request.method != 'GET':
            self.commands.append((request.method, path))
            return route.fulfill(status=403, json={'code': 'FORBIDDEN'}, headers=cors)
        if path in FILES:
            if self.images != 'ok':
                return route.fulfill(status=404, body='', headers=cors)
            assert 'authorization' not in request.headers and 'cookie' not in request.headers
            return route.fulfill(status=200, body=FILES[path], content_type='image/webp',
                                 headers={**cors, 'Cache-Control': 'public, max-age=31536000, immutable'})
        headers = {**cors, 'Cache-Control': 'no-store'}
        if path == '/v1/capabilities':
            data = {'schema_version': 1, 'environment': 'staging', 'data_mode': 'pilot',
                    'ordering_enabled': False,
                    'features': {'phone_auth': True, 'test_order_flow': True,
                                 **{k: False for k in ['payments', 'fiscal', 'checkout', 'loyalty']}}}
        elif path == '/v1/customer-checkout/catalog':
            data = self.publication()
        elif path == '/v1/customer-checkout/catalog/media':
            if self.media != 'ok':
                return route.fulfill(status=404, json={'code': 'NOT_FOUND'}, headers=headers)
            if query.get('version') != [str(self.version)]:
                return route.fulfill(status=409, json={'code': 'CONFLICT'}, headers=headers)
            data = {'version': self.version, 'products': {'burger': ENTRY}}
        elif path == '/v1/customer-checkout/availability':
            signature = hashlib.sha256(f'availability:{self.version}'.encode()).hexdigest()
            data = {'enabled': True, 'fresh': True, 'orderingOpen': True, 'signature': signature,
                    'products': [{'id': p['id'], 'available': True, 'stoppedOptions': []}
                                 for p in self.payload['products']]}
            headers = {**headers, 'X-Catalog-Version': str(self.version),
                       'X-Availability-Signature': signature}
        elif path == '/v1/content/branches/' + BRANCH:
            data = {'schema_version': 1, 'branch_id': BRANCH, 'promos': [], 'games': []}
        elif path == '/v1/auth/config':
            data = {'enabled': False}
        else:
            self.unexpected.append(path)
            return route.fulfill(status=404, json={'code': 'NOT_FOUND'}, headers=headers)
        route.fulfill(status=200, json=data, headers=headers)


def card_image(page, product):
    return page.get_by_test_id(f'product-photo-{product}').locator('img')


def wait_loaded(locator, timeout=15):
    """The image element has decoded pixels (not a broken or pending request)."""
    expect(locator).to_have_count(1)
    locator.scroll_into_view_if_needed()  # Card images load lazily on web.
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if locator.evaluate('(img) => img.complete && img.naturalWidth > 0'):
            return
        locator.page.wait_for_timeout(100)
    raise AssertionError('image not decoded: ' + str(locator.get_attribute('src')))


def settle(page):
    """Every image inside the viewport is decoded, so screenshots show the real tiles."""
    page.wait_for_function('''() => [...document.images].filter((img) => {
        const r = img.getBoundingClientRect();
        return r.width > 0 && r.bottom > 0 && r.top < innerHeight;
    }).every((img) => img.complete && img.naturalWidth > 0)''', timeout=15000)


server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Spa, directory=str(WEB)))
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{server.server_port}'
errors, results = [], []

with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in [(320, 568), (390, 844)]:
        # 1. Uploaded photo everywhere, other products bundled, then a republish via the header.
        fixture = Fixture()
        context = isolated_context(browser,viewport={'width': width, 'height': height},
                                      reduced_motion='reduce')
        route_fixture(context,API + '/**', fixture.route)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + '/menu')
        expect(page.get_by_test_id('product-burger')).to_be_visible(timeout=30000)
        burger = card_image(page, 'burger')
        expect(burger).to_have_attribute('src', API + ENTRY['card'], timeout=15000)
        wait_loaded(burger)
        combo = card_image(page, 'pick-combo')
        expect(combo).to_have_attribute('src', re.compile(r'menu-light/pick-combo'))
        assert 'media/catalog' not in combo.get_attribute('src')
        assert ('/v1/customer-checkout/catalog/media', 'version=6') in fixture.requests
        settle(page)
        page.screenshot(path=str(OUTPUT / f'menu-{width}.png'))
        page.get_by_test_id('product-burger').click()
        hero = page.locator(f'img[src="{API + ENTRY["hero"]}"]')
        expect(hero).to_be_visible(timeout=15000)
        wait_loaded(hero)
        settle(page)
        page.screenshot(path=str(OUTPUT / f'product-{width}.png'))
        page.get_by_test_id('product-add').click()
        page.get_by_test_id('open-cart').click()
        expect(page.get_by_test_id('cart-quantity-burger')).to_have_text('1')
        expect(page.locator(f'img[src="{API + ENTRY["card"]}"]').first).to_be_visible()
        before = page.get_by_test_id('cart-checkout').get_attribute('aria-label')
        catalog_reads = fixture.count('/v1/customer-checkout/catalog')

        assert before == 'Оформить заказ, 2 390 ₸', before
        after = 'Оформить заказ, 2 490 ₸'
        # Republish v7: burger +100 ₸. Only the long-poll header announces it.
        fixture.payload = copy.deepcopy(fixture.payload)
        item = next(x for x in fixture.payload['products'] if x['id'] == 'burger')
        item['price_minor'] = str(int(item['price_minor']) + 10000)
        published_at = time.monotonic()
        fixture.version = 7
        expect(page.get_by_test_id('cart-prices-updated')).to_contain_text(
            'Цены обновились. Проверьте итоговую сумму перед оплатой', timeout=3000)
        refresh_seconds = time.monotonic() - published_at
        assert refresh_seconds < 3, refresh_seconds
        assert fixture.count('/v1/customer-checkout/catalog') > catalog_reads
        expect(page.get_by_test_id('cart-prices-updated')).to_contain_text('Было 2 390 ₸. Сейчас 2 490 ₸.')
        expect(page.get_by_test_id('cart-checkout')).to_have_attribute('aria-label', after)
        expect(page.get_by_test_id('cart-quantity-burger')).to_have_text('1')
        expect(page.locator(f'img[src="{API + ENTRY["card"]}"]').first).to_be_visible()
        assert ('/v1/customer-checkout/catalog/media', 'version=7') in fixture.requests
        page.screenshot(path=str(OUTPUT / f'cart-republished-{width}.png'))
        page.get_by_test_id('catalog-update-apply').click()
        expect(page.get_by_test_id('cart-prices-updated')).to_have_count(0)
        expect(page.get_by_test_id('cart-checkout')).to_have_attribute('aria-label', after)
        expect(page.locator(f'img[src="{API + ENTRY["card"]}"]').first).to_be_visible()
        assert not fixture.commands and not fixture.unexpected, (fixture.commands, fixture.unexpected)
        context.close()

        # 2. Media map unavailable (route missing or media disabled): bundled photos.
        # 3. Media map present but the photo cannot be loaded: bundled photo after the error.
        for media, images in [('missing', 'ok'), ('ok', 'missing')]:
            fixture = Fixture(media=media, images=images)
            context = isolated_context(browser,viewport={'width': width, 'height': height},
                                          reduced_motion='reduce')
            route_fixture(context,API + '/**', fixture.route)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(URL + '/menu')
            expect(page.get_by_test_id('product-burger')).to_be_visible(timeout=30000)
            burger = card_image(page, 'burger')
            expect(burger).to_have_count(1)
            burger.scroll_into_view_if_needed()
            expect(burger).to_have_attribute('src', re.compile(r'catalog-hd/burger'), timeout=15000)
            wait_loaded(burger)
            if images == 'missing':
                assert any(path == ENTRY['card'] for path, _ in fixture.requests)
            settle(page)
            page.screenshot(path=str(OUTPUT / f'fallback-{media}-{images}-{width}.png'))
            assert not fixture.commands and not fixture.unexpected, (fixture.commands,
                                                                      fixture.unexpected)
            context.close()
        results.append({'width': width, 'refresh_seconds': round(refresh_seconds, 2)})
    browser.close()
server.shutdown()
assert not errors, errors
print(json.dumps({'browser': 'passed', 'sizes': results, 'remote_photo': True,
                  'bundled_fallbacks': 2, 'republish_header_refresh': True, 'commands': 0}))
