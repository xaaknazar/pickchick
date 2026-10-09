"""Guest gates and login continuation; local fixtures only, no server writes."""
from browser_network import isolated_context, route_fixture
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
    '/v1/customer-checkout/availability': {'enabled': False, 'fresh': False, 'signature': 'disabled', 'products': []},
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
    visible(page, 'otp-input').fill('1234')
    visible(page, 'profile-gender-female').click()
    visible(page, 'nickname-save').click()


with sync_playwright() as p:
    browser = p.chromium.launch()
    # The welcome-to-input transition must finish before focusing the input;
    # repeated taps cannot skip steps or leave the content transparent.
    for preference in ['no-preference', 'reduce']:
        context = isolated_context(browser,viewport={'width': 390, 'height': 844}, reduced_motion=preference)
        route_fixture(context,'**/v1/**', route_api)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + '/auth?returnTo=M30')
        expect(visible(page, 'account-required-login')).to_be_visible(timeout=20000)
        page.evaluate('''() => {
          window.authFrames = [];
          window.authSampler = setInterval(() => {
            const layer = document.querySelector('[data-testid="auth-step-transition"]');
            const phone = document.querySelector('[data-testid="phone-input"]');
            if (layer) window.authFrames.push({
              opacity: Number(getComputedStyle(layer).opacity),
              transform: getComputedStyle(layer).transform,
              focused: !!phone && document.activeElement === phone
            });
          }, 16);
          const button = document.querySelector('[data-testid="account-required-login"]');
          button.click(); button.click();
        }''')
        expect(visible(page, 'phone-input')).to_be_focused()
        expect(visible(page, 'auth-step-transition')).to_have_css('opacity', '1')
        frames = page.evaluate('() => {clearInterval(window.authSampler); return window.authFrames;}')
        # Under CI load timers may sample only the end of the fade (e.g. .96).
        # Require an actual intermediate frame, not an arbitrary early threshold.
        assert any(0 < frame['opacity'] < 1 for frame in frames), frames
        assert not any(frame['focused'] and frame['opacity'] < .99 for frame in frames), frames
        if preference == 'reduce':
            assert all(frame['transform'] in ['none', 'matrix(1, 0, 0, 1, 0, 0)'] for frame in frames), frames
        expect(page.get_by_test_id('phone-input')).to_have_count(1)
        context.close()
    # Autofill may complete before the sheet entry animation. Sending then used
    # to create a challenge while navigation was still locked, stranding login.
    for preference in ['no-preference', 'reduce']:
        context = isolated_context(browser,viewport={'width': 393, 'height': 852}, reduced_motion=preference)
        route_fixture(context,'**/v1/**', route_api)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + '/auth?returnTo=M30')
        expect(visible(page, 'account-required-login')).to_be_visible()
        page.evaluate('''() => {
          window.earlySubmit = null;
          const timer = setInterval(() => {
            const phone = document.querySelector('[data-testid="phone-input"]');
            if (!phone) return;
            clearInterval(timer);
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
              .set.call(phone, '7000000000');
            phone.dispatchEvent(new Event('input', {bubbles: true}));
            requestAnimationFrame(() => {
              const button = document.querySelector('[data-testid="request-otp"]');
              window.earlySubmit = {
                opacity: Number(getComputedStyle(document.querySelector('[data-testid="auth-step-transition"]')).opacity),
                disabled: button.getAttribute('aria-disabled')
              };
              button.click();
            });
          }, 1);
          document.querySelector('[data-testid="account-required-login"]').click();
        }''')
        page.wait_for_function('window.earlySubmit !== null')
        early = page.evaluate('window.earlySubmit')
        assert early['opacity'] < .99 and early['disabled'] == 'true', early
        expect(visible(page, 'request-otp')).to_be_enabled()
        visible(page, 'request-otp').click()
        expect(visible(page, 'otp-input')).to_be_visible()
        expect(visible(page, 'demo-auth-error')).to_have_count(0)
        context.close()
    for destination, target in [('/games/pick-man', 'pick-man-start'), ('/games/pick-blocks', 'blocks-start'),
                                ('/screen/M12', 'test-checkout-create')]:
        context = isolated_context(browser,viewport={'width': 393, 'height': 852}, reduced_motion='reduce')
        route_fixture(context,'**/v1/**', route_api)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        if destination.endswith('M12'):
            page.goto(URL + '/menu')
            page.get_by_test_id('product-pick-combo').click()
            visible(page, 'product-add').click()
            expect(page.get_by_test_id('screen-M09')).not_to_be_visible()
            visible(page, 'open-cart').click()
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
            # Current checkout mockup returns to the preserved cart via its header.
            visible(page, 'checkout-close').click()
            expect(visible(page, 'confirm-otp')).to_have_count(0)
            expect(visible(page, 'screen-M09').get_by_text('Pick Combo', exact=True)).to_be_visible()
            expect(visible(page, 'cart-quantity-pick-combo')).to_have_text('1')
            visible(page, 'cart-checkout').click()
            expect(visible(page, target)).to_be_enabled()
        page.goto(URL + '/profile')
        visible(page, 'demo-sign-out').click()
        page.goto(URL + destination)
        expect(visible(page, 'account-required-login')).to_be_visible(timeout=20000)
        assert page.get_by_test_id(target).count() == 0
        context.close()

    context = isolated_context(browser,viewport={'width': 320, 'height': 568})
    route_fixture(context,'**/v1/**', route_api)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    for path in ['/screen/M13', '/orders']:
        page.goto(URL + path)
        expect(visible(page, 'account-required-login')).to_be_visible(timeout=20000)
        assert page.get_by_test_id('game-field').count() == 0
        assert page.get_by_test_id('test-payment-approve').count() == 0
    for path in ['/screen/M27', '/screen/M28', '/screen/M27?preview=1', '/screen/M28?preview=1']:
        page.goto(URL + path)
        expect(visible(page, 'account-required-login')).to_be_visible(timeout=20000)
        expect(page.get_by_test_id('pickrun-open')).to_have_count(0)
        expect(page.get_by_test_id('game-start')).to_have_count(0)
    context.close()
    # Unreadable persisted login must fail closed, with a retry instead of a game.
    context = isolated_context(browser,)
    route_fixture(context,'**/v1/**', route_api)
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
