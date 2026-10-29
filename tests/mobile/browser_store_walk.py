"""App Store walk (owner 29.10.2026, «устрани это все»; App Review Guideline 2.1).

The Kaspi customer build is what goes to the App Store. This walk opens every customer screen of
that build and asserts that no visible text, accessible name or icon announces a feature that does
not work yet («скоро», «подключается», «появится позже», «в процессе подключения», «coming soon»)
and that no Apple Pay / Google Pay / bank card is offered (no name, no row, no Apple/Google logo):
  menu (top, end, product page, cart bar), cart (+ end) and «Способ оплаты», «События», «Заказы»,
  order status and its help sheet, a completed order, the profile and every row (notifications
  with both tabs, help, profile edit, language and notifications settings, restaurants, documents,
  data management), the deep links of preview-only screens (M22-M25, M35 open the menu), the same
  main screens in English and Kazakh, a guest (menu, cart, sign-in) and the 320 pt screen.
The server answers like production on 29.10.2026: the 6 + 1 programme is switched off
(/combo-rewards {enabled: false}), push is not connected, receipts are deferred.

Runs against the customer-auth web export (EXPO_PUBLIC_CUSTOMER_AUTH=server,
EXPO_PUBLIC_KASPI_CHECKOUT=1, EXPO_PUBLIC_UNPAID_TEST_ORDERS=1, EXPO_PUBLIC_PUBLISHED_CATALOG=0)
with local fixtures only: no bank, no real customer, no VPS request, no mutation.
Screenshots: STORE_WALK_OUT (default .local/mobile-1029/store).
"""
from browser_network import isolated_context, route_fixture
import json, os, re, subprocess, uuid
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('CUSTOMER_AUTH_URL', 'http://127.0.0.1:4196').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost'), 'Use a local exported app'
OUT = ROOT / os.environ.get('STORE_WALK_OUT', '.local/mobile-1029/store')
OUT.mkdir(parents=True, exist_ok=True)
CAT = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
    "import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js';console.log(JSON.stringify(testCompleteCatalog))"],
    cwd=ROOT, text=True))
BRANCH = CAT['branch_id']
PRICES = {p['id']: (p['name'], int(p['price_minor'])) for p in CAT['products']}
MESSAGES = {m['ru']: m for m in json.loads((ROOT / 'apps/mobile/src/i18n/messages.json').read_text())}
GLYPHS = json.loads((ROOT / 'apps/mobile/node_modules/@expo/vector-icons/build/vendor/'
                     'react-native-vector-icons/glyphmaps/Ionicons.json').read_text())
# The Apple / Google marks the payment rows used: none may be drawn anywhere.
LOGOS = {name: chr(GLYPHS[name]) for name in ('logo-apple', 'logo-google', 'logo-apple-appstore')}

# Same wordings as tests/mobile/store-copy.test.mjs (RU, KK, EN).
FORBIDDEN = [re.compile(pattern, re.I) for pattern in [
    r'скоро', r'подключа', r'не подключ[её]н', r'после подключения', r'в процессе подключения',
    r'оплата в процессе', r'появится позже', r'появятся позже', r'загляни позже',
    r'пока не (выпускается|начисляются|даёт|активн)', r'ещё не (активирован|активен)',
    r'пробн(ый|ые|ого|ых|ом|ая)', r'предварительн', r'готовим программу', r'готовятся',
    r'на подготовке', r'apple ?pay', r'google ?pay', r'coming soon', r'being set up',
    r'being connected', r'not connected yet', r'\bsoon\b', r'жақында(?![а-яёәіңғүұқөһ])',
    r'қосылып жатыр', r'әлі қосылмаған', r'іске қосылмаған', r'банковская карта', r'bank card',
]]
# A real farewell, not a feature: «Будем ждать снова!» reads «See you again soon!» in English.
FAREWELL = MESSAGES['Спасибо, что выбрали PickChick. Будем ждать снова!']
ALLOWED_VISIBLE = [FAREWELL['ru'], FAREWELL['kk'], FAREWELL['en']]
WALLET_IDS = ['apple_pay', 'google_pay', 'card']

CUSTOMER = '40000000-0000-4000-8000-000000000001'
customer = {'id': CUSTOMER, 'phone': '+77000000000', 'nickname': 'UI test', 'birth_date': None,
            'gender': None, 'profile_completed_at': None, 'created_at': '2026-09-07T10:00:00.000Z'}
envelope = {'version': 1, 'device_id': '40000000-0000-4000-8000-000000000004',
            'tokens': {'access_token': 'a' * 64, 'refresh_token': 'b' * 64,
                       'access_expires_at': '2099-01-01T00:00:00.000Z',
                       'session_id': '40000000-0000-4000-8000-000000000002', 'customer': customer},
            'challenge': None, 'otp_request': None, 'verify_intent': None,
            'refresh_request_id': None, 'closing': None}


def uid(seed):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'pickchick-store-walk/' + seed))


