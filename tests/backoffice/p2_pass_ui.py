"""Lane bo-ui2 step 6: one pass over every screen of the second wave, every role, two widths.

See p2-pass-browser.test.mjs. Every flag is on; the fixture holds 20 days of stock history,
suppliers with prices and two price imports, requests in every state, staff cards with
positions, today's intervals (one moved, one outside the position) and an open manager shift. The
manager, the shift manager, the accountant and the analyst open each screen at 1440x900 and
390x844 (scale 1, Asia/Almaty). On every screen: no page error, no horizontal page scroll, no long
dash, no «undefined», «NaN», «[object Object]» or raw ISO time in the text, every visible button
and every open dialog inside the window; the role sees exactly its buttons enabled and the
reason of a disabled one in words. The pass only reads: every dialog it opens is closed without
saving. Synthetic data only.
"""
import json
import re
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

config = json.loads(Path(sys.argv[1]).read_text())
output = Path(config['output'])
LONG_DASHES = ('—', '–')
BAD_TEXT = re.compile(r'undefined|NaN|\[object Object\]|\bnull\b|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}')
ROLES = {
    'manager': config['manager'],
    'shift': config['shift'],
    'accountant': config['accountant'],
    'analyst': config['analyst'],
}
# What each role may do on the second-wave screens (design-bo-ui 9.3).
CAN = {
    'manager': {'request': True, 'close': True, 'suppliers': True, 'assign': True,
                'override': True, 'sheet': True, 'shift': True},
    'shift': {'request': True, 'close': False, 'suppliers': False, 'assign': True,
              'override': False, 'sheet': False, 'shift': True},
    'accountant': {'request': False, 'close': False, 'suppliers': True, 'assign': False,
                   'override': False, 'sheet': True, 'shift': False},
    'analyst': {'request': False, 'close': False, 'suppliers': False, 'assign': False,
                'override': False, 'sheet': True, 'shift': False},
}
WRITE_RIGHTS = 'Заявки создают и подают управляющий и начальник смены.'
CLOSE_RIGHTS = 'Принять поставку по заявке и отменить заявку может только управляющий.'
SUPPLIER_RIGHTS = 'Поставщиков и их цены ведут управляющий и бухгалтер.'
ASSIGN_RIGHTS = 'Расстановку ведут управляющий и начальник смены.'
MONEY = re.compile(r'\d ₸')

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--lang=ru-RU'])
    errors = []
    failures = []
    shots = [0]

    def session(credential, width, height, hash_):
        page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1,
                                timezone_id='Asia/Almaty', locale='ru-RU')
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda d: d.accept())
        page.goto(config['url'] + hash_)
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

    def dialog(page, testid=None):
        d = page.locator('dialog.op-dialog[open]')
        return d if testid is None else page.locator(f'dialog.op-dialog[open][data-testid="{testid}"]')

    def close_dialogs(page):
        """Close every open dialog without saving («Закрыть», then Esc)."""
        for _ in range(4):
            d = dialog(page)
            if not d.count():
                return
            top = d.last
            close = top.get_by_role('button', name='Закрыть', exact=True)
            if close.count():
                close.first.click()
            else:
                page.keyboard.press('Escape')
            page.wait_for_timeout(150)
        if dialog(page).count():
            failures.append('a dialog does not close')

    def check(page, role, screen, width):
        """The generic rules of the pass; a failure is collected, the pass goes on."""
        shots[0] += 1
        settle(page)
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
        # a button inside a sideways scrolling box is reached by scrolling.
        cut = page.evaluate("""(w) => [...document.querySelectorAll('button, a.button, select, input')]
            .filter(b => {
              if (b.offsetParent === null || b.closest('dialog:not([open])')) return false;
              if (b.type === 'hidden' || b.type === 'file') return false;
              for (let a = b.parentElement; a && a !== document.body; a = a.parentElement)
                if (['auto', 'scroll'].includes(getComputedStyle(a).overflowX) && a.scrollWidth > a.clientWidth)
                  return false;
              return true;
            })
            .map(b => [(b.innerText || b.getAttribute('aria-label') || b.id || b.tagName).trim(), b.getBoundingClientRect()])
            .filter(([t, r]) => r.width > 0 && (r.right > w + 1 || r.left < -1))
            .map(([t, r]) => t + ' ' + Math.round(r.left) + '..' + Math.round(r.right))""", width)
        if cut:
            failures.append(f'{where}: controls outside the window {cut[:5]}')
        # Amounts are never cut off: every «… ₸» text node is inside the window.
        money = page.evaluate("""(w) => {
            const out = [];
            const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let n = walk.nextNode(); n; n = walk.nextNode()) {
              if (!/\\d ₸/.test(n.nodeValue)) continue;
              const e = n.parentElement;
              if (!e || e.offsetParent === null || e.closest('dialog:not([open])')) continue;
              let scrolled = false;
              for (let a = e; a && a !== document.body; a = a.parentElement)
                if (['auto', 'scroll'].includes(getComputedStyle(a).overflowX) && a.scrollWidth > a.clientWidth)
                  scrolled = true;
              if (scrolled) continue;
              const range = document.createRange();
              range.selectNodeContents(n);
              const r = range.getBoundingClientRect();
              if (r.width > 0 && (r.right > w + 1 || r.left < -1)) out.push(n.nodeValue.trim().slice(0, 40));
            }
            return out;
          }""", width)
        if money:
            failures.append(f'{where}: amounts outside the window {money[:5]}')
        d = dialog(page)
        if d.count():
            box = d.last.bounding_box()
            if box and (box['x'] < -1 or box['x'] + box['width'] > width + 1):
                failures.append(f'{where}: dialog outside the window {box}')
        page.screenshot(path=str(output / f'{role}-{screen}-{width}.png'), full_page=width == 390 and not d.count())

    def enabled(locator, expected, where):
        locator = locator.first
        expect(locator).to_be_visible()
        if locator.is_enabled() != expected:
            failures.append(f'{where}: enabled={not expected}, expected {expected}')

    def tab(page, name):
        page.locator('.inventory-tabs').get_by_role('button', name=name, exact=True).click()
        settle(page)

    def request_row(page, number):
        return page.get_by_test_id('sp-requests').locator('tbody tr', has_text=f'№ {number}')

    for role, credential in ROLES.items():
        can = CAN[role]
        for width, height in ((1440, 900), (390, 844)):
            w = f'{role} {width}'
            page = session(credential, width, height, '#supply')
            # «Закупки» → «Заявки»: the list of the period.
            expect(page.get_by_test_id('supply')).to_be_visible()
            settle(page)
            for n in (1, 2, 3, 4):
                expect(request_row(page, n)).to_have_count(1)
            enabled(page.get_by_test_id('sp-new'), can['request'], w + ' «Новая заявка»')
            if not can['request']:
                expect(page.get_by_test_id('sp-rights')).to_have_text(WRITE_RIGHTS)
            # A state badge is as wide as its word, also in a phone card.
            badge = page.get_by_test_id('sp-state').first.bounding_box()
            if not badge or badge['width'] > 160:
                failures.append(f'{w} requests: state badge width {badge}')
            check(page, role, 'requests', width)
            # The received request: the receipt and the difference.
            request_row(page, 3).get_by_test_id('sp-open').click()
            d = dialog(page, 'sp-request')
            expect(d.get_by_test_id('sp-request-state')).to_have_text('Получена')
            expect(d.get_by_test_id('sp-receipt')).to_contain_text('НАК-ПРОХОД-1')
            expect(d.get_by_test_id('sp-difference')).to_contain_text('-0,2 кг')
            check(page, role, 'request-received', width)
            close_dialogs(page)
            # The submitted request: who may receive it.
            request_row(page, 1).get_by_test_id('sp-open').click()
            d = dialog(page, 'sp-request')
            expect(d.get_by_test_id('sp-request-state')).to_have_text('Подана')
            enabled(d.get_by_test_id('sp-receive'), can['close'], w + ' «Принять поставку»')
            if not can['close']:
                expect(d.get_by_test_id('sp-action-rights').first).to_have_text(CLOSE_RIGHTS)
            check(page, role, 'request-submitted', width)
            if can['close']:
                d.get_by_test_id('sp-receive').click()
                r = dialog(page, 'sp-receive-dialog')
                expect(r.get_by_test_id('sp-receive-line')).to_have_count(3)
                check(page, role, 'receive', width)
            close_dialogs(page)
            # The editor of a new request (closed without saving).
            if can['request']:
                page.get_by_test_id('sp-new').click()
                d = dialog(page, 'sp-editor')
                d.get_by_test_id('sp-kind').select_option('supplier')
                d.get_by_test_id('sp-supplier').select_option(label='Поставщик 1')
                d.get_by_test_id('sp-line-below').click()
                expect(d.get_by_test_id('sp-line').first).to_be_visible()
                check(page, role, 'editor', width)
                close_dialogs(page)
                page.evaluate('() => localStorage.clear()')
            # «Поставщики и цены», the prices of a supplier and the price imports.
            page.get_by_test_id('sp-tab-suppliers').click()
            settle(page)
            expect(page.get_by_test_id('sp-suppliers')).to_contain_text('Поставщик 9')
            enabled(page.get_by_test_id('sp-supplier-new'), can['suppliers'], w + ' «Новый поставщик»')
            if not can['suppliers']:
                expect(page.get_by_test_id('sp-supplier-rights')).to_have_text(SUPPLIER_RIGHTS)
            expect(page.get_by_test_id('sp-import-state')).to_have_text('Загружен полностью')
            check(page, role, 'suppliers', width)
            page.get_by_test_id('sp-suppliers').locator('tbody tr', has_text='Поставщик 1').get_by_test_id('sp-prices').click()
            d = dialog(page, 'sp-prices-dialog')
            expect(d.get_by_test_id('sp-price-table')).to_contain_text('2 500 ₸ за 1 кг')
            if can['suppliers']:
                expect(d.get_by_test_id('sp-price-form')).to_be_visible()
            else:
                expect(d.get_by_test_id('sp-price-rights')).to_have_text(SUPPLIER_RIGHTS)
            check(page, role, 'prices', width)
            close_dialogs(page)
            page.get_by_test_id('sp-imports').scroll_into_view_if_needed()
            check(page, role, 'imports', width)

            # «Остатки»: the server balances, «Движение» by position, «К заказу».
            nav(page, 'stock')
            expect(page.get_by_test_id('stock-balances')).to_be_visible()
            expect(page.get_by_test_id('stock-balances')).to_contain_text('Синтетическое филе')
            check(page, role, 'balances', width)
            tab(page, 'Движение')
            page.locator('#inventory-movement-start').fill(config['start'])
            page.get_by_test_id('inventory-movement-run').click()
            expect(page.get_by_test_id('stock-turnover')).to_be_visible()
            expect(page.get_by_test_id('stock-turnover-mismatch')).to_have_count(0)
            check(page, role, 'movement', width)
            tab(page, 'К заказу')
            expect(page.get_by_test_id('stock-reorder')).to_contain_text('Синтетическое филе')
            enabled(page.get_by_test_id('stock-reorder-request'), can['request'], w + ' «Создать заявку»')
            picks = page.locator('[data-testid^="stock-reorder-pick-"]')
            if can['request']:
                # The checkbox keeps its own size (it was a 44 px square stretched over 34 %).
                box = picks.first.bounding_box()
                if not box or box['width'] > 30 or box['height'] > 30:
                    failures.append(f'{w} reorder: checkbox size {box}')
            else:
                # Only a role that can create a request picks rows for it.
                expect(picks).to_have_count(0)
                expect(page.locator('#stock-reorder-request-why')).to_have_text(WRITE_RIGHTS)
            check(page, role, 'reorder', width)
            if role == 'manager':
                tab(page, 'Ингредиенты')
                page.get_by_test_id('op-edit-' + config['fillet']).click()
                d = dialog(page)
                expect(d.get_by_test_id('op-meat')).to_be_checked()
                expect(d.get_by_test_id('op-supply-kind')).to_have_value('supplier')
                check(page, role, 'ingredient', width)
                close_dialogs(page)

            # «Расстановка»: the grid of the day and «Поставить на станцию».
            nav(page, 'assignment')
            root = page.get_by_test_id('assignment')
            expect(root).to_be_visible()
            expect(page.get_by_test_id('as-station-issue')).to_contain_text('Синтетический сборщик')
            expect(page.get_by_test_id('as-station-cashier')).to_contain_text('Не по должности')
            expect(page.get_by_test_id('as-history-row')).to_have_count(4)
            enabled(page.get_by_test_id('as-assign'), can['assign'], w + ' «Поставить на станцию»')
            if not can['assign']:
                expect(page.get_by_test_id('as-rights')).to_have_text(ASSIGN_RIGHTS)
            check(page, role, 'assignment', width)
            if can['assign']:
                page.get_by_test_id('as-assign').click()
                d = dialog(page, 'as-assign-dialog')
                d.get_by_test_id('as-employee').select_option(label='Синтетический раннер')
                d.get_by_test_id('as-station').select_option('fryer')
                if can['override']:
                    expect(d.get_by_test_id('as-override')).to_be_visible()
                else:
                    expect(d.get_by_test_id('as-save')).to_be_disabled()
                check(page, role, 'assignment-dialog', width)
                close_dialogs(page)

            # «Смены»: the closing checklist with «Расстановка заполнена», «Табель» with stations.
            nav(page, 'shifts')
            expect(page.get_by_test_id('ms-open-card')).to_be_visible()
            enabled(page.get_by_test_id('ms-close'), can['shift'], w + ' «Закрыть смену»')
            if can['shift']:
                page.get_by_test_id('ms-close').click()
                d = dialog(page, 'ms-close-dialog')
                item = d.get_by_test_id('ms-item-staff_assignment')
                expect(item).to_contain_text('Расстановка заполнена')
                expect(item.get_by_test_id('ms-check-staff_assignment')).to_contain_text('Расставлено:')
                item.scroll_into_view_if_needed()
                check(page, role, 'shift-close', width)
                close_dialogs(page)
            if can['sheet']:
                page.locator('.wf-tabs').get_by_role('button', name='Табель', exact=True).click()
                settle(page)
                expect(page.get_by_test_id('wf-stations-note')).to_contain_text('Станции - из «Расстановки»')
                check(page, role, 'time-sheet', width)
            page.close()

    browser.close()
    if errors:
        failures.append('page errors: ' + '; '.join(errors[:5]))
    print(f'P2 pass: {shots[0]} screens checked', flush=True)
    for f in failures:
        print('FAIL ' + f, flush=True)
    sys.exit(1 if failures else 0)
