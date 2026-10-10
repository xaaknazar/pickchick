"""Live menu: an open photo card and an open cart follow publications without user action.

Driven by tests/integration/catalog-mobile-live-browser.test.mjs (real long-poll controller,
LISTEN/NOTIFY and CatalogAdmin.publish on local PostgreSQL). The fixture refuses every order,
quote and payment command; no external host is reached.
"""
from browser_network import API, isolated_context, route_fixture
import json, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

fixture = json.loads(Path(sys.argv[1]).read_text())
URL = fixture['url']; OUT = Path(fixture['output']); CUSTOMER = fixture['customer']; BRANCH = fixture['branch']
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost')
NOTICE = 'Цены обновились. Проверьте итоговую сумму перед оплатой'
FORBIDDEN_TEXT = ['Позиция пока недоступна', 'Состав меню изменился', 'Нужно выбрать состав заново']
LIMIT = 3.0
future = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat().replace('+00:00', 'Z')
customer = {'id': CUSTOMER, 'phone': '+77000000000', 'nickname': 'Synthetic browser', 'birth_date': None,
            'gender': None, 'profile_completed_at': None, 'created_at': '2026-09-07T10:00:00.000Z'}
envelope = {'version': 1, 'device_id': '40000000-0000-4000-8000-000000000004',
            'tokens': {'access_token': 'a' * 64, 'refresh_token': 'b' * 64, 'access_expires_at': future,
                       'session_id': '40000000-0000-4000-8000-000000000002', 'customer': customer},
            'challenge': None, 'otp_request': None, 'verify_intent': None, 'refresh_request_id': None, 'closing': None}
# Records any forbidden text seen at any moment (catches a short flicker, not only the end state).
WATCH = ('(() => { const bad = ' + json.dumps(FORBIDDEN_TEXT, ensure_ascii=False) + ';'
         ' window.__seen = []; setInterval(() => { const t = document.body ? document.body.innerText : "";'
         ' for (const s of bad) if (t.includes(s) && !window.__seen.includes(s)) window.__seen.push(s); }, 25); })();')
HAS = ('([id, text]) => { const n = id ? document.querySelector(`[data-testid="${id}"]`) : document.body;'
       ' return !!n && n.innerText.replace(/\\s/g, " ").includes(text); }')
HIDE = ('Object.defineProperty(document, "visibilityState", {configurable: true, get: () => "%s"});'
        'document.dispatchEvent(new Event("visibilitychange"))')
errors = []; commands = []; offline = set(); results = {}


def api(context):
    def route(r):
        # The health probe is answered by route_fixture; while "offline" the context itself
        # is offline (set_offline), and API reads that still reach the fixture are refused.
        if id(context) in offline:
            return r.abort('internetdisconnected')
        parsed = urlparse(r.request.url); path = parsed.path
        if path.startswith('/v1/customer-checkout/'):
            if r.request.method != 'GET':
                commands.append(r.request.method + ' ' + path)
                return r.fulfill(status=403, json={'code': 'FORBIDDEN', 'message_key': 'errors.forbidden',
                                                   'trace_id': '00000000-0000-4000-8000-000000000000', 'retryable': False})
            try:
                response = r.fetch(url=URL + path + ('?' + parsed.query if parsed.query else ''), timeout=30000)
            except Exception:
                return r.abort('failed')
            return r.fulfill(response=response, headers={
                **response.headers, 'access-control-allow-origin': '*',
                'access-control-expose-headers': 'X-Catalog-Version, X-Availability-Signature'})
        if path == '/v1/capabilities':
            data = {'schema_version': 1, 'environment': 'staging', 'data_mode': 'pilot', 'ordering_enabled': False,
                    'features': {'phone_auth': True, 'test_order_flow': True,
                                 **{k: False for k in ['payments', 'fiscal', 'checkout', 'loyalty']}}}
        elif path == '/v1/customers/me':
            data = {'customer': customer}
        elif path == '/v1/auth/config':
            data = {'enabled': True, 'delivery_consent_required': True, 'consent_version': 'fixture-v1',
                    'terms_url': 'https://example.test/terms', 'privacy_url': 'https://example.test/privacy'}
        elif path == '/v1/content/branches/' + BRANCH:
            data = {'schema_version': 1, 'branch_id': BRANCH, 'promos': [], 'games': []}
        else:
            raise AssertionError('Unexpected external API ' + path)
        r.fulfill(status=200, json=data, headers={'Access-Control-Allow-Origin': '*'})
    route_fixture(context, API + '/**', route)


def device(browser, name):
    context = isolated_context(browser, viewport={'width': 393, 'height': 852}, reduced_motion='reduce')
    context.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",' + json.dumps(json.dumps(envelope)) + ');')
    context.add_init_script(WATCH)
    api(context)
    page = context.new_page(); page.on('pageerror', lambda e: errors.append(name + ': ' + str(e)))
    page.goto(URL + '/menu')
    expect(page.get_by_test_id('product-burger')).to_contain_text('2 550,01', timeout=30000)
    return context, page


