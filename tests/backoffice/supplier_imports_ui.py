"""Lane bo-ui2 step 3 «Импорт цен из iiko» in the real back office (Chromium).

See supplier-imports-browser.test.mjs. Phases: empty (supply on, no import yet: the block says
how imports come), loaded (after the script imported a synthetic file twice: the newest import
with its state, what was loaded, the report counts, the rows that were not loaded with the
reason and a filter, the suppliers of the import, the choice of the older import; the manager at
1440 and 390 px, the analyst reads the same), old-api (step 6: the view answers 404 like a step 2
server, so the block is hidden and nothing else changes; a 503 is said in words inside the
block). Screenshots at 1440x900 and 390x844, scale 1, Asia/Almaty. Synthetic data only.
"""
import json
import sys
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

config = json.loads(Path(sys.argv[1]).read_text())
output = Path(config['output'])
PHASE = config['phase']
LONG_DASHES = ('—', '–')

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--lang=ru-RU'])
    errors = []

    def session(credential, width=1440, height=900, imports=None):
        context = browser.new_context(viewport={'width': width, 'height': height},
                                      device_scale_factor=1, timezone_id='Asia/Almaty',
                                      locale='ru-RU')
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        if imports:
            # Step 6: the view answers like an older server (404 of an unknown view) or fails
            # (503), in the standard error envelope of the API.
            status, code = imports
            envelope = json.dumps({'code': code, 'message_key': 'errors.' + code.lower(),
                                   'trace_id': str(uuid.uuid4()), 'retryable': status >= 500})
            page.route('**/ops/supplier-imports*', lambda route: route.fulfill(
                status=status, content_type='application/json', body=envelope))
        page.goto(config['url'] + '#supply')
        page.get_by_test_id('credential-file').set_input_files({
            'name': 'person.json', 'mimeType': 'application/json',
            'buffer': json.dumps(credential).encode()}, timeout=15000)
        expect(page.locator('.user')).to_be_visible()
        page.wait_for_function("() => !document.body.innerText.includes('Загружаем данные')")
        expect(page.get_by_test_id('supply')).to_be_visible()
        page.get_by_test_id('sp-tab-suppliers').click()
        if imports and imports[0] == 404:
            expect(page.get_by_test_id('sp-suppliers')).to_be_visible()
        else:
            expect(page.get_by_test_id('sp-imports')).to_be_visible()
        return page

    def capture(page, name, full=True):
        page.evaluate("""async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}""")
        page.screenshot(path=str(output / name), full_page=full)

    def no_long_dash(page, where):
        body = page.locator('body').inner_text()
        assert not any(d in body for d in LONG_DASHES), 'long dash on ' + where

    def no_page_scroll(page, width):
        scroll = page.evaluate('document.documentElement.scrollWidth')
        assert scroll <= width, (scroll, width)

    if PHASE == 'empty':
        page = session(config['manager'])
        expect(page.get_by_test_id('sp-import-empty')).to_contain_text('Импортов ещё не было.')
        no_long_dash(page, 'empty')
        capture(page, 'imports-empty-1440.png')
        page.context.close()

    if PHASE == 'old-api':
        # Step 6 (step 3 notDone): an API without ops/supplier-imports (404, as a step 2 build
        # answers) hides the block and nothing else; the suppliers and the requests still work.
        for width, height in ((1440, 900), (390, 844)):
            page = session(config['manager'], width, height, imports=(404, 'NOT_FOUND'))
            expect(page.get_by_test_id('sp-suppliers')).to_contain_text('Поставщик 1')
            expect(page.get_by_test_id('sp-imports')).to_have_count(0)
            expect(page.locator('body')).not_to_contain_text('Импорты цен не загрузились')
            expect(page.locator('body')).not_to_contain_text('Закупки не загрузились')
            no_long_dash(page, f'old-api {width}')
            no_page_scroll(page, width)
            capture(page, f'imports-old-api-{width}.png')
            page.get_by_test_id('sp-tab-requests').click()
            expect(page.get_by_test_id('sp-new')).to_be_enabled()
            page.context.close()
        # Any other failure is said in words inside the block; the rest of the page stays.
        page = session(config['manager'], imports=(503, 'SERVICE_UNAVAILABLE'))
        alert = page.get_by_test_id('sp-imports').locator('[role=alert]')
        expect(alert).to_have_text('Импорты цен не загрузились. Нажмите «Обновить».')
        expect(page.get_by_test_id('sp-suppliers')).to_contain_text('Поставщик 1')
        capture(page, 'imports-failed-1440.png')
        page.context.close()

    if PHASE == 'loaded':
        for width, height in ((1440, 900), (390, 844)):
            page = session(config['manager'], width, height)
            block = page.get_by_test_id('sp-imports')
            expect(page.get_by_test_id('sp-import-state')).to_have_text('Загружен полностью')
            expect(page.get_by_test_id('sp-import-head')).to_contain_text('Файл: prices-2.csv')
            expect(page.get_by_test_id('sp-import-head')).to_contain_text('Синтетический управляющий')
            expect(page.get_by_test_id('sp-import-loaded')).to_have_text(
                'Загружено новых цен: 1, новых поставщиков: 1.')
            counts = page.get_by_test_id('sp-import-counts')
            for label, value in (('Строк в файле', '3'), ('Новых цен', '1'),
                                 ('Позиция не найдена', '1'), ('Единица не подходит', '1')):
                expect(counts.locator('.sp-count', has_text=label).locator('dd')).to_have_text(value)
            issues = page.get_by_test_id('sp-import-issues')
            expect(issues.locator('tbody tr')).to_have_count(2)
            expect(issues).to_contain_text('Позиция не найдена')
            expect(issues).to_contain_text('Синтетическая неизвестная позиция')
            expect(issues).to_contain_text('Единица не подходит к позиции')
            # The filter by reason.
            page.get_by_test_id('sp-import-filter').select_option('NOT_FOUND')
            expect(page.get_by_test_id('sp-import-issues').locator('tbody tr')).to_have_count(1)
            suppliers = page.get_by_test_id('sp-import-suppliers')
            expect(suppliers.locator('tr', has_text='Поставщик 3')).to_contain_text('Да, создан импортом')
            no_long_dash(page, f'loaded {width}')
            no_page_scroll(page, width)
            # Every button and amount of the block stays on the screen of a phone.
            for i in range(block.locator('select, td').count()):
                b = block.locator('select, td').nth(i).bounding_box()
                assert b is None or (b['x'] >= 0 and b['x'] + b['width'] <= width + 0.5), (width, i, b)
            capture(page, f'imports-loaded-{width}.png')
            if width == 1440:
                # The older import, from the choice.
                pick = page.get_by_test_id('sp-import-pick')
                expect(pick.locator('option')).to_have_count(2)
                pick.select_option(index=1)
                expect(page.get_by_test_id('sp-import-head')).to_contain_text('Файл: prices-1.csv')
                expect(page.get_by_test_id('sp-import-loaded')).to_have_text(
                    'Загружено новых цен: 2, новых поставщиков: 1. Исправлено вручную после импорта: 1.')
                capture(page, 'imports-older-1440.png')
            page.context.close()
        page = session(config['analyst'])
        expect(page.get_by_test_id('sp-import-state')).to_have_text('Загружен полностью')
        expect(page.get_by_test_id('sp-import-issues').locator('tbody tr')).to_have_count(2)
        capture(page, 'imports-analyst-1440.png')
        page.context.close()

    browser.close()
    assert not errors, errors
print('supplier imports browser: ok', PHASE)
