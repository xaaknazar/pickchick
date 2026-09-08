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
        context.route('**/launch/logo*.png', lambda route: route.abort())
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL + '/screen/M01', wait_until='domcontentloaded')
    expect(page.get_by_test_id('launch-screen')).to_be_visible(timeout=20000)
    page.wait_for_timeout(80 if motion == 'no-preference' else 400)
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
        logo = page.get_by_test_id('launch-logo')
        still = logo.evaluate('(el)=>getComputedStyle(el).transform')
        page.wait_for_timeout(100)
        assert logo.evaluate('(el)=>getComputedStyle(el).transform') == still, 'Reduce Motion must keep the logo still'
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
      window.logoSamples = [];
      window.detailSamples = [];
      window.revealSamples = [];
      function sample() {
        const el = document.querySelector('[data-testid="launch-screen"]');
        if (!el) return;
        window.launchSamples.push(Number(getComputedStyle(el).opacity));
        window.logoSamples.push(new DOMMatrixReadOnly(getComputedStyle(document.querySelector('[data-testid="launch-logo"]')).transform).a);
        window.detailSamples.push(Number(getComputedStyle(document.querySelector('[data-testid="launch-tagline"]')).opacity));
        window.revealSamples.push({ opacity: Number(getComputedStyle(el).opacity), mounted: !!document.querySelector('[data-testid="screen-M01"]') });
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    }''')
    page.wait_for_timeout(160)
    early_scales = page.evaluate('window.logoSamples')
    assert len(early_scales) > 3 and early_scales[-1] > early_scales[0], 'Logo must grow before fonts are ready'
    cdp = context.new_cdp_session(page)
    capture = cdp.send('Page.captureScreenshot', {'format': 'png'})
    (OUT / 'animated-393.png').write_bytes(base64.b64decode(capture['data']))
    cdp.detach()
    # Pixel evidence catches the opaque moving logo layer covering the stationary tagline.
    bounds = page.get_by_test_id('launch-artwork').bounding_box()
    white_pixels = page.evaluate('''async ({data, bounds}) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(bounds.x + bounds.width * .2, bounds.y + bounds.height * .8,
        bounds.width * .6, bounds.height * .1).data;
      let white = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 235 && pixels[i + 1] > 235 && pixels[i + 2] > 235) white++;
      }
      return white;
    }''', {'data': capture['data'], 'bounds': bounds})
    assert white_pixels > 100, 'Tagline must remain visible over the animated logo'
    context.unroute('**/*.ttf')
    for route in pending:
        route.continue_()
    page.wait_for_function('window.launchSamples.some(value => value < 0.85)')
    cdp = context.new_cdp_session(page)
    capture = cdp.send('Page.captureScreenshot', {'format': 'png'})
    (OUT / 'reveal-393.png').write_bytes(base64.b64decode(capture['data']))
    cdp.detach()
    expect(page.get_by_test_id('launch-screen')).to_have_count(0, timeout=2000)
    samples = page.evaluate('window.launchSamples')
    assert any(0 < sample < 1 for sample in samples), samples
    scales = page.evaluate('window.logoSamples')
    assert max(scales) > 5, scales
    assert all(b >= a - 0.001 for a, b in zip(scales, scales[1:])), 'Zoom must never shrink or restart'
    assert any(0 < x < 1 for x in page.evaluate('window.detailSamples')), 'Details fade before zoom completes'
    assert all(s['mounted'] for s in page.evaluate('window.revealSamples') if s['opacity'] < 1), 'Only reveal a mounted page'
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
print('PASS: 4 viewports, deep links, no repeated launch, reduced motion, immediate monotonic logo zoom, mounted-page reveal, font/image failures')
