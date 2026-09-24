"""Launch continuity and reordered storefront on local, read-only synthetic data."""
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
OUT = ROOT / '.local/splash-menu-flow/screens'
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


TRACK = """(() => {
  window.launchFrames = [];
  const tick = () => {
    const logo = document.querySelector('[data-testid="launch-logo"]');
    const overlay = document.querySelector('[data-testid="launch-reveal"]');
    if (logo && overlay) {
      const b = logo.getBoundingClientRect();
      window.launchFrames.push({ width: b.width, opacity: Number(getComputedStyle(overlay).opacity) });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in [(320, 568), (393, 852), (768, 1024), (852, 393)]:
        context = browser.new_context(viewport={'width': width, 'height': height},
            has_touch=True, reduced_motion='reduce')
        context.add_init_script(TRACK)
        signed_in(context)
        context.route('**/v1/**', fixture)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + '/')
        expect(page.get_by_test_id('screen-M06')).to_be_visible(timeout=20000)
        expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=5000)
        frames = page.evaluate('window.launchFrames')
        assert frames and max(f['width'] for f in frames) <= 320.1, frames[-5:]
        page.wait_for_function('''() => {
            const r = id => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
            const loyalty = r('loyalty-card'), chip = r('category-Комбо');
            return loyalty && chip && chip.top >= loyalty.bottom - 1;
        }''')
        geometry = page.evaluate('''() => {
            const r = id => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().toJSON();
            return {loyalty:r('loyalty-card'),chip:r('category-Комбо'),product:r('product-pick-combo')};
        }''')
        if height > width:
            assert geometry['product']['top'] < height - 56, geometry
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(OUT / f'menu-{width}.png'))
        for category in ['Напитки', 'Допы', 'Комбо']:
            page.get_by_test_id('category-' + category).click()
            page.wait_for_function('''category => {
                const r = id => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
                const heading=r('category-heading-'+category), chip=r('category-'+category), header=r('storefront-header');
                return heading && chip && header && chip.top >= header.bottom - 1 && heading.top >= chip.bottom - 2 && heading.bottom < innerHeight;
            }''', arg=category)
        page.get_by_test_id('product-pick-combo').click()
        expect(page.get_by_test_id('product-add')).to_be_visible()
        expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
        page.get_by_test_id('product-close').click()
        expect(page.get_by_test_id('screen-M06')).to_be_visible()
        expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
        context.close()

    for preference in ['no-preference', 'reduce-during-launch']:
        context = browser.new_context(viewport={'width': 393, 'height': 852}, reduced_motion='no-preference')
        context.add_init_script(TRACK)
        signed_in(context)
        context.route('**/v1/**', fixture)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + '/profile')
        expect(page.get_by_test_id('launch-reveal')).to_be_visible(timeout=20000)
        if preference == 'reduce-during-launch':
            page.wait_for_function('window.launchFrames.some(f => f.width > 400)')
            page.emulate_media(reduced_motion='reduce')
            page.wait_for_function("""document.querySelector('[data-testid="launch-logo"]')?.getBoundingClientRect().width <= 320.1""")
            page.emulate_media(reduced_motion='no-preference')
        else:
            page.wait_for_function('window.launchFrames.some(f => f.width > 500 && f.opacity > .9)')
            page.screenshot(path=str(OUT / 'launch-zoom.png'))
        expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=5000)
        expect(page.get_by_test_id('screen-M30')).to_be_visible()
        if preference == 'no-preference':
            frames = page.evaluate('window.launchFrames')
            assert max(f['width'] for f in frames if f['opacity'] > .05) > 852, frames[-5:]
        context.close()
    for failure in ['background', 'missing-logo']:
        context = browser.new_context(viewport={'width': 393, 'height': 852}, reduced_motion='no-preference')
        context.add_init_script(TRACK)
        signed_in(context)
        context.route('**/v1/**', fixture)
        if failure == 'missing-logo':
            context.route('**/*logo*.png', lambda route: route.abort())
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + '/')
        if failure == 'background':
            page.wait_for_function('window.launchFrames.some(f => f.width > 400)')
            page.evaluate("Object.defineProperty(document, 'visibilityState', {configurable:true, value:'hidden'}); document.dispatchEvent(new Event('visibilitychange'))")
            expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
            page.evaluate("Object.defineProperty(document, 'visibilityState', {configurable:true, value:'visible'}); document.dispatchEvent(new Event('visibilitychange'))")
        expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=5000)
        expect(page.get_by_test_id('screen-M06')).to_be_visible()
        context.close()
    browser.close()
assert not errors, errors
print('PASS: cold launch, full-screen zoom, reduced motion/change, preserved deep link, no replay, four menu sizes, loyalty before sticky categories, visible first dish and category navigation')
