"""CR client-5: one paid day of a cash desk against the real edge with schema026 (pos lane).

Every text a cashier reads on a desk that sells: no test mode, no wrong desk number, the
Webkassa state of each order, «Чек» of an order and the installed version on the lock screen.
"""
import json
import re
import sys
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

fixture = json.loads(Path(sys.argv[1]).read_text())
url = fixture['url']
output = Path(fixture['output'])
HINT = "() => localStorage.getItem('pickchick.pos.desk-mode.v1')"
TEST_LOCK = 'Вход по личному PIN · Pick Chick POS 0.4 · TEST'
PAID_LOCK = 'Вход по личному PIN · Pick Chick POS 0.5.0'
# Synthetic names carry no "тест": any match is a test-mode text of the cashier screens.
TEST_WORDS = re.compile('тест|TEST|касса 1', re.I)


def button(page, name, exact=True):
    return page.get_by_role('button', name=name, exact=exact)


def keys(page, scope, digits):
    for digit in digits:
        page.locator(scope).get_by_role('button', name=digit, exact=True).click()


def pin(page, digits):
    for digit in digits:
        button(page, digit).click()


def toast(page, text):
    expect(page.locator('.pos-toast')).to_have_text(text)


def no_test_text(page, where):
    found = TEST_WORDS.findall(page.locator('[data-pos]').inner_text())
    assert not found, (where, found)


def capture(page, name):
    page.evaluate('async () => { await document.fonts.ready; }')
    page.screenshot(path=str(output / name))


def bar_fits(page, where):
    """Review 07.11 R5: with five tabs the staff chip and «Блокировать» stay on a 1366 px screen."""
    nav = page.locator('.bottom-nav')
    expect(nav.get_by_role('button', name=re.compile('ЧЕКИ WEBKASSA'))).to_be_visible()
    width = page.viewport_size['width']
    for name, item in (('lock', button(page, 'Блокировать')), ('staff chip', nav.locator('.nav-info > div:not(.lock-action)'))):
        box = item.bounding_box()
        assert box and box['x'] >= 0 and box['x'] + box['width'] <= width, (where, name, box, width)
    assert nav.evaluate('(e) => e.scrollWidth <= e.clientWidth'), (where, 'bottom bar scrolls')


def paid_lock(page):
    expect(button(page, '1')).to_be_visible()
    expect(page.locator('.pin-connection')).to_have_text(PAID_LOCK)
    no_test_text(page, 'lock')


def sell(page, tender):
    """One hall order of the synthetic combo; returns its number from the done screen."""
    page.get_by_role('button', name=re.compile('Синтетическое комбо')).click()
    button(page, re.compile('^В ЗАЛЕ'), exact=False).click()
    button(page, 'К ОПЛАТЕ · 3 490 ₸').click()
    button(page, 'Гость подтвердил - к оплате').click()
    pay = page.locator('.sale-pay')
    if tender == 'cash':
        pay.get_by_role('button', name=re.compile('НАЛИЧНЫЕ')).click()
        keys(page, '.sale-pay .sale-keys', '5000')
        button(page, 'Принять 5 000 ₸ · сдача 1 510 ₸').click()
    else:
        pay.get_by_role('button', name=re.compile('CHOCOFOOD')).click()
        pay.get_by_text('Номер заказа ChocoFood*').click()
        entry = page.locator('.sale-entry')
        for key in 'CF-100':
            entry.get_by_role('button', name=key, exact=True).click()
        entry.get_by_role('button', name='Готово', exact=True).click()
        button(page, 'Заказ ChocoFood оплачен').click()
    number = page.get_by_test_id('sale-done-number')
    expect(number).to_have_text(re.compile(r'^№\d+$'))
    return number.inner_text()[1:]


