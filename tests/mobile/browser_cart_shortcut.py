"""Launch continuity and reordered storefront on local, read-only synthetic data."""
from browser_network import isolated_context, route_fixture
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from account_fixture import signed_in

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4186').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost')
OUT = ROOT / '.local/cart-shortcut/screens'
OUT.mkdir(parents=True, exist_ok=True)
CAT = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
    "import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js';console.log(JSON.stringify(testCompleteCatalog))"], cwd=ROOT, text=True))
BRANCH = CAT['branch_id']
errors = []


def fixture(route):
    assert route.request.method == 'GET', 'Launch and navigation must not mutate the backend'
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


with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in [(320, 568), (393, 852), (768, 1024), (852, 393)]:
        context = isolated_context(browser,viewport={'width': width, 'height': height}, has_touch=True, reduced_motion='reduce')
        signed_in(context)
        route_fixture(context,'**/v1/**', fixture)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + '/menu')
        expect(page.get_by_test_id('product-pick-combo')).to_be_visible(timeout=20000)
        expect(page.get_by_test_id('open-cart')).to_have_count(0)
        page.get_by_test_id('product-pick-combo').click()
        page.get_by_test_id('product-add').click()
        expect(page.get_by_test_id('screen-M09')).not_to_be_visible()
        page.get_by_test_id('open-cart').click()
        expect(page.get_by_test_id('cart-checkout')).to_be_visible()
        for route, screen in [('menu', 'M06'), ('events', 'M26'), ('orders', 'M19'), ('profile', 'M30')]:
            page.goto(URL + '/' + route)
            pill = page.get_by_test_id('open-cart')
            expect(pill).to_be_visible()
            expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
            expect(pill).to_contain_text('4 190')
            expect(page.get_by_test_id('cart-count')).to_have_text('1')
            footer = page.get_by_test_id('bottom-actions').filter(has=pill)
            expect(footer).to_have_css('background-color', 'rgba(0, 0, 0, 0)')
            expect(footer).to_have_css('position', 'absolute')
            expect(footer).to_have_css('pointer-events', 'none')
            box = pill.bounding_box()
            tab = page.get_by_test_id('tab-' + route).bounding_box()
            assert box['height'] >= 48 and box['y'] + box['height'] <= tab['y'], (box, tab)
            assert box['x'] >= 0 and box['x'] + box['width'] <= width
            for tid in ['cart-total', 'cart-count']:
                assert page.get_by_test_id(tid).evaluate('(e) => e.scrollWidth <= e.clientWidth + 1'), tid
            scroll = page.get_by_test_id('scroll-' + screen)
            if scroll.count():
                scroll.evaluate('(e) => e.scrollTop = e.scrollHeight')
            page.wait_for_timeout(400)
            page.screenshot(path=str(OUT / f'{route}-{width}.png'))
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            pill.click()
            expect(page.get_by_test_id('cart-checkout')).to_be_visible()
        page.get_by_test_id('cart-clear').click()
        page.get_by_test_id('cart-clear-confirm').click()
        page.goto(URL + '/events')
        expect(page.get_by_test_id('open-cart')).to_have_count(0)
        context.close()
    context = isolated_context(browser,viewport={'width': 393, 'height': 852}, reduced_motion='no-preference')
    signed_in(context)
    route_fixture(context,'**/v1/**', fixture)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL + '/menu')
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
    page.get_by_test_id('product-pick-combo').click()
    page.get_by_test_id('product-add').click()
    expect(page.get_by_test_id('screen-M09')).not_to_be_visible()
    page.get_by_test_id('open-cart').click()
    expect(page.get_by_test_id('cart-checkout')).to_be_visible()
    page.goto(URL + "/menu")
    expect(page.get_by_test_id("launch-reveal")).to_have_count(0)
    expect(page.get_by_test_id('open-cart')).to_be_visible()
    page.evaluate("""() => {
      window.cartMotionFrames = [];
      const start = performance.now();
      function tick() {
        document.querySelectorAll('[data-testid="cart-count-feedback"]').forEach(e => window.cartMotionFrames.push(getComputedStyle(e).transform));
        if (performance.now() - start < 650) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }""")
    page.get_by_test_id('tab-events').click()
    page.wait_for_timeout(700)
    frames = page.evaluate('window.cartMotionFrames')
    assert any(t not in ('none', 'matrix(1, 0, 0, 1, 0, 0)') for t in frames), frames
    page.emulate_media(reduced_motion='reduce')
    page.get_by_test_id('tab-profile').click()
    page.wait_for_timeout(100)
    for counter in page.get_by_test_id('cart-count-feedback').all():
        assert counter.evaluate('(e) => getComputedStyle(e).transform') in ('none', 'matrix(1, 0, 0, 1, 0, 0)')
    context.close()
    browser.close()
assert not errors, errors
print('PASS: four tabs / four sizes, transparent floating docks, readable count and amount, navigation and empty cart')
