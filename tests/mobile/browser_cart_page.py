"""Kaspi cart page, owner 27.10.2026: the cart is the checkout (Drinkit reference).

Runs against the customer-auth web export (EXPO_PUBLIC_CUSTOMER_AUTH=server,
EXPO_PUBLIC_KASPI_CHECKOUT=1, EXPO_PUBLIC_PUBLISHED_CATALOG=0) with local fixtures only:
no bank, no real customer, no VPS request.
  - top bar: red glass trash left, pin + restaurant point centred, glass close right, no title;
  - «В зале / С собой» pill switches the mode and the quote carries it;
  - removed: «Добавить ещё что-нибудь», promo code, small print after the total;
  - order comment at the bottom, payment selector (Kaspi.kz selected, others «скоро»);
  - one press of «Оплатить с Kaspi.kz» = one quote + one order + one invoice;
  - a guest is sent to sign-in and back to the cart, nothing is ordered;
  - the menu hero video keeps playing under the cart sheet and pauses for tabs/full screens.
"""
from browser_network import isolated_context, route_fixture
import json, os, subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('CUSTOMER_AUTH_URL', 'http://127.0.0.1:4196').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost')
OUT = Path(os.environ.get('CART_PAGE_OUTPUT', ROOT / '.local/cart-page'))
OUT.mkdir(parents=True, exist_ok=True)
CATALOG = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
    "import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js'; console.log(JSON.stringify(testCompleteCatalog))"],
    cwd=ROOT, text=True))
BRANCH = CATALOG['branch_id']
CUSTOMER = '40000000-0000-4000-8000-000000000001'
ORDER = '40000000-0000-4000-8000-000000000003'
future = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat().replace('+00:00', 'Z')
recent = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat().replace('+00:00', 'Z')
customer = {'id': CUSTOMER, 'phone': '+77000000000', 'nickname': 'UI test', 'birth_date': None,
            'gender': None, 'profile_completed_at': None, 'created_at': '2026-09-07T10:00:00.000Z'}
envelope = {'version': 1, 'device_id': '40000000-0000-4000-8000-000000000004',
            'tokens': {'access_token': 'a' * 64, 'refresh_token': 'b' * 64, 'access_expires_at': future,
                       'session_id': '40000000-0000-4000-8000-000000000002', 'customer': customer},
            'challenge': None, 'otp_request': None, 'verify_intent': None, 'refresh_request_id': None,
            'closing': None}
REMOVED = ['Добавить ещё что-нибудь', 'Ввести промокод', 'Счёт придёт на', 'Фискальный чек',
           'Оплата и чеки - в процессе подключения', 'Чики за покупки', 'Цены и наличие блюд проверим',
           'КАК ЗАБЕРЁТЕ', 'Выдача по номеру заказа']
# No playback in headless Chromium: record play()/pause() of the hero <video> without loading media.
HERO_PROBE = """(() => {
  window.__hero = [];
  const setAttribute = Element.prototype.setAttribute;
  HTMLMediaElement.prototype.setAttribute = function (name, value) {
    if (name === 'src') { this.dataset.probeSrc = value; return; }
    return setAttribute.call(this, name, value);
  };
  Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: true,
    get() { return this.dataset.probeSrc || ''; }, set(value) { this.dataset.probeSrc = value; } });
  HTMLMediaElement.prototype.play = function () { window.__hero.push('play'); return Promise.resolve(); };
  HTMLMediaElement.prototype.pause = function () { window.__hero.push('pause'); };
})();"""
errors = []


def order(phase):
    return {'orderId': ORDER, 'revision': '1'.zfill(64), 'restaurant': 'ТЦ Abay Plaza', 'branchId': BRANCH,
            'createdAt': recent, 'updatedAt': recent, 'kitchenStage': None, 'displayNumber': None,
            'totalMinor': '419000', 'serviceMode': 'dine_in', 'kitchenComment': 'Без лука', 'phase': phase,
            'expiresAt': future if phase == 'awaiting_payment' else None, 'receipt': 'deferred',
            'receiptUrl': None, 'items': [{'productId': 'pick-combo', 'title': 'Pick Combo', 'quantity': 1,
                                           'totalMinor': '419000', 'modifiers': []}]}


