"""Lane bo-ui audit fixes in the real back office (Chromium). See audit-fixes-browser.test.mjs.

Modes: off (every flag off, the cloud lane's cabinet), stock (stock v2 only: F01, F02, F17 of the
stock dialogs), on (the cutover back office with roles: F03, F05-F09, F14-F20). Screenshots at
1440x900 and 390x844, scale 1, Asia/Almaty. Synthetic data only.
"""
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
from playwright.sync_api import sync_playwright, expect

config = json.loads(Path(sys.argv[1]).read_text())
output = Path(config['output'])
MODE = config['mode']
LONG_DASHES = ('—', '–')
BLUE, WHITE = 'rgb(0, 71, 187)', 'rgb(255, 255, 255)'

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--lang=ru-RU'])
    errors = []
    asked = []  # every confirm / beforeunload the cabinet raised: (type, message)
    answer = {'confirm': False}

    def on_dialog(d):
        asked.append((d.type, d.message))
        if d.type == 'beforeunload' or answer['confirm']:
            d.accept()
        else:
            d.dismiss()

    def session(credential, width=1440, height=900, hash=''):
        page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1,
                                timezone_id='Asia/Almaty', locale='ru-RU', accept_downloads=True)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', on_dialog)
        page.goto(config['url'] + hash)
        page.get_by_test_id('credential-file').set_input_files({
            'name': 'person.json', 'mimeType': 'application/json',
            'buffer': json.dumps(credential).encode()}, timeout=15000)
        expect(page.locator('.user')).to_be_visible()
        expect(page.locator('h1').first).to_be_visible()
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

    def text(page):
        return page.locator('body').inner_text()

    def no_long_dash(page, where):
        body = text(page)
        assert not any(d in body for d in LONG_DASHES), 'long dash on ' + where

    def fill_receipt(page, reference='НАК-2001', quantity='12', cost='3600'):
        d = dialog(page)
        d.locator('#op-reference').fill(reference)
        d.get_by_test_id('op-stock-ingredient-0').select_option(config['bun'])
        d.locator('#op-stock-quantity-0').fill(quantity)
        d.locator('#op-stock-cost-0').fill(cost)
        return d

    # ------------------------------------------------------------------------------------------
    if MODE == 'off':
        page = session(config['manager'], hash='#stock')
        nav(page, 'stock')
        assert page.evaluate("document.documentElement.classList.contains('bo-fixes')") is False
        expect(page.get_by_test_id('header-role')).to_have_count(0)
        expect(page.locator('[data-label]')).to_have_count(0)
        expect(page.get_by_role('group', name='Период')).to_be_visible()
        expect(page.locator('.inventory-tabs').get_by_role('button', name='Номенклатура')).to_be_visible()
        # F01 as before the lane: Esc closes a filled dialog without a question; the input is gone.
        page.get_by_test_id('op-receipt').click()
        expect(dialog(page).locator('h2')).to_have_text('Поступление')
        fill_receipt(page)
        page.keyboard.press('Escape')
        expect(dialog(page)).to_have_count(0)
        assert asked == [], asked
        page.get_by_test_id('op-receipt').click()
        expect(dialog(page).locator('#op-reference')).to_have_value('')
        dialog(page).get_by_role('button', name='Закрыть').click()
        expect(dialog(page)).to_have_count(0)
        assert asked == [], asked
        # F08 as before: the author is a code.
        nav(page, 'audit')
        expect(page.get_by_role('group', name='Период')).to_be_visible()
        first = page.locator('.op-table tbody tr').first.locator('td').nth(1).inner_text()
        assert re.fullmatch(r'[0-9a-f]{8}', first.strip()), first
        capture(page, 'off-audit-1440.png')
        page.close()

    # ------------------------------------------------------------------------------------------
    if MODE == 'stock':
        page = session(config['manager'], hash='#stock')
        nav(page, 'stock')
        # Only the stock fixes: no general fixes without the cutover flag.
        assert page.evaluate("document.documentElement.classList.contains('bo-fixes')") is False
        expect(page.get_by_role('group', name='Период')).to_be_visible()
        # F17: the tab and the window are called what their buttons are called.
        expect(page.locator('.inventory-tabs').get_by_role('button', name='Ингредиенты')).to_be_visible()
        page.get_by_test_id('op-receipt').click()
        expect(dialog(page).locator('h2')).to_have_text('Поставка')
        fill_receipt(page)
        # F01: Esc asks; «Нет» keeps the dialog and the input.
        page.keyboard.press('Escape')
        expect(dialog(page)).to_have_count(1)
        assert asked and asked[-1][0] == 'confirm' and 'Отменить ввод документа' in asked[-1][1], asked
        expect(dialog(page).locator('#op-reference')).to_have_value('НАК-2001')
        # «Закрыть» asks as well.
        dialog(page).get_by_role('button', name='Закрыть').click()
        expect(dialog(page)).to_have_count(1)
        assert asked[-1][0] == 'confirm', asked
        capture(page, 'stock-receipt-draft-1440.png')
        # A reload asks too, and the draft survives it.
        page.reload()
        assert any(kind == 'beforeunload' for kind, _ in asked), asked
        expect(page.locator('.user')).to_be_visible()
        nav(page, 'stock')
        expect(page.get_by_test_id('stock-draft-receipt')).to_be_visible()
        page.get_by_test_id('stock-draft-receipt').get_by_role('button', name='Продолжить ввод').click()
        expect(dialog(page).get_by_test_id('op-draft-restored')).to_be_visible()
        expect(dialog(page).locator('#op-reference')).to_have_value('НАК-2001')
        expect(dialog(page).locator('#op-stock-quantity-0')).to_have_value('12')
        expect(dialog(page).locator('#op-stock-cost-0')).to_have_value('3600')
        capture(page, 'stock-receipt-restored-1440.png')
        # «Да» drops the draft: the next window is empty.
        answer['confirm'] = True
        dialog(page).get_by_role('button', name='Закрыть').click()
        expect(dialog(page)).to_have_count(0)
        answer['confirm'] = False
        expect(page.get_by_test_id('stock-draft-receipt')).to_have_count(0)
        page.get_by_test_id('op-receipt').click()
        expect(dialog(page).locator('#op-reference')).to_have_value('')
        expect(dialog(page).get_by_test_id('op-draft-restored')).to_have_count(0)
        page.keyboard.press('Escape')  # nothing typed: closes without a question
        expect(dialog(page)).to_have_count(0)

        # F02: another document moves the balance while the waste dialog is open.
        page.get_by_test_id('op-waste').click()
        d = dialog(page)
        d.get_by_test_id('op-waste-reason').select_option('defect')
        d.locator('#op-reference').fill('СП-КОНФЛИКТ')
        d.get_by_test_id('op-stock-ingredient-0').select_option(config['bun'])
        d.locator('#op-stock-quantity-0').fill('2')
        d.get_by_test_id('inventory-reviewed').check()
        d.locator('#op-reason').fill('Синтетическая проверка конфликта')
        expect(d.locator('.inventory-preview')).to_contain_text('20 шт')
        status = page.evaluate("""async ([branch, token, ing]) => {
          const base = '/v1/admin/backoffice/branches/' + branch;
          const h = {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'};
          const s = await (await fetch(base + '?period=day', {headers: h})).json();
          const row = s.stock.find(r => r.id === ing);
          const r = await fetch(base + '/commands', {method: 'POST', headers: h, body: JSON.stringify({
            request_id: crypto.randomUUID(), reason: 'Параллельный документ',
            command: {type: 'stock', kind: 'waste', reference: 'ПАР-1', reason_code: 'damaged',
              lines: [{ingredient_id: ing, quantity: '1', value_minor: '0', expected_revision: row.revision}]}})});
          return r.status;
        }""", [config['branch'], config['manager']['token'], config['bun']])
        assert status == 200, status
        d.get_by_test_id('op-save').click()
        error = d.locator('.op-form-error')
        expect(error).to_contain_text('Остаток изменился, пока вы вводили документ')
        assert 'Черновик изменил другой управляющий' not in error.inner_text()
        # The balances were read again in place; the input is all still there.
        expect(d.locator('.inventory-preview')).to_contain_text('19 шт')
        expect(d.locator('#op-reference')).to_have_value('СП-КОНФЛИКТ')
        expect(d.locator('#op-stock-quantity-0')).to_have_value('2')
        expect(d.get_by_test_id('op-waste-reason')).to_have_value('defect')
        expect(d.locator('#op-reason')).to_have_value('Синтетическая проверка конфликта')
        capture(page, 'stock-conflict-1440.png')
        # The same dialog sends again with the new revisions.
        d.get_by_test_id('inventory-reviewed').check()
        d.get_by_test_id('op-save').click()
        expect(dialog(page)).to_have_count(0)
        expect(page.get_by_test_id('stock-draft-waste')).to_have_count(0)
        # Phone: the dialog fits a 390 px screen.
        page.set_viewport_size({'width': 390, 'height': 844})
        page.get_by_test_id('op-count').click()
        expect(dialog(page).locator('h2')).to_have_text('Инвентаризация')
        width = page.evaluate('document.documentElement.scrollWidth')
        assert width <= 390, width
        capture(page, 'stock-count-390.png')
        page.keyboard.press('Escape')
        page.close()

    # ------------------------------------------------------------------------------------------
    if MODE == 'on':
        page = session(config['manager'])
        assert page.evaluate("document.documentElement.classList.contains('bo-fixes')") is True
        # F09: who is signed in, in the header.
        expect(page.get_by_test_id('header-role')).to_have_text('Вы: управляющий')
        # F07: the period is where it works.
        expect(page.get_by_role('group', name='Период')).to_be_visible()

        # F05: «Месяц» keeps today's data on screen while it loads, marked «Обновляем…».
        held = []
        month = lambda url: 'period=month' in url  # noqa: E731
        hold = lambda route: held.append(route)  # noqa: E731
        page.route(month, hold)
        page.get_by_test_id('period-month').click()
        expect(page.get_by_test_id('op-refreshing')).to_be_visible()
        expect(page.locator('.stat').first).to_be_visible()
        assert 'нужен отдельный доступ' not in text(page)
        capture(page, 'dash-refreshing-1440.png')
        for route in held:
            route.continue_()
        page.unroute(month, hold)
        expect(page.get_by_test_id('op-refreshing')).to_have_count(0)
        expect(page.get_by_test_id('period-month')).to_have_attribute('aria-pressed', 'true')
        # F05: no connection - the shown data stays, the message says so, never «доступ».
        week = lambda url: 'period=week' in url  # noqa: E731
        drop = lambda route: route.abort()  # noqa: E731
        page.route(week, drop)
        page.get_by_test_id('period-week').click()
        problem = page.get_by_test_id('op-problem')
        expect(problem).to_contain_text('Нет связи с сервером. Показаны данные на')
        expect(page.get_by_test_id('period-month')).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('.stat').first).to_be_visible()
        body = text(page)
        assert 'нужен отдельный доступ' not in body and 'request ID' not in body, body[:400]
        capture(page, 'dash-offline-1440.png')
        page.unroute(week, drop)
        with page.expect_response(lambda r: 'period=month' in r.url) as again:
            problem.get_by_test_id('op-retry').click()
        assert again.value.status == 200, again.value.status
        expect(page.get_by_test_id('op-problem')).to_have_count(0)
        expect(page.get_by_test_id('op-refreshing')).to_have_count(0)
        no_long_dash(page, 'dash')

        # F07, F17, F19, F06 on the stock page.
        nav(page, 'stock')
        expect(page.get_by_role('group', name='Период')).to_have_count(0)
        expect(page.get_by_test_id('no-period-hint')).to_be_visible()
        expect(page.locator('.inventory-tabs').get_by_role('button', name='Ингредиенты')).to_be_visible()
        expect(page.locator('.content')).to_contain_text('Стоимость выбранных запасов: 11 870 ₸')
        tab = page.locator('.inventory-tabs').get_by_role('button', name='Документы')
        tab.click()
        expect(page.locator('.inventory-table td[data-label="Создан"]').first).to_have_text(
            re.compile(r'^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$'))
        tab.hover()
        colours = tab.evaluate("e => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color]")
        assert colours == [BLUE, WHITE], colours
        no_long_dash(page, 'stock')
        capture(page, 'stock-documents-1440.png')

        # F06 on the shifts tabs, F16 legacy block, F19 year list.
        nav(page, 'shifts')
        wf = page.locator('.wf-tabs').get_by_role('button', name='Табель')
        wf.click()
        wf.hover()
        colours = wf.evaluate("e => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color]")
        assert colours == [BLUE, WHITE], colours
        years = page.get_by_label('Год', exact=True).locator('option').all_inner_texts()
        assert years[0] == '2025' and len(years) <= 4, years
        page.get_by_text('Кассовые смены и прежний журнал', exact=True).click()
        legacy = page.locator('details.panel')
        expect(legacy.get_by_role('heading', name='Управленческий журнал')).to_be_visible()
        expect(legacy.get_by_role('heading', name='Сотрудники', exact=True)).to_have_count(0)
        expect(legacy).to_contain_text('на вкладке «Сотрудники» раздела «Смены»')
        capture(page, 'shifts-time-hover-1440.png')

        # F08: names, Russian operation names, filters.
        nav(page, 'audit')
        expect(page.get_by_role('group', name='Период')).to_have_count(0)
        log = page.get_by_test_id('audit-log')
        expect(log).to_contain_text('Синтетический управляющий')
        expect(log).to_contain_text('Поставка')
        expect(log).to_contain_text('Изменение: ингредиент')
        expect(log).to_contain_text('Изменение: обращение')
        authors = log.locator('tbody tr td:nth-child(2)').all_inner_texts()
        assert authors and not any(re.fullmatch(r'[0-9a-f]{8}', a.strip()) for a in authors), authors
        total = page.get_by_test_id('audit-count').inner_text()
        page.get_by_test_id('audit-section').select_option('Склад')
        expect(page.get_by_test_id('audit-count')).not_to_have_text(total)
        sections = log.locator('tbody tr td:nth-child(3)').all_inner_texts()
        assert sections and set(s.strip() for s in sections) == {'Склад'}, sections
        capture(page, 'audit-1440.png')

        # F15: the overdue urgent ticket says so.
        nav(page, 'tickets')
        expect(page.get_by_role('group', name='Период')).to_have_count(0)
        row = page.locator('.op-table tbody tr').first
        expect(row).to_contain_text('Долго ждали заказ в зале')
        expect(row).to_contain_text('Просрочено')
        expect(row).to_contain_text('Срочный')
        capture(page, 'tickets-1440.png')

        # F17: the menu page is called «Меню и цены».
        nav(page, 'items')
        expect(page.locator('h1')).to_have_text('Меню и цены')

        # F20: the stop list opens on «Только на стопе».
        nav(page, 'stoplist')
        stop_filter = page.get_by_test_id('stop-filter')
        expect(stop_filter).to_have_value('stopped')
        expect(page.get_by_role('group', name='Период')).to_have_count(0)
        no_long_dash(page, 'stoplist')
        capture(page, 'stoplist-1440.png')

        # F11: the report CSV is in tenge with «Сумма, ₸».
        nav(page, 'reports')
        with page.expect_download() as download:
            page.get_by_role('button', name='Экспорт CSV').last.click()
        raw = Path(download.value.path()).read_bytes()
        assert raw.startswith(b'\xef\xbb\xbf'), 'CSV must start with a UTF-8 BOM'
        head = raw.decode('utf-8-sig').split('\r\n')[0]
        assert head == '"Показатель";"Сумма, ₸"', head

        # F13: one date on «Оплаты и чеки»: no header period; without the reconciliation the
        # blocks have their own day (today), and another day reloads them for that day.
        nav(page, 'settlements')
        expect(page.get_by_role('group', name='Период')).to_have_count(0)
        expect(page.get_by_test_id('no-period-hint')).to_contain_text('Дата страницы')
        title = page.get_by_test_id('settle-title')
        today = datetime.now(ZoneInfo('Asia/Almaty')).date()
        expect(title).to_have_text(f'Приложение и киоск за {today:%d.%m.%Y}')
        before = today - timedelta(days=1)
        with page.expect_response(lambda r: f'start_date={before}' in r.url and f'end_date={before}' in r.url) as answer:
            page.get_by_test_id('settle-day').fill(str(before))
        assert answer.value.status == 200, answer.value.status
        expect(title).to_have_text(f'Приложение и киоск за {before:%d.%m.%Y}')
        # The other pages keep their own header period.
        nav(page, 'dash')
        expect(page.get_by_role('group', name='Период')).to_have_count(1)
        page.close()

        # ---- F03: the accountant writes finance, posts a receipt, but no waste ----
        page = session(config['accountant'])
        expect(page.get_by_test_id('header-role')).to_have_text('Вы: бухгалтер')
        nav(page, 'finance')
        add = page.get_by_role('button', name='Добавить операцию')
        expect(add).to_be_enabled()
        expect(page.get_by_test_id('finance-rights')).to_have_count(0)
        add.click()
        page.get_by_test_id('finance-amount').fill('12500')
        page.get_by_test_id('finance-category').select_option('rent')
        page.get_by_test_id('finance-reference').fill('Синтетическая аренда')
        page.get_by_role('button', name='Провести операцию').click()
        expect(page.get_by_role('button', name='Добавить операцию')).to_be_visible()
        page.get_by_role('button', name='Журнал операций').click()
        journal = page.locator('.finance-journal-table')
        expect(journal).to_contain_text('12 500 ₸')
        expect(journal).to_contain_text(re.compile(r'\d{2}\.\d{2}\.\d{4}'))
        capture(page, 'finance-accountant-1440.png')
        nav(page, 'stock')
        expect(page.get_by_test_id('op-receipt')).to_be_visible()
        expect(page.get_by_test_id('op-waste')).to_have_count(0)
        expect(page.get_by_test_id('stock-rights')).to_contain_text('Списание проводят управляющий и начальник смены.')
        # F14 on a phone: the ledger rows are cards, the amount is on screen.
        page.set_viewport_size({'width': 390, 'height': 844})
        nav(page, 'finance')
        page.get_by_role('button', name='Журнал операций').click()
        amount = page.locator('.finance-journal-table td[data-label="Сумма"]').first
        expect(amount).to_contain_text('12 500 ₸')
        box = amount.bounding_box()
        assert box and box['x'] >= 0 and box['x'] + box['width'] <= 390, box
        assert page.evaluate('document.documentElement.scrollWidth') <= 390
        capture(page, 'finance-journal-390.png')
        page.close()

        # ---- F09: the shift manager posts waste, sees no finance, rates or payroll ----
        page = session(config['shift'], 390, 844)
        expect(page.get_by_test_id('header-role')).to_have_text('Вы: начальник смены')
        role_box = page.get_by_test_id('header-role').bounding_box()
        assert role_box and role_box['x'] + role_box['width'] <= 390, role_box
        expect(page.get_by_test_id('nav-finance')).to_have_count(0)
        nav(page, 'stock')
        expect(page.get_by_test_id('op-waste')).to_be_visible()
        expect(page.get_by_test_id('op-count')).to_be_visible()
        # F14: stock balances as cards; the value and the state are on screen.
        cell = page.locator('.inventory-table td[data-label="Стоимость"]').first
        expect(cell).to_be_visible()
        box = cell.bounding_box()
        assert box and box['x'] + box['width'] <= 390, box
        state = page.locator('.inventory-table td[data-label="Состояние"]').first
        box = state.bounding_box()
        assert box and box['x'] + box['width'] <= 390, box
        assert page.evaluate('document.documentElement.scrollWidth') <= 390
        capture(page, 'stock-shift-manager-390.png')
        # Review BOUI-R5: on a phone the conflict message of the shift manager's waste is
        # scrolled into view above the sticky «Провести документ» button, never cut off.
        page.get_by_test_id('op-waste').click()
        d = dialog(page)
        d.get_by_test_id('op-waste-reason').select_option('defect')
        d.locator('#op-reference').fill('СП-ТЕЛЕФОН')
        d.get_by_test_id('op-stock-ingredient-0').select_option(config['bun'])
        d.locator('#op-stock-quantity-0').fill('1')
        d.get_by_test_id('inventory-reviewed').check()
        d.locator('#op-reason').fill('Синтетическая проверка на телефоне')
        d.evaluate('(node) => { node.scrollTop = 0; }')
        status = page.evaluate("""async ([branch, token, ing]) => {
          const base = '/v1/admin/backoffice/branches/' + branch;
          const h = {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'};
          const s = await (await fetch(base + '?period=day', {headers: h})).json();
          const row = s.stock.find(r => r.id === ing);
          const r = await fetch(base + '/commands', {method: 'POST', headers: h, body: JSON.stringify({
            request_id: crypto.randomUUID(), reason: 'Параллельный документ на телефоне',
            command: {type: 'stock', kind: 'waste', reference: 'ПАР-2', reason_code: 'damaged',
              lines: [{ingredient_id: ing, quantity: '1', value_minor: '0', expected_revision: row.revision}]}})});
          return r.status;
        }""", [config['branch'], config['manager']['token'], config['bun']])
        assert status == 200, status
        save = d.get_by_test_id('op-save')
        save.click()
        error = d.locator('.op-form-error')
        expect(error).to_contain_text('Остаток изменился, пока вы вводили документ')
        dialog_box = d.bounding_box()
        error_box = error.bounding_box()
        save_box = save.bounding_box()
        assert error_box and save_box and dialog_box, (error_box, save_box, dialog_box)
        assert error_box['y'] >= dialog_box['y'] - 1, (error_box, dialog_box)
        assert error_box['y'] + error_box['height'] <= save_box['y'] + 1, (error_box, save_box)
        assert error_box['x'] + error_box['width'] <= 390, error_box
        capture(page, 'stock-conflict-shift-390.png')
        d.get_by_test_id('inventory-reviewed').check()
        save.click()
        expect(dialog(page)).to_have_count(0)
        nav(page, 'shifts')
        expect(page.locator('.content')).to_contain_text('Табель, ставки и начисления видят управляющий и бухгалтер')
        expect(page.get_by_test_id('workforce')).to_have_count(0)
        page.close()

        # ---- F03, F09: a read-only analyst is told why the buttons are grey ----
        page = session(config['analyst'])
        expect(page.get_by_test_id('header-role')).to_have_text('Вы: просмотр')
        nav(page, 'finance')
        rights = page.get_by_test_id('finance-rights')
        expect(rights).to_contain_text('Вносить и исправлять операции могут управляющий и бухгалтер точки.')
        add = page.get_by_role('button', name='Добавить операцию')
        expect(add).to_be_disabled()
        assert 'управляющий и бухгалтер' in (add.get_attribute('title') or '')
        nav(page, 'shifts')
        expect(page.get_by_test_id('workforce-rights')).to_contain_text('меняет управляющий точки')
        capture(page, 'shifts-analyst-1440.png')
        page.close()

    browser.close()
    assert not errors, errors
print('audit fixes browser flow passed:', MODE)
