"""Exercise the exported RN game through its visible controls, with all external traffic blocked."""
import json
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect
from browser_network import isolated_context

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('PICK_BOX_URL', 'http://127.0.0.1:4199').rstrip('/')
assert urlparse(URL).hostname in ('localhost', '127.0.0.1')
OUT = ROOT / '.local/pick-box/ascent-browser'
OUT.mkdir(parents=True, exist_ok=True)


def shot(page, name):
    # Let the native Modal's web fade settle before capturing visual evidence.
    page.wait_for_timeout(450)
    page.screenshot(path=str(OUT / f'{name}.png'), full_page=True)


def drop_at(page, edge=False):
    # Observe the rendered sprite and press the real button. No engine state or score injection.
    page.evaluate('''edge => new Promise((resolve, reject) => {
      let lastX = null, lastTime = null, n = 0;
      const loop = time => {
        const button = document.querySelector('[data-testid="pick-box-drop"]');
        const held = document.querySelector('[data-testid="pick-box-held"]');
        const world = document.querySelector('[data-testid="pick-box-coordinate-space"]');
        if (++n > 2400) return reject(Error('No drop opportunity: ' + document.body.innerText));
        if (held && world && button && button.getAttribute('aria-disabled') !== 'true') {
          const r = held.getBoundingClientRect(), w = world.getBoundingClientRect();
          const scale = w.width / 360, x = (r.x + r.width / 2 - w.x) / scale;
          const speed = lastX === null || time === lastTime ? 0 : (x - lastX) / (time - lastTime) * (1000 / 60);
          const target = 180; // Aim above the foundation, not the accumulated lean of the last box.
          if (lastX !== null && (edge ? x > 291 : Math.abs(x + speed * 4.32 - target) < 0.95)) {
            button.click(); return resolve({x, target});
          }
          lastX = x; lastTime = time;
        } else { lastX = null; lastTime = null; }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    })''', edge)


