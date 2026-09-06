"""Source-composition and decorative-video regressions on an isolated local client."""
import os
import sys
from pathlib import Path
from urllib.parse import urlparse
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

with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={'width': 402, 'height': 874})
    context.route('**/v1/**', fixture_read)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(url + '/menu')
    expect(page.get_by_test_id('hero-promotion')).to_be_visible(timeout=20000)
    assert page.get_by_test_id('hero-video-toggle').count() == 0
    assert page.locator('video').count() == 1
    assert page.locator('video').evaluate('(v)=>!v.controls && v.muted && v.loop')
    hero = page.get_by_test_id('storefront-hero').bounding_box()
    title = page.get_by_text('Комбо недели', exact=True).bounding_box()
    assert abs(hero['height'] - 660) < 1
    assert abs(title['x'] + title['width']/2 - 201) < 1, title
    selected = page.get_by_test_id('dining-takeaway')
    assert selected.evaluate('(e)=>getComputedStyle(e).backgroundColor') == 'rgb(255, 255, 255)'
    page.screenshot(path=str(output / 'menu.png'))
    page.get_by_test_id('category-Комбо').click()
    page.wait_for_timeout(500)
    header = page.get_by_test_id('storefront-header').bounding_box()
    category = page.get_by_test_id('category-Комбо').bounding_box()
    assert category['y'] >= header['y'] + header['height'] - 1
    expect(page.get_by_test_id('product-pick-combo').get_by_text('Выбрать', exact=True)).to_be_visible()
    page.screenshot(path=str(output / 'catalog.png'))
    page.get_by_test_id('product-pick-combo').click()
    expect(page.get_by_test_id('screen-M07')).to_be_visible()
    assert page.get_by_test_id('hero-video-toggle').count() == 0
    expect(page.get_by_test_id('product-add')).to_be_visible()
    page.screenshot(path=str(output / 'product.png'))
    page.get_by_test_id('product-add').click()
    expect(page.get_by_test_id('cart-checkout')).to_be_visible()
    page.screenshot(path=str(output / 'cart.png'))
    page.goto(url + '/profile')
    expect(page.get_by_text('QR для кассы', exact=True)).to_be_visible()
    expect(page.get_by_text('БАЛАНС', exact=True)).to_be_visible()
    page.screenshot(path=str(output / 'profile.png'))
    page.get_by_text('Мои Чики и уровни', exact=True).click()
    expect(page.get_by_test_id('screen-M23')).to_be_visible()
    page.screenshot(path=str(output / 'wallet.png'))
    page.goto(url + '/events')
    expect(page.get_by_test_id('screen-M26')).to_be_visible()
    page.screenshot(path=str(output / 'events.png'))
    # Long restaurant names and category changes keep the selected anchor visible.
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
        page.wait_for_timeout(700)
        chip = last_category.bounding_box()
        assert chip['x'] >= 0 and chip['x'] + chip['width'] <= width + 1, chip
        section = page.get_by_role('heading', name='Напитки', exact=True).bounding_box()
        assert section['y'] >= chip['y'] + chip['height'] - 1, (section, chip)
        first = page.get_by_test_id('product-photo-cat-4-0').bounding_box()
        second = page.get_by_test_id('product-photo-cat-4-1').bounding_box()
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
    browser.close()
print('Mockup composition, product/cart navigation and reduced-motion checks passed; no order writes')
