"""Slide to pay from the cart bar (owner request 27.10.2026) through the guarded Kaspi checkout.

Runs against the customer-auth web export (EXPO_PUBLIC_CUSTOMER_AUTH=server,
EXPO_PUBLIC_KASPI_CHECKOUT=1, EXPO_PUBLIC_UNPAID_TEST_ORDERS=1, EXPO_PUBLIC_PUBLISHED_CATALOG=0)
with local fixtures only: no bank, no real customer, no VPS request.
  A  bar zones; a tap shows the hint only; hold shows «тяни для оплаты»; a swipe without the hold,
     a short drag and Enter on the handle send nothing (no /quotes, /orders or /payment request)
  B  a full drag creates exactly one quote, one order and one invoice; reload/back resend nothing
  C  a changed price stops before the order; only a second explicit press continues
  D  consent: the dialog stops the slide, «Не сейчас» leaves the normal button, no retry
  E  signed out: the slide opens the sign-in and then checkout without sending anything
  F  App Review account: the server refuses the order exactly as for a press, no retry, no invoice
  G  DEMO-1 demonstration: no cart bar or handle, no mutating request
  H  combo gift selected: bar total = «Оформить заказ» = checkout total = quote; one order, one invoice
  I  the hint «тяни для оплаты» fits at 320 pt in RU, KK and EN, also at the largest text size
  J  an old unbilled intent without an order is still saved when checkout opens: the slide still
     pays once (the press drops that intent), the old intent is never sent
  K  «Вернуться в корзину» after a slide opens the cart, not the tab under checkout
"""
from browser_network import isolated_context, route_fixture
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from browser_checkout_traps import CATALOG, BRANCH, envelope, customer, future, order, refusal

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('CUSTOMER_AUTH_URL', 'http://127.0.0.1:4196').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost')
OUT = ROOT / os.environ.get('SLIDE_TO_PAY_SHOTS', '.local/slide-to-pay')
OUT.mkdir(parents=True, exist_ok=True)
PHONE = '7' + '0' * 8 + '2'
HINT = 'тяни для оплаты'
# The hint in each language, from the catalogue the app uses.
HINTS = next({lang: entry[lang] for lang in ('ru', 'kk', 'en')}
             for entry in json.loads((ROOT / 'apps/mobile/src/i18n/messages.json').read_text())
             if entry['ru'] == HINT)
# CartShortcut: the hint grows with Dynamic Type up to x1.4 and may then shrink to 0.7 to fit.
HINT_MAX_SCALE, HINT_MIN_FIT = 1.4, 0.7
CUSTOMER_ID = customer['id']
DRAFT_KEY = 'pickchick.commerce.pending.v1:' + CUSTOMER_ID
errors = []


def new_state(**overrides):
    return {'paths': [], 'held': [], 'quotes': 0, 'creates': 0, 'payments': 0, 'patches': 0,
            'legal': True, 'legal_version': 'fixture-v1', 'quote_total': '419000',
            'forbid_orders': False, 'phase': None, 'signed_in': True, 'combo_earned': None,
            'pay_result': 'awaiting_payment', 'quote_bodies': [], 'order_bodies': [], **overrides}


