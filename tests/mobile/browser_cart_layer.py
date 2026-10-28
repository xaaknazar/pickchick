"""The cart bar (quick pay) always sits above the tab bar and takes its own taps (owner 28.10.2026).

TestFlight 25: «быстрая оплата иногда гонит и застревает за иконками». Before, each tab screen
drew the bar at a bottom computed from a formula, in the screen's layer, which lies UNDER the tab
bar; with a sheet open over a tab (cart, sign-in) the menu even drew a second, standalone bar at
the very bottom of the screen, under the tab icons. Now the tab bar draws the bar itself, stacked
on the measured tab capsule. On every tab, after opening and closing the cart, with the largest
tab labels and total (the tab bar grows) and with the compact closed capsule:
  - exactly one bar is drawn and its rect ends at least 8 pt above the tab bar's rect;
  - elementFromPoint at the bar's centre, at its lowest row and at the handle hits the bar;
  - a real click at the bar's lowest row opens the cart; while the cart is open no bar lies under
    the tab bar.
Runs on the simulator export (MOBILE_RECOVERY_URL, demo account, bag pill) and on the Kaspi
customer-auth export (CUSTOMER_AUTH_URL, payment handle) with local fixtures only.
Select with CART_LAYER=sim,kaspi (default both).
"""
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
SIM_URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4182').rstrip('/')
KASPI_URL = os.environ.get('CUSTOMER_AUTH_URL', 'http://127.0.0.1:4196').rstrip('/')
for url in (SIM_URL, KASPI_URL):
    assert urlparse(url).hostname in ('127.0.0.1', 'localhost')
OUT = ROOT / os.environ.get('CART_LAYER_SHOTS', '.local/cart-layer')
OUT.mkdir(parents=True, exist_ok=True)
SELECTED = os.environ.get('CART_LAYER', 'sim,kaspi').split(',')
TABS = [('menu', 'M06'), ('events', 'M26'), ('orders', 'M19'), ('menu', 'M06')]
MIN_GAP = 8
errors = []

LAYER = """() => {
  const shown = (id) => [...document.querySelectorAll(`[data-testid="${id}"]`)]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0
      && getComputedStyle(e).visibility !== 'hidden'; });
  const bars = shown('cart-shortcut'), tabs = shown('floating-tab-bar');
  const rect = (e) => { const r = e.getBoundingClientRect();
    return {x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right}; };
  const out = {bars: bars.length, tabs: tabs.length, rects: bars.map(rect)};
  if (!tabs.length) return out;
  out.tab = rect(tabs[0]);
  // Hits only where nothing above the tabs (a sheet) covers the point.
  const hit = (bar, x, y) => { const e = document.elementFromPoint(x, y); return !!e && bar.contains(e); };
  out.hits = bars.map((bar) => {
    const r = bar.getBoundingClientRect(), cx = r.left + r.width / 2;
    const handle = bar.querySelector('[data-testid="cart-pay-handle"]');
    const h = handle && handle.getBoundingClientRect();
    return {centre: hit(bar, cx, r.top + r.height / 2), low: hit(bar, cx, r.bottom - 3),
            lowLeft: hit(bar, r.left + r.width * 0.25, r.bottom - 3),
            handle: h ? hit(bar, h.left + h.width / 2, h.bottom - 3) : null};
  });
  const t = tabs[0].getBoundingClientRect();
  const e = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
  out.tabHit = !!e && tabs[0].contains(e);
  return out;
}"""

# Large text (RN scales font size and line height together; the web export keeps fontScale 1,
# so the fixture enlarges the texts the way iOS Dynamic Type would, beyond the tab bar formula).
LARGE = """(on) => {
  const nodes = [...document.querySelectorAll('[data-testid="floating-tab-bar"] [role="tab"] *'),
                 ...document.querySelectorAll('[data-testid="cart-shortcut-total"]')]
    .filter((n) => !n.children.length && n.textContent.trim());
  for (const n of nodes) {
    if (on) {
      if (!n.dataset.fixtureLarge) n.dataset.fixtureLarge = JSON.stringify([n.style.fontSize, n.style.lineHeight]);
      const size = parseFloat(getComputedStyle(n).fontSize), line = parseFloat(getComputedStyle(n).lineHeight) || size * 1.3;
      n.style.fontSize = size * 1.8 + 'px';
      n.style.lineHeight = line * 1.8 + 'px';
    } else if (n.dataset.fixtureLarge) {
      const [size, line] = JSON.parse(n.dataset.fixtureLarge);
      n.style.fontSize = size; n.style.lineHeight = line; delete n.dataset.fixtureLarge;
    }
  }
}"""


