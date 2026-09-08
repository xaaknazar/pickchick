"""Guest gates and login continuation; local fixtures only, no server writes."""
import os
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'operations'))
from kiosk_recovery import Fixture, BRANCH

URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4182').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost')
OUTPUT = Path('.local/account-required')
OUTPUT.mkdir(parents=True, exist_ok=True)
fixture = Fixture()
reads = {
    '/v1/capabilities': {'schema_version': 1, 'environment': 'staging', 'data_mode': 'synthetic',
        'ordering_enabled': False, 'features': {'test_order_flow': True, **{key: False for key in ['phone_auth', 'payments', 'fiscal', 'checkout', 'loyalty']}}},
    '/v1/branches': {'branches': [{'id': BRANCH, 'code': 'TEST', 'name': 'UI fixture',
        'timezone': 'Asia/Almaty', 'ordering_enabled': False}]},
    '/v1/branches/' + BRANCH + '/menu': {'schema_version': 1, 'branch_id': BRANCH,
        'release_id': '10000000-0000-4000-8000-000000000008', 'version': 1,
        'published_at': '2026-09-06T00:00:00Z', 'items': []},
    '/v1/test/catalog': fixture.catalog,
}
errors, writes = [], []


def route_api(route):
    if route.request.method != 'GET':
        writes.append(route.request.method + ' ' + route.request.url)
    data = reads.get(urlparse(route.request.url).path)
    if data is not None and route.request.method == 'GET':
        route.fulfill(json=data, headers={'Access-Control-Allow-Origin': '*'})
    else:
        route.abort()


def visible(page, test_id):
    return page.locator('[data-testid="' + test_id + '"]:visible')


def login(page):
    visible(page, 'account-required-login').click()
    visible(page, 'phone-input').fill('7000000000')
    visible(page, 'request-otp').click()
    visible(page, 'otp-input').fill('123456')
    visible(page, 'confirm-otp').click()
    visible(page, 'profile-fill-later').click()


with sync_playwright() as p:
    browser = p.chromium.launch()
    for destination, target in [('/games/pick-blocks', 'blocks-start'), ('/screen/M27', 'game-start'),
                                ('/screen/M12', 'test-checkout-create')]:
        context = browser.new_context(viewport={'width': 393, 'height': 852}, reduced_motion='reduce')
        context.route('**/v1/**', route_api)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        if destination.endswith('M12'):
            page.goto(URL + '/menu')
            page.get_by_test_id('product-pick-combo').click()
            visible(page, 'product-add').click()
            visible(page, 'cart-checkout').click()
        else:
            page.goto(URL + destination)
        expect(visible(page, 'account-required-login')).to_be_visible(timeout=20000)
        assert page.get_by_test_id(target).count() == 0
        assert page.get_by_test_id('game-field').count() == 0
        assert page.get_by_test_id('blocks-board').count() == 0
        page.screenshot(path=str(OUTPUT / ('guest-' + destination.split('/')[-1] + '.png')))
        login(page)
        expect(visible(page, target)).to_be_visible(timeout=20000)
        if target == 'blocks-start':
            visible(page, target).click()
            expect(visible(page, 'blocks-board')).to_be_visible()
        if destination.endswith('M12'):
            expect(visible(page, target)).to_be_enabled()
            expect(visible(page, 'screen-M12').get_by_text('1 × Pick Combo', exact=False)).to_be_visible()
        page.goto(URL + '/profile')
        visible(page, 'demo-sign-out').click()
        page.goto(URL + destination)
        expect(visible(page, 'account-required-login')).to_be_visible(timeout=20000)
        assert page.get_by_test_id(target).count() == 0
        context.close()

    context = browser.new_context(viewport={'width': 320, 'height': 568})
    context.route('**/v1/**', route_api)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    for path in ['/screen/M27?preview=1', '/screen/M28', '/screen/M13', '/orders']:
        page.goto(URL + path)
        expect(visible(page, 'account-required-login')).to_be_visible(timeout=20000)
        assert page.get_by_test_id('game-field').count() == 0
        assert page.get_by_test_id('test-payment-approve').count() == 0
    context.close()
    # Unreadable persisted login must fail closed, with a retry instead of a game.
    context = browser.new_context()
    context.route('**/v1/**', route_api)
    context.add_init_script("""const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function(key) {
        if (key === 'pickchick.demo.profile.v1') throw new Error('fixture read failure');
        return get.call(this, key);
      };""")
    page = context.new_page()
    page.goto(URL + '/games/pick-blocks')
    expect(page.get_by_test_id('profile-restore-retry')).to_be_visible(timeout=20000)
    assert page.get_by_test_id('blocks-board').count() == 0
    context.close()
    assert not errors, errors
    assert not writes, writes
    browser.close()
print('PASS: guest routes, both games, checkout/cart continuation, logout, preview bypass and restore failure; zero API writes.')
