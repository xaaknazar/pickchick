"""Slide to pay from the cart bar (owner request 27.10.2026) through the guarded Kaspi checkout.

The Kaspi cart is the checkout (final integration 27.10.2026, no separate checkout page): the slide
opens the cart with payment (/cart, M09), which takes the one-shot intent and presses its own
«Оплатить с Kaspi.kz» (cart-pay) once.

Runs against the customer-auth web export (EXPO_PUBLIC_CUSTOMER_AUTH=server,
EXPO_PUBLIC_KASPI_CHECKOUT=1, EXPO_PUBLIC_UNPAID_TEST_ORDERS=1, EXPO_PUBLIC_PUBLISHED_CATALOG=0)
with local fixtures only: no bank, no real customer, no VPS request.
  A  bar zones; a tap shows the hint only; hold shows «тяни для оплаты»; an immediate partial swipe,
     a short drag and Enter on the handle send nothing (no /quotes, /orders or /payment request);
     the handle STRETCHES (owner 6a): its left edge stays at the bar's left edge, its width grows
     with the finger, the method mark rides at its right end (centred under the finger) and the
     pill covers the hint; an early release returns it to the base width on a visible spring
     (about 0.4 s, never narrower than the base width), at once with reduced motion
  B  a full drag fills the bar with the pill and creates exactly one quote, one order and one
     invoice; reload/back resend nothing
  C  a changed price stops before the order; only a second explicit press continues
  D  consent: the dialog stops the slide, «Не сейчас» leaves the normal button, no retry
  E  signed out: the slide opens the sign-in and then the cart without sending anything
  F  App Review account: the server refuses the order exactly as for a press, no retry, no invoice
  G  DEMO-1 demonstration: no cart bar or handle, no mutating request
  H  combo gift selected: bar total = «Оформить заказ» = checkout total = quote; one order, one invoice
  I  the hint «тяни для оплаты» fits at 320 pt in RU, KK and EN, also at the largest text size
  J  an old unbilled intent without an order is still saved when checkout opens: the slide still
     pays once (the press drops that intent), the old intent is never sent
  K  «Вернуться в корзину» after a failed payment from a slide shows the cart itself (one sheet)
  L  with the shared header and three tabs: on Меню, События and Заказы the bar with the Kaspi
     handle sits above the tab bar and below the header, the content ends above the bar, the
     profile stack screen shows no bar, and a full slide from События pays exactly once
  M  last used payment method (owner 6b): kept per account (no card data), set by a choice in
     «Способ оплаты» and by a payment sent; a method that is «скоро» today (Apple Pay, card) or a
     broken value falls back to Kaspi on the handle (mark + accessible name) and in the selector
  N  a future build where Apple Pay and the card can be chosen before their own payment flow
     exists (the served bundle is patched in this browser only): the handle, the selector and the
     pay button follow the choice («Оплатить картой», not «Оплатить с Банковская карта»), but a
     press or a slide stops with a visible message and sends nothing; «Выбрать Kaspi.kz» is only
     a choice, and the next explicit press pays once with Kaspi
  O  owner 28.10 (TestFlight 25): the server keeps answering «sending» after a slide: the glass X
     is there at once at the top right; after 20 s «Kaspi отвечает дольше обычного» with
     «Проверить ещё раз» (one read, nothing sent) and «Вернуться в корзину»; closing asks first,
     returns to the cart with its lines and keeps the intent without its automatic invoice; a
     changed cart paid again reopens the same order (no new quote, order or payment command) and
     says at once that it is stuck (the first time of the wait is kept) and, above the title, that
     it is the earlier order of 4 190 ₸ while the cart says 8 380 ₸ (QA 28.10, item 19); a restart
     after closing sends nothing
  P  review 28.10: the request itself hangs. POST /payment held: «Отправляем счёт» (not «Ресторан
     принял заказ») with the X at once, «Kaspi отвечает дольше обычного» after 20 s, the X asks,
     closing keeps the order id without the automatic invoice, paying again reopens the same order
     (1 quote, 1 order, 1 payment command) and is stuck at once (the same cart: no «прошлый заказ»
     notice). POST /orders held: the X at once,
     «Ресторан не подтверждает заказ» after 20 s with «Вернуться в корзину» (no check of its own),
     closing asks nothing and removes the intent, a restart sends nothing
"""
from browser_network import isolated_context, route_fixture
import json
import os
import re
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
METHOD_KEY = 'pickchick.payment.last-method.v1:' + CUSTOMER_ID
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
                          'giftProductId': 'pick-combo', 'earnedUnits': n, 'completedCycles': n // 6,
                          'currentStamps': n % 6, 'availableGifts': n // 6, 'usedGifts': 0,
                          'reservedGifts': 0, 'reconciliationRequired': False,
                          'visibleStamps': 6 if n == 6 else n % 6, 'remainingToNextGift': 6 - n % 6})
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
    # Hidden tab screens stay mounted on web: measure the bar the customer sees.
    handle = page.get_by_test_id('cart-pay-handle').filter(visible=True).bounding_box()
    bar = page.get_by_test_id('cart-shortcut').filter(visible=True).bounding_box()
    return handle, bar, bar['width'] - 10 - handle['width']


def pill(page):
    # The handle's frame (touch and VoiceOver target) and the visible pill inside it.
    return (page.get_by_test_id('cart-pay-handle').filter(visible=True).bounding_box(),
            page.get_by_test_id('cart-pay-pill').filter(visible=True).bounding_box())


def stored(page, key, **expected):
    # AsyncStorage writes localStorage asynchronously on the web build: wait for the value.
    page.wait_for_function('''([key, expected]) => {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return !!value && Object.entries(expected).every(([name, want]) => value[name] === want);
    }''', arg=[key, expected], timeout=5000)
    return json.loads(page.evaluate('(key) => localStorage.getItem(key)', key))


def mark_box(page, method='kaspi'):
    return page.locator('#cart-pay-mark-' + method).filter(visible=True).bounding_box()


