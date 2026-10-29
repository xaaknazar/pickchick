"""App Store walk (owner 29.10.2026, «устрани это все»; App Review Guideline 2.1; review 29.10.2026).

The Kaspi customer build is what goes to the App Store. This walk opens every customer screen of
that build and asserts that no visible text, accessible name or icon announces a feature that does
not work yet («скоро», «подключается», «ещё не / пока не», «not yet», «will be available»,
KK «әлі», «әзірге», «қосылуда»), mentions the Chiki programme or a «Без фото» placeholder, or
offers Apple Pay / Google Pay / a bank card (no name, no row, no Apple/Google logo). The patterns
and the real temporary states that may be shown are shared with tests/mobile/store-copy.test.mjs
(store-copy-patterns.json).
  menu (top, end, product page with the combo extras, cart bar), cart (+ end) and «Способ оплаты»,
  «События», «Заказы», order status and its help sheet, a completed order, the profile and every
  row (notifications, help and restaurant, «Неясен результат оплаты?», profile edit with its
  «Отмена», «Настройки» with «Как проходит заказ», restaurants, documents, data management), the
  deep links of preview-only screens (M22-M25, M35 open the menu), the same main screens in
  English (where no Cyrillic may remain, accessible names included) and Kazakh, a guest (menu,
  cart, sign-in, «События» and the three mini-games without signing in), the 320 pt screen;
  the payment step: the App Review account (403 FORBIDDEN on POST /orders: neutral text,
  «Как проходит заказ» into the demonstration, no invoice), the restaurant that does not answer
  and Kaspi answering slowly (20 s stuck states); «Удалить аккаунт» and its confirmation;
  the App Review sign-in in English (second review 29.10.2026): the number typed with its country
  code («+7…», «7…», «8…») keeps every digit, the code, the «Let's get to know you» form left empty
  with «Done», and the profile then shows «Crunch lover» (KK too), no Russian; the design-preview
  deep links (`?preview=1`) are ignored by this build.
The server answers like production on 29.10.2026: the 6 + 1 programme is switched off
(/combo-rewards {enabled: false}), push is not connected, receipts are deferred.

STORE_WALK_PROFILE:
  storefront (the App Store profile: EXPO_PUBLIC_CUSTOMER_AUTH=server, EXPO_PUBLIC_KASPI_CHECKOUT=1,
    EXPO_PUBLIC_ORDER_SIMULATOR=0, EXPO_PUBLIC_UNPAID_TEST_ORDERS=0, EXPO_PUBLIC_PUBLISHED_CATALOG=1,
    EXPO_PUBLIC_PICK_FARM=0): the published catalogue, no test-order request at all;
  qa (default; the customer-auth export of CI: ...UNPAID_TEST_ORDERS=1, PUBLISHED_CATALOG=0).
Local fixtures only: no bank, no real customer, no VPS request. Screenshots: STORE_WALK_OUT.
"""
from browser_network import isolated_context, route_fixture
import json, os, re, subprocess, threading, uuid
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('CUSTOMER_AUTH_URL', 'http://127.0.0.1:4196').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost'), 'Use a local exported app'
PROFILE = os.environ.get('STORE_WALK_PROFILE', 'qa')
assert PROFILE in ('qa', 'storefront'), PROFILE
STOREFRONT = PROFILE == 'storefront'
OUT = ROOT / os.environ.get('STORE_WALK_OUT', '.local/store-walk')
# Debugging only: STORE_WALK_REPORT=1 prints findings instead of failing; STORE_WALK_ONLY=a,b runs
# only those parts (signed_in, languages, small, guest, payment_step, delete, sign_in).
REPORT = os.environ.get('STORE_WALK_REPORT') == '1'
ONLY = [part for part in os.environ.get('STORE_WALK_ONLY', '').split(',') if part]
OUT.mkdir(parents=True, exist_ok=True)


def node_json(code):
    return json.loads(subprocess.check_output(['node', '--input-type=module', '-e', code], cwd=ROOT, text=True))


CAT = node_json("import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js';"
                "console.log(JSON.stringify(testCompleteCatalog))")
BRANCH = CAT['branch_id']
PRICES = {p['id']: (p['name'], int(p['price_minor'])) for p in CAT['products']}
# The published storefront (back-office seed of the same menu) for the storefront profile.
SEED = node_json("import {mockupCatalogDraft} from './packages/catalog-admin/dist/seed.js';"
                 "console.log(JSON.stringify(mockupCatalogDraft))")
PUBLICATION = {'branch': {'id': BRANCH, 'code': 'ABAY', 'name': 'ТЦ Abay Plaza', 'timezone': 'Asia/Almaty',
                          'ordering_enabled': True},
               'channel': 'mobile', 'version': 6, 'published_at': '2026-10-28T00:00:00.000Z',
               'payload': {**SEED, 'content_source': 'operator', 'content_reviewed': True}}
PRODUCTS = SEED['products'] if STOREFRONT else CAT['products']


def option_delta(product, group_id, option_id):
    for group in product.get('modifier_groups') or []:
        if group['id'] == group_id:
            for option in group['options']:
                if option['id'] == option_id:
                    return int(option.get('price_delta_minor') or 0)
    return 0


def quote_total(body):
    by_id = {p['id']: p for p in PRODUCTS}
    total = 0
    for item in body['items']:
        product = by_id[item['productId']]
        unit = int(product['price_minor']) + sum(
            option_delta(product, s['group_id'], s['option_id']) * s['quantity'] for s in item['selections'])
        total += unit * item['quantity']
    return str(total)


MESSAGES = {m['ru']: m for m in json.loads((ROOT / 'apps/mobile/src/i18n/messages.json').read_text())}
SHARED = json.loads((ROOT / 'tests/mobile/store-copy-patterns.json').read_text())
FORBIDDEN = [re.compile(pattern, re.I) for pattern in SHARED['patterns']]
# Real temporary states (closed, payment pending, bank or restaurant not answering) in RU/KK/EN.
ALLOWED_VISIBLE = sorted({text for state in SHARED['states']
                          for text in (state['text'], MESSAGES.get(state['text'], {}).get('kk'),
                                       MESSAGES.get(state['text'], {}).get('en')) if text},
                         key=len, reverse=True)
GLYPHS = json.loads((ROOT / 'apps/mobile/node_modules/@expo/vector-icons/build/vendor/'
                     'react-native-vector-icons/glyphmaps/Ionicons.json').read_text())