results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for width, height, reduced, target_score in [(393, 852, False, 36 if os.environ.get('PICK_BOX_LONG_RUN') == '1' else 8), (320, 568, True, 2), (768, 1024, False, 2)]:
        context = isolated_context(browser, viewport={'width': width, 'height': height},
                                   device_scale_factor=1, reduced_motion='reduce' if reduced else 'no-preference')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + '/games/pick-box')
        page.wait_for_load_state('networkidle')
        expect(page.get_by_test_id('pick-box-drop')).to_be_enabled(timeout=20000)
        expect(page.get_by_test_id('pick-box-start')).to_have_count(0)
        page.wait_for_timeout(700)
        shot(page, f'start-{width}')
        expect(page.get_by_test_id('pick-box-score')).to_have_text('0')
        bounds = page.get_by_test_id('pick-box-world').bounding_box()
        assert abs(bounds['y'] + bounds['height'] - height) < 2, 'World must reach screen bottom'
        mount = page.get_by_test_id('pick-box-rope-mount').bounding_box()
        assert abs(mount['x'] + mount['width'] / 2 - (bounds['x'] + bounds['width'] / 2)) < 2, 'Rope mount must be centered'
        score_bounds = page.get_by_test_id('pick-box-score-panel').bounding_box()
        peak_bounds = page.get_by_test_id('pick-box-ascent-panel').bounding_box()
        assert score_bounds['x'] + score_bounds['width'] < mount['x'], 'Score must stay left of the rope'
        assert peak_bounds['x'] > mount['x'] + mount['width'], 'Peak must stay right of the rope'
        assert mount['y'] < bounds['y'], 'Mount must sit higher, in the clear HUD corridor'
        for number in range(1, target_score + 1):
            drop_at(page)
            expect(page.get_by_test_id('pick-box-score')).to_have_text(str(number), timeout=12000)
            if number in [1, 8, 20, 28, 36]:
                page.wait_for_timeout(2100)
                shot(page, f'ascent-{number}-{width}')
        page.wait_for_timeout(1600)
        page.evaluate('''() => new Promise((resolve, reject) => {
          let start;
          const tick = t => {
            start ??= t;
            const r = document.querySelector('[data-testid="pick-box-held"]').getBoundingClientRect();
            if (r.left < -1 || r.right > innerWidth + 1) return reject(Error('Held box clips horizontal edge'));
            if (t - start > 4800) return resolve(true);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        })''')
        shot(page, f'tower-{width}')
        if target_score == 36:
            expect(page.get_by_test_id('pick-box-peak')).to_have_text('Космос')
            page.wait_for_function('''() => {
              const rocket = document.querySelector('[data-testid="pick-box-alex-rocket"]');
              const r = rocket.getBoundingClientRect();
              return getComputedStyle(rocket).opacity === '1' && r.x > 35 && r.right < innerWidth - 20;
            }''', timeout=30000)
            shot(page, 'space-alex')
        page.get_by_test_id('pick-box-pause').click()
        expect(page.get_by_test_id('pick-box-resume')).to_be_visible()
        before = page.get_by_test_id('pick-box-held').get_attribute('style')
        rocket_before = page.get_by_test_id('pick-box-alex-rocket').get_attribute('style')
        page.wait_for_timeout(350)
        assert before == page.get_by_test_id('pick-box-held').get_attribute('style'), 'Paused pendulum moved'
        assert rocket_before == page.get_by_test_id('pick-box-alex-rocket').get_attribute('style'), 'Paused scenery moved'
        shot(page, f'pause-{width}')
        page.get_by_test_id('pick-box-resume').click()
        expect(page.get_by_test_id('pick-box-score')).to_have_text(str(target_score))
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow'
        page.reload(); page.wait_for_load_state('networkidle')
        expect(page.get_by_test_id('pick-box-drop')).to_be_enabled()
        expect(page.get_by_test_id('pick-box-start')).to_have_count(0)
        expect(page.get_by_test_id('pick-box-best')).to_have_text(str(target_score))
        for lost in range(1, 4):
            drop_at(page, edge=True)
            expect(page.get_by_test_id('pick-box-lives')).to_have_attribute('aria-label', f'Жизни: {3-lost}', timeout=12000)
        expect(page.get_by_test_id('pick-box-retry')).to_be_visible(timeout=5000)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Result horizontal overflow'
        shot(page, f'over-{width}')
        page.get_by_test_id('pick-box-retry').click()
        expect(page.get_by_test_id('pick-box-score')).to_have_text('0')
        expect(page.get_by_test_id('pick-box-lives')).to_have_attribute('aria-label', 'Жизни: 3')
        # Browser backgrounding follows the same pause path as native AppState.
        page.evaluate("Object.defineProperty(document, 'hidden', {configurable:true, get:()=>true}); document.dispatchEvent(new Event('visibilitychange'))")
        expect(page.get_by_test_id('pick-box-resume')).to_be_visible()
        page.evaluate("delete document.hidden")
        assert not errors, errors
        results.append({'viewport': [width, height], 'reducedMotion': reduced, 'stacked': target_score,
                        'pause': True, 'recordReload': True, 'threeMisses': True, 'retry': True,
                        'backgroundPause': True, 'pageErrors': errors})
        print(json.dumps(results[-1]), flush=True)
        context.close()
    for locale, hint in [('kk', 'Қорапты жіберу'), ('en', 'Drop the box')]:
        context = isolated_context(browser, viewport={'width': 393, 'height': 852})
        preferences = {'version': 2, 'catalogMode': 'design', 'diningMode': 'takeaway', 'locale': locale,
                       'nickname': '', 'branchId': None, 'releaseId': None, 'lines': []}
        context.add_init_script("localStorage.setItem('pickchick.mobile.preferences.v1', JSON.stringify(%s))" % json.dumps(preferences))
        page = context.new_page(); page.goto(URL + '/games/pick-box'); page.wait_for_load_state('networkidle')
        expect(page.get_by_test_id('pick-box-drop')).to_be_enabled(timeout=20000)
        expect(page.get_by_test_id('pick-box-status')).to_have_text(hint)
        expect(page.get_by_test_id('pick-box-start')).to_have_count(0)
        shot(page, 'start-' + locale)
        expect(page.get_by_test_id('pick-box-score')).to_have_text('0')
        page.get_by_test_id('pick-box-drop').focus(); page.keyboard.press('Enter')
        expect(page.get_by_test_id('pick-box-body-1')).to_be_attached()
        results.append({'locale': locale, 'localizedDirectEntry': True, 'keyboardDrop': True})
        context.close()
    browser.close()
(OUT / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
