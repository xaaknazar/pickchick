"""Orders tab (M19) redesign at 393x852 against local fixtures; no real orders, payments or reviews.

Usage: [ORDERS_VIEWPORT=320x568] browser_orders_redesign.py [sim|kaspi|all] [output-dir]
  sim    test-flow export (EXPO_PUBLIC_ORDER_SIMULATOR=1), served at MOBILE_RECOVERY_URL
  kaspi  customer-auth export (EXPO_PUBLIC_KASPI_CHECKOUT=1), served at CUSTOMER_AUTH_URL
Screenshots go to .local/orders-redesign unless an output directory is given.
"""
from browser_network import isolated_context, route_fixture
from account_fixture import signed_in
import json, os, re, subprocess, sys, uuid
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
SIM_URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4182').rstrip('/')
KASPI_URL = os.environ.get('CUSTOMER_AUTH_URL', 'http://127.0.0.1:4196').rstrip('/')
for url in (SIM_URL, KASPI_URL):
    assert urlparse(url).hostname in ('127.0.0.1', 'localhost'), 'Use a local exported app'
ARGS = [arg for arg in sys.argv[1:]]
MODE = ARGS[0] if ARGS else 'all'
assert MODE in ('sim', 'kaspi', 'all'), MODE
OUT = Path(ARGS[1]) if len(ARGS) > 1 else ROOT / '.local/orders-redesign'
# Default is the approved mockup frame; ORDERS_VIEWPORT=320x568 checks a small phone.
WIDTH, HEIGHT = map(int, os.environ.get('ORDERS_VIEWPORT', '393x852').split('x'))
SUFFIX = '' if (WIDTH, HEIGHT) == (393, 852) else f'-{WIDTH}'
OUT.mkdir(parents=True, exist_ok=True)
CAT = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
    "import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js';console.log(JSON.stringify(testCompleteCatalog))"],
    cwd=ROOT, text=True))
BRANCH = CAT['branch_id']
PRICES = {p['id']: (p['name'], int(p['price_minor'])) for p in CAT['products']}
META = {'synthetic': True, 'namespace': 'pickchick-test'}
# Fixture clock: 2026-10-12 17:00 in Almaty (UTC+5), so day groups are stable.
CLOCK = '2026-10-12T12:00:00.000Z'
TODAY, YESTERDAY, OCT4, OCT2 = '2026-10-12', '2026-10-11', '2026-10-04', '2026-10-02'


def at(day, almaty_time):
    hour, minute = map(int, almaty_time.split(':'))
    utc_hour = hour - 5
    if utc_hour < 0:
        raise ValueError('fixture times stay on the same UTC day')
    return f'{day}T{utc_hour:02d}:{minute:02d}:00.000Z'


def items(*entries):
    return [(pid, qty) for pid, qty in entries]


def total(entries):
    return sum(PRICES[pid][1] * qty for pid, qty in entries)


def uid(seed):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'pickchick-orders-redesign/' + seed))


# ---- test-flow (simulator) fixtures -------------------------------------------------------
SESSION = {**META, 'session_id': uid('session'), 'token': 'a' * 64,
           'expires_at': '2099-01-01T00:00:00.000Z', 'channel': 'mobile'}


def test_order(number, state, created, entries, mode='takeaway', stage='cooking',
               payment='not_started'):
    lines = [{'id': pid, 'name': PRICES[pid][0], 'description': 'Fixture', 'category': 'Комбо',
              'price_minor': str(PRICES[pid][1]), 'image_id': 'i7.jpg', 'prep_required': True,
              'quantity': qty, 'line_total_minor': str(PRICES[pid][1] * qty)} for pid, qty in entries]
    quote = {**META, 'quote_id': uid('quote' + number), 'branch_id': BRANCH,
             'catalog_version': 'mockup-v0.2', 'channel': 'mobile', 'service_mode': mode,
             'currency': 'KZT', 'total_minor': str(total(entries)), 'lines': lines,
             'created_at': created, 'expires_at': '2099-01-01T00:00:00.000Z'}
    done = state in ('ready', 'fulfilled') or stage == 'assembly'
    return {**META, 'order_id': uid('order' + number), 'number': number, 'branch_id': BRANCH,
            'version': 2, 'state': state, 'payment_state': payment, 'payment_attempt_id': None,
            'fiscal_state': 'not_applicable', 'snapshot': quote,
            'tasks': [{'task_id': uid(f'task{number}{station}'), 'station': station, 'title': station,
                       'state': 'done' if (station == 'prep' and done) or state in ('ready', 'fulfilled') else 'pending',
                       'mandatory': True} for station in ['prep', 'assembly']],
            'created_at': created, 'updated_at': created,
            'cancellation_reason': 'Отмена по просьбе клиента' if state == 'cancelled' else None}


