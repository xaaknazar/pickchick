"""Selection clarity and destructive-action recovery using local synthetic fixtures only."""
import copy
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright
from account_fixture import signed_in

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4186').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost')
OUT = ROOT / '.local/ux-guidance/screens'
OUT.mkdir(parents=True, exist_ok=True)
CATALOG = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
    "import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js';console.log(JSON.stringify(testCompleteCatalog))"], cwd=ROOT, text=True))
BRANCH = CATALOG['branch_id']
KEY = 'pickchick.mobile.preferences.v1'
errors = []
mutations = []


def fixture(catalog):
    def handle(route):
        path = urlparse(route.request.url).path
        if route.request.method != 'GET':
            mutations.append(path)
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
            '/v1/test/catalog': catalog,
        }
        if path in data:
            route.fulfill(json=data[path], headers={'Access-Control-Allow-Origin': '*'})
        else:
            route.abort()
    return handle


def saved(page):
    return page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY)


def open_combo(page):
    page.goto(URL + '/menu')
    page.get_by_test_id('product-pick-combo').click(timeout=20000)
    expect(page.get_by_test_id('product-add')).to_be_visible()


def capture(page, name):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(OUT / (name + '.png')))


with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in [(320, 568), (393, 852), (768, 1024), (852, 393)]:
        context = browser.new_context(viewport={'width': width, 'height': height},
            has_touch=True, reduced_motion='reduce')
        signed_in(context)
        context.route('**/v1/**', fixture(CATALOG))
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        open_combo(page)
        close = page.get_by_test_id('product-close').bounding_box()
        assert close['width'] >= 48 and close['height'] >= 48
        expect(page.get_by_test_id('modifier-drink-cola-bottle')).to_have_attribute('aria-checked', 'true')
        expect(page.get_by_test_id('modifier-drink-cola-bottle')).to_contain_text('Включено')
        page.get_by_test_id('modifier-expand-drink').click()
        page.get_by_test_id('modifier-drink-water').click()
        expect(page.get_by_test_id('modifier-drink-water')).to_have_attribute('aria-checked', 'true')
        page.get_by_test_id('modifier-expand-drink').click()
        expect(page.get_by_test_id('modifier-drink-water')).to_have_count(0)
        summary = page.get_by_test_id('modifier-selection-drink')
        expect(summary).to_contain_text('Bonaqua')
        summary.scroll_into_view_if_needed()
        capture(page, f'selection-{width}')
        expect(page.get_by_test_id('product-add')).to_have_text('Добавить · 4 190 ₸')
        page.get_by_test_id('product-add').click()
        expect(page.get_by_test_id('screen-M09')).not_to_be_visible()
        page.get_by_test_id('open-cart').click()
        expect(page.get_by_test_id('cart-clear')).to_be_enabled()
        page.wait_for_function('(key) => JSON.parse(localStorage.getItem(key))?.lines.length === 1', arg=KEY)
        original = saved(page)
        assert any(s['option_id'] == 'water' for s in original['lines'][0]['selections'])
        page.get_by_test_id('cart-clear').click()
        expect(page.get_by_test_id('cart-clear-dialog')).to_be_visible()
        assert saved(page) == original
        page.get_by_test_id('cart-clear-cancel').click()
        expect(page.get_by_test_id('cart-clear-dialog')).not_to_be_visible()
        assert saved(page) == original
        page.reload()
        expect(page.get_by_test_id('cart-clear')).to_be_enabled()
        assert saved(page) == original
        page.get_by_test_id('cart-clear').click()
        expect(page.get_by_test_id('cart-clear-dialog')).to_be_visible()
        page.wait_for_function("""() => {
            let node = document.querySelector('[data-testid="cart-clear-dialog"]');
            if (!node) return false;
            while (node) {
                if (Number(getComputedStyle(node).opacity) < .999) return false;
                node = node.parentElement;
            }
            return true;
        }""")
        capture(page, f'clear-{width}')
        page.get_by_test_id('cart-clear-confirm').click()
        expect(page.get_by_text('Здесь пока тихо', exact=True)).to_be_visible()
        page.wait_for_function('(key) => JSON.parse(localStorage.getItem(key))?.lines.length === 0', arg=KEY)
        expect(page.get_by_test_id('cart-clear')).to_be_disabled()
        context.close()

    # Server-defined optional single-choice groups must permit returning to no extra.
    # A required group with no default must explain the disabled purchase action.
    catalog = copy.deepcopy(CATALOG)
    combo = catalog['products'][0]
    drink = combo['modifier_groups'][0]
    for option in drink['options']:
        option['default_quantity'] = 0
    sauce = combo['modifier_groups'][1]
    sauce['min'] = 0
    for option in sauce['options']:
        option['default_quantity'] = 0
    context = browser.new_context(viewport={'width': 320, 'height': 568}, reduced_motion='reduce')
    signed_in(context)
    context.route('**/v1/**', fixture(catalog))
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    open_combo(page)
    expect(page.get_by_test_id('product-add')).to_be_disabled()
    expect(page.get_by_test_id('product-add-reason')).to_be_visible()
    expect(page.get_by_test_id('product-add-reason')).to_contain_text('напиток на выбор')
    capture(page, 'required-choice-320')
    page.get_by_test_id('modifier-drink-lemonade').click()
    expect(page.get_by_test_id('product-add-reason')).to_have_count(0)
    expect(page.get_by_test_id('product-add')).to_be_enabled()
    expect(page.get_by_test_id('modifier-none-sauce')).to_have_attribute('aria-checked', 'true')
    page.get_by_test_id('modifier-sauce-hot').click()
    expect(page.get_by_test_id('modifier-none-sauce')).to_have_attribute('aria-checked', 'false')
    page.get_by_test_id('modifier-none-sauce').click()
    expect(page.get_by_test_id('modifier-none-sauce')).to_have_attribute('aria-checked', 'true')
    page.get_by_test_id('product-add').click()
    expect(page.get_by_test_id('screen-M09')).not_to_be_visible()
    page.get_by_test_id('open-cart').click()
    page.wait_for_function('(key) => JSON.parse(localStorage.getItem(key))?.lines.length === 1', arg=KEY)
    assert not any(s['group_id'] == 'sauce' for s in saved(page)['lines'][0]['selections'])
    context.close()
    browser.close()
assert not errors, errors
assert not mutations, mutations
print('PASS: 4 viewports, collapsed selection/price, radio semantics, required/optional choices, clear cancel/confirm/persistence, no API mutations or runtime errors')