def layer(page):
    return page.evaluate(LAYER)


def assert_above(page, label, handle=None):
    """The one bar is fully above the tab bar, inside the screen, and takes its own taps."""
    page.wait_for_timeout(150)
    m = layer(page)
    assert m['bars'] == 1 and m['tabs'] == 1, (label, m)
    bar, tab = m['rects'][0], m['tab']
    gap = tab['y'] - bar['bottom']
    assert gap >= MIN_GAP - 0.5, (label, 'the bar reaches into the tab bar', gap, m)
    assert bar['x'] >= 0 and bar['right'] <= page.viewport_size['width'] + 0.5, (label, bar)
    assert bar['y'] >= 0, (label, bar)
    hits = m['hits'][0]
    assert hits['centre'] and hits['low'] and hits['lowLeft'], (label, 'taps go elsewhere', m)
    if handle is not None:
        assert (hits['handle'] is not None) == handle, (label, 'handle', m)
        if handle:
            assert hits['handle'], (label, 'the handle is covered', m)
    assert m['tabHit'], (label, 'the tab bar itself must stay tappable', m)
    return gap


def no_bar_under_tabs(page, label):
    """With a sheet open over a tab no cart bar lies under the tab bar (the old standalone one)."""
    m = layer(page)
    if not m.get('tab'):
        return
    for rect in m['rects']:
        assert rect['bottom'] <= m['tab']['y'] + 0.5, (label, 'a bar under the tab bar', m)


def click_low_edge(page, screen_after='screen-M09'):
    box = page.get_by_test_id('cart-shortcut').filter(visible=True).bounding_box()
    # The lowest row of the capsule, on the total (not the handle): the cart opens.
    page.mouse.click(box['x'] + box['width'] * 0.55, box['y'] + box['height'] - 3)
    expect(page.get_by_test_id(screen_after)).to_be_visible(timeout=15000)


def tour(page, label, close_cart, handle=None, width=393):
    gaps = []
    for route, screen in TABS:
        page.get_by_test_id('tab-' + route).click()
        expect(page.get_by_test_id('screen-' + screen).filter(visible=True)).to_have_count(1)
        gaps.append(assert_above(page, f'{label} {route}', handle))
        for i in range(2):
            click_low_edge(page)
            page.wait_for_timeout(200)
            no_bar_under_tabs(page, f'{label} {route} cart open {i}')
            close_cart(page)
            gaps.append(assert_above(page, f'{label} {route} after cart {i}', handle))
    page.screenshot(path=str(OUT / f'{label}-{width}.png'))
    # The largest text: the tab labels and the total grow, the bar moves up with the tab bar.
    page.evaluate(LARGE, True)
    page.wait_for_timeout(300)
    gaps.append(assert_above(page, f'{label} large text', handle))
    page.screenshot(path=str(OUT / f'{label}-large-{width}.png'))
    page.evaluate(LARGE, False)
    page.wait_for_timeout(300)
    gaps.append(assert_above(page, f'{label} large text reset', handle))
    return gaps


