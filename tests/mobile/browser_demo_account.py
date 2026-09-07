"""Local registration UX; all API traffic is intercepted, no SMS or VPS mutation."""
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

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


def open_birthday_picker(page, width, height, part='day'):
    page.get_by_test_id(f'birthday-{part}').click()
    expect(page.get_by_test_id('birthday-picker')).to_be_visible()
    field = page.get_by_test_id('birthday-native-input')
    expect(field).to_have_attribute('type', 'date')
    expect(field).to_have_attribute('min', '1900-01-01')
    expect(field).to_have_attribute('max', datetime.now(ZoneInfo('Asia/Almaty')).date().isoformat())
    for identifier in ['birthday-picker-confirm', 'birthday-picker-cancel']:
        button = page.get_by_test_id(identifier)
        expect(button).to_be_visible()
        rect = button.bounding_box()
        assert rect and rect['x'] >= 0 and rect['y'] >= 0, (identifier, rect)
        assert rect['x'] + rect['width'] <= width + 1, (identifier, rect)
        assert rect['y'] + rect['height'] <= height + 1, (identifier, rect)
    assert_no_horizontal_overflow(page, width)
    return field


def choose_birthday(page, width, height, footer, value, part='day'):
    field = open_birthday_picker(page, width, height, part)
    field.fill(value)
    expect(field).to_have_value(value)
    page.get_by_test_id('birthday-picker-confirm').click()
    expect(page.get_by_test_id('birthday-picker')).to_have_count(0)
    footer_geometry(page, width, height, footer)


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
        expect(page.get_by_test_id('screen-M04').get_by_text('@', exact=True)).to_have_count(0)
        page.get_by_test_id('nickname-input').fill('Тестовый гость')
        expect(page.get_by_test_id('nickname-input')).to_have_value('Тестовый гость')
        footer = footer_geometry(page, width, height)
        page.screenshot(path=str(OUTPUT / f'registration-empty-{width}.png'))
        choose_birthday(page, width, height, footer, '2000-02-29')
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

        # Design preview accepts visual edits but cannot mutate the live local
        # account or the independent ordering identity, even with valid fields.
        saved_raw = page.evaluate('(key) => localStorage.getItem(key)', PROFILE_KEY)
        page.goto(URL + '/screen/M04?preview=1')
        expect(page.get_by_test_id('screen-M04')).to_be_visible()
        page.get_by_test_id('nickname-input').fill('Только макет')
        preview_footer = footer_geometry(page, width, height)
        choose_birthday(page, width, height, preview_footer, '1995-10-21')
        expect(page.get_by_test_id('nickname-save')).to_be_disabled()
        assert page.evaluate('(key) => localStorage.getItem(key)', PROFILE_KEY) == saved_raw
        assert page.evaluate('(key) => localStorage.getItem(key)', SESSION_KEY) == SESSION
        page.goto(URL + '/screen/M02?preview=1')
        page.get_by_test_id('phone-input').fill(PHONE)
        expect(page.get_by_test_id('request-otp')).to_be_disabled()
        page.goto(URL + '/screen/M32?preview=1')
        expect(page.get_by_test_id('delete-demo-profile')).to_be_disabled()
        expect(page.get_by_test_id('clear-local-data')).to_be_disabled()
        assert page.evaluate('(key) => localStorage.getItem(key)', PROFILE_KEY) == saved_raw
        assert page.evaluate('(key) => localStorage.getItem(key)', SESSION_KEY) == SESSION
        page.goto(URL + '/profile')

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
        draft = open_birthday_picker(page, width, height, 'month')
        expect(draft).to_have_value('2000-02-29')
        draft.fill('2001-03-17')
        page.get_by_test_id('birthday-picker-cancel').click()
        expect(page.get_by_test_id('birthday-picker')).to_have_count(0)
        expect(page.get_by_test_id('birthday-day')).to_have_attribute('aria-label', 'День рождения: 29')
        expect(page.get_by_test_id('birthday-month')).to_have_attribute('aria-label', 'Месяц рождения: Февраль')
        expect(page.get_by_test_id('birthday-year')).to_have_attribute('aria-label', 'Год рождения: 2000')
        assert stored_account(page) == saved, 'Cancel must discard only the date picker draft'
        footer_geometry(page, width, height, footer)

        # The native date control cannot construct 31 February. Verify its
        # calendar bounds and reject a programmatically filled future date.
        draft = open_birthday_picker(page, width, height, 'year')
        future = (datetime.now(ZoneInfo('Asia/Almaty')).date() + timedelta(days=1)).isoformat()
        draft.fill(future)
        expect(draft).to_have_value(future)
        assert draft.evaluate('(input) => input.validity.rangeOverflow')
        expect(page.get_by_test_id('birthday-picker-confirm')).to_be_disabled()
        assert stored_account(page) == saved, 'A future date must not replace the saved profile'
        page.screenshot(path=str(OUTPUT / f'registration-future-date-{width}.png'))
        page.get_by_test_id('birthday-picker-cancel').click()
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

        # Cancel unsaved form edits after confirming a picker draft.
        profile.get_by_test_id('profile-birthday').click()
        page.get_by_test_id('nickname-input').fill('Не сохранять')
        footer = footer_geometry(page, width, height)
        choose_birthday(page, width, height, footer, '2004-05-20')
        page.get_by_test_id('profile-fill-later').click()
        expect(profile).to_be_visible()
        assert stored_account(page) == cleared
        profile.get_by_test_id('demo-sign-out').click()
        expect(profile.get_by_text('Без входа в аккаунт', exact=True)).to_be_visible()
        assert stored_account(page) is None

        # Postponing a new profile keeps login without silently saving fields.
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
        footer = footer_geometry(page, width, height)
        choose_birthday(page, width, height, footer, '2003-01-01')
        page.get_by_test_id('profile-fill-later').click()
        expect(page.get_by_test_id('screen-M06')).to_be_visible()
        assert stored_account(page) == untouched, 'Skipping must not silently save the draft profile'
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
                       'native_date_bounds_and_future_guard': True, 'date_picker_cancel': True,
                       'optional_gender': True,
                       'skip_and_cancel_preserve_profile': True, 'fixed_registration_actions': True,
                       'no_horizontal_overflow': True, 'preview_mutations_disabled': True,
                       'server_identity_preserved': True})
        context.close()
    browser.close()

result = {'success': True, 'fixture_only': True, 'real_orders_created': 0,
          'sms_sent': 0, 'checks': checks}
(OUTPUT / 'verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps(result, ensure_ascii=False))
