"""Lane bo-ui «Касса» and the new «Главная» in the real back office (Chromium).

Real local back-office API with PostgreSQL behind the operator proxy, synthetic cashier day of
packages/backoffice-core/tests/pos-day-fixture.mjs on today's Almaty date. With
BACKOFFICE_POS_DAY_ENABLED off the cabinet is as before (no «Касса», old registry); with it on the
manager reads shifts and Z, receipts and a receipt card, Webkassa, downloads the three CSV files,
sees «Сегодня» on «Главная» and the cash desk column in the registry, and the pages fit a 390 px
phone. Screenshots at 1440x900 and 390x844, scale 1, Asia/Almaty. Synthetic data only.
"""
import csv
import io
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

config = json.loads(Path(sys.argv[1]).read_text())
output = Path(config['output'])
DAY = config['day']
Y, M, D = DAY.split('-')
DAY_RU = f'{D}.{M}.{Y}'
LONG_DASHES = ('—', '–')

with sync_playwright() as pw:
    # --lang makes the native date picker show DD.MM.YYYY, as on the managers' Russian browsers.
    browser = pw.chromium.launch(args=['--lang=ru-RU'])
    errors = []

    def session(width, height, hash=''):
        page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1,
                                timezone_id='Asia/Almaty', locale='ru-RU', accept_downloads=True)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(config['url'] + hash)
        try:
            page.get_by_test_id('credential-file').set_input_files({
                'name': 'person.json', 'mimeType': 'application/json',
                'buffer': json.dumps(config['manager']).encode()}, timeout=15000)
        except Exception:
            print('login page did not appear; page errors:', errors, file=sys.stderr)
            print(page.content()[:2000], file=sys.stderr)
            raise
        expect(page.locator('.user')).to_be_visible()
        return page

    def capture(page, name, full=False):
        page.evaluate("""async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}""")
        page.screenshot(path=str(output / name), full_page=full)

    def nav(page, section):
        item = page.get_by_test_id('nav-' + section)
        if not item.is_visible():
            page.get_by_test_id('navigation-toggle').click()
        item.click()

    def no_long_dash(text, where):
        assert not any(d in text for d in LONG_DASHES), 'long dash in ' + where

    def csv_rows(download):
        raw = Path(download.path()).read_bytes()
        assert raw.startswith(b'\xef\xbb\xbf'), 'CSV must start with a UTF-8 BOM'
        return list(csv.reader(io.StringIO(raw.decode('utf-8-sig')), delimiter=';'))

    if config['mode'] == 'off':
        page = session(1440, 900)
        expect(page.locator('h1', has_text='Главная')).to_be_visible()
        expect(page.get_by_test_id('nav-pos')).to_have_count(0)
        expect(page.get_by_test_id('pos-home')).to_have_count(0)
        expect(page.locator('.stat').first).to_contain_text('Подтверждённые оплаты')
        capture(page, 'off-dash-1440.png')
        nav(page, 'orders')
        expect(page.locator('h2', has_text='Реестр заказов')).to_be_visible()
        heads = page.locator('.op-panel').filter(has_text='Реестр заказов').locator('th').all_inner_texts()
        assert [h.strip().lower() for h in heads] == ['заказ', 'дата', 'канал', 'сумма', 'оплата', 'кухня', ''], heads
        expect(page.get_by_text('Не начата').first).to_be_visible()
        capture(page, 'off-orders-1440.png')
        page.close()
        # #pos never opens a section the server does not have.
        page = session(1440, 900, '#pos')
        expect(page.locator('h1', has_text='Главная')).to_be_visible()
        page.wait_for_timeout(500)
        expect(page.locator('h1', has_text='Главная')).to_be_visible()
        expect(page.get_by_test_id('pos-day')).to_have_count(0)
        page.close()
    else:
        page = session(1440, 900)
        # ---- «Главная»: today of every channel and the cash desks ----
        home = page.get_by_test_id('pos-home')
        expect(home).to_be_visible()
        expect(home).to_contain_text(f'Сегодня, {DAY_RU}')
        tiles = page.get_by_test_id('pos-home-tiles')
        try:
            expect(tiles).to_be_visible(timeout=15000)
        except AssertionError:
            print('«Сегодня» without tiles:', home.inner_text(), errors, file=sys.stderr)
            capture(page, 'debug-home-1440.png')
            raise
        expect(tiles).to_contain_text('Выручка')
        expect(tiles).to_contain_text('7 000 ₸')
        expect(tiles).to_contain_text('Открытые смены')
        expect(tiles).to_contain_text('Касса 2 с 10:00')
        expect(tiles).to_contain_text('Webkassa не оформлено')
        expect(tiles.locator('.stat').filter(has_text='Webkassa не оформлено')).to_contain_text('5')
        expect(page.get_by_test_id('pos-home-freshness')).to_contain_text('Данные кассы получены в')
        expect(page.get_by_test_id('pos-home-channels')).to_contain_text('Яндекс Еда')
        expect(page.locator('h2', has_text='Приложение и киоск за выбранный период')).to_be_visible()
        no_long_dash(home.inner_text(), '«Сегодня»')
        capture(page, 'home-1440.png')

        # ---- «Касса»: shifts and Z ----
        nav(page, 'pos')
        expect(page.locator('h1', has_text='Касса')).to_be_visible()
        expect(page.locator('.op-periods')).to_have_count(0)
        day = page.get_by_test_id('pos-day')
        expect(page.get_by_test_id('pos-day-freshness')).to_contain_text('Данные кассы получены в')
        expect(page.get_by_test_id('pos-day-totals')).to_contain_text('8 500 ₸')
        expect(page.get_by_test_id('pos-day-totals')).to_contain_text('Средний чек 2 000 ₸')
        methods = page.get_by_test_id('pos-day-methods')
        expect(methods.locator('tbody tr')).to_have_count(8)
        cards = page.locator('.pos-shift')
        expect(cards).to_have_count(3)
        first = cards.nth(0)
        expect(first).to_contain_text('Касса 1')
        expect(first).to_contain_text('Закрыта')
        expect(first).to_contain_text('Расхождение наличных: -50 ₸')
        expect(first).to_contain_text('Kaspi терминал: разница -100 ₸')
        expect(first).to_contain_text('Не оформлено чеков Webkassa: 3')
        expect(first).to_contain_text('Синтетический кассир')
        expect(cards.nth(1)).to_contain_text('Это не X-отчёт кассы')
        expect(cards.nth(1)).to_contain_text('Открыта')
        expect(cards.nth(2)).to_contain_text('Нет отчёта смены')
        expect(cards.nth(2)).to_contain_text('Касса 3')
        no_long_dash(day.inner_text(), '«Смены и Z»')
        capture(page, 'pos-day-shifts-1440.png')
        with page.expect_download() as download:
            page.get_by_test_id('pos-day-z-csv').click()
        assert download.value.suggested_filename == f'pickchick-z-{DAY}.csv'
        z = csv_rows(download.value)
        assert z[0] == ['Z-отчёты кассы PickChick', DAY_RU, 'Asia/Almaty'], z[0]
        assert z[3][0] == 'Касса' and 'Расхождение, ₸' in z[3], z[3]
        assert z[4][0] == 'Касса 1' and z[4][12] == '-50,00', z[4]

        # ---- «Чеки»: search, filters, card ----
        page.get_by_test_id('pos-day-tab-receipts').click()
        expect(page.get_by_test_id('pos-day-tab-receipts')).to_have_attribute('aria-pressed', 'true')
        receipts = page.get_by_test_id('pos-receipts')
        expect(receipts.locator('tbody tr')).to_have_count(12)
        expect(page.get_by_test_id('pos-receipts-count')).to_have_text('Показано 12 из 12')
        page.locator('#pos-receipt-search').fill('1')
        expect(receipts.locator('tbody tr')).to_have_count(3)
        for desk in ['Касса 1', 'Касса 2', 'Касса 3']:
            expect(receipts).to_contain_text(desk)
        page.locator('#pos-receipt-search').fill('YA-123')
        expect(receipts.locator('tbody tr')).to_have_count(1)
        page.locator('#pos-receipt-search').fill('SYN-0003')
        expect(receipts.locator('tbody tr')).to_have_count(1)
        page.locator('#pos-receipt-search').fill('')
        page.get_by_test_id('pos-receipt-state').select_option('voided')
        expect(receipts.locator('tbody tr')).to_have_count(1)
        expect(receipts).to_contain_text('Отменён')
        page.get_by_test_id('pos-receipt-state').select_option('')
        page.get_by_test_id('pos-receipt-method').select_option('chocofood')
        expect(receipts.locator('tbody tr')).to_have_count(1)
        page.get_by_test_id('pos-receipt-method').select_option('')
        expect(receipts).to_contain_text('не оформлен')
        expect(receipts).to_contain_text('Сотрудник')
        capture(page, 'pos-day-receipts-1440.png')
        mixed = receipts.locator('tbody tr').filter(has_text='Касса 1').filter(has_text='Kaspi терминал')
        expect(mixed).to_have_count(1)
        mixed.get_by_role('button', name='Открыть').click()
        card = page.get_by_test_id('pos-receipt-card')
        expect(card).to_be_visible()
        expect(card).to_contain_text('Чек №2 · Касса 1')
        expect(page.get_by_test_id('pos-receipt-tenders')).to_contain_text('Kaspi терминал')
        expect(page.get_by_test_id('pos-receipt-refunds')).to_contain_text('Качество блюда: Гость вернул холодный заказ')
        expect(page.get_by_test_id('pos-receipt-refunds')).to_contain_text('Синтетический начальник смены')
        expect(page.get_by_test_id('pos-receipt-fiscal')).to_contain_text('SYN-0002')
        no_long_dash(card.inner_text(), 'receipt card')
        # Every table of the card fits the dialog (no clipped column).
        assert page.evaluate('''() => [...document.querySelectorAll('.pos-dialog table')]
            .every(t => t.getBoundingClientRect().width <= t.parentElement.getBoundingClientRect().width + 1)''')
        capture(page, 'pos-day-receipt-card-1440.png')
        page.get_by_test_id('pos-dialog-close').click()
        with page.expect_download() as download:
            page.get_by_test_id('pos-day-receipts-csv').click()
        rows = csv_rows(download.value)
        assert rows[3][0] == 'Дата и время' and 'Сумма, ₸' in rows[3], rows[3]
        assert len(rows) == 4 + 12, len(rows)
        assert any(r[1] == '2' and r[2] == 'Касса 1' and r[7] == '3000,00' for r in rows[4:]), rows

        # ---- «Webkassa» ----
        page.get_by_test_id('pos-day-tab-webkassa').click()
        totals = page.get_by_test_id('pos-webkassa-totals')
        expect(totals.locator('.stat').filter(has_text='Не оформлено')).to_contain_text('13 500 ₸')
        expect(totals.locator('.stat').filter(has_text='Итого по Webkassa')).to_contain_text('3 200 ₸')
        expect(page.get_by_test_id('pos-webkassa-pending').locator('tbody tr')).to_have_count(5)
        expect(page.get_by_test_id('pos-webkassa-recorded').locator('tbody tr')).to_have_count(3)
        expect(page.get_by_test_id('pos-webkassa-not-required')).to_contain_text('ChocoFood')
        expect(day).to_contain_text('Номер чека исправляется только на кассе, по PIN начальника смены')
        capture(page, 'pos-day-webkassa-1440.png')
        with page.expect_download() as download:
            page.get_by_test_id('pos-day-webkassa-csv').click()
        wk = csv_rows(download.value)
        assert wk[3][:3] == ['Номер чека', 'Вид', 'Сумма, ₸'], wk[3]
        assert len(wk) == 4 + 13, len(wk)
        # One cash desk: the server answers for it alone.
        with page.expect_response(lambda r: '/ops/pos-day?' in r.url and 'terminal_id=' in r.url) as answer:
            page.get_by_test_id('pos-day-terminal').select_option(label='Касса 2')
        assert answer.value.status == 200, answer.value.status
        expect(page.get_by_test_id('pos-webkassa-pending').locator('tbody tr')).to_have_count(1)

        # ---- registry: cash desk column, one-line date, totals, CSV in tenge ----
        nav(page, 'orders')
        registry = page.locator('.op-panel').filter(has_text='Реестр заказов')
        heads = registry.locator('th').all_inner_texts()
        assert [h.strip().lower() for h in heads] == ['заказ', 'касса', 'дата', 'канал', 'сумма', 'оплата', 'кухня', ''], heads
        lines = registry.locator('tbody tr')
        expect(lines).to_have_count(2)
        expect(lines.filter(has_text='Касса 1')).to_contain_text('№1')
        expect(lines.filter(has_text='Касса 2')).to_contain_text('№1')
        expect(registry).to_contain_text('Оплачено')
        # Audit F10: the server totals the whole period, also by cash desk.
        expect(page.get_by_test_id('op-orders-totals')).to_contain_text('Итого за период: заказов 2, без отменённых 2 на 3 700 ₸. Касса 1: 1, 2 500 ₸ · Касса 2: 1, 1 200 ₸.')
        # The search asks the server: «№1» is the number 1 of both desks.
        with page.expect_response(lambda r: '/ops/orders?' in r.url and 'q=' in r.url) as answer:
            page.get_by_test_id('op-order-search').fill('№1')
        assert answer.value.status == 200, answer.value.status
        expect(lines).to_have_count(2)
        with page.expect_response(lambda r: '/ops/orders?' in r.url and 'q=' not in r.url):
            page.get_by_test_id('op-order-search').fill('')
        page.get_by_test_id('op-order-desk').select_option(label='Касса 2')
        expect(lines).to_have_count(1)
        page.get_by_test_id('op-order-desk').select_option('')
        page.get_by_test_id('op-order-sort').select_option('amount')
        expect(lines.first).to_contain_text('2 500 ₸')
        capture(page, 'orders-1440.png')
        with page.expect_download() as download:
            page.get_by_test_id('op-orders-csv').click()
        orders = csv_rows(download.value)
        assert orders[0] == ['Дата', 'Время', 'Номер', 'Касса', 'Канал', 'Сумма, ₸', 'Оплата', 'Кухня', 'ID заказа'], orders[0]
        assert orders[1][0] == DAY_RU and orders[1][2] == '№1' and orders[1][5] == '2500,00', orders[1]
        page.close()

        # ---- phone 390x844 (a #pos link opens «Касса»): nothing wider than the screen ----
        page = session(390, 844, '#pos')
        expect(page.locator('h1', has_text='Касса')).to_be_visible()
        expect(page.get_by_test_id('pos-day-totals')).to_contain_text('8 500 ₸')
        assert page.evaluate('document.documentElement.scrollWidth') <= 390
        page.locator('.pos-shift').first.scroll_into_view_if_needed()
        capture(page, 'pos-day-shifts-390.png')
        # Review BOUI-R6: one line per paid method instead of a card per table row, and the
        # discrepancy line above the cash and Kaspi tables of every shift.
        for card in page.locator('.pos-shift').all():
            expect(card.get_by_test_id('pos-shift-methods')).to_be_hidden()
            expect(card.get_by_test_id('pos-shift-method-lines')).to_be_visible()
            key = card.get_by_test_id('pos-shift-key').bounding_box()
            grid = card.locator('.pos-shift-grid').bounding_box()
            assert key and grid and key['y'] < grid['y'], (key, grid)
            assert key['x'] + key['width'] <= 390, key
        expect(page.locator('.pos-shift').first.get_by_test_id('pos-shift-method-lines')).to_contain_text('оплат')
        print('pos-day shifts 390 height', page.evaluate('document.documentElement.scrollHeight'), flush=True)
        page.get_by_test_id('pos-day-tab-receipts').click()
        receipts = page.get_by_test_id('pos-receipts')
        expect(receipts.locator('tbody tr')).to_have_count(12)
        assert page.evaluate('document.documentElement.scrollWidth') <= 390
        amount = receipts.locator('tbody tr').first.locator('td[data-label="Сумма"]')
        box = amount.bounding_box()
        assert box and box['x'] >= 0 and box['x'] + box['width'] <= 390, box
        button = receipts.locator('tbody tr').first.get_by_role('button', name='Открыть')
        bb = button.bounding_box()
        assert bb and bb['x'] + bb['width'] <= 390, bb
        receipts.locator('tbody tr').first.scroll_into_view_if_needed()
        capture(page, 'pos-day-receipts-390.png')
        page.get_by_test_id('pos-day-tab-webkassa').click()
        assert page.evaluate('document.documentElement.scrollWidth') <= 390
        page.get_by_test_id('pos-webkassa-pending').scroll_into_view_if_needed()
        capture(page, 'pos-day-webkassa-390.png')
        nav(page, 'dash')
        expect(page.get_by_test_id('pos-home-tiles')).to_be_visible()
        width = page.evaluate('document.documentElement.scrollWidth')
        assert width <= 390, width
        capture(page, 'home-390.png')
        page.close()

    browser.close()
    assert not errors, errors
print('pos day browser flow passed (' + config['mode'] + ')')
