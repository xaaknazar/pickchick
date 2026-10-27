"""Restaurant closed or payment not possible (owner 28.10.2026, Drinkit reference).

Drinkit at night: the cart bar has no payment handle (only the total and the photos), the header
says «откроемся в 7:30», the cart shows a red rounded banner with the reason under the top bar
and a grey, disabled «Пока не работаем» button. PickChick does the same.

Runs against the customer-auth web export (EXPO_PUBLIC_CUSTOMER_AUTH=server,
EXPO_PUBLIC_KASPI_CHECKOUT=1, EXPO_PUBLIC_UNPAID_TEST_ORDERS=1, EXPO_PUBLIC_PUBLISHED_CATALOG=0)
with local fixtures only and a fixed browser clock (Almaty wall time, 28.10.2026): no bank,
no real customer, no VPS request. The fixture publishes the server's ordering hours
(10:00-00:00, Asia/Almaty) and computes `orderingOpen` from the same clock, like the server.
  A  closed by the hours (09:59): on Меню, События and Заказы the bar has no handle (total and
     photo only) and the header says «откроемся в 10:00»; the cart shows the red banner (role
     alert) between the top bar and «В зале / С собой», the pay button is grey «Пока не работаем»
     and disabled; ZERO /quotes, /orders and /payment requests; at 10:00 (minute boundary) the
     handle comes back without a reload, the header shows 10:00-00:00 and a full slide pays once
  B  midnight: the minute clock closes the bar at 00:00 even before the server's next answer;
     a cart left open at 23:59 gets the red banner (role alert) and the grey button at 00:00;
     back in the foreground at 11:00 it opens again
  C  payments switched off on the server (/config enabled false): «Оплата временно недоступна»,
     «Оплата недоступна», the bar loses the handle; switched on again the cart pays once
  D  no connection (the phone is offline): one short line «Нет связи с сервером» and «Нет связи»,
     no handle; online again the handle comes back
  E  the restaurant's stop list not fresh: its wording and «Оплата недоступна» (the phone may be
     online); stop list: «Нет в наличии: ...» and «Проверьте корзину»
  F  a slide in progress when the server closes: the handle disappears under the finger, nothing
     opens or is sent, the total and the photo come back
  G  signed out and closed: the same banner and grey button, no sign-in opened
  H  RU/KK/EN at 320 pt with the longest closed caption («откроемся завтра в 09:00»): the header
     caption fits at the normal size without truncation and, at the largest text, within the
     iOS shrink floor; banner and button at their largest text size neither overflow nor clip
     and keep their order; the connection reason is one line; no horizontal scroll
"""
from browser_network import isolated_context, route_fixture
import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from browser_checkout_traps import CATALOG, BRANCH, envelope, customer, refusal
from browser_slide_to_pay import add, slide, geometry, minor

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('CUSTOMER_AUTH_URL', 'http://127.0.0.1:4196').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost')
OUT = ROOT / os.environ.get('CART_UNAVAILABLE_SHOTS', '.local/cart-unavailable')
OUT.mkdir(parents=True, exist_ok=True)
ALMATY = timezone(timedelta(hours=5))
HOURS = {'openingTime': '10:00', 'closingTime': '00:00', 'timeZone': 'Asia/Almaty'}
MESSAGES = {entry['ru']: entry for entry in
            json.loads((ROOT / 'apps/mobile/src/i18n/messages.json').read_text())}
CONNECTION = 'Нет связи с сервером'
STALE = 'Нет свежих данных от ресторана. Проверяем связь автоматически.'
# Same-day hours: after closing the next opening is «завтра», the longest caption.
DAY_HOURS = {'openingTime': '09:00', 'closingTime': '21:00', 'timeZone': 'Asia/Almaty'}
# appHeaderCaptionMinScale (app-header-metrics.ts): 1 / maxFontScale 1.35.
CAPTION_MAX_SCALE = 1.35
ORDER = '40000000-0000-4000-8000-000000000003'
errors = []


def at(clock, day=28):
    """An instant at the given Almaty wall clock, 'HH:MM' or 'HH:MM:SS.s'."""
    h, m, *rest = clock.split(':')
    return datetime(2026, 10, day, int(h), int(m), tzinfo=ALMATY) + timedelta(seconds=float(rest[0]) if rest else 0)


