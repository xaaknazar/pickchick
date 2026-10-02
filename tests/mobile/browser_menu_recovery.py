"""Automatic public-menu recovery against local fixtures, with no order mutations."""
import copy
import json
import os
import subprocess
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright

URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4182').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost'), 'Use an isolated loopback export'
ROOT = Path(os.environ.get('PICKCHICK_TEST_SOURCE_ROOT', Path(__file__).resolve().parents[2]))
PREFERENCES = 'pickchick.mobile.preferences.v1'
module = ROOT / 'packages/test-order-flow/dist/complete-catalog.js'
completed = subprocess.run(
    ['node', '--input-type=module', '-e',
     'import {pathToFileURL} from "node:url"; '
     'const m = await import(pathToFileURL(process.argv[1]).href); '
     'process.stdout.write(JSON.stringify(m.testCompleteCatalog));', str(module)],
    capture_output=True, text=True, check=True,
)
CATALOG = json.loads(completed.stdout)
assert CATALOG['catalog_version'] == 'mockup-v0.3' and len(CATALOG['products']) == 24
# This visible sentinel proves recovery rendered the HTTP result, not the
# application's bundled design catalog (which shares the same product IDs).
SENTINEL = 'Pick Combo · проверка сети'
CATALOG['products'][0]['name'] = SENTINEL
BRANCH = CATALOG['branch_id']
MENU_PATH = '/v1/branches/' + BRANCH + '/menu'
CONTENT_PATH = '/v1/content/branches/' + BRANCH
CAPABILITIES = {
    'schema_version': 1, 'environment': 'staging', 'data_mode': 'synthetic',
    'ordering_enabled': False,
    'features': {'test_order_flow': True,
                 **{key: False for key in ['phone_auth', 'payments', 'fiscal', 'checkout', 'loyalty']}},
}
READS = {
    '/v1/customer-checkout/availability': {'enabled': False, 'fresh': False, 'signature': 'disabled', 'products': []},
    '/v1/capabilities': CAPABILITIES,
    '/v1/branches': {'branches': [{'id': BRANCH, 'code': 'TEST', 'name': 'Проверка восстановления',
                                  'timezone': 'Asia/Almaty', 'ordering_enabled': False}]},
    MENU_PATH: {'schema_version': 1, 'branch_id': BRANCH,
                'release_id': '10000000-0000-4000-8000-000000000008',
                'version': 1, 'published_at': '2026-09-07T00:00:00Z', 'items': []},
    '/v1/test/catalog': CATALOG,
    CONTENT_PATH: {'schema_version': 1, 'branch_id': BRANCH, 'promos': [], 'games': []},
}


class Fixture:
    def __init__(self, mode='ok', path='/v1/capabilities'):
        self.mode = mode
        self.failure_path = path
        self.requests = []
        self.violations = []

    def count(self, path='/v1/capabilities'):
        return sum(request[1] == path for request in self.requests)

    def catalog_reads(self):
        # Promotions and availability have independent refresh lifecycles; they are not part
        # of the four-read catalog recovery transaction tested here.
        return sum(request[1] not in (CONTENT_PATH, '/v1/customer-checkout/availability') for request in self.requests)

    def route(self, route):
        request = route.request
        parsed = urlparse(request.url)
        path = parsed.path
        self.requests.append((request.method, path, time.monotonic()))
        if request.method != 'GET' or path not in READS:
            self.violations.append((request.method, path))
            route.abort('failed')
            return
        if path == '/v1/test/catalog':
            assert parse_qs(parsed.query).get('catalog_version') == ['mockup-v0.3']
        mode = self.mode if path == self.failure_path else 'ok'
        headers = {'Access-Control-Allow-Origin': '*'}
        if mode == 'transport':
            route.abort('failed')
        elif mode in ('503', '403'):
            route.fulfill(status=int(mode), json={'code': 'LOCAL_FIXTURE_FAILURE'}, headers=headers)
        elif mode == 'malformed-json':
            route.fulfill(content_type='application/json', body='{', headers=headers)
        elif mode == 'schema':
            data = copy.deepcopy(READS[path])
            data['products'] = 'invalid'
            route.fulfill(json=data, headers=headers)
        elif mode == 'forbidden-feature':
            data = copy.deepcopy(CAPABILITIES)
            data['features']['payments'] = True
            route.fulfill(json=data, headers=headers)
        else:
            route.fulfill(json=READS[path], headers=headers)


