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
        self.lose_create = False
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
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.contexts = []

    def tearDown(self):
        for context, page, fixture, errors in self.contexts:
            if errors or fixture.unexpected:
                page.screenshot(path=str(OUTPUT / 'failure.png'))
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

    def cart(self, page):
        element(page, 'kiosk-menu-checkout').click()
        screen(page, 'upsell')
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
                page.screenshot(path=str(OUTPUT / f'welcome-{width}.png'))
                element(page, 'kiosk-start').click()
                screen(page, 'mode')
                here = assert_bounded(page, 'kiosk-mode-dine-in', width, height)
                take = assert_bounded(page, 'kiosk-mode-takeaway', width, height)
                self.assertGreaterEqual(take['y'], here['y'] + here['height'] - 1,
                                        'Original portrait layout has vertically stacked choices')
                page.screenshot(path=str(OUTPUT / f'mode-{width}.png'))
                element(page, 'kiosk-mode-takeaway').click()
                screen(page, 'menu')
                for category in ['combo', 'duo', 'sets', 'extras', 'combo']:
                    chip = element(page, 'kiosk-category-' + category)
                    chip.click()
                    assert_bounded(page, 'kiosk-category-' + category, width, height)
                self.assertTrue(element(page, 'kiosk-menu-checkout').is_disabled())
                fixed_action(page, 'kiosk-menu-checkout', 'kiosk-menu-scroll', width, height)
                element(page, 'kiosk-menu-scroll').evaluate('(e) => {e.scrollTop = 0;}')
                page.screenshot(path=str(OUTPUT / f'menu-{width}.png'))
                element(page, 'kiosk-product-pick-combo').click()
                screen(page, 'product')
                expect(element(page, 'kiosk-product-nutrition')).to_contain_text('1240')
                element(page, 'kiosk-modifier-drink-lemonade').click()
                element(page, 'kiosk-modifier-plus-extras-toast').click()
                expect(element(page, 'kiosk-product-add')).to_contain_text('4 780')
                fixed_action(page, 'kiosk-product-add', 'kiosk-product-scroll', width, height)
                page.screenshot(path=str(OUTPUT / f'product-{width}.png'))
                element(page, 'kiosk-product-add').click()
                screen(page, 'menu')
                self.add(page)
                self.cart(page)
                page.screenshot(path=str(OUTPUT / f'cart-{width}.png'))
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
                page.screenshot(path=str(OUTPUT / f'payment-{width}.png'))
                element(page, 'kiosk-payment-approve').click()
                screen(page, 'order')
                expect(element(page, 'kiosk-order-number')).to_have_text(order['number'])
                assert_bounded(page, 'kiosk-next-guest', width, height)
                page.screenshot(path=str(OUTPUT / f'number-{width}.png'))
                element(page, 'kiosk-next-guest').click()
                screen(page, 'welcome')
                self.start(page)
                self.assertTrue(element(page, 'kiosk-menu-checkout').is_disabled())
                self.assertEqual(fixture.orders[order['order_id']]['state'], 'preparing')
                self.assertEqual(len(fixture.orders), 1)
                assert_no_overflow(page, width)

    def test_lost_create_response_reuses_original_command_after_reload(self):
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
        self.assertGreaterEqual(len(creates), 2, 'Retry must exercise persisted create command')
        self.assertEqual(len({r['key'] for r in creates}), 1)
        self.assertTrue(all(r['body'] == creates[0]['body'] for r in creates))
        self.assertEqual(list(fixture.orders), [order_id])
        self.assertEqual(len(fixture.sessions), 1)
        page.screenshot(path=str(OUTPUT / 'restored-create.png'))

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
        page.screenshot(path=str(OUTPUT / 'unknown-after-reload.png'))
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
