"""Attract CTA caption in three languages on the exported kiosk web UI (owner decision 2026-10-11).

Run after exporting apps/kiosk, with the same environment as browser_ui.py. The caption turns
KZ -> RU -> EN every 2.4 s; the accessible name and the order language follow the language
switch; a chosen language or Reduce Motion stops the caption. Whenever a language is chosen,
also in the middle of a flip, exactly one caption stays visible. Local API fixture only.
"""
import unittest

from playwright.sync_api import expect

import browser_ui as ui

CAPTIONS = {'kk': 'ТАПСЫРЫС БЕРУ', 'ru': 'СДЕЛАТЬ ЗАКАЗ', 'en': 'ORDER NOW'}

# Build 16 (iPad): a language chosen on the attract screen left other captions on the button.
# (language to tap, flips to wait for, ms after the flip starts). The first flip is KZ -> RU,
# the second RU -> EN; 40-200 ms lands inside the 280 ms flip, 1000 ms at rest. Tapping the
# language that is flipping in stops the rotation without changing the shown language.
PIN_MOMENTS = [
    ('ru', 1, 40), ('ru', 1, 120), ('ru', 1, 1000),
    ('kk', 1, 40), ('kk', 1, 200), ('kk', 1, 1000),
    ('en', 2, 60), ('en', 2, 150), ('en', 1, 1000),
]

# Resolves once the shown caption has changed `flips` times; remembers when for the tap phase.
AFTER_FLIPS = '''async (flips) => {
    const shown = () => [...document.querySelectorAll('[data-testid="kiosk-start-caption"]')]
        .find((e) => e.getClientRects().length)?.textContent;
    let last = shown();
    for (let seen = 0; seen < flips;) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const now = shown();
        if (now !== last) { seen += 1; last = now; }
    }
    window.__flipAt = performance.now();
    window.__tapAt = null;
    addEventListener('pointerdown', () => { window.__tapAt ??= performance.now(); },
                     {capture: true, once: true});
}'''

# Every caption on the button: text, opacity and offset from the caption box.
CAPTION_STATE = '''() => {
    const shown = [...document.querySelectorAll('[data-testid="kiosk-start-caption"]')]
        .find((e) => e.getClientRects().length);
    const box = shown.parentElement.getBoundingClientRect();
    return {
        shown: shown.textContent,
        phase: window.__tapAt == null ? null : Math.round(window.__tapAt - window.__flipAt),
        captions: [...shown.parentElement.children].map((e) => ({
            text: e.textContent,
            opacity: parseFloat(getComputedStyle(e).opacity),
            top: Math.round(e.getBoundingClientRect().top - box.top),
        })),
    };
}'''


def caption(page):
    return ui.element(page, 'kiosk-start-caption')


def lit_captions(page):
    """The page state and the captions a guest can see (opacity above .05)."""
    state = page.evaluate(CAPTION_STATE)
    return state, [c for c in state['captions'] if c['opacity'] > 0.05]


class WelcomeCta(ui.KioskUI):
    def open_moving(self):
        page, fixture = self.open()
        page.emulate_media(reduced_motion='no-preference')
        page.reload()
        ui.screen(page, 'welcome')
        return page, fixture

    def test_caption_turns_kz_ru_en_and_tap_uses_the_switch_language(self):
        page, fixture = self.open_moving()
        expect(caption(page)).to_have_text(CAPTIONS['kk'])
        for locale in ('ru', 'en', 'kk'):
            expect(caption(page)).to_have_text(CAPTIONS[locale], timeout=3500)
            # Once the 280 ms flip is over only the new caption is left, in place.
            page.wait_for_timeout(400)
            self.assert_only_caption(page, locale)
        # The button always names the switch language (Russian by default).
        expect(ui.element(page, 'kiosk-start')).to_have_attribute('aria-label', CAPTIONS['ru'])
        # Tapping while the caption shows KZ still starts the order in Russian.
        ui.element(page, 'kiosk-start').click()
        ui.screen(page, 'mode')
        expect(page.get_by_text('Как будете есть?', exact=False).first).to_be_visible()
        self.assertEqual(len(fixture.orders), 0)

    def test_chosen_language_pins_the_caption(self):
        page, _ = self.open_moving()
        page.get_by_role('button', name='EN - English').first.click()
        expect(caption(page)).to_have_text(CAPTIONS['en'])
        expect(ui.element(page, 'kiosk-start')).to_have_attribute('aria-label', CAPTIONS['en'])
        page.wait_for_timeout(5200)
        expect(caption(page)).to_have_text(CAPTIONS['en'])
        self.assert_only_caption(page, 'en')

    def assert_only_caption(self, page, locale):
        state, lit = lit_captions(page)
        self.assertEqual(len(state['captions']), 3, state)
        self.assertEqual([c['text'] for c in lit], [CAPTIONS[locale]], state)
        self.assertEqual(lit[0]['opacity'], 1, state)
        self.assertLessEqual(abs(lit[0]['top']), 1, state)
        self.assertEqual(state['shown'], CAPTIONS[locale], state)

    def test_any_moment_of_the_rotation_pins_exactly_one_caption(self):
        page, _ = self.open_moving()
        for locale, flips, delay in PIN_MOMENTS:
            with self.subTest(locale=locale, flips=flips, delay=delay):
                page.reload()
                ui.screen(page, 'welcome')
                target = ui.element(page, 'kiosk-language-' + locale)
                expect(target).to_be_visible()
                box = target.bounding_box()
                page.evaluate(AFTER_FLIPS, flips)
                page.wait_for_timeout(delay)
                page.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
                # Right after the tap, once the flip would have ended and past the next step.
                for wait in (150, 400, 2600):
                    page.wait_for_timeout(wait)
                    self.assert_only_caption(page, locale)
                phase = lit_captions(page)[0]['phase']
                print(f'  pinned {locale} {phase} ms after flip {flips} starts', flush=True)
                expect(ui.element(page, 'kiosk-start')).to_have_attribute(
                    'aria-label', CAPTIONS[locale])

    def test_reduce_motion_keeps_the_switch_language(self):
        page, _ = self.open()
        expect(caption(page)).to_have_text(CAPTIONS['ru'])
        self.assert_only_caption(page, 'ru')
        page.wait_for_timeout(5200)
        expect(caption(page)).to_have_text(CAPTIONS['ru'])
        self.assert_only_caption(page, 'ru')
        # Reduce Motion: a chosen language replaces the caption at once, alone.
        ui.element(page, 'kiosk-language-kk').click()
        expect(caption(page)).to_have_text(CAPTIONS['kk'])
        self.assert_only_caption(page, 'kk')


if __name__ == '__main__':
    # Inherited helpers include the full suite: select only the CTA checks.
    unittest.main(defaultTest=[
        'WelcomeCta.test_caption_turns_kz_ru_en_and_tap_uses_the_switch_language',
        'WelcomeCta.test_chosen_language_pins_the_caption',
        'WelcomeCta.test_any_moment_of_the_rotation_pins_exactly_one_caption',
        'WelcomeCta.test_reduce_motion_keeps_the_switch_language',
    ], verbosity=2)