def commerce_order(number, phase, created, entries, stage=None):
    return {'orderId': uid('order' + number), 'revision': uuid.uuid5(uuid.NAMESPACE_URL, created).hex * 2,
            'restaurant': 'ТЦ Abay Plaza', 'branchId': BRANCH, 'createdAt': created, 'updatedAt': created,
            'kitchenStage': stage, 'displayNumber': number,
            'totalMinor': str(sum(PRICES[p][1] * q for p, q in entries)), 'serviceMode': 'takeaway',
            'kitchenComment': None, 'phase': phase, 'expiresAt': None,
            # Every app order today: fiscalPolicy deferred_pilot, no receipt.
            'receipt': 'deferred', 'receiptUrl': None,
            'items': [{'productId': p, 'title': PRICES[p][0], 'quantity': q,
                       'totalMinor': str(PRICES[p][1] * q), 'modifiers': []} for p, q in entries]}


PREPARING = commerce_order('14', 'preparing', '2026-10-29T06:50:00.000Z', [('finger-duo', 1), ('sauce', 1)], 'cooking')
HANDED = commerce_order('12', 'handed_over', '2026-10-28T12:32:00.000Z', [('pick-combo', 1)])
ORDERS = [PREPARING, HANDED]
errors, mutations, walked = [], [], []

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


def route_for(signed_in=True):
    def intercept(route):
        path = urlparse(route.request.url).path
        method = route.request.method
        if method not in ('GET', 'OPTIONS'):
            # The walk only looks: no quote, order, payment, feedback or profile write. (This export
            # also has the synthetic test-order client, whose session request is refused here.)
            if not path.startswith('/v1/test/'):
                mutations.append(f'{method} {path}')
            route.abort()
            return
        if path.endswith('/watch'):
            route.abort()
            return
        data = None
        if path == '/v1/customers/me' and signed_in:
            data = {'customer': customer, 'legal': {'version': 'fixture-v1', 'terms_url': 'https://example.test/terms',
                                                    'privacy_url': 'https://example.test/privacy', 'accepted': True}}
        elif path == '/v1/customer-checkout/availability':
            data = {'enabled': True, 'fresh': True, 'signature': 'a' * 64,
                    'products': [{'id': p['id'], 'available': True, 'stoppedOptions': []} for p in CAT['products']]}
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
            data = {'schema_version': 1, 'branch_id': BRANCH, 'release_id': uid('release'), 'version': 1,
                    'published_at': '2026-09-07T00:00:00Z', 'items': []}
        elif path == '/v1/test/catalog':
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
            data = {'orders': ORDERS}
        elif path == '/v1/customer-checkout/feedback':
            data = {'feedback': []}
        elif path.startswith('/v1/customer-checkout/orders/') and path.endswith('/feedback'):
            data = {'orderId': path.split('/')[4], 'enabled': True, 'preparationStartedAt': None,
                    'readyAt': None, 'feedback': None}
        elif path.startswith('/v1/customer-checkout/orders/'):
            data = next((o for o in ORDERS if o['orderId'] == path.split('/')[4]), None)
        if data is None:
            route.abort()
            return
        route.fulfill(json=data, headers={'Access-Control-Allow-Origin': '*'})
    return intercept


def context(browser, width=393, height=852, signed_in=True):
    ctx = isolated_context(browser, viewport={'width': width, 'height': height}, device_scale_factor=2,
                           reduced_motion='reduce')
    if signed_in:
        ctx.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",'
                            + json.dumps(json.dumps(envelope)) + ');')
    # Default notification fixture: the push service is not connected (enabled false).
    route_fixture(ctx, '**/v1/**', route_for(signed_in))
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    return ctx, page


def settle(page):
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=25000)


def clean(page, name, wait=600, shot=True):
    """No forbidden word, no wallet row or mark on the visible screen; then a screenshot."""
    page.wait_for_timeout(wait)
    text = page.evaluate(COLLECT)
    for allowed in ALLOWED_VISIBLE:
        text = text.replace(allowed, '')
    hits = []
    for pattern in FORBIDDEN:
        match = pattern.search(text)
        if match:
            hits.append(text[max(0, match.start() - 60):match.end() + 60].replace('\n', ' / '))
    assert not hits, (name, hits)
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


def add(page, product='pick-combo', shot=None):
    page.get_by_test_id('product-' + product).click(timeout=25000)
    expect(page.get_by_test_id('product-add')).to_be_visible(timeout=15000)
    if shot:
        clean(page, shot)
    page.get_by_test_id('product-add').click()
    expect(page.get_by_test_id('cart-shortcut').filter(visible=True)).to_be_visible(timeout=15000)


def open_profile(page):
    page.goto(URL + '/profile')
    expect(page.get_by_test_id('screen-M30')).to_be_visible(timeout=25000)
    settle(page)


def profile_row(page, label):
    page.get_by_test_id('screen-M30').get_by_text(label, exact=True).click()