def iso(instant):
    return instant.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def clock_minutes(value):
    h, m = value.split(':')
    return int(h) * 60 + int(m)


def server_open(instant, hours=HOURS):
    # The server's rule: opening inclusive, closing exclusive, a closing at or before the
    # opening belongs to the next day (10:00-00:00 closes at midnight).
    local = instant.astimezone(ALMATY)
    minute = local.hour * 60 + local.minute
    opening, closing = clock_minutes(hours['openingTime']), clock_minutes(hours['closingTime'])
    if opening == closing:
        return True
    return minute >= opening or minute < closing if closing < opening else opening <= minute < closing


def new_state(**overrides):
    return {'paths': [], 'held': [], 'quotes': 0, 'creates': 0, 'payments': 0, 'config_reads': 0,
            'quote_total': '419000', 'phase': None, 'signed_in': True, 'clock': at('12:00:58.5'),
            'ordering_open': None, 'hours': True, 'hours_data': HOURS, 'enabled': True, 'fresh': True,
            'stopped': set(),
            'config_enabled': True, **overrides}


def availability(state):
    if not state['enabled']:
        return {'enabled': False, 'fresh': False, 'signature': 'disabled', 'products': []}
    body = {'enabled': True, 'fresh': state['fresh'],
            'products': [{'id': p['id'], 'available': p['id'] not in state['stopped'], 'stoppedOptions': []}
                         for p in CATALOG['products']]}
    if state['hours']:
        opened = state['ordering_open']
        body.update(orderingOpen=server_open(state['clock'], state['hours_data']) if opened is None else opened,
                    hours=state['hours_data'])
    body['signature'] = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
    return body


def order(state, phase, revision=1):
    stamp = iso(state['clock'] - timedelta(seconds=30))
    return {'orderId': ORDER, 'revision': hex(revision)[2:].zfill(64), 'restaurant': 'ТЦ Abay Plaza',
            'branchId': BRANCH, 'createdAt': stamp, 'updatedAt': stamp, 'kitchenStage': None,
            'displayNumber': None, 'totalMinor': state['quote_total'], 'serviceMode': 'takeaway',
            'kitchenComment': None, 'phase': phase, 'expiresAt': None, 'receipt': 'deferred',
            'receiptUrl': None, 'items': [{'productId': 'pick-combo', 'title': 'Pick Combo', 'quantity': 1,
                                           'totalMinor': state['quote_total'], 'modifiers': []}]}


