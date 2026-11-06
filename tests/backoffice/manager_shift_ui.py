"""Lane bo-ui step 6 «Смена менеджера» and staff positions in the real back office (Chromium).

See manager-shift-browser.test.mjs. Modes: off (every flag off: the cloud lane «Смены» page),
on (roles, manager shifts and positions on cloud075: open with the checklist, the card with
automatic checks, the closing wizard, the template, the old journal read only, positions and
the roster, the shift manager at 390 px, the analyst). Screenshots at 1440x900 and 390x844,
scale 1, Asia/Almaty. Synthetic data only.
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
OPENING = ['attendance', 'meat_prep', 'equipment', 'screens', 'cash_float', 'stoplist']
CLOSING = ['cash_shifts', 'cash_handover', 'webkassa_receipts', 'webkassa_shift', 'waste',
           'key_count', 'courier_incidents', 'blocked_consumption']

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
        page.goto(config['url'] + '#shifts')
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

    def no_long_dash(page, where):
        body = page.locator('body').inner_text()
        assert not any(d in body for d in LONG_DASHES), 'long dash on ' + where

    def no_page_scroll(page, width):
        scroll = page.evaluate('document.documentElement.scrollWidth')
        assert scroll <= width, (scroll, width)

    def answer(d, code, status='done', comment=None):
        d.get_by_test_id(f'ms-{status}-{code}').click()
        if comment is not None:
            d.get_by_test_id('ms-comment-' + code).fill(comment)

    def legacy(page):
        summary = page.locator('summary', has_text='Кассовые смены и прежний журнал')
        summary.click()
        panel = page.locator('section.panel', has=page.locator('h2', has_text='Управленческий журнал'))
        expect(panel).to_be_visible()
        return panel

    def team(page):
        page.locator('.wf-tabs').get_by_role('button', name='Сотрудники', exact=True).click()
        expect(page.locator('.workforce')).to_contain_text('Почасовые ставки')

    def headers(page):
        return [t.strip() for t in page.locator('.workforce table').first.locator('th').all_text_contents()]

    # ------------------------------------------------------------------------------------------
    if MODE == 'off':
        page = session(config['manager'])
        # The session opens #shifts; a click on the menu would race the first render at 390 px.
        expect(page.get_by_test_id('workforce')).to_be_visible()
        expect(page.get_by_test_id('manager-shift')).to_have_count(0)
        team(page)
        assert headers(page) == ['Сотрудник', 'Роль', 'Статус', 'Действия'], headers(page)
        expect(page.get_by_test_id('wf-roster')).to_have_count(0)
        journal = legacy(page)
        expect(journal.get_by_test_id('op-add-shift')).to_be_visible()
        page.wait_for_timeout(500)
        assert not any('/ops/manager-shifts' in u or '/ops/staff-roster' in u for u in requests), requests
        capture(page, 'off-shifts-1440.png', full=True)
        page.close()

    # ------------------------------------------------------------------------------------------
    if MODE == 'on':
        page = session(config['manager'])
        # The session opens #shifts; a click on the menu would race the first render at 390 px.
        block = page.get_by_test_id('manager-shift')
        expect(block.get_by_test_id('ms-closed')).to_contain_text('Смена не открыта')
        no_long_dash(page, 'shifts page')

        # Open: an empty checklist and a problem without a comment are refused in words.
        block.get_by_test_id('ms-open').click()
        d = dialog(page)
        expect(d).to_have_attribute('data-testid', 'ms-open-dialog')
        expect(d.get_by_test_id('ms-check-cash_float')).to_contain_text(
            'На открытии: Касса 1 5 000 ₸, Касса 2 3 000 ₸.')
        expect(d.get_by_test_id('ms-to-stock')).to_be_visible()
        d.get_by_test_id('ms-open-save').click()
        expect(d.locator('.op-form-error')).to_contain_text('Ответьте на пункты: Явка по графику')
        for code in OPENING[1:]:
            answer(d, code)
        answer(d, 'attendance', 'problem')
        expect(d.get_by_test_id('ms-item-attendance')).to_contain_text('Комментарий обязателен')
        d.get_by_test_id('ms-open-save').click()
        expect(d.locator('.op-form-error')).to_contain_text(
            'Нужен комментарий (минимум 3 символа): Явка по графику')
        d.get_by_test_id('ms-comment-attendance').fill('Жарщик опоздал на 20 минут')
        d.get_by_test_id('ms-manager').select_option(config['managerCard'])
        capture(page, 'open-dialog-1440.png')
        d.get_by_test_id('ms-open-save').click()
        expect(dialog(page)).to_have_count(0)
        card = block.get_by_test_id('ms-open-card')
        expect(card).to_contain_text('Смена открыта · менеджер Синтетический менеджер смены')
        expect(card).to_contain_text('Явка по графику: все на месте: Есть проблема - Жарщик опоздал на 20 минут')
        expect(card.get_by_test_id('ms-check-cash_shifts')).to_have_text(
            'Есть проблема: Кассовые смены: 2 из 2 закрыты, расхождение -500 ₸. Поясните в комментарии.')
        expect(card.get_by_test_id('ms-check-webkassa_receipts')).to_have_text(
            'Есть проблема: Не оформлено в Webkassa: 1 чек на 11 670 ₸. Оформите или поясните.')
        expect(card.get_by_test_id('ms-check-blocked_consumption')).to_contain_text(
            'Не используется: Списание по продажам не включено')
        no_long_dash(page, 'open card')
        capture(page, 'shift-open-1440.png')

        # Close: step 1 needs the explanations of the problems, step 2 the handover.
        card.get_by_test_id('ms-close').click()
        d = dialog(page)
        expect(d).to_have_attribute('data-testid', 'ms-close-dialog')
        for code in CLOSING[:-1]:
            answer(d, code)
        d.get_by_test_id('ms-close-next').click()
        expect(d.locator('.op-form-error')).to_contain_text(
            'Нужен комментарий (минимум 3 символа): Кассовые смены закрыты, расхождения пояснены; Все чеки оформлены в Webkassa')
        d.get_by_test_id('ms-comment-cash_shifts').fill('Касса 1: недостача 500 ₸, кассир пояснила')
        d.get_by_test_id('ms-comment-webkassa_receipts').fill('Чек оформим утром, Webkassa не отвечала')
        capture(page, 'close-step1-1440.png')
        d.get_by_test_id('ms-close-next').click()
        expect(d.get_by_test_id('ms-handover')).to_be_visible()
        d.get_by_test_id('ms-close-save').click()
        expect(d.locator('.op-form-error')).to_have_text('Заполните передачу смены.')
        d.get_by_test_id('ms-handover').fill('Касса 1 сдала на 500 ₸ меньше, разбор утром.')
        capture(page, 'close-step2-1440.png')
        d.get_by_test_id('ms-close-save').click()
        expect(dialog(page)).to_have_count(0)
        expect(block.get_by_test_id('ms-closed')).to_be_visible()
        row = block.locator('tbody tr').first
        expect(row).to_contain_text('Синтетический менеджер смены')
        expect(row).to_contain_text('Касса 1 сдала на 500 ₸ меньше, разбор утром.')
        row.get_by_test_id('ms-details').click()
        d = dialog(page)
        expect(d).to_contain_text('Кассовые смены закрыты, расхождения пояснены: Готово - Касса 1: недостача 500 ₸')
        expect(d).to_contain_text('Передача смены')
        d.get_by_role('button', name='Закрыть', exact=True).first.click()
        expect(dialog(page)).to_have_count(0)

        # The checklist template: a new closing item, a new version.
        block.get_by_test_id('ms-template').click()
        d = dialog(page)
        expect(d).to_contain_text('Версия 1')
        d.get_by_test_id('ms-template-add-closing').click()
        d.get_by_test_id('ms-template-closing-8').fill('Журнал холодильников заполнен')
        d.locator('#op-reason').fill('Добавили журнал холодильников')
        d.get_by_test_id('ms-template-save').click()
        expect(dialog(page)).to_have_count(0)
        block.get_by_test_id('ms-template').click()
        expect(dialog(page)).to_contain_text('Версия 2')
        expect(dialog(page).get_by_test_id('ms-template-closing-8')).to_have_value('Журнал холодильников заполнен')
        dialog(page).get_by_role('button', name='Закрыть', exact=True).first.click()

        # The old journal is read only.
        journal = legacy(page)
        expect(journal.get_by_test_id('op-add-shift')).to_have_count(0)
        expect(journal).to_contain_text('Прежний журнал, только для чтения')
        page.locator('summary', has_text='Кассовые смены и прежний журнал').click()

        # Positions on the card, «Доступы», the roster and the list.
        team(page)
        assert headers(page) == ['Сотрудник', 'Должность', 'Доп. станции', 'Доступ к кассе', 'Доступы',
                                 'Статус', 'Действия'], headers(page)
        row = page.locator('.workforce tbody tr', has_text='Синтетическая кассир')
        expect(row).to_contain_text('Не задан')
        expect(row).to_contain_text('Не выбрана')
        row.get_by_role('button', name='Изменить').click()
        form = page.locator('form.wf-editor')
        form.get_by_test_id('wf-position').select_option('cashier')
        expect(form.get_by_test_id('wf-pos-access')).to_have_value('cashier')
        form.get_by_test_id('wf-extra-issue').check()
        form.get_by_label('Причина добавления или изменения').fill('Назначена кассиром на станцию 1')
        capture(page, 'employee-editor-1440.png')
        form.get_by_role('button', name='Сохранить').click()
        expect(page.locator('form.wf-editor')).to_have_count(0)
        row = page.locator('.workforce tbody tr', has_text='Синтетическая кассир')
        expect(row).to_contain_text('Кассир')
        expect(row).to_contain_text('Выдача')
        expect(row).to_contain_text('Касса (PIN), экран 2 общим входом кухни')
        with page.expect_download() as info:
            page.get_by_test_id('wf-roster').click()
        download = info.value
        assert re.fullmatch(r'PickChick-состав-кассы-\d{2}\.\d{2}\.\d{4}\.json', download.suggested_filename), download.suggested_filename
        roster = json.loads(Path(download.path()).read_text())
        mine = [s for s in roster['staff'] if s['employee_id'] == config['cashier']]
        assert mine and mine[0]['role'] == 'cashier' and mine[0]['edge_staff_id'], mine
        assert re.fullmatch(r'[0-9a-f]{64}', roster['sha256'])
        expect(page.get_by_test_id('wf-roster-note')).to_contain_text('В выгрузке 2 карточки: кассиров 1')
        capture(page, 'team-1440.png', full=True)
        page.get_by_test_id('wf-positions').click()
        editor = page.get_by_test_id('wf-positions-editor')
        expect(editor).to_contain_text('Версия 1')
        page.get_by_test_id('wf-position-add').click()
        page.get_by_test_id('wf-position-label-11').fill('Мойщик')
        page.get_by_test_id('wf-positions-reason').fill('Новая должность мойщика')
        page.get_by_test_id('wf-positions-save').click()
        expect(page.get_by_test_id('wf-positions-editor')).to_have_count(0)
        assert not errors, errors
        page.close()

        # The shift manager at 390 px: opens the shift (version 2), no template, no time sheet.
        page = session(config['shift'], 390, 844)
        # The session opens #shifts; a click on the menu would race the first render at 390 px.
        block = page.get_by_test_id('manager-shift')
        expect(block.get_by_test_id('ms-closed')).to_be_visible()
        expect(block.get_by_test_id('ms-template')).to_have_count(0)
        expect(page.locator('body')).to_contain_text('Табель, ставки и начисления видят управляющий и бухгалтер.')
        block.get_by_test_id('ms-open').click()
        d = dialog(page)
        for code in OPENING:
            answer(d, code)
        no_page_scroll(page, 390)
        capture(page, 'open-dialog-shift-390.png')
        d.get_by_test_id('ms-open-save').click()
        expect(dialog(page)).to_have_count(0)
        card = block.get_by_test_id('ms-open-card')
        expect(card).to_contain_text('Смена открыта · менеджер Синтетический начальник смены')
        expect(card).to_contain_text('Кассовые смены: 2 из 2 закрыты, расхождение -500 ₸')
        expect(card.get_by_test_id('ms-close')).to_be_enabled()
        no_page_scroll(page, 390)
        capture(page, 'shift-manager-390.png')
        page.close()

        # The analyst reads; the button says who may close.
        page = session(config['analyst'])
        # The session opens #shifts; a click on the menu would race the first render at 390 px.
        card = page.get_by_test_id('manager-shift').get_by_test_id('ms-open-card')
        expect(card).to_be_visible()
        expect(card.get_by_test_id('ms-close')).to_be_disabled()
        expect(card.get_by_test_id('ms-close')).to_have_attribute(
            'title', 'Открывают и закрывают смену управляющий и начальник смены.')
        expect(card).to_contain_text('Открывают и закрывают смену управляющий и начальник смены.')
        capture(page, 'analyst-1440.png')
        page.close()

    assert not errors, errors
    browser.close()
