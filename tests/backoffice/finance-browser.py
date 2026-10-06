"""Synthetic accounting acceptance against real HTTP/PostgreSQL, never the restaurant."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

c = json.loads(Path(sys.argv[1]).read_text())
out = Path(c['output'])
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1440, 'height': 960})
    page.set_default_timeout(15000)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.goto(c['url'] + '#finance')
    page.get_by_test_id('credential-file').set_input_files({
        'name': 'synthetic.json', 'mimeType': 'application/json',
        'buffer': json.dumps(c['manager']).encode(),
    })
    def b(label):
        return page.get_by_role('button', name=label, exact=True)
    def tab(label):
        b(label).click()
    def period(start, end):
        page.get_by_test_id('finance-start').fill(start)
        page.get_by_test_id('finance-end').fill(end)
        b('Показать').click()
        expect(b('Показать')).to_be_enabled()
    expect(b('Счета и периоды')).to_be_enabled()
    period('2026-10-01', '2026-10-31')
    tab('Счета и периоды')
    page.get_by_text('Добавить денежный счёт', exact=True).click()
    page.get_by_label('Название счёта', exact=True).fill('Тестовая касса')
    page.get_by_label('Начало учёта', exact=True).fill('2026-09-01')
    page.get_by_label('Начальный остаток, ₸', exact=False).fill('10000')
    b('Добавить счёт').click()
    expect(page.locator('.content')).to_contain_text('10\u00a0000,00 ₸')
    tab('Журнал операций')
    b('Добавить операцию').click()
    page.get_by_test_id('finance-amount').fill('500,25')
    page.get_by_test_id('finance-cash-date').fill('2026-10-06')
    page.get_by_test_id('finance-recognition-date').fill('2026-09-30')
    page.get_by_test_id('finance-category').select_option('utilities')
    page.get_by_test_id('finance-entry-center').select_option('workshop')
    page.get_by_test_id('finance-counterparty').fill('Синтетический поставщик')
    page.get_by_test_id('finance-reference').fill('Синтетические коммунальные услуги')
    page.get_by_test_id('finance-note').fill('<img src=x onerror=alert(1)>')
    # Commit once, lose the reply, reload, then recover the identical request.
    requests = []
    def lose_reply(route):
        requests.append(route.request.post_data_json)
        response = route.fetch()
        assert response.status == 200
        route.abort('failed')
    route = '**/v1/admin/backoffice/branches/*/finance/commands'
    page.route(route, lose_reply)
    b('Провести операцию').click()
    expect(b('Проверить результат')).to_be_enabled()
    page.unroute(route, lose_reply)
    page.reload()
    expect(b('Проверить результат')).to_be_enabled()
    recovered = []
    page.on('request', lambda r: recovered.append(r.post_data_json) if r.method == 'POST' else None)
    b('Проверить результат').click()
    expect(b('Проверить результат')).to_have_count(0)
    assert recovered[0] == requests[0]
    expect(b('Синтетические коммунальные услуги')).to_have_count(1)
    tab('ДДС')
    expect(page.locator('.finance-totals')).to_contain_text('500,25 ₸')
    tab('ОПиУ')
    expect(page.locator('.finance-totals')).not_to_contain_text('500,25')
    period('2026-09-01', '2026-09-30')
    expect(page.locator('.finance-totals')).to_contain_text('-500,25 ₸')
    page.get_by_text('Коммунальные услуги', exact=True).click()
    b('Показать операции').click()
    expect(page.get_by_test_id('finance-filter-basis')).to_have_value('pnl')
    expect(b('Синтетические коммунальные услуги')).to_be_visible()
    b('Синтетические коммунальные услуги').click()
    assert page.locator('img[src=x]').count() == 0
    expect(page.locator('.finance-editor')).to_contain_text('2026-09-30')
    b('К журналу').click()
    tab('ОПиУ')
    with page.expect_download() as download:
        b('Скачать отчёт CSV').click()
    saved = download.value.path()
    assert 'Коммунальные услуги' in Path(saved).read_text(encoding='utf-8-sig')
    for width, height in [(1440, 960), (768, 1024), (393, 852)]:
        page.set_viewport_size({'width': width, 'height': height})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        page.screenshot(path=str(out / f'finance-pnl-{width}.png'), full_page=True)
    tab('Журнал операций')
    page.get_by_test_id('finance-search').fill('несуществующий контрагент')
    b('Найти').click()
    expect(page.locator('.content')).to_contain_text('За выбранный период записей нет.')
    page.get_by_test_id('finance-search').fill('поставщик')
    b('Найти').click()
    expect(b('Синтетические коммунальные услуги')).to_be_visible()
    tab('Счета и периоды')
    page.get_by_test_id('finance-period-month').fill('2026-09')
    page.get_by_label('Причина закрытия / открытия', exact=True).fill('Синтетическая проверка месяца')
    b('Закрыть месяц').click()
    expect(page.locator('.content')).to_contain_text('Статус 2026-09: закрыт')
    tab('Журнал операций')
    b('Синтетические коммунальные услуги').click()
    page.get_by_text('Исправить ошибочную запись', exact=True).click()
    page.get_by_label('Причина отмены', exact=True).fill('Синтетическая ошибочная запись')
    b('Отменить запись').click()
    expect(page.locator('[role=alert]')).to_contain_text('месяц закрыт')
    expect(page.get_by_label('Причина отмены', exact=True)).to_have_value('Синтетическая ошибочная запись')
    b('К журналу').click()
    tab('Счета и периоды')
    page.get_by_label('Причина закрытия / открытия', exact=True).fill('Синтетическое исправление')
    b('Открыть для исправлений').click()
    expect(page.locator('.content')).to_contain_text('Статус 2026-09: открыт')
    tab('Журнал операций')
    b('Синтетические коммунальные услуги').click()
    page.get_by_text('Исправить ошибочную запись', exact=True).click()
    page.get_by_label('Причина отмены', exact=True).fill('Синтетическое исправление')
    b('Отменить запись').click()
    expect(page.locator('.content')).to_contain_text('Отменена')
    tab('ОПиУ')
    expect(page.locator('.finance-totals')).not_to_contain_text('500,25')
    assert errors == [], errors
    browser.close()
print('PASS: real finance save/replay, recognition periods, search, CSV, closed month, void, 3 widths')
