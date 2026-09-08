"""Staff chrome and public display regressions using an isolated HTTP double.

Build operations, then run with the pinned Playwright Python environment. An
optional OPS_RECOVERY_URL must be loopback; otherwise this test serves dist.
Only synthetic fixture keys are entered through the normal staff login form.
No VPS requests, real credentials, order commands or sessionStorage injection.
"""
import copy
import json
import os
import re
import threading
import unittest
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
DIST = Path(os.environ.get('OPS_DIST', ROOT / 'apps/operations/dist'))
PREVIEW = os.environ.get('OPS_RECOVERY_URL', '').rstrip('/')
if PREVIEW:
    assert urlparse(PREVIEW).hostname in ('127.0.0.1', 'localhost'), 'Use a loopback preview'
OUTPUT = ROOT / '.local/operations-display'
SYNTHETIC = {'synthetic': True, 'namespace': 'pickchick-test'}
BRANCH = '10000000-0000-4000-8000-000000000003'
TOKENS = {role: char * 64 for role, char in zip(('prep', 'assembly', 'display', 'manager'), 'abcd')}
PATHS = {'prep': '/kitchen/prep', 'assembly': '/kitchen/assembly',
         'display': '/display', 'manager': '/manager'}


def timestamp():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


class Fixture:
    def __init__(self):
        self.requests = []
        self.violations = []
        self.display_status = 200
        self.set_orders(['T-900001'], ['T-900002'])

    def set_orders(self, preparing, ready):
        self.display = {
            **SYNTHETIC, 'branch_id': BRANCH, 'observed_at': timestamp(),
            'preparing': [{'number': number, 'channel': 'kiosk'} for number in preparing],
            'ready': [{'number': number, 'channel': 'mobile'} for number in ready],
        }

    def handle(self, method, path, authorization):
        # Never store authorization headers in logs or assertion output.
        self.requests.append((method, path))
        if method != 'GET' or path not in ('/display', '/kitchen', '/manager/orders'):
            self.violations.append((method, path))
            return 405, {'code': 'UNEXPECTED_FIXTURE_REQUEST'}
        role = next((role for role, token in TOKENS.items()
                     if authorization == 'Bearer ' + token), None)
        if role is None:
            return 401, {'code': 'UNAUTHORIZED'}
        permitted = {'/display': ('display',), '/kitchen': ('prep', 'assembly'),
                     '/manager/orders': ('manager',)}
        if role not in permitted[path]:
            return 403, {'code': 'FORBIDDEN'}
        if path == '/display':
            if self.display_status != 200:
                return self.display_status, {'code': 'LOCAL_FIXTURE_UNAVAILABLE'}
            return 200, copy.deepcopy(self.display)
        data = {**SYNTHETIC, 'orders': []}
        if path == '/kitchen':
            data['station'] = role
        return 200, data


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def log_message(self, *_args):
        pass

    def api(self):
        path = urlparse(self.path).path.removeprefix('/v1/test')
        status, value = self.server.fixture.handle(self.command, path, self.headers.get('Authorization'))
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/v1/'):
            self.api()
        else:
            if urlparse(self.path).path in ('/', *PATHS.values()):
                self.path = '/index.html'
            super().do_GET()

    def do_POST(self):
        self.api()