def publish(request, query):
    response = request.post(URL + '/fixture/publish?' + query)
    assert response.ok, response.text()
    return time.monotonic(), response.json()['version']


def within(name, page, test_id, text, started, limit=LIMIT):
    page.wait_for_function(HAS, arg=[test_id, text], polling=50, timeout=limit * 1000)
    results[name] = round(time.monotonic() - started, 3)
    assert results[name] <= limit, (name, results[name])


with sync_playwright() as p:
    browser = p.chromium.launch()
    card_context, card = device(browser, 'card')
    cart_context, cart = device(browser, 'cart')
    # Open photo card: extra sauce and quantity 2, not added to the cart.
    card.get_by_test_id('product-burger').click()
    card.get_by_role('button', name='Увеличить: Extra sauce', exact=True).click()
    card.get_by_role('button', name='Увеличить: Director Burger', exact=True).click()
    expect(card.get_by_test_id('product-add')).to_contain_text('5 400,02')
    # Open cart: the same configured burger x2 and one side.
    cart.get_by_test_id('product-burger').click()
    cart.get_by_role('button', name='Увеличить: Extra sauce', exact=True).click()
    cart.get_by_role('button', name='Увеличить: Director Burger', exact=True).click()
    cart.get_by_test_id('product-add').click()
    cart.get_by_test_id('product-side').click(); cart.get_by_test_id('product-add').click()
    cart.get_by_test_id('open-cart').click()
    expect(cart.get_by_test_id('cart-checkout')).to_contain_text('5 650,02')
    expect(cart.get_by_test_id('cart-quantity-burger')).to_have_text('2')
    card.screenshot(path=str(OUT / 'live-card-before.png')); cart.screenshot(path=str(OUT / 'live-cart-before.png'))
    request = card_context.request
    time.sleep(1.0)  # both clients are parked in the availability long-poll

    # 1. Price publication reaches the open card and the open cart without any user action.
    started, version = publish(request, 'price=265001')
    within('publish.card_total', card, 'product-add', '5 600,02', started)
    within('publish.card_notice', card, None, NOTICE, started)
    within('publish.cart_total', cart, 'cart-checkout', '5 850,02', started)
    within('publish.cart_notice', cart, 'cart-prices-updated', NOTICE, started)
    # The card was not remounted: quantity and the chosen extra survive.
    expect(card.get_by_test_id('product-add')).to_contain_text('5 600,02')
    expect(cart.get_by_test_id('cart-quantity-burger')).to_have_text('2')
    card.screenshot(path=str(OUT / 'live-card-published.png')); cart.screenshot(path=str(OUT / 'live-cart-published.png'))

    # 2. Background and foreground: a hidden cart catches up as soon as it returns.
    cart.evaluate(HIDE % 'hidden'); time.sleep(0.5)
    started, version = publish(request, 'price=275001')
    within('background.card_total', card, 'product-add', '5 800,02', started)
    time.sleep(1.0)
    returned = time.monotonic(); cart.evaluate(HIDE % 'visible')
    within('background.cart_after_return', cart, 'cart-checkout', '6 050,02', returned)

    # 3. Network loss and recovery: the offline cart catches up after reconnecting.
    offline.add(id(cart_context)); cart_context.set_offline(True); time.sleep(1.0)
    started, version = publish(request, 'price=285001')
    within('offline.card_total', card, 'product-add', '6 000,02', started)
    assert cart.evaluate(HAS, ['cart-checkout', '6 050,02']), 'offline cart keeps the last known total'
    reconnected = time.monotonic(); offline.discard(id(cart_context)); cart_context.set_offline(False)
    within('offline.cart_after_online', cart, 'cart-checkout', '6 250,02', reconnected, limit=6.0)

    # 4. The chosen option leaves the menu: the cart line is removed entirely, only the price
    #    notice is shown; the open card keeps its quantity without the vanished option.
    started, version = publish(request, 'drop_option=extra')
    cart.wait_for_function('() => !document.querySelector(\'[data-testid="cart-quantity-burger"]\')',
                           polling=50, timeout=LIMIT * 1000)
    results['drop_option.cart_line_removed'] = round(time.monotonic() - started, 3)
    within('drop_option.cart_total', cart, 'cart-checkout', '250 ₸', started)
    expect(cart.get_by_test_id('cart-quantity-side')).to_have_text('1')
    expect(cart.get_by_test_id('cart-prices-updated')).to_contain_text(NOTICE)
    within('drop_option.card_total', card, 'product-add', '5 700,02', started)
    expect(card.get_by_text(NOTICE, exact=True)).to_be_visible()
    card.screenshot(path=str(OUT / 'live-card-option-removed.png')); cart.screenshot(path=str(OUT / 'live-cart-option-removed.png'))

    seen = {'card': card.evaluate('window.__seen'), 'cart': cart.evaluate('window.__seen')}
    assert seen == {'card': [], 'cart': []}, seen
    assert not commands, commands
    assert not errors, errors
    card_context.close(); cart_context.close(); browser.close()
print(json.dumps({'browser': 'passed', 'timings_s': results, 'forbidden_text_seen': 0,
                  'commands': 0, 'publications': version}, ensure_ascii=False))
