"""KDS-5 screens on a real temporary edge: 6, 5, table 1, issue 2, table 2, courier 3 (synthetic data)."""
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

fixture = json.loads(Path(sys.argv[1]).read_text())
url, width, height = fixture['url'], fixture['width'], fixture['height']
stations, orders = fixture['stations'], fixture['orders']
assert urlparse(url).hostname == '127.0.0.1'
output = Path(fixture['output'])
LONG_DASHES = re.compile('[\u2012-\u2015\u2212]')


def capture(page, name):
    page.evaluate('async () => { await document.fonts.ready; await Promise.all([...document.images].map(i=>i.decode())); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); }')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow on ' + name
    text = page.locator('body').inner_text()
    assert not LONG_DASHES.search(text), 'Long dash in UI text on ' + name
    page.screenshot(path=str(output / f'{width}-kds-{name}.png'))


def big(locator, min_height=64, min_width=120):
    box = locator.bounding_box()
    assert box and box['height'] >= min_height and box['width'] >= min_width, f'Touch target too small: {box}'


def settle(page):
    expect(page.locator('#refresh')).to_be_enabled()


def login(page, actor):
    page.locator('details.login-service').evaluate('(node) => node.open = true')
    page.locator('#credential').set_input_files({'name': 'synthetic-staff.json', 'mimeType': 'application/json', 'buffer': json.dumps(actor).encode()})
    expect(page.locator('#logout')).to_be_visible()
    settle(page)


def tabs(page, first, second):
    buttons = page.locator('[data-station]')
    expect(buttons).to_have_count(2)
    expect(buttons.nth(0)).to_have_attribute('data-station', first)
    expect(buttons.nth(1)).to_have_attribute('data-station', second)
    expect(buttons.nth(0)).to_have_attribute('aria-pressed', 'true')
    for i in range(2):
        big(buttons.nth(i), 72, 200)


def act(page, button):
    expect(button).to_be_enabled()
    big(button)
    button.tap()
    settle(page)


def ticket(page, key):
    return page.locator(f'[data-order="{orders[key]["id"]}"]')


