"""Kiosk UI regressions against an isolated local HTTP test double, never the VPS.

Build @pickchick/operations first, then run with the pinned design Playwright venv.
The HTTP double issues all sessions/orders; tests never inject sessionStorage state.
These checks prove browser recovery behavior, not real backend/provider integration.
"""

import copy
import json
import os
import re
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
DIST = Path(os.environ.get('OPS_DIST', ROOT / 'apps/operations/dist'))
REMOTE_API = 'https://pickchick.185.129.51.103.nip.io/v1/test'
SYNTHETIC = {'synthetic': True, 'namespace': 'pickchick-test'}
BRANCH = '10000000-0000-4000-8000-000000000003'


def timestamp():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


class Fixture:
    """Small deterministic HTTP behavior double; all data exists only in this process."""

    def __init__(self):
        self.catalog = {
            **SYNTHETIC, 'branch_id': BRANCH, 'catalog_version': 'mockup-v0.2',
            'currency': 'KZT', 'products': [
                {'id': 'pick-combo', 'name': 'Pick Combo', 'category': 'Комбо',
                 'price_minor': '349000', 'image_id': 'i7.jpg', 'prep_required': True,
                 'description': 'Local HTTP UI test fixture'},
                {'id': 'cola', 'name': 'Coca-Cola', 'category': 'Напитки',
                 'price_minor': '69000', 'image_id': 'i2.jpg', 'prep_required': False,
                 'description': 'Local HTTP UI test fixture'},
            ],
        }
        self.session = None
        self.session_count = 0
        self.order = None
        self.quotes = {}
        self.commands = {}
        self.requests = []
        self.expired = False
        self.expire_payment = False
        self.catalog_status = 200
        self.order_status = 200

    def handle(self, method, path, body, headers):
        self.requests.append((method, path, copy.deepcopy(body), headers.get('Idempotency-Key')))
        if path == '/catalog':
            return self.catalog_status, self.catalog if self.catalog_status == 200 else {'code': 'UNAVAILABLE'}
        if path == '/sessions':
            self.session_count += 1
            self.session = {
                **SYNTHETIC, 'session_id': str(uuid4()), 'token': f'{self.session_count:064x}',
                'channel': 'kiosk',
                'expires_at': (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat().replace('+00:00', 'Z'),
            }
            return 200, self.session
        if not self.session or headers.get('Authorization') != 'Bearer ' + self.session['token']:
            return 401, {'code': 'UNAUTHORIZED'}
        if path == '/sessions/continue':
            if self.order and self.order['state'] not in ('fulfilled', 'cancelled'):
                return 409, {'code': 'CONFLICT'}
            self.expired = False
            return 200, self.session
        if self.expired:
            return 401, {'code': 'UNAUTHORIZED'}
        if path == '/orders' and method == 'GET':
            return 200, {**SYNTHETIC, 'orders': [self.order] if self.order else []}
        if method == 'GET' and path.startswith('/orders/'):
            return self.order_status, self.order if self.order_status == 200 else {'code': 'UNAVAILABLE'}
        key = headers.get('Idempotency-Key')
        previous = self.commands.get(key)
        if previous:
            return (200, previous[2]) if previous[:2] == (path, body) else (409, {'code': 'CONFLICT'})
        if path == '/quotes':
            products = {p['id']: p for p in self.catalog['products']}
            if any(item['product_id'] not in products for item in body['items']):
                return 400, {'code': 'INVALID_REQUEST'}
            lines = [{**products[item['product_id']], 'quantity': item['quantity'],
                      'line_total_minor': str(int(products[item['product_id']]['price_minor']) * item['quantity'])}
                     for item in body['items']]
            result = {
                **SYNTHETIC, 'quote_id': str(uuid4()), 'branch_id': BRANCH,
                'catalog_version': 'mockup-v0.2', 'channel': 'kiosk',
                'service_mode': body['service_mode'], 'currency': 'KZT', 'lines': lines,
                'total_minor': str(sum(int(line['line_total_minor']) for line in lines)),
                'created_at': timestamp(),
                'expires_at': (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat().replace('+00:00', 'Z'),
            }
            self.quotes[result['quote_id']] = result
        elif path == '/orders':
            self.order = {
                **SYNTHETIC, 'order_id': str(uuid4()), 'number': 'T-900001',
                'branch_id': BRANCH, 'version': 1, 'state': 'awaiting_test_payment',
                'payment_state': 'not_started', 'payment_attempt_id': None,
                'fiscal_state': 'not_applicable', 'snapshot': self.quotes[body['quote_id']],
                'tasks': [], 'created_at': timestamp(), 'updated_at': timestamp(),
                'cancellation_reason': None,
            }
            result = self.order
        elif path.endswith('/simulated-payment'):
            if self.expire_payment:
                self.expired = True
                self.expire_payment = False
                return 401, {'code': 'UNAUTHORIZED'}
            if self.order['state'] == 'cancelled':
                return 409, {'code': 'CONFLICT'}
            self.order = {**self.order, 'version': self.order['version'] + 1,
                          'payment_state': 'simulated_' + body['outcome']}
            result = self.order
        else:
            return 404, {'code': 'NOT_FOUND'}
        self.commands[key] = (path, copy.deepcopy(body), copy.deepcopy(result))
        return 200, result


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def log_message(self, *_args):
        pass

    def api(self):
        size = int(self.headers.get('Content-Length', '0'))
        body = json.loads(self.rfile.read(size)) if size else None
        status, value = self.server.fixture.handle(self.command, urlparse(self.path).path.removeprefix('/v1/test'), body, self.headers)
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/v1/test/'):
            self.api()
        else:
            if self.path == '/kiosk':
                self.path = '/index.html'
            super().do_GET()

    def do_POST(self):
        self.api()


class KioskRecovery(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not (DIST / 'index.html').is_file():
            raise AssertionError('Build @pickchick/operations before running UI regressions')
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

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
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.context = self.browser.new_context(viewport={'width': 1024, 'height': 1366})
        self.errors = []
        self.unexpected = []

        def local_only(route):
            url = route.request.url
            if url.startswith(REMOTE_API + '/'):
                response = route.fetch(url=self.url + '/v1/test' + url[len(REMOTE_API):])
                route.fulfill(response=response)
            elif urlparse(url).netloc == urlparse(self.url).netloc:
                route.continue_()
            else:
                self.unexpected.append(url)
                route.abort()

        self.context.route('**/*', local_only)
        self.page = self.context.new_page()
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.goto(self.url + '/kiosk')
        self.page.wait_for_load_state('networkidle')
        expect(self.page.locator('.test-banner')).to_have_count(0)

    def tearDown(self):
        self.context.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.assertEqual(self.errors, [])
        self.assertEqual(self.unexpected, [], 'Unexpected external request was blocked')

    def start(self):
        self.page.get_by_role('button', name='НАЧАТЬ →', exact=True).click()
        self.page.get_by_role('button', name=re.compile('С СОБОЙ')).click()

    def add(self, name='Pick Combo'):
        self.page.locator('.product').filter(has_text=name).click()
        self.page.get_by_role('button', name=re.compile('^Добавить ·')).click()

    def quote(self):
        self.page.get_by_role('button', name='Оформить заказ →', exact=True).click()
        self.page.get_by_role('button', name='Продолжить →', exact=True).click()
        self.page.get_by_role('button', name='Рассчитать тестовый заказ', exact=True).click()
        expect(self.page.get_by_text('Расчёт подтверждён сервером', exact=True)).to_be_visible()

    def create(self):
        self.start()
        self.add()
        self.quote()
        self.page.get_by_role('button', name='Создать тестовый заказ →', exact=True).click()
        expect(self.page.locator('.order-number')).to_have_text('T-900001')

    def saved_draft(self):
        return self.page.evaluate('JSON.parse(sessionStorage.getItem("pickchick.kiosk.draft"))')

    def test_welcome_return_clears_guest_and_next_start_is_empty(self):
        self.start()
        self.add()
        self.page.get_by_role('button', name='Назад', exact=True).click()
        self.page.get_by_role('button', name='Назад', exact=True).click()
        expect(self.page.locator('.attract')).to_be_visible()
        self.assertIsNone(self.saved_draft())
        self.assertIsNone(self.page.evaluate('sessionStorage.getItem("pickchick.kiosk.session")'))
        self.start()
        expect(self.page.locator('.cart-bar')).to_contain_text('В корзине: 0')
        self.assertEqual(self.fixture.session_count, 2)

    def test_mode_change_uses_new_quote_command(self):
        self.start()
        self.add()
        self.quote()
        for _ in range(3):
            self.page.get_by_role('button', name='Назад', exact=True).click()
        self.page.get_by_role('button', name=re.compile('В ЗАЛЕ')).click()
        self.quote()
        requests = [r for r in self.fixture.requests if r[1] == '/quotes']
        self.assertEqual([r[2]['service_mode'] for r in requests], ['takeaway', 'dine_in'])
        self.assertNotEqual(requests[0][3], requests[1][3])
        expect(self.page.locator('.summary')).to_contain_text('В зале')

    def test_missing_product_is_visible_and_removable_before_quote(self):
        self.start()
        self.add()
        self.add('Coca-Cola')
        self.fixture.catalog['products'] = self.fixture.catalog['products'][1:]
        self.page.reload()
        self.page.get_by_role('button', name='Оформить заказ →', exact=True).click()
        expect(self.page.get_by_role('heading', name='Недоступное блюдо · pick-combo')).to_be_visible()
        expect(self.page.get_by_role('button', name='Продолжить →', exact=True)).to_be_disabled()
        self.page.get_by_role('button', name='Удалить недоступное блюдо', exact=True).click()
        self.assertEqual(self.saved_draft()['counts'], {'cola': 1})
        self.page.get_by_role('button', name='Продолжить →', exact=True).click()
        self.page.get_by_role('button', name='Рассчитать тестовый заказ', exact=True).click()
        expect(self.page.get_by_text('Расчёт подтверждён сервером', exact=True)).to_be_visible()
        request = next(r for r in self.fixture.requests if r[1] == '/quotes')
        self.assertEqual(request[2]['items'], [{'product_id': 'cola', 'quantity': 1}])

    def test_catalog_first_failure_and_empty_catalog_are_not_loading(self):
        self.fixture.catalog_status = 503
        self.page.reload()
        self.start()
        expect(self.page.get_by_role('heading', name='Меню не загрузилось')).to_be_visible()
        expect(self.page.locator('.spinner')).to_have_count(0)
        self.fixture.catalog_status = 200
        self.fixture.catalog['products'] = []
        self.page.get_by_role('button', name='Повторить', exact=True).click()
        expect(self.page.get_by_role('heading', name='В меню пока нет блюд')).to_be_visible()
        expect(self.page.locator('.spinner')).to_have_count(0)

    def test_product_reports_stale_catalog_and_retains_details(self):
        self.start()
        self.page.locator('.product').filter(has_text='Pick Combo').click()
        self.fixture.catalog_status = 503
        expect(self.page.locator('.connection')).to_contain_text('Нет свежего ответа', timeout=10000)
        expect(self.page.get_by_role('heading', name='Pick Combo', exact=True)).to_be_visible()
        expect(self.page.get_by_role('button', name='Повторить', exact=True)).to_be_visible()

    def test_order_first_failure_keeps_reference_and_recovers(self):
        self.create()
        order_id = self.saved_draft()['orderId']
        self.fixture.order_status = 503
        self.page.reload()
        expect(self.page.get_by_role('heading', name='Не удалось восстановить заказ')).to_be_visible()
        expect(self.page.locator('.spinner')).to_have_count(0)
        self.assertEqual(self.saved_draft()['orderId'], order_id)
        expect(self.page.get_by_role('button', name='Завершить', exact=True)).to_have_count(0)
        self.fixture.order_status = 200
        self.page.get_by_role('button', name='Повторить', exact=True).click()
        expect(self.page.locator('.order-number')).to_have_text('T-900001')

    def test_expired_pending_command_requires_staff_then_exact_retry(self):
        self.create()
        self.fixture.expire_payment = True
        self.page.get_by_role('button', name='Тест: подтвердить оплату', exact=True).click()
        expect(self.page.get_by_role('heading', name='Срок тестового сеанса истёк')).to_be_visible()
        pending = copy.deepcopy(self.saved_draft()['pending'])
        self.assertEqual(pending['kind'], 'payment')
        self.page.reload()
        expect(self.page.get_by_role('button', name='Повторить прежний запрос', exact=True)).to_be_disabled()
        self.assertEqual(self.saved_draft()['pending'], pending)
        self.page.get_by_role('button', name='Продлить тестовый сеанс', exact=True).click()
        expect(self.page.locator('.session-recovery')).to_contain_text('управляющий должен завершить')
        self.page.get_by_role('button', name='Нужна помощь с доступом', exact=True).click()
        expect(self.page.get_by_role('dialog')).to_contain_text('Корзина и незавершённый запрос сохраняются')
        self.page.get_by_role('button', name='Вернуться к проверке', exact=True).click()
        self.page.clock.install()
        self.page.clock.fast_forward(106000)
        self.assertEqual(self.saved_draft()['pending'], pending)
        expect(self.page.locator('.attract')).to_have_count(0)
        expect(self.page.get_by_role('button', name='Завершить', exact=True)).to_have_count(0)
        self.fixture.order = {**self.fixture.order, 'state': 'cancelled', 'version': 2,
                              'cancellation_reason': 'Local fixture staff resolution'}
        self.page.get_by_role('button', name='Продлить тестовый сеанс', exact=True).click()
        expect(self.page.locator('.session-recovery')).to_have_count(0)
        self.assertEqual(self.saved_draft()['pending'], pending)
        self.page.get_by_role('button', name='Повторить прежний запрос', exact=True).click()
        expect(self.page.get_by_role('heading', name='Заказ отменён', exact=True)).to_be_visible()
        payments = [r for r in self.fixture.requests if r[1].endswith('/simulated-payment')]
        self.assertEqual(len(payments), 2)
        self.assertEqual(payments[0][2:], payments[1][2:])
        self.assertEqual(self.fixture.session_count, 1)

    def test_expired_order_reference_is_preserved_until_continuation(self):
        self.create()
        order_id = self.saved_draft()['orderId']
        self.fixture.expired = True
        self.page.reload()
        expect(self.page.get_by_role('heading', name='Срок тестового сеанса истёк')).to_be_visible()
        expect(self.page.get_by_role('heading', name='Не удалось восстановить заказ')).to_be_visible()
        self.page.get_by_role('button', name='Продлить тестовый сеанс', exact=True).click()
        expect(self.page.locator('.session-recovery')).to_contain_text('Сервер не разрешил продление')
        self.assertEqual(self.saved_draft()['orderId'], order_id)
        self.assertEqual(self.fixture.session_count, 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