def make_context(browser, state, width=393, height=852, reduced='reduce'):
    ctx = isolated_context(browser, viewport={'width': width, 'height': height},
                           reduced_motion=reduced, has_touch=False)
    # The app sees only this clock: tokens, quotes and orders are dated by it, not by the runner.
    ctx.clock.set_fixed_time(state['clock'])
    if state['signed_in']:
        session = json.loads(json.dumps(envelope))
        session['tokens']['access_expires_at'] = iso(at('12:00', day=30))
        ctx.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",'
                            + json.dumps(json.dumps(session)) + ');')
    # RN Web's AppState reads document.visibilityState: a fixture event moves the app to the
    # background and back (as browser_menu_recovery.py does), no app internals are touched.
    ctx.add_init_script("""(() => {
      let active = true;
      Object.defineProperty(document, 'hidden', {get: () => !active});
      Object.defineProperty(document, 'visibilityState', {get: () => active ? 'visible' : 'hidden'});
      window.addEventListener('pickchick-fixture-visibility', event => {
        active = event.detail;
        document.dispatchEvent(new Event('visibilitychange'));
      });
    })();""")

    def ok(route, data, status=200):
        route.fulfill(status=status, json=data, headers={'Access-Control-Allow-Origin': '*'})

    def route(r):
        path = urlparse(r.request.url).path
        method = r.request.method
        body = r.request.post_data_json if r.request.post_data else None
        state['paths'].append(method + ' ' + path)
        if path.endswith('/watch'):
            state['held'].append(r)
            return
        if path == '/v1/customers/me':
            return ok(r, {'customer': customer, 'legal': {
                'version': 'fixture-v1', 'accepted': True, 'terms_url': 'https://example.test/terms',
                'privacy_url': 'https://example.test/privacy'}})
        if path == '/v1/auth/config':
            return ok(r, {'enabled': True, 'delivery_consent_required': True, 'consent_version': 'fixture-v1',
                          'channels': ['telegram'], 'channel_selection': 'automatic',
                          'whatsapp_fallback_enabled': False, 'terms_url': 'https://example.test/terms',
                          'privacy_url': 'https://example.test/privacy'})
        if path == '/v1/customer-checkout/availability':
            return ok(r, availability(state))
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
            state['config_reads'] += 1
            return ok(r, {'enabled': state['config_enabled'], 'branchId': BRANCH, 'restaurant': 'ТЦ Abay Plaza',
                          'fiscalPolicy': 'deferred_pilot', 'orderCommentEnabled': True})
        if path == '/v1/customer-checkout/quotes' and method == 'POST':
            state['quotes'] += 1
            if not server_open(state['clock'], state['hours_data']) and state['ordering_open'] is not True:
                return refusal(r, 409, 'RESTAURANT_CLOSED')
            return ok(r, {'quoteId': '40000000-0000-4000-8000-0000000000%02d' % (50 + state['quotes']),
                          'totalMinor': state['quote_total'], 'expiresAt': iso(state['clock'] + timedelta(minutes=15)),
                          'serviceMode': body['serviceMode'], 'kitchenComment': None})
        if path == '/v1/customer-checkout/orders' and method == 'GET':
            return ok(r, {'orders': [order(state, state['phase'])] if state['phase'] else []})
        if path == '/v1/customer-checkout/orders' and method == 'POST':
            state['creates'] += 1
            state['phase'] = state['phase'] or 'ready_to_pay'
            return ok(r, order(state, state['phase']))
        if path.startswith('/v1/customer-checkout/orders/') and path.endswith('/payment'):
            state['payments'] += 1
            state['phase'] = 'awaiting_payment'
            return ok(r, order(state, state['phase'], revision=2))
        if path.startswith('/v1/customer-checkout/orders/') and method == 'GET' and state['phase']:
            return ok(r, order(state, state['phase'], revision=2 if state['phase'] == 'awaiting_payment' else 1))
        r.abort()

    route_fixture(ctx, '**/v1/**', route)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    return ctx, page


def set_clock(page, state, clock, **changes):
    """The server's state and the phone's clock move together (changes first, then the clock)."""
    state.update(changes)
    state['clock'] = clock
    page.clock.set_fixed_time(clock)


def network(ctx, page, online):
    """The phone loses or regains its network. Chromium has navigator.connection, whose 'change'
    event NetInfo listens to; the emulated switch does not fire it, so the fixture fires the
    platform event a phone would."""
    ctx.set_offline(not online)
    page.evaluate("() => navigator.connection && navigator.connection.dispatchEvent(new Event('change'))")


def visibility(page, active):
    page.evaluate("""(active) => window.dispatchEvent(new CustomEvent(
      'pickchick-fixture-visibility', {detail: active}))""", active)


def release(state):
    for held in state['held']:
        try:
            held.abort()
        except Exception:
            pass


def checkout_paths(state, since=0):
    """Every quote, order or payment request since `since`, whatever the method."""
    return [p for p in state['paths'][since:] if any(k in p for k in ('/quotes', '/orders', '/payment'))]


def mutations(state):
    return [p for p in checkout_paths(state) if not p.startswith('GET ')]


def visible(page, test_id):
    return page.get_by_test_id(test_id).filter(visible=True)


def tr(ru, lang, **values):
    text = MESSAGES[ru][lang] if lang != 'ru' else ru
    for key, value in values.items():
        text = text.replace('{' + key + '}', value)
    return text


