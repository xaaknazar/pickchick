"""Local registration UX; all API traffic is intercepted, no SMS or VPS mutation."""
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


def stored_account(page):
    raw = page.evaluate('(key) => localStorage.getItem(key)', PROFILE_KEY)
    return json.loads(raw) if raw else None


def assert_no_horizontal_overflow(page, width):
    geometry = page.evaluate('''() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth
    })''')
    assert geometry['viewport'] == width, geometry
    assert max(geometry['document'], geometry['body']) <= width + 1, geometry


def footer_geometry(page, width, height, previous=None):
    result = {}
    for identifier in ['nickname-save', 'profile-fill-later']:
        control = page.get_by_test_id(identifier)
        expect(control).to_be_visible()
        rect = control.bounding_box()
        assert rect and rect['x'] >= 0 and rect['y'] >= 0, (identifier, rect)
        assert rect['x'] + rect['width'] <= width + 1, (identifier, rect)
        assert rect['y'] + rect['height'] <= height + 1, (identifier, rect)
        if previous:
            assert abs(rect['y'] - previous[identifier]['y']) <= 1, (identifier, previous, rect)
        result[identifier] = rect
    assert_no_horizontal_overflow(page, width)
    return result


def choose_birthday(page, width, height, footer, year):
    page.get_by_test_id('birthday-day').click()
    for part, value in [('day', 29), ('month', 2), ('year', year)]:
        expect(page.get_by_test_id(f'birthday-options-{part}')).to_be_visible()
        # A real click must reach the option through both nested scroll views.
        page.get_by_test_id(f'birthday-option-{part}-{value}').click()
        footer_geometry(page, width, height, footer)
    expect(page.get_by_test_id('birthday-picker')).to_have_count(0)


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
        # Seed once per browser tab. Re-seeding on each reload could conceal an
        # auth action accidentally deleting or replacing the ordering identity.
        context.add_init_script('''if (!sessionStorage.getItem('pickchick.auth-test.seeded')) {
            localStorage.setItem(''' + json.dumps(SESSION_KEY) + ',' + json.dumps(SESSION) + ''');
            sessionStorage.setItem('pickchick.auth-test.seeded', '1');
        }''')
        page = context.new_page()
        page.on('pageerror', lambda error: failures.append(str(error)))
        page.goto(URL + '/screen/M02')
        request = page.get_by_test_id('request-otp')
        expect(request).to_be_disabled()
        page.get_by_test_id('phone-input').fill(PHONE)
        expect(page.get_by_test_id('phone-input')).to_have_value(PHONE)
        expect(request).to_be_enabled()
        rect = request.bounding_box()
        assert rect['y'] + rect['height'] <= height, 'Phone action must remain in viewport'
        assert_no_horizontal_overflow(page, width)
        page.screenshot(path=str(OUTPUT / f'phone-{width}.png'))
        request.click()
        expect(page.get_by_test_id('screen-M03')).to_be_visible()
        expect(page.get_by_test_id('resend-otp')).to_be_disabled()
        page.get_by_test_id('otp-input').fill('000000')
        page.get_by_test_id('confirm-otp').click()
        expect(page.get_by_test_id('screen-M03').get_by_test_id('demo-auth-error')).to_contain_text('Код не подошёл')
        assert stored_account(page) is None
        page.get_by_test_id('otp-input').fill('123456')
        expect(page.get_by_test_id('otp-input')).to_have_value('123456')
        page.screenshot(path=str(OUTPUT / f'code-{width}.png'))
        page.get_by_test_id('confirm-otp').click()
        expect(page.get_by_test_id('screen-M04')).to_be_visible()
        page.get_by_test_id('nickname-input').fill('Тестовый гость')
        expect(page.get_by_test_id('nickname-input')).to_have_value('Тестовый гость')
        footer = footer_geometry(page, width, height)
        page.screenshot(path=str(OUTPUT / f'registration-empty-{width}.png'))
        choose_birthday(page, width, height, footer, 2000)
        page.get_by_test_id('profile-gender-female').click()
        footer_geometry(page, width, height, footer)
        expect(page.get_by_test_id('nickname-save')).to_be_enabled()
        page.screenshot(path=str(OUTPUT / f'registration-complete-{width}.png'))
        page.get_by_test_id('nickname-save').click()
        expect(page.get_by_test_id('screen-M06')).to_be_visible()
        page.goto(URL + '/profile')
        profile = page.get_by_test_id('screen-M30')
        expect(profile.get_by_text('Тестовый профиль', exact=True)).to_be_visible()
        expect(profile.get_by_text('+7 700 000-00-01', exact=True)).to_be_visible()
        expect(profile.get_by_test_id('profile-birthday')).to_contain_text('29.02.2000')
        page.screenshot(path=str(OUTPUT / f'profile-{width}.png'))
        saved = stored_account(page)
        assert saved['version'] == 2 and saved['kind'] == 'local_demo'
        assert saved['phone'] == '+7' + PHONE
        assert set(saved) == {'version', 'kind', 'phone', 'createdAt', 'profile'}
        assert saved['profile'] == {
            'nickname': 'Тестовый гость', 'birthDate': '2000-02-29',
            'gender': 'female', 'completedAt': saved['profile']['completedAt'],
        }
        assert isinstance(saved['profile']['completedAt'], int) and saved['profile']['completedAt'] > 0

        # Re-open the saved form through the profile, not a replacement fixture.
        page.reload()
        expect(profile.get_by_test_id('demo-sign-out')).to_be_visible()
        expect(profile.get_by_test_id('profile-birthday')).to_contain_text('29.02.2000')
        profile.get_by_test_id('profile-birthday').click()
        expect(page.get_by_test_id('screen-M04')).to_be_visible()
        expect(page.get_by_test_id('nickname-input')).to_have_value('Тестовый гость')
        expect(page.get_by_test_id('birthday-day')).to_have_attribute('aria-label', 'День рождения: 29')
        expect(page.get_by_test_id('birthday-month')).to_have_attribute('aria-label', 'Месяц рождения: Февраль')
        expect(page.get_by_test_id('birthday-year')).to_have_attribute('aria-label', 'Год рождения: 2000')
        footer = footer_geometry(page, width, height)
        page.get_by_test_id('birthday-clear').click()
        choose_birthday(page, width, height, footer, 2025)
        expect(page.get_by_test_id('birthday-error')).to_contain_text('должна существовать')
        expect(page.get_by_test_id('nickname-save')).to_be_disabled()
        assert stored_account(page) == saved, 'Invalid birthday must not replace the saved profile'
        page.screenshot(path=str(OUTPUT / f'registration-invalid-date-{width}.png'))
        page.get_by_test_id('birthday-clear').click()
        expect(page.get_by_test_id('birthday-error')).to_have_count(0)
        expect(page.get_by_test_id('birthday-day')).to_have_attribute('aria-label', 'День рождения: не выбрано')
        # Deselect gender too: both fields are optional, including when editing.
        page.get_by_test_id('profile-gender-female').click()
        expect(page.get_by_test_id('nickname-save')).to_be_enabled()
        footer_geometry(page, width, height, footer)
        page.get_by_test_id('nickname-save').click()
        expect(profile).to_be_visible()
        expect(profile.get_by_test_id('profile-birthday')).to_contain_text('Добавить')
        cleared = stored_account(page)
        assert cleared['profile']['birthDate'] is None and cleared['profile']['gender'] is None
        assert cleared['profile']['nickname'] == 'Тестовый гость'
        page.reload()
        expect(profile.get_by_test_id('profile-birthday')).to_contain_text('Добавить')
        assert stored_account(page) == cleared

        # Cancel partial unsaved edits without altering the persisted record.
        profile.get_by_test_id('profile-birthday').click()
        page.get_by_test_id('nickname-input').fill('Не сохранять')
        page.get_by_test_id('birthday-day').click()
        page.get_by_test_id('birthday-option-day-29').click()
        expect(page.get_by_test_id('nickname-save')).to_be_disabled()
        page.get_by_test_id('profile-fill-later').click()
        expect(profile).to_be_visible()
        assert stored_account(page) == cleared
        profile.get_by_test_id('demo-sign-out').click()
        expect(profile.get_by_text('Без входа в аккаунт', exact=True)).to_be_visible()
        assert stored_account(page) is None

        # Postponing a new profile keeps login, but must not save partial fields.
        profile.get_by_test_id('profile-sign-in').click()
        page.get_by_test_id('phone-input').fill(PHONE)
        page.get_by_test_id('request-otp').click()
        page.get_by_test_id('otp-input').fill('123456')
        page.get_by_test_id('confirm-otp').click()
        expect(page.get_by_test_id('screen-M04')).to_be_visible()
        untouched = stored_account(page)
        assert untouched['profile'] == {
            'nickname': '', 'birthDate': None, 'gender': None, 'completedAt': None,
        }
        page.get_by_test_id('nickname-input').fill('Отложенный профиль')
        page.get_by_test_id('birthday-day').click()
        page.get_by_test_id('birthday-option-day-29').click()
        page.get_by_test_id('profile-fill-later').click()
        expect(page.get_by_test_id('screen-M06')).to_be_visible()
        assert stored_account(page) == untouched, 'Skipping must not silently save a partial profile'
        page.reload()
        expect(page.get_by_test_id('screen-M06')).to_be_visible()
        page.goto(URL + '/profile')
        expect(profile.get_by_test_id('demo-sign-out')).to_be_visible()
        expect(profile.get_by_test_id('profile-birthday')).to_contain_text('Добавить')
        assert stored_account(page) == untouched
        assert page.evaluate('(key) => localStorage.getItem(key)', SESSION_KEY) == SESSION
        profile.get_by_test_id('demo-sign-out').click()
        page.reload()
        expect(profile.get_by_text('Без входа в аккаунт', exact=True)).to_be_visible()
        assert stored_account(page) is None
        assert page.evaluate('(key) => localStorage.getItem(key)', SESSION_KEY) == SESSION
        assert not mutations, mutations
        assert not failures, failures
        checks.append({'viewport': f'{width}x{height}', 'login_restore_logout': True,
                       'wrong_code_rejected': True, 'birthday_saved_and_cleared': True,
                       'invalid_leap_day_rejected': True, 'optional_gender': True,
                       'skip_and_cancel_preserve_profile': True, 'fixed_registration_actions': True,
                       'no_horizontal_overflow': True, 'server_identity_preserved': True})
        context.close()
    browser.close()

result = {'success': True, 'fixture_only': True, 'real_orders_created': 0,
          'sms_sent': 0, 'checks': checks}
(OUTPUT / 'verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps(result, ensure_ascii=False))
