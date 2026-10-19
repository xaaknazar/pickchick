"""Audit 19.10 (0.2/2.0, 2.1, 2.4, 2.5): the Kaspi checkout never traps the customer.

Runs against the customer-auth web export (EXPO_PUBLIC_CUSTOMER_AUTH=server,
EXPO_PUBLIC_KASPI_CHECKOUT=1, EXPO_PUBLIC_PUBLISHED_CATALOG=0) with local fixtures only:
no bank, no real customer, no VPS request.
  A  saved payment intent + order in 'attention': shown once with a close action and a
     support contact, the intent is cleared, the next start does not reopen checkout.
  B  /payment refused with ITEM_STOPPED: back to the cart with the reason, no automatic
     resend, no reopen after restart, the next tap quotes the current cart.
  C  Orders tab: an attention order and an unpaid order both lead back to the list.
  D  kitchen offline at the quote: the honest message at once, no minute of spinner.
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
OUT = ROOT / '.local/checkout-traps'
OUT.mkdir(parents=True, exist_ok=True)
CATALOG = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
    "import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js'; console.log(JSON.stringify(testCompleteCatalog))"],
    cwd=ROOT, text=True))
BRANCH = CATALOG['branch_id']
CUSTOMER = '40000000-0000-4000-8000-000000000001'
ORDER = '40000000-0000-4000-8000-000000000003'
UNPAID = '40000000-0000-4000-8000-000000000013'
DRAFT_KEY = 'pickchick.commerce.pending.v1:' + CUSTOMER
TRACE = '40000000-0000-4000-8000-000000000009'
ACCEPT_V2 = 'application/json; profile=pickchick.checkout-errors-v2'
future = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat().replace('+00:00', 'Z')
recent = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat().replace('+00:00', 'Z')
customer = {'id': CUSTOMER, 'phone': '+77000000000', 'nickname': 'UI test', 'birth_date': None,
            'gender': None, 'profile_completed_at': None, 'created_at': '2026-09-07T10:00:00.000Z'}
envelope = {'version': 1, 'device_id': '40000000-0000-4000-8000-000000000004',
            'tokens': {'access_token': 'a' * 64, 'refresh_token': 'b' * 64, 'access_expires_at': future,
                       'session_id': '40000000-0000-4000-8000-000000000002', 'customer': customer},
            'challenge': None, 'otp_request': None, 'verify_intent': None, 'refresh_request_id': None,
            'closing': None}
errors = []


def order(phase, order_id=ORDER, revision=1):
    return {'orderId': order_id, 'revision': hex(revision)[2:].zfill(64), 'restaurant': 'ТЦ Abay Plaza',
            'branchId': BRANCH, 'createdAt': recent, 'updatedAt': recent, 'kitchenStage': None,
            'displayNumber': None, 'totalMinor': '419000', 'serviceMode': 'takeaway', 'kitchenComment': None,
            'phase': phase, 'expiresAt': None, 'receipt': 'deferred', 'receiptUrl': None,
            'items': [{'productId': 'pick-combo', 'title': 'Pick Combo', 'quantity': 1, 'totalMinor': '419000',
                       'modifiers': []}]}


def refusal(route, status, code, retryable=False):
    route.fulfill(status=status, json={'code': code, 'message_key': 'errors.' + code.lower(),
                                       'trace_id': TRACE, 'retryable': retryable},
                  headers={'Access-Control-Allow-Origin': '*'})


def context(browser, state, handler, draft=None, width=393, height=852):
    ctx = isolated_context(browser, viewport={'width': width, 'height': height}, reduced_motion='reduce')
    ctx.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",' + json.dumps(json.dumps(envelope)) + ');')
    if draft:
        # Written once, as a previous app run would have left it.
        ctx.add_init_script("""(() => {
          if (!sessionStorage.getItem('pickchick.test.draft-seeded')) {
            localStorage.setItem(%s, %s);
            sessionStorage.setItem('pickchick.test.draft-seeded', '1');
          }
        })();""" % (json.dumps(DRAFT_KEY), json.dumps(json.dumps(draft))))

    def route(r):
        path = urlparse(r.request.url).path
        method = r.request.method
        body = r.request.post_data_json if r.request.post_data else None
        if path.startswith('/v1/customer-checkout/') and not path.endswith('/availability') \
                and not path.endswith('/feedback'):
            assert ACCEPT_V2 in (r.request.headers.get('accept') or ''), r.request.headers.get('accept')
        if path.endswith('/watch'):
            state['held'].append(r)
            return
        data = None
        if path == '/v1/customers/me':
            data = {'customer': customer}
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
        else:
            if method != 'GET' and path.endswith('/payment'):
                state['payments'] += 1
            if method == 'POST' and path == '/v1/customer-checkout/quotes':
                state['quotes'] += 1
            if method == 'POST' and path == '/v1/customer-checkout/orders':
                state['creates'] += 1
            if handler(r, path, method, body):
                return
            r.abort()
            return
        r.fulfill(json=data, headers={'Access-Control-Allow-Origin': '*'})

    route_fixture(ctx, '**/v1/**', route)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    return ctx, page


def fresh_state():
    return {'held': [], 'payments': 0, 'quotes': 0, 'creates': 0}


def fulfill(r, data):
    r.fulfill(json=data, headers={'Access-Control-Allow-Origin': '*'})
    return True


def draft_saved(page):
    return page.evaluate('(key) => localStorage.getItem(key)', DRAFT_KEY)


def open_checkout(page):
    page.goto(URL + '/menu')
    page.get_by_test_id('product-pick-combo').click(timeout=25000)
    page.get_by_test_id('product-add').click()
    page.get_by_test_id('open-cart').click()
    page.get_by_test_id('cart-checkout').click()
    button = page.get_by_test_id('kaspi-checkout-submit')
    expect(button).to_be_enabled(timeout=15000)
    return button


def release(state):
    for held in state['held']:
        try:
            held.abort()
        except Exception:
            pass


def scenario_attention(browser, width, height):
    state = fresh_state()

    def handler(r, path, method, body):
        if path == f'/v1/customer-checkout/orders/{ORDER}' and method == 'GET':
            return fulfill(r, order('attention'))
        if path == '/v1/customer-checkout/orders' and method == 'GET':
            return fulfill(r, {'orders': [order('attention')]})
        return False

    # A draft written by build 20: no time, auto-send consent, known order.
    draft = {'key': '40000000-0000-4000-8000-000000000005', 'quoteId': '40000000-0000-4000-8000-000000000006',
             'signature': '{"items":[]}', 'orderId': ORDER, 'sendInvoice': True}
    ctx, page = context(browser, state, handler, draft, width, height)
    page.goto(URL + '/menu')
    waiting = page.get_by_test_id('kaspi-waiting')
    expect(waiting).to_contain_text('Проверяем заказ', timeout=25000)
    assert page.url.endswith('/checkout'), page.url
    expect(waiting).to_contain_text('Новый заказ можно сделать сразу')
    expect(page.get_by_test_id('support-contact-fallback')).to_be_visible()
    close = page.get_by_test_id('kaspi-close-order')
    expect(close).to_be_visible()
    box = close.bounding_box()
    assert box and box['height'] >= 44 and box['y'] + box['height'] <= height + 1, box
    assert draft_saved(page) is None, 'attention is final: the saved intent is removed'
    page.screenshot(path=str(OUT / f'A-attention-{width}.png'))
    close.click()
    expect(page.get_by_test_id('kaspi-waiting')).to_have_count(0, timeout=10000)
    assert not page.url.endswith('/checkout'), page.url
    # Next start: nothing reopens checkout.
    page.goto(URL + '/menu')
    expect(page.get_by_test_id('product-pick-combo')).to_be_visible(timeout=25000)
    page.wait_for_timeout(2500)
    assert not page.url.endswith('/checkout'), page.url
    assert state['payments'] == 0 and state['creates'] == 0, state
    release(state)
    ctx.close()


def scenario_item_stopped(browser):
    state = fresh_state()
    state['stopped_quote'] = False

    def handler(r, path, method, body):
        if path == '/v1/customer-checkout/quotes' and method == 'POST':
            if state['stopped_quote']:
                refusal(r, 409, 'ITEM_STOPPED')
                return True
            return fulfill(r, {'quoteId': '40000000-0000-4000-8000-000000000015', 'totalMinor': '419000',
                               'expiresAt': future, 'serviceMode': body['serviceMode'], 'kitchenComment': None})
        if path == '/v1/customer-checkout/orders' and method == 'POST':
            return fulfill(r, order('ready_to_pay'))
        if path == f'/v1/customer-checkout/orders/{ORDER}' and method == 'GET':
            return fulfill(r, order('ready_to_pay'))
        if path == '/v1/customer-checkout/orders' and method == 'GET':
            # An older server keeps the refused order as ready_to_pay.
            return fulfill(r, {'orders': [order('ready_to_pay')] if state['creates'] else []})
        if path == f'/v1/customer-checkout/orders/{ORDER}/payment':
            refusal(r, 409, 'ITEM_STOPPED')
            return True
        return False

    ctx, page = context(browser, state, handler)
    button = open_checkout(page)
    button.click()
    expect(page.get_by_text('Блюдо или выбранный вариант закончились', exact=False)).to_be_visible(timeout=15000)
    expect(button).to_be_enabled()
    assert state['payments'] == 1 and state['creates'] == 1, state
    assert draft_saved(page) is None, 'a refused order drops its intent'
    page.screenshot(path=str(OUT / 'B-item-stopped.png'))
    page.wait_for_timeout(2500)
    assert state['payments'] == 1, 'no automatic resend'
    # Restart: no reopen, no resend.
    page.goto(URL + '/menu')
    expect(page.get_by_test_id('product-pick-combo')).to_be_visible(timeout=25000)
    page.wait_for_timeout(2500)
    assert not page.url.endswith('/checkout') and state['payments'] == 1, (page.url, state)
    # The next tap quotes the current cart instead of resuming the old unbilled order.
    state['stopped_quote'] = True
    page.get_by_test_id('open-cart').click()
    page.get_by_test_id('cart-checkout').click()
    button = page.get_by_test_id('kaspi-checkout-submit')
    expect(button).to_be_enabled(timeout=15000)
    button.click()
    expect(page.get_by_text('Блюдо или выбранный вариант закончились', exact=False)).to_be_visible(timeout=15000)
    assert state['quotes'] == 2 and state['creates'] == 1 and state['payments'] == 1, state
    release(state)
    ctx.close()


def scenario_orders(browser):
    state = fresh_state()

    def handler(r, path, method, body):
        if path == '/v1/customer-checkout/orders' and method == 'GET':
            return fulfill(r, {'orders': [order('ready_to_pay', UNPAID), order('attention')]})
        return False

    ctx, page = context(browser, state, handler)
    page.goto(URL + '/orders')
    expect(page.get_by_test_id('order-history-open-' + ORDER)).to_be_visible(timeout=25000)
    page.get_by_test_id('order-history-open-' + ORDER).click()
    expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Проверяем заказ', timeout=10000)
    back = page.get_by_test_id('kaspi-close-order')
    expect(back).to_have_text('К списку заказов')
    page.screenshot(path=str(OUT / 'C-attention.png'))
    back.click()
    expect(page.get_by_test_id('order-history-open-' + ORDER)).to_be_visible(timeout=10000)
    page.get_by_test_id('order-history-pay-' + UNPAID).click()
    expect(page.get_by_role('button', name='Отправить счёт на', exact=False)).to_be_visible(timeout=10000)
    page.get_by_test_id('kaspi-close-order').click()
    expect(page.get_by_test_id('order-history-open-' + UNPAID)).to_be_visible(timeout=10000)
    assert state['payments'] == 0, 'returning to the list sends nothing'
    release(state)
    ctx.close()


def scenario_kitchen_offline(browser):
    state = fresh_state()

    def handler(r, path, method, body):
        if path == '/v1/customer-checkout/orders' and method == 'GET':
            return fulfill(r, {'orders': []})
        if path == '/v1/customer-checkout/quotes' and method == 'POST':
            refusal(r, 503, 'KITCHEN_OFFLINE', True)
            return True
        return False

    ctx, page = context(browser, state, handler)
    button = open_checkout(page)
    button.click()
    expect(page.get_by_text('Кухня сейчас не на связи - заказ оформить нельзя', exact=False)).to_be_visible(timeout=6000)
    expect(page.get_by_role('button', name='Проверить оплату', exact=True)).to_have_count(0)
    page.wait_for_timeout(2500)
    assert state['quotes'] == 1 and state['creates'] == 0 and state['payments'] == 0, state
    page.screenshot(path=str(OUT / 'D-kitchen-offline.png'))
    release(state)
    ctx.close()


with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in [(393, 852), (320, 568)]:
        scenario_attention(browser, width, height)
    scenario_item_stopped(browser)
    scenario_orders(browser)
    scenario_kitchen_offline(browser)
    browser.close()
assert not errors, errors
print('PASS checkout traps: attention intent closes and stays closed, refused payment returns to the cart '
      'without resend, Orders tab returns to the list, kitchen offline is reported at once')