def expect_closed_bar(page, total='4 190 ₸'):
    # Drinkit at night: no payment handle (and no bag pill), the total and the photo only.
    expect(visible(page, 'cart-pay-handle')).to_have_count(0, timeout=10000)
    expect(page.locator('#cart-pay-mark-kaspi')).to_have_count(0)
    bar = visible(page, 'cart-shortcut')
    expect(bar).to_have_count(1)
    expect(visible(page, 'cart-shortcut-total')).to_have_text(total)
    expect(visible(page, 'cart-recent-photo-0')).to_be_visible()
    assert visible(page, 'open-cart').inner_text().strip() == total
    box = bar.bounding_box()
    button = visible(page, 'open-cart').bounding_box()
    # The cart button fills the whole capsule: the total is a big target, nothing on the left.
    assert button['x'] - box['x'] <= 6 and button['width'] >= box['width'] - 12, (button, box)
    assert box['x'] >= 0 and box['x'] + box['width'] <= page.viewport_size['width'], box


def expect_open_bar(page, timeout=10000):
    expect(visible(page, 'cart-pay-handle')).to_have_count(1, timeout=timeout)
    expect(page.locator('#cart-pay-mark-kaspi').filter(visible=True)).to_have_count(1)


def open_cart(page):
    visible(page, 'open-cart').click()
    expect(page.get_by_test_id('screen-M09')).to_be_visible(timeout=15000)
    return page.get_by_test_id('screen-M09')


def close_cart(page):
    page.get_by_test_id('screen-M09').get_by_test_id('cart-close').click()
    expect(page.get_by_test_id('screen-M09')).to_have_count(0, timeout=10000)


def expect_cart_unavailable(page, message, label):
    cart = page.get_by_test_id('screen-M09')
    banner = cart.get_by_test_id('cart-unavailable')
    expect(banner).to_be_visible(timeout=15000)
    # The text plus the (!) glyph; screen readers get exactly the reason.
    expect(banner).to_contain_text(message)
    expect(banner).to_have_attribute('aria-label', message)
    expect(banner).to_have_attribute('role', 'alert')
    expect(cart.get_by_role('alert', name=message)).to_have_count(1)
    # Right under the top bar, above «В зале / С собой» (Drinkit puts it where our pill is).
    top = cart.get_by_test_id('cart-close').bounding_box()
    pill = cart.get_by_test_id('cart-dining-mode').bounding_box()
    box = banner.bounding_box()
    assert top['y'] + top['height'] <= box['y'] + 1 and box['y'] + box['height'] <= pill['y'] + 1, (top, box, pill)
    assert box['height'] >= 44 and box['x'] >= 0 and box['x'] + box['width'] <= page.viewport_size['width'], box
    color = banner.evaluate('(e) => getComputedStyle(e).backgroundColor')
    assert color == 'rgb(217, 45, 32)', color
    pay = cart.get_by_test_id('cart-pay')
    expect(pay).to_be_disabled()
    expect(pay).to_have_text(label)
    expect(pay).to_have_attribute('aria-label', label)
    # Grey, not the white payment button.
    assert pay.evaluate('(e) => getComputedStyle(e).backgroundColor') != 'rgb(255, 255, 255)'
    return cart, pay


def expect_cart_payable(page):
    cart = page.get_by_test_id('screen-M09')
    expect(cart.get_by_test_id('cart-unavailable')).to_have_count(0, timeout=15000)
    pay = cart.get_by_test_id('cart-pay')
    expect(pay).to_be_enabled(timeout=15000)
    expect(pay).to_contain_text('Оплатить с')
    return pay


def try_to_pay(page, pay):
    # A disabled button: a forced click, Enter and Space change nothing.
    pay.click(force=True)
    pay.focus()
    page.keyboard.press('Enter')
    page.keyboard.press('Space')
    page.wait_for_timeout(1500)


def full_slide(page, state):
    state['quote_total'] = minor(visible(page, 'cart-shortcut-total').inner_text())
    slide(page, 1.0)
    expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Ждём оплату в Kaspi', timeout=15000)
    page.wait_for_timeout(2000)
    assert (state['quotes'], state['creates'], state['payments']) == (1, 1, 1), state