# The Apple / Google marks the payment rows used: none may be drawn anywhere.
LOGOS = {name: chr(GLYPHS[name]) for name in ('logo-apple', 'logo-google', 'logo-apple-appstore')}
WALLET_IDS = ['apple_pay', 'google_pay', 'card']
CYRILLIC = re.compile(r'[А-Яа-яЁёӘәІіҢңҒғҮүҰұҚқӨөҺһ]')
# English screens may show these Cyrillic words only: the language names of the language picker.
EN_ALLOWED_CYRILLIC = ['Русский', 'Қазақша']

CUSTOMER = '40000000-0000-4000-8000-000000000001'
customer = {'id': CUSTOMER, 'phone': '+77000000000', 'nickname': 'UI test', 'birth_date': None,
            'gender': None, 'profile_completed_at': None, 'created_at': '2026-09-07T10:00:00.000Z'}
envelope = {'version': 1, 'device_id': '40000000-0000-4000-8000-000000000004',
            'tokens': {'access_token': 'a' * 64, 'refresh_token': 'b' * 64,
                       'access_expires_at': '2099-01-01T00:00:00.000Z',
                       'session_id': '40000000-0000-4000-8000-000000000002', 'customer': customer},
            'challenge': None, 'otp_request': None, 'verify_intent': None,
            'refresh_request_id': None, 'closing': None}
DRAFT_KEY = 'pickchick.commerce.pending.v1:' + CUSTOMER


def uid(seed):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'pickchick-store-walk/' + seed))


def commerce_order(number, phase, created, entries, stage=None, modifiers=None):
    return {'orderId': uid('order' + number), 'revision': uuid.uuid5(uuid.NAMESPACE_URL, created + phase).hex * 2,
            'restaurant': 'ТЦ Abay Plaza', 'branchId': BRANCH, 'createdAt': created, 'updatedAt': created,
            'kitchenStage': stage, 'displayNumber': number,
            'totalMinor': str(sum(PRICES[p][1] * q for p, q in entries)), 'serviceMode': 'takeaway',
            'kitchenComment': None, 'phase': phase,
            'expiresAt': None,
            # Every app order today: fiscalPolicy deferred_pilot, no receipt.
            'receipt': 'deferred', 'receiptUrl': None,
            'items': [{'productId': p, 'title': PRICES[p][0], 'quantity': q,
                       'totalMinor': str(PRICES[p][1] * q), 'modifiers': list(modifiers or [])}
                      for p, q in entries]}


PREPARING = commerce_order('14', 'preparing', '2026-10-29T06:50:00.000Z', [('pick-combo', 1), ('sauce', 1)],
                           'cooking', ['Coca-Cola 0.5 л, бутылка', 'Фирменный соус Pick Chick'])
READY = commerce_order('15', 'ready', '2026-10-29T06:40:00.000Z', [('finger-duo', 1)])
HANDED = commerce_order('12', 'handed_over', '2026-10-28T12:32:00.000Z', [('pick-combo', 1)])
ORDERS = [PREPARING, READY, HANDED]
errors, mutations, walked, test_requests = [], [], [], []

COLLECT = '''() => {
  const shown = (el) => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const out = [document.body.innerText];
  for (const el of document.querySelectorAll('[aria-label],[title],[alt],[placeholder],[aria-description]'))
    if (shown(el))
      for (const a of ['aria-label', 'title', 'alt', 'placeholder', 'aria-description']) {
        const v = el.getAttribute(a);
        if (v) out.push(v);
      }
  return out.join('\\n');
}'''