def make_context(browser, width, height, signed=True, motion='reduce', probe=False):
    state = {'quotes': [], 'creates': 0, 'payments': 0, 'phase': 'ready_to_pay', 'held': [], 'mutations': []}
    ctx = isolated_context(browser, viewport={'width': width, 'height': height}, reduced_motion=motion)
    if signed:
        ctx.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",'
                            + json.dumps(json.dumps(envelope)) + ');')
    if probe:
        ctx.add_init_script(HERO_PROBE)

    def route(r):
        path = urlparse(r.request.url).path
        method = r.request.method
        body = r.request.post_data_json if r.request.post_data else None
        # Checkout/order writes only; the QA export's synthetic test session is not an order.
        if method != 'GET' and path.startswith('/v1/customer'):
            state['mutations'].append((method, path))
        if path.endswith('/watch'):
            state['held'].append(r)
            return
        data = None
        if path == '/v1/customers/me':
            data = {'customer': customer, 'legal': {'version': 'fixture-v1', 'accepted': True,
                    'terms_url': 'https://example.test/terms', 'privacy_url': 'https://example.test/privacy'}}
        elif path == '/v1/customer-checkout/availability':
            data = {'enabled': True, 'fresh': True, 'signature': 'a' * 64,
                    'products': [{'id': p['id'], 'available': True, 'stoppedOptions': []} for p in CATALOG['products']]}
        elif path == '/v1/auth/config':
            data = {'enabled': True, 'delivery_consent_required': True, 'consent_version': 'fixture-v1',
                    'terms_url': 'https://example.test/terms', 'privacy_url': 'https://example.test/privacy'}
        elif path == '/v1/capabilities':
            data = {'schema_version': 1, 'environment': 'staging', 'data_mode': 'pilot', 'ordering_enabled': False,
                    'features': {'phone_auth': True, 'test_order_flow': True,
                                 **{k: False for k in ['payments', 'fiscal', 'checkout', 'loyalty']}}}
        elif path == '/v1/branches':
            data = {'branches': [{'id': BRANCH, 'code': 'TEST', 'name': 'ТЦ Abay Plaza', 'timezone': 'Asia/Almaty',
                                  'ordering_enabled': False}]}
        elif path == '/v1/branches/' + BRANCH + '/menu':
            data = {'schema_version': 1, 'branch_id': BRANCH, 'release_id': '10000000-0000-4000-8000-000000000008',
                    'version': 1, 'published_at': '2026-09-07T00:00:00Z', 'items': []}
        elif path == '/v1/test/catalog':
            data = CATALOG
        elif path == '/v1/content/branches/' + BRANCH:
            data = {'schema_version': 1, 'branch_id': BRANCH, 'promos': [], 'games': []}
        elif path == '/v1/customer-checkout/feedback' and method == 'GET':
            data = {'feedback': []}
        elif path == '/v1/customer-checkout/config':
            data = {'enabled': True, 'branchId': BRANCH, 'restaurant': 'ТЦ Abay Plaza',
                    'fiscalPolicy': 'deferred_pilot', 'orderCommentEnabled': True}
        elif path == '/v1/customer-checkout/orders' and method == 'GET':
            data = {'orders': [order(state['phase'])] if state['creates'] else []}
        elif path == '/v1/customer-checkout/quotes' and method == 'POST':
            assert page_of(state).get_by_test_id('kaspi-connecting').count() == 1, 'Quotes start after the press'
            state['quotes'].append(body)
            data = {'quoteId': '40000000-0000-4000-8000-000000000005', 'totalMinor': '419000', 'expiresAt': future,
                    'serviceMode': body['serviceMode'], 'kitchenComment': body.get('kitchenComment')}
        elif path == '/v1/customer-checkout/orders' and method == 'POST':
            state['creates'] += 1
            data = order(state['phase'])
        elif path == f'/v1/customer-checkout/orders/{ORDER}' and method == 'GET':
            data = order(state['phase'])
        elif path == f'/v1/customer-checkout/orders/{ORDER}/payment' and method == 'POST':
            state['payments'] += 1
            state['phase'] = 'awaiting_payment'
            data = order(state['phase'])
        else:
            r.abort()
            return
        r.fulfill(json=data, headers={'Access-Control-Allow-Origin': '*'})

    route_fixture(ctx, '**/v1/**', route)
    page = ctx.new_page()
    state['page'] = page
    page.on('pageerror', lambda e: errors.append(str(e)))
    return ctx, page, state