def scenario_closed_hours(browser, width, height):
    # 09:59:58.5: the minute clock wakes at 10:00 sharp; until then the restaurant is closed.
    state = new_state(clock=at('09:59:58.5'))
    ctx, page = make_context(browser, state, width, height)
    page.goto(URL + '/menu')
    add(page)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=20000)
    expect_closed_bar(page)
    for route, screen in [('events', 'M26'), ('orders', 'M19'), ('menu', 'M06')]:
        page.get_by_test_id('tab-' + route).click()
        scope = page.get_by_test_id('screen-' + screen)
        expect(scope).to_be_visible()
        expect(scope.get_by_test_id('header-hours')).to_have_text('откроемся в 10:00')
        expect_closed_bar(page)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        if route == 'events':
            page.screenshot(path=str(OUT / f'closed-events-{width}.png'))
    page.wait_for_timeout(600)
    page.screenshot(path=str(OUT / f'closed-menu-{width}.png'))
    # Заказы read the order list (GET); nothing was quoted, created or billed.
    assert not mutations(state), mutations(state)
    since = len(state['paths'])
    open_cart(page)
    cart, pay = expect_cart_unavailable(page, 'откроемся в 10:00', 'Пока не работаем')
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / f'closed-cart-{width}.png'))
    try_to_pay(page, pay)
    expect(page.get_by_test_id('kaspi-connecting')).to_have_count(0)
    assert urlparse(page.url).path.rstrip('/') == '/cart', page.url
    assert not checkout_paths(state, since), checkout_paths(state, since)
    assert (state['quotes'], state['creates'], state['payments']) == (0, 0, 0), state
    close_cart(page)
    # 10:00: the clock reaches the opening minute and the server opens; no reload.
    set_clock(page, state, at('10:00:00.5'))
    expect_open_bar(page)
    expect(page.get_by_test_id('screen-M06').get_by_test_id('header-hours')).to_have_text('10:00-00:00')
    page.screenshot(path=str(OUT / f'open-menu-{width}.png'))
    open_cart(page)
    expect_cart_payable(page)
    page.screenshot(path=str(OUT / f'open-cart-{width}.png'))
    close_cart(page)
    assert not mutations(state), mutations(state)
    full_slide(page, state)
    release(state)
    ctx.close()


def scenario_midnight(browser):
    # The server's last answer still says open: the phone's minute clock closes the bar at 00:00.
    state = new_state(clock=at('23:59:58.5', day=27), ordering_open=True)
    ctx, page = make_context(browser, state)
    page.goto(URL + '/menu')
    add(page)
    expect_open_bar(page, 20000)
    expect(visible(page, 'header-hours')).to_have_text('10:00-00:00')
    # The cart is open at 23:59: at 00:00 the reason appears in it (role alert, which the web
    # announces; Android uses the live region, iOS an explicit announcement) and pay turns grey.
    open_cart(page)
    expect_cart_payable(page)
    since = len(state['paths'])
    set_clock(page, state, at('00:00:00.5'))
    _, pay = expect_cart_unavailable(page, 'откроемся в 10:00', 'Пока не работаем')
    try_to_pay(page, pay)
    assert not checkout_paths(state, since), checkout_paths(state, since)
    close_cart(page)
    expect_closed_bar(page)
    expect(visible(page, 'header-hours')).to_have_text('откроемся в 10:00')
    # The next minute tick is a minute away: coming back to the foreground re-evaluates at once.
    visibility(page, False)
    page.wait_for_timeout(300)
    set_clock(page, state, at('11:00:30'), ordering_open=None)
    visibility(page, True)
    expect_open_bar(page, 5000)
    expect(visible(page, 'header-hours')).to_have_text('10:00-00:00')
    assert not mutations(state), mutations(state)
    release(state)
    ctx.close()