with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={'width': width, 'height': height}, has_touch=True)
    context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(url + '/') else route.abort())
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(url)

    # Terminal 6+5: two prep tabs, breading first.
    login(page, fixture['cook'])
    tabs(page, stations['breading'], stations['toasts'])
    expect(page.locator('main[data-kds="breading"]')).to_be_visible()
    expect(page.get_by_test_id('kds-summary')).to_contain_text('3 заказа')
    expect(page.get_by_test_id('total-fingers')).to_have_text('14')
    for key in ['cloud', 'hall', 'glovo']:
        expect(page.locator(f'[data-breading="{orders[key]["id"]}"]')).to_be_visible()
    expect(page.locator(f'[data-breading="{orders["yandex"]["id"]}"]')).to_have_count(0)
    assert page.locator('main[data-kds="breading"] [data-command]').count() == 0, 'Station 6 has no buttons'
    expect(page.locator(f'[data-breading="{orders["glovo"]["id"]}"]')).to_contain_text('ДОСТАВКА · Glovo G-456')
    capture(page, '6-breading')

    page.locator(f'[data-station="{stations["toasts"]}"]').tap()
    expect(page.locator('main[data-kds="toasts"]')).to_be_visible()
    settle(page)
    summary = page.get_by_test_id('kds-summary')
    expect(summary).to_contain_text('Нужно сейчас')
    expect(summary).to_contain_text('Бургеры')
    for key in ['cloud', 'hall', 'glovo', 'yandex']:
        expect(ticket(page, key)).to_be_visible()
    expect(ticket(page, 'cloud')).to_contain_text('Отдать: Сборка - зал (стол 1)')
    expect(ticket(page, 'glovo')).to_contain_text('Отдать: Сборка - доставка (стол 2)')
    capture(page, '5-toasts')
    act(page, ticket(page, 'cloud').get_by_role('button', name='Готово', exact=True))
    expect(ticket(page, 'cloud')).to_have_count(0)
    page.locator('#logout').click()

    # Morning terminal: table 1 and issue as tabs.
    login(page, fixture['packer'])
    tabs(page, stations['assembly_hall'], stations['issue'])
    expect(page.locator('main[data-kds="assembly_hall"]')).to_be_visible()
    expect(ticket(page, 'cloud')).to_contain_text('Бургер: готов ✓')
    expect(ticket(page, 'hall')).to_contain_text('ждём')
    expect(ticket(page, 'hall')).to_contain_text('Напитки и соусы - на выдаче')
    expect(ticket(page, 'glovo')).to_have_count(0)
    capture(page, 'table1')
    for key in ['cloud', 'hall']:
        act(page, ticket(page, key).get_by_role('button', name='Собран', exact=True))
        expect(ticket(page, key)).to_have_count(0)

    page.locator(f'[data-station="{stations["issue"]}"]').tap()
    expect(page.locator('main[data-kds="issue"]')).to_be_visible()
    settle(page)
    preparing = page.locator('[data-column="preparing"]')
    for key in ['cloud', 'hall', 'glovo']:
        expect(preparing.locator(f'[data-order="{orders[key]["id"]}"]')).to_be_visible()
    expect(ticket(page, 'yandex')).to_have_count(0)
    expect(ticket(page, 'hall')).to_contain_text('Сборка: собран ✓')
    expect(ticket(page, 'hall')).to_contain_text('Подготовить на выдаче')
    act(page, ticket(page, 'glovo').get_by_role('button', name='Напитки переданы', exact=True))
    expect(ticket(page, 'glovo')).to_have_count(0)
    for key in ['cloud', 'hall']:
        act(page, ticket(page, key).get_by_role('button', name='Готов - позвать гостя', exact=True))
        expect(page.locator(f'[data-column="ready"] [data-order="{orders[key]["id"]}"]')).to_be_visible()
    capture(page, 'issue')
    act(page, ticket(page, 'hall').get_by_role('button', name='Выдан', exact=True))
    expect(ticket(page, 'hall')).to_have_count(0)

    # The guest board shows the hall order and never an aggregator order.
    page.locator('#mode-display').click()
    expect(page.get_by_test_id('display')).to_be_visible()
    expect(page.locator('.ready .numbers')).to_contain_text(orders['cloud']['number'])
    board = page.get_by_test_id('display').inner_text()
    for key in ['glovo', 'yandex']:
        assert not re.search(r'(?<!\d)' + orders[key]['number'] + r'(?!\d)', board), 'Delivery order on the guest board'
    page.locator('#mode-kitchen').click()
    settle(page)
    page.locator('#logout').click()

    # Table 2 with the courier counter (3) as its second tab.
    login(page, fixture['runner'])
    tabs(page, stations['assembly_delivery'], stations['delivery_handover'])
    expect(page.locator('main[data-kds="assembly_delivery"]')).to_be_visible()
    expect(ticket(page, 'glovo')).to_contain_text('ДОСТАВКА · Glovo G-456')
    expect(ticket(page, 'yandex')).to_contain_text('ДОСТАВКА · Яндекс Еда Y-123')
    capture(page, 'table2')
    for key in ['glovo', 'yandex']:
        act(page, ticket(page, key).get_by_role('button', name='Собран', exact=True))
        expect(ticket(page, key)).to_have_count(0)

    page.locator(f'[data-station="{stations["delivery_handover"]}"]').tap()
    expect(page.locator('main[data-kds="delivery_handover"]')).to_be_visible()
    settle(page)
    for key in ['glovo', 'yandex']:
        act(page, ticket(page, key).get_by_role('button', name='Принять от сборки', exact=True))
        expect(ticket(page, key).get_by_role('button', name='Передать курьеру', exact=True)).to_be_enabled()
    number = page.locator('#courier-number')
    big(number, 64, 200)
    number.fill('g-456')
    expect(ticket(page, 'yandex')).to_have_count(0)
    expect(ticket(page, 'glovo')).to_have_class(re.compile('courier-match'))
    expect(number).to_be_focused()
    expect(number).to_have_value('g-456')
    # The same number on the screen keys of a monoblock without a keyboard. The screen is
    # redrawn after every character: the keys, the focus and the upper case all stay.
    page.locator('#courier-clear').tap()
    expect(number).to_have_value('')
    expect(number).to_be_focused()
    keys = page.locator('.screen-keyboard-panel')
    expect(keys).to_be_visible()
    expect(keys.locator('[data-key="shift"]')).to_have_attribute('aria-pressed', 'true')
    for character in 'G-456':
        keys.locator('button[data-key="type"]').filter(has_text=re.compile('^' + re.escape(character) + '$')).first.tap()
    expect(number).to_have_value('G-456')
    expect(number).to_be_focused()
    expect(keys).to_be_visible()
    expect(keys.locator('[data-key="shift"]')).to_have_attribute('aria-pressed', 'true')
    assert number.bounding_box()['y'] + number.bounding_box()['height'] <= keys.bounding_box()['y'] + 1, 'Field under the keys'
    expect(ticket(page, 'yandex')).to_have_count(0)
    expect(ticket(page, 'glovo')).to_have_class(re.compile('courier-match'))
    ticket(page, 'glovo').get_by_role('button', name='Передать курьеру', exact=True).tap()
    dialog = page.locator('dialog.courier-dialog')
    expect(dialog).to_be_visible()
    expect(dialog).to_contain_text('Передача курьеру Glovo G-456')
    expect(page.locator('#mark-numberMatched')).to_be_checked()
    confirm = page.locator('#handover-confirm')
    expect(confirm).to_be_disabled()
    for mark in dialog.locator('.courier-mark').all():
        big(mark, 64, 300)
    dialog.locator('.courier-mark').nth(1).tap()
    expect(confirm).to_be_disabled()
    dialog.locator('.courier-mark').nth(2).tap()
    expect(confirm).to_be_enabled()
    capture(page, '3-handover')
    confirm.tap()
    expect(dialog).to_have_count(0)
    settle(page)
    expect(ticket(page, 'glovo')).to_have_count(0)

    # Courier refusal: recorded once, the manager banner appears.
    page.locator('#courier-clear').tap()
    expect(number).to_have_value('')
    ticket(page, 'yandex').get_by_role('button', name='Отказ по протоколу', exact=True).tap()
    form = page.locator('dialog.courier-dialog')
    expect(form).to_contain_text('Не вводите телефоны')
    expect(page.locator('#incident-provider')).to_have_value('yandex_eda')
    expect(page.locator('#incident-number')).to_have_value('Y-123')
    page.locator('#incident-kind').select_option('courier_refused')
    # Free Russian text: the screen keys open inside the dialog with Russian letters, the first
    # one a capital.
    page.locator('#incident-description').tap()
    keys = form.locator('.screen-keyboard-panel')
    expect(keys).to_be_visible()
    for character in 'Ку':
        keys.locator('button[data-key="type"]').filter(has_text=re.compile('^' + re.escape(character) + '$')).first.tap()
    expect(page.locator('#incident-description')).to_have_value('Ку')
    page.locator('#incident-description').fill('Курьер отказался, просил звонить +7 700 000 00 00')
    page.locator('#incident-save').tap()
    expect(form).to_contain_text('Уберите номер телефона из описания')
    page.locator('#incident-description').fill('Курьер отказался забирать заказ без пакета')
    capture(page, '3-incident')
    page.locator('#incident-save').tap()
    expect(form).to_have_count(0)
    settle(page)
    banner = page.get_by_test_id('incident-banner')
    expect(banner).to_contain_text('Менеджер вызван', timeout=15000)
    expect(banner).to_contain_text('Y-123')
    expect(ticket(page, 'yandex')).to_be_visible()
    capture(page, '3-banner')
    page.locator('#logout').click()

    # Aggregator order admitted before enable, on the old assembly station: the shift manager
    # hands it over with the same three-marks dialog (no plain handoff for a delivery ticket).
    login(page, fixture['manager'])
    page.locator(f'[data-station="{fixture["oldAssembly"]}"]').tap()
    settle(page)
    expect(ticket(page, 'early')).to_be_visible()
    assert ticket(page, 'early').locator('[data-command]').count() == 0, 'No plain handoff'
    handover = ticket(page, 'early').get_by_role('button', name='Передать курьеру', exact=True)
    expect(handover).to_be_enabled()
    handover.tap()
    dialog = page.locator('dialog.courier-dialog')
    expect(dialog).to_contain_text('Передача курьеру Glovo G-100')
    confirm = page.locator('#handover-confirm')
    for i in range(3):
        expect(confirm).to_be_disabled()
        dialog.locator('.courier-mark').nth(i).tap()
    expect(confirm).to_be_enabled()
    capture(page, 'old-station-handover')
    confirm.tap()
    expect(dialog).to_have_count(0)
    settle(page)
    expect(ticket(page, 'early')).to_have_count(0)
    # No logout: the test reads the result with this manager session afterwards.
    assert not errors, errors
    context.close()
    browser.close()
print(f'PASS KDS screens {width}x{height}: 6, 5, table 1, issue 2, table 2, courier 3, marks, refusal, board, old-station handover')