def watch_pill(page, ms=1500):
    # The visible pill's width on every animation frame from now on (for the early release).
    page.get_by_test_id('cart-pay-pill').filter(visible=True).evaluate('''(pill, ms) => {
      const samples = window.__pillWidths = [];
      const start = performance.now();
      const tick = (now) => {
        samples.push([now - start, pill.getBoundingClientRect().width]);
        if (now - start < ms) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }''', ms)


def release_curve(page, start, rest):
    # How the pill returned from `start` to its base width: when it started to move, when it
    # reached the base width (within half a point), the share still left 120 ms after it started,
    # the narrowest width and whether it ever grew again on the way back.
    samples = page.evaluate('window.__pillWidths')
    moving = next(t for t, w in samples if w < start - 0.5)
    settled = next(t for t, w in samples if w <= rest + 0.5)
    left = next(w for t, w in samples if t >= moving + 120)
    widths = [w for _, w in samples]
    return {'moving': moving, 'settle_ms': settled - moving, 'left_at_120': (left - rest) / (start - rest),
            'narrowest': min(widths), 'monotonic': all(b <= a + 0.25 for a, b in zip(widths, widths[1:])),
            'frames': len(samples), 'start': start, 'rest': rest}


def slide(page, fraction, hold=0, steps=12, release_at_end=True):
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


def pay_button(page):
    # The Kaspi cart's pay button; the cart bar has its own cart-total, the cart sheet is scoped.
    return page.get_by_test_id('screen-M09').get_by_test_id('cart-pay')