def scenario_switched_off(browser):
    state = new_state(config_enabled=False)
    ctx, page = make_context(browser, state)
    page.goto(URL + '/menu')
    add(page)
    # The bar cannot know the server switch before the cart has read /config.
    expect_open_bar(page, 20000)
    since = len(state['paths'])
    open_cart(page)
    _, pay = expect_cart_unavailable(page, 'Оплата временно недоступна', 'Оплата недоступна')
    page.screenshot(path=str(OUT / 'switched-off-cart-393.png'))
    try_to_pay(page, pay)
    assert not checkout_paths(state, since), checkout_paths(state, since)
    close_cart(page)
    # The bar now knows: no handle on any tab.
    for route in ['events', 'menu']:
        page.get_by_test_id('tab-' + route).click()
        expect_closed_bar(page)
    page.screenshot(path=str(OUT / 'switched-off-menu-393.png'))
    # Switched on again: the cart reads /config when it opens, pays, and the handle returns.
    state['config_enabled'] = True
    open_cart(page)
    expect_cart_payable(page)
    close_cart(page)
    expect_open_bar(page)
    assert not mutations(state), mutations(state)
    full_slide(page, state)
    release(state)
    ctx.close()


def scenario_offline(browser):
    state = new_state()
    ctx, page = make_context(browser, state)
    page.goto(URL + '/menu')
    add(page)
    expect_open_bar(page, 20000)
    network(ctx, page, False)
    expect_closed_bar(page)
    open_cart(page)
    expect_cart_unavailable(page, CONNECTION, 'Нет связи')
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / 'offline-cart-393.png'))
    close_cart(page)
    network(ctx, page, True)
    expect_open_bar(page, 25000)
    assert not mutations(state), mutations(state)
    release(state)
    ctx.close()


def scenario_stop_list(browser):
    state = new_state()
    ctx, page = make_context(browser, state)
    page.goto(URL + '/menu')
    add(page)
    expect_open_bar(page, 20000)
    # The restaurant's own stop list is not fresh: the server would refuse the order, but the
    # customer's phone is online, so the button names the payment, not the connection.
    state['fresh'] = False
    expect_closed_bar(page)
    open_cart(page)
    expect_cart_unavailable(page, STALE, 'Оплата недоступна')
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / 'stale-cart-393.png'))
    # Fresh again with Pick Combo on the stop list: the reason changes in the open cart.
    state['fresh'] = True
    state['stopped'] = {'pick-combo'}
    name = 'Pick Combo'
    expect_cart_unavailable(page, f'Нет в наличии: {name}', 'Проверьте корзину')
    # The same settle wait as the other cart shots (the upsell price pills animate in).
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / 'stop-list-cart-393.png'))
    state['stopped'] = set()
    expect_cart_payable(page)
    close_cart(page)
    expect_open_bar(page)
    assert not mutations(state), mutations(state)
    release(state)
    ctx.close()


def scenario_slide_interrupted(browser):
    state = new_state()
    # Reduced motion: the web screen fade (RN Animated) measures time with Date.now, which the
    # fixed clock of this test freezes; the handle itself works the same either way.
    ctx, page = make_context(browser, state)
    page.goto(URL + '/menu')
    add(page)
    expect_open_bar(page, 20000)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=20000)
    since = len(state['paths'])
    # Hold and drag most of the way, then the server closes (its own answer, not the hours).
    # A long hold: the 250 ms press-and-hold must register even on a busy test machine.
    slide(page, 0.7, hold=900, release_at_end=False)
    expect(visible(page, 'cart-pay-hint')).to_have_count(1)
    state['ordering_open'] = False
    expect(visible(page, 'cart-pay-handle')).to_have_count(0, timeout=10000)
    expect(page.get_by_test_id('cart-pay-hint')).to_have_count(0)
    bar = visible(page, 'cart-shortcut').bounding_box()
    page.mouse.move(bar['x'] + bar['width'] - 20, bar['y'] + bar['height'] / 2)
    page.mouse.up()
    page.wait_for_timeout(1500)
    expect(page.get_by_test_id('screen-M09')).to_have_count(0)
    assert urlparse(page.url).path.rstrip('/') == '/menu', page.url
    expect_closed_bar(page)
    assert visible(page, 'cart-shortcut-total').evaluate(
        '(e) => { let o = 1; for (let n = e; n; n = n.parentElement) o *= +getComputedStyle(n).opacity; return o; }') > 0.99
    assert not checkout_paths(state, since), checkout_paths(state, since)
    # The server opens again: the handle is back, the old slide was never kept.
    state['ordering_open'] = None
    expect_open_bar(page)
    page.wait_for_timeout(1000)
    assert not checkout_paths(state, since) and not mutations(state), state['paths'][since:]
    release(state)
    ctx.close()


