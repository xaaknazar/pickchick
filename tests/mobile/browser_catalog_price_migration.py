"""Synthetic published catalog UI; denies every financial command and external network read.
Usage: python browser_catalog_price_migration.py <Expo web export> <publication JSON>
"""
import copy
import json
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(sys.argv[1]).resolve()
publication = json.loads(Path(sys.argv[2]).read_text())
BRANCH = publication['branch']['id']

class Spa(SimpleHTTPRequestHandler):
    def do_GET(self):
        if not (ROOT / urlparse(self.path).path.lstrip('/')).is_file():
            self.path = '/index.html'
        super().do_GET()

    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Spa, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{server.server_port}'
errors = []
commands = []

with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in [(393, 852), (430, 932)]:
        state = {'publication': copy.deepcopy(publication)}
        context = browser.new_context(viewport={'width': width, 'height': height}, reduced_motion='reduce')

        def route(r):
            path = urlparse(r.request.url).path
            if r.request.method != 'GET':
                commands.append(path)
                r.fulfill(status=403, content_type='application/json', body='{}')
                return
            if path == '/v1/capabilities':
                data = {'schema_version': 1, 'environment': 'staging', 'data_mode': 'pilot', 'ordering_enabled': False,
                        'features': {'phone_auth': True, 'test_order_flow': True,
                                     **{k: False for k in ['payments', 'fiscal', 'checkout', 'loyalty']}}}
            elif path == '/v1/customer-checkout/catalog':
                data = state['publication']
            elif path == '/v1/customer-checkout/availability':
                data = {'enabled': True, 'fresh': True, 'orderingOpen': True, 'signature': 'a'*64,
                        'products': [{'id': x['id'], 'available': True, 'stoppedOptions': []}
                                     for x in state['publication']['payload']['products']]}
            elif path == '/v1/content/branches/' + BRANCH:
                data = {'schema_version': 1, 'branch_id': BRANCH, 'promos': [], 'games': []}
            elif path == '/v1/auth/config':
                data = {'enabled': False}
            else:
                raise AssertionError('Unexpected external API ' + path)
            r.fulfill(status=200, content_type='application/json', body=json.dumps(data))

        context.route('https://pickchick.185.129.51.103.nip.io/**', route)
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL + '/menu')
        expect(page.get_by_test_id('product-pick-combo')).to_contain_text('100 ₸', timeout=30000)
        expect(page.get_by_test_id('category-heading-Комбо')).to_be_visible()
        photo = page.get_by_test_id('product-photo-pick-combo').locator('img')
        expect(photo).to_have_count(1)
        assert 'pick-combo' in photo.get_attribute('src')
        page.get_by_test_id('product-pick-combo').click()
        expect(page.get_by_test_id('product-add')).to_contain_text('100 ₸')
        page.get_by_test_id('product-add').click()
        page.get_by_test_id('open-cart').click()
        expect(page.get_by_test_id('cart-checkout')).to_contain_text('100 ₸')
        expect(page.get_by_test_id('cart-recommend-toast')).to_contain_text('25 ₸')
        saved = page.evaluate('JSON.parse(localStorage.getItem("pickchick.mobile.preferences.v1"))')
        assert saved['publication']['version'] == 3
        assert saved['lines'][0]['selections'] == [
            {'group_id': 'drink', 'option_id': 'cola-bottle', 'quantity': 1},
            {'group_id': 'sauce', 'option_id': 'pick', 'quantity': 1}]
        # Simulate a pre-upgrade persisted basket with a chosen paid drink.
        saved.pop('publication')
        saved['releaseId'] = 'test:mockup-v0.3'
        saved['lines'][0]['quantity'] = 2
        saved['lines'][0]['selections'][0]['option_id'] = 'lemonade'
        page.evaluate('(saved)=>localStorage.setItem("pickchick.mobile.preferences.v1", JSON.stringify(saved))', saved)
        page.reload()
        expect(page.get_by_test_id('catalog-update-notice')).to_contain_text('старой версией', timeout=15000)
        expect(page.get_by_test_id('cart-checkout')).to_contain_text('8 780 ₸')
        expect(page.get_by_test_id('cart-quantity-pick-combo')).to_have_text('2')
        page.get_by_test_id('cart-recommend-toast').click()
        expect(page.get_by_test_id('cart-quantity-toast')).to_have_count(0)
        page.reload()
        expect(page.get_by_test_id('cart-checkout')).to_contain_text('8 780 ₸', timeout=15000)
        page.get_by_test_id('catalog-update-apply').click()
        expect(page.get_by_test_id('cart-checkout')).to_contain_text('600 ₸')
        assert page.evaluate('JSON.parse(localStorage.getItem("pickchick.mobile.preferences.v1")).lines[0].selections[0].option_id') == 'lemonade'
        # Public catalog refresh on foreground updates cards but retains the basket.
        state['publication']['version'] = 4
        combo = next(x for x in state['publication']['payload']['products'] if x['id'] == 'pick-combo')
        combo['channel_prices_minor']['mobile'] = '20000'
        page.evaluate('Object.defineProperty(document, "visibilityState", {configurable:true,get:()=>"hidden"});document.dispatchEvent(new Event("visibilitychange"))')
        page.evaluate('Object.defineProperty(document, "visibilityState", {configurable:true,get:()=>"visible"});document.dispatchEvent(new Event("visibilitychange"))')
        expect(page.get_by_test_id('catalog-update-notice')).to_contain_text('старой версией', timeout=15000)
        expect(page.get_by_test_id('cart-checkout')).to_contain_text('600 ₸')
        page.reload()
        expect(page.get_by_test_id('catalog-update-notice')).to_contain_text('старой версией', timeout=15000)
        expect(page.get_by_test_id('cart-checkout')).to_contain_text('600 ₸')
        page.get_by_test_id('catalog-update-apply').click()
        expect(page.get_by_test_id('cart-checkout')).to_contain_text('800 ₸')
        context.close()
    browser.close()
server.shutdown()
assert not errors, errors
assert not commands, commands
print(json.dumps({'browser': 'passed', 'sizes': 2, 'legacy_basket_restart': True, 'foreground_refresh': True,
                  'menu_detail_channel_price': True, 'photo_preserved': True, 'defaults_preserved': True,
                  'financial_commands': 0}))
