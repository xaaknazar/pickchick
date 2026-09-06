"""Local demo login UX; all API traffic is intercepted, no SMS or VPS mutation."""
import json
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4182').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost'), 'Use a local exported app'
OUTPUT = Path(os.environ.get('DEMO_AUTH_OUTPUT', '.local/demo-account'))
OUTPUT.mkdir(parents=True, exist_ok=True)
PROFILE_KEY = 'pickchick.demo.profile.v1'
SESSION_KEY = 'pickchick.test.customer.v1'
SESSION = json.dumps({
    'synthetic': True, 'namespace': 'pickchick-test',
    'session_id': '30000000-0000-4000-8000-000000000001',
    'token': 'a' * 64, 'channel': 'mobile', 'expires_at': '2099-01-01T00:00:00.000Z',
})
PHONE = '7' + '0' * 8 + '1'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    checks = []
    for width, height in [(320, 568), (390, 844), (430, 932)]:
        context = browser.new_context(viewport={'width': width, 'height': height})
        mutations = []
        failures = []

        def intercept(route):
            request = route.request
            if request.method != 'GET':
                mutations.append(request.method + ' ' + urlparse(request.url).path)
            if urlparse(request.url).path == '/v1/test/orders':
                route.fulfill(json={'synthetic': True, 'namespace': 'pickchick-test', 'orders': []},
                              headers={'Access-Control-Allow-Origin': '*'})
            else:
                route.abort('failed')

        context.route('**/v1/**', intercept)
        context.add_init_script('localStorage.setItem(' + json.dumps(SESSION_KEY) + ',' +
                                json.dumps(SESSION) + ');')
        page = context.new_page()
        page.on('pageerror', lambda error: failures.append(str(error)))
        page.goto(URL + '/screen/M02')
        request = page.get_by_test_id('request-otp')
        expect(request).to_be_disabled()
        page.get_by_test_id('phone-input').fill(PHONE)
        expect(request).to_be_enabled()
        rect = request.bounding_box()
        assert rect['y'] + rect['height'] <= height, 'Phone action must remain in viewport'
        page.screenshot(path=str(OUTPUT / f'phone-{width}.png'))
        request.click()
        expect(page.get_by_test_id('screen-M03')).to_be_visible()
        expect(page.get_by_test_id('resend-otp')).to_be_disabled()
        page.get_by_test_id('otp-input').fill('000000')
        page.get_by_test_id('confirm-otp').click()
        expect(page.get_by_test_id('screen-M03').get_by_test_id('demo-auth-error')).to_contain_text('Код не подошёл')
        assert page.evaluate('(key) => localStorage.getItem(key)', PROFILE_KEY) is None
        page.get_by_test_id('otp-input').fill('123456')
        page.screenshot(path=str(OUTPUT / f'code-{width}.png'))
        page.get_by_test_id('confirm-otp').click()
        expect(page.get_by_test_id('nickname-input')).to_be_visible()
        page.get_by_test_id('nickname-input').fill('Тестовый гость')
        page.get_by_test_id('nickname-save').click()
        profile = page.get_by_test_id('screen-M30')
        expect(profile.get_by_text('Тестовый профиль', exact=True)).to_be_visible()
        expect(profile.get_by_text('+7 700 000-00-01', exact=True)).to_be_visible()
        page.screenshot(path=str(OUTPUT / f'profile-{width}.png'))
        saved = json.loads(page.evaluate('(key) => localStorage.getItem(key)', PROFILE_KEY))
        assert saved['kind'] == 'local_demo' and saved['phone'] == '+7' + PHONE
        assert set(saved) == {'version', 'kind', 'phone', 'createdAt'}
        assert page.evaluate('(key) => localStorage.getItem(key)', SESSION_KEY) == SESSION
        page.reload()
        expect(profile.get_by_text('Тестовый профиль', exact=True)).to_be_visible()
        profile.get_by_test_id('demo-sign-out').click()
        expect(profile.get_by_text('Без входа в аккаунт', exact=True)).to_be_visible()
        assert page.evaluate('(key) => localStorage.getItem(key)', PROFILE_KEY) is None
        assert page.evaluate('(key) => localStorage.getItem(key)', SESSION_KEY) == SESSION
        page.reload()
        expect(profile.get_by_text('Без входа в аккаунт', exact=True)).to_be_visible()
        assert not mutations, mutations
        assert not failures, failures
        checks.append({'viewport': f'{width}x{height}', 'login_restore_logout': True,
                       'wrong_code_rejected': True, 'server_identity_preserved': True})
        context.close()
    browser.close()

result = {'success': True, 'fixture_only': True, 'real_orders_created': 0,
          'sms_sent': 0, 'checks': checks}
(OUTPUT / 'verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps(result, ensure_ascii=False))
