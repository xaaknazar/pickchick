"""Paid cashier screens (cutover 19.11) against a synthetic edge: KS8, payments, approvals."""
import json
import re
import sys
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import expect, sync_playwright
from touch_layout import audit_touch_layout

fixture = json.loads(Path(sys.argv[1]).read_text())
url = fixture['url']
output = Path(fixture['output'])


def button(page, name, exact=True):
    return page.get_by_role('button', name=name, exact=exact)


def keys(page, scope, digits):
    for digit in digits:
        page.locator(scope).get_by_role('button', name=digit, exact=True).click()


def capture(page, name):
    page.evaluate('async () => { await document.fonts.ready; }')
    page.screenshot(path=str(output / name))


def no_long_dashes(page):
    text = page.locator('[data-pos]').inner_text()
    assert '\u2014' not in text and '\u2013' not in text, 'long dash in cashier text'


with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1920, 'height': 1080}, reduced_motion='reduce', has_touch=True)
    external = []

    def lan_only(route):
        if route.request.url.startswith(url + '/'):
            route.continue_()
        else:
            external.append(route.request.url)
            route.abort()

    context.route('**/*', lan_only)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        page.goto(url)
        for digit in '1357':
            button(page, digit).click()
        tile = page.get_by_role('button', name=re.compile('Тестовое комбо'))
        expect(tile).to_be_visible()

        # KS8: no default service mode, the pay button names what is missing.
        expect(page.get_by_test_id('sale-channels')).to_be_visible()
        tile.click()
        choose = button(page, 'Выберите: в зале или с собой')
        expect(choose).to_be_visible()
        choose.click()
        expect(page.locator('.pos-toast')).to_have_text('Выберите: в зале или с собой')
        expect(page.get_by_text('Повторите заказ гостю')).to_have_count(0)
        button(page, re.compile('^В ЗАЛЕ'), exact=False).click()
        capture(page, 'sale-order-1920.png')
        button(page, 'К ОПЛАТЕ · 3 490 ₸').click()

        # Repeat the order to the guest before payment.
        review = page.locator('.sale-review')
        expect(review.get_by_text('Повторите заказ гостю')).to_be_visible()
        expect(page.get_by_test_id('sale-review-type')).to_have_text('В ЗАЛЕ')
        expect(page.get_by_test_id('sale-review-total')).to_have_text('3 490 ₸')
        no_long_dashes(page)
        audit_touch_layout(page, output, 'sale-review', '.sale-review')
        button(page, 'Гость подтвердил - к оплате').click()

        # Cash with tendered amount and change.
        pay = page.locator('.sale-pay')
        expect(pay).to_be_visible()
        expect(pay.locator('.sale-hint')).to_have_text('Выберите способ оплаты')
        expect(page.get_by_test_id('sale-pay-confirm')).to_have_attribute('aria-disabled', 'true')
        for label in ('НАЛИЧНЫЕ', 'KASPI ТЕРМИНАЛ', 'KASPI ВРУЧНУЮ', 'СМЕШАННАЯ', 'CHOCOFOOD', 'ПИТАНИЕ СОТРУДНИКА', 'МАРКЕТИНГ'):
            expect(pay.get_by_role('button', name=re.compile(label))).to_be_visible()
        pay.get_by_role('button', name=re.compile('НАЛИЧНЫЕ')).click()
        keys(page, '.sale-pay .sale-keys', '5000')
        expect(page.get_by_test_id('sale-change')).to_have_text('1 510 ₸')
        audit_touch_layout(page, output, 'sale-pay-cash', '.sale-pay')
        for width, height in ((1366, 768), (1024, 600)):
            page.set_viewport_size({'width': width, 'height': height})
            capture(page, f'sale-pay-cash-{width}.png')
        page.set_viewport_size({'width': 1920, 'height': 1080})
        button(page, 'Принять 5 000 ₸ · сдача 1 510 ₸').click()

        # Done: number, pickup place, change and the Webkassa receipt number.
        expect(page.get_by_test_id('sale-done-number')).to_have_text('№27')
        expect(page.get_by_test_id('sale-done-pickup')).to_have_text('Забрать на выдаче')
        expect(page.get_by_test_id('sale-done-change')).to_have_text('Сдача 1 510 ₸')
        audit_touch_layout(page, output, 'sale-done', '.sale-done')
        page.get_by_test_id('sale-receipt').click()
        entry = page.locator('.sale-entry')
        for key in 'TEST-WK-1':
            entry.get_by_role('button', name=key, exact=True).click()
        expect(page.get_by_test_id('sale-entry-value')).to_have_text('TEST-WK-1')
        audit_touch_layout(page, output, 'sale-entry', '.sale-entry')
        entry.get_by_role('button', name='Готово', exact=True).click()
        button(page, 'Сохранить').click()
        expect(page.get_by_test_id('sale-fiscal-note')).to_have_text('Чек Webkassa №TEST-WK-1 сохранён')
        capture(page, 'sale-done-1920.png')
        button(page, 'Новый заказ').click()

        # Aggregator: channel, its number, channel price, always takeaway, delivery pickup.
        tile.click()
        page.get_by_test_id('sale-channels').get_by_role('button', name='ЯНДЕКС ЕДА', exact=True).click()
        button(page, 'Введите номер заказа агрегатора').click()
        entry = page.locator('.sale-entry')
        expect(entry.get_by_text('Номер заказа Яндекс Еды', exact=True)).to_be_visible()
        for key in 'YA-123':
            entry.get_by_role('button', name=key, exact=True).click()
        entry.get_by_role('button', name='Готово', exact=True).click()
        expect(page.get_by_test_id('sale-external-ref')).to_contain_text('YA-123')
        capture(page, 'sale-order-aggregator-1920.png')
        button(page, 'К ОПЛАТЕ · 3 490 ₸').click()
        expect(page.get_by_test_id('sale-review-type')).to_have_text('ДОСТАВКА · ЯНДЕКС ЕДА №YA-123')
        expect(page.get_by_test_id('sale-review-total')).to_have_text('3 590 ₸')
        button(page, 'Гость подтвердил - к оплате').click()
        expect(page.get_by_test_id('sale-aggregator-note')).to_have_text(
            'Заказ оплачен в Яндекс Еде №YA-123 - деньги придут от агрегатора.')
        button(page, 'Провести заказ Яндекс Еды').click()
        expect(page.get_by_test_id('sale-done-pickup')).to_have_text('Выдача доставки · Яндекс Еда №YA-123')
        expect(page.get_by_test_id('sale-fiscal-note')).to_have_text('Чек Webkassa для этого способа оплаты не нужен')
        button(page, 'Новый заказ').click()

        # Staff meal: beneficiary and the shift manager PIN in its own modal.
        tile.click()
        button(page, re.compile('^С СОБОЙ'), exact=False).click()
        button(page, 'К ОПЛАТЕ · 3 490 ₸').click()
        button(page, 'Гость подтвердил - к оплате').click()
        page.locator('.sale-pay').get_by_role('button', name=re.compile('ПИТАНИЕ СОТРУДНИКА')).click()
        page.locator('.sale-pay').get_by_role('button', name=re.compile('^Кому')).click()
        entry = page.locator('.sale-entry')
        for key in 'АЙГЕРИМ':
            entry.get_by_role('button', name=key, exact=True).click()
        expect(page.get_by_test_id('sale-entry-value')).to_have_text('Айгерим')
        entry.get_by_role('button', name='Готово', exact=True).click()
        page.get_by_test_id('sale-approval').click()
        pin = page.locator('.sale-pin')
        expect(pin.get_by_text('Питание сотрудника · 3 490 ₸')).to_be_visible()
        audit_touch_layout(page, output, 'sale-pin', '.sale-pin')
        keys(page, '.sale-pin', '1111')
        expect(pin.get_by_text('Неверный PIN или нет прав начальника смены')).to_be_visible()
        keys(page, '.sale-pin', '2468')
        expect(pin).to_have_count(0)
        expect(page.get_by_test_id('sale-approval')).to_contain_text('Подтвердил: Тестовый начальник')
        no_long_dashes(page)
        button(page, 'Провести питание сотрудника').click()
        expect(page.get_by_test_id('sale-done-number')).to_have_text('№29')
        button(page, 'Новый заказ').click()

        # An edge without pos/config (404): today's unpaid cashier, exactly as before.
        urlopen(fixture['control'] + '/legacy').read()
        page.reload()
        tile = page.get_by_role('button', name=re.compile('Тестовое комбо'))
        expect(tile).to_be_visible()
        expect(page.get_by_test_id('sale-channels')).to_have_count(0)
        tile.click()
        button(page, 'НА КУХНЮ · 3 490 ₸').click()
        expect(page.locator('[data-screen-label="D Оплата"]')).to_be_visible()
        expect(page.locator('.payment-modal')).to_contain_text('ПЕРЕДАЧА ЗАКАЗА')
        expect(button(page, 'ПЕРЕДАТЬ БЕЗ ОПЛАТЫ')).to_be_visible()
        expect(page.locator('.sale-pay')).to_have_count(0)
        capture(page, 'legacy-pay-1920.png')
        assert not errors, errors
        assert not external, external
    finally:
        browser.close()