def wait_quiet(page, ms=2500):
    page.wait_for_timeout(ms)


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
    _, rest = pill(page)
    tab = page.get_by_test_id('tab-menu').bounding_box()
    assert box['width'] >= 44 and box['height'] >= 44, box
    # The handle starts at the bar's left edge; the Kaspi mark (the only method today) is centred.
    assert 0 < box['x'] - bar['x'] <= 8 and abs(rest['x'] - box['x']) <= 1, (box, bar, rest)
    mark = mark_box(page)
    # Centred on the pill (and the finger), also across the glass rim: within half a point.
    assert abs(mark['x'] + mark['width'] / 2 - (rest['x'] + rest['width'] / 2)) <= 0.5, (mark, rest)
    assert abs(mark['y'] + mark['height'] / 2 - (rest['y'] + rest['height'] / 2)) <= 0.5, (mark, rest)
    expect(page.locator('#cart-pay-mark-apple_pay, #cart-pay-mark-google_pay, #cart-pay-mark-card')).to_have_count(0)
    expect(handle).to_have_attribute('aria-label', 'Оплатить через Kaspi')
    assert bar['x'] >= 0 and bar['x'] + bar['width'] <= width and bar['y'] + bar['height'] <= tab['y'], (bar, tab)
    assert travel > 120, travel
    assert bar['width'] <= 320.5 and bar['x'] >= 23, bar
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
    # An immediate partial swipe stretches, then returns without payment.
    start = box['x']
    slide(page, 0.5, hold=0, release_at_end=False)
    assert pill(page)[0]['width'] > box['width'] + 20
    page.mouse.up()
    page.wait_for_timeout(600)
    after, _ = pill(page)
    assert abs(after['x'] - start) < 1 and abs(after['width'] - box['width']) < 1, (after, box)
    assert page.url.endswith('/menu'), page.url
    # Hold: «тяни для оплаты», total and photos fade out.
    slide(page, 0.05, steps=1, release_at_end=False)
    expect(page.get_by_test_id('cart-pay-hint')).to_have_text(HINT)
    fit = hint_fits(page)
    assert fit['normal'] and fit['large'], fit
    page.wait_for_timeout(300)
    assert opacity(page.get_by_test_id('cart-shortcut-total')) < 0.05
    assert opacity(page.get_by_test_id('cart-recent-photo-0')) < 0.05
    page.screenshot(path=str(OUT / f'hold-{width}.png'))
    page.mouse.up()
    expect(page.get_by_test_id('cart-pay-hint')).to_have_count(0)
    # A short drag STRETCHES the pill (owner 6a): the left edge stays where it was, the width
    # grows with the finger, the mark rides at the right end under the finger and the pill
    # covers the start of «тяни для оплаты». It never just slides sideways.
    x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.wait_for_timeout(450)
    widths = []
    for i in range(1, 13):
        page.mouse.move(x + travel * 0.5 * i / 12, y)
        page.wait_for_timeout(16)
        if i % 4 == 0:
            frame, visible = pill(page)
            assert abs(frame['x'] - start) < 1 and abs(visible['x'] - start) < 1.5, (i, frame, visible, start)
            widths.append(visible['width'])
    assert widths == sorted(widths) and widths[0] > rest['width'] + 10, widths
    frame, visible = pill(page)
    finger = x + travel * 0.5
    assert abs(visible['width'] - (rest['width'] + travel * 0.5)) <= 3, (visible, rest, travel)
    assert abs(frame['width'] - visible['width']) <= 1, (frame, visible)
    mark = mark_box(page)
    assert abs(mark['x'] + mark['width'] / 2 - finger) <= 1, (mark, finger)
    assert abs(mark['y'] + mark['height'] / 2 - y) <= 0.5, (mark, y)
    assert visible['x'] + visible['width'] - (mark['x'] + mark['width']) <= rest['width'] / 2, (mark, visible)
    hint_box = page.get_by_test_id('cart-pay-hint').bounding_box()
    assert visible['x'] + visible['width'] > hint_box['x'] + 20, ('the pill covers the hint', visible, hint_box)
    # The hint stays at full strength: the pill covers it, it does not fade away.
    assert opacity(page.get_by_test_id('cart-pay-hint')) > 0.95
    page.screenshot(path=str(OUT / f'mid-drag-{width}.png'))
    stretched = visible['width']
    watch_pill(page)
    page.mouse.up()
    page.wait_for_timeout(1700)
    # Early release: back to the base width at the same left edge, nothing sent.
    frame, visible = pill(page)
    assert abs(frame['x'] - start) < 1 and abs(visible['width'] - rest['width']) < 1.5, (frame, visible, rest)
    assert abs(frame['width'] - box['width']) < 1.5, (frame, box)
    mark = mark_box(page)
    assert abs(mark['x'] + mark['width'] / 2 - (rest['x'] + rest['width'] / 2)) <= 0.5, (mark, rest)
    # The way back (owner 6a): a visible spring that shrinks without ever going narrower than the
    # base width or growing again, about 0.4 s; with reduced motion the width is set at once.
    curve = release_curve(page, stretched, rest['width'])
    print(f'early release {width}x{height} {reduced}: {curve}')
    assert curve['monotonic'] and curve['narrowest'] >= rest['width'] - 0.5, curve
    if reduced == 'reduce':
        assert curve['settle_ms'] <= 50, curve
    else:
        assert 250 <= curve['settle_ms'] <= 1200 and curve['left_at_120'] >= 0.15, curve
    expect(page.get_by_test_id('cart-pay-hint')).to_have_count(0)
    assert opacity(page.get_by_test_id('cart-shortcut-total')) > 0.95
    # 80 % is still not enough.
    slide(page, 0.8)
    page.wait_for_timeout(900)
    assert page.url.endswith('/menu'), page.url
    # Keyboard / assistive activation opens the cart with payment normally: nothing is sent.
    handle.focus()
    page.keyboard.press('Enter')
    expect(pay_button(page)).to_be_enabled(timeout=15000)
    assert urlparse(page.url).path.rstrip('/') == '/cart' and 'slide=' not in page.url, page.url
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
    start, bar_box = geometry(page)[0], geometry(page)[1]
    slide(page, 1.0, release_at_end=False)
    # At the end the pill fills the bar, still anchored at its left edge; nothing is sent yet.
    frame, visible = pill(page)
    assert abs(visible['x'] - start['x']) < 1.5, (visible, start)
    assert visible['width'] >= bar_box['width'] - 10 - 3, (visible, bar_box)
    assert visible['x'] + visible['width'] <= bar_box['x'] + bar_box['width'], (visible, bar_box)
    page.screenshot(path=str(OUT / 'full-stretch-393.png'))
    assert not checkout_traffic(state), checkout_traffic(state)
    page.mouse.up()
    expect(page.get_by_test_id('kaspi-connecting').or_(page.get_by_test_id('kaspi-waiting'))).to_be_visible(timeout=10000)
    page.screenshot(path=str(OUT / 'checkout-after-slide-393.png'))
    expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Ждём оплату в Kaspi', timeout=15000)
    page.screenshot(path=str(OUT / 'checkout-invoice-after-slide-393.png'))
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    saved = stored(page, METHOD_KEY, method='kaspi', source='payment')
    assert set(saved) == {'method', 'source', 'at'}, saved
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    # Reload of the same /cart?slide=... and back navigation resend nothing.
    assert urlparse(page.url).path.rstrip('/') == '/cart' and 'slide=' in page.url, page.url
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
    button = pay_button(page)
    expect(button).to_be_enabled()
    page.screenshot(path=str(OUT / 'checkout-price-changed-320.png'))
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 0, 0), state
    # Reload with the same intent in the address: nothing runs again.
    page.reload()
    expect(pay_button(page)).to_be_enabled(timeout=25000)
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 0, 0), state
    # Only a new explicit press continues (the quote is re-read and confirmed by the press).
    pay_button(page).click()
    expect(page.get_by_text('Цены обновились. Проверьте итоговую сумму перед оплатой', exact=True)).to_be_visible(timeout=15000)
    assert state['creates'] == 0 and state['quotes'] == 2, state
    pay_button(page).click()
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
    expect(pay_button(page)).to_be_enabled()
    wait_quiet(page)
    expect(accept).to_have_count(0)
    assert (state['quotes'], state['creates'], state['payments'], state['patches']) == (0, 0, 0, 0), state
    # A new slide is a new explicit action: accept, then one quote, order and invoice.
    page.get_by_test_id('cart-close').click()
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
    assert 'returnTo=M09' in page.url, page.url
    page.get_by_test_id('account-required-login').filter(visible=True).click()
    page.get_by_test_id('phone-input').filter(visible=True).fill(PHONE)
    page.get_by_test_id('request-otp').filter(visible=True).click()
    page.get_by_test_id('otp-input').filter(visible=True).fill('9381')
    button = pay_button(page)
    expect(button).to_be_enabled(timeout=20000)
    assert urlparse(page.url).path.rstrip('/') == '/cart' and 'slide=' not in page.url, page.url
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
        expect(pay_button(page)).to_be_enabled(timeout=15000)
        pay_button(page).click()
    wait_quiet(page, 4000)
    sheet = page.get_by_role('dialog', name='Корзина', exact=True).inner_text()
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
    # The bar is a payment control: with a combo gift selected it shows the amount of the cart's
    # «Итого» and of the invoice, not the full basket (promo 6 + 1 since 27.10.2026).
    state = new_state(combo_earned=6)
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
    expect(pay_button(page)).to_be_enabled()
    cart_amount = minor(page.get_by_test_id('screen-M09').get_by_test_id('cart-total').inner_text())
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
    # The quote equals the amount the customer slid on, so the cart did not stop for a price
    # change: bar = cart «Итого» = invoice.
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
        slide(page, 0.05, steps=1, release_at_end=False)
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
    # The slide opens the cart with payment right over the tab. After a failed payment
    # «Вернуться в корзину» shows that cart itself again, never a second cart sheet or the tab.
    state = new_state(pay_result='failed')
    ctx, page = make_context(browser, state, 393, 852, 'reduce')
    page.goto(URL + '/menu')
    add(page)
    slide(page, 1.0)
    # The connecting scene has its own «Вернуться в корзину» (abort before anything is sent), so
    # wait for the failed payment scene before reading the counts.
    failed = page.get_by_test_id('kaspi-failed')
    expect(failed).to_be_visible(timeout=15000)
    back = failed.get_by_role('button', name='Вернуться в корзину', exact=True)
    expect(back).to_be_visible()
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    back.click()
    expect(pay_button(page)).to_be_visible(timeout=10000)
    assert urlparse(page.url).path.rstrip('/') == '/cart', page.url
    expect(page.get_by_test_id('screen-M09')).to_have_count(1)
    expect(back).to_have_count(0)
    page.screenshot(path=str(OUT / 'back-to-cart-after-slide-393.png'))
    # Closing the cart returns to the menu with the bar; nothing was sent again.
    page.get_by_test_id('cart-close').click()
    expect(page.get_by_test_id('cart-shortcut')).to_be_visible(timeout=10000)
    assert urlparse(page.url).path.rstrip('/') == '/menu', page.url
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    release(state)
    ctx.close()


