"""Run against pnpm design:serve. Tool dependency: playwright==1.58.0 + chromium."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
from kiosk_ux import check_kiosk_ux
root = Path(__file__).resolve().parents[2]
screens = json.loads((root / 'design/prototype/screens.json').read_text())
base = os.environ.get('DESIGN_URL', 'http://127.0.0.1:4173')
output = root / '.local/design-qa'
output.mkdir(parents=True, exist_ok=True)
errors = []
broken = []
overflows = []
checked = 0
video_fallbacks = []
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
            # render() applies the surface's native size in requestAnimationFrame.
            page.wait_for_function('()=>Boolean(document.querySelector("#preview")?.style.width) && document.fonts.status==="loaded"')
            body = page.locator('#preview').inner_text()
            assert 'Экран не определён' not in body, (screen['id'], state)
            assert 'undefined' not in body, (screen['id'], state)
            assert len(body) > 50, (screen['id'], state)
            bad = page.locator('#preview').evaluate('(e)=>e.scrollWidth>e.clientWidth+2')
            if bad:
                overflows.append([screen['id'], state])
            if screen['id'].startswith('M') and page.locator('#preview .bottom-nav').count():
                geometry = page.locator('#preview').evaluate('''frame=>{
                    const scroll=frame.querySelector('.frame-content'), nav=frame.querySelector('.bottom-nav');
                    const before=nav.getBoundingClientRect();
                    scroll.scrollTop=scroll.scrollHeight;
                    const after=nav.getBoundingClientRect(), bounds=frame.getBoundingClientRect();
                    return {before:before.bottom,after:after.bottom,frame:bounds.bottom};
                }''')
                assert abs(geometry['after'] - geometry['before']) < 1, (screen['id'], state, geometry)
                assert abs(geometry['after'] - geometry['frame']) < 2, (screen['id'], state, geometry)
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
    # Reference-specific behavior survives the visual revision.
    page.goto(base + '/#M06')
    page.wait_for_selector('.ref-mobile-video')
    assert page.locator('[data-action="video-toggle"]').count() == 0
    assert page.locator('video').evaluate('(v)=>!v.controls && v.muted && v.loop')
    assert page.locator('.bottom-nav button[data-go="M19"]').count() == 1
    assert page.locator('.bottom-nav button[data-go="M23"]').count() == 0
    page.goto(base + '/#K01')
    page.wait_for_selector('[data-go="K02"]')
    page.locator('#preview [data-go="K02"]').first.click()
    page.wait_for_function('()=>document.title.startsWith("K02")')
    # Decorative video has no playback buttons; a failed source retains the poster and menu.
    cold = browser.new_page(viewport={'width': 1600, 'height': 1200})
    cold.on('pageerror', lambda e: errors.append(str(e)))
    cold.route('**/assets/mockup/hero.mp4', lambda route: route.abort())
    cold.goto(base + '/#M06')
    cold.wait_for_function('()=>{const v=document.querySelector("#preview video");return v && v.networkState===v.NETWORK_NO_SOURCE;}')
    assert cold.locator('#preview video').evaluate('(v)=>v.paused && !v.controls && Boolean(v.poster)')
    assert cold.locator('[data-action="video-toggle"]').count() == 0
    assert cold.locator('.bottom-nav button[data-go="M19"]').count() == 1
    cold.close()
    kiosk_checks = check_kiosk_ux(browser, base)
    page.set_viewport_size({'width': 2100, 'height': 1550})
    for (id, name) in [('M06', 'mobile-menu'), ('M07', 'mobile-product'), ('M18', 'mobile-ready'), ('M23', 'mobile-wallet'), ('M30', 'mobile-profile'), ('K01', 'kiosk-welcome'), ('K03', 'kiosk-menu'), ('P03', 'pos-sale'), ('D01', 'kitchen-a'), ('D02', 'kitchen-b'), ('T01', 'display'), ('B02', 'backoffice')]:
        page.goto(base + '/')
        page.reload()
        page.wait_for_load_state('networkidle')
        page.goto(base + '/#' + id)
        page.wait_for_function('(id)=>document.title.startsWith(id)', arg=id)
        page.wait_for_load_state('networkidle')
        page.locator('#preview').evaluate('(e)=>{e.style.transform="scale(1)";e.style.position="relative";}')
        if page.locator('#preview video').count():
            page.wait_for_function('()=>Array.from(document.querySelectorAll("#preview video")).every(v=>v.readyState>=1 || v.error || v.networkState===v.NETWORK_NO_SOURCE)')
            if page.locator('#preview video').evaluate_all('(videos)=>videos.some(v=>v.error || v.networkState===v.NETWORK_NO_SOURCE)'):
                video_fallbacks.append(id)
            page.locator('#preview video').evaluate_all('(videos)=>videos.forEach(v=>{v.pause();if(!v.error && v.readyState>=1)v.currentTime=4;})')
            page.wait_for_function('()=>Array.from(document.querySelectorAll("#preview video")).every(v=>!v.seeking)')
        page.locator('#preview').screenshot(path=str(root / 'design/previews' / f'{name}.png'))
        if id == 'M06':
            page.locator('#preview .frame-content').evaluate('(e)=>e.scrollTop=640')
            page.locator('#preview').screenshot(path=str(root / 'design/previews/mobile-menu-scrolled.png'))
    page.set_viewport_size({'width': 390, 'height': 900})
    page.goto(base + '/#M06')
    page.wait_for_function('()=>document.title.startsWith("M06")')
    page.wait_for_function('()=>document.body.scrollWidth<=window.innerWidth+2')
    assert page.locator('body').evaluate('(e)=>e.scrollWidth<=window.innerWidth+2')
    page.screenshot(path=str(output / 'review-at-390.png'), full_page=True)
    browser.close()
result = {'screens': len(screens), 'screen_states': checked, 'browser_errors': errors, 'failed_resources': broken, 'frame_overflows': overflows, 'video_poster_fallbacks': video_fallbacks, 'interactive_checks': ['menu→product→cart', 'quantity', 'cash amount / disabled confirmation', 'unknown payment stays unknown', 'assembly dependencies', 'table search', '390px review layout', 'decorative video without playback controls', 'source bottom navigation', 'kiosk attract transition', 'no pause control before media loads', 'unavailable media poster fallback']}
result['interactive_checks'].extend(kiosk_checks)
(output / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
assert not errors and (not broken) and (not overflows)