with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1366, 'height': 768}, reduced_motion='reduce', has_touch=True)
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
        # A desk that was never told by its edge (no session yet) shows today's lock texts
        # until the first login; from then on it remembers that it sells (CR client-5 §2).
        expect(page.locator('.pin-connection')).to_have_text(TEST_LOCK)
        assert page.evaluate(HINT) is None
        pin(page, '2468')
        subtitle = page.locator('.shift-open-subtitle')
        expect(subtitle).to_contain_text('Абая 62 · ')
        expect(subtitle).to_contain_text('открывает Синтетический начальник (Начальник смены)')
        expect(subtitle).not_to_contain_text('Касса')
        assert page.evaluate(HINT) == 'pos_sale'
        capture(page, 'paid-opening-1366.png')
        button(page, 'Открыть смену').click()
        toast(page, 'Смена открыта')
        expect(page.get_by_text('Начальник смены', exact=True).first).to_be_visible()
        no_test_text(page, 'order screen')
        bar_fits(page, 'order screen')
        button(page, 'Промокод').click()
        toast(page, 'Эта функция пока не подключена.')

        # The cashier sells: cash with its Webkassa number, ChocoFood, cash left for later.
        button(page, 'Блокировать').click()
        paid_lock(page)
        capture(page, 'paid-lock-1366.png')
        pin(page, '1357')
        expect(page.get_by_text('Кассир', exact=True).first).to_be_visible()
        first = sell(page, 'cash')
        page.get_by_test_id('sale-receipt').click()
        entry = page.locator('.sale-entry')
        for key in 'WK-5':
            entry.get_by_role('button', name=key, exact=True).click()
        entry.get_by_role('button', name='Готово', exact=True).click()
        button(page, 'Сохранить').click()
        expect(page.get_by_test_id('sale-fiscal-note')).to_have_text('Чек Webkassa №WK-5 сохранён')
        button(page, 'Новый заказ').click()
        second = sell(page, 'chocofood')
        expect(page.get_by_test_id('sale-fiscal-note')).to_have_text('Чек Webkassa для этого способа оплаты не нужен')
        button(page, 'Новый заказ').click()
        third = sell(page, 'cash')
        button(page, 'Новый заказ').click()

        # "ЗАКАЗЫ" after a restart: each paid row reads its sale receipt from the edge.
        page.reload()
        nav = page.locator('.bottom-nav')
        expect(nav).to_be_visible()
        nav.get_by_role('button', name=re.compile('^ЗАКАЗЫ')).click()

        def row(number):
            return page.locator('.order-table-row', has=page.get_by_text(number, exact=True))

        def receipt_state(number):
            return row(number).get_by_text(re.compile('^(оформлен|не оформлен|не нужен)$'))

        # The ОПЛАТА · ККМ column: "Оплачен" and the state of the Webkassa sale receipt in the
        # words of the X report, whole in the 122 px column of a 1366 px desk.
        for number, label in ((first, 'оформлен'), (second, 'не нужен'), (third, 'не оформлен')):
            expect(receipt_state(number)).to_have_text(label, timeout=10000)
            expect(row(number)).to_contain_text('Оплачен')
            cell = receipt_state(number)
            assert cell.evaluate('(e) => e.scrollWidth <= e.clientWidth'), (number, 'label cut')
        no_test_text(page, 'orders')
        # A receipt still to punch puts its count on «ЧЕКИ WEBKASSA»; the bar still fits.
        bar_fits(page, 'orders')
        capture(page, 'paid-orders-1366.png')
        # «Чек» of a receipt still to punch: its card at the Webkassa number entry, no paper.
        row(third).get_by_role('button', name='Чек', exact=True).click()
        expect(page.get_by_test_id('ops-card-title')).to_have_text('Заказ №' + third)
        entry = page.locator('.sale-entry')
        expect(entry).to_be_visible()
        expect(entry).to_contain_text('Номер чека Webkassa')
        receipt = page.get_by_test_id('ops-card-receipt').first
        expect(receipt).to_contain_text('Чек продажи · 3 490 ₸ · не оформлен')
        capture(page, 'paid-receipt-entry-1366.png')
        entry.get_by_role('button', name='Отмена', exact=True).click()
        expect(entry).to_have_count(0)
        expect(receipt.get_by_role('button', name='Внести номер')).to_be_visible()
        expect(page.locator('.pos-toast')).to_have_count(0)
        page.locator('.ops-card .sale-actions').get_by_role('button', name='Закрыть', exact=True).click()
        # «Чек» of a punched receipt: one print of «Чек заказа (не фискальный)» (no printer here).
        row(first).get_by_role('button', name='Чек', exact=True).click()
        expect(page.get_by_test_id('ops-card-title')).to_have_text('Заказ №' + first)
        toast(page, 'Печать не настроена')
        expect(page.get_by_test_id('ops-card-receipt').first).to_contain_text('Чек продажи · 3 490 ₸ · №WK-5')
        expect(page.locator('.sale-entry')).to_have_count(0)
        capture(page, 'paid-card-1366.png')
        page.locator('.ops-card .sale-actions').get_by_role('button', name='Закрыть', exact=True).click()

        # The lock screen of a desk that sells, also after a restart.
        button(page, 'Блокировать').click()
        paid_lock(page)
        page.reload()
        paid_lock(page)

        # The shift manager closes the sales shift: one receipt is still to punch.
        pin(page, '2468')
        nav.get_by_role('button', name=re.compile('^СМЕНА')).click()
        no_test_text(page, 'shift tab')
        button(page, 'Закрыть смену').click()
        step = page.get_by_test_id('ops-close-step')
        expect(step).to_have_text('1 · Сводка смены')
        page.get_by_test_id('ops-close-next').click()
        keys(page, '.ops-close .sale-keys', '6980')
        expect(page.get_by_test_id('ops-close-diff')).to_have_text('Расхождения нет')
        page.get_by_test_id('ops-close-next').click()
        expect(step).to_have_text('4 · Чеки Webkassa')
        expect(page.get_by_test_id('ops-close-note')).to_contain_text('Не оформлено: 1 на 3 490 ₸')
        page.get_by_test_id('ops-close-next').click()
        page.get_by_test_id('ops-close-next').click()
        page.get_by_test_id('ops-close-next').click()
        keys(page, '.sale-pin', '2468')
        expect(page.get_by_test_id('ops-report-title')).to_have_text('Z-отчёт PickChick (не фискальный)')
        expect(page.locator('.ops-report')).to_contain_text('Чеки Webkassa: оформлено 1, не оформлено 1, не нужен 1')
        toast(page, 'Смена закрыта. Не забудьте закрыть смену в кабинете Webkassa.')
        no_test_text(page, 'Z report')
        page.get_by_role('button', name='Готово · закрыть кассу').click()
        paid_lock(page)
        assert page.evaluate(HINT) == 'pos_sale'
        assert not errors, errors
        assert not external, external
    except Exception:
        page.screenshot(path=str(output / 'paid-day-failure.png'))
        print('RENDER_ERRORS', errors)
        print(page.locator('body').inner_text()[-1800:])
        raise
    finally:
        browser.close()
print('POS paid day (CR client-5): opening, three sales, receipt states, «Чек», lock and Z on a desk that sells - no test-mode text.')