def content_bottom(page, screen):
    # Bottom edge of the last laid-out block of a tab once its list is fully scrolled.
    scroll = page.get_by_test_id('scroll-' + screen)
    scroll.evaluate('(e) => { e.scrollTop = e.scrollHeight; }')
    page.wait_for_timeout(300)
    return scroll.evaluate('''(e) => {
      let bottom = 0;
      for (const child of e.firstElementChild.children) {
        const r = child.getBoundingClientRect();
        if (r.height > 0) bottom = Math.max(bottom, r.bottom);
      }
      return bottom;
    }''')


def scenario_tabs(browser, width, height):
    # Integration of the header lane (shared header, three tabs, profile as a stack screen) with
    # the cart bar: the same bar and Kaspi handle on every tab, never under the header, never
    # over the content end, never on the profile; the slide works from a tab other than the menu.
    state = new_state()
    ctx, page = make_context(browser, state, width, height, 'reduce')
    page.goto(URL + '/menu')
    add(page)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
    expect(page.get_by_test_id('tab-profile')).to_have_count(0)
    for route, screen in [('menu', 'M06'), ('events', 'M26'), ('orders', 'M19')]:
        page.get_by_test_id('tab-' + route).click()
        scope = page.get_by_test_id('screen-' + screen)
        expect(scope).to_be_visible()
        expect(scope.get_by_test_id('header-profile')).to_be_visible()
        expect(page.get_by_test_id('cart-shortcut').filter(visible=True)).to_have_count(1)
        expect(page.get_by_test_id('cart-pay-handle').filter(visible=True)).to_have_count(1)
        expect(page.get_by_test_id('cart-shortcut-total').filter(visible=True)).to_have_text('4 190 ₸')
        handle, bar, travel = geometry(page)
        tabs = page.get_by_test_id('floating-tab-bar').bounding_box()
        head = scope.get_by_test_id('app-header-bar').bounding_box()
        assert 0 <= tabs['y'] - (bar['y'] + bar['height']) <= 18, (route, bar, tabs)
        assert head['y'] + head['height'] <= bar['y'], (route, head, bar)
        assert bar['x'] >= 0 and bar['x'] + bar['width'] <= width, (route, bar)
        assert handle['width'] >= 44 and handle['height'] >= 44 and travel > 120, (route, handle, travel)
        # The bar's measured height is reserved: the end of the tab content stays above it.
        assert content_bottom(page, screen) <= bar['y'] + 1, (route, width)
        head = scope.get_by_test_id('app-header-bar').bounding_box()
        assert head['y'] + head['height'] <= bar['y'], (route, head, bar)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(OUT / f'tab-{route}-{width}.png'))
    # Hold on another tab: the same hint, nothing sent.
    page.get_by_test_id('tab-events').click()
    expect(page.get_by_test_id('screen-M26')).to_be_visible()
    slide(page, 0.05, steps=1, release_at_end=False)
    expect(page.get_by_test_id('cart-pay-hint').filter(visible=True)).to_have_text(HINT)
    page.mouse.up()
    expect(page.get_by_test_id('cart-pay-hint')).to_have_count(0)
    # The profile is a stack screen above the tabs: no bar, no handle, no tab bar.
    page.get_by_test_id('screen-M26').get_by_test_id('header-profile').click()
    expect(page.get_by_test_id('screen-M30')).to_be_visible(timeout=15000)
    page.wait_for_timeout(500)
    expect(page.get_by_test_id('cart-shortcut').filter(visible=True)).to_have_count(0)
    expect(page.get_by_test_id('cart-pay-handle').filter(visible=True)).to_have_count(0)
    expect(page.get_by_test_id('floating-tab-bar').filter(visible=True)).to_have_count(0)
    page.get_by_test_id('profile-back').click()
    expect(page.get_by_test_id('screen-M26')).to_be_visible()
    expect(page.get_by_test_id('cart-pay-handle').filter(visible=True)).to_have_count(1)
    wait_quiet(page, 800)
    # Заказы reads the order list (GET); nothing was quoted, created or billed.
    sent = [path for path in checkout_traffic(state) if not path.startswith('GET ')]
    assert not sent and (state['quotes'], state['creates'], state['payments']) == (0, 0, 0), (sent, state)
    # A full slide from События: one quote, one order, one invoice, as from the menu.
    state['quote_total'] = minor(page.get_by_test_id('cart-shortcut-total').filter(visible=True).inner_text())
    slide(page, 1.0)
    expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Ждём оплату в Kaspi', timeout=15000)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    release(state)
    ctx.close()


