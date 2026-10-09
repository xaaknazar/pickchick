"""Devices tab on an isolated HTTP/PostgreSQL fixture. Registry routes are mocked in the
browser (synthetic devices only); the operations snapshot and login are real."""
import json
import os
import re
import sys
import uuid
from datetime import datetime, timedelta, timezone
from playwright.sync_api import sync_playwright, expect

fixture = json.load(open(sys.argv[1]))
branch = fixture['branch']
shots = fixture.get('shots')
if shots:
    os.makedirs(shots, exist_ok=True)


def now():
    return datetime.now(timezone.utc)


def iso(value):
    return value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def ago(**delta):
    return iso(now() - timedelta(**delta))


def device(role, name, status='active', **extra):
    base = {
        'id': str(uuid.uuid4()),
        'role': role,
        'name': name,
        'status': status,
        'last_seen_at': None,
        'app_version': None,
        'credential_expires_at': None,
        'open_code': None,
        'payment_open': False,
        'revoked_at': None,
    }
    base.update(extra)
    return base


edge = device('edge', 'Моноблок кассы', last_seen_at=ago(seconds=20), app_version='edge 0.9.4',
              credential_expires_at=iso(now() + timedelta(days=5)))
kiosk_ok = device('kiosk', 'iPad у входа', last_seen_at=ago(seconds=40), app_version='1.0 (11)')
kiosk_lost = device('kiosk', 'iPad у окна', last_seen_at=ago(minutes=25), app_version='1.0 (10)')
kiosk_paying = device('kiosk', 'iPad у кассы', last_seen_at=ago(seconds=15), app_version='1.0 (11)',
                      payment_open=True)
prep = device('kitchen_prep', 'Горячий цех', last_seen_at=ago(minutes=4), app_version='kitchen 0.6.0')
board = device('board', 'Табло в зале', last_seen_at=ago(seconds=30))
old = device('kiosk', 'Старый iPad', status='revoked', revoked_at=ago(days=12))
state = {'devices': [edge, kiosk_ok, kiosk_lost, kiosk_paying, prep, board, old], 'paired': None}
requests = []
DEVICES = re.compile(r'.*/v1/admin/backoffice/branches/([0-9a-f-]{36})/devices(/.*)?$')


def reply(route, value, status=200):
    route.fulfill(status=status, content_type='application/json', body=json.dumps(value))


def handle(route, request):
    match = DEVICES.match(request.url)
    assert match and match.group(1) == branch, request.url
    tail = match.group(2) or ''
    body = json.loads(request.post_data) if request.post_data else None
    requests.append((request.method, tail, body))
    find = lambda i: next(d for d in state['devices'] if d['id'] == i)
    if request.method == 'GET' and tail == '':
        return reply(route, {
            'schema_version': 1, 'branch_id': branch, 'role': 'manager', 'as_of': iso(now()),
            'kiosk_supported': True, 'devices': state['devices'],
        })
    if request.method == 'POST' and tail == '':
        assert body['role'] == 'kiosk' and len(body['reason']) >= 3, body
        d = device('kiosk', body['name'], status='pending')
        state['devices'].append(d)
        return reply(route, {'device': {'id': d['id']}})
    parts = tail.strip('/').split('/')
    d = find(parts[0])
    if request.method == 'POST' and parts[1:] == ['pairing-codes']:
        code = {'id': str(uuid.uuid4()), 'expires_at': iso(now() + timedelta(minutes=30))}
        d['open_code'] = code
        state['paired'] = d['id']
        return reply(route, {'code_id': code['id'], 'login': 'kiosk-entrance-7',
                             'password': 'Q7m-4tZ9-pK2w', 'expires_at': code['expires_at']})
    if request.method == 'POST' and parts[1:2] == ['pairing-codes'] and parts[-1] == 'cancel':
        d['open_code'] = None
        return reply(route, {'ok': True})
    if request.method == 'POST' and parts[1:] == ['revoke']:
        assert body['confirmName'] == d['name'] and d['role'] != 'edge', body
        d['status'] = 'revoked'
        d['revoked_at'] = iso(now())
        return reply(route, {'ok': True})
    if request.method == 'GET' and parts[1:] == ['events']:
        return reply(route, {'events': [
            {'action': 'paired', 'actor_kind': 'device', 'reason': None, 'at': ago(days=3)},
            {'action': 'code_issued', 'actor_kind': 'backoffice', 'reason': 'Новый киоск', 'at': ago(days=3, minutes=5)},
        ]})
    raise AssertionError('unexpected ' + request.method + ' ' + tail)