def page_of(state):
    return state['page']


def close(ctx, state):
    for held in state['held']:
        try:
            held.abort()
        except Exception:
            pass
    ctx.close()


def add_combo_and_open_cart(page):
    page.goto(URL + '/menu')
    page.get_by_test_id('product-pick-combo').click(timeout=25000)
    page.get_by_test_id('product-add').click()
    page.get_by_test_id('open-cart').click()
    expect(page.get_by_test_id('screen-M09')).to_be_visible()


def glyph(locator):
    return locator.evaluate("""(el) => {
      const node = [...el.querySelectorAll('*')].find((n) => getComputedStyle(n).fontFamily.toLowerCase().includes('ionicons'));
      return node ? getComputedStyle(node).color : null;
    }""")


def has_blur(locator):
    return locator.evaluate("""(el) => [el, ...el.querySelectorAll('*')].some((n) => {
      const style = getComputedStyle(n);
      return (style.backdropFilter || style.webkitBackdropFilter || '').includes('blur');
    })""")


def cart_page(browser, width, height):
    ctx, page, state = make_context(browser, width, height)
    add_combo_and_open_cart(page)
    sheet = page.get_by_role('dialog', name='Корзина', exact=True)
    expect(sheet).to_be_visible()
    pay = page.get_by_test_id('cart-pay')
    expect(pay).to_be_enabled(timeout=15000)
    # Top bar: trash left, pin + point centred, close right; no «Корзина» title.
    clear, point, shut = (page.get_by_test_id(i) for i in ('cart-clear', 'cart-restaurant', 'cart-close'))
    expect(point).to_contain_text('ТЦ Abay Plaza')
    expect(sheet.get_by_role('heading', name='Корзина', exact=True)).to_have_count(0)
    a, b, c, s = clear.bounding_box(), point.bounding_box(), shut.bounding_box(), sheet.bounding_box()
    assert a['x'] + a['width'] <= b['x'] and b['x'] + b['width'] <= c['x'], (a, b, c)
    assert abs((b['x'] + b['width'] / 2) - (s['x'] + s['width'] / 2)) <= 2, (b, s)
    assert abs((a['y'] + a['height'] / 2) - (c['y'] + c['height'] / 2)) <= 1, (a, c)
    for box in (a, c):
        assert box['width'] >= 44 and box['height'] >= 44, box
    assert glyph(clear) == 'rgb(255, 107, 94)', glyph(clear)
    assert glyph(shut) == 'rgb(255, 255, 255)', glyph(shut)
    assert has_blur(clear) and has_blur(shut), 'Glass buttons blur what is behind them'
    for minus in (page.get_by_test_id('cart-minus-pick-combo'), page.get_by_test_id('cart-plus-pick-combo')):
        assert has_blur(minus) and minus.bounding_box()['height'] >= 44
    # Editing the cart never locks the sheet: the drag handle stays (no 28 px jump per tap).
    expect(sheet.get_by_test_id('sheet-handle')).to_be_visible()
    page.evaluate("""() => {
      window.__handleGone = 0;
      new MutationObserver(() => {
        if (!document.querySelector('[data-testid=order-sheet] [data-testid=sheet-handle]')) window.__handleGone++;
      }).observe(document.body, { childList: true, subtree: true });
    }""")
    page.get_by_test_id('cart-plus-pick-combo').click()
    expect(page.get_by_test_id('cart-quantity-pick-combo')).to_have_text('2')
    expect(page.get_by_test_id('screen-M09').get_by_test_id('cart-total')).to_have_text('8 380 ₸')
    page.get_by_test_id('cart-minus-pick-combo').click()
    expect(page.get_by_test_id('cart-quantity-pick-combo')).to_have_text('1')
    page.wait_for_timeout(400)
    assert page.evaluate('window.__handleGone') == 0, 'The sheet handle must not flicker on edits'
    # Dining pill: «В зале / С собой», a radio pair inside one pill.
    pill = page.get_by_test_id('cart-dining-mode')
    dine = pill.get_by_role('radio', name='В зале', exact=True)
    away = pill.get_by_role('radio', name='С собой', exact=True)
    expect(away).to_have_attribute('aria-checked', 'true')
    dine.click()
    expect(dine).to_have_attribute('aria-checked', 'true')
    expect(away).to_have_attribute('aria-checked', 'false')
    assert pill.bounding_box()['y'] > a['y'] + a['height'], 'The pill sits under the top bar'
    # Removed blocks and small print; kept suggestions and promotions.
    for copy in REMOVED:
        expect(sheet.get_by_text(copy, exact=False)).to_have_count(0)
    for test_id in ('cart-add-more', 'cart-promo-open', 'cart-checkout', 'checkout-apple-pay', 'checkout-add-card'):
        expect(page.get_by_test_id(test_id)).to_have_count(0)
    expect(sheet.get_by_text('Всегда кстати', exact=True)).to_be_visible()
    expect(page.get_by_test_id('cart-combo-reward')).to_have_count(1)
    # Footer: payment method left, «Итого» right, white pay button below. The floating cart bar
    # under the sheet has its own cart-total, so the footer one is read inside the cart screen.
    method = page.get_by_test_id('cart-payment-method')
    total = page.get_by_test_id('screen-M09').get_by_test_id('cart-total')
    expect(method).to_contain_text('Kaspi.kz')
    expect(total).to_have_text('4 190 ₸')
    expect(pay).to_contain_text('Оплатить с')
    expect(pay).to_contain_text('Kaspi.kz')
    expect(pay).to_have_accessible_name('Оплатить с Kaspi.kz, 4 190 ₸')
    m, t, p = method.bounding_box(), total.bounding_box(), pay.bounding_box()
    assert m['x'] < t['x'] and m['y'] + m['height'] <= p['y'] and t['y'] + t['height'] <= p['y'], (m, t, p)
    assert p['height'] >= 48 and p['y'] + p['height'] <= height + 1, p
    assert pay.evaluate('(el) => getComputedStyle(el).backgroundColor') == 'rgb(255, 255, 255)'
    assert total.evaluate('(el) => parseFloat(getComputedStyle(el).lineHeight) >= parseFloat(getComputedStyle(el).fontSize) * 1.3')
    footer = sheet.get_by_test_id('bottom-actions')
    for copy in REMOVED:
        expect(footer.get_by_text(copy, exact=False)).to_have_count(0)
    page.get_by_test_id('scroll-M09').evaluate('(e) => e.scrollTop = 0')
    page.screenshot(path=str(OUT / f'cart-1-item-{width}.png'))
    # Comment at the bottom of the cart, after the promotions, above the payment block.
    comment = page.get_by_test_id('checkout-comment-input')
    comment.scroll_into_view_if_needed()
    comment.fill('Без лука')
    comment.blur()
    expect(page.get_by_test_id('checkout-comment-count')).to_have_text('8/60')
    reward = page.get_by_test_id('cart-combo-reward').bounding_box()
    box = comment.bounding_box()
    assert reward['y'] < box['y'] and box['y'] + box['height'] <= footer.bounding_box()['y'] + 1, (reward, box)
    page.screenshot(path=str(OUT / f'cart-comment-{width}.png'))
    # Payment selector: Kaspi.kz selected; Apple Pay and cards are «скоро» and cannot be chosen.
    method.click()
    chooser = page.get_by_test_id('cart-payment-sheet')
    expect(chooser).to_be_visible()
    kaspi = page.get_by_test_id('cart-payment-kaspi')
    expect(kaspi).to_have_attribute('aria-checked', 'true')
    for id in ('apple_pay', 'card'):
        option = page.get_by_test_id('cart-payment-' + id)
        expect(option).to_have_attribute('aria-disabled', 'true')
        expect(option).to_have_attribute('aria-checked', 'false')
        expect(option).to_contain_text('СКОРО')
        option.click(force=True)
        expect(chooser).to_be_visible()
    expect(page.get_by_test_id('cart-payment-google_pay')).to_have_count(0)
    expect(chooser.locator('input')).to_have_count(0)
    expect(page.get_by_test_id('cart-payment-close')).to_have_accessible_name('Закрыть способы оплаты')
    page.wait_for_timeout(350)
    page.screenshot(path=str(OUT / f'payment-selector-{width}.png'))
    kaspi.click()
    expect(chooser).to_have_count(0)
    expect(method).to_contain_text('Kaspi.kz')
    assert not state['quotes'] and not state['creates'] and not state['payments'], state
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    # One press: exactly one quote (with the chosen mode and comment), one order, one invoice.
    pay.click()
    expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Ждём оплату в Kaspi', timeout=15000)
    page.wait_for_timeout(2000)
    assert len(state['quotes']) == 1 and state['creates'] == 1 and state['payments'] == 1, state
    quote = state['quotes'][0]
    assert quote['serviceMode'] == 'dine_in' and quote.get('kitchenComment') == 'Без лука', quote
    expect(sheet.get_by_test_id('sheet-handle')).to_have_count(0)
    page.screenshot(path=str(OUT / f'after-pay-{width}.png'))
    close(ctx, state)