def scenario_payment_method(browser):
    # Owner 6b: the handle shows the customer's last used payment method. Today only Kaspi.kz
    # pays, so a saved Apple Pay or card (from a future build) and a broken value fall back to
    # Kaspi; a choice in «Способ оплаты» and a payment sent are remembered per account.
    state = new_state()
    ctx, page = make_context(browser, state, 393, 852, 'reduce')
    other = 'pickchick.payment.last-method.v1:40000000-0000-4000-8000-0000000000b2'
    seeded = {'method': 'apple_pay', 'source': 'payment', 'at': 1761500000000}
    ctx.add_init_script('if (!sessionStorage.getItem("method-seeded")) {'
                        f'localStorage.setItem({json.dumps(METHOD_KEY)}, {json.dumps(json.dumps(seeded))});'
                        f'localStorage.setItem({json.dumps(other)}, {json.dumps(json.dumps({**seeded, "method": "card"}))});'
                        'sessionStorage.setItem("method-seeded", "1"); }')
    page.goto(URL + '/menu')
    add(page)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
    handle = page.get_by_test_id('cart-pay-handle').filter(visible=True)
    expect(handle).to_have_attribute('aria-label', 'Оплатить через Kaspi')
    expect(page.locator('#cart-pay-mark-kaspi')).to_be_visible()
    expect(page.locator('#cart-pay-mark-apple_pay')).to_have_count(0)
    # The fallback does not erase the saved value: once Apple Pay works it is shown again.
    assert json.loads(page.evaluate('(key) => localStorage.getItem(key)', METHOD_KEY))['method'] == 'apple_pay'
    # The cart's selector opens preselected with the same method.
    page.get_by_test_id('open-cart').click()
    method = page.get_by_test_id('cart-payment-method')
    expect(method).to_contain_text('Kaspi.kz', timeout=15000)
    expect(method).to_have_attribute('aria-label', 'Способ оплаты: Kaspi.kz, изменить')
    method.click()
    expect(page.get_by_test_id('cart-payment-kaspi')).to_have_attribute('aria-checked', 'true')
    expect(page.get_by_test_id('cart-payment-apple_pay')).to_have_attribute('aria-checked', 'false')
    # «Скоро» methods cannot be chosen, so nothing is remembered for them.
    page.get_by_test_id('cart-payment-apple_pay').click(force=True)
    assert json.loads(page.evaluate('(key) => localStorage.getItem(key)', METHOD_KEY))['source'] == 'payment'
    page.get_by_test_id('cart-payment-kaspi').click()
    expect(page.get_by_test_id('cart-payment-sheet')).to_have_count(0)
    saved = stored(page, METHOD_KEY, method='kaspi', source='choice')
    assert set(saved) == {'method', 'source', 'at'}, saved
    # Another account's value on the same device is untouched.
    assert json.loads(page.evaluate('(key) => localStorage.getItem(key)', other))['method'] == 'card'
    assert not checkout_traffic(state) or all(p.startswith('GET ') for p in checkout_traffic(state)), checkout_traffic(state)
    page.get_by_test_id('cart-close').click()
    expect(page.get_by_test_id('cart-shortcut')).to_be_visible(timeout=10000)
    # A broken saved value reads as a new customer: Kaspi, nothing thrown.
    page.evaluate('(key) => localStorage.setItem(key, \'{"method":"card","pan":"0"}\')', METHOD_KEY)
    page.reload()
    expect(page.get_by_test_id('cart-pay-handle').filter(visible=True)).to_have_attribute('aria-label', 'Оплатить через Kaspi', timeout=25000)
    expect(page.locator('#cart-pay-mark-kaspi')).to_be_visible()
    page.screenshot(path=str(OUT / 'payment-method-fallback-393.png'))
    # The slide pays with that method (Kaspi): one quote, one order, one invoice, then remembered.
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=20000)
    state['quote_total'] = minor(page.get_by_test_id('cart-shortcut-total').filter(visible=True).inner_text())
    slide(page, 1.0)
    expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Ждём оплату в Kaspi', timeout=15000)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    stored(page, METHOD_KEY, method='kaspi', source='payment')
    release(state)
    ctx.close()


# Apple Pay and the card as a future build would list them: available, without their own flow yet.
FUTURE_METHODS = re.compile(r"(\{id:'(apple_pay|card)',label:\w+\('\2'\),available:)!1\}")


def text(locator):
    # Visible words only: icon glyphs (the card mark is an icon font character) are left out.
    return locator.evaluate("(e) => e.innerText.replace(/[\\uE000-\\uF8FF]/g, '').replace(/\\s+/g, ' ').trim()")


def posts(state):
    return [p for p in checkout_traffic(state) if not p.startswith('GET ')]


def close_box_ok(page, width, height):
    # The glass X of a payment screen: top right, a 44 pt target, the top element at its centre.
    close = page.get_by_test_id('kaspi-state-close')
    expect(close).to_be_visible()
    box = close.bounding_box()
    sheet = page.get_by_test_id('order-sheet').bounding_box()
    assert box['width'] >= 44 and box['height'] >= 44, box
    assert width - 16 - box['width'] - 2 <= box['x'] and box['x'] + box['width'] <= width - 14, (box, width)
    assert sheet['y'] <= box['y'] <= sheet['y'] + 24, (box, sheet)
    hit = page.evaluate('([x, y]) => !!document.elementFromPoint(x, y)?.closest("[data-testid=kaspi-state-close]")',
                        [box['x'] + box['width'] / 2, box['y'] + box['height'] / 2])
    assert hit, 'the X is the top element at its centre'
    return close


