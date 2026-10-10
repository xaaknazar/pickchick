"""Luma-inspired patterns (sheet, top toast, order status line, slide-to-confirm) on local fixtures.

Usage: browser_luma_patterns.py <before|after> [published web export dir]
  before  only saves screenshots of the current app (baseline for the owner)
  after   saves screenshots, animation frames and asserts the new behaviour

Two exports are used: the simulator export served at MOBILE_RECOVERY_URL (test orders,
profile, cart) and, when given, a default published-catalog export for the price-change sheet.
Every API request is answered by a local fixture; no real orders, payments or messages.
"""
from browser_network import isolated_context, route_fixture
from account_fixture import signed_in
import copy
import json
import os
import subprocess
import sys
import threading
import uuid
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4182').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost')
MODE = sys.argv[1] if len(sys.argv) > 1 else 'after'
assert MODE in ('before', 'after'), MODE
AFTER = MODE == 'after'
PUBLISHED = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None
OUT = ROOT / '.local/luma-patterns' / MODE
OUT.mkdir(parents=True, exist_ok=True)
CAT = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
    "import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js';console.log(JSON.stringify(testCompleteCatalog))"],
    cwd=ROOT, text=True))
META = {'synthetic': True, 'namespace': 'pickchick-test'}
BRANCH = CAT['branch_id']
NOW = '2026-10-11T12:00:00.000Z'
SESSION = {**META, 'session_id': str(uuid.uuid4()), 'token': 'a' * 64,
           'expires_at': '2099-01-01T00:00:00.000Z', 'channel': 'mobile'}
LINE = {'id': 'pick-combo', 'name': 'Pick Combo', 'description': 'Fixture', 'category': 'Комбо',
        'price_minor': '419000', 'image_id': 'i7.jpg', 'prep_required': True, 'quantity': 1,
        'line_total_minor': '419000'}
QUOTE = {**META, 'quote_id': str(uuid.uuid4()), 'branch_id': BRANCH, 'catalog_version': 'mockup-v0.2',
         'channel': 'mobile', 'service_mode': 'takeaway', 'currency': 'KZT', 'total_minor': '419000',
         'lines': [LINE], 'created_at': NOW, 'expires_at': '2099-01-01T00:00:00.000Z'}
BASE = {**META, 'order_id': str(uuid.uuid4()), 'number': '342', 'branch_id': BRANCH, 'version': 2,
        'state': 'preparing', 'payment_state': 'not_started', 'payment_attempt_id': None,
        'fiscal_state': 'not_applicable', 'snapshot': QUOTE,
        'tasks': [{'task_id': str(uuid.uuid4()), 'station': s, 'title': s, 'state': 'pending',
                   'mandatory': True} for s in ['prep', 'assembly']],
        'created_at': NOW, 'updated_at': NOW, 'cancellation_reason': None}
CAPABILITIES = {'schema_version': 1, 'environment': 'staging', 'data_mode': 'synthetic',
                'ordering_enabled': False,
                'features': {**{k: False for k in ['phone_auth', 'payments', 'fiscal', 'checkout', 'loyalty']},
                             'test_order_flow': True}}
errors = []


def shot(page, name):
    page.screenshot(path=str(OUT / f'{name}.png'))