def make_context(browser, state, width=393, height=852, reduced='reduce'):
    ctx = isolated_context(browser, viewport={'width': width, 'height': height},
                           reduced_motion=reduced, has_touch=False)
    if state['signed_in']:
        ctx.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",'
                            + json.dumps(json.dumps(envelope)) + ');')
    me = {**customer, 'phone': '+7' + PHONE, 'nickname': 'Slide',
          'profile_completed_at': '2026-10-01T10:00:00.000Z'}
    expires = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat()

    def ok(route, data, status=200):
        route.fulfill(status=status, json=data, headers={'Access-Control-Allow-Origin': '*'})

    def route(r):
        path = urlparse(r.request.url).path
        method = r.request.method
        body = r.request.post_data_json if r.request.post_data else None
        state['paths'].append(method + ' ' + path)
        legal = {'version': state['legal_version'], 'accepted': state['legal'],
                 'terms_url': 'https://example.test/terms', 'privacy_url': 'https://example.test/privacy'}
        if path.endswith('/watch'):
            state['held'].append(r)
            return
        if path == '/v1/customers/me':
            if method == 'PATCH':
                assert body == {'legal_consents': {'terms_version': state['legal_version'],
                                                   'privacy_version': state['legal_version'],
                                                   'accepted': True}}, body
                state['patches'] += 1
                state['legal'] = True
                legal['accepted'] = True
            return ok(r, {'customer': me if not state['signed_in'] else customer, 'legal': legal})
        if path == '/v1/auth/config':
            return ok(r, {'enabled': True, 'delivery_consent_required': True,
                          'consent_version': 'fixture-v1', 'channels': ['telegram'],
                          'channel_selection': 'automatic', 'whatsapp_fallback_enabled': False,
                          'terms_url': 'https://example.test/terms',
                          'privacy_url': 'https://example.test/privacy'})
        if path == '/v1/auth/otp/request' and method == 'POST':
            assert body['phone'] == '+7' + PHONE
            now = datetime.now(timezone.utc)
            return ok(r, {'challenge_id': '40000000-0000-4000-8000-000000000073',
                          'expires_at': (now + timedelta(minutes=3)).isoformat(),
                          'resend_at': (now + timedelta(minutes=1)).isoformat(),
                          'delivery_status': 'submitted', 'channel': 'telegram', 'code_length': 4}, 202)
        if path == '/v1/auth/otp/verify' and method == 'POST':
            assert body['code'] == '9381'
            return ok(r, {'access_token': 'a' * 64, 'refresh_token': 'b' * 64, 'access_expires_at': expires,
                          'session_id': '40000000-0000-4000-8000-000000000072', 'customer': me})
        if path == '/v1/customer-checkout/availability':
            return ok(r, {'enabled': True, 'fresh': True, 'signature': 'a' * 64,
                          'products': [{'id': p['id'], 'available': True, 'stoppedOptions': []}
                                       for p in CATALOG['products']]})
        if path == '/v1/capabilities':
            return ok(r, {'schema_version': 1, 'environment': 'staging', 'data_mode': 'pilot',
                          'ordering_enabled': False,
                          'features': {'phone_auth': True, 'test_order_flow': True,
                                       **{k: False for k in ['payments', 'fiscal', 'checkout', 'loyalty']}}})
        if path == '/v1/branches':
            return ok(r, {'branches': [{'id': BRANCH, 'code': 'TEST', 'name': 'ТЦ Abay Plaza',
                                        'timezone': 'Asia/Almaty', 'ordering_enabled': False}]})
        if path == '/v1/branches/' + BRANCH + '/menu':
            return ok(r, {'schema_version': 1, 'branch_id': BRANCH,
                          'release_id': '10000000-0000-4000-8000-000000000008', 'version': 1,
                          'published_at': '2026-09-07T00:00:00Z', 'items': []})
        if path == '/v1/test/catalog':
            return ok(r, CATALOG)
        if path == '/v1/content/branches/' + BRANCH:
            return ok(r, {'schema_version': 1, 'branch_id': BRANCH, 'promos': [], 'games': []})
        if path == '/v1/customer-checkout/feedback' and method == 'GET':
            return ok(r, {'feedback': []})
        if path == '/v1/customer-checkout/config':
            return ok(r, {'enabled': True, 'branchId': BRANCH, 'restaurant': 'ТЦ Abay Plaza',
                          'fiscalPolicy': 'deferred_pilot', 'orderCommentEnabled': True})
        if path == '/v1/customer-checkout/combo-rewards' and state['combo_earned'] is not None:
            n = state['combo_earned']
            return ok(r, {'enabled': True, 'programId': '40000000-0000-4000-8000-000000000010',
                          'giftProductId': 'pick-combo', 'earnedUnits': n, 'completedCycles': n // 7,
                          'currentStamps': n % 7, 'availableGifts': n // 7, 'usedGifts': 0,
                          'reservedGifts': 0, 'reconciliationRequired': False,
                          'visibleStamps': 7 if n == 7 else n % 7, 'remainingToNextGift': 7 - n % 7})
        if path == '/v1/customer-checkout/quotes' and method == 'POST':
            state['quote_bodies'].append(body)
            state['quotes'] += 1
            return ok(r, {'quoteId': '40000000-0000-4000-8000-0000000000%02d' % (50 + state['quotes']),
                          'totalMinor': state['quote_total'], 'expiresAt': future,
                          'serviceMode': body['serviceMode'], 'kitchenComment': None})
        if path == '/v1/customer-checkout/orders' and method == 'GET':
            return ok(r, {'orders': [order(state['phase'])] if state['phase'] else []})
        if path == '/v1/customer-checkout/orders' and method == 'POST':
            state['order_bodies'].append(body)
            state['creates'] += 1
            if state['forbid_orders']:
                return refusal(r, 403, 'FORBIDDEN')
            state['phase'] = state['phase'] or 'ready_to_pay'
            return ok(r, order(state['phase']))
        if path.startswith('/v1/customer-checkout/orders/') and path.endswith('/payment'):
            state['payments'] += 1
            state['phase'] = state['pay_result']
            return ok(r, order(state['phase'], revision=2))
        if path.startswith('/v1/customer-checkout/orders/') and method == 'GET' and state['phase']:
            return ok(r, order(state['phase'], revision=2 if state['phase'] == 'awaiting_payment' else 1))
        r.abort()

    route_fixture(ctx, '**/v1/**', route)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    return ctx, page