def route_for(signed_in=True, checkout=None, deleted=None, auth=None):
    """`checkout`: None (the walk only looks), or the payment step: {'orders': 'forbidden' |
    'hold' | 'ok', 'counts': {...}} (quotes, refused or held creates, invoices are counted).
    `auth`: the sign-in of a guest: {'calls': [...], 'customer': None until the code is verified}."""
    def ok(route, data, headers=None):
        route.fulfill(json=data, headers={'Access-Control-Allow-Origin': '*', **(headers or {})})

    def intercept(route):
        path = urlparse(route.request.url).path
        method = route.request.method
        if path.startswith('/v1/test/'):
            test_requests.append(f'{method} {path}')
        if checkout is not None and path.startswith('/v1/customer-checkout/') and method == 'POST':
            counts = checkout['counts']
            if path.endswith('/quotes'):
                counts['quotes'] += 1
                body = route.request.post_data_json
                return ok(route, {'quoteId': uid('quote%d' % counts['quotes']), 'totalMinor': quote_total(body),
                                  'expiresAt': '2099-01-01T00:00:00.000Z', 'serviceMode': body['serviceMode'],
                                  'kitchenComment': None})
            if path.endswith('/orders'):
                counts['creates'] += 1
                if checkout['orders'] == 'forbidden':
                    # The server's error envelope (customer-checkout-controller, App Review phone).
                    return route.fulfill(status=403, json={'code': 'FORBIDDEN', 'message_key': 'errors.forbidden',
                                                           'trace_id': uid('trace'), 'retryable': False},
                                         headers={'Access-Control-Allow-Origin': '*'})
                if checkout['orders'] == 'hold':
                    checkout['held'].append(route)
                    return
                checkout['order'] = commerce_order('21', 'ready_to_pay', '2026-10-29T07:00:00.000Z',
                                                   [('pick-combo', 1)])
                return ok(route, checkout['order'])
            if path.endswith('/payment'):
                counts['payments'] += 1
                # Kaspi answers slowly: the invoice is still being sent.
                checkout['order'] = {**checkout['order'], 'phase': 'sending',
                                     'revision': uuid.uuid4().hex * 2}
                return ok(route, checkout['order'])
        if deleted is not None and path == '/v1/customers/me' and method == 'DELETE':
            deleted.append(path)
            return ok(route, {'ok': True})
        if auth is not None and method == 'POST' and path == '/v1/auth/otp/request':
            body = route.request.post_data_json
            auth['calls'].append(('request', body['phone']))
            return route.fulfill(status=202, json={
                'challenge_id': uid('challenge'), 'expires_at': '2099-01-01T00:03:00.000Z',
                'resend_at': '2099-01-01T00:01:00.000Z', 'delivery_status': 'submitted',
                'channel': 'telegram', 'code_length': 4}, headers={'Access-Control-Allow-Origin': '*'})
        if auth is not None and method == 'POST' and path == '/v1/auth/otp/verify':
            body = route.request.post_data_json
            auth['calls'].append(('verify', body['code']))
            # A new review account: no name, the optional profile form comes next.
            auth['customer'] = {**customer, 'nickname': '', 'profile_completed_at': None}
            return ok(route, {**envelope['tokens'], 'customer': auth['customer']})
        if auth is not None and method == 'PATCH' and path == '/v1/customers/me':
            body = route.request.post_data_json
            auth['calls'].append(('patch', body))
            auth['customer'] = {**auth['customer'], **body, 'profile_completed_at': '2026-10-29T10:00:00.000Z'}
            return ok(route, {'customer': auth['customer']})
        if method not in ('GET', 'OPTIONS'):
            # The walk only looks: no quote, order, payment, feedback or profile write. (The QA
            # export also has the synthetic test-order client, whose session request is refused.)
            if not path.startswith('/v1/test/'):
                mutations.append(f'{method} {path}')
            route.abort()
            return
        if path.endswith('/watch'):
            if checkout is not None:
                checkout['held'].append(route)
            else:
                route.abort()
            return
        data, headers = None, None
        if path == '/v1/customers/me' and (signed_in or (auth or {}).get('customer')) and not deleted:
            data = {'customer': (auth or {}).get('customer') or customer, 'legal': {'version': 'fixture-v1', 'terms_url': 'https://example.test/terms',
                                                    'privacy_url': 'https://example.test/privacy', 'accepted': True}}
        elif path == '/v1/customer-checkout/availability':
            data = {'enabled': True, 'fresh': True, 'orderingOpen': True, 'signature': 'a' * 64,
                    'products': [{'id': p['id'], 'available': True, 'stoppedOptions': []} for p in PRODUCTS]}
            if STOREFRONT:
                headers = {'X-Catalog-Version': str(PUBLICATION['version']), 'X-Availability-Signature': 'a' * 64,
                           'Access-Control-Expose-Headers': 'X-Catalog-Version, X-Availability-Signature'}
        elif path == '/v1/auth/config':
            # Production: the code goes to Telegram or WhatsApp.
            data = {'enabled': True, 'delivery_consent_required': True, 'consent_version': 'fixture-v1',
                    'channels': ['telegram'], 'channel_selection': 'automatic',
                    'whatsapp_fallback_enabled': True,
                    'terms_url': 'https://example.test/terms', 'privacy_url': 'https://example.test/privacy'}
        elif path == '/v1/capabilities':
            data = {'schema_version': 1, 'environment': 'production' if STOREFRONT else 'staging',
                    'data_mode': 'pilot', 'ordering_enabled': False,
                    'features': {'phone_auth': True, 'test_order_flow': not STOREFRONT,
                                 **{k: False for k in ['payments', 'fiscal', 'checkout', 'loyalty']}}}
        elif path == '/v1/customer-checkout/catalog' and STOREFRONT:
            data = PUBLICATION
        elif path == '/v1/branches' and not STOREFRONT:
            data = {'branches': [{'id': BRANCH, 'code': 'TEST', 'name': 'ТЦ Abay Plaza', 'timezone': 'Asia/Almaty',
                                  'ordering_enabled': False}]}
        elif path == '/v1/branches/' + BRANCH + '/menu' and not STOREFRONT:
            data = {'schema_version': 1, 'branch_id': BRANCH, 'release_id': uid('release'), 'version': 1,
                    'published_at': '2026-09-07T00:00:00Z', 'items': []}
        elif path == '/v1/test/catalog' and not STOREFRONT:
            data = CAT
        elif path == '/v1/content/branches/' + BRANCH:
            data = {'schema_version': 1, 'branch_id': BRANCH, 'promos': [], 'games': []}
        elif path == '/v1/customer-checkout/config':
            data = {'enabled': True, 'branchId': BRANCH, 'restaurant': 'ТЦ Abay Plaza',
                    'fiscalPolicy': 'deferred_pilot', 'orderCommentEnabled': True}
        elif path == '/v1/customer-checkout/combo-rewards':
            # Production on 29.10.2026: CUSTOMER_COMBO_REWARDS_ENABLED is off.
            data = {'enabled': False}
        elif path == '/v1/customer-checkout/orders':
            data = {'orders': [] if checkout is not None else ORDERS}
        elif path == '/v1/customer-checkout/feedback':
            data = {'feedback': []}
        elif path.startswith('/v1/customer-checkout/orders/') and path.endswith('/feedback'):
            data = {'orderId': path.split('/')[4], 'enabled': True, 'preparationStartedAt': None,
                    'readyAt': None, 'feedback': None}
        elif path.startswith('/v1/customer-checkout/orders/'):
            if checkout is not None and checkout.get('order'):
                data = checkout['order']
            else:
                data = next((o for o in ORDERS if o['orderId'] == path.split('/')[4]), None)
        if data is None:
            route.abort()
            return
        ok(route, data, headers)
    return intercept


def context(browser, width=393, height=852, signed_in=True, checkout=None, deleted=None, auth=None):
    ctx = isolated_context(browser, viewport={'width': width, 'height': height}, device_scale_factor=2,
                           reduced_motion='reduce')
    if signed_in:
        ctx.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",'
                            + json.dumps(json.dumps(envelope)) + ');')
    # Default notification fixture: the push service is not connected (enabled false).
    route_fixture(ctx, '**/v1/**', route_for(signed_in, checkout, deleted, auth))
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    return ctx, page


def settle(page):
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=25000)


def clean(page, name, wait=600, shot=True, english=False):
    """No forbidden word, no wallet row or mark on the visible screen; in English no Cyrillic."""
    page.wait_for_timeout(wait)
    text = page.evaluate(COLLECT)
    for allowed in ALLOWED_VISIBLE:
        text = text.replace(allowed, '')
    hits = []
    for pattern in FORBIDDEN:
        for match in pattern.finditer(text):
            hits.append(text[max(0, match.start() - 60):match.end() + 60].replace('\n', ' / '))
    if REPORT and hits:
        print('FORBIDDEN', name, hits)
        hits = []
    assert not hits, (name, hits)
    if english:
        latin = text
        for word in EN_ALLOWED_CYRILLIC:
            latin = latin.replace(word, '')
        russian = sorted({line.strip() for line in latin.split('\n') if CYRILLIC.search(line)})
        if REPORT and russian:
            print('CYRILLIC', name, russian)
            russian = []
        assert not russian, (name, 'Cyrillic on an English screen', russian)
    for logo, glyph in LOGOS.items():
        assert glyph not in text, (name, logo)
    glyphs = page.evaluate('() => document.body.textContent')
    for logo, glyph in LOGOS.items():
        assert glyph not in glyphs, (name, logo, 'drawn even if hidden')
    for wallet in WALLET_IDS:
        for prefix in ('cart-payment-', 'cart-pay-mark-', 'payment-mark-'):
            expect(page.locator(f'[data-testid="{prefix}{wallet}"]')).to_have_count(0)
    for gone in ('checkout-apple-pay', 'checkout-add-card'):
        expect(page.get_by_test_id(gone)).to_have_count(0)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (name, 'horizontal scroll')
    if shot:
        page.screenshot(path=str(OUT / f'{name}.png'))
    walked.append(name)