def orders_context(browser, width, height, reduced=True):
    """Simulator export with one synthetic order; returns (context, page, state, advance)."""
    ctx = isolated_context(browser, viewport={'width': width, 'height': height}, has_touch=True,
                           reduced_motion='reduce' if reduced else 'no-preference')
    signed_in(ctx)
    ctx.add_init_script('localStorage.setItem("pickchick.test.customer.v1",' + json.dumps(json.dumps(SESSION)) + ')')
    state = {'order': copy.deepcopy(BASE), 'waiting': [], 'commands': [], 'teardown': False}

    def intercept(r):
        if state['teardown']:
            r.abort()
            return
        order = state['order']
        path = urlparse(r.request.url).path
        if path == '/v1/test/orders/watch':
            if r.request.post_data_json['versions'][0]['version'] == order['version']:
                state['waiting'].append(r)
                return
            data = {**META, 'orders': [order]}
        elif path == '/v1/test/orders':
            data = {**META, 'orders': [order]}
        elif path.endswith('/cancel') and r.request.method == 'POST':
            body = r.request.post_data_json
            state['commands'].append(('cancel', body))
            order.update(state='cancelled', version=order['version'] + 1,
                         cancellation_reason=body['reason'])
            data = order
        elif path.endswith('/feedback'):
            data = {'review': None, 'tickets': []}
        elif path == '/v1/test/catalog':
            data = CAT
        elif path == '/v1/capabilities':
            data = CAPABILITIES
        elif path == '/v1/branches':
            data = {'branches': [{'id': BRANCH, 'code': 'TEST', 'name': 'ТЦ Abay Plaza',
                                  'timezone': 'Asia/Almaty', 'ordering_enabled': False}]}
        elif path.endswith('/menu'):
            data = {'schema_version': 1, 'branch_id': BRANCH, 'release_id': str(uuid.uuid4()),
                    'version': 1, 'published_at': NOW, 'items': []}
        elif '/content/branches/' in path:
            data = {'schema_version': 1, 'branch_id': BRANCH, 'promos': [], 'games': []}
        else:
            r.abort()
            return
        r.fulfill(json=data, headers={'Access-Control-Allow-Origin': '*'})

    route_fixture(ctx, '**/v1/**', intercept)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))

    def advance(next_state, prep, assembly):
        order = state['order']
        order['state'] = next_state
        order['version'] += 1
        order['tasks'][0]['state'] = prep
        order['tasks'][1]['state'] = assembly
        page.wait_for_timeout(100)
        for held in state['waiting'][:]:
            held.fulfill(json={**META, 'orders': [order]}, headers={'Access-Control-Allow-Origin': '*'})
            state['waiting'].remove(held)

    def close():
        state['teardown'] = True
        for held in state['waiting']:
            try:
                held.abort()
            except Exception:
                pass
        page.wait_for_timeout(50)
        ctx.close()

    return page, state, advance, close


def open_order(page, state):
    page.goto(URL + '/orders')
    item = page.get_by_test_id('history-order-' + state['order']['order_id'])
    expect(item).to_be_visible(timeout=20000)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=10000)
    item.click()
    expect(page.get_by_test_id('order-status-items')).to_be_visible()


def toast_box(page):
    toast = page.get_by_test_id('app-toast')
    expect(toast).to_be_visible()
    return toast, toast.bounding_box()


def order_status(browser, width, height):
    page, state, advance, close = orders_context(browser, width, height)
    open_order(page, state)
    page.wait_for_timeout(300)
    shot(page, f'03-order-status-preparing-{width}')
    if AFTER:
        line = page.get_by_test_id('order-status-line')
        expect(line).to_contain_text('Готовится')
        expect(line).to_contain_text('342')
        actions = page.get_by_test_id('order-action-row')
        expect(actions.get_by_role('button')).to_have_count(3)
        for button in actions.get_by_role('button').all():
            box = button.bounding_box()
            assert box['height'] >= 44 and box['width'] >= 44, box
        expect(actions.get_by_role('button', name='Позвонить')).to_have_count(0)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    advance('ready', 'done', 'done')
    expect(page.get_by_test_id('connected-order-state')).to_have_text('Заказ готов!', timeout=10000)
    if AFTER:
        toast, box = toast_box(page)
        expect(toast).to_contain_text('Заказ готов - заберите на выдаче')
        expect(toast).to_have_attribute('role', 'status')
        assert box['y'] >= 0 and box['y'] < 80, box
        expect(page.get_by_test_id('order-status-line')).to_contain_text('Готов - заберите на выдаче')
    page.wait_for_timeout(250)
    shot(page, f'02-toast-ready-{width}')
    if AFTER:
        # Auto-dismiss after 2.5 s.
        expect(page.get_by_test_id('app-toast')).to_have_count(0, timeout=4000)
    shot(page, f'03-order-status-ready-{width}')
    close()


