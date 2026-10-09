"""Native kiosk's exported web UI; every API request stays in a local fixture.

Build the shared catalog and export apps/kiosk before running with the design
Playwright venv. This exercises real controller/persistence and deliberately
does not seed guest storage. No VPS, bank, fiscal or SMS requests are sent.
"""
import copy
import json
import os
import re
import subprocess
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


URL = os.environ.get('KIOSK_UI_URL', 'http://127.0.0.1:4184').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost'), 'Use a local exported kiosk'
ROOT = Path(os.environ.get('PICKCHICK_TEST_SOURCE_ROOT', Path(__file__).resolve().parents[2]))
OUTPUT = Path(os.environ.get('KIOSK_UI_OUTPUT', '.local/kiosk-ui'))
PACKAGE = ROOT / 'packages/test-order-flow/dist'
FLOW_KEY = 'pickchick.kiosk.guest-flow.v1'
SESSION_KEY = 'pickchick.kiosk.guest-session.v1'
META = {'synthetic': True, 'namespace': 'pickchick-test'}


def node_module(filename, expression, payload=None):
    code = ('import {pathToFileURL} from "node:url"; import {readFileSync} from "node:fs"; '
            'const module = await import(pathToFileURL(process.argv[1]).href); '
            'const input = JSON.parse(readFileSync(0,"utf8")); '
            'process.stdout.write(JSON.stringify(' + expression + '));')
    result = subprocess.run(['node', '--input-type=module', '-e', code, str(PACKAGE / filename)],
                            input=json.dumps(payload), capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def timestamp(delta=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=delta)).isoformat().replace('+00:00', 'Z')


def line_id(product_id, selections):
    parts = sorted(f"{s['group_id']}:{s['option_id']}:{s['quantity']}" for s in selections)
    return product_id + ('|' + ','.join(parts) if parts else '')


def selection_set(line):
    return {(s['group_id'], s['option_id'], s['quantity']) for s in line['selections']}


def element(page, identifier):
    return page.get_by_test_id(identifier).filter(visible=True)


def screen(page, name):
    expect(element(page, 'kiosk-screen-' + name)).to_be_visible(timeout=20000)


def stored(page, key):
    return page.evaluate('(key) => JSON.parse(localStorage.getItem(key) || "null")', key)


def assert_bounded(page, identifier, width, height, minimum=44):
    target = element(page, identifier)
    expect(target).to_be_visible()
    rect = target.bounding_box()
    assert rect and rect['width'] >= minimum and rect['height'] >= minimum, (identifier, rect)
    assert rect['x'] >= -1 and rect['y'] >= -1, (identifier, rect)
    assert rect['x'] + rect['width'] <= width + 1, (identifier, rect)
    assert rect['y'] + rect['height'] <= height + 1, (identifier, rect)
    return rect


def capture(page, filename):
    # Screen visibility precedes Expo Image decoding after a navigation. Capture
    # only after visible images are decoded, so blank loading frames cannot pass
    # as visual evidence. Broken visible assets fail instead of being hidden.
    page.evaluate('() => document.fonts.ready')
    page.wait_for_function("""() => [...document.images].filter(image => {
        const r = image.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
            r.top < innerHeight && r.left < innerWidth;
    }).every(image => image.complete && image.naturalWidth > 0)""")
    page.evaluate('''async () => {
        await Promise.all([...document.images].filter(image => image.complete && image.naturalWidth)
            .map(image => image.decode()));
        await Promise.all(document.getAnimations().filter(animation => {
            const timing = animation.effect?.getComputedTiming();
            return animation.playState === 'running' && timing && Number.isFinite(timing.iterations);
        }).map(animation => animation.finished.catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }''')
    page.screenshot(path=str(OUTPUT / filename))


def assert_no_overflow(page, width):
    geometry = page.evaluate('''() => ({viewport: innerWidth,
        document: document.documentElement.scrollWidth, body: document.body.scrollWidth})''')
    assert geometry['viewport'] == width, geometry
    assert max(geometry['document'], geometry['body']) <= width + 1, geometry


