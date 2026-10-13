"""Kiosk redesign 2026-10-13: start screen and dining choice on the exported web UI.

Run after exporting apps/kiosk, with the same environment as browser_ui.py
(KIOSK_UI_URL points at the local preview server). Every API request goes to
browser_ui.Fixture. For each iPad size (1024x1366, 820x1180, 744x1133) and
locale it checks and captures the start screen at rest (reduced motion) and the
dining choice, then frames of the CTA salute at ~8 %, ~25 %, ~40 % and ~60 %
of its 2.8 s cycle. Salute frames run in real time: the page watches the sweep band,
derives the cycle phase from its position when it starts to move (6 %), waits
for the target phase and reports the sparks; the screenshot follows at once, so
it lands a frame or two later. Results go to KIOSK_REDESIGN_OUTPUT (default
.local/kiosk-redesign-start), small JPEGs plus redesign-start.json.
"""
import json
import os
import unittest
from pathlib import Path

from playwright.sync_api import expect

import browser_ui as ui


OUTPUT = Path(os.environ.get('KIOSK_REDESIGN_OUTPUT', '.local/kiosk-redesign-start'))
SIZES = [(1024, 1366), (820, 1180), (744, 1133)]
COPY = {
    'ru': {'kaspi': 'Оплата через Kaspi QR', 'cta': 'СДЕЛАТЬ ЗАКАЗ', 'title': 'Как будете есть?'},
    'kk': {'kaspi': 'Kaspi QR арқылы төлем', 'cta': 'ТАПСЫРЫС БЕРУ', 'title': 'Қалай тамақтанасыз?'},
    'en': {'kaspi': 'Pay with Kaspi QR', 'cta': 'ORDER NOW', 'title': 'Where will you eat?'},
}
FRAMES = (0.08, 0.25, 0.40, 0.60)

# Shared page helpers: the visible copy of a test id and the salute's current state.
STATE = '''
const visible = (id) => [...document.querySelectorAll(`[data-testid="${id}"]`)]
    .find((e) => e.getClientRects().length);
const salute = () => {
    const button = visible('kiosk-start');
    const band = visible('kiosk-start-sweep');
    const sparks = visible('kiosk-start-sparks');
    const spring = visible('kiosk-start-spring');
    const match = band && /translateX\\(([-0-9.e]+)px\\)/.exec(band.style.transform || '');
    const lit = sparks ? [...sparks.children].filter(
        (s) => parseFloat(getComputedStyle(s).opacity) > 0.05) : [];
    const box = button.getBoundingClientRect();
    const reach = lit.map((s) => {
        const r = s.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        return Math.hypot(Math.max(box.left - x, 0, x - box.right),
                          Math.max(box.top - y, 0, y - box.bottom));
    });
    return {
        width: button.offsetWidth,
        sweep: match ? parseFloat(match[1]) / button.offsetWidth : null,
        sparks: sparks ? sparks.children.length : 0,
        lit: lit.length,
        reach: reach.length ? Math.round(Math.max(...reach)) : 0,
        spring: spring ? getComputedStyle(spring).transform : null,
    };
};
'''

# Wait for the next sweep start, infer the phase (band: -35 % at 6 %, CSS `ease-in-out`
# to 125 % at 50 % of 2.8 s), then wait for `target` and return the state.
AT_PHASE = '''async (target) => {
''' + STATE + '''
    const bezier = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
    const solve = (f, y) => {
        let low = 0, high = 1;
        for (let i = 0; i < 40; i++) {
            const mid = (low + high) / 2;
            if (f(mid) < y) low = mid; else high = mid;
        }
        return (low + high) / 2;
    };
    const ease = (x) => bezier(solve((t) => bezier(t, 0.42, 0.58), x), 0, 1);
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const started = performance.now();
    let previous = salute().sweep;
    for (;;) {
        await frame();
        const now = performance.now();
        if (now - started > 8000) return {error: 'sweep band never started', state: salute()};
        const position = salute().sweep;
        if (previous !== null && position !== null && previous <= -0.349 && position > -0.349) {
            const phase = 0.06 + 0.44 * solve(ease, (position + 0.35) / 1.6);
            const wait = (target - phase) * 2800 - (performance.now() - now);
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait)));
            return {...salute(), phase: Math.round(phase * 1000) / 1000};
        }
        previous = position;
    }
}'''


