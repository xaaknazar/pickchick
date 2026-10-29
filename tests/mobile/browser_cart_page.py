"""Kaspi cart page, owner 27.10.2026: the cart is the checkout (Drinkit reference).

Runs against the customer-auth web export (EXPO_PUBLIC_CUSTOMER_AUTH=server,
EXPO_PUBLIC_KASPI_CHECKOUT=1, EXPO_PUBLIC_PUBLISHED_CATALOG=0) with local fixtures only:
no bank, no real customer, no VPS request.
  - top bar: red glass trash left, pin + restaurant point centred, glass close right, no title;
  - «В зале / С собой» pill switches the mode and the quote carries it;
  - removed: «Добавить ещё что-нибудь», promo code, small print after the total;
  - order comment at the bottom, payment selector with Kaspi.kz only (owner 29.10.2026, App Store
    build: no Apple Pay / Google Pay / card row, name or mark, no «скоро»); no 6 + 1 card and no
    «Акции» block while the server does not run the programme;
  - one press of «Оплатить с Kaspi.kz» = one quote + one order + one invoice;
  - a guest is sent to sign-in (Kaspi reason, glass back on the code step) and back to the cart,
    nothing is ordered;
  - a burst of +/- taps re-reads the Kaspi session once (one GET /config, not one per tap);
  - the menu hero video keeps playing under the cart sheet and pauses for tabs/full screens;
  - the glass (owner 28.10: Apple's style): iOS 26 draws Apple's Liquid Glass, this web build the
    fallback - light rim, specular edge, thin veil over the blur - and an opaque fill when the
    system reduces transparency.
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
    state = {'quotes': [], 'creates': 0, 'payments': 0, 'phase': 'ready_to_pay', 'held': [], 'mutations': [],
             'config': 0, 'otp': 0}
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
                    'channels': ['telegram'], 'channel_selection': 'automatic',
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
        elif path == '/v1/auth/otp/request' and method == 'POST':
            # Sign-in from the cart reaches the code step; no SMS, no account, no order.
            state['otp'] += 1
            now = datetime.now(timezone.utc)
            r.fulfill(status=202, json={'challenge_id': '40000000-0000-4000-8000-000000000006',
                                        'expires_at': (now + timedelta(minutes=3)).isoformat(),
                                        'resend_at': (now + timedelta(minutes=1)).isoformat(),
                                        'delivery_status': 'submitted', 'channel': 'telegram',
                                        'code_length': 4},
                      headers={'Access-Control-Allow-Origin': '*'})
            return
        elif path == '/v1/customer-checkout/config':
            state['config'] += 1
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


def blur_is_round(locator):
    # QA 27.10 (item 13): the blur layer itself is rounded like its button. A backdrop blur is not
    # shaped by an ancestor's rounded clip, which showed a square tinted patch in the cart sheet.
    return locator.evaluate("""(el) => {
      const side = el.getBoundingClientRect().width;
      const layers = [el, ...el.querySelectorAll('*')].filter((n) => {
        const style = getComputedStyle(n);
        return (style.backdropFilter || style.webkitBackdropFilter || '').includes('blur');
      });
      return layers.length > 0 && layers.every((n) => {
        const style = getComputedStyle(n);
        return ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']
          .every((corner) => parseFloat(style[corner]) >= side / 2 - 1) && style.overflow === 'hidden';
      });
    }""")


def waiting_fits(page, width):
    # QA 27.10 (items 11/16): the whole waiting scene sits above the pinned buttons, at 393 and at
    # 320 x 568: title, scene, spinner, the amount line and the countdown are not cut or covered.
    waiting = page.get_by_test_id('kaspi-waiting')
    scroll = waiting.get_by_test_id('kaspi-state-scroll').bounding_box()
    footer = waiting.get_by_test_id('bottom-actions').bounding_box()
    assert scroll['y'] + scroll['height'] <= footer['y'] + 1, (scroll, footer)
    expect(waiting.get_by_test_id('kaspi-state-detail')).to_contain_text('4 190 ₸')
    for test_id in ('kaspi-state-spinner', 'kaspi-state-detail', 'kaspi-invoice-countdown'):
        box = waiting.get_by_test_id(test_id).bounding_box()
        assert box and scroll['y'] - 1 <= box['y'] and box['y'] + box['height'] <= footer['y'] + 1, (width, test_id, box, scroll, footer)
    if width > 360:
        return
    # Large text (the web build reports fontScale 1): grow every text of the scene by x1.3. The
    # content may scroll then, but it stays above the buttons and every line can be reached.
    waiting.get_by_test_id('kaspi-state-scroll').evaluate("""(e) => {
      for (const node of e.querySelectorAll('*')) {
        const style = getComputedStyle(node);
        if (node.childNodes.length && [...node.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) {
          node.style.fontSize = parseFloat(style.fontSize) * 1.3 + 'px';
          if (style.lineHeight !== 'normal') node.style.lineHeight = parseFloat(style.lineHeight) * 1.3 + 'px';
        }
      }
    }""")
    page.wait_for_timeout(200)
    scroll = waiting.get_by_test_id('kaspi-state-scroll').bounding_box()
    footer = waiting.get_by_test_id('bottom-actions').bounding_box()
    assert scroll['y'] + scroll['height'] <= footer['y'] + 1, (scroll, footer)
    for test_id in ('kaspi-state-detail', 'kaspi-invoice-countdown'):
        target = waiting.get_by_test_id(test_id)
        target.evaluate("(e) => e.scrollIntoView({block: 'nearest'})")
        box = target.bounding_box()
        assert scroll['y'] - 1 <= box['y'] and box['y'] + box['height'] <= scroll['y'] + scroll['height'] + 1, (test_id, box, scroll)
    page.screenshot(path=str(OUT / f'after-pay-large-text-{width}.png'))


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
    assert glyph(clear) == 'rgb(255, 59, 48)', glyph(clear)
    assert glyph(shut) == 'rgb(255, 255, 255)', glyph(shut)
    assert has_blur(clear) and has_blur(shut), 'Glass buttons blur what is behind them'
    assert blur_is_round(clear) and blur_is_round(shut), 'No square blur patch around the round buttons'
    # Owner 28.10.2026: the cart -/+ keep their original look - plain buttons in one filled pill.
    for minus in (page.get_by_test_id('cart-minus-pick-combo'), page.get_by_test_id('cart-plus-pick-combo')):
        assert not has_blur(minus) and minus.bounding_box()['height'] >= 44
    stepper_bg = page.get_by_test_id('cart-minus-pick-combo').evaluate(
        '(e) => getComputedStyle(e.parentElement).backgroundColor')
    assert stepper_bg == 'rgb(20, 48, 107)', stepper_bg

    # Text remains readable and keeps the same size after selection/layout changes.
    for mode in ('dine_in', 'takeaway', 'dine_in', 'takeaway'):
        control = page.get_by_test_id('cart-dining-' + mode)
        control.click()
        typography = control.evaluate("""e => [...e.querySelectorAll('*')]
          .filter(n => [...n.childNodes].some(c => c.nodeType === 3 && c.textContent.trim()))
          .map(n => parseFloat(getComputedStyle(n).fontSize))""")
        assert 17 in typography, typography
        assert control.bounding_box()['height'] >= 48

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
    # A burst of taps (150 ms apart) re-reads the Kaspi session once after the last tap, not per tap.
    page.wait_for_timeout(800)
    reads = state['config']
    page.get_by_test_id('cart-plus-pick-combo').evaluate(
        '(el) => { el.click(); setTimeout(() => el.click(), 150); setTimeout(() => el.click(), 300); }')
    expect(page.get_by_test_id('cart-quantity-pick-combo')).to_have_text('4')
    page.wait_for_timeout(1500)
    assert state['config'] - reads == 1, ('one passive re-read per burst', state['config'] - reads)
    page.get_by_test_id('cart-minus-pick-combo').evaluate(
        '(el) => { el.click(); setTimeout(() => el.click(), 150); setTimeout(() => el.click(), 300); }')
    expect(page.get_by_test_id('cart-quantity-pick-combo')).to_have_text('1')
    expect(pay).to_be_enabled()
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
    # This fixture's server does not run 6 + 1 (/combo-rewards unanswered) and publishes no promos:
    # the App Store build shows no card and no empty «Акции» heading (owner 29.10.2026).
    expect(page.get_by_test_id('cart-combo-reward')).to_have_count(0)
    expect(sheet.get_by_text('Акции', exact=True)).to_have_count(0)
    expect(sheet.get_by_text('Отметки пока у кассира', exact=False)).to_have_count(0)
    # Footer: payment method left, «Итого» right, white pay button below. The floating cart bar
    # under the sheet has its own cart-total, so the footer one is read inside the cart screen.
    method = page.get_by_test_id('cart-payment-method')
    total = page.get_by_test_id('screen-M09').get_by_test_id('cart-total')
    expect(method).to_contain_text('Kaspi.kz')
    expect(total).to_have_text('4 190 ₸')
    expect(pay).to_contain_text('Оплатить с')
    expect(pay).to_contain_text('Kaspi.kz')
    assert pay.evaluate("(e) => e.innerText.replace(/\\s+/g, ' ').trim()") == 'Оплатить с Kaspi.kz'
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
    # Comment at the bottom of the cart, after the suggestions, above the payment block.
    comment = page.get_by_test_id('checkout-comment-input')
    comment.scroll_into_view_if_needed()
    comment.fill('Без лука')
    comment.blur()
    expect(page.get_by_test_id('checkout-comment-count')).to_have_text('8/60')
    above = page.get_by_test_id('cart-recommendations').bounding_box()
    box = comment.bounding_box()
    assert above['y'] < box['y'] and box['y'] + box['height'] <= footer.bounding_box()['y'] + 1, (above, box)
    page.screenshot(path=str(OUT / f'cart-comment-{width}.png'))
    # Payment selector: Kaspi.kz only (owner 29.10.2026, App Review 2.1): no Apple Pay, Google Pay
    # or card row, name, «скоро» or mark (EXPO_PUBLIC_UPCOMING_PAYMENTS is off in this build).
    method.click()
    chooser = page.get_by_test_id('cart-payment-sheet')
    expect(chooser).to_be_visible()
    kaspi = page.get_by_test_id('cart-payment-kaspi')
    expect(kaspi).to_have_attribute('aria-checked', 'true')
    expect(chooser.get_by_role('radio')).to_have_count(1)
    for id in ('apple_pay', 'google_pay', 'card'):
        expect(page.get_by_test_id('cart-payment-' + id)).to_have_count(0)
    for word in ('Apple', 'Google', 'Банковская карта', 'СКОРО', 'скоро'):
        expect(chooser.get_by_text(word, exact=False)).to_have_count(0)
    assert 'Apple' not in (chooser.inner_text() + ' '.join(
        chooser.locator('[aria-label]').evaluate_all('(els) => els.map((e) => e.getAttribute("aria-label"))'))), 'no wallet name'
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
    waiting_fits(page, width)
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
    assert blur_is_round(close_button)
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / f'product-glass-{width}.png'))
    close(ctx, state)


def glass_parts(locator):
    # The fallback glass of one control (the web build; iOS 26 draws Apple's Liquid Glass instead):
    # its rim, blur layers, specular edge and the translucent or opaque fills inside it.
    return locator.evaluate("""(el) => {
      const styles = [el, ...el.querySelectorAll('*')].map((n) => getComputedStyle(n));
      return {
        rim: getComputedStyle(el).borderTopColor,
        blur: styles.some((s) => (s.backdropFilter || s.webkitBackdropFilter || '').includes('blur')),
        specular: styles.some((s) => s.boxShadow.includes('inset')),
        fills: styles.map((s) => s.backgroundColor).filter((c) => c !== 'rgba(0, 0, 0, 0)'),
      };
    }""")


def glass_look(browser, width, height):
    # Owner 28.10.2026: Apple's glass style. The web fallback imitates Liquid Glass: a light rim, a
    # specular inner edge, a thin veil over the blur; reduced transparency makes it opaque, live.
    ctx, page, state = make_context(browser, width, height)
    page.goto(URL + '/menu')
    page.get_by_test_id('product-pick-combo').click(timeout=25000)
    page.get_by_test_id('product-add').click()
    bar = page.get_by_test_id('cart-shortcut').filter(visible=True)
    expect(bar).to_be_visible()
    profile = page.get_by_test_id('screen-M06').get_by_test_id('header-profile')
    expect(profile.locator('#header-profile-avatar')).to_have_count(1)
    parts = glass_parts(bar)
    assert parts['blur'] and parts['specular'], parts
    assert 'rgba(10, 32, 80, 0.8)' in parts['fills'] and parts['rim'] == 'rgba(255, 255, 255, 0.24)', parts
    pill = page.get_by_test_id('cart-pay-pill').filter(visible=True)
    # The handle's glass lies on its opaque base (#071A44), never on the capsule's glass (on iOS 26
    # Apple's glass cannot sample glass); the header profile keeps its brighter 0.4 rim over the video.
    for shape, rim in ((pill, 'rgba(255, 255, 255, 0.3)'), (profile, 'rgba(255, 255, 255, 0.4)')):
        parts = glass_parts(shape)
        assert parts['blur'] and parts['specular'] and parts['rim'] == rim, parts
    assert glass_parts(pill)['fills'][0] == 'rgb(7, 26, 68)', glass_parts(pill)
    assert blur_is_round(profile)
    # The avatar sits inside the glass with a 3 pt ring of glass around it (Drinkit's profile).
    outer, avatar = profile.bounding_box(), profile.locator('#header-profile-avatar').bounding_box()
    assert abs(avatar['width'] - (outer['width'] - 6)) <= 0.5 and abs(avatar['height'] - avatar['width']) <= 0.5, (outer, avatar)
    assert abs((avatar['x'] + avatar['width'] / 2) - (outer['x'] + outer['width'] / 2)) <= 0.5, (outer, avatar)
    assert abs((avatar['y'] + avatar['height'] / 2) - (outer['y'] + outer['height'] / 2)) <= 0.5, (outer, avatar)
    # The screenshot shows the menu from the top (opening the product scrolled it at 320 pt).
    page.get_by_test_id('product-pick-combo').evaluate("""(el) => {
      for (let n = el.parentElement; n; n = n.parentElement)
        if (n.scrollHeight > n.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) {
          n.scrollTop = 0;
          return;
        }
    }""")
    page.wait_for_timeout(600)
    page.screenshot(path=str(OUT / f'menu-glass-{width}.png'))
    page.get_by_test_id('open-cart').filter(visible=True).click()
    expect(page.get_by_test_id('screen-M09')).to_be_visible()
    expect(page.get_by_test_id('cart-pay')).to_be_enabled(timeout=15000)
    controls = [page.get_by_test_id(i) for i in ('cart-clear', 'cart-close')]
    for control in controls:
        parts = glass_parts(control)
        assert parts['blur'] and parts['specular'] and parts['rim'] == 'rgba(255, 255, 255, 0.3)', parts
        assert 'rgba(16, 36, 84, 0.26)' in parts['fills'], parts
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / f'cart-glass-{width}.png'))
    # The system asks for reduced transparency: no blur, an opaque fill, the rim stays.
    cdp = ctx.new_cdp_session(page)
    cdp.send('Emulation.setEmulatedMedia',
             {'features': [{'name': 'prefers-reduced-transparency', 'value': 'reduce'}]})
    page.wait_for_function("() => matchMedia('(prefers-reduced-transparency: reduce)').matches")
    page.wait_for_function("""() => {
      const el = document.querySelector('[data-testid="cart-close"]');
      return el && ![el, ...el.querySelectorAll('*')].some((n) =>
        (getComputedStyle(n).backdropFilter || '').includes('blur'));
    }""")
    for control in controls:
        parts = glass_parts(control)
        assert not parts['blur'] and 'rgb(18, 48, 104)' in parts['fills'], parts
        assert parts['rim'] == 'rgba(255, 255, 255, 0.3)', parts
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / f'cart-glass-solid-{width}.png'))
    page.get_by_test_id('cart-close').click()
    expect(page.get_by_test_id('screen-M09')).to_have_count(0)
    parts = glass_parts(bar)
    assert not parts['blur'] and 'rgb(10, 32, 80)' in parts['fills'], parts
    # The handle and the profile keep their rims on the solid glass too (on iOS 26 the rim comes
    # back with Reduce Transparency: it follows the surface, not a value fixed at launch).
    for shape, rim in ((pill, 'rgba(255, 255, 255, 0.3)'), (profile, 'rgba(255, 255, 255, 0.4)')):
        parts = glass_parts(shape)
        assert not parts['blur'] and parts['rim'] == rim and 'rgb(18, 48, 104)' in parts['fills'], parts
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / f'menu-glass-solid-{width}.png'))
    assert not state['mutations'], state['mutations']
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
    # Sign-in from the cart names the reason: order and pay with Kaspi.
    expect(page.get_by_text('Чтобы оформить заказ и оплатить его через Kaspi', exact=True)
           .filter(visible=True)).to_be_visible()
    page.get_by_test_id('account-required-login').filter(visible=True).click()
    phone = page.get_by_test_id('phone-input').filter(visible=True)
    expect(phone).to_be_editable()
    shut = page.get_by_role('button', name='Закрыть вход', exact=True).filter(visible=True)
    assert has_blur(shut) and shut.bounding_box()['height'] >= 44, 'The sign-in X is glass'
    phone.fill('7' + '0' * 8 + '1')
    page.get_by_test_id('request-otp').filter(visible=True).click()
    expect(page.get_by_test_id('screen-M03').filter(visible=True)).to_be_visible()
    # The code step's «Изменить номер» is the same round glass button as the X on the other steps.
    back = page.get_by_test_id('auth-change-number').filter(visible=True)
    expect(back).to_have_accessible_name('Изменить номер')
    box = back.bounding_box()
    assert has_blur(back) and box['width'] >= 44 and abs(box['width'] - box['height']) < 1, box
    assert glyph(back) == 'rgb(255, 255, 255)', glyph(back)
    assert back.evaluate('(el) => getComputedStyle(el).borderTopLeftRadius') == f"{box['width'] / 2:g}px"
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / 'otp-glass-393.png'))
    back.click()
    expect(page.get_by_test_id('phone-input').filter(visible=True)).to_be_editable()
    page.get_by_role('button', name='Закрыть вход', exact=True).filter(visible=True).click()
    expect(page.get_by_test_id('screen-M09')).to_be_visible(timeout=10000)
    assert state['otp'] == 1, state['otp']
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
        glass_look(browser, width, height)
    guest(browser)
    hero_video(browser)
    browser.close()
assert not errors, errors
print('PASS cart page 393/320: Drinkit top bar (red glass trash, pin + point, glass close), dining pill -> quote, '
      'one re-read per burst of edits, removed blocks/small print, comment, payment selector (Kaspi.kz only, no '
      'Apple Pay / card / «скоро»), no 6 + 1 card while the server programme is off, one press = 1 quote + 1 order + 1 invoice, 3-item total, glass product close, guest -> sign-in '
      '(Kaspi reason, glass X and code-step back) -> cart, hero video plays under the cart and pauses for tab/full '
      'screen/background, round blur layers (no square patch), waiting scene fits at 393 and 320 (also with large text), '
      'Liquid Glass fallback (light rim, specular edge, thin veil; bar, handle on its opaque base, profile 0.4 rim and '
      'ring around the avatar) and opaque glass with reduced transparency (rims kept)')
