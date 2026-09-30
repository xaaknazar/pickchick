"""Source-composition and decorative-video regressions on an isolated local client."""
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlparse
from account_fixture import signed_in
from playwright.sync_api import expect, sync_playwright
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'operations'))
from kiosk_recovery import Fixture, BRANCH

url = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4182').rstrip('/')
assert urlparse(url).hostname in ('127.0.0.1', 'localhost')
output = Path('.local/fidelity/browser')
output.mkdir(parents=True, exist_ok=True)
fixture = Fixture()
branch_name = 'TEST · Алматы'

def fixture_read(route):
    assert route.request.method == 'GET', 'Visual tests must not create orders'
    path = urlparse(route.request.url).path
    data = {
        '/v1/capabilities': {'schema_version': 1, 'environment': 'staging', 'data_mode': 'synthetic',
            'ordering_enabled': False, 'features': {'test_order_flow': True,
            **{key: False for key in ['phone_auth', 'payments', 'fiscal', 'checkout', 'loyalty']}}},
        '/v1/branches': {'branches': [{'id': BRANCH, 'code': 'TEST', 'name': branch_name,
            'timezone': 'Asia/Almaty', 'ordering_enabled': False}]},
        '/v1/branches/' + BRANCH + '/menu': {'schema_version': 1, 'branch_id': BRANCH,
            'release_id': '10000000-0000-4000-8000-000000000008', 'version': 1,
            'published_at': '2026-09-06T00:00:00Z', 'items': []},
        '/v1/test/catalog': fixture.catalog,
    }
    if path in data:
        route.fulfill(json=data[path], headers={'Access-Control-Allow-Origin': '*'})
    else:
        route.abort()

def settled_catalog_geometry(page):
    # Read every dependent rectangle atomically, then require 150ms without
    # movement. Fixed sleeps and separate protocol calls mix animation frames
    # while the catalog's smooth anchor scroll is still settling on CI.
    previous = None
    stable_since = time.monotonic()
    deadline = stable_since + 5
    while time.monotonic() < deadline:
        current = page.get_by_role('heading', name='Напитки', exact=True).evaluate("""(section) => {
            const rect = (id) => document.querySelector(`[data-testid="${id}"]`)
                .getBoundingClientRect().toJSON();
            return { section: section.getBoundingClientRect().toJSON(),
                chip: rect('category-Напитки'),
                first: rect('product-photo-cat-4-0'), second: rect('product-photo-cat-4-1') };
        }""")
        if current != previous:
            stable_since = time.monotonic()
            previous = current
        elif time.monotonic() - stable_since >= 0.15:
            return current
        page.wait_for_timeout(40)
    raise AssertionError(f'Catalog geometry did not settle: {previous}')