def scale(width):
    return max(0.8, min(1.08, width / 1024))


def px(width, n):
    return round(n * scale(width))


def shoot(page, name):
    page.screenshot(path=str(OUTPUT / name), type='jpeg', quality=72)


def settle(page):
    page.evaluate('() => document.fonts.ready')
    page.wait_for_function("""() => [...document.images].filter(image => {
        const r = image.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
    }).every(image => image.complete && image.naturalWidth > 0)""")


class RedesignStart(ui.KioskUI):
    def page_for(self, width, height, motion):
        context = self.browser.new_context(viewport={'width': width, 'height': height},
                                           reduced_motion='no-preference' if motion else 'reduce')
        fixture = ui.Fixture(self.catalog)
        context.route('**/*', fixture.route)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        self.contexts.append((context, page, fixture, errors))
        page.goto(ui.URL)
        ui.screen(page, 'welcome')
        settle(page)
        return page

    def locale(self, page, value):
        ui.element(page, 'kiosk-language-' + value).click()
        expect(ui.element(page, 'kiosk-language-' + value)).to_have_attribute('aria-pressed', 'true')

    def check_start(self, page, width, height, value):
        expect(ui.element(page, 'kiosk-start')).to_contain_text(COPY[value]['cta'])
        ui.assert_bounded(page, 'kiosk-start', width, height)
        chip = ui.assert_bounded(page, 'kiosk-start-kaspi', width, height)
        expect(ui.element(page, 'kiosk-start-kaspi')).to_have_text(COPY[value]['kaspi'])
        self.assertLessEqual(abs(chip['height'] - px(width, 75)), 1, chip)
        look = page.evaluate('() => {' + STATE + '''
            const chip = getComputedStyle(visible('kiosk-start-kaspi'));
            const track = getComputedStyle(visible('kiosk-language-ru').parentElement);
            const label = getComputedStyle(visible('kiosk-start-kaspi').querySelector('[dir="auto"]'));
            const cta = getComputedStyle(visible('kiosk-start').querySelector('[dir="auto"]'));
            const glow = getComputedStyle(visible('kiosk-start').parentElement);
            return {
                cta: [cta.fontFamily, cta.fontSize, cta.letterSpacing],
                glow: glow.boxShadow,
                chip: [chip.backgroundColor, chip.borderTopColor, chip.borderTopWidth,
                       chip.backdropFilter, chip.borderTopLeftRadius],
                track: [track.backgroundColor, track.borderTopColor, track.borderTopWidth,
                        track.backdropFilter],
                label: [label.fontFamily, label.fontSize],
            };
        }''')
        self.assertEqual(look['chip'][:4], ['rgba(2, 10, 31, 0.28)', 'rgba(255, 255, 255, 0.2)',
                                            '1px', 'blur(14px)'], look)
        self.assertEqual(look['track'], ['rgba(2, 10, 31, 0.55)', 'rgba(255, 255, 255, 0.18)',
                                         '1px', 'blur(14px)'], look)
        self.assertIn('Montserrat_700Bold', look['label'][0], look)
        self.assertEqual(look['label'][1], f'{px(width, 24)}px', look)
        # CTA as in the approved mock-up: Montserrat 900 58, letter-spacing .04em, glow 0 16 48.
        self.assertIn('Montserrat_900Black', look['cta'][0], look)
        self.assertEqual(look['cta'][1], f'{px(width, 58)}px', look)
        self.assertAlmostEqual(float(look['cta'][2][:-2]), px(width, 58) * 0.04, delta=0.05, msg=look)
        self.assertIn(f'0px {px(width, 16)}px {px(width, 48)}px', look['glow'], look)
        ui.assert_no_overflow(page, width)
        return {'chip': chip, 'look': look}

    def check_mode(self, page, width, height, value):
        title = ui.element(page, 'kiosk-screen-mode').get_by_role('heading', name=COPY[value]['title'])
        expect(title).to_be_visible()
        line = title.evaluate('''(e) => {
            const style = getComputedStyle(e);
            return {height: e.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight),
                    fontSize: parseFloat(style.fontSize), truncated: e.scrollWidth > e.clientWidth + 1,
                    scrollWidth: e.scrollWidth, clientWidth: e.clientWidth};
        }''')
        # One line in every locale. React Native Web ignores adjustsFontSizeToFit, so on the
        # 744 pt web export the Kazakh title is clipped (recorded only); iPad shrinks it
        # (it needs ~96 % of the size, the floor is 75 %).
        self.assertLess(line['height'], line['lineHeight'] * 1.5, ('title wraps', value, width, line))
        if width >= 820:
            self.assertFalse(line['truncated'], ('title clipped', value, width, line))
        here = ui.assert_bounded(page, 'kiosk-mode-dine-in', width, height)
        take = ui.assert_bounded(page, 'kiosk-mode-takeaway', width, height)
        self.assertLessEqual(abs(here['height'] - take['height']), 1, ('card heights', here, take))
        return {'title': line, 'cards': [here['height'], take['height']]}

    def salute(self, width, height, value):
        page = self.page_for(width, height, motion=True)
        if value != 'ru':
            self.locale(page, value)
        frames = {}
        for target in FRAMES:
            state = page.evaluate(AT_PHASE, target)
            name = f'start-salute-{round(target * 100):02d}-{value}-{width}.jpg'
            shoot(page, name)
            self.assertNotIn('error', state, state)
            frames[name] = state
        early, crossing, middle, late = frames.values()
        self.assertEqual([f['sparks'] for f in frames.values()], [14] * 4, frames)
        # ~8 %: sparks have appeared at the edges, the band is still left of the label.
        self.assertGreaterEqual(early['lit'], 10, early)
        self.assertLess(early['sweep'], 0.2, early)
        self.assertLess(early['reach'], px(width, 40), early)
        # ~25 %: the band crosses the button (ease-in-out from 6 % to 50 %), sparks fly out.
        self.assertTrue(0 < crossing['sweep'] < 1, crossing)
        self.assertEqual(crossing['lit'], 14, crossing)
        # ~40 %: the band is leaving the button, all sparks still out.
        self.assertGreater(middle['sweep'], 0.8, middle)
        self.assertEqual(middle['lit'], 14, middle)
        self.assertGreater(middle['reach'], crossing['reach'], (crossing, middle))
        # ~60 %: sparks near their 60-120 pt reach and fading (55-70 %), the band has left.
        self.assertGreater(late['reach'], px(width, 45), late)
        self.assertLessEqual(late['reach'], px(width, 140), late)
        self.assertGreaterEqual(late['sweep'], 1, late)
        ui.assert_no_overflow(page, width)
        return frames

    def test_start_and_dining_choice_in_three_locales_and_sizes(self):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        report = {}
        for width, height in SIZES:
            with self.subTest(width=width, height=height, motion='reduce'):
                page = self.page_for(width, height, motion=False)
                for value in ['ru', 'kk', 'en']:
                    self.locale(page, value)
                    settle(page)
                    # Reduced motion: scale 1, no sweep band, no sparks.
                    state = page.evaluate('() => {' + STATE + 'return salute(); }')
                    self.assertEqual((state['sparks'], state['sweep']), (0, None), state)
                    self.assertIn(state['spring'], ('none', 'matrix(1, 0, 0, 1, 0, 0)'), state)
                    report[f'start-{value}-{width}'] = self.check_start(page, width, height, value)
                    shoot(page, f'start-{value}-{width}.jpg')
                ui.element(page, 'kiosk-start').click()
                ui.screen(page, 'mode')
                for value in ['en', 'kk', 'ru']:
                    self.locale(page, value)
                    settle(page)
                    report[f'mode-{value}-{width}'] = self.check_mode(page, width, height, value)
                    shoot(page, f'mode-{value}-{width}.jpg')
            for value in ['ru', 'kk', 'en'] if width == 1024 else ['ru']:
                with self.subTest(width=width, height=height, motion='salute', locale=value):
                    report[f'salute-{value}-{width}'] = self.salute(width, height, value)
        (OUTPUT / 'redesign-start.json').write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    # Inherited helpers include the full suite: select only this bounded check.
    unittest.main(defaultTest='RedesignStart.test_start_and_dining_choice_in_three_locales_and_sizes',
                  verbosity=2)
