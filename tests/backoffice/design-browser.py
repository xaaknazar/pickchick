"""Layout/asset regression on a real isolated HTTP/PostgreSQL fixture, no production data."""
import json
import sys
from playwright.sync_api import sync_playwright, expect

fixture = json.load(open(sys.argv[1]))
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on('dialog', lambda dialog: dialog.accept())
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(fixture['url'] + '#finance')
    expect(page.locator('.login-intro img')).to_be_visible()
    assert page.locator('.login-intro img').evaluate('(img) => img.complete && img.naturalWidth > 0')
    page.get_by_test_id('credential-file').set_input_files({"name": "access.json", "mimeType": "application/json", "buffer": json.dumps(fixture['manager']).encode()})
    expect(page.get_by_role('heading', name='Финансы за период')).to_be_visible()
    assert page.locator('.brand img').evaluate('(img) => img.complete && img.naturalWidth > 0')
    for width in [1440, 768, 393]:
        page.set_viewport_size({"width": width, "height": 1000})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        if width < 801:
            page.get_by_test_id('navigation-toggle').click()
            expect(page.get_by_test_id('nav-finance')).to_be_visible()
            page.get_by_test_id('navigation-toggle').click()
            expect(page.get_by_test_id('nav-finance')).not_to_be_visible()
        fields = page.locator('.finance-period-filter input, .finance-period-filter select, .finance-period-filter > button')
        heights = fields.evaluate_all('(xs) => xs.map(x => x.getBoundingClientRect().height)')
        assert max(heights)-min(heights) <= 1, heights
        if width == 1440:
            bottoms = fields.evaluate_all('(xs) => xs.map(x => x.getBoundingClientRect().bottom)')
            assert max(bottoms)-min(bottoms) <= 1, bottoms
        page.get_by_role('button', name='Журнал операций', exact=True).click()
        expect(page.get_by_text('За выбранный период записей нет.', exact=True)).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        page.get_by_role('button', name='Добавить операцию', exact=True).click()
        expect(page.get_by_test_id('finance-amount')).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        page.get_by_role('button', name='Отменить ввод', exact=True).click()
        page.get_by_role('button', name='Сводка', exact=True).click()
    page.set_viewport_size({"width": 1440, "height": 1000})
    for name in ['dash', 'orders', 'items', 'stoplist', 'shifts', 'reports', 'finance']:
        page.get_by_test_id('nav-' + name).click()
        expect(page.get_by_test_id('nav-' + name)).to_have_attribute('aria-current', 'page')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), name
    assert not errors, errors
    browser.close()
print('PASS: logo, aligned controls, 3 widths, empty journal, entry form and 7 primary sections')