def release(state):
    for held in state['held']:
        try:
            held.abort()
        except Exception:
            pass


def checkout_traffic(state):
    return [p for p in state['paths'] if any(part in p for part in ('/quotes', '/orders', '/payment'))]


def add(page, product='pick-combo'):
    page.get_by_test_id('product-' + product).click(timeout=25000)
    page.get_by_test_id('product-add').click()
    expect(page.get_by_test_id('screen-M09')).not_to_be_visible()
    expect(page.get_by_test_id('cart-shortcut')).to_be_visible()


def geometry(page):
    handle = page.get_by_test_id('cart-pay-handle').bounding_box()
    bar = page.get_by_test_id('cart-shortcut').bounding_box()
    return handle, bar, bar['width'] - 10 - handle['width']


def slide(page, fraction, hold=450, steps=12, release_at_end=True):
    handle, _, travel = geometry(page)
    x, y = handle['x'] + handle['width'] / 2, handle['y'] + handle['height'] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.wait_for_timeout(hold)
    for i in range(1, steps + 1):
        page.mouse.move(x + travel * fraction * i / steps, y)
        page.wait_for_timeout(16)
    if release_at_end:
        page.mouse.up()
    return handle['x'], travel


def opacity(locator):
    return locator.evaluate('(e) => { let o = 1; for (let n = e; n; n = n.parentElement) o *= +getComputedStyle(n).opacity; return o; }')


def minor(text):
    whole, _, fraction = text.replace('₸', '').replace(' ', '').replace('\u00a0', '').partition(',')
    return str(int(whole) * 100 + int((fraction or '0').ljust(2, '0')))


def wait_quiet(page, ms=2500):
    page.wait_for_timeout(ms)


def money_minor(text):
    import re
    found = re.findall(r'(\d[\d \u00a0\u202f]*(?:,\d+)?)\s?₸', text)
    assert found, text
    return minor(found[-1].replace('\u202f', ''))


def hint_fits(page):
    # The rendered hint at the normal size, and at the size iOS reaches with the largest text:
    # x1.4 (maxFontSizeMultiplier), then shrunk to the minimum fit scale (adjustsFontSizeToFit).
    return page.get_by_test_id('cart-pay-hint').evaluate('''(e, scale) => {
      const fits = () => e.scrollWidth <= e.clientWidth + 1;
      const size = parseFloat(getComputedStyle(e).fontSize);
      const normal = fits();
      e.style.fontSize = (size * scale) + 'px';
      const large = fits();
      const result = {normal, large, text: e.textContent, scroll: e.scrollWidth, client: e.clientWidth};
      e.style.fontSize = '';
      return result;
    }''', HINT_MAX_SCALE * HINT_MIN_FIT)