def fixed_action(page, action_id, scroller_id, width, height):
    before = assert_bounded(page, action_id, width, height)
    scroll = element(page, scroller_id)
    scroll.evaluate('(e) => {e.scrollTop = e.scrollHeight;}')
    after = assert_bounded(page, action_id, width, height)
    assert abs(before['y'] - after['y']) <= 1, (action_id, before, after)
    assert_no_overflow(page, width)


class Fixture:
    """Deterministic behavior double, not a substitute for backend acceptance."""

    def __init__(self, catalog):
        self.catalog = copy.deepcopy(catalog)
        self.sessions = {}
        self.orders = {}
        self.order_owners = {}
        self.quotes = {}
        self.commands = {}
        self.requests = []
        self.unexpected = []
        self.entrypoints = set()
        self.lose_create = False
        self.drop_create_request = False
        self.block_order_reads = False

    def quote(self, body):
        node_module('contracts.js', 'module.TestCompleteCartSchema.parse(input)', body)
        assert body['catalog_version'] == 'mockup-v0.3'
        products = {p['id']: p for p in self.catalog['products']}
        lines = []
        for item in body['items']:
            product = products[item['product_id']]
            groups = {g['id']: g for g in product['modifier_groups']}
            selections = []
            for selected in item['selections']:
                group = groups[selected['group_id']]
                option = next(o for o in group['options'] if o['id'] == selected['option_id'])
                assert option['available'] and selected['quantity'] <= option['max_quantity']
                selections.append({**selected, 'group_label': group['title'],
                                   'option_label': option['label'],
                                   'price_delta_minor': option['price_delta_minor']})
            for group in groups.values():
                count = sum(s['quantity'] for s in selections if s['group_id'] == group['id'])
                assert group['min'] <= count <= group['max'], (group['id'], count)
            unit = int(product['price_minor']) + sum(
                int(s['price_delta_minor']) * s['quantity'] for s in selections)
            names = ['id', 'name', 'description', 'category', 'image_id', 'prep_required',
                     'serving_label', 'nutrition', 'nutrition_provenance']
            lines.append({**{key: product[key] for key in names},
                          'base_price_minor': product['price_minor'], 'price_minor': str(unit),
                          'quantity': item['quantity'], 'line_total_minor': str(unit * item['quantity']),
                          'selections': selections, 'line_id': line_id(product['id'], selections)})
        result = {**META, 'quote_id': str(uuid4()), 'branch_id': self.catalog['branch_id'],
                  'catalog_version': 'mockup-v0.3', 'channel': 'kiosk',
                  'service_mode': body['service_mode'], 'payment_method': body['payment_method'],
                  'currency': 'KZT', 'total_minor': str(sum(int(l['line_total_minor']) for l in lines)),
                  'lines': lines, 'estimated_minutes': self.catalog['estimated_minutes'],
                  'created_at': timestamp(), 'expires_at': timestamp(300)}
        return node_module('contracts.js', 'module.TestCompleteQuoteSchema.parse(input)', result)

    def resolve(self, order_id, outcome):
        old = self.orders[order_id]
        assert old['payment_state'] == 'simulated_unknown'
        self.orders[order_id] = {**old, 'version': old['version'] + 1,
                                 'payment_state': 'simulated_' + outcome,
                                 'state': 'preparing' if outcome == 'approved' else 'awaiting_test_payment',
                                 'updated_at': timestamp()}

    def route(self, route):
        request = route.request
        parsed = urlparse(request.url)
        if not parsed.path.startswith('/v1/'):
            if re.fullmatch(r'/_expo/static/js/web/index-[a-f0-9]+\.js', parsed.path):
                self.entrypoints.add(parsed.path)
            if parsed.netloc == urlparse(URL).netloc or parsed.scheme in ('data', 'blob'):
                route.continue_()
            else:
                self.unexpected.append((request.method, parsed.netloc, parsed.path))
                route.abort('blockedbyclient')
            return
        allowed = (parsed.path == '/v1/capabilities' or re.fullmatch(
            r'/v1/test/(catalog|sessions|quotes|orders(?:/[a-f0-9-]{36}(?:/(simulated-payment|cancel))?)?)',
            parsed.path))
        if not allowed:
            self.unexpected.append((request.method, parsed.netloc, parsed.path))
            route.abort('blockedbyclient')
            return
        headers = {'Access-Control-Allow-Origin': '*',
                   'Access-Control-Allow-Headers': 'Authorization,Content-Type,Idempotency-Key',
                   'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'}
        if request.method == 'OPTIONS':
            route.fulfill(status=204, headers=headers)
            return
        body = request.post_data_json if request.post_data else None
        path = parsed.path
        key = request.headers.get('idempotency-key')
        token = request.headers.get('authorization', '').removeprefix('Bearer ')
        self.requests.append({'method': request.method, 'path': path,
                              'body': copy.deepcopy(body), 'key': key})
        status, value, drop = 200, None, False
        if request.method == 'GET' and path == '/v1/capabilities':
            value = {'schema_version': 1, 'environment': 'staging', 'data_mode': 'synthetic',
                     'ordering_enabled': False, 'features': {'test_order_flow': True,
                     **{name: False for name in ['phone_auth', 'payments', 'fiscal', 'checkout', 'loyalty']}}}
        elif request.method == 'GET' and path == '/v1/test/catalog':
            assert parse_qs(parsed.query).get('catalog_version') == ['mockup-v0.3']
            value = self.catalog
        elif request.method == 'POST' and path == '/v1/test/sessions':
            assert body == {'channel': 'kiosk'}
            token = format(len(self.sessions) + 1, '064x')
            value = {**META, 'session_id': str(uuid4()), 'token': token, 'channel': 'kiosk',
                     'expires_at': '9999-12-31T23:59:59.999Z'}
            self.sessions[token] = value
        elif token not in self.sessions:
            status, value = 401, {'code': 'UNAUTHORIZED'}
        elif request.method == 'GET' and path.startswith('/v1/test/orders'):
            if self.block_order_reads:
                route.abort('failed')
                return
            if path == '/v1/test/orders':
                value = {**META, 'orders': [order for oid, order in self.orders.items()
                                            if self.order_owners[oid] == token]}
            else:
                oid = path.rsplit('/', 1)[1]
                assert self.order_owners[oid] == token
                value = self.orders[oid]
        elif request.method == 'POST':
            assert key, (path, 'Every durable command needs its original key')
            command = (token, key)
            prior = self.commands.get(command)
            if prior:
                assert prior[:2] == (path, body), 'Replayed key must keep the exact command'
                value = copy.deepcopy(prior[2])
            elif path == '/v1/test/quotes':
                value = self.quote(body)
                self.quotes[value['quote_id']] = value
            elif path == '/v1/test/orders':
                if self.drop_create_request:
                    self.drop_create_request = False
                    route.abort('failed')
                    return
                node_module('contracts.js', 'module.TestCreateOrderSchema.parse(input)', body)
                value = {**META, 'order_id': str(uuid4()), 'number': f'T-{900001 + len(self.orders):06}',
                         'branch_id': self.catalog['branch_id'], 'version': 1,
                         'state': 'awaiting_test_payment', 'payment_state': 'not_started',
                         'payment_attempt_id': None, 'fiscal_state': 'not_applicable',
                         'snapshot': self.quotes[body['quote_id']], 'tasks': [],
                         'created_at': timestamp(), 'updated_at': timestamp(), 'cancellation_reason': None}
                node_module('contracts.js', 'module.TestOrderSchema.parse(input)', value)
                self.orders[value['order_id']] = value
                self.order_owners[value['order_id']] = token
                drop, self.lose_create = self.lose_create, False
            elif path.endswith('/simulated-payment') or path.endswith('/cancel'):
                oid = path.split('/')[-2]
                assert self.order_owners[oid] == token
                old = self.orders[oid]
                assert old['version'] == body['expected_version']
                assert old['payment_state'] != 'simulated_unknown'
                if path.endswith('/simulated-payment'):
                    node_module('contracts.js', 'module.TestPaymentSchema.parse(input)', body)
                    assert old['state'] == 'awaiting_test_payment'
                    value = {**old, 'version': old['version'] + 1, 'updated_at': timestamp(),
                             'payment_attempt_id': str(uuid4()),
                             'payment_state': 'simulated_' + body['outcome'],
                             'state': 'preparing' if body['outcome'] == 'approved' else 'awaiting_test_payment'}
                else:
                    node_module('contracts.js', 'module.TestCancellationSchema.parse(input)', body)
                    value = {**old, 'version': old['version'] + 1, 'updated_at': timestamp(),
                             'state': 'cancelled', 'cancellation_reason': body['reason']}
                self.orders[oid] = value
            else:
                self.unexpected.append((request.method, path))
                route.abort('blockedbyclient')
                return
            self.commands[command] = (path, copy.deepcopy(body), copy.deepcopy(value))
        else:
            self.unexpected.append((request.method, path))
            route.abort('blockedbyclient')
            return
        if drop:
            route.abort('failed')
        else:
            route.fulfill(status=status, json=value, headers=headers)