def scroll_end(page, test_id):
    page.get_by_test_id(test_id).filter(visible=True).first.evaluate('(e) => { e.scrollTop = e.scrollHeight; }')


def add(page, product='pick-combo', shot=None, english=False):
    page.get_by_test_id('product-' + product).click(timeout=25000)
    expect(page.get_by_test_id('product-add')).to_be_visible(timeout=15000)
    if shot:
        clean(page, shot, english=english)
        # «Добавить к комбо»: every extra and sauce has a picture (no «Без фото» placeholder).
        expect(page.get_by_test_id('option-photo-brand')).to_have_count(0)
    page.get_by_test_id('product-add').click()
    expect(page.get_by_test_id('cart-shortcut').filter(visible=True)).to_be_visible(timeout=15000)


def open_profile(page):
    page.goto(URL + '/profile')
    expect(page.get_by_test_id('screen-M30')).to_be_visible(timeout=25000)
    settle(page)


def profile_row(page, label):
    page.get_by_test_id('screen-M30').get_by_text(label, exact=True).click()


def payment_selector(page, name, english=False):
    page.get_by_test_id('cart-payment-method').click()
    sheet = page.get_by_test_id('cart-payment-sheet')
    expect(sheet).to_be_visible()
    # Kaspi.kz only: one radio, checked.
    expect(sheet.get_by_role('radio')).to_have_count(1)
    expect(page.get_by_test_id('cart-payment-kaspi')).to_have_attribute('aria-checked', 'true')
    clean(page, name, english=english)
    page.get_by_test_id('cart-payment-close').click()
    expect(sheet).to_have_count(0)


