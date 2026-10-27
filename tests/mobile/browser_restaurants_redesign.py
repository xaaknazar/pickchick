"""M05 «Наши рестораны» redesign: open/closed states on local synthetic fixtures only.

Run against an exported web build (see CI): MOBILE_RECOVERY_URL=http://127.0.0.1:4182.
Time is frozen with Playwright's clock; Almaty is UTC+5.
"""
from browser_network import isolated_context, route_fixture
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4182').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost')
OUT = Path(os.environ.get('RESTAURANTS_SCREENSHOTS', ROOT / '.local/restaurants-redesign'))
OUT.mkdir(parents=True, exist_ok=True)
CATALOG = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
    "import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js';"
    "console.log(JSON.stringify(testCompleteCatalog))"], cwd=ROOT, text=True))
BRANCH = CATALOG['branch_id']
MAP_URL = 'https://2gis.kz/almaty/geo/70030076952394244'
errors = []
opened = []


def fixture(route):
    path = urlparse(route.request.url).path
    if route.request.method != 'GET':
        errors.append('unexpected mutation ' + path)
        route.abort()
        return
    data = {
        '/v1/capabilities': {'schema_version': 1, 'environment': 'staging', 'data_mode': 'synthetic',
            'ordering_enabled': False, 'features': {'test_order_flow': True,
                **{k: False for k in ['phone_auth', 'payments', 'fiscal', 'checkout', 'loyalty']}}},
        '/v1/branches': {'branches': [{'id': BRANCH, 'code': 'TEST', 'name': 'Локальная проверка',
            'timezone': 'Asia/Almaty', 'ordering_enabled': False}]},
        '/v1/branches/' + BRANCH + '/menu': {'schema_version': 1, 'branch_id': BRANCH,
            'release_id': '10000000-0000-4000-8000-000000000008', 'version': 1,
            'published_at': '2026-09-07T00:00:00Z', 'items': []},
        '/v1/test/catalog': CATALOG,
    }
    if path in data:
        route.fulfill(json=data[path], headers={'Access-Control-Allow-Origin': '*'})
    else:
        route.abort()


def box(page, test_id):
    return page.get_by_test_id(test_id).bounding_box()


def open_screen(browser, almaty_hour, width=393, height=852):
    context = isolated_context(browser, viewport={'width': width, 'height': height},
        device_scale_factor=2, has_touch=True, reduced_motion='reduce')
    route_fixture(context, '**/v1/**', fixture)
    # On web, expo-linking navigates to the 2GIS page; record it instead of leaving the fixture network.
    route_fixture(context, 'https://2gis.kz/**', lambda route: (opened.append(route.request.url),
        route.fulfill(status=200, content_type='text/html', body='<title>2GIS</title>')))
    context.clock.set_fixed_time(datetime(2026, 10, 12, almaty_hour - 5, 0, tzinfo=timezone.utc)
        if almaty_hour >= 5 else datetime(2026, 10, 11, almaty_hour + 19, 0, tzinfo=timezone.utc))
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL + '/screen/M05')
    expect(page.get_by_test_id('branch-' + BRANCH)).to_be_visible(timeout=20000)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=10000)
    page.wait_for_function("""() => [...document.querySelectorAll('[data-testid="branches-map"] img')]
        .some((img) => img.complete && img.naturalWidth > 1000)""", timeout=10000)
    return context, page


