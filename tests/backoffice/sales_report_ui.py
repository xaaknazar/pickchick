"""Cutover CC-7: the sales report page of the real back office (Chromium).

Real local back-office API with PostgreSQL behind the operator proxy. With
BACKOFFICE_SALES_REPORT_ENABLED off the reports page is exactly as before (no sales block); with it
on the manager reads one synthetic day of every channel, the eight cashier methods, voids and refunds
with the approver and «Без выручки», downloads the CSV, and the page fits a 393 px phone.
Synthetic data only.
"""
import csv
import io
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

config = json.loads(Path(sys.argv[1]).read_text())
output = Path(config['output'])
DAY = config['day']
LONG_DASHES = ('—', '–')

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    errors = []

    def session(width):
        page = browser.new_page(viewport={'width': width, 'height': 900}, device_scale_factor=1,
                                accept_downloads=True)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(config['url'])
        page.get_by_test_id('credential-file').set_input_files({
            'name': 'person.json', 'mimeType': 'application/json',
            'buffer': json.dumps(config['manager']).encode()})
        expect(page.locator('.user')).to_be_visible()
        return page

    def capture(page, name):
        page.evaluate("""async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}""")
        page.screenshot(path=str(output / name), full_page=False)

    def open_reports(page):
        nav = page.get_by_test_id('nav-reports')
        if not nav.is_visible():
            page.get_by_test_id('navigation-toggle').click()
        nav.click()
        # 15 s: in a full suite on a shared machine the reports page once took longer than the
        # default 5 s (bo-ui2 step 6); the check itself is unchanged.
        expect(page.locator('h1, h2', has_text='Финансовые показатели').first).to_be_visible(
            timeout=15000)

    if config['mode'] == 'off':
        page = session(1440)
        open_reports(page)
        expect(page.get_by_test_id('sales-report')).to_have_count(0)
        capture(page, 'reports-flag-off-1440.png')
        page.close()
    else:
        page = session(1440)
        open_reports(page)
        report = page.get_by_test_id('sales-report')
        expect(report).to_be_visible()
        expect(report).to_contain_text('Выберите период и нажмите «Показать».')
        expect(page.get_by_test_id('sales-report-csv')).to_be_disabled()
        page.locator('#sales-report-start').fill(DAY)
        page.locator('#sales-report-end').fill(DAY)
        with page.expect_response(lambda r: '/ops/sales?' in r.url) as answer:
            page.get_by_test_id('sales-report-run').click()
        assert answer.value.status == 200, answer.value.status
        expect(page.get_by_test_id('sales-report-coverage')).to_contain_text('Касса: данные продаж получены')
        expect(report.locator('.stat').first).to_contain_text('16 900 ₸')
        channels = page.get_by_test_id('sales-report-channels')
        for name in ['Зал', 'С собой', 'Яндекс Еда', 'Glovo', 'Приложение', 'Киоск']:
            expect(channels).to_contain_text(name)
        methods = page.get_by_test_id('sales-report-methods')
        for name in ['Наличные', 'Kaspi терминал', 'Kaspi вручную', 'Яндекс Еда - оплачено агрегатором',
                     'Glovo - оплачено агрегатором', 'ChocoFood', 'Питание сотрудников (без выручки)',
                     'Маркетинг (без выручки)', 'Онлайн - приложение и киоск']:
            expect(methods).to_contain_text(name)
        expect(methods.locator('tbody tr')).to_have_count(9)
        refunds = page.get_by_test_id('sales-report-refunds')
        expect(refunds).to_contain_text('Синтетический управляющий')
        expect(refunds).to_contain_text('PIN начальника смены')
        expect(refunds).to_contain_text('Агрегатор отменил: Курьер отменил заказ')
        expect(refunds).to_contain_text('Отмена до кухни')
        expect(page.get_by_test_id('sales-report-no-revenue-items')).to_contain_text('Синтетический сотрудник')
        expect(page.get_by_test_id('sales-report-shifts')).to_contain_text('Открыта или Z-отчёт ещё не получен')
        expect(page.get_by_test_id('sales-report-top')).to_contain_text('Синтетический бургер')
        text = report.inner_text()
        assert not any(d in text for d in LONG_DASHES), 'long dash in the sales report'
        capture(page, 'sales-report-1440.png')
        with page.expect_download() as download:
            page.get_by_test_id('sales-report-csv').click()
        assert download.value.suggested_filename == f'pickchick-sales-{DAY}-{DAY}.csv'
        raw = Path(download.value.path()).read_bytes()
        assert raw.startswith(b'\xef\xbb\xbf'), 'CSV must start with a UTF-8 BOM'
        rows = list(csv.reader(io.StringIO(raw.decode('utf-8-sig')), delimiter=';'))
        flat = {tuple(r) for r in rows}
        assert ('Выручка, ₸', '16900,00') in flat, rows[:20]
        assert ('Наличные', 'да', '3', '4500,00', '0,00', '700,00', '3800,00') in flat
        assert ('Питание сотрудников', 'нет', '1', '900,00', '0,00', '0,00', '900,00') in flat
        assert any(r and r[0] == 'Зал' and r[-2] == '4000,00' for r in rows)
        page.close()

        # ---- Phone width: the same report, nothing wider than the screen ----
        page = session(393)
        open_reports(page)
        page.locator('#sales-report-start').fill(DAY)
        page.locator('#sales-report-end').fill(DAY)
        page.get_by_test_id('sales-report-run').click()
        expect(page.get_by_test_id('sales-report-methods')).to_contain_text('Kaspi вручную')
        width = page.evaluate('document.documentElement.scrollWidth')
        assert width <= 393, width
        page.get_by_test_id('sales-report-methods').scroll_into_view_if_needed()
        capture(page, 'sales-report-393.png')
        # A window longer than 92 days is explained, not sent as an empty report.
        page.locator('#sales-report-start').fill('2026-01-01')
        page.get_by_test_id('sales-report-run').click()
        expect(page.get_by_test_id('sales-report-result')).to_contain_text('не больше 92 дней')
        page.close()

    browser.close()
    assert not errors, errors
print('sales report browser flow passed (' + config['mode'] + ')')
