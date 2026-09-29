"""Kaspi invoice checkout UI against local fixtures. No bank, SMS, VPS or real account calls.

Build: EXPO_PUBLIC_CUSTOMER_AUTH=server EXPO_PUBLIC_KASPI_CHECKOUT=1 expo export --platform web.
The fixture server scripts the ledger stages; the app must only display them.
"""
import json
import os
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('KASPI_CHECKOUT_URL', 'http://127.0.0.1:4197').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost')
OUT = ROOT / '.local/kaspi-checkout'
OUT.mkdir(parents=True, exist_ok=True)
CATALOG = json.loads(subprocess.run(
    ['node', '--input-type=module', '-e',
     "import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js';"
     " console.log(JSON.stringify(testCompleteCatalog))"],
    cwd=ROOT, capture_output=True, text=True, check=True).stdout)
BRANCH = CATALOG['branch_id']
ORDER = '50000000-0000-4000-8000-000000000001'
NOW = datetime.now(timezone.utc)
CUSTOMER = {'id': '40000000-0000-4000-8000-000000000001', 'phone': '+77011234567',
            'nickname': 'Гость', 'birth_date': None, 'gender': None,
            'profile_completed_at': NOW.isoformat(), 'created_at': '2026-09-07T10:00:00.000Z'}
SESSION = {'version': 1, 'device_id': '40000000-0000-4000-8000-000000000009',
           'tokens': {'access_token': 'a' * 64, 'refresh_token': 'b' * 64,
                      'access_expires_at': (NOW + timedelta(hours=2)).isoformat(),
                      'session_id': '40000000-0000-4000-8000-000000000002', 'customer': CUSTOMER},
           'challenge': None, 'otp_request': None, 'verify_intent': None,
           'refresh_request_id': None, 'closing': None}
READS = {
    '/v1/capabilities': {'schema_version': 1, 'environment': 'staging', 'data_mode': 'pilot',
                         'ordering_enabled': False,
                         'features': {'test_order_flow': True, 'phone_auth': True,
                                      **{k: False for k in ['payments', 'fiscal', 'checkout', 'loyalty']}}},
    '/v1/branches': {'branches': [{'id': BRANCH, 'code': 'TEST', 'name': 'ТЦ Abay Plaza',
                                   'timezone': 'Asia/Almaty', 'ordering_enabled': False}]},
    '/v1/branches/' + BRANCH + '/menu': {'schema_version': 1, 'branch_id': BRANCH,
                                         'release_id': '10000000-0000-4000-8000-000000000008',
                                         'version': 1, 'published_at': '2026-09-07T00:00:00Z', 'items': []},
    '/v1/test/catalog': CATALOG,
    '/v1/content/branches/' + BRANCH: {'schema_version': 1, 'branch_id': BRANCH, 'promos': [], 'games': []},
    '/v1/auth/config': {'enabled': True, 'delivery_consent_required': True, 'consent_version': 'fixture-v1',
                        'terms_url': 'https://example.test/terms', 'privacy_url': 'https://example.test/privacy'},
    '/v1/customers/me': {'customer': CUSTOMER},
}
# Each read advances the scripted ledger by one fact, as the worker would.
SCRIPT = ['accepting', 'ready_to_pay', 'sending_invoice', 'invoice_sent', 'invoice_sent', 'paid']


def view(stage):
    return {'order_id': ORDER, 'stage': stage, 'total_minor': '419000', 'service_mode': 'takeaway',
            'lines': [{'title': 'Pick Combo', 'quantity': 1, 'total_minor': '419000'}],
            'invoice': ({'expires_at': (NOW + timedelta(minutes=10)).isoformat(), 'closed_reason': None}
                        if stage == 'invoice_sent' else None),
            'can_retry': False, 'kitchen_queued': False}


