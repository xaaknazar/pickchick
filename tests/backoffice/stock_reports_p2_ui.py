"""Lane bo-ui2 step 4 stock reports in the real back office (Chromium).

See stock-reports-p2-browser.test.mjs. Modes: off (stock reports off: the bo-ui stock page, no
«К заказу», no request to ops/stock?view=balances|reorder), on (roles, stock v2, «Закупки» and
the stock reports on: «Остатки» from the server with the value at the last purchase price,
«Движение» by position with its CSV, «К заказу» with the rule in words, its CSV and «Создать
заявку» into the request editor, the banners while sales are not written off, the card fields
«Откуда обычно приходит» and «Мясо», the phone at 390 px, the shift manager, the accountant and
the analyst with the disabled button explained in words). Screenshots at 1440x900 and 390x844,
scale 1, Asia/Almaty. Synthetic data only.
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

config = json.loads(Path(sys.argv[1]).read_text())
output = Path(config['output'])
MODE = config['mode']
LONG_DASHES = ('—', '–')
NO_SALES = 'Продажи не списываются со склада автоматически: остатки, движение и расход здесь - без продаж.'
WRITE_RIGHTS = 'Заявки создают и подают управляющий и начальник смены.'

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--lang=ru-RU'])
    errors = []
    requests = []

    def session(credential, width=1440, height=900):
        page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1,
                                timezone_id='Asia/Almaty', locale='ru-RU', accept_downloads=True)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda r: requests.append(r.url))
        page.on('dialog', lambda d: d.accept())
        page.goto(config['url'] + '#stock')
        page.get_by_test_id('credential-file').set_input_files({
            'name': 'person.json', 'mimeType': 'application/json',
            'buffer': json.dumps(credential).encode()}, timeout=15000)
        expect(page.locator('.user')).to_be_visible()
        page.wait_for_function("() => !document.body.innerText.includes('Загружаем данные')")
        return page

    def capture(page, name, full=False):
        page.evaluate("""async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}""")
        page.screenshot(path=str(output / name), full_page=full)

    def nav(page, section):
        item = page.get_by_test_id('nav-' + section)
        if not item.is_visible():
            page.get_by_test_id('navigation-toggle').click()
        item.click()

    def tab(page, name):
        page.locator('.inventory-tabs').get_by_role('button', name=name, exact=True).click()

    def dialog(page, testid=None):
        d = page.locator('dialog.op-dialog[open]')
        return d if testid is None else page.locator(f'dialog.op-dialog[open][data-testid="{testid}"]')

    def download(page, test_id):
        with page.expect_download() as file:
            page.get_by_test_id(test_id).click()
        raw = Path(file.value.path()).read_bytes()
        assert raw.startswith(b'\xef\xbb\xbf'), 'CSV must start with a UTF-8 BOM'
        return raw.decode('utf-8-sig').split('\r\n')

    def no_long_dash(page, where):
        body = page.locator('body').inner_text()
        assert not any(d in body for d in LONG_DASHES), 'long dash on ' + where

    def no_page_scroll(page, width):
        scroll = page.evaluate('document.documentElement.scrollWidth')
        assert scroll <= width, (scroll, width)

    def inside(locator, width):
        b = locator.bounding_box()
        assert b and b['x'] >= 0 and b['x'] + b['width'] <= width + 0.5, b

    def reorder_row(page, name):
        return page.get_by_test_id('stock-reorder').locator('tbody tr', has_text=name)

    # ------------------------------------------------------------------------------------------
    if MODE == 'off':
        page = session(config['manager'])
        nav(page, 'stock')
        tabs = page.locator('.inventory-tabs')
        expect(tabs.get_by_role('button', name='Движение', exact=True)).to_be_visible()
        expect(tabs.get_by_role('button', name='К заказу', exact=True)).to_have_count(0)
        expect(page.get_by_test_id('stock-balances')).to_have_count(0)
        expect(page.locator('.inventory-table').first).to_contain_text('Синтетическое филе')
        tab(page, 'Движение')
        page.locator('#inventory-movement-start').fill(config['start'])
        page.get_by_test_id('inventory-movement-run').click()
        expect(page.get_by_test_id('inventory-report-movement')).to_contain_text('По видам документов')
        expect(page.get_by_test_id('stock-turnover')).to_have_count(0)
        expect(page.get_by_test_id('inventory-turnover-csv')).to_have_count(0)
        page.wait_for_timeout(300)
        assert not any('view=balances' in u or 'view=reorder' in u for u in requests), requests
        capture(page, 'off-movement-1440.png')
        page.close()

    # ------------------------------------------------------------------------------------------
    if MODE == 'on':
        page = session(config['manager'])
        nav(page, 'stock')
        tabs = page.locator('.inventory-tabs')
        labels = [t.strip() for t in tabs.locator('button').all_inner_texts()]
        assert labels.index('К заказу') == labels.index('Движение') + 1, labels

        # «Остатки» from the server: banner, state in words, value at the last purchase price.
        balances = page.get_by_test_id('stock-balances')
        expect(balances).to_be_visible()
        expect(page.get_by_test_id('stock-balances-sales')).to_have_text(NO_SALES)
        summary = page.get_by_test_id('stock-balances-summary')
        expect(summary).to_contain_text('по последней цене закупки')
        expect(summary).to_contain_text('Ниже минимума: 1.')
        bun = balances.locator('tbody tr', has_text='Синтетическая булка')
        expect(bun).to_contain_text('Ниже минимума')
        expect(bun).to_contain_text('80 ₸')
        fillet = balances.locator('tbody tr', has_text='Синтетическое филе')
        expect(fillet).to_contain_text('3,3 кг')
        expect(fillet).to_contain_text('9 900 ₸')
        expect(balances.locator('tbody tr', has_text='Синтетическая заготовка')).to_contain_text(
            'нет закупки')
        lines = download(page, 'stock-balances-csv')
        assert lines[0].startswith('"Остатки на";'), lines[0]
        assert '"Сумма, ₸"' in lines[1] and '"По последней цене закупки, ₸"' in lines[1], lines[1]
        assert any(l.startswith('"Синтетическое филе";"3,3";"кг";"2"') and l.endswith('"9900,00";"9900,00"')
                   for l in lines), lines
        page.get_by_test_id('inventory-filter').select_option('low')
        expect(balances.locator('tbody tr')).to_have_count(1)
        page.get_by_test_id('inventory-filter').select_option('active')
        no_long_dash(page, 'balances')
        capture(page, 'balances-1440.png', full=True)

        # «Движение»: by position, opening + in - out = closing, the CSV.
        tab(page, 'Движение')
        page.locator('#inventory-movement-start').fill(config['start'])
        page.get_by_test_id('inventory-movement-run').click()
        turnover = page.get_by_test_id('stock-turnover')
        expect(turnover).to_be_visible()
        expect(page.get_by_test_id('stock-turnover-sales')).to_contain_text(NO_SALES)
        expect(page.get_by_test_id('stock-turnover-mismatch')).to_have_count(0)
        row = turnover.locator('tbody tr', has_text='Синтетическое филе')
        expect(row).to_contain_text('24,3 кг')
        expect(row).to_contain_text('Поставки +24,3 кг')
        expect(row).to_contain_text('Списано по продажам -7 кг')
        expect(row).to_contain_text('В производство -14 кг')
        expect(row).not_to_contain_text('не сходится')
        expect(turnover.locator('tbody tr', has_text='Синтетическая коробка')).to_contain_text(
            'Списания -10 шт; Сторно +10 шт')
        expect(page.get_by_test_id('stock-turnover-totals')).to_contain_text('на конец')
        lines = download(page, 'inventory-turnover-csv')
        assert lines[0].startswith('"Движение по позициям за период";'), lines[0]
        assert '"На начало: Сумма, ₸"' in lines[1], lines[1]
        assert lines[-1].startswith('"Итого"'), lines[-1]
        no_long_dash(page, 'movement')
        capture(page, 'movement-1440.png', full=True)

        # «К заказу»: the rule in words, below and near, «Создать заявку» into the editor.
        tab(page, 'К заказу')
        reorder = page.get_by_test_id('stock-reorder')
        expect(reorder).to_be_visible()
        expect(page.get_by_test_id('stock-reorder-sales')).to_contain_text(NO_SALES)
        rule = page.get_by_test_id('stock-reorder-rule')
        expect(rule).to_contain_text('цель - 3 дня среднего расхода')
        expect(rule).to_contain_text('Заказать = цель минус остаток')
        meat = reorder_row(page, 'Синтетическое филе (мясо)')
        expect(meat).to_contain_text('1,5 кг в день / 1,5 кг в день')
        expect(meat).to_contain_text('2 дня')
        expect(meat).to_contain_text('4,5 кг (3 дня расхода)')
        expect(meat).to_contain_text('1,2 кг · 3 600 ₸')
        expect(meat).to_contain_text('Откуда: не задано')
        expect(meat).to_contain_text('Ниже цели')
        buns = reorder_row(page, 'Синтетическая булка')
        expect(buns).to_contain_text('3 шт в день')
        expect(buns).to_contain_text('10 шт (минимум)')
        expect(reorder_row(page, 'Синтетическая коробка')).to_have_count(0)
        expect(page.get_by_test_id('stock-reorder-totals')).to_contain_text(
            'Ниже цели: 2, рядом с минимумом: 0. Заказать на 3 620 ₸')
        lines = download(page, 'stock-reorder-csv')
        assert '"Сумма, ₸"' in lines[1], lines[1]
        assert any(l.startswith('"Синтетическое филе";"кг";"";"да";"3,3";"2"') for l in lines), lines
        create = page.get_by_test_id('stock-reorder-request')
        expect(create).to_have_text('Создать заявку (2)')
        page.get_by_test_id('stock-reorder-pick-' + config['bun']).uncheck()
        expect(create).to_have_text('Создать заявку (1)')
        no_long_dash(page, 'reorder')
        capture(page, 'reorder-1440.png', full=True)
        create.click()
        d = dialog(page, 'sp-editor')
        expect(d.get_by_test_id('sp-prefilled')).to_contain_text('подставлены из «К заказу»')
        expect(d.get_by_test_id('sp-kind')).to_have_value('supplier')
        expect(d.get_by_test_id('sp-line')).to_have_count(1)
        expect(d.get_by_test_id('sp-line-item-0')).to_have_value(config['fillet'])
        expect(d.locator('#sp-line-qty-0')).to_have_value('1,2')
        expect(d.get_by_test_id('sp-line-unit-0')).to_have_value('kg')
        capture(page, 'reorder-request-1440.png')
        d.get_by_test_id('sp-save').click()
        expect(dialog(page, 'sp-editor')).to_have_count(0)
        expect(dialog(page)).to_be_visible()
        page.keyboard.press('Escape')
        expect(dialog(page)).to_have_count(0)

        # The card: «Откуда обычно приходит» and «Мясо» (fields of the second wave).
        tab(page, 'Ингредиенты')
        page.get_by_test_id('op-edit-' + config['bun']).click()
        d = dialog(page)
        expect(d.get_by_test_id('op-meat')).not_to_be_checked()
        d.get_by_test_id('op-supply-kind').select_option('bakery')
        d.locator('#op-reason').fill('Булка приходит из пекарни')
        d.get_by_test_id('op-save').click()
        expect(dialog(page)).to_have_count(0)
        page.get_by_test_id('op-edit-' + config['fillet']).click()
        expect(dialog(page).get_by_test_id('op-meat')).to_be_checked()
        page.keyboard.press('Escape')
        tab(page, 'К заказу')
        expect(reorder_row(page, 'Синтетическая булка')).to_contain_text('Откуда: Пекарня')
        assert not errors, errors
        page.close()

        # The manager on a phone: no page scroll, the button and the amounts stay visible.
        page = session(config['manager'], 390, 844)
        nav(page, 'stock')
        expect(page.get_by_test_id('stock-balances')).to_be_visible()
        no_page_scroll(page, 390)
        capture(page, 'balances-390.png', full=True)
        tab(page, 'К заказу')
        expect(page.get_by_test_id('stock-reorder')).to_contain_text('3 600 ₸')
        inside(page.get_by_test_id('stock-reorder-request'), 390)
        inside(page.get_by_test_id('stock-reorder-csv'), 390)
        no_page_scroll(page, 390)
        capture(page, 'reorder-390.png', full=True)
        page.close()

        # The shift manager creates requests; the accountant and the analyst read, with the reason.
        page = session(config['shift'], 390, 844)
        nav(page, 'stock')
        tab(page, 'К заказу')
        expect(page.get_by_test_id('stock-reorder-request')).to_be_enabled()
        page.close()
        for who in ('accountant', 'analyst'):
            page = session(config[who])
            nav(page, 'stock')
            expect(page.get_by_test_id('stock-balances')).to_be_visible()
            tab(page, 'К заказу')
            button = page.get_by_test_id('stock-reorder-request')
            expect(button).to_be_disabled()
            expect(page.locator('#stock-reorder-request-why')).to_have_text(WRITE_RIGHTS)
            expect(page.get_by_test_id('stock-reorder')).to_contain_text('Синтетическое филе')
            capture(page, f'reorder-{who}-1440.png')
            page.close()

    browser.close()
    assert not errors, errors
