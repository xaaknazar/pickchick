"""Owner polish 14 Oct: foreground photography, no help controls, legible quantities.

Uses local fixture only. Does not create a live order, invoice or payable QR.
"""
import unittest
from playwright.sync_api import expect
import browser_ui as ui
from browser_redesign_upsell import SmartUpsell, FINGERS, SIZES


class GlassPolish(SmartUpsell):
    def assert_no_help(self, page):
        expect(page.locator('[data-testid$="-help"]')).to_have_count(0)
        expect(page.get_by_role('button', name='Позвать сотрудника', exact=True)).to_have_count(0)

    def test_photography_and_quantity_controls_on_three_ipads(self):
        for width, height in SIZES:
            with self.subTest(width=width):
                page, fixture = self.upsell(FINGERS, width, height)
                self.assert_no_help(page)
                hero = ui.element(page, 'kiosk-upsell-hero')
                expect(hero).to_be_in_viewport()
                ui.capture(page, f'glass-upsell-top-{width}.png')
                sauce = ui.element(page, 'kiosk-upsell-tile-sauce')
                sauce.scroll_into_view_if_needed()
                # Product image has its own normal compositing layer, never multiply.
                photos = sauce.locator('img').filter(visible=True)
                self.assertTrue(photos.count())
                self.assertEqual(sauce.evaluate('''e => [...e.querySelectorAll('*')]
                    .filter(n => getComputedStyle(n).mixBlendMode === 'multiply').length'''), 0)
                self.sheet_add(page, 'sauce')
                minus = ui.element(page, 'kiosk-upsell-minus-sauce')
                minus.scroll_into_view_if_needed()
                expect(minus).to_be_enabled()
                box = minus.bounding_box()
                self.assertGreaterEqual(min(box['width'], box['height']), 44)
                self.assertNotEqual(minus.evaluate('e => getComputedStyle(e).backgroundColor'), 'rgb(255, 255, 255)')
                expect(ui.element(page, 'kiosk-upsell-quantity-sauce')).to_have_text('1')
                minus.click()
                expect(ui.element(page, 'kiosk-upsell-quantity-sauce')).to_have_text('0')
                self.assertEqual(len(fixture.orders), 0)


if __name__ == '__main__':
    unittest.main(defaultTest='GlassPolish.test_photography_and_quantity_controls_on_three_ipads', verbosity=2)
