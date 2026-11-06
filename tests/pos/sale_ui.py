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


PAID_LOCK = 'Вход по личному PIN · Pick Chick POS 0.5.0'
TEST_LOCK = 'Вход по личному PIN · Pick Chick POS 0.4 · TEST'
HINT = "() => localStorage.getItem('pickchick.pos.desk-mode.v1')"


def paid_lock(page):
    """CR client-5: the lock screen of a desk that sells: no desk number, no TEST, real version."""
    expect(page.locator('.pin-connection')).to_have_text(PAID_LOCK)
    expect(page.get_by_text(re.compile('Касса 1|TEST'))).to_have_count(0)


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
        # A desk never told by its edge (no session yet): today's lock texts until the first login.
        expect(page.locator('.pin-connection')).to_have_text(TEST_LOCK)
        assert page.evaluate(HINT) is None
        for digit in '1357':
            button(page, digit).click()
        tile = page.get_by_role('button', name=re.compile('Тестовое комбо'))
        expect(tile).to_be_visible()
        # CR client-5: a desk that sells names no test mode and no wrong desk number.
        expect(page.get_by_text('Кассир', exact=True).first).to_be_visible()
        expect(page.get_by_text(re.compile('касса 1', re.I))).to_have_count(0)
        assert page.evaluate(HINT) == 'pos_sale'
        button(page, 'Промокод').click()
        expect(page.locator('.pos-toast')).to_have_text('Эта функция пока не подключена.')

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
        # The browser cashier has no printer bridge: the ticket is not printed, the sale stands.
        page.get_by_test_id('sale-done-print').click()
        expect(page.locator('.pos-toast')).to_have_text('Печать не настроена')
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
        # The edge said 404: today's texts again, and the lock screen will show them too.
        expect(page.get_by_text('Кассир · касса 1', exact=True).first).to_be_visible()
        assert page.evaluate(HINT) == 'unpaid'
        capture(page, 'legacy-pay-1920.png')
        expect(page.locator('.bottom-nav').get_by_role('button', name=re.compile('ЧЕКИ WEBKASSA'))).to_have_count(0)
        page.keyboard.press('Escape')

        # Part B on an edge that sells again: refund, void, Webkassa tab, X report, closing.
        urlopen(fixture['control'] + '/paid').read()
        page.reload()
        expect(page.get_by_test_id('sale-channels')).to_be_visible()
        nav = page.locator('.bottom-nav')

        def open_order(number):
            nav.get_by_role('button', name=re.compile('^ЗАКАЗЫ')).click()
            row = page.locator('.order-table-row', has=page.get_by_text(number, exact=True))
            row.get_by_role('button', name='Открыть').click()
            expect(page.get_by_test_id('ops-card-title')).to_have_text('Заказ №' + number)

        # CR client-5: each paid row says its Webkassa sale receipt as the X report counts it,
        # read again after the reload; «Чек» opens the card and prints the order ticket.
        nav.get_by_role('button', name=re.compile('^ЗАКАЗЫ')).click()
        def order_row(number):
            return page.locator('.order-table-row', has=page.get_by_text(number, exact=True))
        expect(order_row('27')).to_contain_text('чек: оформлен', timeout=10000)
        expect(order_row('28')).to_contain_text('чек: не нужен', timeout=10000)
        expect(order_row('29')).to_contain_text('чек: не нужен', timeout=10000)
        for number in ('27', '28', '29'):
            # The whole state is readable in the 148px column: never cut with an ellipsis.
            label = order_row(number).get_by_text(re.compile('^чек: '))
            assert label.evaluate('(e) => e.scrollWidth <= e.clientWidth'), number
        for number in ('27', '28', '29'):
            expect(order_row(number)).not_to_contain_text('без чека')
            expect(order_row(number)).not_to_contain_text('ТЕСТ')
        capture(page, 'orders-paid-1920.png')
        order_row('28').get_by_role('button', name='Чек', exact=True).click()
        expect(page.get_by_test_id('ops-card-title')).to_have_text('Заказ №28')
        expect(page.locator('.pos-toast')).to_have_text('Печать не настроена')
        expect(page.get_by_test_id('ops-card-receipt').first).to_contain_text('Чек продажи · 3 590 ₸ · не нужен')
        page.locator('.ops-card .sale-actions').get_by_role('button', name='Закрыть', exact=True).click()

        # Refund of the cash order by its tender, with the shift manager PIN.
        open_order('27')
        card = page.locator('.ops-card')
        expect(page.get_by_test_id('ops-card-status')).to_contain_text('оплачен')
        card.get_by_role('button', name='Возврат', exact=True).click()
        card.get_by_role('button', name='Всё', exact=True).click()
        card.get_by_role('button', name='Качество блюда', exact=True).click()
        no_long_dashes(page)
        audit_touch_layout(page, output, 'ops-refund', '.ops-card')
        confirm = page.get_by_test_id('ops-confirm')
        expect(confirm).to_have_text('Вернуть 3 490 ₸ · PIN начальника смены')
        confirm.click()
        pin = page.locator('.sale-pin')
        expect(pin.get_by_text('Возврат по заказу №27 · 3 490 ₸')).to_be_visible()
        keys(page, '.sale-pin', '2468')
        expect(pin).to_have_count(0)
        expect(page.get_by_test_id('ops-card-refund')).to_contain_text('Возврат')
        expect(page.get_by_test_id('ops-card-refund')).to_contain_text('-3 490 ₸')
        expect(page.get_by_test_id('ops-card-receipt').nth(1)).to_contain_text('Чек возврата · 3 490 ₸ · не оформлен')
        expect(page.get_by_test_id('ops-card-note')).to_have_text('Деньги по заказу возвращены полностью.')
        capture(page, 'ops-card-refund-1920.png')
        card.locator('.sale-actions').get_by_role('button', name='Закрыть', exact=True).click()

        # Void of the aggregator order before the kitchen starts.
        open_order('28')
        card.get_by_role('button', name='Отменить заказ', exact=True).click()
        card.get_by_role('button', name='Агрегатор отменил', exact=True).click()
        confirm.click()
        keys(page, '.sale-pin', '2468')
        expect(pin).to_have_count(0)
        expect(page.get_by_test_id('ops-card-status')).to_contain_text('Отменён')
        card.locator('.sale-actions').get_by_role('button', name='Закрыть', exact=True).click()

        # The refund receipt in the Webkassa tab, recorded from the list.
        webkassa = nav.get_by_role('button', name=re.compile('ЧЕКИ WEBKASSA'))
        expect(webkassa).to_contain_text('1')
        webkassa.click()
        expect(page.get_by_test_id('ops-fiscal-title')).to_have_text('Не оформлено: 1 на 3 490 ₸')
        row = page.get_by_test_id('ops-fiscal-row')
        expect(row).to_contain_text('№27')
        expect(row).to_contain_text('Возврат')
        audit_touch_layout(page, output, 'ops-fiscal', '.ops-tab')
        capture(page, 'ops-fiscal-1920.png')
        row.get_by_role('button', name='Внести номер').click()
        entry = page.locator('.sale-entry')
        for key in 'TEST-WK-2':
            entry.get_by_role('button', name=key, exact=True).click()
        entry.get_by_role('button', name='Готово', exact=True).click()
        expect(page.get_by_test_id('ops-fiscal-title')).to_have_text('Все чеки оформлены')

        # Shift tab: real money and the X report; no printer is configured here.
        nav.get_by_role('button', name=re.compile('^СМЕНА')).click()
        expect(page.get_by_text('Чеки: вручную в Webkassa · не оформлено: 0')).to_be_visible()
        expect(page.get_by_text('Тестовые заказы без оплаты')).to_have_count(0)
        button(page, 'X-отчёт · печать').click()
        expect(page.get_by_test_id('ops-report-title')).to_have_text('X-отчёт PickChick (не фискальный)')
        no_long_dashes(page)
        capture(page, 'ops-x-report-1920.png')
        page.locator('.ops-report').get_by_role('button', name='Печать', exact=True).click()
        expect(page.locator('.pos-toast')).to_have_text('Печать не настроена')
        page.locator('.ops-report').get_by_role('button', name='Закрыть', exact=True).click()

        # Closing: the shift manager signs in, counts the drawer, types the terminal total.
        button(page, 'Сменить кассира').click()
        for digit in '2468':
            button(page, digit).click()
        expect(nav).to_be_visible()
        nav.get_by_role('button', name=re.compile('^СМЕНА')).click()
        button(page, 'Закрыть смену').click()
        close = page.locator('.ops-close')
        step = page.get_by_test_id('ops-close-step')
        expect(step).to_have_text('1 · Сводка смены')
        audit_touch_layout(page, output, 'ops-close', '.ops-close')
        page.get_by_test_id('ops-close-next').click()
        expect(step).to_have_text('2 · Пересчитайте наличные')
        keys(page, '.ops-close .sale-keys', '20000')
        expect(page.get_by_test_id('ops-close-diff')).to_have_text('Расхождения нет')
        page.get_by_test_id('ops-close-next').click()
        expect(step).to_have_text('3 · Итог терминала Kaspi за смену')
        expect(page.get_by_test_id('ops-close-diff')).to_have_text('Совпадает с кассой')
        page.get_by_test_id('ops-close-next').click()
        expect(page.get_by_test_id('ops-close-note')).to_have_text('Все чеки Webkassa этой смены оформлены.')
        page.get_by_test_id('ops-close-next').click()
        expect(step).to_have_text('5 · Причина')
        page.get_by_test_id('ops-close-next').click()
        expect(page.get_by_test_id('ops-close-next')).to_have_text('Закрыть смену · PIN начальника смены')
        no_long_dashes(page)
        page.get_by_test_id('ops-close-next').click()
        keys(page, '.sale-pin', '2468')
        expect(page.get_by_test_id('ops-report-title')).to_have_text('Z-отчёт PickChick (не фискальный)')
        expect(page.get_by_test_id('ops-report-webkassa')).to_be_visible()
        expect(close).to_have_count(0)
        capture(page, 'ops-z-report-1920.png')
        page.get_by_role('button', name='Готово · закрыть кассу').click()
        expect(button(page, '1')).to_be_visible()
        paid_lock(page)
        capture(page, 'lock-paid-1920.png')
        # After a restart the lock screen still knows this desk sells.
        page.reload()
        expect(button(page, '1')).to_be_visible()
        paid_lock(page)
        assert not errors, errors
        assert not external, external
    finally:
        browser.close()