class StaffDisplay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not PREVIEW and not (DIST / 'index.html').is_file():
            raise AssertionError('Build operations or set OPS_RECOVERY_URL to its loopback preview')
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)
        OUTPUT.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.fixture = Fixture()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.fixture = self.fixture
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.api_url = f'http://127.0.0.1:{self.server.server_port}'
        self.url = PREVIEW or self.api_url
        self.contexts = []
        self.errors = []
        self.unexpected = []

    def tearDown(self):
        for context in self.contexts:
            context.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.assertEqual(self.errors, [])
        self.assertEqual(self.unexpected, [], 'An external or mutating request was blocked')
        self.assertEqual(self.fixture.violations, [])
        self.assertTrue(all(method == 'GET' for method, _ in self.fixture.requests))

    def open(self, role, width=1920, height=1080):
        context = self.browser.new_context(viewport={'width': width, 'height': height},
                                           reduced_motion='reduce')
        self.contexts.append(context)

        def local_only(route):
            request = route.request
            parsed = urlparse(request.url)
            if request.method != 'GET':
                self.unexpected.append((request.method, parsed.path))
                route.abort()
            elif parsed.path.startswith('/v1/'):
                response = route.fetch(url=self.api_url + parsed.path)
                route.fulfill(response=response)
            elif parsed.netloc == urlparse(self.url).netloc:
                route.continue_()
            else:
                self.unexpected.append(('EXTERNAL', parsed.path))
                route.abort()

        context.route('**/*', local_only)
        page = context.new_page()
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        # Advance presentation/polling timers deterministically, while responses
        # still cross a real local HTTP socket and the app validates their schema.
        page.clock.install()
        page.goto(self.url + PATHS[role])
        page.wait_for_load_state('networkidle')
        expect(page.get_by_label('Ключ доступа', exact=True)).to_be_visible()
        self.assert_no_chrome(page, role)
        return page

    def login(self, page, role):
        page.get_by_label('Ключ доступа', exact=True).fill(TOKENS[role])
        page.get_by_role('button', name='Открыть рабочий экран', exact=True).click()
        selector = '.display-shell' if role == 'display' else '.manager-layout' if role == 'manager' else '.kitchen-main'
        expect(page.locator(selector)).to_be_visible()
        if role == 'display':
            expect(page.locator('.display-columns')).to_be_visible()
        self.assert_no_chrome(page, role)

    def assert_no_chrome(self, page, role):
        expect(page.locator('.test-banner')).to_have_count(0)
        expect(page.get_by_text('Тестовый контур - не ресторан · Реальные деньги не списываются', exact=True)).to_have_count(0)
        expect(page.get_by_role('navigation', name='Рабочие экраны')).to_have_count(0)
        expect(page.locator('a[href="/kitchen/prep"], a[href="/kitchen/assembly"], a[href="/display"], a[href="/kiosk"]')).to_have_count(0)
        if role in ('prep', 'assembly', 'display'):
            expect(page.get_by_role('button', name=re.compile('^(Выйти|Выход)'))).to_have_count(0)
        expect(page.get_by_text('Управление тестовой точкой', exact=True)).to_have_count(0)

    def numbers(self, page, ready=False):
        group = '.display-columns > section.ready' if ready else '.display-columns > section:not(.ready)'
        return page.locator(group + ' .display-number')

    def test_role_gate_and_removed_navigation_on_every_staff_surface(self):
        for role in PATHS:
            with self.subTest(role=role):
                page = self.open(role)
                before = len(self.fixture.requests)
                page.get_by_label('Ключ доступа', exact=True).fill('invalid')
                expect(page.get_by_role('button', name='Открыть рабочий экран', exact=True)).to_be_disabled()
                self.assertEqual(len(self.fixture.requests), before)
                if role == 'display':
                    page.get_by_label('Ключ доступа', exact=True).fill(TOKENS['prep'])
                    page.get_by_role('button', name='Открыть рабочий экран', exact=True).click()
                    expect(page.get_by_role('alert')).to_contain_text('нет прав')
                    expect(page.locator('.display-number')).to_have_count(0)
                self.login(page, role)
                expect(page.get_by_label('Ключ доступа', exact=True)).to_have_count(0)

    def test_only_api_snapshot_can_move_an_order_to_ready_or_remove_it(self):
        page = self.open('display')
        self.login(page, 'display')
        expect(self.numbers(page)).to_have_text(['T-900001'])
        expect(self.numbers(page, True)).to_have_text(['T-900002'])
        expect(page.locator('.display-columns > section').first).to_contain_text('Готовится')
        expect(page.locator('.display-columns > section.ready')).to_contain_text('Готово')
        page.clock.fast_forward(16000)
        expect(self.numbers(page)).to_have_text(['T-900001'])
        expect(self.numbers(page, True)).to_have_text(['T-900002'])
        self.fixture.set_orders(['T-900003'], ['T-900002', 'T-900001'])
        page.clock.fast_forward(2600)
        expect(self.numbers(page)).to_have_text(['T-900003'])
        expect(self.numbers(page, True)).to_have_text(['T-900002', 'T-900001'])
        self.fixture.set_orders(['T-900003'], ['T-900001'])
        page.clock.fast_forward(2600)
        expect(self.numbers(page, True)).to_have_text(['T-900001'])
        expect(page.get_by_text('T-900002', exact=True)).to_have_count(0)
        self.fixture.set_orders([], [])
        page.clock.fast_forward(2600)
        expect(page.locator('.display-number')).to_have_count(0)
        expect(page.locator('.display-columns > section')).to_have_count(2)
        self.assertTrue(all(path == '/display' for _, path in self.fixture.requests),
                        'Display must not fetch kitchen contents or manager/customer details')

    def test_expired_access_requires_the_staff_login_again(self):
        page = self.open('display')
        self.login(page, 'display')
        self.fixture.display_status = 401
        page.clock.fast_forward(2600)
        expect(page.get_by_role('status').filter(has_text='Нет свежего ответа')).to_be_visible()
        page.get_by_role('button', name='Восстановить доступ', exact=True).click()
        expect(page.get_by_label('Ключ доступа', exact=True)).to_be_visible()
        expect(page.locator('.display-columns')).to_have_count(0)
        expect(page.get_by_role('button', name='Открыть рабочий экран', exact=True)).to_be_disabled()
        self.fixture.display_status = 200
        self.login(page, 'display')
        expect(self.numbers(page, True)).to_have_text(['T-900002'])

    def test_disconnect_and_pii_payload_keep_last_complete_snapshot(self):
        self.fixture.set_orders([f'T-{number:06d}' for number in range(900001, 900014)], ['T-900100'])
        page = self.open('display', 1280, 720)
        self.login(page, 'display')
        expect(self.numbers(page)).to_have_count(6)
        saved = self.numbers(page).all_text_contents()
        self.fixture.display_status = 503
        self.fixture.set_orders(['T-999998'], ['T-999999'])
        page.clock.fast_forward(2600)
        expect(page.get_by_role('status').filter(has_text='Нет свежего ответа')).to_be_visible()
        page.clock.fast_forward(24000)
        expect(self.numbers(page)).to_have_text(saved)
        expect(self.numbers(page, True)).to_have_text(['T-900100'])
        expect(page.get_by_text('T-999999', exact=True)).to_have_count(0)
        self.assert_geometry(page, 1280, 720, 'stale-1280')
        # Strict display schema rejects accidental PII fields, preserving the
        # previous safe snapshot instead of leaking the new payload to the UI.
        self.fixture.display_status = 200
        self.fixture.display['ready'][0]['customer_name'] = 'PRIVATE_FIXTURE_NAME'
        self.fixture.display['ready'][0]['phone'] = '+70000000000'
        page.clock.fast_forward(2600)
        expect(page.get_by_role('status').filter(has_text='Нет свежего ответа')).to_be_visible()
        expect(self.numbers(page, True)).to_have_text(['T-900100'])
        for private in ('PRIVATE_FIXTURE_NAME', '+70000000000', 'T-999999'):
            expect(page.get_by_text(private, exact=False)).to_have_count(0)
        self.fixture.set_orders(['T-999998'], ['T-999999'])
        page.clock.fast_forward(2600)
        expect(self.numbers(page, True)).to_have_text(['T-999999'])
        expect(page.get_by_role('status').filter(has_text='Нет свежего ответа')).to_have_count(0)

    def test_asymmetric_overflow_pages_show_every_number_without_clipping(self):
        preparing = [f'T-{number:06d}' for number in range(910001, 910014)]
        ready = [f'T-{number:06d}' for number in range(920001, 920006)]
        self.fixture.set_orders(preparing, ready)
        for width, height in [(1920, 1080), (1280, 720)]:
            with self.subTest(viewport=(width, height)):
                page = self.open('display', width, height)
                self.login(page, 'display')
                expect(self.numbers(page)).to_have_count(6)
                expect(self.numbers(page, True)).to_have_count(4)
                seen_preparing, seen_ready = set(), set()
                for index in range(3):
                    if index:
                        before = self.numbers(page).all_text_contents()
                        page.clock.fast_forward(8000)
                        expect(self.numbers(page).first).not_to_have_text(before[0])
                    self.assertGreater(self.numbers(page).count(), 0)
                    self.assertGreater(self.numbers(page, True).count(), 0)
                    self.assertLessEqual(self.numbers(page).count(), 6)
                    self.assertLessEqual(self.numbers(page, True).count(), 4)
                    seen_preparing.update(self.numbers(page).all_text_contents())
                    seen_ready.update(self.numbers(page, True).all_text_contents())
                    self.assert_geometry(page, width, height, f'display-{width}-page-{index + 1}')
                self.assertEqual(seen_preparing, set(preparing))
                self.assertEqual(seen_ready, set(ready))

    def assert_geometry(self, page, width, height, name):
        page.wait_for_function('() => document.fonts.status === "loaded"')
        expect(page.locator('.display-clock time')).to_have_text(re.compile(r'^\d{2}:\d{2}$'))
        self.assertTrue(page.locator('.display-clock time').evaluate('''e => {
          const range = document.createRange(); range.selectNodeContents(e);
          const box = range.getBoundingClientRect();
          return range.getClientRects().length === 1 && box.left >= 0
            && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
        }'''), 'The entire clock must remain visible after polling and resize')
        self.assertTrue(page.evaluate('''() => {
          const root = document.documentElement;
          return root.scrollWidth <= innerWidth + 1 && root.scrollHeight <= innerHeight + 1;
        }'''), 'Display should fit the actual viewport without a browser scrollbar')
        self.assertTrue(page.locator('.display-number').evaluate_all('''elements => elements.every(e => {
          const box = e.getBoundingClientRect(), column = e.closest('section').getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(e);
          const text = range.getBoundingClientRect();
          return range.getClientRects().length === 1 && text.width <= box.width + 1
            && e.scrollWidth <= e.clientWidth + 1 && text.left >= column.left
            && text.right <= column.right + 1 && text.top >= 0 && text.bottom <= innerHeight
            && parseFloat(getComputedStyle(e).fontSize) >= 28;
        })'''), 'Order numbers must remain whole, readable and within their column')
        boxes = [section.bounding_box() for section in page.locator('.display-columns > section').all()]
        self.assertEqual(len(boxes), 2)
        self.assertLessEqual(boxes[0]['x'] + boxes[0]['width'], boxes[1]['x'] + 1)
        for box in boxes:
            self.assertGreaterEqual(box['x'], 0)
            self.assertLessEqual(box['x'] + box['width'], width + 1)
            self.assertLessEqual(box['y'] + box['height'], height + 1)
        # Give Chromium a paint after accelerated clock changes; an immediate
        # screenshot can retain only the changed digit although DOM bounds fit.
        page.wait_for_timeout(150)
        page.screenshot(path=str(OUTPUT / f'{name}.png'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
