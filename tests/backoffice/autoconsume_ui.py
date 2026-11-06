"""Lane bo-ui step 5 «Списание по продажам» in the real back office (Chromium).

See autoconsume-browser.test.mjs. Modes: off (every flag off: no tab, no request to the new
views), on (stock v2, roles and autoconsume on cloud075: mode, coverage, queue, approval, retry,
link editor, mode dialog, shift manager at 390 px, analyst). Screenshots at 1440x900 and 390x844,
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

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--lang=ru-RU'])
    errors = []
    requests = []

    def session(credential, width=1440, height=900):
        page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1,
                                timezone_id='Asia/Almaty', locale='ru-RU')
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda r: requests.append(r.url))
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

    def no_long_dash(page, where):
        body = page.locator('body').inner_text()
        assert not any(d in body for d in LONG_DASHES), 'long dash on ' + where

    def no_page_scroll(page, width):
        scroll = page.evaluate('document.documentElement.scrollWidth')
        assert scroll <= width, (scroll, width)

    def sales_tab(page):
        nav(page, 'stock')
        tab(page, 'Списание по продажам')
        expect(page.get_by_test_id('autoconsume')).to_be_visible()
        expect(page.locator('.autoconsume-links')).not_to_contain_text('Загружаем')

    def row(page, text):
        return page.locator('.autoconsume tr', has_text=text)

    def submit(page, reason, label):
        d = dialog(page)
        d.locator('#op-reason').fill(reason)
        expect(d.get_by_test_id('op-save')).to_have_text(label)
        d.get_by_test_id('op-save').click()
        expect(dialog(page)).to_have_count(0)

    # ------------------------------------------------------------------------------------------
    if MODE == 'off':
        page = session(config['manager'])
        nav(page, 'stock')
        tabs = page.locator('.inventory-tabs')
        expect(tabs.get_by_role('button', name='Остатки')).to_be_visible()
        expect(tabs.get_by_role('button', name='Списание по продажам')).to_have_count(0)
        page.wait_for_timeout(500)
        assert not any('/ops/menu-links' in u or '/ops/consumption' in u for u in requests), requests
        capture(page, 'off-stock-1440.png')
        page.close()

    # ------------------------------------------------------------------------------------------
    if MODE == 'on':
        page = session(config['manager'])
        nav(page, 'stock')
        notice = page.get_by_test_id('stock-sales-notice')
        expect(notice).to_contain_text(re.compile(
            r'Продажи списываются со склада автоматически с \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}'))
        sales_tab(page)
        expect(page.get_by_test_id('autoconsume-mode')).to_have_text(re.compile(
            r'^Списание по продажам: Включено с \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$'))
        expect(page.get_by_test_id('autoconsume-coverage')).to_contain_text('Покрытие за 7 дней')
        expect(page.get_by_test_id('autoconsume-coverage-low')).to_contain_text(
            'Покрытие ниже 95 %: включать списание рано')
        expect(page.get_by_test_id('autoconsume-summary')).to_contain_text('Не списано: 2')
        blocked = row(page, 'Касса №72')
        expect(blocked).to_contain_text('Не списано')
        expect(blocked).to_contain_text('связь не утверждена: Синтетический бургер · Сыр')
        expect(row(page, 'Касса №71')).to_contain_text('Списано')
        expect(row(page, 'Касса №71')).to_contain_text('Документ проведён')
        expect(row(page, 'Касса №71')).to_contain_text('Синтетический картофель 0,15 кг')
        expect(row(page, 'Касса №73')).to_contain_text('связь не утверждена: Синтетическое дуо')
        links = page.locator('.autoconsume-links')
        expect(page.get_by_test_id('autoconsume-links-coverage')).to_contain_text('Меню версии 1')
        expect(links.locator('tr', has_text='Синтетическое комбо').first).to_contain_text('Из состава комбо')
        expect(links.locator('tr', has_text='Напиток: Кола')).to_contain_text('Из товара: Синтетическая кола')
        no_long_dash(page, 'autoconsume tab')
        capture(page, 'autoconsume-1440.png', full=True)

        # Approve the cheese link (the chef checked it), then «Повторить» writes the sale off.
        page.get_by_test_id('autoconsume-links-filter').select_option('draft')
        cheese = links.locator('tr', has_text='Добавки: Сыр')
        expect(cheese).to_contain_text('Черновик')
        cheese.get_by_test_id('autoconsume-link-approve').click()
        expect(dialog(page)).to_contain_text('Синтетический бургер · Добавки: Сыр')
        submit(page, 'Шеф проверил: два ломтика сыра', 'Утвердить')
        expect(links.locator('tr', has_text='Добавки: Сыр')).to_have_count(0)
        page.get_by_test_id('autoconsume-links-filter').select_option('all')
        expect(links.locator('tr', has_text='Добавки: Сыр')).to_contain_text('Утверждено')
        row(page, 'Касса №72').get_by_test_id('autoconsume-retry').click()
        expect(dialog(page)).to_contain_text('Касса №72: попытка списания сейчас')
        submit(page, 'Связь сыра утверждена', 'Повторить')
        expect(row(page, 'Касса №72')).to_contain_text('Документ проведён')
        expect(page.get_by_test_id('autoconsume-summary')).to_contain_text('Не списано: 1')

        # A link of its own for the combo drink: one can, a draft until approved.
        links.locator('tr', has_text='Напиток: Кола').get_by_test_id('autoconsume-link-edit').click()
        d = dialog(page)
        expect(d).to_contain_text('Синтетическое комбо · Напиток: Кола')
        d.get_by_test_id('autoconsume-link-target-0').select_option('i:' + config['can'])
        d.get_by_test_id('autoconsume-link-quantity-0').fill('1')
        capture(page, 'link-editor-1440.png')
        submit(page, 'Банка колы в комбо', 'Сохранить связь')
        expect(links.locator('tr', has_text='Напиток: Кола')).to_contain_text('Черновик')
        expect(links.locator('tr', has_text='Напиток: Кола')).to_contain_text('Синтетическая банка колы 1 шт')

        # The mode dialog: what happens, the coverage warning for «Включено», then dry_run.
        page.get_by_test_id('autoconsume-mode-edit').click()
        d = dialog(page)
        expect(d.get_by_test_id('autoconsume-mode-consequence')).to_contain_text('будут списываться со склада')
        expect(d.get_by_test_id('autoconsume-mode-warning')).to_be_visible()
        d.get_by_test_id('autoconsume-mode-select').select_option('dry_run')
        expect(d.get_by_test_id('autoconsume-mode-consequence')).to_contain_text('без списания')
        expect(d.get_by_test_id('autoconsume-mode-warning')).to_be_hidden()
        capture(page, 'mode-dialog-1440.png')
        submit(page, 'Проверка связей до инвентаризации', 'Сохранить режим')
        expect(page.get_by_test_id('autoconsume-mode')).to_contain_text('Проверка без списания с')
        nav(page, 'stock')
        expect(page.get_by_test_id('stock-sales-notice')).to_contain_text('режиме проверки')
        page.close()

        # The shift manager at 390 px: skip with a reason, no mode change, no link editing.
        page = session(config['shift'], 390, 844)
        sales_tab(page)
        expect(page.get_by_test_id('autoconsume-mode-edit')).to_have_count(0)
        expect(page.locator('.autoconsume-mode')).to_contain_text(
            'Режим списания по продажам меняет управляющий.')
        expect(page.get_by_test_id('autoconsume-link-edit')).to_have_count(0)
        duo = row(page, 'Касса №73')
        expect(duo.get_by_test_id('autoconsume-retry')).to_be_visible()
        no_page_scroll(page, 390)
        capture(page, 'autoconsume-shift-390.png', full=True)
        duo.get_by_test_id('autoconsume-skip').click()
        expect(dialog(page)).to_contain_text('не будет списана автоматически')
        submit(page, 'Дуо отдали взамен, расход внесён списанием', 'Пропустить')
        expect(row(page, 'Касса №73')).to_contain_text('Пропущено')
        expect(row(page, 'Касса №73')).to_contain_text('Причина: Дуо отдали взамен')
        no_page_scroll(page, 390)
        page.close()

        # The analyst: reads everything, no action anywhere.
        page = session(config['analyst'], 390, 844)
        sales_tab(page)
        expect(page.get_by_test_id('autoconsume-retry')).to_have_count(0)
        expect(page.get_by_test_id('autoconsume-skip')).to_have_count(0)
        expect(page.get_by_test_id('autoconsume-mode-edit')).to_have_count(0)
        expect(page.get_by_test_id('autoconsume-approve-all')).to_have_count(0)
        expect(page.locator('.autoconsume-links')).to_contain_text('Связи меню со складом заводит управляющий')
        no_page_scroll(page, 390)
        capture(page, 'autoconsume-analyst-390.png')
        page.close()

    browser.close()
    if errors:
        print('page errors:', errors, file=sys.stderr)
        sys.exit(1)