class KioskUI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = node_module('complete-catalog.js', 'module.testCompleteCatalog')
        assert cls.catalog['catalog_version'] == 'mockup-v0.3'
        assert len(cls.catalog['products']) == 24
        OUTPUT.mkdir(parents=True, exist_ok=True)
        cls.entrypoints = set()
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        version = cls.browser.version
        cls.browser.close()
        cls.playwright.stop()
        (OUTPUT / 'runtime-entrypoints.json').write_text(json.dumps({
            'browser': version, 'entrypoints': sorted(cls.entrypoints),
            'capture_mode': 'exported web UI with local API fixtures',
        }, indent=2) + '\n')
        assert len(cls.entrypoints) == 1, 'Export changed during the run; repeat against one stable bundle'

    def setUp(self):
        self.contexts = []

    def tearDown(self):
        result = self._outcome.result
        failed = any(test is self for test, _ in result.failures + result.errors)
        for index, (context, page, fixture, errors) in enumerate(self.contexts):
            self.entrypoints.update(fixture.entrypoints)
            if failed or errors or fixture.unexpected:
                name = f'failure-{self._testMethodName}-{index}'
                page.screenshot(path=str(OUTPUT / (name + '.png')))
                (OUTPUT / (name + '.json')).write_text(json.dumps({
                    'visible_text': page.locator('body').inner_text(),
                    'entrypoints': sorted(fixture.entrypoints),
                    'page_errors': errors,
                    'unexpected_requests': fixture.unexpected,
                }, ensure_ascii=False, indent=2) + '\n')
            context.close()
            self.assertEqual(errors, [])
            self.assertEqual(fixture.unexpected, [], 'Unexpected requests were blocked')

    def open(self, width=820, height=1180):
        context = self.browser.new_context(viewport={'width': width, 'height': height},
                                           reduced_motion='reduce')
        fixture = Fixture(self.catalog)
        context.route('**/*', fixture.route)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        self.contexts.append((context, page, fixture, errors))
        page.goto(URL)
        screen(page, 'welcome')
        return page, fixture

    def start(self, page):
        element(page, 'kiosk-start').click()
        screen(page, 'mode')
        element(page, 'kiosk-mode-takeaway').click()
        screen(page, 'menu')

    def add(self, page):
        element(page, 'kiosk-product-pick-combo').click()
        screen(page, 'product')
        element(page, 'kiosk-product-add').click()
        screen(page, 'menu')

    def cart(self, page, capture_name=None):
        element(page, 'kiosk-menu-checkout').click()
        screen(page, 'upsell')
        if capture_name:
            capture(page, capture_name)
        element(page, 'kiosk-upsell-continue').click()
        screen(page, 'cart')

    def review(self, page):
        self.cart(page)
        element(page, 'kiosk-cart-checkout').click()
        screen(page, 'loyalty')

    def test_three_ipad_sizes_configuration_fixed_actions_and_reset(self):
        base = {('drink', 'cola-bottle', 1), ('sauce', 'pick', 1)}
        custom = {('drink', 'lemonade', 1), ('sauce', 'pick', 1), ('extras', 'toast', 1)}
        for width, height in [(768, 1024), (820, 1180), (1024, 1366)]:
            with self.subTest(width=width, height=height):
                page, fixture = self.open(width, height)
                assert_bounded(page, 'kiosk-start', width, height)
                self.assertEqual(page.locator('video[controls]').count(), 0)
                self.assertEqual(page.get_by_test_id('hero-video-toggle').count(), 0)
                capture(page, f'welcome-{width}.png')
                element(page, 'kiosk-start').click()
                screen(page, 'mode')
                here = assert_bounded(page, 'kiosk-mode-dine-in', width, height)
                take = assert_bounded(page, 'kiosk-mode-takeaway', width, height)
                self.assertGreaterEqual(take['y'], here['y'] + here['height'] - 1,
                                        'Original portrait layout has vertically stacked choices')
                # Expo Image mounts its actual img nodes after the screen View.
                # Do not accept a visually empty card before those nodes exist.
                for choice in ['dine-in', 'takeaway']:
                    images = element(page, 'kiosk-mode-' + choice).locator('img')
                    expect(images).to_have_count(2)
                    for image in images.all():
                        expect(image).to_be_visible()
                capture(page, f'mode-{width}.png')
                element(page, 'kiosk-mode-takeaway').click()
                screen(page, 'menu')
                for category in ['combo', 'duo', 'sets', 'extras', 'combo']:
                    chip = element(page, 'kiosk-category-' + category)
                    chip.click()
                    assert_bounded(page, 'kiosk-category-' + category, width, height)
                self.assertTrue(element(page, 'kiosk-menu-checkout').is_disabled())
                fixed_action(page, 'kiosk-menu-checkout', 'kiosk-menu-scroll', width, height)
                element(page, 'kiosk-menu-scroll').evaluate('(e) => {e.scrollTop = 0;}')
                capture(page, f'menu-{width}.png')
                element(page, 'kiosk-product-pick-combo').click()
                screen(page, 'product')
                capture(page, f'product-top-{width}.png')
                expect(element(page, 'kiosk-product-nutrition')).to_contain_text('1240')
                element(page, 'kiosk-modifier-expand-drink').click()
                sheet = element(page, 'kiosk-drinks-sheet')
                expect(sheet).to_be_visible()
                # The last native choice remains reachable above the fixed Done action.
                product = next(p for p in self.catalog['products'] if p['id'] == 'pick-combo')
                group = next(g for g in product['modifier_groups'] if g['id'] == 'drink')
                last_option = sheet.get_by_test_id('kiosk-modifier-drink-' + group['options'][-1]['id'])
                last_option.scroll_into_view_if_needed()
                expect(last_option).to_be_in_viewport()
                assert_bounded(page, 'kiosk-drinks-done', width, height)
                capture(page, f'drinks-sheet-{width}.png')
                element(page, 'kiosk-drinks-done').click()
                expect(sheet).not_to_be_visible()
                expect(element(page, 'kiosk-product-add')).to_contain_text('4 190')
                element(page, 'kiosk-modifier-drink-lemonade').click()
                element(page, 'kiosk-modifier-plus-extras-toast').click()
                expect(element(page, 'kiosk-product-add')).to_contain_text('4 780')
                fixed_action(page, 'kiosk-product-add', 'kiosk-product-scroll', width, height)
                capture(page, f'product-{width}.png')
                element(page, 'kiosk-product-add').click()
                screen(page, 'menu')
                self.add(page)
                self.cart(page, f'upsell-{width}.png')
                capture(page, f'cart-{width}.png')
                self.assertFalse(element(page, 'kiosk-cart-checkout').is_disabled())
                assert_bounded(page, 'kiosk-cart-checkout', width, height)
                page.reload()
                screen(page, 'menu')
                self.cart(page)
                element(page, 'kiosk-cart-checkout').click()
                screen(page, 'loyalty')
                element(page, 'kiosk-payment-method-card').click()
                element(page, 'kiosk-review-create').click()
                screen(page, 'payment')
                self.assertEqual(len(fixture.orders), 1)
                order = next(iter(fixture.orders.values()))
                self.assertEqual(order['snapshot']['payment_method'], 'card')
                self.assertEqual(order['snapshot']['service_mode'], 'takeaway')
                self.assertEqual(len(order['snapshot']['lines']), 2)
                self.assertEqual({frozenset(selection_set(line)) for line in order['snapshot']['lines']},
                                 {frozenset(base), frozenset(custom)})
                self.assertEqual(order['snapshot']['total_minor'], '897000')
                capture(page, f'payment-{width}.png')
                element(page, 'kiosk-payment-approve').click()
                screen(page, 'order')
                expect(element(page, 'kiosk-order-number')).to_have_text(order['number'])
                assert_bounded(page, 'kiosk-next-guest', width, height)
                capture(page, f'number-{width}.png')
                element(page, 'kiosk-next-guest').click()
                screen(page, 'welcome')
                self.start(page)
                self.assertTrue(element(page, 'kiosk-menu-checkout').is_disabled())
                self.assertEqual(fixture.orders[order['order_id']]['state'], 'preparing')
                self.assertEqual(len(fixture.orders), 1)
                assert_no_overflow(page, width)

    def test_compact_upsell_cards_add_to_cart_without_creating_order(self):
        page, fixture = self.open(1024, 1366)
        self.start(page)
        self.add(page)
        element(page, 'kiosk-menu-checkout').click()
        screen(page, 'upsell')
        for product_id in self.catalog['upsell_product_ids']:
            assert_bounded(page, 'kiosk-upsell-' + product_id, 1024, 1366)
        assert_bounded(page, 'kiosk-upsell-continue', 1024, 1366)
        element(page, 'kiosk-upsell-toast').click()
        screen(page, 'upsell')
        element(page, 'kiosk-upsell-continue').click()
        screen(page, 'cart')
        expect(element(page, 'kiosk-cart-line-toast-quantity')).to_have_text('1')
        cart = stored(page, FLOW_KEY)['cart']
        self.assertEqual(len(cart), 2)
        self.assertEqual({line['productId'] for line in cart}, {'pick-combo', 'toast'})
        self.assertEqual(len(fixture.orders), 0)
        self.assertEqual(len(fixture.sessions), 0, 'Browse/upsell must not allocate an ordering identity')
        capture(page, 'cart-with-upsell.png')

    def test_menu_restores_category_and_offset_after_product_close(self):
        page, fixture = self.open()
        self.start(page)
        selected = element(page, 'kiosk-category-extras')
        selected.click()
        expect(selected).to_have_attribute('aria-selected', 'true')
        scroller = element(page, 'kiosk-menu-scroll')
        product = element(page, 'kiosk-product-piko')
        product.scroll_into_view_if_needed()
        # Use actual UI scrolling; do not seed navigation memory or storage.
        capture(page, 'extras-before-product.png')
        offset = scroller.evaluate('(e) => e.scrollTop')
        self.assertGreater(offset, 500, 'This must exercise a scrolled category')
        product.click()
        screen(page, 'product')
        element(page, 'kiosk-product-close').click()
        screen(page, 'menu')
        expect(element(page, 'kiosk-category-extras')).to_have_attribute('aria-selected', 'true')
        page.wait_for_function("""(offset) => Math.abs(
            document.querySelector('[data-testid="kiosk-menu-scroll"]').scrollTop - offset) <= 2""", arg=offset)
        self.assertTrue(product.is_visible())
        assert_bounded(page, 'kiosk-menu-checkout', 820, 1180)
        self.assertEqual(len(fixture.orders), 0)
        capture(page, 'extras-restored-after-product.png')

    def test_lost_create_response_reconciles_committed_order_after_reload(self):
        page, fixture = self.open()
        self.start(page)
        self.add(page)
        self.review(page)
        fixture.lose_create = True
        fixture.block_order_reads = True
        element(page, 'kiosk-review-create').click()
        screen(page, 'recovery')
        self.assertEqual(len(fixture.orders), 1)
        order_id = next(iter(fixture.orders))
        page.reload()
        screen(page, 'recovery')
        fixture.block_order_reads = False
        element(page, 'kiosk-payment-retry').click()
        screen(page, 'payment')
        creates = [r for r in fixture.requests if r['method'] == 'POST' and r['path'] == '/v1/test/orders']
        self.assertEqual(len(creates), 1, 'A committed order must be observed without another creation')
        self.assertEqual(stored(page, FLOW_KEY)['order']['order_id'], order_id)
        self.assertIsNone(stored(page, FLOW_KEY)['pending'])
        self.assertEqual(list(fixture.orders), [order_id])
        self.assertEqual(len(fixture.sessions), 1)
        capture(page, 'restored-create.png')

    def test_lost_create_request_replays_original_command_after_reload(self):
        page, fixture = self.open()
        self.start(page)
        self.add(page)
        self.review(page)
        fixture.drop_create_request = True
        element(page, 'kiosk-review-create').click()
        screen(page, 'recovery')
        self.assertEqual(len(fixture.orders), 0)
        pending = stored(page, FLOW_KEY)['pending']
        self.assertEqual(pending['kind'], 'create')
        page.reload()
        screen(page, 'recovery')
        self.assertEqual(stored(page, FLOW_KEY)['pending'], pending)
        element(page, 'kiosk-payment-retry').click()
        screen(page, 'payment')
        creates = [r for r in fixture.requests if r['method'] == 'POST' and r['path'] == '/v1/test/orders']
        self.assertEqual(len(creates), 2, 'Lost request must replay exactly once from durable intent')
        self.assertEqual({r['key'] for r in creates}, {pending['orderKey']})
        self.assertTrue(all(r['body'] == {'quote_id': pending['quoteId']} for r in creates))
        self.assertEqual(len(fixture.quotes), 1)
        self.assertEqual(len(fixture.orders), 1)
        self.assertEqual(len(fixture.sessions), 1)
        self.assertIsNone(stored(page, FLOW_KEY)['pending'])
        capture(page, 'replayed-create.png')

    def test_unknown_payment_preserves_guest_until_authoritative_recovery(self):
        page, fixture = self.open()
        self.start(page)
        self.add(page)
        self.review(page)
        element(page, 'kiosk-review-create').click()
        screen(page, 'payment')
        element(page, 'kiosk-payment-unknown').click()
        screen(page, 'recovery')
        order_id = next(iter(fixture.orders))
        self.assertEqual(fixture.orders[order_id]['payment_state'], 'simulated_unknown')
        guest = stored(page, SESSION_KEY)
        for identifier in ['kiosk-next-guest', 'kiosk-cancel-confirm', 'kiosk-payment-approve']:
            target = element(page, identifier)
            self.assertTrue(target.count() == 0 or target.is_disabled(), identifier)
        page.reload()
        screen(page, 'recovery')
        self.assertEqual(stored(page, SESSION_KEY), guest)
        self.assertEqual(len(fixture.sessions), 1)
        self.assertEqual(len(fixture.orders), 1)
        capture(page, 'unknown-after-reload.png')
        # Represents a later trusted backend observation; no manager API is called.
        fixture.resolve(order_id, 'approved')
        element(page, 'kiosk-payment-retry').click()
        screen(page, 'order')
        expect(element(page, 'kiosk-order-number')).to_have_text(fixture.orders[order_id]['number'])
        element(page, 'kiosk-next-guest').click()
        screen(page, 'welcome')
        self.assertEqual(len(fixture.orders), 1)
        payments = [r for r in fixture.requests if r['path'].endswith('/simulated-payment')]
        self.assertEqual(len(payments), 1, 'Recovery must not initiate another payment')


if __name__ == '__main__':
    unittest.main(verbosity=2)