def walk_signed_in(browser):
    ctx, page = context(browser)
    # Menu: no Chiki card, no «скоро»; the end of the menu too.
    page.goto(URL + '/menu')
    settle(page)
    expect(page.get_by_test_id('product-pick-combo')).to_be_visible(timeout=25000)
    expect(page.get_by_test_id('loyalty-card')).to_have_count(0)
    clean(page, 'menu-393')
    scroll_end(page, 'scroll-M06')
    clean(page, 'menu-end-393')
    page.get_by_test_id('scroll-M06').evaluate('(e) => { e.scrollTop = 0; }')
    add(page, shot='product-393')
    clean(page, 'menu-cart-bar-393')
    # The cart bar handle pays with Kaspi only.
    expect(page.get_by_test_id('cart-pay-handle').filter(visible=True)).to_have_attribute(
        'aria-label', 'Оплатить через Kaspi', timeout=15000)
    # Cart: no 6 + 1 card (the server programme is off), no «Акции», Kaspi.kz only.
    page.get_by_test_id('open-cart').filter(visible=True).click()
    expect(page.get_by_test_id('screen-M09')).to_be_visible(timeout=15000)
    expect(page.get_by_test_id('cart-pay')).to_contain_text('Kaspi.kz', timeout=15000)
    expect(page.get_by_test_id('cart-combo-reward')).to_have_count(0)
    expect(page.get_by_test_id('screen-M09').get_by_text('Акции', exact=True)).to_have_count(0)
    clean(page, 'cart-393')
    scroll_end(page, 'scroll-M09')
    clean(page, 'cart-end-393')
    payment_selector(page, 'payment-selector-393')
    page.get_by_test_id('cart-close').click()
    expect(page.get_by_test_id('screen-M09')).to_have_count(0, timeout=10000)
    # «События»: games only; no 6 + 1 card, no «Миссии», no «Скоро».
    page.get_by_test_id('tab-events').click()
    expect(page.get_by_test_id('screen-M26')).to_be_visible(timeout=15000)
    expect(page.get_by_test_id('events-games')).to_be_visible()
    expect(page.get_by_test_id('events-combo-reward')).to_have_count(0)
    expect(page.get_by_test_id('screen-M26').get_by_text('Миссии', exact=True)).to_have_count(0)
    clean(page, 'events-393')
    scroll_end(page, 'scroll-M26')
    clean(page, 'events-end-393')
    # The mini-games' start screens: a personal best on this device, no Chiki.
    for route, start in (('/games/pick-blocks', 'blocks-start'), ('/games/pick-man', 'pick-man-start')):
        page.goto(URL + route)
        expect(page.get_by_test_id(start)).to_be_visible(timeout=25000)
        clean(page, f'game-{route.split("/")[-1]}-393')
    # «Заказы»: list, an order in preparation and its help sheet, a completed order.
    page.goto(URL + '/orders')
    expect(page.get_by_test_id('order-history-open-' + PREPARING['orderId'])).to_be_visible(timeout=25000)
    settle(page)
    clean(page, 'orders-393')
    page.get_by_test_id('order-history-open-' + PREPARING['orderId']).click()
    expect(page.get_by_test_id('order-more')).to_be_visible(timeout=15000)
    # A deferred receipt has no tile (no «чек пока не выпускается - Webkassa подключается»).
    expect(page.get_by_test_id('order-receipt')).to_have_count(0)
    clean(page, 'order-status-393')
    page.get_by_test_id('order-more').click()
    expect(page.get_by_test_id('order-actions-dialog')).to_be_visible()
    expect(page.get_by_test_id('order-actions-dialog')).to_contain_text('назовите номер заказа')
    clean(page, 'order-help-393')
    page.get_by_test_id('order-actions-close').click()
    page.goto(URL + '/orders')
    expect(page.get_by_test_id('order-history-open-' + HANDED['orderId'])).to_be_visible(timeout=25000)
    settle(page)
    page.get_by_test_id('order-history-open-' + HANDED['orderId']).click()
    expect(page.get_by_test_id('completed-order-close')).to_be_visible(timeout=15000)
    expect(page.get_by_test_id('completed-receipt-unavailable')).to_have_count(0)
    expect(page.get_by_test_id('completed-order-receipt')).to_have_count(0)
    clean(page, 'order-completed-393')
    scroll_end(page, 'scroll-M19')
    clean(page, 'order-completed-end-393')
    # Profile and every row.
    page.goto(URL + '/menu')
    settle(page)
    page.get_by_test_id('header-profile').filter(visible=True).click()
    expect(page.get_by_test_id('screen-M30')).to_be_visible(timeout=15000)
    for gone in ('profile-loyalty', 'profile-combo-reward'):
        expect(page.get_by_test_id(gone)).to_have_count(0)
    for gone in ('Программа Чиков', 'Промокоды', 'Награды и миссии', 'Мои Чики и уровни'):
        expect(page.get_by_test_id('screen-M30').get_by_text(gone, exact=True)).to_have_count(0)
    clean(page, 'profile-393')
    scroll_end(page, 'scroll-M30')
    clean(page, 'profile-end-393')
    # Notifications: one list (no «Для вас» that never receives anything), a neutral empty state.
    page.get_by_test_id('profile-notifications').click()
    expect(page.get_by_test_id('notifications-screen')).to_be_visible(timeout=15000)
    expect(page.get_by_test_id('notifications-tab-personal')).to_have_count(0)
    expect(page.get_by_test_id('notifications-empty-orders')).to_contain_text('Новых сообщений нет')
    clean(page, 'notifications-393')
    # Help: an information card (not a dead button), the restaurant, no message form.
    open_profile(page)
    page.get_by_test_id('profile-help').click()
    expect(page.get_by_test_id('screen-M31')).to_be_visible(timeout=15000)
    expect(page.get_by_test_id('support-restaurant')).to_contain_text('4-й микрорайон, 10Б')
    expect(page.get_by_test_id('screen-M31').get_by_text('Поддержка Pick Chick', exact=True)).to_have_count(0)
    expect(page.get_by_test_id('screen-M31')).not_to_contain_text('данные карты')
    clean(page, 'help-393')
    page.get_by_test_id('support-restaurant').click()
    expect(page.get_by_test_id('screen-M05')).to_be_visible(timeout=15000)
    clean(page, 'help-restaurant-393')
    page.goto(URL + '/screen/M31')
    expect(page.get_by_test_id('screen-M31')).to_be_visible(timeout=20000)
    settle(page)
    # «Неясен результат оплаты?» opens «Заказы» (where each order says whether it is paid), not the
    # payment screen with «Оплатить» right under «do not pay again» (second review 29.10.2026).
    page.get_by_test_id('support-payment-unclear').click()
    expect(page.get_by_test_id('order-history-open-' + PREPARING['orderId'])).to_be_visible(timeout=15000)
    expect(page.get_by_test_id('screen-M14')).to_have_count(0)
    assert urlparse(page.url).path.rstrip('/').endswith('/orders'), page.url
    clean(page, 'help-payment-unclear-393', wait=1500)
    # «Мои заказы» opens the orders tab.
    open_profile(page)
    page.get_by_test_id('profile-orders').click()
    expect(page.get_by_test_id('order-history-open-' + PREPARING['orderId'])).to_be_visible(timeout=15000)
    rows = [
        ('profile-edit', None, 'screen-M04', 'profile-edit-393'),
        (None, 'Мои данные', 'screen-M04', None),
        ('profile-birthday', None, 'screen-M04', None),
        ('profile-settings', None, 'screen-M34', 'settings-393'),
        (None, 'Язык', 'screen-M34', None),
        (None, 'Наши рестораны', 'screen-M05', 'restaurants-393'),
        (None, 'Условия и конфиденциальность', 'screen-M33', 'legal-393'),
        (None, 'Управление данными', 'screen-M32', 'data-393'),
    ]
    for test_id, label, screen, shot in rows:
        open_profile(page)
        if test_id:
            page.get_by_test_id(test_id).click()
        else:
            profile_row(page, label)
        expect(page.get_by_test_id(screen)).to_be_visible(timeout=15000)
        if screen == 'screen-M34':
            # The push service is not connected: no disabled switches, no «ещё не подключён».
            for gone in ('push-orders', 'push-promotions'):
                expect(page.get_by_test_id(gone)).to_have_count(0)
            expect(page.get_by_test_id('language-ru')).to_be_visible()
            # The review notes: Profile > Settings (gear) > «How ordering works».
            expect(page.get_by_test_id('screen-M34').get_by_text('Настройки', exact=True).first).to_be_visible()
            expect(page.get_by_test_id('screen-M34').get_by_text('Как проходит заказ', exact=True)).to_be_visible()
        if screen == 'screen-M04':
            # A way back without saving (review 29.10.2026: only «Готово» before).
            expect(page.get_by_test_id('profile-fill-later')).to_be_visible()
        if screen == 'screen-M33':
            expect(page.get_by_test_id('screen-M33')).not_to_contain_text('запрашивается отдельно')
        if shot:
            clean(page, shot)
        else:
            clean(page, f'row {label or test_id}', wait=300, shot=False)
        if screen == 'screen-M04':
            page.get_by_test_id('profile-fill-later').click()
            expect(page.get_by_test_id('screen-M30')).to_be_visible(timeout=15000)
    # Settings > «Как проходит заказ»: the demonstration, nothing sent.
    page.goto(URL + '/screen/M34')
    settle(page)
    page.get_by_test_id('screen-M34').get_by_text('Как проходит заказ', exact=True).click()
    expect(page.get_by_test_id('demo-start')).to_be_visible(timeout=15000)
    clean(page, 'demo-order-393')
    # Deep links of preview-only screens open the menu in the App Store build.
    for screen in ('M22', 'M23', 'M24', 'M25', 'M35'):
        for query in ('', '?preview=1'):
            page.goto(URL + f'/screen/{screen}{query}')
            expect(page.get_by_test_id('screen-M06').filter(visible=True)).to_be_visible(timeout=20000)
            expect(page.get_by_test_id(f'screen-{screen}')).to_have_count(0)
            assert urlparse(page.url).path.rstrip('/').endswith('/menu'), (screen, query, page.url)
    # The design preview is ignored by this build (second review 29.10.2026: /screen/M25?preview=1
    # showed «СКОРО», «Чиков», «ещё не»): the real screens, no «Закрыть превью».
    for screen in ('M06', 'M26', 'M30'):
        page.goto(URL + f'/screen/{screen}?preview=1')
        expect(page.get_by_test_id(f'screen-{screen}').filter(visible=True)).to_be_visible(timeout=20000)
        expect(page.get_by_test_id('close-design-preview')).to_have_count(0)
        clean(page, f'preview-link-{screen}-393', shot=False)
    ctx.close()


