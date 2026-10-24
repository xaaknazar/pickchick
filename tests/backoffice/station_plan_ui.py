"""Station plan delivery in the back-office (stage 2, lane cfg).

Real local API, PostgreSQL and the operator proxy; no browser mocks. The fixture already holds
an applied version 1 and a rejected version 2 (unknown kitchen station) confirmed by the edge.
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

config = json.loads(Path(sys.argv[1]).read_text())
output = Path(config['output'])

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1440, 'height': 960}, device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.set_default_timeout(15000)

    def at(test_id):
        return page.get_by_test_id(test_id)

    def navigate(section):
        toggle = at('navigation-toggle')
        if toggle.is_visible() and toggle.get_attribute('aria-expanded') == 'false':
            toggle.click()
        at('nav-' + section).click()

    page.goto(config['url'])
    at('credential-file').set_input_files({
        'name': 'synthetic-manager.json',
        'mimeType': 'application/json',
        'buffer': json.dumps(config['manager']).encode(),
    })
    expect(at('nav-stations')).to_be_visible()
    navigate('stations')
    panel = at('station-plan-panel')
    expect(panel).to_be_visible()
    state = at('station-plan-state')
    expect(state).to_contain_text('Версия 2: касса отклонила')
    expect(state).to_contain_text('станция кухни не найдена на кассе (станция «Напитки»)')
    expect(state).to_contain_text('Предыдущий план остаётся на кассе. На кассе действует версия 1.')
    expect(state).to_have_attribute('role', 'alert')
    expect(panel.locator('tbody tr')).to_have_count(2)
    expect(panel.locator('tbody tr').nth(1)).to_contain_text('Применено на кассе')
    expect(panel).to_contain_text('Подтверждено кассой')
    page.screenshot(path=str(output / 'station-plan-rejected-1440.png'), full_page=True)

    # The edit dialog offers the kitchen stations the cashier reported, by name and kind.
    at('op-edit-' + config['drinks']).click()
    binding = at('op-edge_station_id')
    expect(binding).to_be_visible()
    options = binding.locator('option').all_inner_texts()
    assert 'Фритюр (Приготовление)' in options, options
    assert 'Сборка (Сборка)' in options, options
    assert 'Станция, которой больше нет на кассе' in options, options
    binding.select_option(label='Сборка (Сборка)')
    page.get_by_label('Роль станции').select_option('assembly')
    at('op-reason').fill('Привязка к станции сборки')
    at('op-save').click()
    expect(at('op-editor')).to_have_count(0)

    # Send the current plan again: a new version waits for the cashier.
    at('station-plan-deliver').click()
    at('op-reason').fill('Отправить исправленный план')
    at('op-save').click()
    expect(page.locator('dialog')).to_have_count(0)
    expect(state).to_contain_text('Версия 3: опубликовано в облаке, касса ещё не получила')
    expect(state).to_contain_text('На кассе действует версия 1.')
    page.set_viewport_size({'width': 1024, 'height': 900})
    page.screenshot(path=str(output / 'station-plan-published-1024.png'), full_page=True)
    overflow = page.evaluate('document.documentElement.scrollWidth - window.innerWidth')
    assert overflow <= 0, overflow
    assert not errors, errors
    browser.close()
print('station plan UI checks passed')
