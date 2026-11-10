"""Lane bo-ui2 step 2 «Закупки» in the real back office (Chromium).

See supply-browser.test.mjs. Modes: off (supply off: no section, no request to ops/suppliers or
ops/supply-requests, #supply opens «Главная»), on (roles, stock v2 and supply on 076: a supplier
and its price, a request to the supplier with the balance, the hint and the price, «Добавить всё
ниже минимума», a draft that survives a reload, save and submit, the text and its copy, print, a
partial receipt with the difference, a cancelled draft with its reason, the phone at 390 px, the
shift manager, the accountant and the analyst with disabled buttons explained in words).
Screenshots at 1440x900 and 390x844, scale 1, Asia/Almaty. Synthetic data only.
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

config = json.loads(Path(sys.argv[1]).read_text())
output = Path(config['output'])
MODE = config['mode']
LONG_DASHES = ('—', '–')
BANNER = ('Заявка сама ничего не отправляет: после подачи распечатайте её или скопируйте текст '
          'и отправьте в мессенджере.')
ALMATY = timezone(timedelta(hours=5))
TODAY = datetime.now(ALMATY).strftime('%d.%m.%Y')
CLOSE_RIGHTS = 'Принять поставку по заявке и отменить заявку может только управляющий.'
WRITE_RIGHTS = 'Заявки создают и подают управляющий и начальник смены.'
SUPPLIER_RIGHTS = 'Поставщиков и их цены ведут управляющий и бухгалтер.'
origin = '{0.scheme}://{0.netloc}'.format(urlparse(config['url']))

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--lang=ru-RU'])
    errors = []
    requests = []

    def session(credential, width=1440, height=900):
        context = browser.new_context(viewport={'width': width, 'height': height},
                                      device_scale_factor=1, timezone_id='Asia/Almaty',
                                      locale='ru-RU')
        context.grant_permissions(['clipboard-read', 'clipboard-write'], origin=origin)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda r: requests.append(r.url))
        page.on('dialog', lambda d: d.accept())
        page.goto(config['url'] + '#supply')
        page.get_by_test_id('credential-file').set_input_files({
            'name': 'person.json', 'mimeType': 'application/json',
            'buffer': json.dumps(credential).encode()}, timeout=15000)
        expect(page.locator('.user')).to_be_visible()
        page.wait_for_function("() => !document.body.innerText.includes('Загружаем данные')")
        return page

    def close(page):
        page.context.close()

    def capture(page, name, full=False):
        page.evaluate("""async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}""")
        page.screenshot(path=str(output / name), full_page=full)

    def dialog(page, testid=None):
        d = page.locator('dialog.op-dialog[open]')
        return d if testid is None else page.locator(f'dialog.op-dialog[open][data-testid="{testid}"]')

    def no_long_dash(page, where):
        body = page.locator('body').inner_text()
        assert not any(d in body for d in LONG_DASHES), 'long dash on ' + where

    def no_page_scroll(page, width):
        scroll = page.evaluate('document.documentElement.scrollWidth')
        assert scroll <= width, (scroll, width)

    def inside(locator, width):
        b = locator.bounding_box()
        assert b and b['x'] >= 0 and b['x'] + b['width'] <= width + 0.5, b

    def request_row(page, number):
        return page.get_by_test_id('sp-requests').locator('tbody tr', has_text=f'№ {number}')

    # ------------------------------------------------------------------------------------------
    if MODE == 'off':
        page = session(config['manager'])
        expect(page.locator('h1')).to_have_text('Главная')
        expect(page.get_by_test_id('nav-supply')).to_have_count(0)
        expect(page.get_by_test_id('supply')).to_have_count(0)
        page.get_by_test_id('nav-stock').click()
        expect(page.locator('body')).not_to_contain_text('Закупки')
        page.wait_for_timeout(500)
        assert not any('/ops/suppliers' in u or '/ops/supply-requests' in u for u in requests), requests
        capture(page, 'off-stock-1440.png')
        close(page)

    # ------------------------------------------------------------------------------------------
    if MODE == 'on':
        page = session(config['manager'])
        section = page.get_by_test_id('supply')
        expect(section).to_be_visible()
        expect(page.locator('h1')).to_have_text('Закупки')
        expect(page.get_by_test_id('sp-banner')).to_have_text(BANNER)
        labels = [t.strip() for t in page.locator('nav.navigation .nav-item').all_inner_texts()]
        assert labels.index('Закупки') == labels.index('Остатки') + 1, labels
        expect(page.locator('.op-periods')).to_have_count(0)
        expect(section).to_contain_text('Заявок за этот период нет.')

        # Suppliers: a new one, a taken name, its price with the history.
        page.get_by_test_id('sp-tab-suppliers').click()
        expect(section).to_contain_text('Поставщиков пока нет.')
        page.get_by_test_id('sp-supplier-new').click()
        d = dialog(page, 'sp-supplier-editor')
        d.get_by_test_id('sp-supplier-save').click()
        expect(d.locator('.op-form-error')).to_contain_text('Введите название поставщика')
        d.get_by_test_id('sp-supplier-name').fill('  Поставщик   1 ')
        d.get_by_test_id('sp-supplier-kind').select_option('supplier')
        d.get_by_test_id('sp-supplier-save').click()
        expect(dialog(page)).to_have_count(0)
        row = page.get_by_test_id('sp-suppliers').locator('tbody tr', has_text='Поставщик 1')
        expect(row).to_contain_text('Цен нет')
        page.get_by_test_id('sp-supplier-new').click()
        d = dialog(page, 'sp-supplier-editor')
        d.get_by_test_id('sp-supplier-name').fill('поставщик 1')
        d.get_by_test_id('sp-supplier-kind').select_option('bakery')
        d.get_by_test_id('sp-supplier-save').click()
        expect(d.locator('.op-form-error')).to_have_text(
            'Поставщик с таким названием уже есть (возможно, в архиве). Выберите другое название.')
        d.get_by_test_id('sp-supplier-name').fill('Пекарня 1')
        d.get_by_test_id('sp-supplier-save').click()
        expect(dialog(page)).to_have_count(0)
        row.get_by_test_id('sp-prices').click()
        d = dialog(page, 'sp-prices-dialog')
        expect(d).to_contain_text('Цен этого поставщика пока нет.')
        d.get_by_test_id('sp-price-item').select_option(label='Синтетическое филе')
        expect(d.get_by_test_id('sp-price-unit')).to_have_value('kg')
        d.get_by_test_id('sp-price-value').fill('2 400')
        d.get_by_test_id('sp-price-save').click()
        prices = d.get_by_test_id('sp-price-table').locator('tbody tr')
        expect(prices).to_have_count(1)
        expect(prices.nth(0)).to_contain_text('2 400 ₸ за 1 кг')
        expect(prices.nth(0)).to_contain_text('В силе')
        # A correction of the same day raises its version.
        prices.nth(0).get_by_test_id('sp-price-fix').click()
        expect(d.get_by_test_id('sp-price-value')).to_have_value('2400')
        d.get_by_test_id('sp-price-value').fill('2500')
        d.get_by_test_id('sp-price-save').click()
        expect(prices.nth(0)).to_contain_text('2 500 ₸ за 1 кг')
        expect(prices.nth(0)).to_contain_text('Вручную, исправлена (версия 2)')
        no_long_dash(page, 'prices')
        capture(page, 'prices-1440.png')
        d.get_by_test_id('sp-close').click()
        expect(row).to_contain_text(f'1, последняя с {TODAY}')

        # A request to the supplier: the facts of each line, the price and the hint lines.
        page.get_by_test_id('sp-tab-requests').click()
        page.get_by_test_id('sp-new').click()
        d = dialog(page, 'sp-editor')
        d.get_by_test_id('sp-kind').select_option('supplier')
        d.get_by_test_id('sp-supplier').select_option(label='Поставщик 1')
        d.get_by_test_id('sp-line-add').click()
        d.get_by_test_id('sp-line-item-0').select_option(label='Синтетическое филе')
        d.get_by_test_id('sp-line-qty-0').fill('1,5')
        d.get_by_test_id('sp-line-unit-0').select_option('kg')
        line = d.get_by_test_id('sp-line').nth(0)
        expect(line.get_by_test_id('sp-line-facts')).to_have_text(
            'Остаток: 0 кг · Минимум: 1 кг · Подсказка: 1 кг')
        expect(line.get_by_test_id('sp-line-price')).to_have_text(
            f'Цена: 2 500 ₸ за 1 кг с {TODAY} · Сумма ≈ 3 750 ₸')
        d.get_by_test_id('sp-line-below').click()
        lines = d.get_by_test_id('sp-line')
        expect(lines).to_have_count(2)
        expect(d.get_by_test_id('sp-line-qty-1')).to_have_value('6')
        expect(lines.nth(1).get_by_test_id('sp-line-facts')).to_have_text(
            'Остаток: 4 шт · Минимум: 10 шт · Подсказка: 6 шт')
        expect(lines.nth(1).get_by_test_id('sp-line-price')).to_have_text(
            'Цены этого поставщика на позицию нет.')
        d.get_by_test_id('sp-note').fill('К утру')
        no_long_dash(page, 'request editor')
        capture(page, 'editor-1440.png')
        # The draft of the editor survives a reload.
        page.reload()
        expect(page.get_by_test_id('supply')).to_be_visible()
        page.get_by_test_id('sp-new').click()
        d = dialog(page, 'sp-editor')
        expect(d.get_by_test_id('sp-restored')).to_have_text('Восстановлен несохранённый ввод.')
        expect(d.get_by_test_id('sp-supplier').locator('option:checked')).to_have_text('Поставщик 1')
        expect(d.get_by_test_id('sp-line')).to_have_count(2)
        d.get_by_test_id('sp-save-submit').click()
        d = dialog(page, 'sp-request')
        expect(d.locator('h2')).to_have_text('Заявка № 1 - Поставщику')
        expect(d.get_by_test_id('sp-request-state')).to_have_text('Подана')
        expect(d.get_by_test_id('sp-request-total')).to_have_text(
            'Сумма по ценам поставщика: 3 750 ₸, без цены: 1 поз.')
        text = d.get_by_test_id('sp-text')
        expect(text).to_have_value(
            f'Заявка № 1 от {TODAY} поставщику\nНужно к: '
            + (datetime.now(ALMATY) + timedelta(days=1)).strftime('%d.%m.%Y')
            + '\nПоставщик: Поставщик 1\nПримечание: К утру\n\n'
            '1. Синтетическое филе - 1,5 кг\n2. Синтетическая булка - 6 шт\n\nПозиций: 2')
        d.get_by_test_id('sp-copy').click()
        expect(d.get_by_test_id('sp-copied')).to_have_text(
            'Текст скопирован. Отправьте его в мессенджере вручную: система сама ничего не отправляет.')
        assert page.evaluate('navigator.clipboard.readText()').startswith('Заявка № 1 от ')
        # Print: only the sheet of the request is printed.
        page.evaluate('() => { window.__printed = 0; window.print = function () { window.__printed += 1; }; }')
        d.get_by_test_id('sp-print').click()
        assert page.evaluate('() => window.__printed') == 1, errors
        sheet = page.get_by_test_id('sp-print-root')
        expect(sheet).to_contain_text('Заявка № 1 - Поставщику')
        expect(sheet.locator('tr')).to_have_count(3)
        page.evaluate("window.dispatchEvent(new Event('afterprint'))")
        expect(sheet).to_have_count(0)
        expect(d.get_by_test_id('sp-edit')).to_have_count(0)
        no_long_dash(page, 'request card')
        capture(page, 'request-1440.png')

        # Receipt by the request: 1 kg of 1,5 and no bun; the difference before posting.
        d.get_by_test_id('sp-receive').click()
        r = dialog(page, 'sp-receive-dialog')
        expect(r.get_by_test_id('sp-receive-from')).to_have_text('Откуда: Поставщик · Поставщик: Поставщик 1')
        expect(r.get_by_test_id('sp-receive-qty-0')).to_have_value('1,5')
        expect(r.get_by_test_id('sp-receive-unit-0')).to_have_value('kg')
        expect(r.get_by_test_id('sp-receive-qty-1')).to_have_value('6')
        r.get_by_test_id('sp-receive-confirm').click()
        err = r.locator('.op-form-error')
        expect(err).to_contain_text('Укажите номер накладной.')
        expect(err).to_contain_text('Проверьте документ и отметьте подтверждение.')
        r.get_by_test_id('sp-receive-reference').fill('НАК-7')
        r.get_by_test_id('sp-receive-qty-0').fill('1')
        r.get_by_test_id('sp-receive-cost-0').fill('2500')
        r.get_by_test_id('sp-receive-remove-1').click()
        diff = r.get_by_test_id('sp-difference')
        expect(diff).to_contain_text('Получено не так, как заказали')
        rows = diff.locator('tbody tr')
        expect(rows).to_have_count(2)
        expect(rows.nth(0)).to_contain_text('-0,5 кг')
        expect(rows.nth(1)).to_contain_text('-6 шт')
        r.get_by_test_id('sp-receive-reviewed').check()
        no_long_dash(page, 'receipt dialog')
        capture(page, 'receive-1440.png')
        r.get_by_test_id('sp-receive-confirm').click()
        expect(dialog(page, 'sp-receive-dialog')).to_have_count(0)
        d = dialog(page, 'sp-request')
        expect(d.get_by_test_id('sp-request-state')).to_have_text('Получена')
        expect(d.get_by_test_id('sp-receipt')).to_have_text(
            f'Поставка проведена: накладная НАК-7 от {TODAY}, сумма 2 500 ₸, Синтетический управляющий.')
        expect(d.get_by_test_id('sp-difference').locator('tbody tr')).to_have_count(2)
        expect(d.get_by_test_id('sp-receive')).to_have_count(0)
        expect(d.get_by_test_id('sp-cancel')).to_have_count(0)
        capture(page, 'received-1440.png')
        d.get_by_test_id('sp-close').click()
        expect(request_row(page, 1).get_by_test_id('sp-state')).to_have_text('Получена')
        expect(request_row(page, 1)).to_contain_text('2 поз.: Синтетическое филе, Синтетическая булка')
        expect(request_row(page, 1)).to_contain_text('3 750 ₸, без цены: 1 поз.')

        # A draft to the bakery, cancelled with a reason.
        page.get_by_test_id('sp-new').click()
        d = dialog(page, 'sp-editor')
        expect(d.get_by_test_id('sp-restored')).to_have_count(0)
        d.get_by_test_id('sp-kind').select_option('bakery')
        d.get_by_test_id('sp-line-add').click()
        d.get_by_test_id('sp-line-item-0').select_option(label='Синтетическая булка')
        d.get_by_test_id('sp-line-qty-0').fill('10')
        d.get_by_test_id('sp-save').click()
        d = dialog(page, 'sp-request')
        expect(d.get_by_test_id('sp-request-state')).to_have_text('Черновик')
        expect(d.get_by_test_id('sp-text')).to_have_value(
            f'Заявка № 2 от {TODAY} в пекарню (черновик)\nНужно к: '
            + (datetime.now(ALMATY) + timedelta(days=1)).strftime('%d.%m.%Y')
            + '\n\n1. Синтетическая булка - 10 шт\n\nПозиций: 1')
        d.get_by_test_id('sp-cancel').click()
        c = dialog(page, 'sp-cancel-dialog')
        c.get_by_test_id('sp-cancel-confirm').click()
        expect(c.locator('.op-form-error')).to_have_text('Укажите причину отмены: минимум 3 символа.')
        c.get_by_test_id('sp-cancel-reason').fill('Пекарня привезёт сама')
        c.get_by_test_id('sp-cancel-confirm').click()
        expect(dialog(page, 'sp-cancel-dialog')).to_have_count(0)
        d = dialog(page, 'sp-request')
        expect(d.get_by_test_id('sp-request-state')).to_have_text('Отменена')
        expect(d).to_contain_text('Причина отмены')
        expect(d).to_contain_text('Пекарня привезёт сама')
        d.get_by_test_id('sp-close').click()
        expect(page.get_by_test_id('sp-counts')).to_have_text(
            'Черновик: 0 · Подана: 0 · Получена: 1 · Отменена: 1')
        page.get_by_test_id('sp-state-filter').select_option('cancelled')
        page.get_by_test_id('sp-show').click()
        expect(page.get_by_test_id('sp-requests').locator('tbody tr')).to_have_count(1)
        expect(request_row(page, 2)).to_be_visible()
        no_long_dash(page, 'request list')
        capture(page, 'requests-1440.png')
        assert not errors, errors
        close(page)

        # The manager at 390 px: the list and the card fit, amounts and buttons on screen.
        page = session(config['manager'], 390, 844)
        expect(page.get_by_test_id('sp-banner')).to_have_text(BANNER)
        r1 = request_row(page, 1)
        expect(r1).to_be_visible()
        inside(r1.get_by_test_id('sp-state'), 390)
        inside(r1.get_by_test_id('sp-open'), 390)
        no_page_scroll(page, 390)
        capture(page, 'requests-390.png', full=True)
        r1.get_by_test_id('sp-open').click()
        d = dialog(page, 'sp-request')
        expect(d.get_by_test_id('sp-request-state')).to_have_text('Получена')
        no_page_scroll(page, 390)
        inside(d, 390)
        inside(d.get_by_test_id('sp-copy'), 390)
        capture(page, 'received-390.png')
        d.get_by_test_id('sp-close').click()
        close(page)

        # The shift manager at 390 px: creates and submits; receipt and cancel are explained.
        page = session(config['shift'], 390, 844)
        expect(page.get_by_test_id('sp-new')).to_be_enabled()
        page.get_by_test_id('sp-new').click()
        d = dialog(page, 'sp-editor')
        d.get_by_test_id('sp-kind').select_option('central_kitchen')
        d.get_by_test_id('sp-line-add').click()
        d.get_by_test_id('sp-line-item-0').select_option(label='Синтетическая соль')
        d.get_by_test_id('sp-line-qty-0').fill('500')
        expect(d.get_by_test_id('sp-line').nth(0).get_by_test_id('sp-line-facts')).to_have_text(
            'Остаток: 0 кг · Минимум: не задан · Подсказка: нет минимума')
        no_page_scroll(page, 390)
        inside(d.get_by_test_id('sp-save-submit'), 390)
        capture(page, 'editor-shift-390.png')
        d.get_by_test_id('sp-save-submit').click()
        d = dialog(page, 'sp-request')
        expect(d.get_by_test_id('sp-request-state')).to_have_text('Подана')
        expect(d.get_by_test_id('sp-receive')).to_be_disabled()
        expect(d.get_by_test_id('sp-cancel')).to_be_disabled()
        expect(d.get_by_test_id('sp-action-rights')).to_have_text(CLOSE_RIGHTS)
        expect(d.get_by_test_id('sp-receive')).to_have_attribute(
            'aria-describedby', d.get_by_test_id('sp-action-rights').get_attribute('id'))
        capture(page, 'request-shift-390.png')
        d.get_by_test_id('sp-close').click()
        page.get_by_test_id('sp-tab-suppliers').click()
        expect(page.get_by_test_id('sp-supplier-new')).to_be_disabled()
        expect(page.get_by_test_id('sp-supplier-rights')).to_have_text(SUPPLIER_RIGHTS)
        page.get_by_test_id('sp-suppliers').locator('tbody tr', has_text='Поставщик 1').get_by_test_id('sp-prices').click()
        d = dialog(page, 'sp-prices-dialog')
        expect(d.get_by_test_id('sp-price-rights')).to_have_text(SUPPLIER_RIGHTS)
        expect(d.get_by_test_id('sp-price-form')).to_have_count(0)
        no_page_scroll(page, 390)
        d.get_by_test_id('sp-close').click()
        assert not errors, errors
        close(page)

        # The accountant: suppliers yes, requests read only.
        page = session(config['accountant'])
        expect(page.get_by_test_id('sp-new')).to_be_disabled()
        expect(page.get_by_test_id('sp-rights')).to_have_text(WRITE_RIGHTS)
        request_row(page, 3).get_by_test_id('sp-open').click()
        d = dialog(page, 'sp-request')
        expect(d.get_by_test_id('sp-receive')).to_be_disabled()
        expect(d.get_by_test_id('sp-action-rights')).to_have_text(CLOSE_RIGHTS)
        d.get_by_test_id('sp-close').click()
        page.get_by_test_id('sp-tab-suppliers').click()
        expect(page.get_by_test_id('sp-supplier-new')).to_be_enabled()
        close(page)

        # The analyst reads everything and changes nothing.
        page = session(config['analyst'])
        expect(page.get_by_test_id('sp-new')).to_be_disabled()
        expect(request_row(page, 3)).to_be_visible()
        page.get_by_test_id('sp-tab-suppliers').click()
        expect(page.get_by_test_id('sp-supplier-new')).to_be_disabled()
        expect(page.get_by_test_id('sp-supplier-edit')).to_have_count(0)
        capture(page, 'suppliers-analyst-1440.png')
        close(page)

    assert not errors, errors
    browser.close()