def three_items(browser, width, height):
    ctx, page, state = make_context(browser, width, height)
    add_combo_and_open_cart(page)
    rail = page.get_by_test_id('cart-recommendations')
    for product in ('burger', 'piko'):
        button = page.get_by_test_id('cart-recommend-' + product)
        button.scroll_into_view_if_needed()
        button.click()
        expect(page.get_by_test_id('cart-quantity-' + product)).to_have_text('1')
    expect(rail).to_be_visible()
    expect(page.get_by_test_id('screen-M09').get_by_test_id('cart-total')).to_have_text('7 170 ₸')
    expect(page.get_by_test_id('cart-pay')).to_have_accessible_name('Оплатить с Kaspi.kz, 7 170 ₸')
    page.get_by_test_id('scroll-M09').evaluate('(e) => e.scrollTop = 0')
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / f'cart-3-items-{width}.png'))
    # Clearing still asks first; the red trash is the only way to empty the cart at once.
    page.get_by_test_id('cart-clear').click()
    expect(page.get_by_test_id('cart-clear-dialog')).to_be_visible()
    page.get_by_test_id('cart-clear-cancel').click()
    assert not state['mutations'], state['mutations']
    close(ctx, state)


def product_glass(browser, width, height):
    ctx, page, state = make_context(browser, width, height)
    page.goto(URL + '/menu')
    page.get_by_test_id('product-pick-combo').click(timeout=25000)
    close_button = page.get_by_test_id('product-close')
    expect(close_button).to_be_visible()
    assert has_blur(close_button) and close_button.bounding_box()['height'] >= 44
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / f'product-glass-{width}.png'))
    close(ctx, state)


