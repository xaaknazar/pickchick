"""Owner 2026-10-13: one caption in the selected language, never on a timer.

Runs against the isolated browser_ui fixture. No real ordering requests.
"""
import unittest
from playwright.sync_api import expect
import browser_ui as ui

CAPTIONS = {'kk': 'ТАПСЫРЫС БЕРУ', 'ru': 'СДЕЛАТЬ ЗАКАЗ', 'en': 'ORDER NOW'}

class WelcomeCta(ui.KioskUI):
    def assert_caption(self, page, locale):
        caption = ui.element(page, 'kiosk-start-caption')
        expect(caption).to_have_count(1)
        expect(caption).to_have_text(CAPTIONS[locale])
        expect(caption).to_be_visible()
        expect(ui.element(page, 'kiosk-start')).to_have_attribute('aria-label', CAPTIONS[locale])

    def test_caption_only_follows_language_with_and_without_motion(self):
        for motion in ('no-preference', 'reduce'):
            with self.subTest(motion=motion):
                page, fixture = self.open()
                page.emulate_media(reduced_motion=motion)
                page.reload()
                ui.screen(page, 'welcome')
                self.assert_caption(page, 'ru')
                for locale in ('kk', 'en', 'ru'):
                    ui.element(page, 'kiosk-language-' + locale).click()
                    self.assert_caption(page, locale)
                    page.wait_for_timeout(7400)
                    self.assert_caption(page, locale)
                self.assertEqual(len(fixture.orders), 0)

    def test_fast_language_changes_leave_one_caption_and_start_in_that_language(self):
        page, fixture = self.open()
        page.emulate_media(reduced_motion='no-preference')
        for locale in ('ru', 'en', 'kk', 'ru', 'kk', 'en'):
            ui.element(page, 'kiosk-language-' + locale).click()
            self.assert_caption(page, locale)
        ui.element(page, 'kiosk-start').click()
        ui.screen(page, 'mode')
        expect(page.get_by_text('Where will you eat?', exact=False).first).to_be_visible()
        self.assertEqual(len(fixture.orders), 0)

if __name__ == '__main__':
    unittest.main(defaultTest=[f'WelcomeCta.{name}' for name in vars(WelcomeCta)
                               if name.startswith('test_')], verbosity=2)
