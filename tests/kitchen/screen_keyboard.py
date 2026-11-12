"""A kitchen monoblock has a touch screen and no keyboard. Everything here is typed on the
page's own keyboard against a real point server: the one-time code, the login, the password."""
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

fixture = json.loads(Path(sys.argv[1]).read_text())
url, width, height, mode = fixture['url'], fixture['width'], fixture['height'], fixture['mode']
assert urlparse(url).hostname == '127.0.0.1'
output = Path(fixture['output'])
PANEL = '.screen-keyboard-panel'
LAUNCHER = '.screen-keyboard-launcher'


def keys(page):
    return page.locator(PANEL + ' button[data-key="type"]').all_inner_texts()


def press(page, selector, touch=True):
    key = page.locator(PANEL + ' ' + selector).first
    key.tap() if touch else key.click()


def type_on_screen(page, text, touch=True):
    """Find every character the way a person does: language, register, then the symbols."""
    for character in text:
        if character == ' ':
            press(page, '[data-key="space"]', touch)
            continue
        if character not in keys(page):
            if character.isalpha():
                if page.locator(PANEL + ' [data-key="symbols"]').inner_text() != '#+=':
                    press(page, '[data-key="symbols"]', touch)
                if character.lower() not in [k.lower() for k in keys(page)]:
                    press(page, '[data-key="language"]', touch)
                for _ in range(2):
                    if character in keys(page):
                        break
                    press(page, '[data-key="shift"]', touch)
            else:
                press(page, '[data-key="symbols"]', touch)
        assert character in keys(page), f'No key for {character!r} among {keys(page)}'
        key = page.locator(PANEL + ' button[data-key="type"]').filter(
            has_text=re.compile('^' + re.escape(character) + '$')).first
        key.tap() if touch else key.click()


def keyboard_height(page):
    return page.evaluate(
        "getComputedStyle(document.documentElement).getPropertyValue('--screen-keyboard-height').trim()")


def above_keys(page, locator, what):
    """The thing being typed into is never under the keys."""
    box, panel = locator.bounding_box(), page.locator(PANEL).bounding_box()
    assert box and panel, what
    assert box['y'] >= 0 and box['y'] + box['height'] <= panel['y'] + 1, f'{what} is covered: {box} {panel}'
    assert panel['y'] + panel['height'] <= height + 1 and panel['x'] >= 0, f'Keys leave the screen: {panel}'
    assert abs(panel['width'] - width) <= 1, f'Keys do not span the screen: {panel}'
    for key in page.locator(PANEL + ' button').all():
        size = key.bounding_box()
        assert size['height'] >= 44 and size['width'] >= 44, f'Key too small to touch: {size}'


def closed(page):
    expect(page.locator(PANEL)).to_be_hidden()
    expect(page.locator(LAUNCHER)).to_be_hidden()
    expect(page.locator('html')).not_to_have_class(re.compile('screen-keyboard-open'))
    assert keyboard_height(page) in ('', '0px'), keyboard_height(page)


def capture(page, name):
    page.evaluate('async () => { await document.fonts.ready; await Promise.all([...document.images].map(i=>i.decode())); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); }')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow'
    page.screenshot(path=str(output / f'{width}-keyboard-{name}.png'))


def same_origin(context, origin=url):
    context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(origin + '/') else route.abort())


def pair(page):
    code = page.locator('#terminal-code')
    expect(code).to_be_visible()
    closed(page)
    code.tap()
    expect(page.locator(PANEL)).to_be_visible()
    expect(code).to_be_focused()
    expect(code).to_have_attribute('inputmode', 'none')
    type_on_screen(page, fixture['code'])
    expect(code).to_have_value(fixture['code'])
    above_keys(page, code, 'Pairing code')
    capture(page, 'pairing-code')
    # One field in the form: "Ввод" sends it.
    press(page, '[data-key="enter"]')
    expect(page.locator('#staff-login')).to_be_enabled()
    expect(page.locator('#terminal-code')).to_have_count(0)
    closed(page)


def session_check(page, answer):
    """The pairing check the page makes every 15 seconds, here and now."""
    if answer == 200:
        with page.expect_response(lambda r: r.url == url + '/edge/v1/terminals/session') as waited:
            page.clock.fast_forward(15000)
        assert waited.value.status == 200
    else:
        with page.expect_event('requestfailed', lambda r: r.url == url + '/edge/v1/terminals/session'):
            page.clock.fast_forward(15000)


