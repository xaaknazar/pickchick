"""Local Expo-web regression; every API request is intercepted, no VPS orders are created."""
import json
import os
from datetime import datetime, timezone
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4182').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost'), 'Use a local exported app'
META = {'synthetic': True, 'namespace': 'pickchick-test'}
SESSION_KEY = 'pickchick.test.customer.v1'
SESSION = {**META, 'session_id': '30000000-0000-4000-8000-000000000001',
           'token': 'a' * 64, 'channel': 'mobile', 'expires_at': '2099-01-01T00:00:00.000Z'}
now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
line = {'id': 'pick-combo', 'name': 'Pick Combo', 'description': 'Browser fixture only',
        'category': 'Комбо', 'price_minor': '349000', 'image_id': 'i7.jpg',
        'prep_required': True, 'quantity': 1, 'line_total_minor': '349000'}
quote = {**META, 'quote_id': '30000000-0000-4000-8000-000000000002',
         'branch_id': '10000000-0000-4000-8000-000000000003',
         'catalog_version': 'mockup-v0.2', 'channel': 'mobile', 'service_mode': 'takeaway',
         'currency': 'KZT', 'total_minor': '349000', 'lines': [line],
         'created_at': now, 'expires_at': '2099-01-01T00:00:00.000Z'}
ORDER = {**META, 'order_id': '30000000-0000-4000-8000-000000000003', 'number': 'T-900001',
         'branch_id': quote['branch_id'], 'version': 2, 'state': 'awaiting_test_payment',
         'payment_state': 'simulated_unknown',
         'payment_attempt_id': '30000000-0000-4000-8000-000000000004',
         'fiscal_state': 'not_applicable', 'snapshot': quote, 'tasks': [],
         'created_at': now, 'updated_at': now, 'cancellation_reason': None}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    requests = []
    mode = {'orders': 'success'}
    def intercept(route):
        request = route.request
        path = urlparse(request.url).path
        requests.append((request.method, path))
        if request.method == 'POST' and path == '/v1/test/orders/watch':
            # An older API has no event endpoint. Only this exact read-only request
            # is allowed; session/quote/order/payment mutations remain forbidden.
            body = request.post_data_json
            assert set(body) == {'versions'} and len(body['versions']) <= 1
            assert all(set(row) == {'order_id', 'version'} and row['order_id'] == ORDER['order_id']
                       and row['version'] in (2, 3) for row in body['versions'])
            assert request.headers.get('authorization') == 'Bearer ' + SESSION['token']
            route.fulfill(status=404, json={'code':'NOT_FOUND'}, headers={'Access-Control-Allow-Origin':'*'})
            return
        assert request.method == 'GET', 'Reading order screens must not issue any mutation'
        if path == '/v1/customer-checkout/availability':
            route.fulfill(json={'enabled':False,'fresh':False,'signature':'disabled','products':[]}, headers={'Access-Control-Allow-Origin':'*'})
        elif path == '/v1/test/orders' and mode['orders'] == 'success':
            route.fulfill(json={**META, 'orders': [({**ORDER, 'version': 3, 'state': 'fulfilled', 'payment_state': 'simulated_approved'} if mode.get('terminal') else ORDER)]}, headers={'Access-Control-Allow-Origin': '*'})
        else:
            route.abort('failed')
    context.route('**/v1/**', intercept)
    context.add_init_script('localStorage.setItem(' + json.dumps(SESSION_KEY) + ',' +
                            json.dumps(json.dumps(SESSION)) + ');')
    from account_fixture import signed_in
    signed_in(context)
    page = context.new_page()
    page.goto(URL + '/screen/M19')
    history = page.get_by_test_id('screen-M19')
    expect(history.get_by_text('Заказ №'+ORDER['number'], exact=True)).to_be_visible(timeout=15000)
    expect(history.get_by_text('Новое оформление недоступно', exact=True)).not_to_be_visible()
    assert ('GET', '/v1/test/orders') in requests
    assert not any(path.endswith('/sessions') for _, path in requests)
    history.get_by_text('Заказ №'+ORDER['number'], exact=True).click()
    details = page.get_by_test_id('screen-M20')
    expect(details.get_by_test_id('connected-order-number')).to_have_text(ORDER['number'])
    expect(details.get_by_text('Уточняем результат', exact=True)).to_be_visible()
    assert details.get_by_test_id('test-payment-approve').count() == 0

    mode['orders'] = 'offline'
    page.reload()
    expect(details.get_by_text('Статус пока не удалось проверить', exact=True)).to_be_visible(timeout=15000)
    assert page.get_by_text('Активного платежа нет', exact=True).count() == 0
    assert page.evaluate('(key)=>localStorage.getItem(key)', SESSION_KEY) == json.dumps(SESSION)
    mode['orders'] = 'success'
    details.get_by_role('button', name='Обновить статус', exact=True).click()
    expect(details.get_by_test_id('connected-order-number')).to_have_text(ORDER['number'], timeout=15000)

    page.goto(URL + '/screen/M12')
    expect(page.get_by_test_id('test-checkout-create')).to_contain_text('Продолжить ' + ORDER['number'], timeout=15000)
    expect(page.get_by_text('Новое оформление недоступно', exact=True)).to_be_visible()
    page.get_by_test_id('test-checkout-create').click()
    expect(page.get_by_test_id('screen-M14').get_by_test_id('connected-order-number')).to_have_text(ORDER['number'])
    page.goto(URL + '/screen/M11')
    expect(page.get_by_text('Доступность пока не подтверждена', exact=True)).to_be_visible(timeout=15000)
    page.get_by_role('button', name='Обновить доступность', exact=True).click()
    expect(page.get_by_text('Доступность пока не подтверждена', exact=True)).to_be_visible()
    mode['terminal'] = True
    page.goto(URL + '/screen/M19')
    expect(page.get_by_text('Выдан', exact=True)).to_be_visible(timeout=10000)
    terminal_reads = len([path for _, path in requests if path == '/v1/test/orders'])
    # Observe actual scheduled network activity over more than two old poll periods.
    page.wait_for_timeout(7500)
    assert len([path for _, path in requests if path == '/v1/test/orders']) == terminal_reads
    assert all(method == 'GET' or (method, path) == ('POST', '/v1/test/orders/watch')
               for method, path in requests)
    assert ('POST', '/v1/test/orders/watch') in requests
    browser.close()

print(json.dumps({'success': True, 'fixture_only': True, 'real_orders_created': 0,
                  'checks': ['saved unknown order survives unavailable catalog',
                             'failed cold read stays unknown; manual retry restores the same order',
                             'checkout resumes saved unknown order without a new request',
                             'availability retry does not falsely report a closed restaurant',
                             'older API watch404 falls back to read-only snapshots without mutations']}, ensure_ascii=False))