def scenario_stuck_sending(browser, width, height):
    # Owner 28.10.2026 (TestFlight 25): the slide reached «Отправляем счёт», the invoice never
    # came and the screen had nothing to press. The server here keeps answering «sending».
    state = new_state(pay_result='sending')
    ctx, page = make_context(browser, state, width, height, 'reduce')
    # Real time: an installed fake clock makes the web build drop some drags of the handle.
    page.goto(URL + '/menu')
    add(page)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
    expect(page.get_by_test_id('cart-pay-handle').filter(visible=True)).to_be_visible(timeout=15000)
    slide(page, 1.0)
    scene = page.get_by_test_id('kaspi-waiting')
    expect(scene).to_contain_text('Отправляем счёт', timeout=15000)
    # «Отправляем счёт» is shown as soon as the payment command starts (review 28.10), before its
    # POST /payment reaches the fixture: wait for that one request instead of racing it.
    for _ in range(100):
        if state['payments']:
            break
        page.wait_for_timeout(100)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    # The X is there at once, top right; the bottom «Закрыть» still waits as before (90 s).
    close = close_box_ok(page, width, height)
    expect(page.get_by_test_id('kaspi-close-order')).to_have_count(0)
    expect(page.get_by_test_id('kaspi-stuck-recheck')).to_have_count(0)
    page.screenshot(path=str(OUT / f'esc-sending-x-{width}.png'))
    # 20 s without news: an honest title and its actions instead of «Подождите немного».
    page.wait_for_timeout(15_000)
    expect(scene).to_contain_text('Отправляем счёт')
    expect(scene).to_contain_text('Kaspi отвечает дольше обычного', timeout=10_000)
    expect(scene.get_by_test_id('kaspi-state-detail')).to_contain_text('Счёт ещё не пришёл в Kaspi')
    recheck = page.get_by_test_id('kaspi-stuck-recheck')
    back = page.get_by_test_id('kaspi-stuck-cart')
    expect(recheck).to_be_visible()
    expect(back).to_have_text('Вернуться в корзину')
    expect(close).to_be_visible()
    footer = scene.get_by_test_id('bottom-actions').bounding_box()
    for control in (recheck, back):
        box = control.bounding_box()
        assert box['height'] >= 44 and box['y'] + box['height'] <= height + 1, (box, height)
        assert footer['y'] - 1 <= box['y'], (box, footer)
    page.screenshot(path=str(OUT / f'esc-sending-stuck-{width}.png'))
    # «Проверить ещё раз» only reads the order: no quote, order or payment command.
    read = 'GET /v1/customer-checkout/orders/' + order('sending')['orderId']
    reads = state['paths'].count(read)
    recheck.click()
    for _ in range(40):
        if state['paths'].count(read) > reads:
            break
        page.wait_for_timeout(100)
    assert state['paths'].count(read) == reads + 1, state['paths'][-6:]
    assert not posts(state)[3:], posts(state)
    expect(scene).to_contain_text('Kaspi отвечает дольше обычного')
    # The bank may still act: «Закрыть оплату?» first; «Остаться» keeps the screen.
    back.click()
    dialog = page.get_by_test_id('kaspi-close-dialog')
    expect(dialog).to_be_visible()
    expect(dialog).to_contain_text('Закрыть оплату?')
    expect(dialog).to_contain_text('Повторная оплата откроет этот же заказ - второй счёт не создаётся.')
    page.screenshot(path=str(OUT / f'esc-confirm-{width}.png'))
    page.get_by_test_id('kaspi-close-stay').click()
    expect(dialog).to_have_count(0)
    expect(scene).to_be_visible()
    close.click()
    expect(dialog).to_be_visible()
    page.get_by_test_id('kaspi-close-confirm').click()
    # Back in the cart itself (one sheet, the same /cart), with its lines; nothing was cancelled.
    expect(pay_button(page)).to_be_enabled(timeout=10000)
    expect(page.get_by_test_id('kaspi-waiting')).to_have_count(0)
    expect(page.get_by_test_id('screen-M09')).to_have_count(1)
    expect(page.get_by_test_id('cart-quantity-pick-combo')).to_have_text('1')
    assert urlparse(page.url).path.rstrip('/') == '/cart', page.url
    saved = stored(page, DRAFT_KEY, orderId=order('sending')['orderId'], sendInvoice=False)
    assert saved['orderId'] == order('sending')['orderId'], saved
    page.screenshot(path=str(OUT / f'esc-back-in-cart-{width}.png'))
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    # The cart can change; paying again reopens the same order at the bank: no new quote, order
    # or payment command for it.
    page.get_by_test_id('cart-plus-pick-combo').click()
    expect(page.get_by_test_id('cart-quantity-pick-combo')).to_have_text('2')
    expect(pay_button(page)).to_be_enabled(timeout=10000)
    pay_button(page).click()
    # The order has been «sending» for more than 20 s in this app run: it says so at once
    # (review 28.10: the first time of a wait is kept per order, on the phone clock).
    expect(scene).to_contain_text('Kaspi отвечает дольше обычного', timeout=5000)
    # QA 28.10 (item 19): the cart now says 8 380 ₸, so the reopened screen says at once that this
    # is the earlier order of 4 190 ₸ and why no new one, above the title, under the X.
    earlier = page.get_by_test_id('kaspi-earlier-order')
    expect(earlier).to_be_visible()
    expect(earlier).to_have_text('Это ваш прошлый заказ на 4 190 ₸. Пока Kaspi обрабатывает его счёт, новый '
                                 'заказ не создаётся - так вы не оплатите дважды. Корзина сохранена.')
    note = earlier.bounding_box()
    x_box = page.get_by_test_id('kaspi-state-close').bounding_box()
    assert note['y'] >= x_box['y'] + x_box['height'] - 1, (note, x_box)
    assert note['x'] >= 0 and note['x'] + note['width'] <= width, (note, width)
    footer = scene.get_by_test_id('bottom-actions').bounding_box()
    assert note['y'] + note['height'] <= footer['y'], (note, footer)
    # The words come first: at 320 x 568 the decorative scene gives way, so the stuck detail stays
    # above the buttons instead of scrolling under them.
    detail = scene.get_by_test_id('kaspi-state-detail').bounding_box()
    assert detail['y'] + detail['height'] <= footer['y'] + 1, (detail, footer)
    expect(page.get_by_test_id('kaspi-stuck-recheck')).to_be_visible()
    expect(page.get_by_test_id('kaspi-stuck-cart')).to_be_visible()
    page.screenshot(path=str(OUT / f'esc-earlier-order-{width}.png'))
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    # Closed again and the app restarted on the cart: the order comes back for recovery, nothing
    # is sent again.
    page.get_by_test_id('kaspi-state-close').click()
    page.get_by_test_id('kaspi-close-confirm').click()
    expect(pay_button(page)).to_be_visible(timeout=10000)
    page.reload()
    expect(page.get_by_test_id('kaspi-waiting').or_(pay_button(page))).to_be_visible(timeout=25000)
    wait_quiet(page)
    if page.get_by_test_id('kaspi-waiting').count():
        # Restored on the 2-combo cart after the restart: the same explanation.
        expect(page.get_by_test_id('kaspi-earlier-order')).to_contain_text('4 190 ₸')
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    release(state)
    ctx.close()


def held(page, routes):
    # Wait until the fixture holds the request (the app sent it and waits for the answer).
    for _ in range(150):
        if routes:
            return
        page.wait_for_timeout(100)
    raise AssertionError('the request was never sent')