def no_design_fallback(page):
    expect(page.get_by_text('Образцы меню', exact=True)).not_to_be_visible()
    page.wait_for_function(
        '(key) => JSON.parse(localStorage.getItem(key) || "null")?.catalogMode === "server"',
        arg=PREFERENCES,
    )


def offline(page, received=False):
    expect(page.get_by_text('Нет свежего меню', exact=True)).to_be_visible(timeout=15000)
    expect(page.locator('[data-testid^="product-photo-"]')).to_have_count(24 if received else 0)
    no_design_fallback(page)


def online(page, timeout=12000):
    expect(page.locator('[data-testid^="product-photo-"]')).to_have_count(24, timeout=timeout)
    expect(page.get_by_test_id('product-pick-combo').get_by_text(SENTINEL, exact=True)).to_be_visible()
    expect(page.get_by_text('Нет свежего меню', exact=True)).not_to_be_visible()
    # Retained cards and a hidden error banner also occur during refresh. Wait
    # for the visible loading state to settle before counting completed reads.
    expect(page.get_by_text('Загружаем меню', exact=True)).not_to_be_visible()
    no_design_fallback(page)


def visibility(page, active):
    # RN Web's real AppState adapter reads document.visibilityState on this event.
    # We do not call application internals or inject an online status.
    page.evaluate("""(active) => window.dispatchEvent(new CustomEvent(
      'pickchick-fixture-visibility', {detail: active}))""", active)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    contexts = []
    fixtures = []
    errors = []

    def open_menu(fixture):
        context = browser.new_context(viewport={'width': 393, 'height': 852}, reduced_motion='reduce')
        contexts.append(context)
        fixtures.append(fixture)
        context.route('**/v1/**', fixture.route)
        context.add_init_script("""(() => {
          let active = true;
          Object.defineProperty(document, 'hidden', {get: () => !active});
          Object.defineProperty(document, 'visibilityState', {get: () => active ? 'visible' : 'hidden'});
          window.addEventListener('pickchick-fixture-visibility', event => {
            active = event.detail;
            document.dispatchEvent(new Event('visibilitychange'));
          });
        })();""")
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + '/menu')
        return page

    # A server failure and a failed fourth GET both recover without a click,
    # navigation, reload, simulated online event, or a bundled-menu fallback.
    for mode, path in [('503', '/v1/capabilities'), ('transport', '/v1/test/catalog')]:
        fixture = Fixture(mode, path)
        page = open_menu(fixture)
        offline(page)
        before = fixture.count(path)
        fixture.mode = 'ok'
        online(page)
        assert fixture.count(path) == before + 1, fixture.requests
        assert fixture.count() == 2, fixture.requests
        assert fixture.count(MENU_PATH) >= 1 and fixture.count('/v1/test/catalog') >= 1
        context = page.context
        context.close()
        contexts.remove(context)

    original_availability = READS['/v1/customer-checkout/availability']
    availability_path = '/v1/customer-checkout/availability'
    available = {'enabled': True, 'fresh': False, 'signature': 'b'*64,
                 'products': [{'id': product['id'], 'available': True, 'stoppedOptions': []} for product in CATALOG['products']]}
    READS[availability_path] = available
    availability_fixture = Fixture('transport', availability_path)
    availability_page = open_menu(availability_fixture)
    online(availability_page)
    availability_page.get_by_test_id('product-pick-combo').click()
    availability_page.get_by_test_id('product-add').click()
    availability_page.get_by_test_id('open-cart').click()
    expect(availability_page.get_by_test_id('cart-checkout')).to_be_enabled()
    expect(availability_page.get_by_text('Не удалось связаться с сервером. Проверьте интернет - связь проверяется автоматически.', exact=True)).to_have_count(0)
    expect(availability_page.get_by_test_id('cart-availability-refresh')).to_have_count(0)
    availability_fixture.mode = 'ok'
    before = availability_fixture.count(availability_path)
    availability_page.wait_for_timeout(2500)
    assert availability_fixture.count(availability_path) > before
    expect(availability_page.get_by_text('Нет свежих данных от ресторана. Проверяем связь автоматически.', exact=True)).to_have_count(0)
    expect(availability_page.get_by_test_id('cart-checkout')).to_be_enabled()
    available.update(fresh=True, signature='a'*64)
    expect(availability_page.get_by_test_id('cart-checkout')).to_be_enabled(timeout=5000)
    available.update(orderingOpen=False, hours={'openingTime':'10:00','closingTime':'00:00','timeZone':'Asia/Almaty'}, signature='c'*64)
    closed_reads = availability_fixture.count(availability_path)
    availability_page.wait_for_timeout(2500)
    assert availability_fixture.count(availability_path) > closed_reads
    expect(availability_page.get_by_text('Ресторан сейчас закрыт. Принимаем заказы с 10:00 до 00:00.', exact=True)).to_have_count(0)
    expect(availability_page.get_by_test_id('cart-checkout')).to_be_enabled()
    available.update(orderingOpen=True, signature='d'*64)
    expect(availability_page.get_by_test_id('cart-checkout')).to_be_enabled(timeout=5000)
    expect(availability_page.get_by_test_id('cart-quantity-pick-combo')).to_have_text('1')
    availability_page.context.close()
    contexts.remove(availability_page.context)
    READS[availability_path] = original_availability

    # Successful data remains visible when a foreground refresh fails; a later
    # real AppState foreground transition immediately restarts the public reads.
    retained = Fixture()
    page = open_menu(retained)
    online(page)
    retained.mode = '503'
    visibility(page, False)
    hidden_reads = retained.catalog_reads()
    page.wait_for_timeout(2200)
    assert retained.catalog_reads() == hidden_reads, 'Background refresh must be stopped'
    visibility(page, True)
    offline(page, received=True)
    expect(page.get_by_test_id('product-pick-combo').get_by_text(SENTINEL, exact=True)).to_be_visible()
    visibility(page, False)
    retained.mode = 'ok'
    paused_reads = retained.catalog_reads()
    page.wait_for_timeout(2200)
    assert retained.catalog_reads() == paused_reads, 'A scheduled retry leaked into background'
    foreground_at = time.monotonic()
    visibility(page, True)
    online(page)
    first_foreground_read = next(timestamp for _, _, timestamp in retained.requests
                                 if timestamp >= foreground_at)
    assert first_foreground_read - foreground_at < 1.8, 'Foreground should not wait for retry backoff'
    active_reads = retained.catalog_reads()
    visibility(page, True)
    page.wait_for_timeout(2300)
    assert retained.catalog_reads() == active_reads, ('Repeated active events must not multiply catalog reads', retained.requests)

    # Observe increasing jittered 2/5/15-second caps. Permanent protocol failures run
    # alongside it, so one observation window covers all non-retryable cases.
    permanent = []
    for mode, path in [('403', '/v1/capabilities'), ('forbidden-feature', '/v1/capabilities'),
                       ('malformed-json', '/v1/capabilities'), ('schema', '/v1/test/catalog')]:
        fixture = Fixture(mode, path)
        failed = open_menu(fixture)
        offline(failed)
        permanent.append((fixture, failed))
    exhausted = Fixture('503')
    failed = open_menu(exhausted)
    offline(failed)
    deadline = time.monotonic() + 30
    while exhausted.count() < 4 and time.monotonic() < deadline:
        failed.wait_for_timeout(100)
    assert exhausted.count() == 4, exhausted.requests
    offline(failed)
    attempt_times = [timestamp for _, path, timestamp in exhausted.requests if path == '/v1/capabilities']
    for actual, minimum in zip([b - a for a, b in zip(attempt_times, attempt_times[1:])], [1.4, 3.8, 11.8]):
        assert actual >= minimum, (attempt_times, minimum)
    # Recovery continues after the original three-retry budget, without a click.
    exhausted.mode = 'ok'
    online(failed, timeout=35000)
    assert exhausted.count() == 5, exhausted.requests
    for fixture, page in permanent:
        assert fixture.count() == 1, fixture.requests
        offline(page)
    assert errors == [], errors
    assert all(not fixture.violations for fixture in fixtures), [f.violations for f in fixtures]
    assert all(method == 'GET' for f in fixtures for method, _, _ in f.requests)
    count = sum(len(f.requests) for f in fixtures)
    for context in contexts:
        context.close()
    browser.close()
    print(json.dumps({'result': 'PASS', 'fixture_get_requests': count, 'real_orders_created': 0,
                      'checks': ['503 and transport auto recovery', '24 products retained after failure',
                                 'AppState background cancellation and foreground restart',
                                 'continuous retries with capped jitter', 'schema, forbidden feature and 403 stay offline']},
                     ensure_ascii=False))