def scenario_signed_out(browser):
    state = new_state(signed_in=False, clock=at('07:30'))
    ctx, page = make_context(browser, state)
    page.goto(URL + '/menu')
    add(page)
    expect_closed_bar(page)
    open_cart(page)
    _, pay = expect_cart_unavailable(page, 'откроемся в 10:00', 'Пока не работаем')
    try_to_pay(page, pay)
    assert urlparse(page.url).path.rstrip('/') == '/cart', page.url
    assert not checkout_paths(state), checkout_paths(state)
    release(state)
    ctx.close()


def caption_fit(page):
    """The header caption at the normal text size and at the largest one it follows
    (maxFontSizeMultiplier 1.35): the full width of the text against the column it has."""
    return visible(page, 'header-hours').evaluate('''(e, scale) => {
      const room = e.parentElement.clientWidth;
      const normal = e.scrollWidth;
      const clipped = e.scrollWidth > e.clientWidth + 1;
      const base = parseFloat(getComputedStyle(e).fontSize);
      e.style.fontSize = base * scale + 'px';
      const large = e.scrollWidth;
      e.style.fontSize = '';
      return {room, normal, clipped, large};
    }''', CAPTION_MAX_SCALE)


def large_text(page, test_id, scale, line_height):
    """The element's text at its largest supported size (RN scales the font size and the line
    height together): nothing overflows sideways or is clipped, the text stays inside its own box
    and clear of the (!) mark. The style stays until reset_large_text()."""
    return page.get_by_test_id('screen-M09').get_by_test_id(test_id).evaluate('''(e, [scale, lineHeight]) => {
      // The reason, then the (!) mark (an icon-font glyph on the web).
      const leaves = [...e.querySelectorAll('*')].filter((n) => !n.children.length && n.textContent.trim());
      const text = leaves[0] || e;
      const base = parseFloat(getComputedStyle(text).fontSize);
      text.dataset.fixtureLarge = JSON.stringify([text.style.fontSize, text.style.lineHeight]);
      text.style.fontSize = base * scale + 'px';
      text.style.lineHeight = lineHeight * scale + 'px';
      const box = e.getBoundingClientRect();
      const own = text.getBoundingClientRect();
      const marks = leaves.slice(1).map((n) => n.getBoundingClientRect());
      return {
        sideways: text.scrollWidth > text.clientWidth + 1,
        clipped: text.scrollHeight > text.clientHeight + 1,
        inside: own.left >= box.left - 1 && own.right <= box.right + 1 && own.top >= box.top - 1
          && own.bottom <= box.bottom + 1,
        overlap: marks.some((r) => r.left < own.right - 1 && r.right > own.left + 1
          && r.top < own.bottom - 1 && r.bottom > own.top + 1),
        marks: marks.length,
        height: box.height,
        bottom: box.bottom,
        lines: Math.round(own.height / (lineHeight * scale)),
      };
    }''', [scale, line_height])


def reset_large_text(page):
    page.get_by_test_id('screen-M09').evaluate('''(e) => {
      for (const n of e.querySelectorAll('[data-fixture-large]')) {
        [n.style.fontSize, n.style.lineHeight] = JSON.parse(n.dataset.fixtureLarge);
        delete n.dataset.fixtureLarge;
      }
    }''')


