"""Launch lifecycle: slow/failed resources, deep links, reduced motion and geometry.

All API traffic is blocked. No extra route or production preview flag is needed.
"""
import base64
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4182').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost')
OUT = ROOT / '.local/launch'
OUT.mkdir(parents=True, exist_ok=True)
errors = []


def start(browser, width=393, height=852, motion='reduce', fail_image=False):
    context = browser.new_context(viewport={'width': width, 'height': height}, reduced_motion=motion)
    context.route('**/v1/**', lambda route: route.abort())
    pending = []
    context.route('**/*.ttf', lambda route: pending.append(route))
    if fail_image:
        context.route('**/*artwork*.png', lambda route: route.abort())
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL + '/screen/M01', wait_until='domcontentloaded')
    expect(page.get_by_test_id('launch-screen')).to_be_visible(timeout=20000)
    page.wait_for_timeout(400)
    assert pending, 'Font requests must be held to observe real startup'
    return context, page, pending


with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in [(320, 568), (393, 852), (430, 932), (852, 393)]:
        context, page, pending = start(browser, width, height)
        artwork = page.get_by_test_id('launch-artwork').bounding_box()
        loading = page.get_by_role('progressbar', name='Загрузка PickChick').bounding_box()
        assert artwork['y'] + artwork['height'] < loading['y'], (artwork, loading)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert page.get_by_test_id('launch-screen').evaluate('(el)=>getComputedStyle(el).opacity') == '1'
        # Page.screenshot waits for fonts by default; these fonts are intentionally blocked.
        cdp = context.new_cdp_session(page)
        capture = cdp.send('Page.captureScreenshot', {'format': 'png'})
        (OUT / f'launch-{width}.png').write_bytes(base64.b64decode(capture['data']))
        cdp.detach()
        context.unroute('**/*.ttf')
        for route in pending:
            route.continue_()
        expect(page.get_by_test_id('launch-screen')).to_have_count(0, timeout=20000)
        expect(page.get_by_test_id('screen-M01')).to_be_visible()
        assert page.url.endswith('/screen/M01'), 'Launch must preserve deep links'
        page.get_by_test_id('welcome-menu').click()
        expect(page.get_by_test_id('screen-M06')).to_be_visible()
        expect(page.get_by_test_id('launch-screen')).to_have_count(0)
        context.close()

    context, page, pending = start(browser, motion='no-preference')
    page.evaluate('''() => {
      window.launchSamples = [];
      function sample() {
        const el = document.querySelector('[data-testid="launch-screen"]');
        if (!el) return;
        window.launchSamples.push(Number(getComputedStyle(el).opacity));
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    }''')
    context.unroute('**/*.ttf')
    for route in pending:
        route.continue_()
    expect(page.get_by_test_id('launch-screen')).to_have_count(0, timeout=20000)
    samples = page.evaluate('window.launchSamples')
    assert any(0 < sample < 1 for sample in samples), samples
    context.close()

    context, page, pending = start(browser)
    context.unroute('**/*.ttf')
    for route in pending:
        route.abort()
    expect(page.get_by_test_id('launch-error')).to_be_visible(timeout=20000)
    expect(page.get_by_test_id('launch-screen')).to_have_count(0)
    context.close()

    context, page, pending = start(browser, fail_image=True)
    expect(page.get_by_text('PickChick', exact=True)).to_be_visible()
    context.unroute('**/*.ttf')
    for route in pending:
        route.continue_()
    expect(page.get_by_test_id('launch-screen')).to_have_count(0, timeout=20000)
    expect(page.get_by_test_id('screen-M01')).to_be_visible()
    context.close()
    browser.close()

assert not errors, errors
print('PASS: 4 viewports, deep links, no repeated launch, reduced motion, fade, font/image failures')