def scenario_bar_and_short_drag(browser, width, height, reduced):
    state = new_state()
    ctx, page = make_context(browser, state, width, height, reduced)
    page.goto(URL + '/menu')
    add(page)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
    handle = page.get_by_role('button', name='Оплатить через Kaspi', exact=True)
    expect(handle).to_have_count(1)
    expect(page.get_by_test_id('cart-shortcut-total')).to_have_text('4 190 ₸')
    # Total only: no time, no item count, no label in the bar.
    assert page.get_by_test_id('open-cart').inner_text().strip() == '4 190 ₸'
    expect(page.get_by_test_id('cart-recent-photo-0')).to_be_visible()
    expect(page.get_by_test_id('cart-recent-photo-1')).to_have_count(0)
    box, bar, travel = geometry(page)
    tab = page.get_by_test_id('tab-menu').bounding_box()
    assert box['width'] >= 44 and box['height'] >= 44, box
    assert bar['x'] >= 0 and bar['x'] + bar['width'] <= width and bar['y'] + bar['height'] <= tab['y'], (bar, tab)
    assert travel > 120, travel
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    # VoiceOver / keyboard order follows the picture: the Kaspi handle first, then the cart button.
    # Its frame is level with the cart button (same top and height), the visible pill inside it.
    cart_box = page.get_by_test_id('open-cart').bounding_box()
    assert abs(box['y'] - cart_box['y']) <= 1 and abs(box['height'] - cart_box['height']) <= 1, (box, cart_box)
    assert page.evaluate('''() => {
      const handle = document.querySelector('[data-testid="cart-pay-handle"]');
      const cart = document.querySelector('[data-testid="open-cart"]');
      return !!(handle.compareDocumentPosition(cart) & Node.DOCUMENT_POSITION_FOLLOWING);
    }''')
    handle.focus()
    page.keyboard.press('Tab')
    assert page.evaluate('document.activeElement && document.activeElement.dataset.testid') == 'open-cart'
    page.evaluate('document.activeElement.blur()')
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / f'bar-1-item-{width}.png'))
    # A short tap shows the hint and nothing else.
    page.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    expect(page.get_by_test_id('cart-pay-hint')).to_have_text(HINT)
    expect(page.get_by_test_id('cart-pay-hint')).to_have_count(0, timeout=4000)
    assert page.url.endswith('/menu'), page.url
    # A swipe without the hold never moves the handle (and never pays).
    start = box['x']
    slide(page, 1.0, hold=0)
    page.wait_for_timeout(400)
    assert abs(page.get_by_test_id('cart-pay-handle').bounding_box()['x'] - start) < 2
    assert page.url.endswith('/menu'), page.url
    # Hold: «тяни для оплаты», total and photos fade out.
    slide(page, 0.0, steps=1, release_at_end=False)
    expect(page.get_by_test_id('cart-pay-hint')).to_have_text(HINT)
    fit = hint_fits(page)
    assert fit['normal'] and fit['large'], fit
    page.wait_for_timeout(300)
    assert opacity(page.get_by_test_id('cart-shortcut-total')) < 0.05
    assert opacity(page.get_by_test_id('cart-recent-photo-0')) < 0.05
    page.screenshot(path=str(OUT / f'hold-{width}.png'))
    page.mouse.up()
    expect(page.get_by_test_id('cart-pay-hint')).to_have_count(0)
    # A short drag follows the finger, then springs back and does nothing.
    slide(page, 0.5, release_at_end=False)
    moved = page.get_by_test_id('cart-pay-handle').bounding_box()['x']
    assert moved - start > travel * 0.4, (moved, start, travel)
    page.screenshot(path=str(OUT / f'mid-drag-{width}.png'))
    page.mouse.up()
    page.wait_for_timeout(900)
    assert abs(page.get_by_test_id('cart-pay-handle').bounding_box()['x'] - start) < 2
    expect(page.get_by_test_id('cart-pay-hint')).to_have_count(0)
    assert opacity(page.get_by_test_id('cart-shortcut-total')) > 0.95
    # 80 % is still not enough.
    slide(page, 0.8)
    page.wait_for_timeout(900)
    assert page.url.endswith('/menu'), page.url
    # Keyboard / assistive activation opens checkout normally: nothing is sent by itself.
    handle.focus()
    page.keyboard.press('Enter')
    expect(page.get_by_test_id('kaspi-checkout-submit')).to_be_enabled(timeout=15000)
    wait_quiet(page)
    assert not checkout_traffic(state), checkout_traffic(state)
    assert state['quotes'] == state['creates'] == state['payments'] == 0, state
    release(state)
    ctx.close()