def walk_languages(browser):
    # English (no Cyrillic left, accessible names included) and Kazakh: the same main screens.
    ctx, page = context(browser)
    page.goto(URL + '/menu')
    settle(page)
    add(page)
    for language in ('en', 'kk'):
        english = language == 'en'
        page.goto(URL + '/screen/M34')
        expect(page.get_by_test_id('language-' + language)).to_be_visible(timeout=20000)
        page.get_by_test_id('language-' + language).click()
        expect(page.get_by_test_id('language-' + language)).to_have_attribute('aria-checked', 'true')
        clean(page, f'settings-{language}-393', english=english)
        page.goto(URL + '/menu')
        settle(page)
        expect(page.get_by_test_id('product-pick-combo')).to_be_visible(timeout=25000)
        clean(page, f'menu-{language}-393', english=english)
        page.get_by_test_id('product-pick-combo').click(timeout=25000)
        expect(page.get_by_test_id('product-add')).to_be_visible(timeout=15000)
        clean(page, f'product-{language}-393', english=english)
        # The swap sheets of the combo (drink, sauce): option names and «без доплаты» in the app
        # language, accessible names included (second review 29.10.2026).
        groups = []
        for test_id in page.locator('[data-testid^="photo-replace-"]').evaluate_all(
                '(nodes) => nodes.filter((n) => n.offsetParent).map((n) => n.dataset.testid)'):
            group = test_id.rsplit('-', 1)[0]
            if group not in groups:
                groups.append(group)
                page.get_by_test_id(test_id).click()
                expect(page.get_by_test_id('photo-replacement-dialog')).to_be_visible(timeout=10000)
                clean(page, f'product-swap-{group.removeprefix("photo-replace-")}-{language}-393',
                      english=english)
                page.get_by_test_id('photo-replacement-apply').click()
                expect(page.get_by_test_id('photo-replacement-dialog')).to_have_count(0, timeout=10000)
        assert len(groups) >= 2, groups
        page.goto(URL + '/menu')
        settle(page)
        page.get_by_test_id('open-cart').filter(visible=True).click()
        expect(page.get_by_test_id('screen-M09')).to_be_visible(timeout=15000)
        clean(page, f'cart-{language}-393', english=english)
        payment_selector(page, f'payment-selector-{language}-393', english=english)
        page.get_by_test_id('cart-close').click()
        page.get_by_test_id('tab-events').click()
        expect(page.get_by_test_id('screen-M26')).to_be_visible(timeout=15000)
        clean(page, f'events-{language}-393', english=english)
        page.get_by_test_id('tab-orders').click()
        expect(page.get_by_test_id('order-history-open-' + PREPARING['orderId'])).to_be_visible(timeout=20000)
        clean(page, f'orders-{language}-393', english=english)
        page.get_by_test_id('order-history-open-' + PREPARING['orderId']).click()
        expect(page.get_by_test_id('order-more')).to_be_visible(timeout=15000)
        clean(page, f'order-status-{language}-393', english=english)
        page.goto(URL + '/orders')
        expect(page.get_by_test_id('order-history-open-' + READY['orderId'])).to_be_visible(timeout=25000)
        settle(page)
        page.get_by_test_id('order-history-open-' + READY['orderId']).click()
        expect(page.get_by_test_id('order-more')).to_be_visible(timeout=15000)
        clean(page, f'order-ready-{language}-393', english=english)
        open_profile(page)
        clean(page, f'profile-{language}-393', english=english)
        # The date of birth picker (its field is named in the app language too).
        page.get_by_test_id('profile-birthday').click()
        page.get_by_test_id('birthday-open').filter(visible=True).click(timeout=15000)
        expect(page.get_by_test_id('birthday-picker').filter(visible=True)).to_be_visible(timeout=10000)
        clean(page, f'birthday-picker-{language}-393', english=english)
        page.get_by_test_id('birthday-picker-cancel').filter(visible=True).click()
        # Magic Sort: every bottle reads its colours in the app language («Bottle 5: empty»).
        page.goto(URL + '/games/magic-sort')
        expect(page.get_by_test_id('magic-sort-bottle-0')).to_be_visible(timeout=25000)
        clean(page, f'magic-sort-{language}-393', english=english)
        page.goto(URL + '/notifications')
        expect(page.get_by_test_id('notifications-screen')).to_be_visible(timeout=15000)
        clean(page, f'notifications-{language}-393', english=english)
        page.goto(URL + '/screen/M31')
        expect(page.get_by_test_id('screen-M31')).to_be_visible(timeout=15000)
        clean(page, f'help-{language}-393', english=english)
        page.goto(URL + '/screen/M05')
        expect(page.get_by_test_id('screen-M05')).to_be_visible(timeout=15000)
        clean(page, f'restaurants-{language}-393', english=english)
        page.goto(URL + '/demo-order')
        expect(page.get_by_test_id('demo-start')).to_be_visible(timeout=15000)
        page.get_by_test_id('demo-start').click()
        expect(page.get_by_test_id('demo-approve')).to_be_visible()
        clean(page, f'demo-order-{language}-393', english=english)
        page.get_by_test_id('demo-reset').click()
        expect(page.get_by_test_id('demo-start')).to_be_visible()
    page.goto(URL + '/screen/M34')
    page.get_by_test_id('language-ru').click()
    expect(page.get_by_test_id('language-ru')).to_have_attribute('aria-checked', 'true')
    ctx.close()


def walk_small(browser):
    # 320 x 568: the same screens fit without the hidden blocks leaving gaps or scroll.
    ctx, page = context(browser, 320, 568)
    page.goto(URL + '/menu')
    settle(page)
    expect(page.get_by_test_id('product-pick-combo')).to_be_visible(timeout=25000)
    clean(page, 'menu-320')
    add(page)
    page.get_by_test_id('open-cart').filter(visible=True).click()
    expect(page.get_by_test_id('screen-M09')).to_be_visible(timeout=15000)
    clean(page, 'cart-320')
    payment_selector(page, 'payment-selector-320')
    page.get_by_test_id('cart-close').click()
    page.get_by_test_id('tab-events').click()
    expect(page.get_by_test_id('screen-M26')).to_be_visible(timeout=15000)
    clean(page, 'events-320')
    open_profile(page)
    clean(page, 'profile-320')
    page.goto(URL + '/screen/M34')
    expect(page.get_by_test_id('screen-M34')).to_be_visible(timeout=15000)
    clean(page, 'settings-320')
    ctx.close()


