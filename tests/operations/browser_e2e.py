"""Real, explicitly synthetic VPS flow. Requires temporary staff role files; never prints keys.

OPS_URL=https://... MOBILE_URL=http://127.0.0.1:8081 \
TEST_FLOW_STAFF_DIR=/absolute/private/roles python tests/operations/browser_e2e.py
"""
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
OPS = os.environ.get('OPS_URL', 'https://pickchick.185.129.51.103.nip.io').rstrip('/')
API = os.environ.get('TEST_FLOW_API_URL', 'https://pickchick.185.129.51.103.nip.io/v1/test').rstrip('/')
MOBILE = os.environ.get('MOBILE_URL', 'http://127.0.0.1:8081').rstrip('/')
STAFF = Path(os.environ.get('TEST_FLOW_STAFF_DIR', str(ROOT / '.local/test-flow-staff')))
OUTPUT = ROOT / '.local/operations-e2e'
OUTPUT.mkdir(parents=True, exist_ok=True)
stage = 'preflight'
errors = []
broken = []
checks = []
numbers = []
created_ids = []


def role_token(role):
    for path in sorted(STAFF.glob(f'{role}*.json'), key=lambda p: p.stat().st_mtime, reverse=True):
        value = json.loads(path.read_text())
        if value.get('role') != role or value.get('synthetic') is not True:
            continue
        if not re.fullmatch(r'[a-f0-9]{64}', value.get('token', '')):
            continue
        if datetime.fromisoformat(value['expires_at'].replace('Z', '+00:00')) <= datetime.now(timezone.utc):
            continue
        return value['token']
    raise AssertionError(f'No current private credential for role {role}')


def watch(page):
    page.on('pageerror', lambda error: errors.append({'surface': page.url.split('?')[0], 'name': type(error).__name__}))
    # The single forbidden-role check is intentional. Transport abort is injected separately.
    page.on('response', lambda response: broken.append({'status': response.status, 'url': response.url.split('?')[0]})
            if response.status >= 400 and not (response.status == 403 and response.url.endswith('/kitchen')) else None)


def assert_layout(page, name):
    assert not page.locator('body').evaluate('(e)=>e.scrollWidth>window.innerWidth+2'), f'{name}: horizontal overflow'
    page.screenshot(path=str(OUTPUT / f'{name}.png'), full_page=True)


def staff_page(browser, role, token):
    path = {'prep': '/kitchen/prep', 'assembly': '/kitchen/assembly', 'display': '/display', 'manager': '/manager'}[role]
    context = browser.new_context(viewport={'width': 1440, 'height': 1050})
    page = context.new_page()
    watch(page)
    page.goto(OPS + path)
    page.get_by_label('Ключ доступа', exact=True).fill(token)
    page.get_by_role('button', name='Открыть рабочий экран', exact=True).click()
    page.locator('.display-shell' if role == 'display' else '.manager-layout' if role == 'manager' else '.kitchen-main').wait_for()
    return page


def create_kiosk(page, start=True):
    if start:
        page.get_by_role('button', name='НАЧАТЬ →', exact=True).click()
        page.get_by_role('button', name=re.compile('С СОБОЙ')).click()
    page.locator('.product').first.click()
    page.get_by_role('button', name=re.compile('^Добавить ·')).click()
    page.get_by_role('button', name='Оформить заказ →', exact=True).click()
    page.get_by_role('button', name='Продолжить →', exact=True).click()
    page.get_by_role('button', name='Рассчитать тестовый заказ', exact=True).click()
    with page.expect_response(lambda r: r.request.method == 'POST' and r.url == API + '/orders') as received:
        page.get_by_role('button', name='Создать тестовый заказ →', exact=True).click()
    assert received.value.ok, 'Kiosk order creation rejected'
    order = received.value.json()
    assert order['synthetic'] is True and order['namespace'] == 'pickchick-test'
    assert order['state'] == 'awaiting_test_payment'
    assert order['snapshot']['channel'] == 'kiosk'
    numbers.append(order['number']); created_ids.append(order['order_id'])
    expect(page.locator('.order-number')).to_have_text(order['number'])
    return order


def ticket(page, number):
    return page.locator(f'.ticket[data-order-number="{number}"]')


def prepare_and_assemble(prep, assembly, display, number):
    card = ticket(assembly, number)
    card.wait_for()
    expect(card.get_by_role('button', name='Заказ собран', exact=True)).to_be_disabled()
    prep_card = ticket(prep, number)
    prep_card.wait_for()
    while prep_card.get_by_role('button', name='Готово', exact=True).count():
        with prep.expect_response(lambda r: r.request.method == 'POST' and '/tasks/' in r.url and r.url.endswith('/complete')) as response:
            prep_card.get_by_role('button', name='Готово', exact=True).first.click()
        assert response.value.ok, 'Prep task rejected'
        if not prep_card.count():
            break
        # Every command is followed by a fresh queue read, not an optimistic tick.
        prep.wait_for_function('(number)=>{const card=document.querySelector(`[data-order-number="${number}"]`);return !card||!card.textContent.includes("Сохраняем…")}', arg=number)
    button = card.get_by_role('button', name='Заказ собран', exact=True)
    expect(button).to_be_enabled(timeout=15000)
    button.click()
    expect(card.get_by_role('button', name='Выдать заказ', exact=True)).to_be_visible(timeout=15000)
    expect(display.locator('.display-columns .ready .display-numbers').get_by_text(number, exact=True)).to_be_visible(timeout=15000)
    expect(display.locator('.display-columns section').first.locator('.display-numbers').get_by_text(number, exact=True)).to_have_count(0)