def scenario_full_slide(browser):
    state = new_state()
    ctx, page = make_context(browser, state, 393, 852, 'no-preference')
    page.goto(URL + '/menu')
    for product in ['pick-combo', 'burger', 'wedges', 'coleslaw']:
        add(page, product)
    page.wait_for_timeout(500)
    ids = [page.get_by_test_id(f'cart-recent-photo-{i}').get_attribute('id') for i in range(3)]
    assert ids == ['cart-recent-coleslaw', 'cart-recent-wedges', 'cart-recent-burger'], ids
    expect(page.get_by_test_id('cart-recent-photo-3')).to_have_count(0)
    page.screenshot(path=str(OUT / 'bar-4-items-393.png'))
    assert not checkout_traffic(state)
    # The server quote equals the total shown in the bar (no price change in this scenario).
    state['quote_total'] = minor(page.get_by_test_id('cart-shortcut-total').inner_text())
    slide(page, 1.0)
    expect(page.get_by_test_id('kaspi-connecting').or_(page.get_by_test_id('kaspi-waiting'))).to_be_visible(timeout=10000)
    page.screenshot(path=str(OUT / 'checkout-after-slide-393.png'))
    expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Ждём оплату в Kaspi', timeout=15000)
    page.screenshot(path=str(OUT / 'checkout-invoice-after-slide-393.png'))
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    # Reload of the same /checkout?slide=... and back navigation resend nothing.
    assert '/checkout' in page.url and 'slide=' in page.url, page.url
    page.reload()
    expect(page.get_by_test_id('kaspi-waiting')).to_be_visible(timeout=25000)
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    page.go_back()
    wait_quiet(page)
    page.go_forward()
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    release(state)
    ctx.close()


def scenario_price_change(browser):
    state = new_state(quote_total='429000')
    ctx, page = make_context(browser, state, 320, 568, 'reduce')
    page.goto(URL + '/menu')
    add(page)
    page.screenshot(path=str(OUT / 'bar-1-item-320-kaspi.png'))
    slide(page, 1.0)
    expect(page.get_by_text('Цены обновились. Проверьте итоговую сумму перед оплатой', exact=True)).to_be_visible(timeout=15000)
    button = page.get_by_test_id('kaspi-checkout-submit')
    expect(button).to_be_enabled()
    page.screenshot(path=str(OUT / 'checkout-price-changed-320.png'))
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 0, 0), state
    # Reload with the same intent in the address: nothing runs again.
    page.reload()
    expect(page.get_by_test_id('kaspi-checkout-submit')).to_be_enabled(timeout=25000)
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 0, 0), state
    # Only a new explicit press continues (the quote is re-read and confirmed by the press).
    page.get_by_test_id('kaspi-checkout-submit').click()
    expect(page.get_by_text('Цены обновились. Проверьте итоговую сумму перед оплатой', exact=True)).to_be_visible(timeout=15000)
    assert state['creates'] == 0 and state['quotes'] == 2, state
    page.get_by_test_id('kaspi-checkout-submit').click()
    expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Ждём оплату в Kaspi', timeout=15000)
    assert (state['quotes'], state['creates'], state['payments']) == (3, 1, 1), state
    release(state)
    ctx.close()


