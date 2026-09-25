"""Server-account UI against isolated HTTP fixtures. No SMS, VPS or real account calls."""
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

URL = os.environ.get('CUSTOMER_AUTH_URL', 'http://127.0.0.1:4196').rstrip('/')
assert urlparse(URL).hostname in ('localhost', '127.0.0.1')
OUTPUT = Path('.local/customer-auth-ui')
OUTPUT.mkdir(parents=True, exist_ok=True)
KEY = 'pickchick.customer.session.v1'
PHONE = '7' + '0' * 8 + '1'


def visible(page, name):
    return page.get_by_test_id(name).filter(visible=True)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    checks = []
    for width, height in [(320, 568), (390, 844), (430, 932)]:
        context = browser.new_context(viewport={'width': width, 'height': height})
        calls = []
        errors = []
        policy = {'version': 'fixture-v1'}
        verify_attempts = []
        customer = {'id': '40000000-0000-4000-8000-000000000001', 'phone': '+7' + PHONE,
                    'nickname': '', 'birth_date': None, 'gender': None,
                    'profile_completed_at': None, 'created_at': '2026-09-07T10:00:00.000Z'}
        now = datetime.now(timezone.utc)
        expires = (now + timedelta(minutes=15)).isoformat()
        sessions = {'access_token': 'a' * 64, 'refresh_token': 'b' * 64,
                    'access_expires_at': expires,
                    'session_id': '40000000-0000-4000-8000-000000000002', 'customer': customer}

        def intercept(route):
            request = route.request
            path = urlparse(request.url).path
            if path.startswith('/v1/test/') or path in ['/v1/capabilities', '/v1/branches']:
                route.abort('failed')
                return
            body = request.post_data_json if request.post_data else None
            calls.append({'path': path, 'method': request.method, 'body': body})
            status = 200
            if path == '/v1/auth/config':
                response = {'enabled': True, 'consent_version': policy['version'],
                            'terms_url': 'https://example.test/terms',
                            'privacy_url': 'https://example.test/privacy'}
            elif path == '/v1/auth/otp/request':
                assert body['phone'] == '+7' + PHONE
                assert len(body['request_id']) == 36 and len(body['device_id']) == 36
                status = 202
                response = {'challenge_id': '40000000-0000-4000-8000-000000000003',
                            'expires_at': (now + timedelta(minutes=3)).isoformat(),
                            'resend_at': (now + timedelta(minutes=1)).isoformat(),
                            'delivery_status': 'submitted'}
            elif path == '/v1/auth/otp/verify':
                assert body['consents'] == {'terms_version': 'fixture-v1',
                                            'privacy_version': 'fixture-v1', 'marketing_opt_in': False}
                if body['code'] != '938174':
                    status = 401
                    response = {'code': 'UNAUTHORIZED', 'message_key': 'errors.unauthorized',
                                'trace_id': '40000000-0000-4000-8000-000000000004', 'retryable': False}
                else:
                    response = sessions
                    verify_attempts.append(body)
                    if width == 390 and len(verify_attempts) == 1:
                        route.abort('failed')
                        return
            elif path == '/v1/customers/me':
                assert request.headers.get('authorization') == 'Bearer ' + 'a' * 64
                if request.method == 'PATCH':
                    customer.update(body)
                    customer['profile_completed_at'] = now.isoformat()
                response = {'customer': customer} if request.method != 'DELETE' else {'ok': True}
            elif path == '/v1/auth/logout':
                assert request.headers.get('authorization') == 'Bearer ' + 'a' * 64
                response = {'ok': True}
            else:
                raise AssertionError('Unexpected auth request: ' + path)
            route.fulfill(status=status, json=response, headers={'Access-Control-Allow-Origin': '*'})

        if width == 390:
            # A click does not wait for asynchronous OTP dispatch. Keep this
            # boundary deterministic while all requests still use local fixtures.
            context.add_init_script("""
                const originalFetch = window.fetch.bind(window);
                window.fetch = async (input, init) => {
                    const url = typeof input === 'string' ? input : input.url;
                    if (new URL(url, location.href).pathname === '/v1/auth/otp/verify')
                        await new Promise(resolve => setTimeout(resolve, 250));
                    return originalFetch(input, init);
                };
            """)
        context.route('**/v1/**', intercept)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + '/screen/M02')
        expect(visible(page, 'phone-input')).to_be_editable()
        visible(page, 'phone-input').fill(PHONE)
        expect(visible(page, 'request-otp')).to_be_enabled()
        expect(page.get_by_text('Код входа 123456. SMS не отправляется.', exact=True)).to_have_count(0)
        page.screenshot(path=str(OUTPUT / f'phone-{width}.png'))
        visible(page, 'request-otp').click()
        expect(visible(page, 'screen-M03')).to_be_visible()
        visible(page, 'otp-input').fill('938174')
        expect(visible(page, 'confirm-otp')).to_be_disabled()
        visible(page, 'auth-consent').click()
        expect(visible(page, 'confirm-otp')).to_be_enabled()
        rect = visible(page, 'confirm-otp').bounding_box()
        assert rect['y'] + rect['height'] <= height + 1, rect
        assert page.evaluate('document.documentElement.scrollWidth') <= width + 1
        page.screenshot(path=str(OUTPUT / f'otp-consent-{width}.png'))
        visible(page, 'confirm-otp').click()
        if width == 390:
            expect(page.get_by_text('Нет связи с сервером. Сохранённый вход останется на устройстве. Попробуйте ещё раз.', exact=True).filter(visible=True)).to_be_visible()
            pending = json.loads(page.evaluate('(key) => sessionStorage.getItem(key)', KEY))
            assert pending['verify_intent']['consent_version'] == 'fixture-v1'
            assert pending['tokens'] is None
            pending['challenge']['expires_at'] = (now - timedelta(minutes=10)).isoformat()
            pending['challenge']['resend_at'] = (now - timedelta(minutes=12)).isoformat()
            policy['version'] = 'fixture-v2'
            page.evaluate('([key, value]) => sessionStorage.setItem(key, value)', [KEY, json.dumps(pending)])
            page.reload()
            expect(visible(page, 'otp-input')).to_be_editable()
            expect(visible(page, 'auth-consent')).to_have_count(0)
            visible(page, 'otp-input').fill('938174')
            expect(visible(page, 'confirm-otp')).to_be_enabled()
            visible(page, 'confirm-otp').click()
        expect(visible(page, 'screen-M04')).to_be_visible()
        if width == 390:
            assert len(verify_attempts) == 2
            assert verify_attempts[0] == verify_attempts[1]
        visible(page, 'nickname-input').fill('Проверка аккаунта')
        visible(page, 'birthday-day').click()
        visible(page, 'birthday-picker-cancel').click(trial=True)
        visible(page, 'birthday-native-input').fill('2000-02-29')
        visible(page, 'birthday-picker-confirm').click()
        visible(page, 'nickname-save').click()
        expect(visible(page, 'screen-M06')).to_be_visible()
        stored = json.loads(page.evaluate('(key) => sessionStorage.getItem(key)', KEY))
        assert stored['tokens']['customer']['nickname'] == 'Проверка аккаунта'
        assert stored['tokens']['customer']['birth_date'] == '2000-02-29'
        assert page.evaluate("localStorage.getItem('pickchick.demo.profile.v1')") is None
        session_id = stored['tokens']['session_id']
        page.goto(URL + '/screen/M30')
        expect(visible(page, 'profile-birthday')).to_contain_text('29.02.2000')
        page.reload()
        expect(visible(page, 'profile-birthday')).to_contain_text('29.02.2000')
        assert json.loads(page.evaluate('(key) => sessionStorage.getItem(key)', KEY))['tokens']['session_id'] == session_id
        page.screenshot(path=str(OUTPUT / f'profile-{width}.png'))
        visible(page, 'demo-sign-out').click()
        expect(visible(page, 'profile-sign-in')).to_be_visible()
        assert json.loads(page.evaluate('(key) => sessionStorage.getItem(key)', KEY))['tokens'] is None
        assert len([x for x in calls if x['path'] == '/v1/auth/otp/request']) == 1
        assert len([x for x in calls if x['path'] == '/v1/auth/logout']) == 1
        assert not errors, errors
        checks.append({'viewport': [width, height], 'login': True, 'explicit_consent': True,
                       'birthday_server_save': True, 'reload_same_session': True, 'logout': True,
                       'expired_verify_receipt_policy_recovery': width == 390,
                       'sms_sent': 0, 'browser_errors': 0})
        context.close()
    browser.close()
    (OUTPUT / 'verification.json').write_text(json.dumps(checks, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(checks, ensure_ascii=False))
