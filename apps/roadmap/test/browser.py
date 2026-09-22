"""Real roadmap UI + isolated HTTP/SQLite, no restaurant operations."""
import json
import os
from pathlib import Path
import re
from playwright.sync_api import sync_playwright, expect

base = os.environ['ROADMAP_TEST_URL']
key_file = Path(os.environ['ROADMAP_TEST_KEY_FILE'])
output = Path(os.environ.get('ROADMAP_SCREENSHOTS', '.local/roadmap-browser'))
output.mkdir(parents=True, exist_ok=True)
report = []
source = json.loads((Path(__file__).resolve().parents[3] / 'docs/roadmap/project.json').read_text())
pos_design = next(task for task in source['tasks'] if task['id'] == 'pos-design')
source_fact_count = sum(value is True for value in pos_design['checks'].values())


def login(page):
    page.goto(base)
    page.wait_for_load_state('networkidle')
    page.get_by_text('Или выбрать файл с ключом', exact=True).click()
    page.locator('#access-file').set_input_files(key_file)
    page.locator('#access-name').fill('Тест пульта')
    page.get_by_role('button', name='Открыть пульт проекта').click()
    expect(page.locator('.sidebar')).to_be_visible()


def goto(page, route):
    page.goto(base + '#' + route)
    page.wait_for_load_state('networkidle')
    expect(page.locator('#main')).to_be_visible()
    page.evaluate('window.scrollTo(0, 0)')
    page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')


def fits(page):
    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth'), 'Page overflows viewport: ' + page.url


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    login(page)
    expect(page.locator('.stream-card')).to_have_count(21)
    fits(page)
    page.screenshot(path=str(output / 'overview-desktop.png'), full_page=True)
    report.append('Access-key file login and all 21 workstreams')
    for route in ['directions', 'plan', 'checks', 'customer']:
        goto(page, route)
        fits(page)
        page.screenshot(path=str(output / (route + '-desktop.png')), full_page=False)
    assert page.locator('body').inner_text().find('\nfalse\n') == -1
    goto(page, 'directions')
    page.get_by_label('Поиск по задачам').fill('payments-applepay')
    expect(page.locator('.task-row')).to_have_count(1)
    page.get_by_label('Поиск по задачам').fill('нет-такой-задачи')
    expect(page.get_by_role('heading', name='Такой задачи пока нет')).to_be_visible()
    report.append('Five views, source links, search and empty state')

    goto(page, 'directions?task=pos-design')
    expect(page.locator('#task-dialog')).to_be_visible()
    expect(page.locator('#task-title')).to_have_text(pos_design['title'])
    expect(page.locator('.facts-grid .fact-chip.yes')).to_have_count(source_fact_count)
    # Two separate browsers edit the same initial version.
    other_context = browser.new_context(viewport={'width': 1280, 'height': 900})
    other = other_context.new_page()
    login(other)
    goto(other, 'directions?task=pos-design')
    page.locator('#review-result').select_option('passed')
    page.locator('#review-note').fill('Проверен только пульт. <img src=x onerror=alert(1)>')
    page.get_by_role('button', name='Сохранить для команды').click()
    expect(page.locator('#task-dialog .form-message.success')).to_be_visible()
    expect(page.locator('.facts-grid .fact-chip.yes')).to_have_count(source_fact_count)
    other.locator('#review-note').fill('Мой текст должен сохраниться при конфликте.')
    other.get_by_role('button', name='Сохранить для команды').click()
    expect(other.get_by_role('button', name='Показать последнюю запись')).to_be_visible()
    expect(other.locator('#review-note')).to_have_value('Мой текст должен сохраниться при конфликте.')
    other.get_by_role('button', name='Показать последнюю запись').click()
    expect(other.get_by_role('button', name='Сохранить для команды')).to_be_enabled()
    expect(other.locator('#review-note')).to_have_value('Мой текст должен сохраниться при конфликте.')
    other.locator('#review-result').select_option('failed')
    other.get_by_role('button', name='Сохранить для команды').click()
    expect(other.locator('#task-dialog .form-message.success')).to_be_visible()
    other_context.close()
    page.reload()
    page.wait_for_load_state('networkidle')
    expect(page.locator('#task-dialog')).to_be_visible()
    expect(page.locator('#review-result')).to_have_value('failed')
    expect(page.locator('#review-note')).to_have_value('Мой текст должен сохраниться при конфликте.')
    page.screenshot(path=str(output / 'task-desktop.png'), full_page=False)
    report.append('Shared save, conflict comparison, exact text, reload and immutable source facts')

    # Failed network writes preserve the draft.
    page.route('**/api/reviews/**', lambda route: route.abort())
    page.locator('#review-note').fill('Эту заметку нельзя терять при пропаже связи.')
    page.get_by_role('button', name='Сохранить для команды').click()
    expect(page.get_by_text(re.compile('Не удалось сохранить. Ваши изменения остались'))).to_be_visible()
    expect(page.locator('#review-note')).to_have_value('Эту заметку нельзя терять при пропаже связи.')
    page.unroute('**/api/reviews/**')
    context.clear_cookies()
    page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    expect(page.locator('#session-renewal')).to_be_visible()
    expect(page.locator('#review-note')).to_have_value('Эту заметку нельзя терять при пропаже связи.')
    page.locator('#renew-key').fill(key_file.read_text().strip())
    page.get_by_role('button', name='Войти заново').click()
    expect(page.locator('#session-renewal')).to_have_count(0)
    expect(page.locator('#review-note')).to_have_value('Эту заметку нельзя терять при пропаже связи.')
    report.append('Session renewal preserves an unsaved draft')
    page.get_by_role('button', name='Закрыть задачу').click()
    report.append('Failed write retains draft; dialog closes accessibly')

    for width in [390, 320]:
        page.close()
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_viewport_size({'width': width, 'height': 844})
        for route in ['overview', 'directions', 'plan', 'checks', 'customer']:
            goto(page, route)
            fits(page)
            page.screenshot(path=str(output / (route + '-' + str(width) + '.png')), full_page=False)
        goto(page, 'directions?task=payments-applepay')
        fits(page)
        expect(page.locator('#task-dialog')).to_be_visible()
        assert page.locator('#task-dialog').evaluate('(d) => d.scrollWidth <= d.clientWidth'), 'Dialog overflows'
        page.screenshot(path=str(output / ('task-' + str(width) + '.png')), full_page=False)
        page.keyboard.press('Escape')
        expect(page.locator('#task-dialog')).not_to_be_visible()
    assert not errors, errors
    report.append('All views and task details at 390/320 px; no page or dialog overflow; no JS errors')
    context.close()
    browser.close()
print(json.dumps({'passed': report, 'screenshots': str(output)}, ensure_ascii=False, indent=2))