with sync_playwright() as p:
    browser = p.chromium.launch()
    results = {}
    for width, height in [(320, 568), (390, 844)]:
        state = {'step': 0, 'keys': []}
        calls, violations, errors = [], [], []

        def route(r):
            request = r.request
            path = urlparse(request.url).path
            calls.append((request.method, path))
            ok = lambda body: r.fulfill(json=body, headers={'Access-Control-Allow-Origin': '*'})
            if request.method == 'GET' and path in READS:
                return ok(READS[path])
            if path.startswith('/v1/customer/checkout'):
                assert request.headers.get('authorization') == 'Bearer ' + 'a' * 64
                sub = path[len('/v1/customer/checkout'):]
                if request.method == 'POST':
                    state['keys'].append((sub, request.headers.get('idempotency-key')))
                if sub == '' and request.method == 'GET':
                    return ok({'enabled': True, 'payment_method': 'kaspi', 'phone_masked': '+7 701 ••• •• 67'})
                if sub == '/quotes':
                    body = request.post_data_json
                    # Prices never travel from the phone; only SKUs and selections.
                    assert 'price' not in json.dumps(body), body
                    assert body['items'][0]['sku'] == 'pick-combo', body
                    return ok({'quote_id': '50000000-0000-4000-8000-000000000002', 'total_minor': '419000',
                               'currency': 'KZT', 'expires_at': NOW.isoformat(), 'lines': []})
                if sub == '/orders':
                    return ok(view('accepting'))
                if sub == f'/orders/{ORDER}/kaspi-payment':
                    stage = SCRIPT[state['step']]
                    if stage == 'ready_to_pay':
                        state['step'] += 1
                    return ok(view(SCRIPT[state['step']]))
                if sub == f'/orders/{ORDER}':
                    state['step'] = min(state['step'] + 1, len(SCRIPT) - 1)
                    return ok(view(SCRIPT[state['step']]))
            violations.append((request.method, path))
            r.abort()

        context = browser.new_context(viewport={'width': width, 'height': height}, reduced_motion='reduce')
        context.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1", %s)'
                                % json.dumps(json.dumps(SESSION)))
        context.route('**/v1/**', route)
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL + '/menu')
        page.get_by_test_id('product-pick-combo').click(timeout=30000)
        page.get_by_test_id('product-add').click()
        page.get_by_test_id('open-cart').click()
        page.get_by_test_id('cart-checkout').click()
        checkout = page.get_by_test_id('screen-M12')
        expect(checkout).to_be_visible()
        pay = page.get_by_test_id('kaspi-checkout-pay')
        expect(pay).to_have_text('Оплатить через Kaspi', timeout=15000)
        expect(page.get_by_test_id('kaspi-checkout-phone')).to_contain_text('+7 701 ••• •• 67')
        expect(checkout).not_to_contain_text('Деньги не списываются')
        box = pay.bounding_box()
        assert box['height'] >= 48 and box['y'] + box['height'] <= height + 1, box
        page.screenshot(path=str(OUT / f'checkout-{width}.png'))
        pay.click()
        for stage in ['accepting', 'sending_invoice', 'invoice_sent', 'paid']:
            expect(page.get_by_test_id(f'kaspi-stage-{stage}')).to_be_visible(timeout=20000)
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            if stage != 'paid':
                expect(page.get_by_text('Оплачено', exact=True)).to_have_count(0)
            page.screenshot(path=str(OUT / f'{stage}-{width}.png'))
        expect(page.get_by_test_id('kaspi-stage-invoice_sent')).to_have_count(0)
        page.get_by_test_id('kaspi-done').click()
        expect(page.get_by_test_id('screen-M06').filter(visible=True).first).to_be_visible()
        # One order, one quote; the invoice request key was reused, never multiplied.
        posts = [k for k in state['keys']]
        assert [s for s, _ in posts].count('/orders') == 1, posts
        assert [s for s, _ in posts].count('/quotes') == 1, posts
        pay_keys = {k for s, k in posts if s.endswith('kaspi-payment')}
        assert len(pay_keys) == 1, posts
        assert not any(path.startswith('/v1/test/orders') for _, path in calls), calls
        assert not violations, violations
        assert not errors, errors
        results[width] = len(calls)
        context.close()
    browser.close()
print(json.dumps({'success': True, 'sizes': list(results), 'bank_requests': 0}))