def scenario_held_payment(browser, width, height):
    # Review 28.10.2026: the server took the payment command (the order is «sending») but its
    # answer hangs; prepareCheckout keeps it up to 60 s. The screen must not read «Ресторан принял
    # заказ / Можно отправить счёт» meanwhile, and the X must work at once.
    state = new_state(pay_result='sending')
    ctx, page = make_context(browser, state, width, height, 'reduce')
    routes = []

    def hold(route):
        state['paths'].append('HELD ' + route.request.method + ' ' + urlparse(route.request.url).path)
        state['payments'] += 1
        state['phase'] = 'sending'
        routes.append(route)

    route_fixture(ctx, '**/v1/customer-checkout/orders/*/payment', hold)
    page.goto(URL + '/menu')
    add(page)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
    expect(page.get_by_test_id('cart-pay-handle').filter(visible=True)).to_be_visible(timeout=15000)
    slide(page, 1.0)
    held(page, routes)
    scene = page.get_by_test_id('kaspi-waiting')
    expect(scene).to_contain_text('Отправляем счёт', timeout=5000)
    expect(scene).not_to_contain_text('Ресторан принял заказ')
    expect(page.get_by_role('button', name='Отправить счёт на', exact=False)).to_have_count(0)
    close = close_box_ok(page, width, height)
    page.screenshot(path=str(OUT / f'esc-held-payment-x-{width}.png'))
    # 20 s of a running command is the bank's wait: the honest text and its actions.
    expect(scene).to_contain_text('Kaspi отвечает дольше обычного', timeout=25_000)
    expect(scene.get_by_test_id('kaspi-state-detail')).to_contain_text('Счёт ещё не пришёл в Kaspi')
    expect(page.get_by_test_id('kaspi-stuck-recheck')).to_be_visible()
    expect(page.get_by_test_id('kaspi-stuck-cart')).to_have_text('Вернуться в корзину')
    page.screenshot(path=str(OUT / f'esc-held-payment-stuck-{width}.png'))
    # The bank may act: the X asks first; closing keeps the order without its automatic invoice.
    close.click()
    dialog = page.get_by_test_id('kaspi-close-dialog')
    expect(dialog).to_contain_text('Закрыть оплату?')
    expect(dialog).to_contain_text('Если счёт всё же придёт в Kaspi')
    page.get_by_test_id('kaspi-close-confirm').click()
    expect(pay_button(page)).to_be_enabled(timeout=10000)
    expect(scene).to_have_count(0)
    expect(page.get_by_test_id('cart-quantity-pick-combo')).to_have_text('1')
    saved = stored(page, DRAFT_KEY, orderId=order('sending')['orderId'], sendInvoice=False)
    assert saved['orderId'] == order('sending')['orderId'], saved
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    # Paying again reopens the same order, nothing new is created or sent, and it is stuck at once.
    pay_button(page).click()
    expect(scene).to_contain_text('Kaspi отвечает дольше обычного', timeout=5000)
    # The same cart: simply the same order, no «прошлый заказ» notice (QA 28.10, item 19).
    expect(page.get_by_test_id('kaspi-earlier-order')).to_have_count(0)
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    for route in routes:
        try:
            route.abort()
        except Exception:
            pass
    release(state)
    ctx.close()


def scenario_held_create(browser, width, height, via_x):
    # Review 28.10.2026: the create command (POST /orders) hangs (on a real phone NOT_READY is
    # retried up to 60 s). Nothing was ordered for sure and no payment was sent: the X closes at
    # once without a question and the intent goes; 20 s say who is waiting.
    state = new_state()
    ctx, page = make_context(browser, state, width, height, 'reduce')
    routes = []

    def hold(route):
        if route.request.method != 'POST':
            return route.fallback()
        state['paths'].append('HELD POST /orders')
        state['creates'] += 1
        routes.append(route)

    route_fixture(ctx, '**/v1/customer-checkout/orders', hold)
    page.goto(URL + '/menu')
    add(page)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
    expect(page.get_by_test_id('cart-pay-handle').filter(visible=True)).to_be_visible(timeout=15000)
    slide(page, 1.0)
    held(page, routes)
    scene = page.get_by_test_id('kaspi-connecting')
    expect(scene).to_contain_text('Связываемся с рестораном', timeout=5000)
    close = close_box_ok(page, width, height)
    stored(page, DRAFT_KEY, sendInvoice=True)
    page.screenshot(path=str(OUT / f'esc-held-create-x-{width}.png'))
    expect(scene).to_contain_text('Ресторан не подтверждает заказ', timeout=25_000)
    expect(scene.get_by_test_id('kaspi-state-detail')).to_contain_text('Счёт не выставлен, деньги не списаны')
    back = page.get_by_test_id('kaspi-stuck-cart')
    expect(back).to_have_text('Вернуться в корзину')
    # The create command retries by itself: no «Проверить ещё раз» of its own.
    expect(page.get_by_test_id('kaspi-stuck-recheck')).to_have_count(0)
    page.screenshot(path=str(OUT / f'esc-held-create-stuck-{width}.png'))
    (close if via_x else back).click()
    expect(page.get_by_test_id('kaspi-close-dialog')).to_have_count(0)
    expect(pay_button(page)).to_be_enabled(timeout=10000)
    expect(scene).to_have_count(0)
    expect(page.get_by_test_id('cart-quantity-pick-combo')).to_have_text('1')
    page.wait_for_function('(key) => localStorage.getItem(key) === null', arg=DRAFT_KEY, timeout=5000)
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 0), state
    # A restart on the cart reopens nothing and sends nothing.
    page.reload()
    expect(pay_button(page)).to_be_visible(timeout=25000)
    wait_quiet(page)
    expect(page.get_by_test_id('kaspi-connecting')).to_have_count(0)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 0), state
    for route in routes:
        try:
            route.abort()
        except Exception:
            pass
    release(state)
    ctx.close()


