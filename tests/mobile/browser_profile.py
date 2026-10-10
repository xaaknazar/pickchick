"""Profile hierarchy, navigation and recovery on local fixtures; no live API writes."""
from browser_network import isolated_context, route_fixture
import json
import os
import time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4182').rstrip('/')
assert urlparse(URL).hostname in ('localhost', '127.0.0.1')
OUTPUT = Path('.local/profile-redesign')
OUTPUT.mkdir(parents=True, exist_ok=True)
KEY = 'pickchick.demo.profile.v1'
LONG_NAME = 'ТестовыйГостьСОченьДлиннымИменем'
ACCOUNT = {'version': 2, 'kind': 'local_demo', 'phone': '+7' + '7' + '0' * 8 + '1',
           'createdAt': int(time.time() * 1000),
           'profile': {'nickname': LONG_NAME, 'birthDate': None, 'gender': None,
                       'completedAt': int(time.time() * 1000)}}

with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in [(320, 568), (393, 852)]:
        context = isolated_context(browser,viewport={'width': width, 'height': height})
        errors, mutations = [], []
        def intercept(route):
            if route.request.method != 'GET':
                mutations.append(route.request.method + ' ' + urlparse(route.request.url).path)
            route.abort()
        route_fixture(context,'**/v1/**', intercept)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + '/profile')
        login = page.get_by_test_id('account-required-login').filter(visible=True)
        expect(login).to_be_visible()
        page.get_by_test_id('auth-close').click(trial=True)
        page.screenshot(path=str(OUTPUT / f'guest-{width}.png'))
        login.click()
        expect(page.get_by_test_id('phone-input').filter(visible=True)).to_be_visible()

        page.evaluate('([key, account]) => localStorage.setItem(key, JSON.stringify(account))', [KEY, ACCOUNT])
        page.goto(URL + '/profile')
        identity = page.get_by_test_id('profile-identity')
        expect(identity.get_by_text(LONG_NAME, exact=True)).to_be_visible()
        expect(page.get_by_test_id('profile-sign-in')).to_have_count(0)
        assert identity.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
        assert identity.get_by_text(LONG_NAME, exact=True).evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(OUTPUT / f'member-long-{width}.png'))
        page.get_by_test_id('profile-edit').click()
        expect(page.get_by_test_id('nickname-input').filter(visible=True)).to_have_value(LONG_NAME)
        page.goto(URL + '/profile')
        page.get_by_test_id('scroll-M30').evaluate('(e) => e.scrollTop = e.scrollHeight')
        page.screenshot(path=str(OUTPUT / f'settings-{width}.png'))
        page.get_by_test_id('demo-sign-out').click()
        # Sign-out is confirmed in a sheet; closing it keeps the account.
        expect(page.get_by_test_id('confirm-sheet')).to_contain_text('Выйти из профиля?')
        page.get_by_test_id('confirm-sheet-close').click()
        expect(page.get_by_test_id('confirm-sheet')).to_have_count(0)
        assert page.evaluate('(key) => localStorage.getItem(key)', KEY) is not None
        page.get_by_test_id('demo-sign-out').click()
        page.get_by_test_id('confirm-sheet-primary').click()
        expect(page.get_by_test_id('account-required-login').filter(visible=True)).to_be_visible()
        assert page.evaluate('(key) => localStorage.getItem(key)', KEY) is None
        assert not mutations, mutations
        assert not errors, errors
        context.close()

    broken = isolated_context(browser,viewport={'width': 393, 'height': 852})
    route_fixture(broken,'**/v1/**', lambda route: route.abort())
    broken.add_init_script('''const original = Storage.prototype.getItem;
        Storage.prototype.getItem = function(key) {
            if (key === 'pickchick.demo.profile.v1') throw new Error('Fixture read failure');
            return original.call(this, key);
        };''')
    page = broken.new_page()
    page.goto(URL + '/profile')
    expect(page.get_by_test_id('profile-restore-error')).to_be_visible()
    expect(page.get_by_test_id('profile-sign-in')).to_have_count(0)
    expect(page.get_by_test_id('profile-restore-retry')).to_be_visible()
    browser.close()
print('Profile guest/member layouts, long names, navigation, logout and unreadable-account recovery passed at 320/393; no API mutations')
