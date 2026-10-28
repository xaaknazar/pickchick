"""Launch continuity and the Drinkit-style cart bar on local, read-only synthetic data.

Simulator export (no Kaspi checkout, local demo account): the bar shows the total only and the
photos of the last added items; the whole capsule opens the cart and has no Kaspi handle. The Kaspi
handle and slide to pay are covered by browser_slide_to_pay.py on the customer-auth export.
"""
from browser_network import isolated_context, route_fixture
import json
import os
import re
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
        for route, screen in [('menu', 'M06'), ('events', 'M26'), ('orders', 'M19')]:
            page.goto(URL + '/' + route)
            pill = page.get_by_test_id('open-cart')
            expect(pill).to_be_visible()
            expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
            expect(pill).to_contain_text('4 190')
            # Total only (owner): no count, label or time; photos of the last items on the right.
            expect(page.get_by_test_id('cart-shortcut-total')).to_have_text('4 190 ₸')
            # Icon glyphs (private use characters) aside, the total is the only text.
            assert re.sub(r'[\ue000-\uf8ff\s]', '', pill.inner_text()) == '4190₸', pill.inner_text()
            expect(page.get_by_test_id('cart-count')).to_have_count(0)
            expect(page.get_by_test_id('cart-recent-photo-0')).to_be_visible()
            expect(page.get_by_test_id('cart-recent-photo-1')).to_have_count(0)
            # Not a Kaspi checkout build: no payment handle, the whole capsule opens the cart.
            expect(page.get_by_test_id('cart-pay-handle')).to_have_count(0)
            # The bag pill lies on the handle's opaque base inside the capsule (on iOS 26 Apple's
            # glass cannot sample the capsule's glass) and has the common light rim.
            bag = page.get_by_test_id('cart-bag-pill')
            expect(bag).to_be_visible()
            expect(bag).to_have_css('background-color', 'rgb(7, 26, 68)')
            expect(bag).to_have_css('border-top-color', 'rgba(255, 255, 255, 0.3)')
            # Not inside the cart button, whose press dims its own content: Apple's glass under a
            # translucent parent renders wrong (QA 28.10). It still sits at the capsule's left.
            assert pill.locator('[data-testid="cart-bag-pill"]').count() == 0
            bag_box = bag.bounding_box()
            assert bag_box['x'] - page.get_by_test_id('cart-shortcut').bounding_box()['x'] <= 8, bag_box
            assert pill.get_by_test_id('cart-shortcut-total').bounding_box()['x'] >= bag_box['x'] + bag_box['width'], bag_box
            # Not the Kaspi checkout: the header keeps today's hours at any time of day, never the
            # «откроемся в ...» of the payment decision (QA 28.10).
            expect(page.get_by_test_id('screen-' + screen).get_by_test_id('header-hours')).to_have_text('10:00-00:00')
            capsule = page.get_by_test_id('cart-shortcut').bounding_box()
            assert abs(pill.bounding_box()['width'] - capsule['width']) <= 12, (pill.bounding_box(), capsule)
            footer = page.get_by_test_id('bottom-actions').filter(has=pill)
            expect(footer).to_have_css('background-color', 'rgba(0, 0, 0, 0)')
            # Owner 28.10.2026: the tab bar draws the bar in its own layer, stacked on the tab
            # capsule (never under it); see browser_cart_layer.py.
            expect(page.get_by_test_id('tab-cart-dock').filter(has=pill)).to_have_count(1)
            expect(footer).to_have_css('pointer-events', 'none')
            box = pill.bounding_box()
            tab = page.get_by_test_id('tab-' + route).bounding_box()
            assert box['height'] >= 48 and box['y'] + box['height'] <= tab['y'], (box, tab)
            # The shared header (logo, restaurant, profile) stays clear of the bar, also landscape.
            head = page.get_by_test_id('screen-' + screen).get_by_test_id('app-header-bar').bounding_box()
            assert head['y'] + head['height'] <= box['y'], (route, width, head, box)
            assert box['x'] >= 0 and box['x'] + box['width'] <= width
            for tid in ['cart-shortcut-total']:
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
    page.wait_for_timeout(700)
    # The customer comes back from a product with one more item: the newest photo settles in.
    # (Owner 28.10.2026: the tab bar draws the one bar, so a plain tab switch no longer replays it.)
    page.get_by_test_id('product-pick-combo').click()
    page.get_by_test_id('product-add').click()
    page.evaluate("""() => {
      window.cartMotionFrames = [];
      const start = performance.now();
      function tick() {
        document.querySelectorAll('[data-testid="cart-recent-feedback"]').forEach(e => window.cartMotionFrames.push(getComputedStyle(e).transform));
        if (performance.now() - start < 650) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }""")
    page.wait_for_timeout(700)
    frames = page.evaluate('window.cartMotionFrames')
    assert any(t not in ('none', 'matrix(1, 0, 0, 1, 0, 0)') for t in frames), frames
    page.emulate_media(reduced_motion='reduce')
    page.get_by_test_id('tab-orders').click()
    page.wait_for_timeout(100)
    for counter in page.get_by_test_id('cart-recent-feedback').all():
        assert counter.evaluate('(e) => getComputedStyle(e).transform') in ('none', 'matrix(1, 0, 0, 1, 0, 0)')
    context.close()
    # Last added items: up to three photos, newest first; adding again makes a product the newest.
    for width, height in [(393, 852), (320, 568)]:
        context = isolated_context(browser, viewport={'width': width, 'height': height}, reduced_motion='reduce')
        signed_in(context)
        route_fixture(context, '**/v1/**', fixture)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + '/menu')
        expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=20000)

        def add(product):
            page.get_by_test_id('product-' + product).click(timeout=20000)
            page.get_by_test_id('product-add').click()
            expect(page.get_by_test_id('screen-M09')).not_to_be_visible()

        def photos():
            return [page.get_by_test_id(f'cart-recent-photo-{i}').get_attribute('id')
                    for i in range(page.locator('[data-testid^="cart-recent-photo-"]').count())]

        for product in ['pick-combo', 'burger', 'wedges', 'coleslaw']:
            add(product)
        expect(page.get_by_test_id('cart-recent-photo-2')).to_be_visible()
        assert photos() == ['cart-recent-coleslaw', 'cart-recent-wedges', 'cart-recent-burger'], photos()
        page.wait_for_timeout(300)
        page.screenshot(path=str(OUT / f'four-items-{width}.png'))
        # Newest photo is drawn on top at the right end; all photos stay inside the bar.
        bar = page.get_by_test_id('cart-shortcut').bounding_box()
        boxes = [page.get_by_test_id(f'cart-recent-photo-{i}').bounding_box() for i in range(3)]
        assert boxes[0]['x'] > boxes[1]['x'] > boxes[2]['x'], boxes
        assert all(b['x'] >= bar['x'] and b['x'] + b['width'] <= bar['x'] + bar['width'] for b in boxes)
        total = page.get_by_test_id('cart-shortcut-total')
        assert total.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
        add('pick-combo')
        assert photos() == ['cart-recent-pick-combo', 'cart-recent-coleslaw', 'cart-recent-wedges'], photos()
        # The order is kept with the saved basket.
        page.reload()
        expect(page.get_by_test_id('cart-recent-photo-2')).to_be_visible(timeout=20000)
        assert photos() == ['cart-recent-pick-combo', 'cart-recent-coleslaw', 'cart-recent-wedges'], photos()
        # Tapping the photos or the total opens the cart (they are decorative parts of one button).
        for zone in ['cart-recent-photo-0', 'cart-shortcut-total']:
            box = page.get_by_test_id(zone).bounding_box()
            page.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
            expect(page.get_by_test_id('cart-checkout')).to_be_visible()
            page.get_by_test_id('cart-close').click()
            expect(page.get_by_test_id('screen-M09')).not_to_be_visible()
        context.close()
    browser.close()
assert not errors, errors
print('PASS: every tab / four sizes, transparent floating docks, total only, last three photos in add order '
      '(persisted), no Kaspi handle outside the Kaspi build (the bag pill on its opaque base), navigation and '
      'empty cart')