def cancel_flow(browser, width, height):
    page, state, advance, close = orders_context(browser, width, height)
    open_order(page, state)
    page.goto(URL + '/screen/M22')
    expect(page.get_by_test_id('test-cancel-order')).to_be_visible(timeout=15000)
    page.wait_for_timeout(300)
    if not AFTER:
        shot(page, f'01-sheet-cancel-{width}')
        shot(page, f'04-slide-cancel-{width}')
        close()
        return
    page.get_by_test_id('test-cancel-order').click()
    sheet = page.get_by_test_id('confirm-sheet')
    expect(sheet).to_be_visible()
    expect(sheet).to_have_attribute('role', 'dialog')
    expect(sheet.get_by_role('heading')).to_contain_text('Отменить заказ')
    page.wait_for_timeout(300)
    shot(page, f'01-sheet-cancel-{width}')
    assert not state['commands'], 'Opening the sheet must not cancel'
    # Close with × keeps the order.
    page.get_by_test_id('confirm-sheet-close').click()
    expect(sheet).to_have_count(0)
    page.get_by_test_id('test-cancel-order').click()
    knob = page.get_by_test_id('slide-confirm-knob')
    track = page.get_by_test_id('slide-confirm')
    expect(track).to_have_attribute('role', 'button')
    tb, kb = track.bounding_box(), knob.bounding_box()
    assert kb['height'] >= 44 and kb['width'] >= 44, kb
    cx, cy = kb['x'] + kb['width'] / 2, kb['y'] + kb['height'] / 2
    travel = tb['width'] - kb['width'] - 8
    # A short drag springs back and does not confirm.
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + travel * 0.5, cy, steps=8)
    page.wait_for_timeout(120)
    shot(page, f'04-slide-cancel-50-{width}')
    page.mouse.up()
    page.wait_for_timeout(400)
    assert not state['commands'], 'Half a slide must not cancel'
    shot(page, f'04-slide-cancel-0-{width}')
    kb = knob.bounding_box()
    cx, cy = kb['x'] + kb['width'] / 2, kb['y'] + kb['height'] / 2
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + travel * 0.97, cy, steps=12)
    page.wait_for_timeout(120)
    shot(page, f'04-slide-cancel-100-{width}')
    page.mouse.move(cx + travel + 20, cy, steps=2)
    page.mouse.up()
    expect(page.get_by_test_id('confirm-sheet')).to_have_count(0, timeout=10000)
    expect(page.get_by_test_id('order-status-line').first).to_contain_text('Отменён', timeout=10000)
    assert len(state['commands']) == 1, state['commands']
    page.wait_for_timeout(300)
    shot(page, f'04-slide-cancel-done-{width}')
    close()


def add_to_cart(browser, width, height, frames=False):
    ctx = isolated_context(browser, viewport={'width': width, 'height': height}, has_touch=True,
                           reduced_motion='no-preference' if frames else 'reduce')
    signed_in(ctx)

    def fixture(route):
        assert route.request.method == 'GET'
        path = urlparse(route.request.url).path
        data = {'/v1/capabilities': CAPABILITIES,
                '/v1/branches': {'branches': [{'id': BRANCH, 'code': 'TEST', 'name': 'ТЦ Abay Plaza',
                                               'timezone': 'Asia/Almaty', 'ordering_enabled': False}]},
                '/v1/branches/' + BRANCH + '/menu': {'schema_version': 1, 'branch_id': BRANCH,
                    'release_id': '10000000-0000-4000-8000-000000000008', 'version': 1,
                    'published_at': NOW, 'items': []},
                '/v1/test/catalog': CAT}
        if path in data:
            route.fulfill(json=data[path], headers={'Access-Control-Allow-Origin': '*'})
        else:
            route.abort()

    route_fixture(ctx, '**/v1/**', fixture)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL + '/menu')
    expect(page.get_by_test_id('product-pick-combo')).to_be_visible(timeout=20000)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=10000)
    page.get_by_test_id('product-pick-combo').click()
    page.get_by_test_id('product-add').click()
    if frames and AFTER:
        for i, delay in enumerate([30, 110, 260]):
            page.wait_for_timeout(delay if i == 0 else delay - [30, 110, 260][i - 1])
            shot(page, f'02-toast-cart-frame{i + 1}-{width}')
        ctx.close()
        return
    page.wait_for_timeout(300)
    shot(page, f'02-toast-cart-{width}')
    if AFTER:
        toast, box = toast_box(page)
        expect(toast).to_contain_text('Добавлено в корзину')
        assert box['x'] >= 8 and box['x'] + box['width'] <= width - 8, box
        assert box['height'] >= 44, box
        # Swipe up dismisses before the timer.
        x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x, y - 60, steps=6)
        page.mouse.up()
        expect(page.get_by_test_id('app-toast')).to_have_count(0, timeout=1500)
    ctx.close()