def handoff(assembly, display, number):
    ticket(assembly, number).get_by_role('button', name='Выдать заказ', exact=True).click()
    expect(ticket(assembly, number)).to_have_count(0, timeout=15000)
    expect(display.locator('.display-numbers').get_by_text(number, exact=True)).to_have_count(0, timeout=15000)


def manager_open(manager, number):
    manager.get_by_label('Найти заказ', exact=True).fill(number)
    row = manager.locator('tbody tr').filter(has_text=number)
    row.get_by_role('button', name='Открыть', exact=True).click()
    manager.locator('.order-details').wait_for()


def run():
    global stage
    tokens = {role: role_token(role) for role in ('prep', 'assembly', 'display', 'manager')}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        api_request = p.request.new_context()
        catalog = api_request.get(API + '/catalog')
        assert catalog.ok, 'VPS test API is not ready'
        assert catalog.json()['namespace'] == 'pickchick-test'
        stage = 'staff login'
        prep = staff_page(browser, 'prep', tokens['prep'])
        assembly = staff_page(browser, 'assembly', tokens['assembly'])
        display = staff_page(browser, 'display', tokens['display'])
        manager = staff_page(browser, 'manager', tokens['manager'])

        stage = 'role isolation'
        denied = browser.new_page(viewport={'width': 1024, 'height': 1366})
        watch(denied)
        denied.goto(OPS + '/kitchen/prep')
        denied.get_by_label('Ключ доступа', exact=True).fill(tokens['display'])
        denied.get_by_role('button', name='Открыть рабочий экран', exact=True).click()
        expect(denied.get_by_role('alert')).to_contain_text('нет прав')
        assert denied.locator('.ticket').count() == 0
        denied.close(); checks.append('display key cannot open kitchen')

        stage = 'kiosk create'
        context = browser.new_context(viewport={'width': 1024, 'height': 1366})
        kiosk = context.new_page(); watch(kiosk)
        kiosk.goto(OPS + '/kiosk')
        first = create_kiosk(kiosk)
        first_session = kiosk.evaluate('()=>sessionStorage.getItem("pickchick.kiosk.session")')

        stage = 'lost response / exact retry after reload'
        attempts = []
        injected = False
        def lose_response(route):
            nonlocal injected
            attempts.append({'key': route.request.header_value('idempotency-key'), 'body': route.request.post_data})
            if not injected:
                injected = True
                response = route.fetch()
                assert response.ok, 'Injected payment was not committed'
                route.abort('failed')
            else:
                route.continue_()
        kiosk.route('**/simulated-payment', lose_response)
        kiosk.get_by_role('button', name='Тест: подтвердить оплату', exact=True).click()
        expect(kiosk.get_by_role('button', name='Повторить прежний запрос', exact=True)).to_be_enabled()
        assert kiosk.get_by_role('button', name='Следующий гость', exact=True).count() == 0
        kiosk.reload()
        expect(kiosk.get_by_role('button', name='Повторить прежний запрос', exact=True)).to_be_enabled()
        kiosk.get_by_role('button', name='Повторить прежний запрос', exact=True).click()
        expect(kiosk.get_by_role('heading', name='Ваш заказ на кухне', exact=True)).to_be_visible(timeout=15000)
        assert len(attempts) == 2 and attempts[0] == attempts[1], 'Retry changed key or payload'
        kiosk.unroute('**/simulated-payment', lose_response)
        checks.append('committed payment response lost; reload retries same key/body')

        stage = 'next guest before first handoff'
        kiosk.get_by_role('button', name='Следующий гость', exact=True).click()
        expect(kiosk.locator('.attract')).to_be_visible()
        assert kiosk.evaluate('()=>sessionStorage.getItem("pickchick.kiosk.session")') is None
        assert first['number'] not in kiosk.locator('body').inner_text()
        kiosk.get_by_role('button', name='НАЧАТЬ →', exact=True).click()
        kiosk.get_by_role('button', name=re.compile('С СОБОЙ')).click()
        assert kiosk.evaluate('()=>sessionStorage.getItem("pickchick.kiosk.session")') != first_session
        assert first['number'] not in kiosk.locator('body').inner_text()
        expect(kiosk.locator('.cart-bar')).to_contain_text('В корзине: 0')
        current = api_request.get(API + '/orders/' + first['order_id'], headers={'Authorization': 'Bearer ' + tokens['manager']})
        assert current.ok and current.json()['state'] == 'preparing', 'New guest altered first order'
        checks.append('new guest clears local session while first server order stays preparing')

        stage = 'kiosk kitchen assembly display'
        prepare_and_assemble(prep, assembly, display, first['number'])
        assert_layout(prep, 'kitchen-prep')
        assert_layout(assembly, 'kitchen-assembly')
        assert_layout(display, 'display-ready')
        handoff(assembly, display, first['number'])
        checks.append('kiosk → prep → assembly → display → staff handoff')

        stage = 'unknown payment survives reload'
        unknown = create_kiosk(kiosk, start=False)
        kiosk.get_by_role('button', name='Тест: неизвестный результат', exact=True).click()
        expect(kiosk.get_by_role('heading', name='Проверяем тестовую оплату', exact=True)).to_be_visible()
        kiosk.reload()
        expect(kiosk.locator('.order-number')).to_have_text(unknown['number'])
        assert kiosk.get_by_role('button', name='Тест: подтвердить оплату', exact=True).count() == 0
        assert kiosk.get_by_role('button', name='Следующий гость', exact=True).count() == 0
        kiosk.get_by_role('button', name='Нужна помощь', exact=True).click()
        expect(kiosk.get_by_role('dialog')).to_contain_text(unknown['number'])
        assert kiosk.get_by_role('button', name='Завершить сеанс', exact=True).count() == 0
        kiosk.get_by_role('button', name='Вернуться к проверке', exact=True).click()
        manager_open(manager, unknown['number'])
        manager.locator('.order-details').get_by_role('button', name='Тест: подтвердить', exact=True).click()
        expect(kiosk.get_by_role('heading', name='Ваш заказ на кухне', exact=True)).to_be_visible(timeout=15000)
        assert_layout(kiosk, 'kiosk-confirmed-1024')
        # Cancel only the order created by this run; no unrelated user/test orders touched.
        manager.locator('.order-details').get_by_label('Причина отмены тестового заказа').fill('Завершение браузерной проверки неизвестного результата')
        manager.locator('.order-details').get_by_role('button', name='Отменить с причиной', exact=True).click()
        expect(kiosk.get_by_role('heading', name='Заказ отменён', exact=True)).to_be_visible(timeout=15000)
        checks.append('unknown persists; no new guest/payment; manager resolves same order')

        stage = 'mobile web create'
        mobile_context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        mobile = mobile_context.new_page(); watch(mobile)
        mobile.goto(MOBILE + '/screen/M06')
        mobile.get_by_test_id('product-pick-combo').click(timeout=60000)
        mobile.get_by_test_id('product-add').click()
        mobile.get_by_test_id('cart-checkout').click()
        with mobile.expect_response(lambda r: r.request.method == 'POST' and r.url == API + '/orders') as received:
            mobile.get_by_test_id('test-checkout-create').click()
        assert received.value.ok, 'Mobile order creation rejected'
        mobile_order = received.value.json()
        numbers.append(mobile_order['number']); created_ids.append(mobile_order['order_id'])
        assert mobile_order['snapshot']['channel'] == 'mobile'
        expect(mobile.get_by_test_id('connected-order-number')).to_have_text(mobile_order['number'])
        mobile.get_by_role('button', name='Тест: подтвердить и передать на кухню', exact=True).click()
        expect(mobile.get_by_text('Задания уже появились на двух кухонных экранах.', exact=True)).to_be_visible(timeout=15000)
        mobile.reload()
        expect(mobile.get_by_test_id('connected-order-number')).to_have_text(mobile_order['number'], timeout=60000)
        stage = 'mobile kitchen display handoff'
        prepare_and_assemble(prep, assembly, display, mobile_order['number'])
        expect(mobile.get_by_text('Можно забирать', exact=True)).to_be_visible(timeout=15000)
        assert_layout(mobile, 'mobile-ready-390')
        assert_layout(manager, 'manager-orders')
        handoff(assembly, display, mobile_order['number'])
        expect(mobile.get_by_text('Выдача подтверждена на кухне. Заказ убран с табло.', exact=True)).to_be_visible(timeout=15000)
        checks.append('mobile persisted order → both kitchen stations → display + own status → handoff')

        stage = 'result verification'
        for order_id in created_ids:
            response = api_request.get(API + '/orders/' + order_id, headers={'Authorization': 'Bearer ' + tokens['manager']})
            assert response.ok and response.json()['state'] in ('fulfilled', 'cancelled'), 'Run left active order'
        assert not errors, 'Browser JavaScript errors'
        assert not broken, 'Unexpected failed resource responses'
        browser.close(); api_request.dispose()


try:
    run()
    result = {'success': True, 'synthetic': True, 'checks': checks, 'orders': numbers,
              'browser_errors': errors, 'failed_resources': broken}
except Exception as failure:
    # Playwright exceptions may include filled field values. Never emit their raw text.
    result = {'success': False, 'stage': stage, 'error_type': type(failure).__name__,
              'checks': checks, 'orders': numbers, 'browser_errors': errors, 'failed_resources': broken}
    if isinstance(failure, AssertionError):
        result['assertion'] = str(failure)
    (OUTPUT / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False)); sys.exit(1)
(OUTPUT / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