HISTORY_SIM = [
    test_order('12', 'fulfilled', at(TODAY, '12:32'), items(('pick-combo', 1))),
    test_order('7', 'fulfilled', at(YESTERDAY, '19:05'), items(('burger-combo', 1), ('mix-duo', 1)), 'dine_in'),
    test_order('3', 'fulfilled', at(YESTERDAY, '13:40'),
               items(('master-combo', 2), ('pick-combo', 1), ('finger-duo', 1), ('solo-combo', 2), ('fingers-25', 3))),
]
SIM_SCENARIOS = {
    'active-history': [test_order('14', 'preparing', at(TODAY, '16:51'), items(('finger-duo', 1), ('sauce', 1)))] + HISTORY_SIM
    + [test_order('18', 'cancelled', at(OCT2, '11:02'), items(('solo-combo', 1)))],
    'two-active': [
        test_order('16', 'awaiting_test_payment', at(TODAY, '16:55'), items(('pick-combo', 1), ('cola', 1))),
        test_order('15', 'ready', at(TODAY, '16:40'), items(('pick-combo', 1), ('lemonade', 1))),
    ] + HISTORY_SIM,
    'history-only': [
        test_order('7', 'fulfilled', at(YESTERDAY, '19:05'), items(('burger-combo', 1), ('mix-duo', 1)), 'dine_in'),
        test_order('3', 'fulfilled', at(YESTERDAY, '13:40'),
                   items(('pick-combo', 1), ('burger-combo', 1), ('solo-combo', 1), ('mix-duo', 1))),
        test_order('30', 'fulfilled', at(OCT4, '20:47'), items(('fingers-50', 1))),
        test_order('11', 'fulfilled', at(OCT4, '14:15'),
                   items(('master-combo', 2), ('pick-combo', 1), ('finger-duo', 1), ('solo-combo', 2), ('fingers-25', 3))),
        test_order('18', 'cancelled', at(OCT2, '11:02'), items(('solo-combo', 1))),
        test_order('4', 'fulfilled', at(OCT2, '09:58'), items(('pick-combo', 1), ('mix-duo', 1), ('solo-combo', 1))),
    ],
    'empty': [],
}

# ---- Kaspi (customer commerce) fixtures --------------------------------------------------------
CUSTOMER = '40000000-0000-4000-8000-000000000001'
customer = {'id': CUSTOMER, 'phone': '+77000000000', 'nickname': 'UI test', 'birth_date': None,
            'gender': None, 'profile_completed_at': None, 'created_at': '2026-09-07T10:00:00.000Z'}
envelope = {'version': 1, 'device_id': '40000000-0000-4000-8000-000000000004',
            'tokens': {'access_token': 'a' * 64, 'refresh_token': 'b' * 64,
                       'access_expires_at': '2099-01-01T00:00:00.000Z',
                       'session_id': '40000000-0000-4000-8000-000000000002', 'customer': customer},
            'challenge': None, 'otp_request': None, 'verify_intent': None,
            'refresh_request_id': None, 'closing': None}


def commerce_order(number, phase, created, entries, mode='takeaway', stage=None, expires=None):
    return {'orderId': uid('commerce' + (number or created)), 'revision': uuid.uuid5(uuid.NAMESPACE_URL, created).hex * 2,
            'restaurant': 'ТЦ Abay Plaza', 'branchId': BRANCH, 'createdAt': created, 'updatedAt': created,
            'kitchenStage': stage, 'displayNumber': number, 'totalMinor': str(total(entries)),
            'serviceMode': mode, 'kitchenComment': None, 'phase': phase, 'expiresAt': expires,
            'receipt': 'deferred', 'receiptUrl': None,
            'items': [{'productId': pid, 'title': PRICES[pid][0], 'quantity': qty,
                       'totalMinor': str(PRICES[pid][1] * qty), 'modifiers': []} for pid, qty in entries]}