def sign_out(browser, width, height, frames=False):
    ctx = isolated_context(browser, viewport={'width': width, 'height': height},
                           reduced_motion='no-preference' if frames else 'reduce')
    signed_in(ctx)
    mutations = []

    def intercept(route):
        if route.request.method != 'GET':
            mutations.append(route.request.url)
        route.abort()

    route_fixture(ctx, '**/v1/**', intercept)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL + '/profile')
    expect(page.get_by_test_id('demo-sign-out')).to_be_visible(timeout=20000)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=10000)
    page.get_by_test_id('scroll-M30').evaluate('(e) => e.scrollTop = e.scrollHeight')
    page.wait_for_timeout(300)
    if not AFTER:
        shot(page, f'01-sheet-signout-{width}')
        ctx.close()
        return
    page.get_by_test_id('demo-sign-out').click()
    sheet = page.get_by_test_id('confirm-sheet')
    if frames:
        for i, delay in enumerate([40, 120, 400]):
            page.wait_for_timeout(delay if i == 0 else delay - [40, 120, 400][i - 1])
            shot(page, f'01-sheet-signout-frame{i + 1}-{width}')
        ctx.close()
        return
    expect(sheet).to_be_visible()
    expect(sheet).to_contain_text('Выйти из профиля?')
    page.wait_for_timeout(300)
    shot(page, f'01-sheet-signout-{width}')
    close = page.get_by_test_id('confirm-sheet-close').bounding_box()
    assert close['width'] >= 44 and close['height'] >= 44, close
    primary = page.get_by_test_id('confirm-sheet-primary').bounding_box()
    assert primary['height'] >= 48 and primary['width'] >= width - 80, primary
    page.keyboard.press('Escape')
    expect(sheet).to_have_count(0)
    page.get_by_test_id('demo-sign-out').click()
    page.get_by_test_id('confirm-sheet-primary').click()
    expect(page.get_by_test_id('account-required-login').filter(visible=True)).to_be_visible()
    assert not mutations, mutations
    ctx.close()


def storefront(version, price):
    script = ("import {pricingFixture, product, text} from './tests/helpers/catalog-pricing.mjs';"
              "const f = pricingFixture([product('pick-combo', {name: text('Pick Combo'), price_minor: '%s'}),"
              "product('side', {name: text('Картофель фри'), price_minor: '89000'})]);"
              "console.log(JSON.stringify(f.publication.payload));" % price)
    payload = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script], cwd=ROOT, text=True))
    return {'branch': {'id': BRANCH, 'code': 'TEST', 'name': 'ТЦ Abay Plaza', 'timezone': 'Asia/Almaty',
                       'ordering_enabled': True},
            'channel': 'mobile', 'version': version, 'published_at': NOW, 'payload': payload}


