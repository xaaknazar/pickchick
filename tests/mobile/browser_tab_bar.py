"""Floating tab bar (Luma pattern) on local, read-only synthetic data.

Usage: browser_tab_bar.py [--capture-only] [label]
  --capture-only  only save screenshots (used for the "before" baseline)
  label           screenshot folder under .local/tab-bar (default: after)
"""
from browser_network import isolated_context, route_fixture
import json
import os
import re
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
# Owner 27.10.2026: exactly three tabs; the profile opens from the top header.
TABS = [('menu', 'M06', 'Меню'), ('events', 'M26', 'События'), ('orders', 'M19', 'Заказы')]
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
    expect(page.get_by_test_id('tab-profile')).to_have_count(0)
    expect(bar.get_by_role('tab')).to_have_count(3)
    # Three balanced items: equal widths, even spacing, labels never clipped.
    boxes = [page.get_by_test_id('tab-' + route).bounding_box() for route, _, _ in TABS]
    assert max(b['width'] for b in boxes) - min(b['width'] for b in boxes) <= 1, boxes
    assert abs((boxes[1]['x'] - boxes[0]['x']) - (boxes[2]['x'] - boxes[1]['x'])) <= 1, boxes
    assert boxes[0]['width'] >= 88, boxes
    for route, _, _ in TABS:
        label = page.get_by_test_id('tab-' + route).get_by_text(dict((r, l) for r, _, l in TABS)[route], exact=True)
        assert label.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1'), route
    return box


def assert_header(page, screen, width):
    # Same header on every tab: logo, restaurant, hours; one round profile button at the right.
    scope = page.get_by_test_id('screen-' + screen)
    button = scope.get_by_test_id('header-profile')
    expect(button).to_be_visible()
    expect(button).to_have_attribute('role', 'button')
    expect(button).to_have_accessible_name('Профиль')
    expect(scope.get_by_test_id('header-restaurant')).to_be_visible()
    b = button.bounding_box()
    assert b['width'] >= 44 and b['height'] >= 44, b
    assert abs(width - (b['x'] + b['width']) - 18) <= 1, (screen, b)
    assert b['y'] <= 24, (screen, b)
    # Owner answer: nothing about unread notifications outside the profile.
    # (the icon glyph is the only text; no counter, dot or extra element).
    assert not re.search(r'\w', button.evaluate('(e) => e.innerText'), re.UNICODE)
    assert button.evaluate('(e) => e.querySelectorAll("[data-testid]").length') == 0
    expect(page.get_by_test_id('storefront-notifications')).to_have_count(0)
    return b


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
        if not CAPTURE_ONLY:
            # Exercise repeated refocus without artificial waits between tab presses.
            # The native iOS detach regression still needs the owner/device checklist.
            for _ in range(20):
                page.get_by_test_id('tab-events').click()
                expect(page.get_by_test_id('screen-M26')).to_be_visible()
                page.get_by_test_id('tab-menu').click()
                expect(page.get_by_test_id('product-pick-combo')).to_be_visible()
        page.wait_for_timeout(500)
        # Photo-heavy storefront: hero cover and product photos run under the bar.
        page.screenshot(path=str(OUT / f'menu-hero-{width}.png'))
        page.get_by_test_id('scroll-M06').evaluate('(e) => { e.scrollTop = Math.round(e.scrollHeight / 3); }')
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / f'menu-photos-{width}.png'))
        if not CAPTURE_ONLY:
            # The collapsed storefront header is opaque: no product button shows through it.
            color = page.get_by_test_id('storefront-header').evaluate('(e) => getComputedStyle(e).backgroundColor')
            channels = [float(v) for v in re.findall(r'[\d.]+', color)]
            assert channels[:3] == [4, 20, 58] and channels[3:] in ([], [1.0]), color
            assert_floating_bar(page, width, height, 'menu')
        header = None
        for route, screen, _ in TABS:
            page.get_by_test_id('tab-' + route).click()
            expect(page.get_by_test_id('screen-' + screen)).to_be_visible()
            page.wait_for_timeout(400)
            page.screenshot(path=str(OUT / f'{route}-{width}.png'))
            if CAPTURE_ONLY:
                continue
            # The header does not move when switching tabs.
            position = assert_header(page, screen, width)
            assert header is None or abs(position['x'] - header['x']) <= 1 and abs(position['y'] - header['y']) <= 1
            header = position
            # As on the menu, the restaurant name opens the picker (M05); back returns to the tab.
            page.get_by_test_id('screen-' + screen).get_by_test_id('header-restaurant').click()
            expect(page.get_by_test_id('screen-M05')).to_be_visible()
            page.get_by_test_id('branches-back').click()
            expect(page.get_by_test_id('screen-' + screen)).to_be_visible()
            expect(page.get_by_test_id('screen-M05')).to_have_count(0)
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
                # The shared header never reaches the cart bar, also with the list scrolled.
                head = page.get_by_test_id('screen-' + screen).get_by_test_id('app-header-bar').bounding_box()
                assert head['y'] + head['height'] <= cart['y'], (route, head, cart)
            page.screenshot(path=str(OUT / f'orders-cart-{width}.png'))
            # The profile is a stack screen: no tab bar and no cart dock above it.
            page.get_by_test_id('screen-M19').get_by_test_id('header-profile').click()
            expect(page.get_by_test_id('screen-M30')).to_be_visible()
            expect(page.get_by_test_id('floating-tab-bar').filter(visible=True)).to_have_count(0)
            expect(page.get_by_test_id('open-cart').filter(visible=True)).to_have_count(0)
            scroll_to_end(page, 'M30')
            assert last_content_bottom(page, 'M30') <= height + 1
            page.screenshot(path=str(OUT / f'profile-cart-{width}.png'))
            page.get_by_test_id('profile-back').click()
            expect(page.get_by_test_id('screen-M19')).to_be_visible()
            expect(page.get_by_test_id('floating-tab-bar')).to_be_visible()
            page.get_by_test_id('open-cart').filter(visible=True).click()
            expect(page.get_by_test_id('cart-checkout')).to_be_visible()
        context.close()
    if not CAPTURE_ONLY:
        # Wider than a phone (tablet-size web): every tab shares one width cap (760, gutter 18),
        # so the profile button does not jump between tabs and profile settings sits under it.
        width, height = 1024, 768
        context = isolated_context(browser, viewport={'width': width, 'height': height}, reduced_motion='reduce')
        signed_in(context)
        route_fixture(context, '**/v1/**', fixture)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + '/menu')
        expect(page.get_by_test_id('product-pick-combo')).to_be_visible(timeout=20000)
        expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=10000)
        expected = (width + 760) / 2 - 18 - 48
        for route, screen, _ in TABS:
            page.get_by_test_id('tab-' + route).click()
            expect(page.get_by_test_id('screen-' + screen)).to_be_visible()
            b = page.get_by_test_id('screen-' + screen).get_by_test_id('header-profile').bounding_box()
            assert abs(b['x'] - expected) <= 1 and b['y'] <= 24, (route, b, expected)
        page.screenshot(path=str(OUT / f'orders-{width}.png'))
        page.get_by_test_id('screen-M19').get_by_test_id('header-profile').click()
        expect(page.get_by_test_id('screen-M30')).to_be_visible()
        settings = page.get_by_test_id('profile-settings').bounding_box()
        assert abs(settings['x'] - expected) <= 1, (settings, expected)
        context.close()
    browser.close()
assert errors == [], errors
print('tab bar: 3 tabs, header profile at one spot on all tabs (320/393/1024), opaque collapsed menu header, '
      'profile stack screen without bar/cart; screenshots:', OUT)