INVOICE_EXPIRES = '2026-10-12T12:04:14.000Z'  # about 4:12 left on the fixture clock
HISTORY_KASPI = [
    commerce_order('12', 'handed_over', at(TODAY, '12:32'), items(('pick-combo', 1))),
    commerce_order('7', 'handed_over', at(YESTERDAY, '19:05'), items(('burger-combo', 1), ('mix-duo', 1)), 'dine_in'),
    commerce_order('3', 'handed_over', at(YESTERDAY, '13:40'),
                   items(('master-combo', 2), ('pick-combo', 1), ('finger-duo', 1), ('solo-combo', 2), ('fingers-25', 3))),
    commerce_order('19', 'handed_over', at(OCT2, '13:10'), items(('solo-combo', 1))),
]
RATED_KASPI = {HISTORY_KASPI[1]['orderId']: 5, HISTORY_KASPI[2]['orderId']: 4}
KASPI_SCENARIOS = {
    'active-history': [commerce_order('14', 'preparing', at(TODAY, '16:51'),
                                      items(('finger-duo', 1), ('sauce', 1)), stage='cooking')] + HISTORY_KASPI,
    'two-active': [
        commerce_order(None, 'awaiting_payment', at(TODAY, '16:55'), items(('pick-combo', 1), ('cola', 1)),
                       expires=INVOICE_EXPIRES),
        commerce_order('15', 'ready', at(TODAY, '16:40'), items(('pick-combo', 1), ('lemonade', 1))),
    ] + HISTORY_KASPI,
    'ready': [commerce_order('15', 'ready', at(TODAY, '16:40'), items(('pick-combo', 1), ('lemonade', 1)))] + HISTORY_KASPI,
    'awaiting-payment': [commerce_order(None, 'awaiting_payment', at(TODAY, '16:55'),
                                        items(('pick-combo', 1), ('cola', 1)), expires=INVOICE_EXPIRES)] + HISTORY_KASPI,
    'history-only': [
        commerce_order('7', 'handed_over', at(YESTERDAY, '19:05'), items(('burger-combo', 1), ('mix-duo', 1)), 'dine_in'),
        commerce_order('3', 'handed_over', at(YESTERDAY, '13:40'),
                       items(('pick-combo', 1), ('burger-combo', 1), ('solo-combo', 1), ('mix-duo', 1))),
        commerce_order('30', 'handed_over', at(OCT4, '20:47'), items(('fingers-50', 1))),
        commerce_order('11', 'handed_over', at(OCT4, '14:15'),
                       items(('master-combo', 2), ('pick-combo', 1), ('finger-duo', 1), ('solo-combo', 2), ('fingers-25', 3))),
        commerce_order('18', 'attention', at(OCT2, '11:02'), items(('solo-combo', 1))),
        commerce_order(None, 'failed', at(OCT2, '10:20'), items(('pick-combo', 1))),
        commerce_order('4', 'handed_over', at(OCT2, '09:58'), items(('pick-combo', 1), ('mix-duo', 1), ('solo-combo', 1))),
    ],
    'empty': [],
}
errors = []
# Shift the page clock to CLOCK while letting time flow (animations and timers keep running).
SHIFT_CLOCK = '''(() => {
  const RealDate = Date;
  const shift = RealDate.parse(%s) - RealDate.now();
  class FixtureDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + shift);
      else super(...args);
    }
    static now() {
      return RealDate.now() + shift;
    }
  }
  globalThis.Date = FixtureDate;
})();''' % json.dumps(CLOCK)


def settle(page):
    expect(page.get_by_test_id('floating-tab-bar')).to_be_visible(timeout=20000)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=20000)


def capture(page, name, expectations):
    page.wait_for_timeout(700)
    for test_id, count in expectations:
        expect(page.get_by_test_id(test_id)).to_have_count(count, timeout=15000)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), name
    page.screenshot(path=str(OUT / f'{name}.png'))