with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={'width': width, 'height': height}, has_touch=True)
    same_origin(context)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.install()
    page.goto(url)
    pair(page)

    login, password = page.locator('#staff-login'), page.locator('#staff-password')
    login.tap()
    expect(page.locator(PANEL)).to_be_visible()
    type_on_screen(page, 'kitchen')
    expect(login).to_have_value('kitchen')
    above_keys(page, login, 'Login')
    # "Ввод" in the login goes to the password, like Tab on a real keyboard.
    press(page, '[data-key="enter"]')
    expect(password).to_be_focused()
    expect(page.locator(PANEL)).to_be_visible()
    secret = fixture['password']
    half = len(secret) // 2

    if mode == 'fit':
        type_on_screen(page, secret)
        expect(password).to_have_value(secret)
        above_keys(page, password, 'Password')
        above_keys(page, page.locator('#sign-in'), 'Sign-in button')
        capture(page, 'login')
    else:
        type_on_screen(page, secret[:half])
        expect(password).to_have_value(secret[:half])
        above_keys(page, password, 'Password')
        capture(page, 'login')
        # A steady answer of the 15 second check leaves the form alone: the very same field.
        password.evaluate("node => node.dataset.kept = 'yes'")
        session_check(page, 200)
        session_check(page, 200)
        expect(password).to_have_attribute('data-kept', 'yes')
        expect(password).to_have_value(secret[:half])
        expect(password).to_be_focused()
        # The password is shown, the symbols are open and the point server stops answering: the
        # screen is redrawn (the field is a new one), and nothing the person did is lost.
        page.locator('#password-toggle').tap()
        expect(password).to_have_attribute('type', 'text')
        expect(password).to_be_focused()
        press(page, '[data-key="symbols"]')
        expect(page.locator(PANEL + ' [data-key="symbols"]')).to_have_text('ABC')
        page.route('**/edge/v1/terminals/session', lambda route: route.abort('failed'))
        session_check(page, 'lost')
        expect(password).not_to_have_attribute('data-kept', 'yes')
        expect(password).to_have_value(secret[:half])
        expect(password).to_be_focused()
        expect(password).to_have_attribute('type', 'text')
        expect(page.locator('#password-toggle')).to_have_text('Скрыть')
        expect(page.locator('#password-toggle')).to_have_attribute('aria-pressed', 'true')
        assert password.evaluate('node => [node.selectionStart, node.selectionEnd]') == [half, half]
        expect(page.locator(PANEL)).to_be_visible()
        expect(page.locator(PANEL + ' [data-key="symbols"]')).to_have_text('ABC')
        expect(login).to_have_value('kitchen')
        # The outage goes on: no further redraw. Then the answer returns: one more redraw.
        password.evaluate("node => node.dataset.kept = 'again'")
        session_check(page, 'lost')
        expect(password).to_have_attribute('data-kept', 'again')
        page.unroute('**/edge/v1/terminals/session')
        session_check(page, 200)
        expect(password).not_to_have_attribute('data-kept', 'again')
        expect(password).to_have_value(secret[:half])
        expect(password).to_be_focused()
        # A wrong key is taken back with the erase key; the rest of the password follows.
        type_on_screen(page, '9')
        expect(password).to_have_value(secret[:half] + '9')
        press(page, '[data-key="backspace"]')
        expect(password).to_have_value(secret[:half])
        type_on_screen(page, secret[half:])
        expect(password).to_have_value(secret)
        page.locator('#password-toggle').tap()
        expect(password).to_have_attribute('type', 'password')
        expect(password).to_have_value(secret)

    # "Ввод" in the last field signs in. Before 12.11.2026 a paired screen got «Сессия истекла
    # или отозвана» here: the point server did not pass the screen key to the session check.
    press(page, '[data-key="enter"]')
    expect(page.locator('#logout')).to_be_visible()
    expect(page.locator('#refresh')).to_be_enabled()
    expect(page.locator('[data-station="' + fixture['prep'] + '"]')).to_be_visible()
    expect(page.get_by_role('alert')).to_have_count(0)
    closed(page)
    capture(page, 'signed-in')

    if mode == 'journey':
        # Signed out, the login is still there; the keys come back with a tap on a field.
        page.locator('#logout').tap()
        expect(login).to_have_value('kitchen')
        expect(password).to_have_value('')
        closed(page)
        # "Забыли пароль?" is a modal dialog: the keys move inside it, the dialog stays above.
        page.get_by_role('button', name='Забыли пароль?').tap()
        dialog = page.locator('dialog.password-reset')
        expect(dialog).to_be_visible()
        fields = dialog.locator('input')
        expect(fields.nth(0)).to_be_focused()
        expect(dialog.locator(PANEL)).to_be_visible()
        requests = []
        page.on('request', lambda r: requests.append(r.url) if r.method == 'POST' else None)
        type_on_screen(page, 'ab12-cd34')
        expect(fields.nth(0)).to_have_value('ab12-cd34')
        press(page, '[data-key="enter"]')
        expect(fields.nth(1)).to_be_focused()
        type_on_screen(page, 'Short-1')
        press(page, '[data-key="enter"]')
        expect(fields.nth(2)).to_be_focused()
        type_on_screen(page, 'Short-1')
        expect(fields.nth(2)).to_have_value('Short-1')
        above_keys(page, fields.nth(2), 'Field of the dialog')
        above_keys(page, dialog.get_by_role('button', name='Сохранить пароль'), 'Save button of the dialog')
        capture(page, 'password-reset')
        # The browser does not apply `minlength` to text from the screen keys, so the dialog
        # checks the length itself: a short password is refused in words and nothing is sent.
        press(page, '[data-key="enter"]')
        expect(dialog.get_by_role('alert')).to_have_text('Пароль должен быть от 12 до 128 символов.')
        expect(dialog).to_be_visible()
        assert requests == [], requests
        assert fields.nth(1).input_value() == 'Short-1', 'A refused form keeps what was typed'
        dialog.get_by_role('button', name='Отмена').tap()
        expect(dialog).to_have_count(0)
        closed(page)
        # Back on the page the keys work as before, and "Скрыть" puts them away until a tap.
        password.tap()
        expect(page.locator(PANEL)).to_be_visible()
        type_on_screen(page, 'x')
        press(page, '[data-key="hide"]')
        expect(page.locator(PANEL)).to_be_hidden()
        expect(page.locator(LAUNCHER)).to_be_visible()
        expect(password).to_be_focused()
        password.tap()
        expect(page.locator(PANEL)).to_be_visible()
        expect(password).to_have_value('x')
        # A tap outside every field: the keys and the button go away, the page gets its height back.
        page.locator('h2').first.tap()
        closed(page)
        assert not errors, errors
        context.close()

        # A workplace with a mouse and a real keyboard: only a small button, nothing opens by itself.
        desk = browser.new_context(viewport={'width': width, 'height': height})
        same_origin(desk)
        page = desk.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(url)
        code = page.locator('#terminal-code')
        code.click()
        expect(page.locator(LAUNCHER)).to_be_visible()
        expect(page.locator(PANEL)).to_be_hidden()
        assert code.get_attribute('inputmode') is None
        page.locator(LAUNCHER).click()
        expect(page.locator(PANEL)).to_be_visible()
        expect(code).to_be_focused()
        type_on_screen(page, 'a1', touch=False)
        expect(code).to_have_value('a1')
        page.keyboard.type('b')
        expect(code).to_have_value('a1b')
        expect(page.locator(PANEL)).to_be_hidden()
        expect(page.locator(LAUNCHER)).to_be_visible()
        code.click()
        expect(page.locator(PANEL)).to_be_hidden()
        page.keyboard.press('Tab')
        closed(page)
        desk.close()

        # A phone or a tablet has the keyboard of its system; the page adds nothing there.
        phone = browser.new_context(
            viewport={'width': 412, 'height': 915}, has_touch=True, is_mobile=True,
            user_agent='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36')
        same_origin(phone)
        page = phone.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(url)
        code = page.locator('#terminal-code')
        code.tap()
        expect(code).to_be_focused()
        assert page.locator('.screen-keyboard').count() == 0
        assert code.get_attribute('inputmode') is None
        phone.close()

        # A monoblock that was never linked: the form says so and does not look ready to type
        # in; a tap on a field brings no keys, because nothing can be typed there.
        fresh = browser.new_context(viewport={'width': width, 'height': height}, has_touch=True)
        same_origin(fresh, fixture['unlinked'])
        page = fresh.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(fixture['unlinked'])
        notice = page.locator('.setup-blocked')
        expect(notice).to_contain_text('Экран не подключён к серверу ресторана')
        expect(notice).to_contain_text('Настройку делает управляющий')
        for name in ['#staff-login', '#staff-password', '#password-toggle', '#sign-in']:
            expect(page.locator(name)).to_be_disabled()
        field = page.locator('#staff-login')
        assert field.evaluate("node => getComputedStyle(node).borderTopStyle") == 'dashed'
        assert field.evaluate("node => getComputedStyle(node).cursor") == 'not-allowed'
        page.touchscreen.tap(field.bounding_box()['x'] + 40, field.bounding_box()['y'] + 20)
        page.touchscreen.tap(notice.bounding_box()['x'] + 40, notice.bounding_box()['y'] + 10)
        closed(page)
        assert page.evaluate("document.activeElement === document.body")
        capture(page, 'not-linked')
        fresh.close()
    else:
        context.close()
    assert not errors, errors
    browser.close()
print(f'PASS paired kitchen screen by touch {width}x{height} {mode}: code, login, password, sign-in')