with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={'width': 402, 'height': 874})
    signed_in(context)
    context.route('**/v1/**', fixture_read)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(url + '/menu')
    expect(page.get_by_test_id('hero-promotion')).to_be_visible(timeout=20000)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=5000)
    assert page.get_by_test_id('hero-video-toggle').count() == 0
    assert page.locator('video').count() == 1
    assert page.locator('video').evaluate('(v)=>!v.controls && v.muted && v.loop')
    hero = page.get_by_test_id('storefront-hero').bounding_box()
    title = page.get_by_text('Комбо недели', exact=True).bounding_box()
    # Owner update, 24 September: lift the storefront by 48px at this size.
    assert abs(hero['height'] - 756) < 1
    assert abs(title['x'] + title['width']/2 - 201) < 1, title
    # Owner decision: service mode is selected at checkout, never on the menu.
    expect(page.get_by_test_id('dining-takeaway')).to_have_count(0)
    expect(page.get_by_test_id('dining-dine_in')).to_have_count(0)
    # Owner update: loyalty precedes categories, which still pin below the header.
    header = page.get_by_test_id('storefront-header')
    branch = header.get_by_role('button', name='Выбрать ресторан', exact=True)
    notifications = page.get_by_test_id('storefront-notifications')
    assert branch.evaluate('(e)=>getComputedStyle(e).alignItems') == 'flex-start'
    assert notifications.bounding_box()['x'] > branch.bounding_box()['x'] + branch.bounding_box()['width']
    assert notifications.bounding_box()['width'] >= 44 and notifications.bounding_box()['height'] >= 44
    category = page.get_by_test_id('category-Комбо')
    expect(category).to_have_text('Комбо на одного')
    promo = page.get_by_test_id('hero-promotion').bounding_box()
    tab = category.bounding_box()
    loyalty = page.get_by_test_id('loyalty-card').bounding_box()
    assert promo['y'] + promo['height'] <= tab['y'], (promo, tab)
    assert loyalty['y'] + loyalty['height'] < tab['y'], (tab, loyalty)
    assert category.evaluate('(e)=>getComputedStyle(e).backgroundColor') == 'rgba(0, 0, 0, 0)'
    page.screenshot(path=str(output / 'menu.png'))
    notifications.click()
    expect(page.get_by_test_id('notifications-screen')).to_be_visible()
    page.get_by_test_id('notifications-back').click()
    expect(page.get_by_test_id('screen-M06')).to_be_visible()
    page.goto(url + '/menu')
    # Wait for the fixture catalog after navigation; before it arrives the hero
    # intentionally opens the fallback combo route instead of a selected product.
    expect(page.locator('[data-testid^="product-"][role="button"]').first).to_be_visible()
    page.get_by_test_id('hero-promotion').click()
    expect(page.get_by_test_id('photo-product-pick-combo')).to_be_visible()
    page.get_by_role('button', name='Закрыть блюдо', exact=True).click()
    expect(page.get_by_test_id('screen-M06')).to_be_visible()
    page.get_by_test_id('category-Комбо').click()
    page.wait_for_timeout(500)
    header = page.get_by_test_id('storefront-header').bounding_box()
    category = page.get_by_test_id('category-Комбо').bounding_box()
    assert category['y'] >= header['y'] + header['height'] - 1
    expect(page.get_by_test_id('product-pick-combo').get_by_text('Выбрать', exact=True)).to_be_visible()
    page.screenshot(path=str(output / 'catalog.png'))
    page.get_by_test_id('product-pick-combo').click()
    expect(page.get_by_test_id('photo-product-pick-combo')).to_be_visible()
    assert page.get_by_test_id('hero-video-toggle').count() == 0
    expect(page.get_by_test_id('product-add')).to_be_visible()
    page.screenshot(path=str(output / 'product.png'))
    page.get_by_test_id('product-add').click()
    expect(page.get_by_test_id('screen-M09')).not_to_be_visible()
    page.get_by_test_id('open-cart').click()
    expect(page.get_by_test_id('cart-checkout')).to_be_visible()
    page.screenshot(path=str(output / 'cart.png'))
    page.goto(url + '/profile')
    expect(page.get_by_text('QR для кассы', exact=True)).to_be_visible()
    expect(page.get_by_test_id('profile-combo-reward')).to_be_visible()
    page.screenshot(path=str(output / 'profile.png'))
    page.get_by_text('Мои Чики и уровни', exact=True).click()
    expect(page.get_by_test_id('screen-M23')).to_be_visible()
    page.screenshot(path=str(output / 'wallet.png'))
    page.goto(url + '/events')
    expect(page.get_by_test_id('screen-M26')).to_be_visible()
    page.screenshot(path=str(output / 'events.png'))
    # Category changes keep the selected anchor visible at narrow widths.
    base = fixture.catalog['products'][0]
    categories = ['Комбо', 'На двоих', 'На компанию', 'Допы', 'Напитки']
    fixture.catalog['products'] = [dict(base, id=f'cat-{i}-{j}', name=f'Пример {i}.{j}', category=cat)
        for i, cat in enumerate(categories) for j in range(6)]
    branch_name = 'TEST · Длинное название ресторана в торговом центре Алматы'
    for width in [320, 402]:
        page.set_viewport_size({'width': width, 'height': 874})
        page.goto(url + '/menu')
        last_category = page.get_by_test_id('category-Напитки')
        expect(last_category).to_be_visible()
        last_category.click()
        geometry = settled_catalog_geometry(page)
        chip, section = geometry['chip'], geometry['section']
        first, second = geometry['first'], geometry['second']
        assert chip['x'] >= 0 and chip['x'] + chip['width'] <= width + 1, chip
        assert section['y'] >= chip['y'] + chip['height'] - 1, (section, chip)
        assert abs(first['width'] - first['height']) < 1, first
        assert abs(first['y'] - second['y']) < 1 and second['x'] > first['x'], (first, second)
    assert errors == [], errors
    reduced = browser.new_context(viewport={'width': 390, 'height': 844}, reduced_motion='reduce')
    reduced.route('**/v1/**', fixture_read)
    reduced_page = reduced.new_page()
    reduced_page.goto(url + '/menu')
    expect(reduced_page.get_by_test_id('hero-promotion')).to_be_visible()
    assert reduced_page.locator('video').count() == 0, 'Reduced motion must use a still poster'
    assert reduced_page.get_by_test_id('hero-video-toggle').count() == 0
    # Deterministic browser-media races: never suppress pageerror. The adapter
    # owns each play() promise, including interruption before the first frame.
    interrupted = browser.new_context(viewport={'width': 402, 'height': 874})
    interrupted.route('**/v1/**', fixture_read)
    interrupted.add_init_script("""
        window.mediaCalls = { play: 0, pause: 0 };
        window.mediaHidden = false;
        Object.defineProperty(document, 'hidden', { get: () => window.mediaHidden });
        HTMLMediaElement.prototype.play = function () {
            window.mediaCalls.play++;
            return new Promise((_, reject) => setTimeout(() => reject(
                new DOMException('Playback superseded by navigation', 'AbortError')), 80));
        };
        const pause = HTMLMediaElement.prototype.pause;
        HTMLMediaElement.prototype.pause = function () {
            window.mediaCalls.pause++;
            return pause.call(this);
        };
    """)
    racing = interrupted.new_page()
    race_errors = []
    racing.on('pageerror', lambda error: race_errors.append(str(error)))
    racing.goto(url + '/menu')
    expect(racing.locator('video')).to_have_count(1)
    racing.wait_for_function('window.mediaCalls.play > 0')
    for _ in range(3):
        racing.get_by_test_id('hero-promotion').click()
        expect(racing.get_by_test_id('screen-M07')).to_be_visible()
        racing.get_by_role('button', name='Закрыть блюдо', exact=True).click()
        expect(racing.get_by_test_id('screen-M06')).to_be_visible()
    before_pause = racing.evaluate('window.mediaCalls.pause')
    racing.evaluate("window.mediaHidden = true; document.dispatchEvent(new Event('visibilitychange'))")
    racing.wait_for_function('(before) => window.mediaCalls.pause > before', arg=before_pause)
    before_play = racing.evaluate('window.mediaCalls.play')
    racing.evaluate("window.mediaHidden = false; document.dispatchEvent(new Event('visibilitychange'))")
    racing.wait_for_function('(before) => window.mediaCalls.play > before', arg=before_play)
    racing.emulate_media(reduced_motion='reduce')
    expect(racing.locator('video')).to_have_count(0)
    racing.wait_for_timeout(150)
    assert race_errors == [], race_errors

    unsupported = browser.new_context(viewport={'width': 402, 'height': 874})
    unsupported.route('**/v1/**', fixture_read)
    unsupported.add_init_script("""
        window.playAttempted = false;
        HTMLMediaElement.prototype.play = function () {
            window.playAttempted = true;
            return Promise.reject(new DOMException('Unsupported media', 'NotSupportedError'));
        };
    """)
    fallback = unsupported.new_page()
    fallback_errors = []
    fallback.on('pageerror', lambda error: fallback_errors.append(str(error)))
    fallback.goto(url + '/menu')
    fallback.wait_for_function('window.playAttempted')
    expect(fallback.locator('video')).to_have_count(0)
    expect(fallback.get_by_test_id('hero-promotion')).to_be_visible()
    assert fallback.get_by_test_id('storefront-hero').locator('img').count() >= 1
    assert fallback_errors == [], fallback_errors
    browser.close()
print('Mockup composition, product/cart navigation, reduced-motion, interrupted playback and poster fallback passed; no order writes')