def scenario_unconnected_method(browser, width, height):
    # Owner 6b, before another method gets its own flow: the Kaspi cart has one flow (the Kaspi
    # invoice). A future build may list Apple Pay or the card as available first; then the handle,
    # «Способ оплаты» and the pay button follow the customer's choice, but a press or a slide must
    # say that the method is not connected and send nothing, never do nothing silently.
    state = new_state()
    ctx, page = make_context(browser, state, width, height, 'reduce')
    patched = []

    def bundle(route):
        response = route.fetch()
        body, count = FUTURE_METHODS.subn(r'\1!0}', response.text())
        patched.append(count)
        route.fulfill(response=response, body=body)

    # Through the guarded fixture: the bundle is fetched from the local preview server only.
    route_fixture(ctx, '**/_expo/static/js/web/entry-*.js', bundle)
    page.goto(URL + '/menu')
    add(page)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
    assert patched and all(count == 2 for count in patched), ('Apple Pay and card made available', patched)
    state['quote_total'] = minor(page.get_by_test_id('cart-shortcut-total').filter(visible=True).inner_text())
    # A new customer still starts with Kaspi (the first available method).
    handle = page.get_by_test_id('cart-pay-handle').filter(visible=True)
    expect(handle).to_have_attribute('aria-label', 'Оплатить через Kaspi')
    page.get_by_test_id('open-cart').click()
    pay = pay_button(page)
    expect(pay).to_be_enabled(timeout=15000)
    # The card: chosen, remembered, and the button reads «Оплатить [card] картой».
    page.get_by_test_id('cart-payment-method').click()
    page.get_by_test_id('cart-payment-card').click()
    expect(page.get_by_test_id('cart-payment-sheet')).to_have_count(0)
    stored(page, METHOD_KEY, method='card', source='choice')
    expect(page.get_by_test_id('cart-payment-method-name')).to_have_text('Банковская карта')
    assert text(pay) == 'Оплатить картой', text(pay)
    expect(pay).to_have_accessible_name('Оплатить картой, 4 190 ₸')
    pay.click()
    stop = page.get_by_test_id('cart-pay-method-stop')
    expect(stop).to_contain_text('Этот способ оплаты пока не подключён. Заказ не оформлен, деньги не списаны.')
    page.screenshot(path=str(OUT / f'method-not-connected-card-{width}.png'))
    # The stop and the pay button stay on screen above the fold, also at 320 x 568.
    assert stop.bounding_box()['y'] >= 0 and pay.bounding_box()['y'] + pay.bounding_box()['height'] <= height, (stop.bounding_box(), pay.bounding_box())
    wait_quiet(page, 1500)
    assert not posts(state) and state['patches'] == 0, (posts(state), state)
    # Apple Pay: the handle shows its mark and name; a full slide opens the cart, which says the
    # same instead of sending anything.
    page.get_by_test_id('cart-payment-method').click()
    page.get_by_test_id('cart-payment-apple_pay').click()
    stored(page, METHOD_KEY, method='apple_pay', source='choice')
    expect(stop).to_have_count(0)
    assert text(pay) == 'Оплатить с Apple Pay', text(pay)
    page.get_by_test_id('cart-close').click()
    expect(page.get_by_test_id('cart-shortcut')).to_be_visible(timeout=10000)
    expect(handle).to_have_attribute('aria-label', 'Оплатить через Apple Pay')
    expect(page.locator('#cart-pay-mark-apple_pay').filter(visible=True)).to_be_visible()
    slide(page, 1.0)
    expect(page.get_by_test_id('screen-M09').get_by_test_id('cart-pay-method-stop')).to_be_visible(timeout=15000)
    assert urlparse(page.url).path.rstrip('/') == '/cart' and 'slide=' in page.url, page.url
    page.screenshot(path=str(OUT / f'method-not-connected-slide-{width}.png'))
    wait_quiet(page)
    assert not posts(state) and state['patches'] == 0, (posts(state), state)
    # «Выбрать Kaspi.kz» is a choice, not a payment: nothing is sent until a new explicit press.
    page.get_by_test_id('cart-pay-method-kaspi').click()
    expect(page.get_by_test_id('cart-pay-method-stop')).to_have_count(0)
    stored(page, METHOD_KEY, method='kaspi', source='choice')
    assert text(pay) == 'Оплатить с Kaspi.kz', text(pay)
    wait_quiet(page, 1500)
    assert not posts(state), posts(state)
    pay.click()
    expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Ждём оплату в Kaspi', timeout=15000)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    stored(page, METHOD_KEY, method='kaspi', source='payment')
    wait_quiet(page)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state
    release(state)
    ctx.close()


if __name__ == '__main__':
    SELECTED = os.environ.get('SLIDE_TO_PAY', 'ABCDEFGHIJKLMNOP').upper()
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
        if 'L' in SELECTED:
            scenario_tabs(browser, 393, 852)
            scenario_tabs(browser, 320, 568)
        if 'M' in SELECTED:
            scenario_payment_method(browser)
        if 'N' in SELECTED:
            scenario_unconnected_method(browser, 393, 852)
            scenario_unconnected_method(browser, 320, 568)
        if 'O' in SELECTED:
            scenario_stuck_sending(browser, 393, 852)
            scenario_stuck_sending(browser, 320, 568)
        if 'P' in SELECTED:
            scenario_held_payment(browser, 393, 852)
            scenario_held_payment(browser, 320, 568)
            scenario_held_create(browser, 393, 852, via_x=False)
            scenario_held_create(browser, 320, 568, via_x=True)
        browser.close()
    assert not errors, errors
    print('PASS slide to pay into the Kaspi cart (' + SELECTED + '): hold hint, the pill stretches from a fixed left '
          'edge with the mark under the finger and shrinks back on an early release, tap/short drag/keyboard send nothing, '
          'full drag = one quote + one order + one invoice, reload/back resend nothing, price change and '
          'consent stop before the order, signed-out sign-in lands on the cart without sending, '
          'App Review account refused once, DEMO-1 without cart bar or mutations, gift total = invoice, '
          'hint fits in RU/KK/EN at 320 pt, an old unbilled intent does not block the slide, '
          'back to cart after a slide, the same bar above the three tabs and below the header, '
          'none on the profile, one payment from События, last used payment method per account with Kaspi fallback, '
          'a method without its own flow stops with a message and sends nothing, '
          'a stuck «sending» has the X at once, an honest text after 20 s, asks before closing, '
          'returns to the cart and pays again without a second order or payment command, '
          'a held payment command reads «Отправляем счёт» and a held create command is the restaurant\'s wait')
