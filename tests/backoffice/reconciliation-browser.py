"""Synthetic daily reconciliation in the cabinet against real HTTP/PostgreSQL, never the restaurant."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

c = json.loads(Path(sys.argv[1]).read_text())
out = Path(c['output'])
DAY = '2026-10-21'
STATEMENT = '\r\n'.join([
    'Синтетическая выписка (не банк)',
    'Дата;Номер;Тип;Сумма;Описание',
    '21.10.2026 10:00:00;900001;Покупка;1 500,00;Синтетика',
    '21.10.2026 11:00:00;900002;Покупка;2 000,00;Клиент +7 700 000 00 00',
    '21.10.2026 12:00:00;900003;Возврат;500,00;Возврат',
]).encode('utf-8')

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1440, 'height': 960})
    page.set_default_timeout(15000)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(c['url'] + '#settlements')
    page.get_by_test_id('credential-file').set_input_files({
        'name': 'synthetic.json', 'mimeType': 'application/json',
        'buffer': json.dumps(c['manager']).encode(),
    })
    tid = page.get_by_test_id
    def b(label):
        return page.get_by_role('button', name=label, exact=True)
    expect(page.get_by_role('heading', name='Ежедневная сверка оплат')).to_be_visible()
    tid('rec-day').fill(DAY)
    tid('rec-day').dispatch_event('change')
    expect(tid('rec-status')).to_contain_text('Нерешённых расхождений нет')
    # Mapping profile for the synthetic statement (the real Kaspi Pay format is not known).
    tid('rec-map-skip_rows').fill('1')
    tid('rec-map-occurred_at').fill('Дата')
    tid('rec-map-amount').fill('Сумма')
    tid('rec-map-operation_id').fill('Номер')
    tid('rec-map-direction').fill('Тип')
    tid('rec-map-description').fill('Описание')
    tid('rec-map-refund_values').fill('Возврат')
    tid('rec-profile-name').fill('Синтетический профиль')
    tid('rec-profile-save').click()
    expect(tid('rec-notice')).to_contain_text('Профиль выписки сохранён')
    tid('rec-file').set_input_files({'name': 'statement.csv', 'mimeType': 'text/csv', 'buffer': STATEMENT})
    expect(page.get_by_text('Выбран: statement.csv')).to_be_visible()
    tid('rec-check').click()
    expect(tid('rec-preview')).to_contain_text('К загрузке: 3')
    expect(tid('rec-preview')).to_contain_text('•••')
    tid('rec-import').click()
    expect(tid('rec-notice')).to_contain_text('Выписка загружена')
    expect(tid('rec-rows')).to_contain_text('Нет в PickChick')
    expect(tid('rec-status')).to_contain_text('Нерешённых расхождений: 3')
    for width, height in [(1440, 960), (393, 852)]:
        page.set_viewport_size({'width': width, 'height': height})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        page.screenshot(path=str(out / f'reconciliation-open-{width}.png'), full_page=True)
    page.set_viewport_size({'width': 1440, 'height': 960})
    # One decision with an owner, then the rest accepted with a reason.
    tid('rec-decide').first.click()
    tid('rec-status-select').select_option('resolved')
    tid('rec-comment').fill('Оплата на терминале кассы (синтетика)')
    tid('rec-decision-save').click()
    expect(tid('rec-status')).to_contain_text('Нерешённых расхождений: 2')
    # Cash on the cashier is not recorded by PickChick: a ККМ total must be explained too.
    tid('rec-total-amount').fill('4 500')
    tid('rec-total-comment').fill('Z-отчёт ККМ (синтетика)')
    tid('rec-total-save').click()
    expect(tid('rec-totals')).to_contain_text('4 500,00 ₸')
    expect(tid('rec-status')).to_contain_text('Нерешённых расхождений: 3')
    tid('rec-accept-all').click()
    tid('rec-reason').fill('Синтетическая проверка: операции терминала')
    tid('rec-reason-confirm').click()
    expect(tid('rec-status')).to_contain_text('Нерешённых расхождений нет')
    expect(tid('rec-close')).to_be_enabled()
    tid('rec-close').click()
    expect(tid('rec-status')).to_contain_text('День закрыт')
    with page.expect_download() as download:
        tid('rec-export').click()
    text = Path(download.value.path()).read_text(encoding='utf-8-sig')
    assert 'Итог по способу' in text and 'Нет в PickChick' in text and 'Принято с причиной' in text
    for width, height in [(1440, 960), (393, 852)]:
        page.set_viewport_size({'width': width, 'height': height})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        page.screenshot(path=str(out / f'reconciliation-closed-{width}.png'), full_page=True)
    page.set_viewport_size({'width': 1440, 'height': 960})
    tid('rec-reopen').click()
    tid('rec-reason').fill('Синтетика: проверка повторного открытия')
    tid('rec-reason-confirm').click()
    expect(tid('rec-status')).to_contain_text('День открыт')
    assert not errors, errors
    browser.close()