def walk_guest(browser):
    # A guest: no 6 + 1 card in the cart; «События» and the mini-games need no account (5.1.1);
    # the sign-in screen behind the profile icon says nothing about Chiki.
    ctx, page = context(browser, signed_in=False)
    page.goto(URL + '/menu')
    settle(page)
    expect(page.get_by_test_id('product-pick-combo')).to_be_visible(timeout=25000)
    clean(page, 'guest-menu-393')
    add(page)
    page.get_by_test_id('open-cart').filter(visible=True).click()
    expect(page.get_by_test_id('screen-M09')).to_be_visible(timeout=15000)
    expect(page.get_by_test_id('cart-combo-reward')).to_have_count(0)
    clean(page, 'guest-cart-393')
    page.get_by_test_id('cart-close').click()
    expect(page.get_by_test_id('screen-M09')).to_have_count(0, timeout=10000)
    page.get_by_test_id('tab-events').click()
    expect(page.get_by_test_id('screen-M26')).to_be_visible(timeout=15000)
    expect(page.get_by_test_id('auth-welcome')).to_have_count(0)
    expect(page.get_by_test_id('account-required')).to_have_count(0)
    clean(page, 'guest-events-393')
    for card, start, name in (('pick-blocks-open', 'blocks-start', 'pick-blocks'),
                              ('pick-man-open', 'pick-man-start', 'pick-man')):
        page.goto(URL + '/events')
        expect(page.get_by_test_id(card)).to_be_visible(timeout=25000)
        page.get_by_test_id(card).click()
        expect(page.get_by_test_id(start)).to_be_visible(timeout=20000)
        expect(page.get_by_test_id('auth-welcome')).to_have_count(0)
        expect(page.get_by_test_id('account-required')).to_have_count(0)
        clean(page, f'guest-{name}-393')
    page.goto(URL + '/games/pick-blocks')
    expect(page.get_by_test_id('blocks-start')).to_be_visible(timeout=20000)
    page.get_by_test_id('blocks-start').click()
    expect(page.get_by_test_id('blocks-board')).to_be_visible(timeout=15000)
    page.goto(URL + '/games/magic-sort')
    expect(page.get_by_test_id('magic-sort-screen')).to_be_visible(timeout=20000)
    expect(page.get_by_test_id('account-required')).to_have_count(0)
    expect(page.get_by_test_id('auth-welcome')).to_have_count(0)
    clean(page, 'guest-magic-sort-393')
    # The profile icon opens the sign-in: ordering only, no «копить Чики».
    page.goto(URL + '/menu')
    settle(page)
    page.get_by_test_id('header-profile').filter(visible=True).click()
    expect(page.get_by_test_id('auth-welcome')).to_be_visible(timeout=15000)
    expect(page.get_by_test_id('auth-welcome')).to_contain_text('Чтобы оформлять заказы и следить за ними')
    clean(page, 'guest-sign-in-393')
    ctx.close()


def pay_from_cart(page):
    page.goto(URL + '/menu')
    settle(page)
    add(page)
    page.get_by_test_id('open-cart').filter(visible=True).click()
    expect(page.get_by_test_id('screen-M09').get_by_test_id('cart-pay')).to_be_enabled(timeout=15000)
    page.get_by_test_id('screen-M09').get_by_test_id('cart-pay').click()


def walk_payment_step(browser):
    # The App Review account: the server answers 403 FORBIDDEN to POST /orders.
    checkout = {'orders': 'forbidden', 'counts': {'quotes': 0, 'creates': 0, 'payments': 0}, 'held': []}
    ctx, page = context(browser, checkout=checkout)
    pay_from_cart(page)
    expect(page.get_by_test_id('checkout-forbidden')).to_be_visible(timeout=15000)
    expect(page.get_by_test_id('checkout-forbidden')).to_contain_text(
        'Для этого аккаунта оплата заказов выключена. Как проходит заказ - можно посмотреть без оплаты.')
    expect(page.get_by_test_id('kaspi-connecting')).to_have_count(0)
    clean(page, 'payment-forbidden-393')
    page.wait_for_timeout(3000)
    assert checkout['counts'] == {'quotes': 1, 'creates': 1, 'payments': 0}, checkout['counts']
    page.get_by_test_id('checkout-forbidden-demo').click()
    expect(page.get_by_test_id('demo-start')).to_be_visible(timeout=15000)
    clean(page, 'payment-forbidden-demo-393')
    page.get_by_test_id('demo-start').click()
    page.get_by_test_id('demo-approve').click()
    page.get_by_test_id('demo-ready').click()
    page.get_by_test_id('demo-collect').click()
    expect(page.get_by_test_id('review-demo')).to_contain_text('Покупка и чек не создавались')
    clean(page, 'demo-end-393')
    assert checkout['counts'] == {'quotes': 1, 'creates': 1, 'payments': 0}, checkout['counts']
    ctx.close()
    # The restaurant does not answer: POST /orders held; after 20 s it says so, honestly.
    checkout = {'orders': 'hold', 'counts': {'quotes': 0, 'creates': 0, 'payments': 0}, 'held': []}
    ctx, page = context(browser, checkout=checkout)
    pay_from_cart(page)
    expect(page.get_by_test_id('kaspi-connecting')).to_be_visible(timeout=15000)
    clean(page, 'payment-restaurant-393')
    expect(page.get_by_text('Ресторан не подтверждает заказ', exact=True)).to_be_visible(timeout=30000)
    clean(page, 'payment-restaurant-stuck-393')
    assert checkout['counts']['payments'] == 0, checkout['counts']
    for held in checkout['held']:
        try:
            held.abort()
        except Exception:
            pass
    ctx.close()
    # Kaspi answers slowly: the invoice command says «sending»; after 20 s it says so.
    checkout = {'orders': 'ok', 'counts': {'quotes': 0, 'creates': 0, 'payments': 0}, 'held': []}
    ctx, page = context(browser, checkout=checkout)
    pay_from_cart(page)
    expect(page.get_by_text('Kaspi отвечает дольше обычного', exact=True)).to_be_visible(timeout=40000)
    clean(page, 'payment-kaspi-slow-393')
    assert checkout['counts'] == {'quotes': 1, 'creates': 1, 'payments': 1}, checkout['counts']
    for held in checkout['held']:
        try:
            held.abort()
        except Exception:
            pass
    ctx.close()