def scenario_consent(browser):
    state = new_state(legal=False, legal_version='fixture-v2')
    ctx, page = make_context(browser, state, 393, 852, 'reduce')
    page.goto(URL + '/menu')
    add(page)
    slide(page, 1.0)
    accept = page.get_by_test_id('checkout-legal-accept')
    expect(accept).to_be_visible(timeout=15000)
    assert (state['quotes'], state['creates'], state['payments'], state['patches']) == (0, 0, 0, 0), state
    page.screenshot(path=str(OUT / 'checkout-consent-393.png'))
    page.get_by_test_id('checkout-legal-close').click()
    expect(accept).to_have_count(0)
    expect(page.get_by_test_id('kaspi-checkout-submit')).to_be_enabled()
    wait_quiet(page)
    expect(accept).to_have_count(0)
    assert (state['quotes'], state['creates'], state['payments'], state['patches']) == (0, 0, 0, 0), state
    # A new slide is a new explicit action: accept, then one quote, order and invoice.
    page.get_by_test_id('checkout-close').click()
    expect(page.get_by_test_id('cart-shortcut')).to_be_visible(timeout=10000)
    page.wait_for_timeout(800)
    slide(page, 1.0)
    expect(accept).to_be_visible(timeout=15000)
    accept.click()
    expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Ждём оплату в Kaspi', timeout=15000)
    assert (state['quotes'], state['creates'], state['payments'], state['patches']) == (1, 1, 1, 1), state
    release(state)
    ctx.close()


def scenario_signed_out(browser):
    state = new_state(signed_in=False)
    ctx, page = make_context(browser, state, 393, 852, 'reduce')
    page.goto(URL + '/menu')
    add(page)
    slide(page, 1.0)
    expect(page.get_by_test_id('auth-welcome').filter(visible=True)).to_be_visible(timeout=15000)
    assert 'returnTo=M12' in page.url, page.url
    page.get_by_test_id('account-required-login').filter(visible=True).click()
    page.get_by_test_id('phone-input').filter(visible=True).fill(PHONE)
    page.get_by_test_id('request-otp').filter(visible=True).click()
    page.get_by_test_id('otp-input').filter(visible=True).fill('9381')
    button = page.get_by_test_id('kaspi-checkout-submit')
    expect(button).to_be_enabled(timeout=20000)
    assert page.url.rstrip('/').endswith('/checkout'), page.url
    wait_quiet(page)
    page.screenshot(path=str(OUT / 'signed-out-then-checkout-393.png'))
    assert not checkout_traffic(state) or all(p.startswith('GET ') for p in checkout_traffic(state)), checkout_traffic(state)
    assert (state['quotes'], state['creates'], state['payments']) == (0, 0, 0), state
    release(state)
    ctx.close()


def review_flow(browser, via_slide):
    state = new_state(forbid_orders=True)
    ctx, page = make_context(browser, state, 320, 568, 'reduce')
    page.goto(URL + '/menu')
    add(page)
    if via_slide:
        slide(page, 1.0)
    else:
        page.get_by_test_id('open-cart').click()
        page.get_by_test_id('cart-checkout').click()
        expect(page.get_by_test_id('kaspi-checkout-submit')).to_be_enabled(timeout=15000)
        page.get_by_test_id('kaspi-checkout-submit').click()
    wait_quiet(page, 4000)
    sheet = page.get_by_role('dialog', name='Оформление', exact=True).inner_text()
    counts = (state['quotes'], state['creates'], state['payments'])
    page.screenshot(path=str(OUT / f'review-account-{"slide" if via_slide else "press"}-320.png'))
    wait_quiet(page)
    assert counts == (state['quotes'], state['creates'], state['payments']), 'no automatic retry'
    assert not any('/payment' in path for path in state['paths']), state['paths']
    release(state)
    ctx.close()
    return sheet, counts


def scenario_review_account(browser):
    # App Review account: the server answers FORBIDDEN to every new order. The slide must end
    # exactly where a press of «Оплатить через Kaspi» ends: one quote, one refused create, no invoice.
    slid = review_flow(browser, True)
    pressed = review_flow(browser, False)
    assert slid == pressed, (slid, pressed)
    assert slid[1] == (1, 1, 0), slid