def check_layout(page, name):
    # Touch targets of the new controls stay at least 44pt tall.
    for selector in ['[data-testid^="repeat-order-"]', '[data-testid^="order-history-pay-"]',
                     '[data-testid^="history-order-pay-"]', '[data-testid="orders-open-menu"]']:
        for box in [el.bounding_box() for el in page.locator(selector).all()]:
            if box:
                assert box['height'] >= 44, (name, selector, box)
    for el in page.locator('[data-testid*="-rate-"]').all():
        box = el.bounding_box()
        assert box and box['height'] >= 44 and box['width'] >= 40, (name, box)


def run_sim(browser):
    for name, orders in SIM_SCENARIOS.items():
        ctx = isolated_context(browser, viewport={'width': WIDTH, 'height': HEIGHT}, device_scale_factor=2,
                               reduced_motion='reduce')
        signed_in(ctx)
        ctx.add_init_script('localStorage.setItem("pickchick.test.customer.v1",' + json.dumps(json.dumps(SESSION)) + ')')
        held = []

        def intercept(route, orders=orders, held=held):
            path = urlparse(route.request.url).path
            if path == '/v1/test/orders/watch':
                held.append(route)
                return
            data = None
            if path == '/v1/test/orders':
                data = {**META, 'orders': orders}
            elif path == '/v1/test/history':
                data = {**META, 'orders': []}
            elif path == '/v1/test/catalog':
                data = CAT
            elif path == '/v1/capabilities':
                data = {'schema_version': 1, 'environment': 'staging', 'data_mode': 'synthetic', 'ordering_enabled': False,
                        'features': {**{k: False for k in ['phone_auth', 'payments', 'fiscal', 'checkout', 'loyalty']}, 'test_order_flow': True}}
            elif path == '/v1/branches':
                data = {'branches': [{'id': BRANCH, 'code': 'TEST', 'name': 'ТЦ Abay Plaza', 'timezone': 'Asia/Almaty', 'ordering_enabled': False}]}
            elif path.endswith('/menu'):
                data = {'schema_version': 1, 'branch_id': BRANCH, 'release_id': uid('release'), 'version': 1,
                        'published_at': '2026-09-25T12:00:00.000Z', 'items': []}
            elif '/content/branches/' in path:
                data = {'schema_version': 1, 'branch_id': BRANCH, 'promos': [], 'games': []}
            else:
                route.abort()
                return
            route.fulfill(json=data, headers={'Access-Control-Allow-Origin': '*'})

        route_fixture(ctx, '**/v1/**', intercept)
        ctx.add_init_script(SHIFT_CLOCK)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(SIM_URL + '/orders')
        settle(page)
        active = sum(1 for o in orders if o['state'] in ('awaiting_test_payment', 'preparing', 'ready'))
        if orders:
            expect(page.get_by_test_id('history-order-' + orders[0]['order_id'])).to_be_visible(timeout=20000)
        else:
            expect(page.get_by_test_id('orders-empty')).to_be_visible(timeout=20000)
        expectations = [('tab-orders-badge', 1 if active else 0), ('orders-active', 1 if active else 0)]
        capture(page, f'sim-{name}{SUFFIX}', expectations)
        check_layout(page, name)
        if name == 'active-history':
            expect(page.get_by_test_id('orders-active-title')).to_have_text('Сейчас')
            expect(page.get_by_test_id('tab-orders-badge')).to_have_text('1')
            # Only the newest handed-over order asks for stars; the cancelled one cannot repeat.
            expect(page.get_by_test_id('orders-rate-row')).to_have_count(1)
            expect(page.get_by_test_id('history-order-rate-' + HISTORY_SIM[0]['order_id'] + '-5')).to_be_visible()
            expect(page.get_by_test_id('repeat-order-' + SIM_SCENARIOS[name][-1]['order_id'])).to_have_count(0)
            expect(page.get_by_text('Отменён', exact=True)).to_have_count(1)
            page.get_by_test_id('scroll-M19').evaluate('(e) => { e.scrollTop = e.scrollHeight; }')
            page.wait_for_timeout(300)
            page.screenshot(path=str(OUT / f'sim-{name}-end{SUFFIX}.png'))
            page.get_by_test_id('scroll-M19').evaluate('(e) => { e.scrollTop = 0; }')
            # Existing repeat flow opens from the text button.
            page.get_by_test_id('repeat-order-' + HISTORY_SIM[0]['order_id']).click()
            expect(page.get_by_test_id('repeat-order-confirm')).to_be_visible()
            page.screenshot(path=str(OUT / f'sim-{name}-repeat{SUFFIX}.png'))
        if name == 'two-active':
            expect(page.get_by_test_id('orders-active-title')).to_have_text('Сейчас · 2')
            expect(page.get_by_test_id('tab-orders-badge')).to_have_text('2')
            expect(page.get_by_test_id('history-order-pay-' + orders[0]['order_id'])).to_have_text('Перейти к оплате')
        if name == 'history-only':
            expect(page.get_by_text('+2', exact=True)).to_have_count(1)
        for route in held:
            try:
                route.abort()
            except Exception:
                pass
        ctx.close()