def scenario_languages(browser, width=320, height=568):
    # 21:30 with same-day hours 09:00-21:00: «откроемся завтра в 09:00», the longest caption.
    state = new_state(clock=at('21:30'), hours_data=DAY_HOURS)
    ctx, page = make_context(browser, state, width, height)
    page.goto(URL + '/menu')
    add(page)
    expect_closed_bar(page)
    for lang in ['kk', 'en', 'ru']:
        page.goto(URL + '/screen/M34')
        page.get_by_test_id('language-' + lang).click()
        expect(page.get_by_test_id('language-' + lang)).to_have_attribute('aria-checked', 'true')
        page.goto(URL + '/menu')
        expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=20000)
        expect_closed_bar(page)
        opens = tr('откроемся завтра в {p0}', lang, p0='09:00')
        expect(visible(page, 'header-hours')).to_have_text(opens)
        fit = caption_fit(page)
        # Normal size: the whole caption, no ellipsis. Largest text: iOS shrinks it to fit
        # (adjustsFontSizeToFit), never below the normal size, which fits.
        assert not fit['clipped'] and fit['normal'] <= fit['room'], (lang, fit)
        assert fit['large'] / CAPTION_MAX_SCALE <= fit['room'] + 1, (lang, fit)
        print(lang, 'header caption', fit)
        open_cart(page)
        expect_cart_unavailable(page, opens, tr('Пока не работаем', lang))
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / f'closed-cart-{lang}-{width}.png'))
        cart = page.get_by_test_id('screen-M09')
        # Largest text: the banner follows Dynamic Type up to 1.6 (17/23), the button up to 1.5
        # (19/26).
        banner = large_text(page, 'cart-unavailable', 1.6, 23)
        assert not banner['sideways'] and not banner['clipped'] and banner['inside'], (lang, banner)
        assert banner['marks'] == 1 and not banner['overlap'], (lang, 'the (!) mark', banner)
        pill = cart.get_by_test_id('cart-dining-mode').bounding_box()
        assert banner['bottom'] <= pill['y'] + 1, (lang, 'banner runs into «В зале / С собой»', banner, pill)
        button = large_text(page, 'cart-pay', 1.5, 26)
        assert not button['sideways'] and not button['clipped'] and button['inside'], (lang, button)
        assert button['marks'] == 0, (lang, 'the grey button carries only its label', button)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), lang
        print(lang, 'large text banner', banner, 'button', button)
        page.screenshot(path=str(OUT / f'closed-cart-{lang}-large-{width}.png'))
        reset_large_text(page)
        close_cart(page)
    # The connection reason is one short line at 320 pt (at most two at the largest text).
    # The next minute tick is far away: the foreground re-evaluates at once.
    visibility(page, False)
    set_clock(page, state, at('12:00:30'))
    visibility(page, True)
    expect_open_bar(page)
    network(ctx, page, False)
    expect_closed_bar(page)
    open_cart(page)
    expect_cart_unavailable(page, CONNECTION, 'Нет связи')
    banner = page.get_by_test_id('cart-unavailable')
    assert banner.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
    normal = large_text(page, 'cart-unavailable', 1, 23)
    assert normal['lines'] == 1 and normal['height'] <= 48 + 1, normal
    reset_large_text(page)
    large = large_text(page, 'cart-unavailable', 1.6, 23)
    assert large['lines'] <= 2 and not large['clipped'] and not large['sideways'], large
    reset_large_text(page)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / f'offline-cart-{width}.png'))
    assert not mutations(state), mutations(state)
    network(ctx, page, True)
    release(state)
    ctx.close()


if __name__ == '__main__':
    SELECTED = os.environ.get('CART_UNAVAILABLE', 'ABCDEFGH').upper()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        if 'A' in SELECTED:
            scenario_closed_hours(browser, 393, 852)
            scenario_closed_hours(browser, 320, 568)
        if 'B' in SELECTED:
            scenario_midnight(browser)
        if 'C' in SELECTED:
            scenario_switched_off(browser)
        if 'D' in SELECTED:
            scenario_offline(browser)
        if 'E' in SELECTED:
            scenario_stop_list(browser)
        if 'F' in SELECTED:
            scenario_slide_interrupted(browser)
        if 'G' in SELECTED:
            scenario_signed_out(browser)
        if 'H' in SELECTED:
            scenario_languages(browser)
        browser.close()
    assert not errors, errors
    print('PASS cart unavailable (' + SELECTED + '): closed by the hours = no handle on Меню/События/Заказы, '
          '«откроемся в 10:00» in the header, red banner under the top bar, grey «Пока не работаем», '
          'zero quote/order/payment requests; 10:00 brings the handle back and a slide pays once; '
          'midnight closes on the minute (an open cart gets the banner), foreground reopens; server switch, '
          'no connection, stale stop list and stop list say why; a slide in progress is cancelled safely; '
          'signed-out cart the same; RU/KK/EN fit at 320 pt with the largest text')