def payment_selector(page, name):
    page.get_by_test_id('cart-payment-method').click()
    sheet = page.get_by_test_id('cart-payment-sheet')
    expect(sheet).to_be_visible()
    # Kaspi.kz only: one radio, checked.
    expect(sheet.get_by_role('radio')).to_have_count(1)
    expect(page.get_by_test_id('cart-payment-kaspi')).to_have_attribute('aria-checked', 'true')
    clean(page, name)
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
    # «Заказы»: list, an order in preparation and its help sheet, a completed order.
    page.get_by_test_id('tab-orders').click()
    expect(page.get_by_test_id('order-history-open-' + PREPARING['orderId'])).to_be_visible(timeout=20000)
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
    # Notifications: both tabs.
    page.get_by_test_id('profile-notifications').click()
    expect(page.get_by_test_id('notifications-screen')).to_be_visible(timeout=15000)
    clean(page, 'notifications-orders-393')
    page.get_by_test_id('notifications-tab-personal').click()
    expect(page.get_by_test_id('notifications-empty-personal')).to_be_visible()
    clean(page, 'notifications-personal-393')
    # Help: the restaurant itself is the contact, no message form.
    open_profile(page)
    page.get_by_test_id('profile-help').click()
    expect(page.get_by_test_id('screen-M31')).to_be_visible(timeout=15000)
    expect(page.get_by_test_id('support-restaurant')).to_contain_text('4-й микрорайон, 10Б')
    clean(page, 'help-393')
    page.get_by_test_id('support-restaurant').click()
    expect(page.get_by_test_id('screen-M05')).to_be_visible(timeout=15000)
    clean(page, 'help-restaurant-393')
    page.goto(URL + '/screen/M31')
    expect(page.get_by_test_id('screen-M31')).to_be_visible(timeout=20000)
    settle(page)
    page.get_by_test_id('screen-M31').get_by_text('Неясен результат оплаты?', exact=True).click()
    expect(page.get_by_test_id('screen-M14')).to_be_visible(timeout=15000)
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
        if shot:
            clean(page, shot)
        else:
            clean(page, f'row {label or test_id}', wait=300, shot=False)
    # Deep links of preview-only screens open the menu in the App Store build.
    for screen in ('M22', 'M23', 'M24', 'M25', 'M35'):
        page.goto(URL + f'/screen/{screen}')
        expect(page.get_by_test_id('screen-M06').filter(visible=True)).to_be_visible(timeout=20000)
        expect(page.get_by_test_id(f'screen-{screen}')).to_have_count(0)
        assert urlparse(page.url).path.rstrip('/').endswith('/menu'), (screen, page.url)
    # English and Kazakh: the same main screens.
    for language in ('en', 'kk'):
        page.goto(URL + '/screen/M34')
        expect(page.get_by_test_id('language-' + language)).to_be_visible(timeout=20000)
        page.get_by_test_id('language-' + language).click()
        expect(page.get_by_test_id('language-' + language)).to_have_attribute('aria-checked', 'true')
        clean(page, f'settings-{language}-393')
        page.goto(URL + '/menu')
        settle(page)
        expect(page.get_by_test_id('product-pick-combo')).to_be_visible(timeout=25000)
        clean(page, f'menu-{language}-393')
        page.get_by_test_id('open-cart').filter(visible=True).click()
        expect(page.get_by_test_id('screen-M09')).to_be_visible(timeout=15000)
        clean(page, f'cart-{language}-393')
        payment_selector(page, f'payment-selector-{language}-393')
        page.get_by_test_id('cart-close').click()
        page.get_by_test_id('tab-events').click()
        expect(page.get_by_test_id('screen-M26')).to_be_visible(timeout=15000)
        clean(page, f'events-{language}-393')
        page.get_by_test_id('tab-orders').click()
        expect(page.get_by_test_id('order-history-open-' + PREPARING['orderId'])).to_be_visible(timeout=20000)
        clean(page, f'orders-{language}-393')
        open_profile(page)
        clean(page, f'profile-{language}-393')
        page.goto(URL + '/notifications')
        expect(page.get_by_test_id('notifications-screen')).to_be_visible(timeout=15000)
        page.get_by_test_id('notifications-tab-personal').click()
        clean(page, f'notifications-{language}-393')
        page.goto(URL + '/screen/M31')
        expect(page.get_by_test_id('screen-M31')).to_be_visible(timeout=15000)
        clean(page, f'help-{language}-393')
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
    # A guest: no 6 + 1 card in the cart; the sign-in screen is clean.
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
    # «События» and the profile ask a guest to sign in first: that screen is clean too.
    page.get_by_test_id('tab-events').click()
    expect(page.get_by_test_id('auth-welcome')).to_be_visible(timeout=15000)
    clean(page, 'guest-sign-in-393')
    ctx.close()


with sync_playwright() as p:
    browser = p.chromium.launch()
    walk_signed_in(browser)
    walk_small(browser)
    walk_guest(browser)
    browser.close()
assert not mutations, mutations
assert not errors, errors
print(f'PASS App Store walk: {len(walked)} screens without «скоро» / «подключается» / Apple Pay / '
      f'Google Pay / card (RU, EN, KK; 393x852, 320x568, guest), preview-only deep links open the menu, '
      f'no mutation; screenshots in {OUT}')
