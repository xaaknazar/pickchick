"""Lane bo-ui step 8: one pass over every new or changed P1 screen, every role, two widths.

See p1-pass-browser.test.mjs. Every flag is on; the fixture holds a published menu with
approved links, automatic consumption (one sale written off, one blocked), a count with a
shortage, a waste, today's cash day of two desks, an open manager shift, a card with a position,
a draft and a live discount. The manager, the shift manager, the accountant and the analyst open
each screen at 1440x900 and 390x844 (scale 1, Asia/Almaty). On every screen: no page error, no
horizontal page scroll, no long dash, no «undefined», «NaN», «[object Object]» or raw ISO time in
the text, every visible button inside the window; the role sees exactly its buttons. The pass
only reads: it opens no dialog that sends anything. Synthetic data only.
"""
import json
import re
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

config = json.loads(Path(sys.argv[1]).read_text())
output = Path(config['output'])
LONG_DASHES = ('—', '–')
BAD_TEXT = re.compile(r'undefined|NaN|\[object Object\]|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}')
ROLES = {
    'manager': config['manager'],
    'shift': config['shift'],
    'accountant': config['accountant'],
    'analyst': config['analyst'],
}
# What each role may do on the P1 screens (design-bo-ui 4).
CAN = {
    'manager': {'count': True, 'reverse': True, 'discounts': True, 'shift': True, 'mode': True,
                'team': True},
    'shift': {'count': True, 'reverse': False, 'discounts': False, 'shift': True, 'mode': False,
              'team': False},
    'accountant': {'count': False, 'reverse': True, 'discounts': False, 'shift': False,
                   'mode': False, 'team': True},
    'analyst': {'count': False, 'reverse': False, 'discounts': False, 'shift': False,
                'mode': False, 'team': True},
}
STOCK_TABS = ['Остатки', 'Документы', 'Списания', 'Движение', 'Расхождения подсчёта',
              'Расход по продажам', 'Списание по продажам', 'Техкарты', 'Ингредиенты']