def scenario_review_demo(browser):
    # DEMO-1 (Apple review demonstration) is its own local screen: no cart bar, no handle and
    # no request that could create an order or an invoice, even with a full basket.
    state = new_state()
    ctx, page = make_context(browser, state, 393, 852, 'reduce')
    page.goto(URL + '/menu')
    add(page)
    page.goto(URL + '/demo-order')
    expect(page.get_by_test_id('demo-start')).to_be_visible(timeout=25000)
    expect(page.get_by_test_id('cart-shortcut')).to_have_count(0)
    expect(page.get_by_test_id('cart-pay-handle')).to_have_count(0)
    page.get_by_test_id('demo-start').click()
    expect(page.get_by_test_id('demo-approve')).to_be_visible()
    wait_quiet(page)
    assert not checkout_traffic(state), checkout_traffic(state)
    # The QA export opens its unpaid TEST session at launch (aborted here); nothing else mutates.
    mutations = [p for p in state['paths'] if not p.startswith('GET ') and p != 'POST /v1/test/sessions']
    assert not mutations, mutations
    release(state)
    ctx.close()


def scenario_combo_gift(browser):
    # The bar is a payment control: with a combo gift selected it shows the amount of «Оформить
    # заказ» and of the invoice, not the full basket.
    state = new_state(combo_earned=7)
    ctx, page = make_context(browser, state, 393, 852, 'reduce')
    page.goto(URL + '/menu')
    add(page, 'burger')
    full = minor(page.get_by_test_id('cart-shortcut-total').inner_text())
    page.get_by_test_id('open-cart').click()
    toggle = page.get_by_test_id('cart-use-combo-gift')
    expect(toggle).to_have_attribute('aria-checked', 'false', timeout=25000)
    toggle.scroll_into_view_if_needed()
    toggle.click()
    expect(toggle).to_have_attribute('aria-checked', 'true')
    button = page.get_by_test_id('cart-checkout')
    expect(button).to_be_enabled()
    cart_amount = money_minor(button.inner_text())
    page.get_by_test_id('cart-close').click()
    expect(page.get_by_test_id('screen-M09')).not_to_be_visible()
    bar = page.get_by_test_id('cart-shortcut-total')
    expect(bar).to_be_visible()
    bar_amount = minor(bar.inner_text())
    # Burger 2 390 + gift Pick Combo 4 190 - gift 4 190: the bar shows 2 390, never 6 580.
    assert bar_amount == cart_amount == '239000', (bar_amount, cart_amount, full)
    page.screenshot(path=str(OUT / 'bar-gift-393.png'))
    state['quote_total'] = bar_amount
    slide(page, 1.0)
    expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Ждём оплату в Kaspi', timeout=15000)
    # The quote equals the amount the customer slid on, so the checkout did not stop for a price
    # change: bar = cart button = checkout total = invoice.
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    assert state['quote_bodies'][0].get('giftItemIndex') is not None, state['quote_bodies']
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    release(state)
    ctx.close()


def scenario_hint_languages(browser):
    state = new_state()
    ctx, page = make_context(browser, state, 320, 568, 'reduce')
    page.goto(URL + '/menu')
    add(page)
    for lang in ['kk', 'en', 'ru']:
        page.goto(URL + '/screen/M34')
        page.get_by_test_id('language-' + lang).click()
        expect(page.get_by_test_id('language-' + lang)).to_have_attribute('aria-checked', 'true')
        page.goto(URL + '/menu')
        expect(page.get_by_test_id('cart-pay-handle')).to_be_visible(timeout=25000)
        expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=20000)
        slide(page, 0.0, steps=1, release_at_end=False)
        hint = page.get_by_test_id('cart-pay-hint')
        expect(hint).to_have_text(HINTS[lang])
        fit = hint_fits(page)
        assert fit['normal'] and fit['large'], (lang, fit)
        page.wait_for_timeout(200)
        page.screenshot(path=str(OUT / f'hold-{lang}-320.png'))
        page.mouse.up()
        expect(hint).to_have_count(0)
    assert not checkout_traffic(state), checkout_traffic(state)
    release(state)
    ctx.close()


