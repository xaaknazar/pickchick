"""Lane bo-ui step 7 «Скидки» in the real back office (Chromium).

See discounts-browser.test.mjs. Modes: off (every flag off: no section, no request to
ops/discounts, #discounts opens «Главная»), on (roles and discounts on cloud075 with a published
synthetic catalog: the banner, validation in words, create with categories, products, channels,
period, weekdays and hours, a draft that survives a reload, a taken name, switch on, an edit of a
live discount back to draft, the history, the archive and its filter, the shift manager at 390 px
without buttons). Screenshots at 1440x900 and 390x844, scale 1, Asia/Almaty. Synthetic data only.
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

config = json.loads(Path(sys.argv[1]).read_text())
output = Path(config['output'])
MODE = config['mode']
LONG_DASHES = ('—', '–')
BANNER = 'Скидки пока не применяются на кассе. Включим после проверки на кассе.'

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--lang=ru-RU'])
    errors = []
    requests = []

    def session(credential, width=1440, height=900):
        page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1,
                                timezone_id='Asia/Almaty', locale='ru-RU')
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda r: requests.append(r.url))
        page.on('dialog', lambda d: d.accept())
        page.goto(config['url'] + '#discounts')
        page.get_by_test_id('credential-file').set_input_files({
            'name': 'person.json', 'mimeType': 'application/json',
            'buffer': json.dumps(credential).encode()}, timeout=15000)
        expect(page.locator('.user')).to_be_visible()
        page.wait_for_function("() => !document.body.innerText.includes('Загружаем данные')")
        return page

    def capture(page, name, full=False):
        page.evaluate("""async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}""")
        page.screenshot(path=str(output / name), full_page=full)

    def dialog(page):
        return page.locator('dialog.op-dialog[open]')

    def no_long_dash(page, where):
        body = page.locator('body').inner_text()
        assert not any(d in body for d in LONG_DASHES), 'long dash on ' + where

    def no_page_scroll(page, width):
        scroll = page.evaluate('document.documentElement.scrollWidth')
        assert scroll <= width, (scroll, width)

    def row(page, name):
        return page.get_by_test_id('dc-table').locator('tbody tr', has_text=name)

    # ------------------------------------------------------------------------------------------
    if MODE == 'off':
        page = session(config['manager'])
        expect(page.locator('h1')).to_have_text('Главная')
        expect(page.get_by_test_id('nav-discounts')).to_have_count(0)
        expect(page.get_by_test_id('discounts')).to_have_count(0)
        expect(page.locator('body')).not_to_contain_text('Скидки пока не применяются')
        page.wait_for_timeout(500)
        assert not any('/ops/discounts' in u for u in requests), requests
        capture(page, 'off-dash-1440.png')
        page.close()

    # ------------------------------------------------------------------------------------------
    if MODE == 'on':
        page = session(config['manager'])
        section = page.get_by_test_id('discounts')
        expect(section).to_be_visible()
        expect(page.locator('h1')).to_have_text('Скидки')
        expect(page.get_by_test_id('dc-banner')).to_have_text(BANNER)
        expect(section).to_contain_text('Скидок пока нет. На запуске скидок нет')
        # «Скидки» after «Промо и баннеры»; no period switch on this page.
        labels = [t.strip() for t in page.locator('nav.navigation .nav-item').all_inner_texts()]
        assert labels.index('Скидки') == labels.index('Промо и баннеры') + 1, labels
        expect(page.locator('.op-periods')).to_have_count(0)
        no_long_dash(page, 'empty discounts')

        # Validation in words before anything is sent.
        page.get_by_test_id('dc-new').click()
        d = dialog(page)
        expect(d).to_have_attribute('data-testid', 'dc-editor')
        expect(d.get_by_test_id('dc-pin')).to_be_checked()
        expect(d.get_by_test_id('dc-combinable')).not_to_be_checked()
        expect(d.get_by_test_id('dc-channel-hall')).to_be_checked()
        d.get_by_test_id('dc-save').click()
        err = d.locator('.op-form-error')
        expect(err).to_contain_text('Введите название скидки')
        expect(err).to_contain_text('Процент скидки - от 1 до 100')
        d.get_by_test_id('dc-name').fill('Обед будни')
        d.get_by_test_id('dc-value').fill('101')
        d.get_by_test_id('dc-whole').uncheck()
        d.get_by_test_id('dc-day-6').uncheck()
        d.get_by_test_id('dc-day-7').uncheck()
        d.get_by_test_id('dc-save').click()
        expect(err).to_contain_text('Процент скидки - от 1 до 100')
        expect(err).to_contain_text('Выберите категории или позиции меню')
        # The full discount: 12,5 % on a category and a product, two channels, a period, weekdays
        # Monday to Friday and lunch hours.
        d.get_by_test_id('dc-value').fill('12,5')
        d.get_by_test_id('dc-cat-chicken').check()
        d.get_by_test_id('dc-prod-cola').check()
        d.get_by_test_id('dc-channel-yandex_eda').check()
        d.get_by_test_id('dc-start').fill('2099-11-20')
        d.get_by_test_id('dc-end').fill('2099-11-30')
        d.get_by_test_id('dc-hour-add').click()
        d.get_by_test_id('dc-from-0').fill('12:00')
        d.get_by_test_id('dc-to-0').fill('15:00')
        no_long_dash(page, 'editor')
        capture(page, 'editor-1440.png')
        d.get_by_test_id('dc-save').click()
        expect(dialog(page)).to_have_count(0)
        r = row(page, 'Обед будни')
        expect(r.get_by_test_id('dc-value-text')).to_have_text('12,5 %')
        expect(r).to_contain_text('Категории: Синтетическая курица; Позиции: Синтетическая кола')
        expect(r).to_contain_text('Каналы: Зал, Яндекс Еда')
        expect(r).to_contain_text('с 20.11.2099 по 30.11.2099; Пн, Вт, Ср, Чт, Пт; 12:00-15:00')
        expect(r).to_contain_text('PIN начальника смены, не суммируется')
        expect(r.get_by_test_id('dc-state')).to_have_text('Черновик, ещё не началась')
        expect(r).to_contain_text(', Синтетический управляющий')

        # A draft of the editor survives a reload; Esc asks and then drops it.
        page.get_by_test_id('dc-new').click()
        d = dialog(page)
        d.get_by_test_id('dc-name').fill('Недописанная скидка')
        d.get_by_test_id('dc-value').fill('5')
        page.reload()
        expect(page.get_by_test_id('discounts')).to_be_visible()
        expect(row(page, 'Обед будни')).to_be_visible()
        page.get_by_test_id('dc-new').click()
        d = dialog(page)
        expect(d.get_by_test_id('dc-restored')).to_have_text('Восстановлен несохранённый ввод.')
        expect(d.get_by_test_id('dc-name')).to_have_value('Недописанная скидка')
        page.keyboard.press('Escape')
        expect(dialog(page)).to_have_count(0)
        page.get_by_test_id('dc-new').click()
        d = dialog(page)
        expect(d.get_by_test_id('dc-restored')).to_have_count(0)
        expect(d.get_by_test_id('dc-name')).to_have_value('')

        # A live name is taken whatever the case; an amount in tenge for every channel.
        d.get_by_test_id('dc-name').fill('обед будни')
        d.get_by_test_id('dc-kind').select_option('amount')
        d.get_by_test_id('dc-value').fill('500')
        for code in ['yandex_eda', 'glovo', 'chocofood', 'mobile', 'kiosk']:
            d.get_by_test_id('dc-channel-' + code).check()
        d.get_by_test_id('dc-combinable').check()
        d.get_by_test_id('dc-save').click()
        expect(d.locator('.op-form-error')).to_have_text(
            'Скидка с таким названием уже есть. Выберите другое название.')
        d.get_by_test_id('dc-name').fill('Ужин 500')
        d.get_by_test_id('dc-save').click()
        expect(dialog(page)).to_have_count(0)
        r2 = row(page, 'Ужин 500')
        expect(r2).to_contain_text('500 ₸')
        expect(r2).to_contain_text('Каналы: Все каналы')
        expect(r2).to_contain_text('Всё меню')
        expect(r2).to_contain_text('Без срока; Каждый день; Весь день')
        expect(r2).to_contain_text('PIN начальника смены, вместе с другими скидками')

        # Switch on, then an edit returns the live discount to draft.
        row(page, 'Обед будни').get_by_test_id('dc-to-active').click()
        d = dialog(page)
        expect(d).to_have_attribute('data-testid', 'dc-state-dialog')
        expect(d).to_contain_text('сейчас касса скидки не применяет')
        d.get_by_test_id('dc-state-confirm').click()
        expect(dialog(page)).to_have_count(0)
        expect(row(page, 'Обед будни').get_by_test_id('dc-state')).to_have_text(
            'Включена, ещё не началась')
        row(page, 'Обед будни').get_by_test_id('dc-edit').click()
        d = dialog(page)
        expect(d).to_contain_text('Скидка сейчас включена. После сохранения она станет черновиком')
        expect(d.get_by_test_id('dc-value')).to_have_value('12,5')
        expect(d.get_by_test_id('dc-start')).to_have_value('2099-11-20')
        expect(d.get_by_test_id('dc-end')).to_have_value('2099-11-30')
        expect(d.get_by_test_id('dc-cat-chicken')).to_be_checked()
        expect(d.get_by_test_id('dc-day-6')).not_to_be_checked()
        d.get_by_test_id('dc-value').fill('15')
        d.get_by_test_id('dc-reason').fill('Скидка на обед 15 % по решению владельца')
        d.get_by_test_id('dc-save').click()
        expect(dialog(page)).to_have_count(0)
        expect(row(page, 'Обед будни')).to_contain_text('15 %')
        expect(row(page, 'Обед будни').get_by_test_id('dc-state')).to_have_text(
            'Черновик, ещё не началась')

        # History: three versions, newest first, with the author.
        row(page, 'Обед будни').get_by_test_id('dc-history').click()
        d = dialog(page)
        expect(d).to_have_attribute('data-testid', 'dc-history-dialog')
        versions = d.locator('tbody tr')
        expect(versions).to_have_count(3)
        expect(versions.nth(0)).to_contain_text('15 %')
        expect(versions.nth(1)).to_contain_text('Включена')
        expect(versions.nth(2)).to_contain_text('12,5 %')
        expect(versions.nth(0)).to_contain_text('Синтетический управляющий')
        capture(page, 'history-1440.png')
        d.get_by_test_id('dc-close').click()
        expect(dialog(page)).to_have_count(0)

        # The archive is final: the row leaves the live list and has no edit there.
        row(page, 'Ужин 500').get_by_test_id('dc-to-archived').click()
        d = dialog(page)
        expect(d).to_contain_text('Архив нельзя вернуть')
        d.get_by_test_id('dc-state-confirm').click()
        expect(dialog(page)).to_have_count(0)
        expect(row(page, 'Ужин 500')).to_have_count(0)
        page.get_by_test_id('dc-filter').select_option('archived')
        expect(row(page, 'Ужин 500').get_by_test_id('dc-state')).to_have_text('В архиве')
        expect(row(page, 'Ужин 500').get_by_test_id('dc-edit')).to_have_count(0)
        expect(row(page, 'Ужин 500').get_by_test_id('dc-to-active')).to_have_count(0)
        page.get_by_test_id('dc-filter').select_option('all')
        no_long_dash(page, 'discount list')
        capture(page, 'discounts-1440.png')
        assert not errors, errors
        page.close()

        # The manager's editor at 390 px: every field on screen, no horizontal scroll.
        page = session(config['manager'], 390, 844)
        expect(page.get_by_test_id('dc-banner')).to_have_text(BANNER)
        page.get_by_test_id('dc-new').click()
        d = dialog(page)
        no_page_scroll(page, 390)
        box = d.bounding_box()
        assert box['x'] >= 0 and box['x'] + box['width'] <= 390, box
        capture(page, 'editor-390.png')
        d.get_by_test_id('dc-close').click()
        page.close()

        # The shift manager reads at 390 px: no buttons that change, the reason in words.
        page = session(config['shift'], 390, 844)
        section = page.get_by_test_id('discounts')
        expect(section).to_be_visible()
        expect(page.get_by_test_id('dc-banner')).to_have_text(BANNER)
        expect(page.get_by_test_id('dc-rights')).to_have_text(
            'Скидки создаёт и меняет только управляющий точки.')
        expect(page.get_by_test_id('dc-new')).to_have_count(0)
        expect(section.get_by_test_id('dc-edit')).to_have_count(0)
        expect(section.get_by_test_id('dc-to-active')).to_have_count(0)
        expect(section.get_by_test_id('dc-to-archived')).to_have_count(0)
        r = row(page, 'Обед будни')
        expect(r.get_by_test_id('dc-history')).to_be_visible()
        # The phone card keeps the amount and the state on screen.
        for cell in [r.get_by_test_id('dc-value-text'), r.get_by_test_id('dc-state')]:
            b = cell.bounding_box()
            assert b and b['x'] >= 0 and b['x'] + b['width'] <= 390, b
        expect(r.locator('td').nth(0)).to_have_attribute('data-label', 'Скидка')
        expect(r.get_by_test_id('dc-value-text')).to_have_text('15 %')
        no_page_scroll(page, 390)
        capture(page, 'discounts-shift-390.png', full=True)
        page.close()

        # The analyst reads too.
        page = session(config['analyst'])
        expect(page.get_by_test_id('dc-rights')).to_be_visible()
        expect(page.get_by_test_id('dc-new')).to_have_count(0)
        expect(row(page, 'Обед будни')).to_be_visible()
        page.close()

    assert not errors, errors
    browser.close()