REPORT_TABS = {'Списания', 'Движение', 'Расхождения подсчёта', 'Расход по продажам'}

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--lang=ru-RU'])
    errors = []
    failures = []
    shots = 0

    def session(credential, width, height):
        page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1,
                                timezone_id='Asia/Almaty', locale='ru-RU')
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda d: d.accept())
        page.goto(config['url'] + '#dash')
        page.get_by_test_id('credential-file').set_input_files({
            'name': 'person.json', 'mimeType': 'application/json',
            'buffer': json.dumps(credential).encode()}, timeout=15000)
        expect(page.locator('.user')).to_be_visible()
        page.wait_for_function("() => !document.body.innerText.includes('Загружаем данные')")
        return page

    def settle(page):
        page.wait_for_function(
            "() => !document.body.innerText.includes('Загружаем') && !document.body.innerText.includes('Обновляем…')",
            timeout=15000)
        page.evaluate("""async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}""")

    def nav(page, section):
        item = page.get_by_test_id('nav-' + section)
        if not item.is_visible():
            page.get_by_test_id('navigation-toggle').click()
        item.click()
        settle(page)

    def check(page, role, screen, width):
        """The generic rules of the pass; a failure is collected, the pass goes on."""
        nonlocal_shots[0] += 1
        where = f'{role} {screen} {width}'
        text = page.locator('body').inner_text()
        if any(d in text for d in LONG_DASHES):
            failures.append(where + ': long dash')
        bad = BAD_TEXT.search(text)
        if bad:
            failures.append(where + ': raw text ' + repr(bad.group(0)))
        scroll = page.evaluate('document.documentElement.scrollWidth')
        if scroll > width:
            failures.append(f'{where}: page scrolls sideways ({scroll} > {width})')
        # Every visible button fits into the window (a button cut off on a phone is a bug);
        # a button inside a sideways scrolling table (the schedule grid) is reached by scrolling.
        cut = page.evaluate("""(w) => [...document.querySelectorAll('button, a.button')]
            .filter(b => {
              if (b.offsetParent === null || b.closest('dialog:not([open])')) return false;
              for (let a = b.parentElement; a && a !== document.body; a = a.parentElement)
                if (['auto', 'scroll'].includes(getComputedStyle(a).overflowX) && a.scrollWidth > a.clientWidth)
                  return false;
              return true;
            })
            .map(b => [b.innerText.trim(), b.getBoundingClientRect()])
            .filter(([t, r]) => r.width > 0 && (r.right > w + 1 || r.left < -1))
            .map(([t, r]) => t + ' ' + Math.round(r.left) + '..' + Math.round(r.right))""", width)
        if cut:
            failures.append(f'{where}: buttons outside the window {cut[:5]}')
        page.screenshot(path=str(output / f'{role}-{screen}-{width}.png'), full_page=width == 390)

    nonlocal_shots = [0]

    def stock_tab(page, name):
        page.locator('.inventory-tabs').get_by_role('button', name=name, exact=True).click()
        settle(page)

    def run_report(page, name):
        view = {'Списания': 'waste', 'Движение': 'movement', 'Расхождения подсчёта': 'variance',
                'Расход по продажам': 'consumption'}[name]
        page.get_by_test_id(f'inventory-{view}-run').click()
        expect(page.get_by_test_id('inventory-report-' + view).locator('h3').first).to_be_visible()
        settle(page)
        return page.get_by_test_id('inventory-report-' + view)

    for role, credential in ROLES.items():
        can = CAN[role]
        for width, height in ((1440, 900), (390, 844)):
            page = session(credential, width, height)
            # «Главная» with the «Сегодня» block of the cash desks.
            nav(page, 'dash')
            expect(page.get_by_test_id('pos-home')).to_be_visible()
            # Every period chip inside the window, also on a phone (they wrap).
            for chip in page.locator('.op-periods button').all():
                box = chip.bounding_box()
                if box['x'] + box['width'] > width + 1:
                    failures.append(f'{role} dash {width}: period {chip.inner_text()} outside')
            check(page, role, 'dash', width)
            # «Касса»: three tabs.
            nav(page, 'pos')
            expect(page.get_by_test_id('pos-day')).to_be_visible()
            expect(page.get_by_test_id('pos-day-totals')).to_be_visible()
            check(page, role, 'pos-shifts', width)
            page.get_by_test_id('pos-day-tab-receipts').click()
            expect(page.get_by_test_id('pos-receipts')).to_be_visible()
            check(page, role, 'pos-receipts', width)
            page.get_by_test_id('pos-day-tab-webkassa').click()
            expect(page.get_by_test_id('pos-webkassa-pending')).to_be_visible()
            check(page, role, 'pos-webkassa', width)
            # «Заказы» with the cash desk column.
            nav(page, 'orders')
            check(page, role, 'orders', width)
            # «Остатки»: every tab; the reports are run for today.
            nav(page, 'stock')
            expect(page.get_by_test_id('stock-sales-notice')).to_contain_text(
                'Продажи списываются со склада автоматически')
            key = page.get_by_test_id('op-key-count')
            if can['count']:
                expect(key).to_have_text('Подсчёт на закрытии (3)')
            else:
                expect(key).to_have_count(0)
            for name in STOCK_TABS:
                stock_tab(page, name)
                if name in REPORT_TABS:
                    report = run_report(page, name)
                    if name == 'Расхождения подсчёта':
                        expect(report).to_contain_text('Синтетическая булка')
                        expect(report).to_contain_text('-4 шт')
                    if name == 'Расход по продажам':
                        expect(report.locator('table').first).to_contain_text('Касса')
                if name == 'Документы':
                    reverse = page.get_by_role('button', name='Сторно')
                    page.locator('summary', has_text='Движения и сторно').first.click()
                    # The movements table of a document keeps its own labels on a phone.
                    inner = page.locator('details[open] table td').first
                    expect(inner).to_have_attribute('data-label', 'Ингредиент')
                    expect(page.locator('td:has(> details[open])').first).to_have_attribute(
                        'data-label', '')
                    if can['reverse']:
                        expect(reverse.first).to_be_visible()
                    else:
                        expect(reverse).to_have_count(0)
                if name == 'Списание по продажам':
                    edit = page.get_by_test_id('autoconsume-mode-edit')
                    expect(edit).to_have_count(1 if can['mode'] else 0)
                check(page, role, 'stock-' + STOCK_TABS.index(name).__str__(), width)
            # The closing count dialog shows the key positions (closed with Esc, nothing sent).
            if can['count']:
                key.click()
                d = page.locator('dialog.op-dialog[open]')
                expect(d.locator('h2')).to_have_text('Подсчёт на закрытии')
                expect(d.locator('.inventory-line')).to_have_count(3)
                check(page, role, 'stock-key-count', width)
                d.get_by_role('button', name='Закрыть').first.click()
                page.wait_for_timeout(200)
                if page.locator('dialog.op-dialog[open]').count():
                    page.keyboard.press('Escape')
                page.wait_for_timeout(200)
            # «Смены»: the manager shift card and «Сотрудники».
            nav(page, 'shifts')
            expect(page.get_by_test_id('ms-open-card')).to_be_visible()
            expect(page.get_by_test_id('ms-close')).to_have_count(1)
            if can['shift']:
                expect(page.get_by_test_id('ms-close')).to_be_enabled()
            else:
                expect(page.get_by_test_id('ms-close')).to_be_disabled()
            expect(page.get_by_test_id('ms-open-card')).to_contain_text('Не посчитаны ключевые позиции')
            check(page, role, 'shifts', width)
            # «Сотрудники» for the roles that read the time sheet (workforce.read); the others
            # are told who sees it.
            if can['team']:
                page.locator('.wf-tabs').get_by_role('button', name='Сотрудники', exact=True).click()
                settle(page)
                expect(page.locator('.workforce')).to_contain_text(
                    'Синтетическая кассир с должностью')
                check(page, role, 'team', width)
            else:
                expect(page.locator('.wf-tabs')).to_have_count(0)
                expect(page.locator('body')).to_contain_text(
                    'Табель, ставки и начисления видят управляющий и бухгалтер')
            # «Скидки».
            nav(page, 'discounts')
            expect(page.get_by_test_id('dc-banner')).to_be_visible()
            expect(page.get_by_test_id('dc-new')).to_have_count(1 if can['discounts'] else 0)
            check(page, role, 'discounts', width)
            # «Журнал аудита».
            nav(page, 'audit')
            check(page, role, 'audit', width)
            page.close()

    browser.close()
    if errors:
        failures.append('page errors: ' + '; '.join(errors[:5]))
    print(f'P1 pass: {nonlocal_shots[0]} screens checked', flush=True)
    for f in failures:
        print('FAIL ' + f, flush=True)
    sys.exit(1 if failures else 0)
