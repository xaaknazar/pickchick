"""Attract CTA caption in three languages on the exported kiosk web UI (owner decision 2026-10-11).

Run after exporting apps/kiosk, with the same environment as browser_ui.py. The caption turns
KZ -> RU -> EN every 2.4 s; the accessible name and the order language follow the language
switch; a chosen language or Reduce Motion stops the caption. Local API fixture only.
"""
import unittest

from playwright.sync_api import expect

import browser_ui as ui

CAPTIONS = {'kk': 'ТАПСЫРЫС БЕРУ', 'ru': 'СДЕЛАТЬ ЗАКАЗ', 'en': 'ORDER NOW'}


def caption(page):
    return ui.element(page, 'kiosk-start-caption')


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
        expect(caption(page)).to_have_text(CAPTIONS['ru'], timeout=3500)
        expect(caption(page)).to_have_text(CAPTIONS['en'], timeout=3500)
        expect(caption(page)).to_have_text(CAPTIONS['kk'], timeout=3500)
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

    def test_reduce_motion_keeps_the_switch_language(self):
        page, _ = self.open()
        expect(caption(page)).to_have_text(CAPTIONS['ru'])
        page.wait_for_timeout(5200)
        expect(caption(page)).to_have_text(CAPTIONS['ru'])


if __name__ == '__main__':
    # Inherited helpers include the full suite: select only the CTA checks.
    unittest.main(defaultTest=[
        'WelcomeCta.test_caption_turns_kz_ru_en_and_tap_uses_the_switch_language',
        'WelcomeCta.test_chosen_language_pins_the_caption',
        'WelcomeCta.test_reduce_motion_keeps_the_switch_language',
    ], verbosity=2)