def scenario_stale_draft(browser):
    # An intent saved long ago that never became an order (nothing billed) is still in storage
    # when the slide opens checkout. The press itself drops such an intent, so the slide pays once
    # and the old intent's key is never used.
    state = new_state()
    ctx, page = make_context(browser, state, 393, 852, 'reduce')
    page.goto(URL + '/menu')
    add(page)
    old = {'key': '40000000-0000-4000-8000-0000000000e1', 'quoteId': '40000000-0000-4000-8000-0000000000e2',
           'signature': '{"items":[]}', 'sendInvoice': True}
    # Written after launch, as an intent closed earlier in this run stays (PaymentRecovery does
    # not reopen it); createdAt is an hour old, so it may never send an invoice by itself.
    page.evaluate('([key, draft]) => localStorage.setItem(key, JSON.stringify({...draft, createdAt: Date.now() - 3600000}))',
                  [DRAFT_KEY, old])
    slide(page, 1.0)
    expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Ждём оплату в Kaspi', timeout=15000)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    assert all(body['key'] != old['key'] and body['quoteId'] != old['quoteId'] for body in state['order_bodies']), state['order_bodies']
    saved = json.loads(page.evaluate('(key) => localStorage.getItem(key)', DRAFT_KEY))
    assert saved['key'] != old['key'] and saved.get('orderId'), saved
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    release(state)
    ctx.close()


def scenario_back_to_cart(browser):
    # The slide opens checkout right over the tab. «Вернуться в корзину» must show the cart
    # (in place of checkout), not the menu tab that lies under checkout.
    state = new_state(pay_result='failed')
    ctx, page = make_context(browser, state, 393, 852, 'reduce')
    page.goto(URL + '/menu')
    add(page)
    slide(page, 1.0)
    back = page.get_by_role('button', name='Вернуться в корзину', exact=True)
    expect(back).to_be_visible(timeout=15000)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    back.click()
    expect(page.get_by_test_id('cart-checkout')).to_be_visible(timeout=10000)
    assert page.url.rstrip('/').endswith('/cart'), page.url
    expect(page.get_by_test_id('kaspi-checkout-submit')).to_have_count(0)
    page.screenshot(path=str(OUT / 'back-to-cart-after-slide-393.png'))
    # Closing the cart returns to the menu with the bar; nothing was sent again.
    page.get_by_test_id('cart-close').click()
    expect(page.get_by_test_id('cart-shortcut')).to_be_visible(timeout=10000)
    assert page.url.rstrip('/').endswith('/menu'), page.url
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    release(state)
    ctx.close()


if __name__ == '__main__':
    SELECTED = os.environ.get('SLIDE_TO_PAY', 'ABCDEFGHIJK').upper()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        if 'A' in SELECTED:
            scenario_bar_and_short_drag(browser, 393, 852, 'no-preference')
            scenario_bar_and_short_drag(browser, 320, 568, 'reduce')
        if 'B' in SELECTED:
            scenario_full_slide(browser)
        if 'C' in SELECTED:
            scenario_price_change(browser)
        if 'D' in SELECTED:
            scenario_consent(browser)
        if 'E' in SELECTED:
            scenario_signed_out(browser)
        if 'F' in SELECTED:
            scenario_review_account(browser)
        if 'G' in SELECTED:
            scenario_review_demo(browser)
        if 'H' in SELECTED:
            scenario_combo_gift(browser)
        if 'I' in SELECTED:
            scenario_hint_languages(browser)
        if 'J' in SELECTED:
            scenario_stale_draft(browser)
        if 'K' in SELECTED:
            scenario_back_to_cart(browser)
        browser.close()
    assert not errors, errors
    print('PASS slide to pay (' + SELECTED + '): hold hint, tap/swipe/short drag/keyboard send nothing, '
          'full drag = one quote + one order + one invoice, reload/back resend nothing, price change and '
          'consent stop before the order, signed-out sign-in lands on checkout without sending, '
          'App Review account refused once, DEMO-1 without cart bar or mutations, gift total = invoice, '
          'hint fits in RU/KK/EN at 320 pt, an old unbilled intent does not block the slide, '
          'back to cart after a slide')