def sim_fixture():
    """Read-only synthetic catalogue of the simulator export (as browser_tab_bar.py)."""
    cat = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
        "import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js';"
        "console.log(JSON.stringify(testCompleteCatalog))"], cwd=ROOT, text=True))
    branch = cat['branch_id']
    data = {
        '/v1/capabilities': {'schema_version': 1, 'environment': 'staging', 'data_mode': 'synthetic',
            'ordering_enabled': False, 'features': {'test_order_flow': True,
                **{key: False for key in ['phone_auth', 'payments', 'fiscal', 'checkout', 'loyalty']}}},
        '/v1/branches': {'branches': [{'id': branch, 'code': 'TEST', 'name': 'Локальная проверка',
            'timezone': 'Asia/Almaty', 'ordering_enabled': False}]},
        '/v1/branches/' + branch + '/menu': {'schema_version': 1, 'branch_id': branch,
            'release_id': '10000000-0000-4000-8000-000000000008', 'version': 1,
            'published_at': '2026-09-07T00:00:00Z', 'items': []},
        '/v1/test/catalog': cat,
    }

    def fixture(route):
        assert route.request.method == 'GET', 'Tab navigation must not mutate the backend'
        path = urlparse(route.request.url).path
        if path in data:
            route.fulfill(json=data[path], headers={'Access-Control-Allow-Origin': '*'})
        else:
            route.abort()
    return fixture


def run_sim(browser):
    sys.path.insert(0, str(ROOT / 'tests/mobile'))
    from browser_network import isolated_context, route_fixture
    from account_fixture import signed_in
    fixture = sim_fixture()

    def close_cart(page):
        page.get_by_test_id('cart-close').click()
        expect(page.get_by_test_id('screen-M09')).to_have_count(0, timeout=10000)

    for width, height in [(393, 852), (320, 568)]:
        ctx = isolated_context(browser, viewport={'width': width, 'height': height}, has_touch=False,
                               reduced_motion='reduce')
        signed_in(ctx)
        route_fixture(ctx, '**/v1/**', fixture)
        page = ctx.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(SIM_URL + '/menu')
        page.get_by_test_id('product-pick-combo').click(timeout=25000)
        page.get_by_test_id('product-add').click()
        expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=20000)
        expect(page.get_by_test_id('cart-shortcut').filter(visible=True)).to_have_count(1)
        # Builds without the Kaspi checkout keep the bag pill and no handle.
        gaps = tour(page, 'sim', close_cart, handle=False, width=width)
        print('sim', width, 'gaps', sorted(set(round(g) for g in gaps)))
        ctx.close()


def run_kaspi(browser):
    sys.path.insert(0, str(ROOT / 'tests/mobile'))
    os.environ['CUSTOMER_AUTH_URL'] = KASPI_URL
    import browser_cart_unavailable as cu
    from browser_slide_to_pay import add

    for width, height in [(393, 852), (320, 568)]:
        state = cu.new_state()
        ctx, page = cu.make_context(browser, state, width, height)
        page.goto(KASPI_URL + '/menu')
        add(page)
        expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=20000)
        cu.expect_open_bar(page, 20000)
        gaps = tour(page, 'kaspi', cu.close_cart, handle=True, width=width)
        print('kaspi', width, 'gaps', sorted(set(round(g) for g in gaps)))
        assert not cu.mutations(state), cu.mutations(state)
        cu.release(state)
        ctx.close()
    # The compact closed capsule (no handle) sits above the tab bar the same way.
    state = cu.new_state(clock=cu.at('09:30'))
    ctx, page = cu.make_context(browser, state, 393, 852)
    page.goto(KASPI_URL + '/menu')
    add(page)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=20000)
    cu.expect_closed_bar(page)
    gaps = tour(page, 'kaspi-closed', cu.close_cart, handle=False)
    print('kaspi closed gaps', sorted(set(round(g) for g in gaps)))
    assert not cu.mutations(state), cu.mutations(state)
    cu.release(state)
    ctx.close()
    errors.extend(cu.errors)


if __name__ == '__main__':
    with sync_playwright() as p:
        browser = p.chromium.launch()
        if 'sim' in SELECTED:
            run_sim(browser)
        if 'kaspi' in SELECTED:
            run_kaspi(browser)
        browser.close()
    assert not errors, errors
    print('PASS cart layer (' + ','.join(SELECTED) + '): on Меню, События and Заказы, after opening and '
          'closing the cart, with the largest text and with the closed capsule the one cart bar ends '
          '>= 8 pt above the tab bar and takes its own taps (centre, lowest row, handle); a click on '
          'its lowest row opens the cart; no bar under the tab bar while the cart is open')