def run_kaspi(browser):
    for name, orders in KASPI_SCENARIOS.items():
        ctx = isolated_context(browser, viewport={'width': WIDTH, 'height': HEIGHT}, device_scale_factor=2,
                               reduced_motion='reduce')
        ctx.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",' + json.dumps(json.dumps(envelope)) + ');')
        held = []
        rated = {k: v for k, v in RATED_KASPI.items() if any(o['orderId'] == k for o in orders)}
        if name == 'history-only':
            rated = {o['orderId']: 5 for o in orders if o['phase'] == 'handed_over' and o['displayNumber'] != '30'}
            rated[orders[3]['orderId']] = 4

        def intercept(route, orders=orders, held=held, rated=rated):
            path = urlparse(route.request.url).path
            method = route.request.method
            data = None
            if path.endswith('/watch'):
                held.append(route)
                return
            if path == '/v1/customers/me':
                data = {'customer': customer}
            elif path == '/v1/customer-checkout/availability':
                data = {'enabled': True, 'fresh': True, 'signature': 'a' * 64,
                        'products': [{'id': p['id'], 'available': True, 'stoppedOptions': []} for p in CAT['products']]}
            elif path == '/v1/auth/config':
                data = {'enabled': True, 'delivery_consent_required': True, 'consent_version': 'fixture-v1',
                        'terms_url': 'https://example.test/terms', 'privacy_url': 'https://example.test/privacy'}
            elif path == '/v1/capabilities':
                data = {'schema_version': 1, 'environment': 'staging', 'data_mode': 'pilot', 'ordering_enabled': False,
                        'features': {'phone_auth': True, 'test_order_flow': True, **{k: False for k in ['payments', 'fiscal', 'checkout', 'loyalty']}}}
            elif path == '/v1/branches':
                data = {'branches': [{'id': BRANCH, 'code': 'TEST', 'name': 'ТЦ Abay Plaza', 'timezone': 'Asia/Almaty', 'ordering_enabled': False}]}
            elif path == '/v1/branches/' + BRANCH + '/menu':
                data = {'schema_version': 1, 'branch_id': BRANCH, 'release_id': uid('release'), 'version': 1,
                        'published_at': '2026-09-07T00:00:00Z', 'items': []}
            elif path == '/v1/test/catalog':
                data = CAT
            elif path == '/v1/content/branches/' + BRANCH:
                data = {'schema_version': 1, 'branch_id': BRANCH, 'promos': [], 'games': []}
            elif path == '/v1/customer-checkout/feedback' and method == 'GET':
                data = {'feedback': [{'orderId': k, 'rating': v, 'comment': None, 'createdAt': CLOCK, 'updatedAt': CLOCK}
                                     for k, v in rated.items()]}
            elif path == '/v1/customer-checkout/config':
                data = {'enabled': True, 'branchId': BRANCH, 'restaurant': 'ТЦ Abay Plaza',
                        'fiscalPolicy': 'deferred_pilot', 'orderCommentEnabled': True}
            elif path == '/v1/customer-checkout/orders' and method == 'GET':
                data = {'orders': orders}
            elif path.startswith('/v1/customer-checkout/orders/') and path.endswith('/feedback') and method == 'GET':
                order_id = path.split('/')[4]
                saved = rated.get(order_id)
                data = {'orderId': order_id, 'enabled': True, 'preparationStartedAt': None, 'readyAt': None,
                        'feedback': {'rating': saved, 'comment': None, 'createdAt': CLOCK, 'updatedAt': CLOCK} if saved else None}
            else:
                if method != 'GET' and path.startswith('/v1/customer-checkout'):
                    errors.append(f'Orders tab must not send {method} {path}')
                route.abort()
                return
            route.fulfill(json=data, headers={'Access-Control-Allow-Origin': '*'})

        route_fixture(ctx, '**/v1/**', intercept)
        ctx.add_init_script(SHIFT_CLOCK)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(KASPI_URL + '/orders')
        settle(page)
        if orders:
            expect(page.get_by_test_id('order-history-open-' + orders[0]['orderId'])).to_be_visible(timeout=20000)
        else:
            expect(page.get_by_test_id('orders-empty')).to_be_visible(timeout=20000)
        active = sum(1 for o in orders if o['phase'] not in ('handed_over', 'failed', 'attention'))
        capture(page, f'kaspi-{name}{SUFFIX}', [('tab-orders-badge', 1 if active else 0), ('orders-active', 1 if active else 0)])
        check_layout(page, name)
        if name == 'awaiting-payment':
            card = page.get_by_test_id('order-history-' + orders[0]['orderId'])
            expect(card).to_contain_text('Ждём оплату')
            expect(card).to_contain_text(re.compile(r'Kaspi · осталось 4:[01]\d'))
            expect(page.get_by_text('Оплатить в Kaspi', exact=False)).to_have_count(0)
            # «Перейти к оплате» resumes the existing Kaspi payment state; nothing is sent.
            page.get_by_test_id('order-history-pay-' + orders[0]['orderId']).click()
            expect(page.get_by_test_id('kaspi-waiting')).to_be_visible(timeout=10000)
            kaspi_button = page.get_by_test_id('kaspi-open-app')
            expect(kaspi_button).to_be_visible()
            button_box = kaspi_button.bounding_box()
            tab_box = page.get_by_test_id('tab-orders').bounding_box()
            assert button_box and tab_box
            assert button_box['y'] >= 0
            assert button_box['y'] + button_box['height'] <= tab_box['y'], 'Kaspi action is covered by the floating tab bar'
            # Check pointer reachability without opening Kaspi or sending an invoice.
            kaspi_button.click(trial=True)
            page.screenshot(path=str(OUT / f'kaspi-{name}-resume{SUFFIX}.png'))
        if name == 'active-history':
            expect(page.get_by_test_id('tab-orders-badge')).to_have_text('1')
            expect(page.get_by_test_id('orders-rate-row')).to_have_count(1)
            expect(page.get_by_test_id(f"order-history-rate-{HISTORY_KASPI[0]['orderId']}-5")).to_be_visible()
            expect(page.get_by_test_id(f"order-history-{HISTORY_KASPI[1]['orderId']}")).to_contain_text('★ 5')
            # A star in the list opens the existing review sheet with that rating preselected.
            page.get_by_test_id(f"order-history-rate-{HISTORY_KASPI[0]['orderId']}-5").click()
            expect(page.get_by_test_id('completed-rating-5')).to_have_attribute('aria-checked', 'true', timeout=10000)
            page.screenshot(path=str(OUT / f'kaspi-{name}-rate{SUFFIX}.png'))
        if name == 'history-only':
            expect(page.get_by_test_id('orders-rate-row')).to_have_count(1)
            expect(page.get_by_text('Счёт не оплачен', exact=True)).to_have_count(1)
            expect(page.get_by_text('Проверяем заказ', exact=True)).to_have_count(1)
            expect(page.get_by_text('деньги вернули', exact=False)).to_have_count(0)
        for route in held:
            try:
                route.abort()
            except Exception:
                pass
        ctx.close()


with sync_playwright() as p:
    browser = p.chromium.launch()
    if MODE in ('sim', 'all'):
        run_sim(browser)
    if MODE in ('kaspi', 'all'):
        run_kaspi(browser)
    browser.close()
assert not errors, errors
print(f'PASS orders redesign ({MODE}): screenshots in {OUT}')