def walk_delete(browser):
    # Profile > «Управление данными» > «Удалить аккаунт»: confirmation, DELETE, then it says so.
    deleted = []
    ctx, page = context(browser, deleted=deleted)
    page.goto(URL + '/screen/M32')
    expect(page.get_by_test_id('delete-demo-profile')).to_be_enabled(timeout=25000)
    settle(page)
    page.get_by_test_id('delete-demo-profile').click()
    expect(page.get_by_test_id('server-delete-confirmation')).to_be_visible()
    clean(page, 'delete-confirm-393')
    page.get_by_test_id('confirm-server-delete').click()
    expect(page.get_by_test_id('account-deleted')).to_be_visible(timeout=15000)
    expect(page.get_by_test_id('account-deleted')).to_contain_text('Аккаунт удалён')
    clean(page, 'delete-done-393')
    assert deleted == ['/v1/customers/me'], deleted
    ctx.close()


def type_phone(page, keys):
    field = page.get_by_test_id('phone-input').filter(visible=True)
    field.fill('')
    field.click()
    field.press_sequentially(keys, delay=40)
    page.wait_for_timeout(300)
    return field.input_value()


def walk_sign_in(browser):
    # The App Review sign-in in English (second review 29.10.2026). The number of the review
    # account typed key by key with its country code used to stop at «770 000 00 00»: ten digits
    # starting with 7 looked complete, the keyboard closed and the last key never arrived, so the
    # code went to another number. Then the optional «Let's get to know you» form, left empty.
    auth = {'calls': [], 'customer': None}
    ctx, page = context(browser, signed_in=False, auth=auth)
    page.goto(URL + '/screen/M34')
    page.get_by_test_id('language-en').click(timeout=25000)
    expect(page.get_by_test_id('language-en')).to_have_attribute('aria-checked', 'true')
    page.goto(URL + '/menu')
    settle(page)
    page.get_by_test_id('header-profile').filter(visible=True).click()
    expect(page.get_by_test_id('auth-welcome')).to_be_visible(timeout=15000)
    clean(page, 'sign-in-welcome-en-393', english=True)
    page.get_by_test_id('account-required-login').filter(visible=True).click()
    expect(page.get_by_test_id('phone-input').filter(visible=True)).to_be_editable(timeout=15000)
    local = customer['phone'][2:]
    shown = f'{local[:3]} {local[3:6]} {local[6:8]} {local[8:]}'
    for typed in ('+7' + local, '7' + local, '8' + local, local):
        assert type_phone(page, typed) == shown, (typed, page.get_by_test_id('phone-input').input_value())
    expect(page.get_by_test_id('request-otp').filter(visible=True)).to_be_enabled()
    type_phone(page, '+7' + local)
    clean(page, 'sign-in-phone-en-393', english=True)
    page.get_by_test_id('request-otp').filter(visible=True).click()
    expect(page.get_by_test_id('otp-input').filter(visible=True)).to_be_editable(timeout=15000)
    assert auth['calls'] == [('request', customer['phone'])], auth['calls']
    clean(page, 'sign-in-code-en-393', english=True)
    page.get_by_test_id('otp-input').filter(visible=True).fill('9381')
    # «Let's get to know you»: everything is optional; «Done» with every field empty.
    expect(page.get_by_test_id('nickname-save').filter(visible=True)).to_be_enabled(timeout=15000)
    expect(page.get_by_test_id('nickname-input').filter(visible=True)).to_have_value('')
    clean(page, 'sign-in-profile-form-en-393', english=True)
    page.get_by_test_id('nickname-save').filter(visible=True).click()
    expect(page.get_by_test_id('screen-M30').filter(visible=True)).to_be_visible(timeout=15000)
    assert [call[0] for call in auth['calls']] == ['request', 'verify', 'patch'], auth['calls']
    assert auth['calls'][2][1]['nickname'] == '', auth['calls']
    identity = page.get_by_test_id('profile-identity')
    expect(identity).to_contain_text('Crunch lover', timeout=15000)
    expect(identity).not_to_contain_text('Любитель хруста')
    clean(page, 'sign-in-profile-en-393', english=True)
    # Kazakh: its own default name, not the Russian one.
    page.goto(URL + '/screen/M34')
    page.get_by_test_id('language-kk').click(timeout=25000)
    open_profile(page)
    expect(page.get_by_test_id('profile-identity')).to_contain_text('Қытырлақты жақсы көретін жан')
    expect(page.get_by_test_id('profile-identity')).not_to_contain_text('Любитель хруста')
    clean(page, 'sign-in-profile-kk-393')
    page.goto(URL + '/screen/M34')
    page.get_by_test_id('language-ru').click(timeout=25000)
    expect(page.get_by_test_id('language-ru')).to_have_attribute('aria-checked', 'true')
    ctx.close()


PARTS = {'signed_in': walk_signed_in, 'languages': walk_languages, 'small': walk_small,
         'guest': walk_guest, 'payment_step': walk_payment_step, 'delete': walk_delete,
         'sign_in': walk_sign_in}
with sync_playwright() as p:
    browser = p.chromium.launch()
    for part, walk in PARTS.items():
        if not ONLY or part in ONLY:
            walk(browser)
    browser.close()
assert not ONLY and not REPORT, 'a partial or report-only run is not a pass'
assert not mutations, mutations
assert not errors, errors
if STOREFRONT:
    # The App Store profile has no test-order client at all.
    assert not test_requests, test_requests
print(f'PASS App Store walk ({PROFILE}): {len(walked)} screens without «скоро» / «ещё не» / «not yet» / '
      f'Chiki / «Без фото» / Apple Pay / Google Pay / card (RU, EN without Cyrillic, KK; 393x852, 320x568, '
      f'guest with games), payment step (FORBIDDEN + demo, restaurant and Kaspi stuck states), account deletion, '
      f'preview-only deep links open the menu and ?preview=1 is ignored, the App Review sign-in in EN '
      f'(+7 / 7 / 8 typed, empty profile form, «Crunch lover»), no other mutation; screenshots in {OUT}')
