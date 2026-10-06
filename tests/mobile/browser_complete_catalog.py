"""Complete mobile catalog UX on local HTTP fixtures; no VPS/SMS/bank mutations.

Uses the compiled catalog rather than duplicating its 24 products. The real
mobile recovery core submits a quote payload, but a simulated 503 intentionally
stops it before order creation. Integration tests own server pricing/payment.
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright

URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4182').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost'), 'Use a local exported app'
ROOT = Path(os.environ.get('PICKCHICK_TEST_SOURCE_ROOT', Path(__file__).resolve().parents[2]))
OUTPUT = Path(os.environ.get('COMPLETE_CATALOG_OUTPUT', '.local/complete-catalog'))
OUTPUT.mkdir(parents=True, exist_ok=True)
PACKAGE = ROOT / 'packages/test-order-flow/dist'
PREFERENCES = 'pickchick.mobile.preferences.v1'
DRAFT = 'pickchick.test.pending-order.v1'
SESSION_KEY = 'pickchick.test.customer.v1'


def node_module(filename, expression, payload=None):
    code = ('import {pathToFileURL} from "node:url"; import {readFileSync} from "node:fs"; '
            'const module = await import(pathToFileURL(process.argv[1]).href); '
            'const input = JSON.parse(readFileSync(0, "utf8")); '
            'process.stdout.write(JSON.stringify(' + expression + '));')
    completed = subprocess.run(['node', '--input-type=module', '-e', code, str(PACKAGE / filename)],
                               input=json.dumps(payload), text=True, capture_output=True, check=True)
    return json.loads(completed.stdout)


CATALOG = node_module('complete-catalog.js', 'module.testCompleteCatalog')
assert CATALOG['catalog_version'] == 'mockup-v0.3'
assert len(CATALOG['products']) == 24
assert all(product['description'] and product['nutrition'] for product in CATALOG['products'])
BRANCH = CATALOG['branch_id']
META = {'synthetic': True, 'namespace': 'pickchick-test'}
SESSION = {**META, 'session_id': '30000000-0000-4000-8000-000000000001',
           'token': 'a' * 64, 'channel': 'mobile', 'expires_at': '2099-01-01T00:00:00.000Z'}
READS = {
    '/v1/customer-checkout/availability': {'enabled': False, 'fresh': False, 'signature': 'disabled', 'products': []},
    '/v1/capabilities': {'schema_version': 1, 'environment': 'staging', 'data_mode': 'synthetic',
                         'ordering_enabled': False, 'features': {'test_order_flow': True, 'unpaid_test_orders': True,
                         **{key: False for key in ['phone_auth', 'payments', 'fiscal', 'checkout', 'loyalty']}}},
    '/v1/branches': {'branches': [{'id': BRANCH, 'code': 'TEST', 'name': 'Локальная проверка UI',
                     'timezone': 'Asia/Almaty', 'ordering_enabled': False}]},
    '/v1/branches/' + BRANCH + '/menu': {'schema_version': 1, 'branch_id': BRANCH,
                                      'release_id': '10000000-0000-4000-8000-000000000008',
                                      'version': 1, 'published_at': '2026-09-07T00:00:00Z', 'items': []},
    '/v1/test/catalog': CATALOG,
    '/v1/content/branches/' + BRANCH: {'schema_version': 1, 'branch_id': BRANCH, 'promos': [], 'games': []},
    '/v1/test/orders': {**META, 'orders': []},
}


def selected_set(item):
    return {(s['group_id'], s['option_id'], s['quantity']) for s in item['selections']}


BASE_SELECTIONS = {('drink', 'cola-bottle', 1), ('sauce', 'pick', 1)}
CUSTOM_SELECTIONS = {('drink', 'lemonade', 1), ('sauce', 'pick', 1), ('extras', 'toast', 1)}


class Fixture:
    def __init__(self):
        self.requests = []
        self.quotes = []
        self.violations = []

    def route(self, route):
        request = route.request
        parsed = urlparse(request.url)
        path = parsed.path
        self.requests.append((request.method, path))
        headers = {'Access-Control-Allow-Origin': '*'}
        if request.method == 'GET' and path in READS:
            if path == '/v1/test/catalog':
                assert parse_qs(parsed.query).get('catalog_version') == ['mockup-v0.3']
            route.fulfill(json=READS[path], headers=headers)
        elif request.method == 'POST' and path == '/v1/test/sessions':
            assert request.post_data_json == {'channel': 'mobile'}
            route.fulfill(json=SESSION, headers=headers)
        elif request.method == 'POST' and path == '/v1/test/quotes':
            self.quotes.append({'payload': request.post_data_json,
                                'key': request.headers.get('idempotency-key'),
                                'authorization': request.headers.get('authorization')})
            route.fulfill(status=503, json={'code': 'FIXTURE_QUOTE_UNAVAILABLE'}, headers=headers)
        else:
            self.violations.append((request.method, path))
            route.abort('failed')


def saved(page, key=PREFERENCES):
    return page.evaluate('(key) => JSON.parse(localStorage.getItem(key) || "null")', key)


def wait_saved_lines(page, count):
    page.wait_for_function('([key,count]) => JSON.parse(localStorage.getItem(key) || "null")?.lines.length === count',
                           arg=[PREFERENCES, count])


def stable_geometry(page, category):
    previous = None
    stable_since = time.monotonic()
    deadline = stable_since + 7
    while time.monotonic() < deadline:
        current = page.get_by_test_id('screen-M06').evaluate('''(root, category) => {
            const rect = (element) => element?.getBoundingClientRect().toJSON();
            const chip = root.querySelector(`[data-testid="category-${category}"]`);
            return { header: rect(root.querySelector('[data-testid="storefront-header"]')),
                     chip: rect(chip), heading: rect(root.querySelector(`[data-testid="category-heading-${category}"]`)),
                     selected: chip?.getAttribute('aria-selected'),
                     scroll: root.querySelector('[data-testid="scroll-M06"]').scrollTop };
        }''', category)
        if current != previous:
            stable_since = time.monotonic()
            previous = current
        elif time.monotonic() - stable_since >= 0.2:
            return current
        page.wait_for_timeout(35)
    raise AssertionError(f'Category scrolling did not settle: {previous}')


def fixed_footer(page, button_id, scroll_id, height):
    button = page.get_by_test_id(button_id)
    expect(button).to_be_visible()
    before = button.bounding_box()
    assert before['height'] >= 48 and before['y'] + before['height'] <= height + 1, before
    page.get_by_test_id(scroll_id).evaluate('(e) => { e.scrollTop = e.scrollHeight; }')
    after = button.bounding_box()
    assert abs(after['y'] - before['y']) <= 1, (before, after)
    scroll = page.get_by_test_id(scroll_id).bounding_box()
    if scroll_id == 'photo-product-scroll':
        # The photo page intentionally scrolls behind a transparent fixed action.
        # Its bottom padding must leave the final quantity control reachable.
        control = page.get_by_role('button', name='Увеличить: Pick Combo', exact=True).bounding_box()
        assert control['y'] + control['height'] <= before['y'] + 1, (control, before)
    else:
        assert scroll['y'] + scroll['height'] <= before['y'] + 1, (scroll, before)


def peak_geometry(page):
    # The supplied SVG's highest snow crest is at 168,44 in its 820x240 viewBox.
    # Check a point just inside that crest, including cover cropping and ancestors.
    geometry = page.get_by_test_id('loyalty-skyline').evaluate('''(image) => {
        const box = image.getBoundingClientRect();
        const card = image.closest('[data-testid="loyalty-card"]').getBoundingClientRect();
        const fill = getComputedStyle(image.querySelector('img') || image).objectFit === 'fill';
        const scale = Math.max(box.width / 820, box.height / 240);
        const point = fill
            ? { x: box.x + box.width * 168 / 820, y: box.y + box.height * 46 / 240 }
            : { x: box.x + (box.width - 820 * scale) / 2 + 168 * scale,
                y: box.bottom - 240 * scale + 46 * scale };
        const clips = [];
        for (let parent = image.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
            if ((style.overflowY !== 'visible' && (point.y < rect.top || point.y > rect.bottom)) ||
                (style.overflowX !== 'visible' && (point.x < rect.left || point.x > rect.right))) {
                clips.push(parent.getAttribute('data-testid') || parent.tagName);
            }
        }
        return { point, card: card.toJSON(), clips };
    }''')
    assert geometry['point']['y'] < geometry['card']['y'] - 0.5, geometry
    assert not geometry['clips'], geometry
    return geometry


def diagnostics(kind, value, traceback):
    current = globals().get('fixture')
    if current:
        print(json.dumps({'requests': current.requests, 'unexpected': current.violations,
                          'page_errors': globals().get('errors', [])}, ensure_ascii=False))
    sys.__excepthook__(kind, value, traceback)


sys.excepthook = diagnostics


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    results = []
    for width, height in [(320, 568), (390, 844), (430, 932)]:
        context = browser.new_context(viewport={'width': width, 'height': height}, reduced_motion='reduce')
        fixture = Fixture()
        context.route('**/v1/**', fixture.route)
        from account_fixture import signed_in
        signed_in(context)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + '/menu')
        menu = page.get_by_test_id('screen-M06')
        expect(page.get_by_test_id('product-pick-combo')).to_be_visible(timeout=20000)
        assert menu.locator('[data-testid^="product-"][role="button"]').count() == 24
        assert page.get_by_text('Меню обновилось.', exact=False).count() == 0
        page.get_by_test_id('loyalty-card').scroll_into_view_if_needed()
        peak = peak_geometry(page)
        page.screenshot(path=str(OUTPUT / f'mountains-{width}.png'))
        for category in ['Комбо', 'На двоих', 'Допы', 'Напитки', 'На компанию', 'Комбо'] * 2:
            chip = page.get_by_test_id('category-' + category)
            chip.click()
            geometry = stable_geometry(page, category)
            assert geometry['selected'] == 'true', (category, geometry)
            assert geometry['chip']['y'] >= geometry['header']['bottom'] - 1, geometry
            assert geometry['heading']['top'] >= geometry['chip']['bottom'] - 1, geometry
            assert geometry['heading']['bottom'] <= height - 48, geometry
            assert geometry['chip']['x'] >= -1 and geometry['chip']['right'] <= width + 1, geometry
            # User drag interrupts the previous anchor; the next tap must still work.
            page.get_by_test_id('scroll-M06').evaluate('(e) => { e.scrollTop += 160; }')
        page.get_by_test_id('category-Комбо').click()
        stable_geometry(page, 'Комбо')
        page.screenshot(path=str(OUTPUT / f'catalog-{width}.png'))
        page.get_by_test_id('product-pick-combo').click()
        product = page.get_by_test_id('photo-product-pick-combo')
        expect(product.get_by_test_id('product-add')).to_have_accessible_name('Добавить в корзину: 4 190 ₸')
        product.get_by_test_id('photo-nutrition-open').click()
        expect(page.get_by_test_id('photo-nutrition-dialog')).to_contain_text('1240')
        page.get_by_role('button', name='Закрыть окно пищевой ценности', exact=True).click()
        expect(product.get_by_text(CATALOG['products'][0]['description'], exact=True)).to_be_visible()
        product.get_by_test_id('photo-replace-drink-0').click()
        page.get_by_test_id('photo-option-lemonade').click()
        page.get_by_test_id('photo-replacement-apply').click()
        expect(product.get_by_test_id('product-add')).to_have_accessible_name('Добавить в корзину: 4 390 ₸')
        page.screenshot(path=str(OUTPUT / f'combo-drinks-{width}.png'))
        expect(product.get_by_test_id('photo-extras-track').locator('[data-testid^="photo-extra-"]')).to_have_count(8)
        expect(product.get_by_test_id('photo-extra-sauce')).to_have_count(0)
        expect(product.get_by_test_id('photo-extra-large-sauce')).to_contain_text('300 мл')
        product.get_by_test_id('photo-extra-toast').get_by_role('button', name='Увеличить:', exact=False).click()
        expect(product.get_by_test_id('product-add')).to_have_accessible_name('Добавить в корзину: 4 780 ₸')
        product.get_by_test_id('photo-extra-toast').get_by_role('button', name='Уменьшить:', exact=False).click()
        expect(product.get_by_test_id('product-add')).to_have_accessible_name('Добавить в корзину: 4 390 ₸')
        product.get_by_test_id('photo-extra-toast').get_by_role('button', name='Увеличить:', exact=False).click()
        fixed_footer(page, 'product-add', 'photo-product-scroll', height)
        page.screenshot(path=str(OUTPUT / f'combo-{width}.png'))
        product.get_by_test_id('product-add').click()
        wait_saved_lines(page, 1)
        assert selected_set(saved(page)['lines'][0]) == CUSTOM_SELECTIONS
        page.goto(URL + '/menu')
        page.get_by_test_id('product-pick-combo').click()
        expect(page.get_by_test_id('product-add')).to_have_accessible_name('Добавить в корзину: 4 190 ₸')
        page.get_by_test_id('product-add').click()
        expect(page.get_by_test_id('screen-M09')).not_to_be_visible()
        page.get_by_test_id('open-cart').click()
        cart = page.get_by_test_id('screen-M09')
        expect(cart.get_by_test_id('cart-quantity-pick-combo')).to_have_count(2)
        wait_saved_lines(page, 2)
        variants = saved(page)['lines']
        assert {frozenset(selected_set(line)) for line in variants} == {
            frozenset(BASE_SELECTIONS), frozenset(CUSTOM_SELECTIONS)}
        assert all(line['quantity'] == 1 for line in variants)
        cart.get_by_test_id('cart-plus-pick-combo').first.click()
        page.wait_for_function('(key) => JSON.parse(localStorage.getItem(key)).lines[0].quantity === 2', arg=PREFERENCES)
        assert [line['quantity'] for line in saved(page)['lines']] == [2, 1]
        cart.get_by_test_id('cart-minus-pick-combo').first.click()
        page.wait_for_function('(key) => JSON.parse(localStorage.getItem(key)).lines[0].quantity === 1', arg=PREFERENCES)
        expect(cart.get_by_text('Акции', exact=True)).to_be_visible()
        expect(cart.get_by_test_id('cart-promo-open')).to_be_visible()
        assert cart.get_by_text('Тестовый контур', exact=False).count() == 0
        page.get_by_test_id('scroll-M09').evaluate('(e) => { e.scrollTop = 0; }')
        page.screenshot(path=str(OUTPUT / f'cart-{width}.png'))
        fixed_footer(page, 'cart-checkout', 'scroll-M09', height)
        page.screenshot(path=str(OUTPUT / f'cart-footer-{width}.png'))
        preferences = saved(page)
        page.reload()
        expect(page.get_by_test_id('cart-quantity-pick-combo')).to_have_count(2)
        wait_saved_lines(page, 2)
        assert saved(page) == preferences
        page.get_by_test_id('cart-checkout').click()
        checkout = page.get_by_test_id('screen-M12')
        expect(checkout.get_by_test_id('checkout-apple-pay')).to_contain_text('СКОРО')
        expect(checkout.get_by_test_id('checkout-add-card')).to_have_attribute('aria-disabled','true')
        expect(checkout.get_by_test_id('checkout-add-card')).to_contain_text('СКОРО')
        expect(checkout.get_by_test_id('test-checkout-create')).to_be_enabled()
        with page.expect_response(lambda response: urlparse(response.url).path == '/v1/test/quotes'):
            checkout.get_by_test_id('test-checkout-create').click()
        page.wait_for_function('(key) => !!localStorage.getItem(key)', arg=DRAFT)
        expect(checkout.get_by_test_id('test-checkout-create')).to_be_enabled()
        expect(checkout.get_by_text('Не удалось обновить', exact=True)).to_have_count(0)
        # Failed quote state remains durable and retryable without a technical banner.
        expect(checkout.get_by_text(re.compile('^Статус проверен в '))).to_have_count(0)
        expect(checkout.get_by_test_id('test-checkout-create')).to_be_enabled()
        expect(checkout.get_by_text('Не удалось обновить', exact=True)).to_have_count(0)
        assert len(fixture.quotes) == 1
        quote = fixture.quotes[0]
        payload = node_module('contracts.js', 'module.TestCompleteCartSchema.parse(input)', quote['payload'])
        assert payload['catalog_version'] == 'mockup-v0.3' and payload['payment_method'] == 'kaspi'
        assert len(payload['items']) == 2
        variants = [line for line in payload['items'] if line['product_id'] == 'pick-combo']
        assert {frozenset(selected_set(line)) for line in variants} == {
            frozenset(BASE_SELECTIONS), frozenset(CUSTOM_SELECTIONS)}
        assert quote['authorization'] == 'Bearer ' + SESSION['token']
        pending = saved(page, DRAFT)
        assert pending['payload'] == payload and pending['quoteKey'] == quote['key']
        session = saved(page, SESSION_KEY)
        page.reload()
        expect(checkout.get_by_test_id('test-checkout-create')).to_be_enabled()
        assert saved(page, DRAFT) == pending and saved(page, SESSION_KEY) == session
        with page.expect_response(lambda response: urlparse(response.url).path == '/v1/test/quotes'):
            checkout.get_by_test_id('test-checkout-create').click()
        expect(checkout.get_by_test_id('test-checkout-create')).to_be_enabled()
        expect(checkout.get_by_text('Не удалось обновить', exact=True)).to_have_count(0)
        assert len(fixture.quotes) == 2 and fixture.quotes[0] == fixture.quotes[1]
        assert saved(page, DRAFT) == pending
        assert not fixture.violations, fixture.violations
        assert not errors, errors
        results.append({'viewport': f'{width}x{height}', 'catalog_products': 24,
                        'category_switches': 13, 'variants_preserved': 2,
                        'quote_payload_and_retry': True, 'mountain_peak': peak})
        context.close()
    browser.close()

result = {'success': True, 'fixture_only': True, 'orders_created': 0,
          'payment_requests': 0, 'checks': results}
(OUTPUT / 'verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps(result, ensure_ascii=False))