def guest(browser):
    ctx, page, state = make_context(browser, 393, 852, signed=False)
    add_combo_and_open_cart(page)
    pay = page.get_by_test_id('cart-pay')
    expect(pay).to_be_enabled(timeout=15000)
    expect(page.get_by_test_id('screen-M09').get_by_test_id('cart-total')).to_have_text('4 190 ₸')
    pay.click()
    expect(page.get_by_test_id('auth-sheet')).to_be_visible(timeout=10000)
    assert 'returnTo=M09' in page.url, page.url
    page.get_by_test_id('auth-close').filter(visible=True).click()
    expect(page.get_by_test_id('screen-M09')).to_be_visible()
    assert not state['quotes'] and not state['creates'] and not state['payments'], state
    assert not state['mutations'], state['mutations']
    close(ctx, state)


def hero_video(browser):
    ctx, page, state = make_context(browser, 393, 852, motion='no-preference', probe=True)
    last = lambda: page.evaluate('window.__hero[window.__hero.length - 1] || null')
    page.goto(URL + '/menu')
    page.wait_for_function("() => window.__hero && window.__hero.at(-1) === 'play'", timeout=25000)
    # A full screen (product page) covers the menu: pause; back on the menu: play again.
    page.get_by_test_id('product-pick-combo').click()
    page.wait_for_function("() => window.__hero.at(-1) === 'pause'")
    page.get_by_test_id('product-add').click()
    page.wait_for_function("() => window.__hero.at(-1) === 'play'")
    # The cart sheet over the menu keeps it playing (owner: «у Drinkit идёт»). The Kaspi cart
    # still slides in: reading the saved intent does not lock (and so jump) the sheet.
    before = page.evaluate('window.__hero.length')
    page.evaluate("""() => {
      window.sheetFrames = [];
      const start = (event) => {
        if (!event.target.closest('[data-testid="open-cart"]')) return;
        document.removeEventListener('click', start, true);
        const until = performance.now() + 1500;
        const tick = () => {
          const el = document.querySelector('[data-testid="order-sheet"]');
          if (el) window.sheetFrames.push(el.getBoundingClientRect().y);
          if (performance.now() < until) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      };
      document.addEventListener('click', start, true);
    }""")
    page.get_by_test_id('open-cart').click()
    expect(page.get_by_test_id('screen-M09')).to_be_visible()
    page.wait_for_timeout(600)
    frames = page.evaluate('window.sheetFrames')
    assert len(frames) > 4 and max(frames) - min(frames) > 80, frames
    expect(page.get_by_test_id('sheet-handle')).to_be_visible()
    page.wait_for_timeout(1500)
    assert last() == 'play' and 'pause' not in page.evaluate('window.__hero.slice(%d)' % before), \
        page.evaluate('window.__hero')
    page.get_by_test_id('cart-payment-method').click()
    expect(page.get_by_test_id('cart-payment-sheet')).to_be_visible()
    page.wait_for_timeout(500)
    assert 'pause' not in page.evaluate('window.__hero.slice(%d)' % before)
    page.get_by_test_id('cart-payment-close').click()
    page.get_by_test_id('cart-close').click()
    expect(page.get_by_test_id('screen-M09')).to_have_count(0)
    assert last() == 'play'
    # Another tab covers the menu: pause; the menu again: play.
    page.get_by_test_id('tab-events').click()
    page.wait_for_function("() => window.__hero.at(-1) === 'pause'")
    page.get_by_test_id('tab-menu').click()
    page.wait_for_function("() => window.__hero.at(-1) === 'play'")
    # App in the background: pause.
    page.evaluate("""() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    }""")
    page.wait_for_function("() => window.__hero.at(-1) === 'pause'")
    close(ctx, state)


with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in [(393, 852), (320, 568)]:
        cart_page(browser, width, height)
        three_items(browser, width, height)
        product_glass(browser, width, height)
    guest(browser)
    hero_video(browser)
    browser.close()
assert not errors, errors
print('PASS cart page 393/320: Drinkit top bar (red glass trash, pin + point, glass close), dining pill -> quote, '
      'removed blocks/small print, comment, payment selector (Kaspi only, others «скоро»), one press = 1 quote + '
      '1 order + 1 invoice, 3-item total, glass product close, guest -> sign-in -> cart, hero video plays under the '
      'cart and pauses for tab/full screen/background')