def price_change(browser, width, height):
    class Spa(SimpleHTTPRequestHandler):
        def do_GET(self):
            if not (PUBLISHED / urlparse(self.path).path.lstrip('/')).is_file():
                self.path = '/index.html'
            super().do_GET()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Spa, directory=str(PUBLISHED)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}'
    state = {'publication': storefront(1, '419000')}
    ctx = isolated_context(browser, viewport={'width': width, 'height': height}, reduced_motion='reduce')
    signed_in(ctx)

    def route(r):
        path = urlparse(r.request.url).path
        if r.request.method != 'GET':
            r.fulfill(status=403, content_type='application/json', body='{}')
            return
        pub = state['publication']
        if path == '/v1/capabilities':
            data = {**CAPABILITIES, 'data_mode': 'pilot',
                    'features': {**CAPABILITIES['features'], 'phone_auth': True}}
        elif path == '/v1/customer-checkout/catalog':
            data = pub
        elif path == '/v1/customer-checkout/catalog/media':
            data = {'version': pub['version'], 'products': {}}
        elif path == '/v1/customer-checkout/availability':
            data = {'enabled': True, 'fresh': True, 'orderingOpen': True, 'signature': 'a' * 64,
                    'products': [{'id': x['id'], 'available': True, 'stoppedOptions': []}
                                 for x in pub['payload']['products']]}
        elif path.startswith('/v1/content/branches/'):
            data = {'schema_version': 1, 'branch_id': BRANCH, 'promos': [], 'games': []}
        elif path == '/v1/auth/config':
            data = {'enabled': False}
        else:
            r.abort()
            return
        r.fulfill(status=200, content_type='application/json', body=json.dumps(data),
                  headers={'Access-Control-Allow-Origin': '*'})

    route_fixture(ctx, '**/v1/**', route)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base + "/menu")
    page.get_by_test_id('product-pick-combo').click(timeout=30000)
    page.get_by_test_id('product-add').click()
    page.get_by_test_id('open-cart').click()
    expect(page.get_by_test_id('cart-checkout')).to_contain_text('4 190', timeout=10000)
    expect(page.get_by_test_id('app-toast')).to_have_count(0, timeout=4000)
    state['publication'] = storefront(2, '449000')
    page.evaluate('Object.defineProperty(document, "visibilityState", {configurable:true,get:()=>"hidden"});document.dispatchEvent(new Event("visibilitychange"))')
    page.evaluate('Object.defineProperty(document, "visibilityState", {configurable:true,get:()=>"visible"});document.dispatchEvent(new Event("visibilitychange"))')
    notice = page.get_by_test_id('cart-prices-updated')
    expect(notice).to_contain_text('Было 4 190 ₸. Сейчас 4 490 ₸.', timeout=10000)
    page.wait_for_timeout(300)
    shot(page, f'01-sheet-prices-{width}')
    if AFTER:
        sheet = page.get_by_test_id('confirm-sheet')
        expect(sheet).to_contain_text('Цены обновились')
        # × keeps the inline notice; «Понятно» acknowledges the change.
        page.get_by_test_id('confirm-sheet-close').click()
        expect(sheet).to_have_count(0)
        expect(notice).to_contain_text('Было 4 190 ₸. Сейчас 4 490 ₸.')
        page.get_by_test_id('catalog-update-apply').click()
        expect(notice).to_have_count(0)
    ctx.close()
    server.shutdown()


ONLY = os.environ.get('LUMA_ONLY')
with sync_playwright() as p:
    browser = p.chromium.launch()
    if ONLY:
        globals()[ONLY](browser, 393, 852)
        browser.close()
        sys.exit(0)
    order_status(browser, 393, 852)
    order_status(browser, 320, 568)
    cancel_flow(browser, 393, 852)
    cancel_flow(browser, 320, 568)
    add_to_cart(browser, 393, 852)
    sign_out(browser, 393, 852)
    if AFTER:
        add_to_cart(browser, 393, 852, frames=True)
        sign_out(browser, 393, 852, frames=True)
    if PUBLISHED:
        price_change(browser, 393, 852)
    browser.close()
assert not errors, errors
print(f'PASS luma patterns ({MODE}): screenshots in {OUT.relative_to(ROOT)}')
