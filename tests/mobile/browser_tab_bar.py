"""Floating tab bar (Luma pattern) on local, read-only synthetic data.

Usage: browser_tab_bar.py [--capture-only] [label]
  --capture-only  only save screenshots (used for the "before" baseline)
  label           screenshot folder under .local/tab-bar (default: after)
"""
from browser_network import isolated_context, route_fixture
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from account_fixture import signed_in

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4182').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost')
ARGS = [arg for arg in sys.argv[1:] if not arg.startswith('--')]
CAPTURE_ONLY = '--capture-only' in sys.argv
OUT = ROOT / '.local/tab-bar' / (ARGS[0] if ARGS else 'after')
OUT.mkdir(parents=True, exist_ok=True)
CAT = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
    "import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js';console.log(JSON.stringify(testCompleteCatalog))"], cwd=ROOT, text=True))
BRANCH = CAT['branch_id']
TABS = [('menu', 'M06', 'Меню'), ('events', 'M26', 'События'), ('orders', 'M19', 'Заказы'),
        ('profile', 'M30', 'Профиль')]
errors = []


def fixture(route):
    assert route.request.method == 'GET', 'Tab navigation must not mutate the backend'
    path = urlparse(route.request.url).path
    data = {
        '/v1/capabilities': {'schema_version': 1, 'environment': 'staging', 'data_mode': 'synthetic',
            'ordering_enabled': False, 'features': {'test_order_flow': True,
                **{key: False for key in ['phone_auth', 'payments', 'fiscal', 'checkout', 'loyalty']}}},
        '/v1/branches': {'branches': [{'id': BRANCH, 'code': 'TEST', 'name': 'Локальная проверка',
            'timezone': 'Asia/Almaty', 'ordering_enabled': False}]},
        '/v1/branches/' + BRANCH + '/menu': {'schema_version': 1, 'branch_id': BRANCH,
            'release_id': '10000000-0000-4000-8000-000000000008', 'version': 1,
            'published_at': '2026-09-07T00:00:00Z', 'items': []},
        '/v1/test/catalog': CAT,
    }
    if path in data:
        route.fulfill(json=data[path], headers={'Access-Control-Allow-Origin': '*'})
    else:
        route.abort()


def scroll_to_end(page, screen):
    scroll = page.get_by_test_id('scroll-' + screen)
    if scroll.count():
        scroll.evaluate('(e) => { e.scrollTop = e.scrollHeight; }')
    page.wait_for_timeout(300)


def last_content_bottom(page, screen):
    # Bottom edge of the last laid-out content block once the list is fully scrolled.
    return page.get_by_test_id('scroll-' + screen).evaluate('''(e) => {
      const content = e.firstElementChild;
      let bottom = 0;
      for (const child of content.children) {
        const r = child.getBoundingClientRect();
        if (r.height > 0) bottom = Math.max(bottom, r.bottom);
      }
      return bottom;
    }''')


def assert_floating_bar(page, width, height, active):
    bar = page.get_by_test_id('floating-tab-bar')
    expect(bar).to_be_visible()
    expect(page.get_by_role('tablist')).to_have_count(1)
    box = bar.bounding_box()
    # Inset capsule: clear of both edges and lifted above the bottom edge.
    assert box['x'] >= 8 and box['x'] + box['width'] <= width - 8, box
    gap = height - box['y'] - box['height']
    assert 8 <= gap <= 30, gap
    assert box['height'] <= 84, box
    radius = bar.evaluate('(e) => parseFloat(getComputedStyle(e).borderTopLeftRadius)')
    assert radius >= box['height'] / 2 - 1, radius
    glass = bar.evaluate('(e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).backdropFilter || getComputedStyle(e).webkitBackdropFilter]')
    assert glass[0] == 'rgba(10, 32, 80, 0.92)' and 'blur' in glass[1], glass
    for route, _, label in TABS:
        tab = page.get_by_test_id('tab-' + route)
        expect(tab).to_have_attribute('role', 'tab')
        expect(tab).to_have_attribute('aria-selected', 'true' if route == active else 'false')
        expect(tab).to_contain_text(label)
        tb = tab.bounding_box()
        assert tb['height'] >= 48 and tb['width'] >= 48, (route, tb)
        assert tb['y'] >= box['y'] - 1 and tb['y'] + tb['height'] <= box['y'] + box['height'] + 1
    pill = page.get_by_test_id('tab-' + active + '-pill')
    expect(pill).to_be_visible()
    expect(page.locator('[data-testid$="-pill"][data-testid^="tab-"]')).to_have_count(1)
    return box


with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in [(393, 852), (320, 568)]:
        context = isolated_context(browser, viewport={'width': width, 'height': height},
                                   has_touch=True, reduced_motion='reduce')
        signed_in(context)
        route_fixture(context, '**/v1/**', fixture)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + '/menu')
        expect(page.get_by_test_id('product-pick-combo')).to_be_visible(timeout=20000)
        expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=10000)
        page.wait_for_timeout(500)
        # Photo-heavy storefront: hero cover and product photos run under the bar.
        page.screenshot(path=str(OUT / f'menu-hero-{width}.png'))
        page.get_by_test_id('scroll-M06').evaluate('(e) => { e.scrollTop = Math.round(e.scrollHeight / 3); }')
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / f'menu-photos-{width}.png'))
        if not CAPTURE_ONLY:
            assert_floating_bar(page, width, height, 'menu')
        for route, screen, _ in TABS:
            page.get_by_test_id('tab-' + route).click()
            expect(page.get_by_test_id('screen-' + screen)).to_be_visible()
            page.wait_for_timeout(400)
            page.screenshot(path=str(OUT / f'{route}-{width}.png'))
            if CAPTURE_ONLY:
                continue
            box = assert_floating_bar(page, width, height, route)
            scroll_to_end(page, screen)
            assert last_content_bottom(page, screen) <= box['y'] + 1, (route, width)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        # Cart dock must sit above the floating bar and keep the content clear.
        page.get_by_test_id('tab-menu').click()
        page.get_by_test_id('scroll-M06').evaluate('(e) => { e.scrollTop = 0; }')
        page.get_by_test_id('product-pick-combo').click()
        page.get_by_test_id('product-add').click()
        expect(page.get_by_test_id('screen-M09')).not_to_be_visible()
        pill = page.get_by_test_id('open-cart')
        expect(pill).to_be_visible()
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / f'menu-cart-{width}.png'))
        if not CAPTURE_ONLY:
            for route, screen, _ in TABS:
                page.get_by_test_id('tab-' + route).click()
                expect(page.get_by_test_id('screen-' + screen)).to_be_visible()
                box = assert_floating_bar(page, width, height, route)
                cart = page.get_by_test_id('open-cart').bounding_box()
                assert 0 <= box['y'] - cart['y'] - cart['height'] <= 18, (route, cart, box)
                scroll_to_end(page, screen)
                assert last_content_bottom(page, screen) <= cart['y'] + 1, (route, width)
            page.screenshot(path=str(OUT / f'profile-cart-{width}.png'))
            page.get_by_test_id('open-cart').click()
            expect(page.get_by_test_id('cart-checkout')).to_be_visible()
        context.close()
    browser.close()
assert errors == [], errors
print('tab bar screenshots:', OUT)
