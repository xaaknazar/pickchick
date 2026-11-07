"""Lane bo-ui stock P1 in the real back office (Chromium). See stock-p1-browser.test.mjs.

Modes: off (every flag off: the cloud lane's stock page), on (stock v2 with roles on cloud075:
sales notice, last count, quick waste tiles, storno with a concurrent document, «Списания» and
«Движение» with CSV, the ingredient's tile, accountant and shift manager at 390 px). Screenshots
at 1440x900 and 390x844, scale 1, Asia/Almaty. Synthetic data only.
"""
import json
import re
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

config = json.loads(Path(sys.argv[1]).read_text())
output = Path(config['output'])
MODE = config['mode']
LONG_DASHES = ('—', '–')
DOCS = config['docs']

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--lang=ru-RU'])
    errors = []

    def session(credential, width=1440, height=900):
        page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1,
                                timezone_id='Asia/Almaty', locale='ru-RU', accept_downloads=True)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda d: d.dismiss())
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

    def dialog(page):
        return page.locator('dialog.op-dialog[open]')

    def tab(page, name):
        page.locator('.inventory-tabs').get_by_role('button', name=name, exact=True).click()

    def open_details(page, document_id):
        """Opens the details of one document in «Документы» (its storno button lives there)."""
        target = page.locator('details').filter(
            has=page.get_by_test_id('stock-reverse-' + document_id))
        target.locator('summary').click()
        return target

    def no_long_dash(page, where):
        body = page.locator('body').inner_text()
        assert not any(d in body for d in LONG_DASHES), 'long dash on ' + where

    def no_page_scroll(page, width):
        scroll = page.evaluate('document.documentElement.scrollWidth')
        assert scroll <= width, (scroll, width)

    def download(page, test_id):
        with page.expect_download() as file:
            page.get_by_test_id(test_id).click()
        raw = Path(file.value.path()).read_bytes()
        assert raw.startswith(b'\xef\xbb\xbf'), 'CSV must start with a UTF-8 BOM'
        return raw.decode('utf-8-sig').split('\r\n')

    def concurrent_waste(page, reference):
        return page.evaluate("""async ([branch, token, ing, reference]) => {
          const base = '/v1/admin/backoffice/branches/' + branch;
          const h = {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'};
          const s = await (await fetch(base + '?period=day', {headers: h})).json();
          const row = s.stock.find(r => r.id === ing);
          const r = await fetch(base + '/commands', {method: 'POST', headers: h, body: JSON.stringify({
            request_id: crypto.randomUUID(), reason: 'Параллельный документ',
            command: {type: 'stock', kind: 'waste', reference, reason_code: 'damaged',
              lines: [{ingredient_id: ing, quantity: '1', value_minor: '0', expected_revision: row.revision}]}})});
          return r.status;
        }""", [config['branch'], config['manager']['token'], config['bun'], reference])

    # ------------------------------------------------------------------------------------------
    if MODE == 'off':
        page = session(config['manager'])
        nav(page, 'stock')
        expect(page.get_by_test_id('stock-sales-notice')).to_have_count(0)
        expect(page.locator('.inventory')).to_contain_text('Ручной учёт этой точки')
        expect(page.get_by_text('Последний подсчёт')).to_have_count(0)
        tabs = page.locator('.inventory-tabs')
        expect(tabs.get_by_role('button', name='Номенклатура')).to_be_visible()
        expect(tabs.get_by_role('button', name='Списания', exact=True)).to_have_count(0)
        expect(tabs.get_by_role('button', name='Движение', exact=True)).to_have_count(0)
        tab(page, 'Документы')
        expect(page.locator('.inventory-table summary').first).to_have_text('Движения')
        expect(page.locator('[data-testid^="stock-reverse-"]')).to_have_count(0)
        expect(page.get_by_label('Тип документа').locator('option', has_text='Сторно')).to_have_count(0)
        page.get_by_test_id('op-waste').click()
        expect(dialog(page)).to_be_visible()
        expect(dialog(page).get_by_test_id('quick-waste')).to_have_count(0)
        dialog(page).get_by_role('button', name='Закрыть').click()
        expect(dialog(page)).to_have_count(0)
        nav(page, 'stock')
        tab(page, 'Номенклатура')
        page.get_by_test_id('op-edit-' + config['fillet']).click()
        expect(dialog(page)).to_be_visible()
        expect(dialog(page).locator('#op-quick-waste-label')).to_have_count(0)
        capture(page, 'off-stock-1440.png')
        dialog(page).get_by_role('button', name='Закрыть').click()
        page.close()

    # ------------------------------------------------------------------------------------------
    if MODE == 'on':
        page = session(config['manager'])
        nav(page, 'stock')
        notice = page.get_by_test_id('stock-sales-notice')
        expect(notice).to_contain_text('Продажи пока не списываются со склада автоматически')
        expect(notice).to_contain_text('«Последний подсчёт»')
        expect(page.locator('.inventory')).not_to_contain_text('Ручной учёт этой точки')
        balances = page.locator('.inventory-table').first
        expect(balances.locator('th', has_text='Последний подсчёт')).to_be_visible()
        expect(balances.locator('tr', has_text='Синтетическая булка')).to_contain_text('Подсчёта не было')
        expect(balances.locator('tr', has_text='Синтетическое филе')).to_contain_text(
            re.compile(r'\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}'))
        no_long_dash(page, 'stock balances')
        capture(page, 'stock-balances-1440.png')

        # Quick waste: two presses of the bun tile make one 4 pcs line; the reason stays required.
        page.get_by_test_id('op-waste').click()
        d = dialog(page)
        tiles = d.get_by_test_id('quick-waste')
        expect(tiles).to_contain_text('Булки из шкафа +2 шт')
        expect(tiles).to_contain_text('Мясо +0,5 кг')
        d.get_by_test_id('quick-waste-' + config['bun']).click()
        d.get_by_test_id('quick-waste-' + config['bun']).click()
        expect(d.get_by_test_id('op-stock-ingredient-0')).to_have_value(config['bun'])
        expect(d.locator('#op-stock-quantity-0')).to_have_value('4')
        d.locator('#op-reference').fill('СП-БЫСТРО')
        d.get_by_test_id('inventory-reviewed').check()
        d.locator('#op-reason').fill('Булки старше 50 минут в шкафу')
        d.get_by_test_id('op-save').click()
        expect(d.locator('.op-form-error')).to_have_text('Укажите причину списания.')
        d.get_by_test_id('op-waste-reason').select_option('hot_cabinet_expired')
        capture(page, 'waste-tiles-1440.png')
        d.get_by_test_id('op-save').click()
        expect(dialog(page)).to_have_count(0)

        # Storno of a receipt: the exact opposite, the original stays in history.
        tab(page, 'Документы')
        open_details(page, DOCS['НАК-1'])
        page.get_by_test_id('stock-reverse-' + DOCS['НАК-1']).click()
        d = dialog(page)
        expect(d).to_have_attribute('data-testid', 'stock-reverse-dialog')
        expect(d).to_contain_text('Сторно создаст обратный документ. Исходный останется в истории.')
        row = d.locator('tr', has_text='Синтетическая булка')
        expect(row).to_contain_text('35 шт')
        expect(row).to_contain_text('-10 шт')
        expect(row).to_contain_text('25 шт')
        expect(d.get_by_test_id('op-save')).to_have_text('Провести сторно')
        d.locator('#op-reason').fill('Поставка введена дважды')
        capture(page, 'storno-dialog-1440.png')
        d.get_by_test_id('op-save').click()
        expect(dialog(page)).to_have_count(0)
        table = page.locator('.inventory-table').first
        expect(table).to_contain_text('Сторно: Поставка «НАК-1» от')
        expect(table.locator('tr', has_text='Пекарня, накладная от 05.11.2026').first).to_be_visible()
        expect(table.locator('tr').filter(has_text='Сторнирован')).to_have_count(1)

        # Storno of the quick waste while another document moves the bun: refreshed in place.
        waste_row = page.locator('.inventory-table tbody tr', has_text='СП-БЫСТРО')
        expect(waste_row).to_contain_text('Тепловой шкаф: старше 50 минут')
        waste_row.locator('summary').click()
        waste_row.locator('[data-testid^="stock-reverse-"]').click()
        d = dialog(page)
        expect(d.locator('tr', has_text='Синтетическая булка')).to_contain_text('25 шт')
        d.locator('#op-reason').fill('Булки были свежие, списание ошибочное')
        assert concurrent_waste(page, 'ПАР-1') == 200
        d.get_by_test_id('op-save').click()
        expect(d.locator('.op-form-error')).to_contain_text('Остатки этих позиций изменились')
        expect(d.locator('tr', has_text='Синтетическая булка')).to_contain_text('24 шт')
        expect(d.locator('tr', has_text='Синтетическая булка')).to_contain_text('28 шт')
        capture(page, 'storno-conflict-1440.png')
        d.get_by_test_id('op-save').click()
        expect(dialog(page)).to_have_count(0)
        no_long_dash(page, 'stock documents')

        # «Списания»: by reason with the storno, by day, by author; CSV in tenge.
        tab(page, 'Списания')
        with page.expect_response(lambda r: '/ops/stock?' in r.url) as answer:
            page.get_by_test_id('inventory-waste-run').click()
        assert answer.value.status == 200, answer.value.status
        report = page.get_by_test_id('inventory-report-waste')
        hot = report.locator('tr', has_text='Тепловой шкаф: старше 50 минут').first
        expect(hot.locator('td')).to_have_text(['Тепловой шкаф: старше 50 минут', '1', '1', '0 ₸'])
        old = report.locator('tr', has_text='Без кода причины (до включения склада v2)').first
        expect(old.locator('td')).to_have_text(
            ['Без кода причины (до включения склада v2)', '1', '0', '10 ₸'])
        expect(report.locator('h3', has_text='По дням')).to_be_visible()
        expect(report).to_contain_text('Синтетический управляющий')
        expect(report).to_contain_text('Сторно: Списание «СП-БЫСТРО» от')
        lines = download(page, 'inventory-waste-csv')
        assert lines[0].startswith('"Списания за период";'), lines[0]
        assert '"Документов списания";"Сторно";"Сумма, ₸"' == lines[1], lines[1]
        assert '"Тепловой шкаф: старше 50 минут";"1";"1";"0,00"' in lines, lines
        rows = download(page, 'inventory-waste-lines-csv')
        assert rows[0].split(';')[7] == '"Сумма, ₸"', rows[0]
        no_long_dash(page, 'waste report')
        capture(page, 'waste-report-1440.png', full=True)

        # «Движение»: every document of the period, storno as its own kind.
        tab(page, 'Движение')
        page.get_by_test_id('inventory-movement-run').click()
        movement = page.get_by_test_id('inventory-report-movement')
        expect(movement.locator('tr', has_text='Сторно').first).to_be_visible()
        expect(movement).to_contain_text('Пекарня, накладная от 05.11.2026')
        rows = download(page, 'inventory-movement-lines-csv')
        assert '"Сумма, ₸"' in rows[0], rows[0]
        capture(page, 'movement-report-1440.png')

        # The ingredient's tile: checked before saving.
        tab(page, 'Ингредиенты')
        page.get_by_test_id('op-edit-' + config['fillet']).click()
        d = dialog(page)
        expect(d.locator('#op-quick-waste-label')).to_have_value('Мясо')
        d.locator('#op-quick-waste-label').fill('Мясо в шкафу')
        d.locator('#op-quick-waste-quantity').fill('0')
        d.locator('#op-reason').fill('Плитка списания мяса')
        d.get_by_test_id('op-save').click()
        expect(d.locator('.op-form-error')).to_contain_text('целое число больше нуля')
        d.locator('#op-quick-waste-quantity').fill('250')
        d.get_by_test_id('op-save').click()
        expect(dialog(page)).to_have_count(0)
        page.close()

        # The manager on a phone: notice and the last count stay readable, no page scroll.
        page = session(config['manager'], 390, 844)
        nav(page, 'stock')
        expect(page.get_by_test_id('stock-sales-notice')).to_be_visible()
        expect(page.locator('.inventory-table th', has_text='Последний подсчёт').first).to_be_attached()
        no_page_scroll(page, 390)
        capture(page, 'stock-balances-390.png')
        page.close()

        # The accountant reverses a receipt at 390 px.
        page = session(config['accountant'], 390, 844)
        nav(page, 'stock')
        tab(page, 'Документы')
        open_details(page, DOCS['НАК-2'])
        page.get_by_test_id('stock-reverse-' + DOCS['НАК-2']).click()
        d = dialog(page)
        expect(d).to_contain_text('Сторно создаст обратный документ. Исходный останется в истории.')
        d.locator('#op-reason').fill('Поставка оформлена на другую точку')
        no_page_scroll(page, 390)
        capture(page, 'storno-accountant-390.png')
        d.get_by_test_id('op-save').click()
        expect(dialog(page)).to_have_count(0)
        no_page_scroll(page, 390)
        page.close()

        # The shift manager: no storno, the rights in words; the tiles in the waste dialog.
        page = session(config['shift'], 390, 844)
        nav(page, 'stock')
        tab(page, 'Документы')
        old_row = page.locator('.inventory-table tbody tr', has_text='СП-СТАРОЕ')
        old_row.locator('summary').click()
        expect(old_row).to_contain_text('Сторно делают управляющий и бухгалтер.')
        expect(page.locator('[data-testid^="stock-reverse-"]')).to_have_count(0)
        page.get_by_test_id('op-waste').click()
        expect(dialog(page).get_by_test_id('quick-waste')).to_contain_text('Мясо в шкафу +0,25 кг')
        no_page_scroll(page, 390)
        capture(page, 'waste-tiles-shift-390.png')
        dialog(page).get_by_role('button', name='Закрыть').click()
        page.close()

    browser.close()
    assert not errors, errors
print('stock P1 browser flow passed:', MODE)
