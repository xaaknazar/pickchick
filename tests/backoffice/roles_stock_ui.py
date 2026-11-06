"""Cutover CC-5/CC-6: waste reasons, receipt details and role-aware menus in the real back office.

Real local back-office API with PostgreSQL behind the operator proxy, BACKOFFICE_ROLES_ENABLED and
BACKOFFICE_STOCK_V2_ENABLED on. The manager posts a waste (the reason is required) and a receipt
(where it came from, invoice date), then reads the stock report; a designated shift manager sees
the same stock buttons but no finance section. Desktop 1440 and phone 393. Synthetic data only.
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

config = json.loads(Path(sys.argv[1]).read_text())
output = Path(config['output'])

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    errors = []

    def session(credential, width):
        page = browser.new_page(viewport={'width': width, 'height': 900}, device_scale_factor=1)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(config['url'])
        page.get_by_test_id('credential-file').set_input_files({
            'name': 'person.json', 'mimeType': 'application/json',
            'buffer': json.dumps(credential).encode()})
        return page

    def capture(page, name):
        page.evaluate("""async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}""")
        page.screenshot(path=str(output / name), full_page=False)

    def open_stock(page):
        nav = page.get_by_test_id('nav-stock')
        if not nav.is_visible():
            page.get_by_test_id('navigation-toggle').click()
        nav.click()
        expect(page.get_by_test_id('op-waste')).to_be_visible()

    def document_line(page, quantity, cost=None):
        dialog = page.locator('dialog.op-dialog')
        dialog.get_by_test_id('op-stock-ingredient-0').select_option(config['ingredient'])
        dialog.locator('#op-stock-quantity-0').fill(quantity)
        if cost is not None:
            dialog.locator('#op-stock-cost-0').fill(cost)
        dialog.get_by_test_id('inventory-reviewed').check()
        dialog.locator('#op-reason').fill('Синтетическая проверка склада')
        return dialog

    # ---- Manager, desktop: waste needs a reason ----
    page = session(config['manager'], 1440)
    expect(page.locator('.user')).to_contain_text('Вы: управляющий')
    expect(page.get_by_test_id('nav-finance')).to_be_visible()
    open_stock(page)
    page.get_by_test_id('op-waste').click()
    dialog = page.locator('dialog.op-dialog')
    expect(dialog.get_by_test_id('op-waste-reason')).to_be_visible()
    dialog.locator('#op-reference').fill('СП-1')
    document_line(page, '2')
    dialog.get_by_test_id('op-save').click()
    expect(dialog.locator('.op-form-error')).to_have_text('Укажите причину списания.')
    dialog.get_by_test_id('op-waste-reason').select_option('hot_cabinet_expired')
    capture(page, 'waste-reason-1440.png')
    dialog.get_by_test_id('op-save').click()
    expect(page.locator('dialog.op-dialog')).to_have_count(0)

    # ---- Receipt with supplier and invoice date ----
    page.get_by_test_id('op-receipt').click()
    dialog = page.locator('dialog.op-dialog')
    expect(dialog.locator('.field-label', has_text='Номер накладной')).to_be_visible()
    dialog.locator('#op-reference').fill('НАК-5')
    document_line(page, '10', '1000')
    dialog.get_by_test_id('op-save').click()
    expect(dialog.locator('.op-form-error')).to_have_text('Укажите, откуда пришла поставка.')
    dialog.get_by_test_id('op-supplier-kind').select_option('bakery')
    dialog.locator('#op-supplier-name').fill('Синтетическая пекарня')
    dialog.locator('#op-document-date').fill('2026-11-18')
    capture(page, 'receipt-details-1440.png')
    dialog.get_by_test_id('op-save').click()
    expect(page.locator('dialog.op-dialog')).to_have_count(0)

    # ---- Report tab ----
    if config.get('p1'):
        # cloud075 with its rights: stock P1 rides stock v2 (lane bo-ui), two report tabs.
        expect(page.get_by_role('button', name='Списания и поставки')).to_have_count(0)
        page.get_by_role('button', name='Списания', exact=True).click()
        with page.expect_response(lambda r: '/ops/stock?' in r.url) as answer:
            page.get_by_test_id('inventory-waste-run').click()
        assert answer.value.status == 200, answer.value.status
        report = page.get_by_test_id('inventory-report-waste')
        expect(report).to_contain_text('Тепловой шкаф: старше 50 минут')
        expect(report).to_contain_text('Синтетический управляющий')
        page.get_by_role('button', name='Движение', exact=True).click()
        page.get_by_test_id('inventory-movement-run').click()
        report = page.get_by_test_id('inventory-report-movement')
        expect(report).to_contain_text('Пекарня, Синтетическая пекарня, накладная от 18.11.2026')
    else:
        # The cloud lane's stock page (stock v2 without cloud075).
        page.get_by_role('button', name='Списания и поставки').click()
        with page.expect_response(lambda r: '/ops/stock?' in r.url) as answer:
            page.get_by_test_id('inventory-report-run').click()
        assert answer.value.status == 200, answer.value.status
        report = page.get_by_test_id('inventory-report')
        expect(report).to_contain_text('Тепловой шкаф: старше 50 минут')
        expect(report).to_contain_text('Синтетический управляющий')
        page.get_by_test_id('inventory-report-view').select_option('movement')
        page.get_by_test_id('inventory-report-run').click()
        expect(report).to_contain_text('Пекарня, Синтетическая пекарня, накладная от 18.11.2026')
        expect(page.get_by_text('Последний подсчёт')).to_have_count(0)
    capture(page, 'stock-report-%s-1440.png' % ('p1' if config.get('p1') else 'v2'))
    page.close()

    # ---- Designated shift manager, phone width ----
    page = session(config['shift'], 393)
    expect(page.locator('.user')).to_contain_text('Вы: начальник смены')
    expect(page.get_by_test_id('nav-finance')).to_have_count(0)
    open_stock(page)
    expect(page.get_by_test_id('op-receipt')).to_be_visible()
    expect(page.get_by_test_id('op-count')).to_be_visible()
    page.get_by_test_id('op-waste').click()
    dialog = page.locator('dialog.op-dialog')
    dialog.locator('#op-reference').fill('СП-2')
    dialog.get_by_test_id('op-waste-reason').select_option('defect')
    document_line(page, '1')
    capture(page, 'waste-reason-393.png')
    dialog.get_by_test_id('op-save').click()
    expect(page.locator('dialog.op-dialog')).to_have_count(0)
    # Recipes and ingredients stay with the manager: no "Добавить" there.
    page.get_by_role('button', name='Техкарты').click()
    expect(page.get_by_test_id('op-add-recipe')).to_have_count(0)
    width = page.evaluate('document.documentElement.scrollWidth')
    assert width <= 393, width
    page.close()

    browser.close()
    assert not errors, errors
print('roles and stock v2 browser flow passed')