def check_layout(page, state):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    text = page.evaluate('document.body.innerText')
    assert '—' not in text, 'UI text uses a plain hyphen, never a long dash'
    for label in ['Адрес', 'Часы работы', 'Получение']:
        assert label not in text, f'The owner removed the «{label}» label'
    expect(page.get_by_role('heading', name='Рестораны', exact=True)).to_be_visible()
    expect(page.get_by_test_id('branches-summary')).to_have_text('Алматы · 1 ресторан')
    row = page.get_by_test_id('branch-' + BRANCH)
    expect(row).to_contain_text('ТЦ Abay Plaza')
    expect(row).to_contain_text('4-й микрорайон, 10Б, Алматы')
    expect(row).to_have_attribute('aria-checked', 'true')
    status = page.get_by_test_id('branch-status-' + BRANCH)
    if state == 'open':
        expect(status).to_have_text('Открыто · до 00:00')
        expect(page.get_by_test_id('branches-caption')).to_have_text(
            'При смене ресторана корзина проверяется заново')
        expect(page.get_by_test_id('branches-menu')).to_have_text('Перейти в меню')
    else:
        expect(status).to_have_text('Закрыто · откроется в 10:00')
        expect(page.get_by_test_id('branches-caption')).to_have_text('Заказ можно оформить с 10:00')
        expect(page.get_by_test_id('branches-menu')).to_have_text('Посмотреть меню')
    expect(page.get_by_test_id('map-attribution')).to_have_text('© OpenStreetMap')

    viewport = page.viewport_size
    map_box = box(page, 'branches-map')
    assert map_box['y'] == 0 and abs(map_box['height'] - 320) < 1 and abs(map_box['width'] - viewport['width']) < 1
    title = page.get_by_role('heading', name='Рестораны', exact=True).bounding_box()
    assert 300 < title['y'] < 340, title
    for test_id in ['branches-back', 'branches-city', 'branch-' + BRANCH, 'branch-map-' + BRANCH,
                    'branches-menu']:
        rect = box(page, test_id)
        assert rect['height'] >= 44 and rect['width'] >= 44, (test_id, rect)
    # The back button over the map is the shared round glass button (owner 27.10.2026).
    back = page.get_by_test_id('branches-back')
    expect(back).to_have_accessible_name('Назад')
    assert back.evaluate("""(el) => [el, ...el.querySelectorAll('*')].some((n) =>
      (getComputedStyle(n).backdropFilter || getComputedStyle(n).webkitBackdropFilter || '').includes('blur'))"""), \
        'branches-back is glass'
    rect = box(page, 'branches-back')
    assert abs(rect['width'] - rect['height']) < 1 and abs(rect['x'] - 16) < 1, rect
    button = box(page, 'branches-menu')
    assert abs(button['height'] - 54) < 1 and abs(button['x'] - 16) < 1, button
    assert button['y'] + button['height'] <= viewport['height'] - 16, button
    # The pin's tip marks the restaurant: centred, above the sheet.
    pin = box(page, 'branch-pin-' + BRANCH)
    assert abs(pin['x'] + pin['width'] / 2 - viewport['width'] / 2) < 1.5, pin
    assert 130 < pin['y'] + 55 < 170, pin
    drop = page.get_by_test_id('branch-pin-drop-' + BRANCH).evaluate(
        'element => getComputedStyle(element).backgroundColor')
    assert drop == ('rgb(255, 105, 0)' if state == 'open' else 'rgba(147, 166, 201, 0.7)'), drop


with sync_playwright() as p:
    browser = p.chromium.launch()
    for state, hour in [('open', 12), ('closed', 3)]:
        context, page = open_screen(browser, hour)
        check_layout(page, state)
        page.screenshot(path=str(OUT / f'restaurants-{state}.png'))

        page.get_by_test_id('branches-city').click()
        expect(page.get_by_test_id('branches-city-option')).to_be_visible()
        expect(page.get_by_test_id('branches-city-option')).to_have_attribute('aria-checked', 'true')
        if state == 'open':
            page.screenshot(path=str(OUT / 'restaurants-city.png'))
        page.get_by_test_id('branches-city-option').click()
        expect(page.get_by_test_id('branches-city-option')).to_have_count(0)

        page.get_by_test_id('branches-menu').click()
        page.wait_for_url('**/menu', timeout=10000)
        context.close()

    # 2GIS: the web build has no app to try and opens the configured map page.
    context, page = open_screen(browser, 12)
    page.get_by_test_id('branch-map-' + BRANCH).click()
    page.wait_for_url(MAP_URL, timeout=10000)
    assert opened == [MAP_URL], opened
    context.close()

    # Choosing the restaurant itself keeps the previous behaviour: select and open its menu.
    context, page = open_screen(browser, 12)
    page.get_by_test_id('branch-' + BRANCH).click()
    page.wait_for_url('**/menu', timeout=10000)
    context.close()

    # Small phones scroll the sheet; the menu action stays reachable.
    context, page = open_screen(browser, 12, 320, 568)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    expect(page.get_by_test_id('branches-menu')).to_be_in_viewport()
    page.screenshot(path=str(OUT / 'restaurants-320.png'))
    context.close()
    browser.close()

assert not errors, errors
print('restaurants redesign: open/closed states, 2GIS fallback and navigation checked;', OUT)