def no_scroll(page, label):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), label


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(fixture['url'] + '#devices')
    page.get_by_test_id('credential-file').set_input_files({
        'name': 'access.json', 'mimeType': 'application/json',
        'buffer': json.dumps(fixture['manager']).encode()})
    # Real API without the registry route: read-only legacy list, no revoke anywhere.
    expect(page.get_by_test_id('devices-legacy')).to_be_visible()
    expect(page.get_by_role('button', name='Отозвать доступ')).to_have_count(0)
    expect(page.locator('[data-testid^="device-revoke-"]')).to_have_count(0)
    expect(page.get_by_test_id('devices-pair')).to_have_count(0)
    expect(page.locator('.op-periods')).to_have_count(0)

    page.route(DEVICES, handle)
    page.get_by_test_id('nav-devices').click()
    expect(page.get_by_test_id('devices-legacy')).to_have_count(0)
    expect(page.get_by_test_id('device-' + edge['id'])).to_be_visible()
    groups = page.locator('.device-group h3').all_inner_texts()
    assert groups == ['Касса (моноблок)', 'iPad-киоски', 'Кухня: приём', 'Кухня: сборка', 'Табло'], groups
    summary = page.get_by_test_id('devices-summary').inner_text()
    assert 'Подключено\n4' in summary and 'Требуют внимания\n2' in summary, summary
    expect(page.get_by_test_id('device-status-' + edge['id'])).to_have_text('На связи')
    expect(page.get_by_test_id('device-status-' + kiosk_lost['id'])).to_have_text('Нет связи 25 мин')
    expect(page.get_by_test_id('device-status-' + prep['id'])).to_have_text('Нет связи 4 мин')
    # Cashier node: no revoke, replacement procedure instead; screens: read-only with reset hint.
    edge_card = page.get_by_test_id('device-' + edge['id'])
    expect(edge_card.locator('[data-testid^="device-revoke-"]')).to_have_count(0)
    expect(edge_card).to_contain_text('Замена кассы - по процедуре')
    expect(edge_card).to_contain_text('Ключ облака')
    for screen in (prep, board):
        card = page.get_by_test_id('device-' + screen['id'])
        expect(card).to_contain_text('staff-password-setup.mjs --replace')
        expect(card.locator('[data-testid^="device-revoke-"], [data-testid^="device-rename-"]')).to_have_count(0)
    paying = page.get_by_test_id('device-' + kiosk_paying['id'])
    expect(paying).to_contain_text('Идёт оплата Kaspi')
    expect(paying.locator('[data-testid^="device-revoke-"]')).to_have_count(0)
    expect(page.locator('.device-revoked summary')).to_have_text('Отозванные (1)')
    no_scroll(page, 'devices 1440')
    if shots:
        page.screenshot(path=os.path.join(shots, 'devices-1440.png'), full_page=True)

    # Journal.
    page.get_by_test_id('device-journal-' + kiosk_ok['id']).click()
    journal = page.get_by_test_id('device-journal')
    expect(journal).to_contain_text('Устройство подключено')
    journal.get_by_test_id('device-journal-close').click()
    expect(journal).to_have_count(0)

    # Pairing a new iPad: one-time login, 30-minute countdown, follows to "paired".
    page.get_by_test_id('devices-pair').click()
    dialog = page.get_by_test_id('device-pairing')
    expect(dialog).to_be_visible()
    page.get_by_test_id('device-pairing-name').fill('iPad на террасе')
    page.get_by_test_id('device-pairing-reason').fill('Новый киоск на летней террасе')
    page.get_by_test_id('device-pairing-issue').click()
    expect(page.get_by_test_id('device-pairing-login')).to_have_text('kiosk-entrance-7')
    expect(page.get_by_test_id('device-pairing-password')).to_have_text('Q7m-4tZ9-pK2w')
    expect(page.get_by_test_id('device-pairing-countdown')).to_have_text(re.compile(r'^(29:[0-5]\d|30:00)$'))
    first = page.get_by_test_id('device-pairing-countdown').inner_text()
    page.wait_for_timeout(1300)
    assert page.get_by_test_id('device-pairing-countdown').inner_text() != first, 'countdown ticks'
    creates = [r for r in requests if r[0] == 'POST' and r[1] == '']
    issues = [r for r in requests if r[1].endswith('/pairing-codes')]
    assert len(creates) == 1 and len(issues) == 1, requests
    assert set(creates[0][2]) == {'requestId', 'role', 'name', 'reason'}, creates
    assert set(issues[0][2]) == {'requestId', 'reason'}, issues
    if shots:
        page.screenshot(path=os.path.join(shots, 'devices-pairing-1440.png'))
    # The iPad signs in: the registry reports it active; the dialog notices within ~3 s.
    paired = next(d for d in state['devices'] if d['id'] == state['paired'])
    paired.update(status='active', open_code=None, last_seen_at=iso(now()), app_version='1.0 (11)')
    expect(page.get_by_test_id('device-pairing-paired')).to_be_visible(timeout=8000)
    expect(page.get_by_test_id('device-pairing-password')).to_have_count(0)
    page.get_by_test_id('device-pairing-finish').click()
    expect(dialog).to_have_count(0)
    expect(page.get_by_test_id('device-status-' + paired['id'])).to_have_text('На связи')

    # Revoke with reason and typed name; the button stays disabled until both are valid.
    page.get_by_test_id('device-revoke-' + kiosk_lost['id']).click()
    confirm = page.get_by_test_id('device-revoke-confirm')
    expect(confirm).to_be_disabled()
    page.get_by_test_id('device-revoke-reason').fill('iPad украден из зала')
    page.get_by_test_id('device-revoke-name').fill('iPad')
    expect(confirm).to_be_disabled()
    page.get_by_test_id('device-revoke-name').fill('iPad у окна')
    expect(confirm).to_be_enabled()
    if shots:
        page.screenshot(path=os.path.join(shots, 'devices-revoke-1440.png'))
    confirm.click()
    expect(page.get_by_test_id('device-revoke-dialog')).to_have_count(0)
    expect(page.locator('.device-revoked summary').first).to_have_text('Отозванные (2)')
    expect(page.get_by_test_id('device-' + kiosk_lost['id'])).to_have_count(0)

    # Phone width: no horizontal scroll on the page or in the pairing dialog.
    page.set_viewport_size({'width': 400, 'height': 900})
    page.wait_for_timeout(200)
    no_scroll(page, 'devices 400')
    if shots:
        page.screenshot(path=os.path.join(shots, 'devices-400.png'), full_page=True)
    page.get_by_test_id('devices-pair').click()
    page.get_by_test_id('device-pairing-name').fill('iPad у бара')
    page.get_by_test_id('device-pairing-reason').fill('Второй киоск у бара')
    page.get_by_test_id('device-pairing-issue').click()
    expect(page.get_by_test_id('device-pairing-password')).to_be_visible()
    width = page.get_by_test_id('device-pairing').evaluate('(d) => d.getBoundingClientRect().width')
    assert width <= 400, width
    if shots:
        page.screenshot(path=os.path.join(shots, 'devices-pairing-400.png'))
    page.get_by_test_id('device-pairing-cancel').click()
    expect(page.get_by_test_id('device-pairing-cancelled')).to_be_visible()
    assert any(r[1].endswith('/cancel') for r in requests), requests
    page.get_by_test_id('device-pairing-finish').click()
    assert not errors, errors
    browser.close()
print('PASS: legacy read-only, registry groups, no cashier revoke, journal, iPad pairing, revoke, 1440/400 px')
