"""Lane bo-ui2 step 5 «Расстановка» in the real back office (Chromium).

See assignment-browser.test.mjs. Modes: off (the staff assignment off: no «Расстановка» in the
menu, #assignment opens «Главная», no request to ops/staff-assignments, the closing checklist and
«Табель» are bo-ui's) and on (an interval left open yesterday ended first, «Поставить на
станцию», «Переставить», a station outside the position with the manager's reason, «Закончить»,
the history of the day, the shift manager without the override and its reason in words, the
accountant and the analyst read only, the phone at 390 px, «Расстановка заполнена» in the closing
checklist and the stations in «Табель»), rollback (step 6: a shift closed with «Расстановка
заполнена» while the feature was on still shows that answer and its check after the flag is
off). Screenshots at 1440x900 and 390x844, scale 1, Asia/Almaty. Synthetic data only.
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright, expect


def assignment_check_text():
    """What the closing check of the fixture's shift says at the hour of the run.

    The shift takes the Almaty calendar day of its opening, the intervals the business day (a time
    before 06:00 is the night after it). A real shift is opened in the morning, where the two
    agree, and business_date is immutable, so the fixture cannot move it. In a run between 00:00
    and 05:59 Almaty the shift is a day later than its intervals and the check says so.
    """
    night = (datetime.now(timezone.utc) + timedelta(hours=5)).hour < 6
    return 'Расстановка за день не заполнена' if night else 'Расставлено:'


config = json.loads(Path(sys.argv[1]).read_text())
output = Path(config['output'])
MODE = config['mode']
LONG_DASHES = ('—', '–')
RIGHTS = 'Расстановку ведут управляющий и начальник смены.'
OVERRIDE_RIGHTS = 'Поставить сотрудника не по должности может только управляющий.'
REASON = 'Жарщик заболел, кассир помогает'

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--lang=ru-RU'])
    errors = []
    requests = []

    def session(credential, hash_='', width=1440, height=900):
        page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1,
                                timezone_id='Asia/Almaty', locale='ru-RU')
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda r: requests.append(r.url))
        page.on('dialog', lambda d: d.accept())
        page.goto(config['url'] + hash_)
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

    def dialog(page, testid):
        return page.locator(f'dialog.op-dialog[open][data-testid="{testid}"]')

    def no_long_dash(page, where):
        body = page.locator('body').inner_text()
        assert not any(d in body for d in LONG_DASHES), 'long dash on ' + where

    def no_page_scroll(page, width):
        scroll = page.evaluate('document.documentElement.scrollWidth')
        assert scroll <= width, (scroll, width)

    def inside(locator, width):
        b = locator.bounding_box()
        assert b and b['x'] >= 0 and b['x'] + b['width'] <= width + 0.5, b

    def station(page, code):
        return page.get_by_test_id('as-station-' + code)

    def place(page, employee_label, station_code, override=None, time=None):
        """«Поставить на станцию» from the bar: employee, station, the time, the reason."""
        page.get_by_test_id('as-assign').click()
        d = dialog(page, 'as-assign-dialog')
        expect(d).to_be_visible()
        d.get_by_test_id('as-employee').select_option(label=employee_label)
        d.get_by_test_id('as-station').select_option(station_code)
        if time:
            d.get_by_test_id('as-time').fill(time)
        if override is not None:
            d.get_by_test_id('as-override').fill(override)
        d.get_by_test_id('as-save').click()
        expect(d).to_have_count(0)

    def time_sheet(page):
        nav(page, 'shifts')
        expect(page.get_by_test_id('workforce')).to_be_visible()
        page.locator('.wf-tabs').get_by_role('button', name='Табель', exact=True).click()

    def closing_item(page, present):
        nav(page, 'shifts')
        expect(page.get_by_test_id('ms-open-card')).to_be_visible()
        page.get_by_test_id('ms-close').click()
        d = dialog(page, 'ms-close-dialog')
        expect(d).to_be_visible()
        item = d.get_by_test_id('ms-item-staff_assignment')
        if present:
            expect(item).to_contain_text('Расстановка заполнена')
            expect(item.get_by_test_id('ms-check-staff_assignment')).to_contain_text(assignment_check_text())
        else:
            expect(item).to_have_count(0)
        d.get_by_role('button', name='Закрыть', exact=True).click()
        expect(d).to_have_count(0)

    # ------------------------------------------------------------------------------------------
    if MODE == 'rollback':
        # Step 6 (step 5 notDone): the shift was closed with «Расстановка заполнена» while the
        # feature was on; with the flag off now the section is gone, and the closed shift still
        # shows the stored answer with its automatic check, in words.
        page = session(config['manager'], '#assignment')
        expect(page.get_by_test_id('nav-assignment')).to_have_count(0)
        nav(page, 'shifts')
        expect(page.get_by_test_id('ms-closed')).to_be_visible()
        page.get_by_test_id('ms-details').first.click()
        d = dialog(page, 'ms-details-dialog')
        expect(d).to_contain_text('Расстановка заполнена - Готово')
        expect(d).to_contain_text('Комментарий: Все на своих станциях')
        expect(d).to_contain_text('Авто-проверка:')
        no_long_dash(page, 'rollback')
        capture(page, 'rollback-details-1440.png')
        d.get_by_role('button', name='Закрыть', exact=True).first.click()
        expect(d).to_have_count(0)
        assert not any('staff-assignments' in u for u in requests), requests
        page.close()

    # ------------------------------------------------------------------------------------------
    if MODE == 'off':
        page = session(config['manager'], '#assignment')
        expect(page.get_by_test_id('nav-shifts')).to_be_visible()
        expect(page.get_by_test_id('nav-assignment')).to_have_count(0)
        expect(page.get_by_test_id('assignment')).to_have_count(0)
        expect(page.locator('h1')).to_have_text('Главная')
        closing_item(page, False)
        time_sheet(page)
        page.wait_for_timeout(300)
        expect(page.get_by_test_id('wf-stations-note')).to_have_count(0)
        expect(page.locator('.wf-day-cell.wf-placed')).to_have_count(0)
        assert not any('staff-assignments' in u for u in requests), requests
        capture(page, 'off-time-sheet-1440.png')
        page.close()

    # ------------------------------------------------------------------------------------------
    if MODE == 'on':
        page = session(config['manager'], '#assignment')
        root = page.get_by_test_id('assignment')
        expect(root).to_be_visible()
        labels = [t.strip() for t in page.locator('.navigation .nav-item').all_inner_texts()]
        assert labels.index('Расстановка') == labels.index('Смены') + 1, labels
        expect(page.locator('h1')).to_have_text('Расстановка')

        # Yesterday's open interval: said in words, ended at 23:00 of its own day.
        earlier = page.get_by_test_id('as-earlier')
        expect(earlier).to_contain_text('Синтетический кассир')
        capture(page, 'on-earlier-1440.png')
        earlier.get_by_test_id('as-end-earlier').click()
        d = dialog(page, 'as-end-dialog')
        d.get_by_test_id('as-end-time').fill('23:00')
        d.get_by_test_id('as-end-save').click()
        expect(d).to_have_count(0)
        expect(page.get_by_test_id('as-earlier')).to_have_count(0)
        expect(page.get_by_test_id('as-free').locator('li')).to_have_count(3)

        # «Поставить на станцию»: the assembler on the hall table.
        place(page, 'Синтетический сборщик', 'assembly_hall')
        hall = station(page, 'assembly_hall')
        expect(hall).to_contain_text('На станции: 1')
        expect(hall.get_by_test_id('as-person')).to_contain_text('Синтетический сборщик')
        expect(hall.get_by_test_id('as-person')).to_contain_text('с ')
        expect(station(page, 'fryer')).to_contain_text('Никого нет')
        capture(page, 'on-grid-1440.png')

        # «Переставить»: from the hall table to the issue, the old interval ends then.
        hall.get_by_test_id('as-move').click()
        d = dialog(page, 'as-assign-dialog')
        expect(d.locator('h2')).to_have_text('Переставить')
        expect(d.locator('.as-current')).to_contain_text('Сейчас: Сборка - зал (стол 1)')
        d.get_by_test_id('as-station').select_option('issue')
        d.get_by_test_id('as-save').click()
        expect(d).to_have_count(0)
        expect(station(page, 'issue')).to_contain_text('Синтетический сборщик')
        expect(station(page, 'assembly_hall')).to_contain_text('Было: Синтетический сборщик')

        # Outside the position: the reason is required and shown in the history.
        free = page.get_by_test_id('as-free')
        free.locator('li', has_text='Синтетический кассир').get_by_test_id('as-place').click()
        d = dialog(page, 'as-assign-dialog')
        d.get_by_test_id('as-station').select_option('fryer')
        expect(d.get_by_test_id('as-override')).to_be_visible()
        d.get_by_test_id('as-save').click()
        expect(d.locator('.op-form-error')).to_contain_text('Укажите причину')
        d.get_by_test_id('as-override').fill(REASON)
        capture(page, 'on-override-1440.png')
        d.get_by_test_id('as-save').click()
        expect(d).to_have_count(0)
        expect(station(page, 'fryer')).to_contain_text('Не по должности: ' + REASON)

        # «Закончить» the assembler at the issue.
        station(page, 'issue').get_by_test_id('as-end').click()
        d = dialog(page, 'as-end-dialog')
        d.get_by_test_id('as-end-save').click()
        expect(d).to_have_count(0)
        expect(station(page, 'issue')).to_contain_text('Никого нет')
        rows = page.get_by_test_id('as-history-row')
        expect(rows).to_have_count(3)
        expect(rows.filter(has_text='Синтетический кассир')).to_contain_text('Не по должности: ' + REASON)
        no_long_dash(page, 'assignment')
        capture(page, 'on-history-1440.png', True)

        # «Расстановка заполнена» in the closing checklist, the stations in «Табель».
        closing_item(page, True)
        time_sheet(page)
        expect(page.get_by_test_id('wf-stations-note')).to_contain_text('Станции - из «Расстановки»')
        if config['month']:
            placed = page.locator('.wf-day-cell.wf-placed')
            expect(placed.first).to_be_visible()
            assert 'Станции: ' in (placed.first.get_attribute('aria-label') or '')
        capture(page, 'on-time-sheet-1440.png')
        page.close()

        # The shift manager places people but not outside their position.
        page = session(config['shift'], '#assignment')
        expect(page.get_by_test_id('assignment')).to_be_visible()
        expect(page.get_by_test_id('as-rights')).to_have_count(0)
        place(page, 'Синтетический жарщик', 'fryer')
        expect(station(page, 'fryer')).to_contain_text('Синтетический жарщик')
        page.get_by_test_id('as-free').locator('li', has_text='Синтетический сборщик').get_by_test_id('as-place').click()
        d = dialog(page, 'as-assign-dialog')
        d.get_by_test_id('as-station').select_option('cashier')
        expect(d).to_contain_text(OVERRIDE_RIGHTS)
        expect(d.get_by_test_id('as-override')).to_have_count(0)
        expect(d.get_by_test_id('as-save')).to_be_disabled()
        capture(page, 'on-shift-manager-1440.png')
        d.get_by_role('button', name='Закрыть', exact=True).click()
        expect(d).to_have_count(0)
        page.close()

        # The accountant and the analyst read: every button disabled, the reason in words.
        for who in ('accountant', 'analyst'):
            page = session(config[who], '#assignment')
            expect(page.get_by_test_id('assignment')).to_be_visible()
            expect(page.get_by_test_id('as-rights')).to_have_text(RIGHTS)
            expect(page.get_by_test_id('as-assign')).to_be_disabled()
            assert page.get_by_test_id('as-assign').get_attribute('title') == RIGHTS
            for b in page.locator('[data-testid="as-move"], [data-testid="as-end"], [data-testid="as-place"]').all():
                expect(b).to_be_disabled()
            expect(page.get_by_test_id('as-history-row')).to_have_count(4)
            capture(page, f'on-{who}-1440.png')
            page.close()

        # The phone: the grid, the people and their buttons stay on screen.
        page = session(config['manager'], '#assignment', 390, 844)
        expect(page.get_by_test_id('assignment')).to_be_visible()
        no_page_scroll(page, 390)
        inside(page.get_by_test_id('as-assign'), 390)
        for card in page.locator('.as-station').all():
            inside(card, 390)
        for b in page.locator('[data-testid="as-move"], [data-testid="as-end"]').all():
            b.scroll_into_view_if_needed()
            inside(b, 390)
        capture(page, 'on-phone-390.png', True)
        page.get_by_test_id('as-assign').click()
        d = dialog(page, 'as-assign-dialog')
        inside(d.get_by_test_id('as-save'), 390)
        capture(page, 'on-phone-dialog-390.png')
        d.get_by_role('button', name='Закрыть', exact=True).click()
        no_page_scroll(page, 390)
        page.close()

    assert not errors, errors
    browser.close()
