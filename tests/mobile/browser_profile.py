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
        # Owner 27.10.2026: a guest's header profile button opens the same auth gate.
        page.goto(URL + '/menu')
        page.get_by_test_id('screen-M06').get_by_test_id('header-profile').click()
        expect(page.get_by_test_id('account-required-login').filter(visible=True)).to_be_visible()
        expect(page.get_by_test_id('screen-M30')).to_have_count(0)
        # A double tap opens the sign-in sheet once; the second tap lands on its backdrop (or,
        # on notched phones, «Поддержка») while it slides in and must not close or leave it.
        page.goto(URL + '/menu')
        page.get_by_test_id('screen-M06').get_by_test_id('header-profile').dblclick()
        page.wait_for_timeout(700)
        expect(page.get_by_test_id('account-required-login').filter(visible=True)).to_be_visible()
        expect(page.get_by_test_id('auth-sheet')).to_have_count(1)
        assert urlparse(page.url).path == '/auth', page.url
        # Old links to /profile still open the (gated) profile.
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
        # The profile is a stack screen opened from the header; notifications live inside it.
        page.goto(URL + '/menu')
        page.get_by_test_id('screen-M06').get_by_test_id('header-profile').click()
        expect(page.get_by_test_id('screen-M30')).to_be_visible()
        assert urlparse(page.url).path == '/profile', page.url
        expect(page.get_by_test_id('floating-tab-bar').filter(visible=True)).to_have_count(0)
        row = page.get_by_test_id('profile-notifications')
        expect(row).to_be_visible()
        expect(row).to_contain_text('Уведомления')
        expect(page.get_by_test_id('profile-notifications-count')).to_have_count(0)
        box = row.bounding_box()
        assert box['y'] < page.get_by_test_id('profile-orders').bounding_box()['y'], box
        assert box['y'] + box['height'] <= height and box['height'] >= 44, box
        back = page.get_by_test_id('profile-back')
        assert back.bounding_box()['width'] >= 44 and back.bounding_box()['height'] >= 44
        expect(back).to_have_accessible_name('Назад')
        page.screenshot(path=str(OUTPUT / f'header-entry-{width}.png'))
        row.click()
        expect(page.get_by_test_id('notifications-screen')).to_be_visible()
        expect(page.get_by_test_id('notifications-back')).to_have_accessible_name('Назад в профиль')
        page.get_by_test_id('notifications-back').click()
        expect(page.get_by_test_id('screen-M30')).to_be_visible()
        assert urlparse(page.url).path == '/profile', page.url
        back.click()
        expect(page.get_by_test_id('screen-M06')).to_be_visible()
        expect(page.get_by_test_id('screen-M30')).to_have_count(0)
        assert urlparse(page.url).path == '/menu', page.url
        page.get_by_test_id('screen-M06').get_by_test_id('header-profile').click()
        expect(page.get_by_test_id('screen-M30')).to_be_visible()
        page.get_by_test_id('profile-edit').click()
        expect(page.get_by_test_id('nickname-input').filter(visible=True)).to_have_value(LONG_NAME)
        # Saving the edit returns to the same profile screen, not a second copy of it.
        page.get_by_test_id('nickname-save').filter(visible=True).click()
        expect(page.get_by_test_id('screen-M30')).to_be_visible()
        expect(page.get_by_test_id('screen-M30')).to_have_count(1)
        page.get_by_test_id('profile-back').click()
        expect(page.get_by_test_id('screen-M06')).to_be_visible()
        expect(page.get_by_test_id('screen-M30')).to_have_count(0)
        # A double tap on the header opens the profile once on every tab. The settings button
        # sits right under the header button, so the second tap must not press it.
        for route, screen in [('menu', 'M06'), ('events', 'M26'), ('orders', 'M19')]:
            page.goto(URL + '/' + route)
            header = page.get_by_test_id('screen-' + screen).get_by_test_id('header-profile')
            expect(header).to_be_visible(timeout=20000)
            under = header.bounding_box()
            header.dblclick()
            expect(page.get_by_test_id('screen-M30')).to_be_visible()
            page.wait_for_timeout(700)
            assert urlparse(page.url).path == '/profile', (route, page.url)
            expect(page.get_by_test_id('screen-M34')).to_have_count(0)
            expect(page.get_by_test_id('screen-M30')).to_have_count(1)
            settings = page.get_by_test_id('profile-settings').bounding_box()
            assert abs(settings['x'] - under['x']) <= 1 and abs(settings['y'] - under['y']) <= 1, (settings, under)
            if route == 'menu':
                # Once the push has settled, settings works as before.
                page.get_by_test_id('profile-settings').click()
                expect(page.get_by_test_id('screen-M34')).to_be_visible()
                page.go_back()
                expect(page.get_by_test_id('screen-M30')).to_be_visible()
            # One profile on the stack: a single back returns to the tab.
            page.get_by_test_id('profile-back').click()
            expect(page.get_by_test_id('screen-M30')).to_have_count(0)
            expect(page.get_by_test_id('screen-' + screen)).to_be_visible()
            assert urlparse(page.url).path == '/' + route, (route, page.url)
        page.goto(URL + '/profile')
        page.get_by_test_id('scroll-M30').evaluate('(e) => e.scrollTop = e.scrollHeight')
        page.screenshot(path=str(OUTPUT / f'settings-{width}.png'))
        page.get_by_test_id('demo-sign-out').click()
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
print('Profile guest/member layouts, header entry and auth gate, double tap on every tab (one profile, no settings, '
      'sign-in stays open), notifications row and back, long names, navigation, logout and unreadable-account '
      'recovery passed at 320/393; no API mutations')
