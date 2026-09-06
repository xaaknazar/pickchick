"""Run against pnpm design:serve. Tool dependency: playwright==1.58.0 + chromium."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
root = Path(__file__).resolve().parents[2]
screens = json.loads((root / 'design/prototype/screens.json').read_text())
base = os.environ.get('DESIGN_URL', 'http://127.0.0.1:4173')
output = root / '.local/design-qa'
output.mkdir(parents=True, exist_ok=True)
errors = []
broken = []
overflows = []
checked = 0
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1600, 'height': 1200}, device_scale_factor=1)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('response', lambda r: broken.append([r.status, r.url]) if r.status >= 400 else None)
    page.goto(base)
    page.wait_for_load_state('networkidle')
    page.screenshot(path=str(output / 'overview.png'), full_page=True)
    for screen in screens:
        for state in screen['states']:
            fragment = screen['id'] + ('' if state == 'default' else '?state=' + state)
            page.goto(base + '/#' + fragment)
            page.wait_for_function('(id)=>document.title.startsWith(id)', arg=screen['id'])
            page.wait_for_function('(value)=>document.querySelector("#state-select")?.value===value', arg=state)
            body = page.locator('#preview').inner_text()
            assert 'Экран не определён' not in body, (screen['id'], state)
            assert 'undefined' not in body, (screen['id'], state)
            assert len(body) > 50, (screen['id'], state)
            bad = page.locator('#preview').evaluate('(e)=>e.scrollWidth>e.clientWidth+2')
            if bad:
                overflows.append([screen['id'], state])
            checked += 1
    page.goto(base + '/#M06')
    page.wait_for_selector('.product-card')
    page.locator('#preview .product-card').first.click()
    page.wait_for_function('()=>document.title.startsWith("M07")')
    page.locator('#preview button[data-go="M09"]').click()
    page.wait_for_function('()=>document.title.startsWith("M09")')
    page.locator('[data-action="increment"]').click()
    assert '6\xa0980' in page.locator('#preview').inner_text()
    page.goto(base + '/#P07')
    page.wait_for_selector('[data-cash-input]')
    page.locator('[data-cash-input]').fill('100')
    assert page.locator('[data-action="cash-confirm"]').is_disabled()
    page.locator('[data-cash-input]').fill('10000')
    assert page.locator('[data-action="cash-confirm"]').is_enabled()
    page.goto(base + '/#M14')
    page.locator('[data-action="payment-check"]').click()
    assert 'Проверяем платёж' in page.title()
    page.goto(base + '/#D03')
    page.wait_for_selector('[data-action="kds-done"]')
    assert page.locator('[data-action="kds-done"]').is_disabled()
    page.locator('[data-action="assemble"]').check()
    assert page.locator('[data-action="kds-done"]').is_enabled()
    page.goto(base + '/#B03')
    page.wait_for_selector('[data-table-search]')
    page.locator('[data-table-search]').fill('Яндекс')
    assert page.locator('#preview tbody tr:visible').count() == 1
    page.set_viewport_size({'width': 2100, 'height': 1550})
    for (id, name) in [('M06', 'mobile-menu'), ('K03', 'kiosk-menu'), ('P03', 'pos-sale'), ('D01', 'kitchen-a'), ('D02', 'kitchen-b'), ('T01', 'display'), ('B02', 'backoffice')]:
        page.goto(base + '/')
        page.reload()
        page.wait_for_load_state('networkidle')
        page.goto(base + '/#' + id)
        page.wait_for_function('(id)=>document.title.startsWith(id)', arg=id)
        page.wait_for_load_state('networkidle')
        page.locator('#preview').evaluate('(e)=>{e.style.transform="none";e.style.position="relative";}')
        page.locator('#preview').screenshot(path=str(root / 'design/previews' / f'{name}.png'))
    page.set_viewport_size({'width': 390, 'height': 900})
    page.goto(base + '/#M06')
    page.wait_for_selector('#preview')
    assert page.locator('body').evaluate('(e)=>e.scrollWidth<=window.innerWidth+2')
    page.screenshot(path=str(output / 'review-at-390.png'), full_page=True)
    browser.close()
result = {'screens': len(screens), 'screen_states': checked, 'browser_errors': errors, 'failed_resources': broken, 'frame_overflows': overflows, 'interactive_checks': ['menu→product→cart', 'quantity', 'cash amount / disabled confirmation', 'unknown payment stays unknown', 'assembly dependencies', 'table search', '390px review layout']}
(output / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
assert not errors and (not broken) and (not overflows)
