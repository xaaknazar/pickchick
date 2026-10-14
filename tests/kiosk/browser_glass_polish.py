"""Owner polish 14 Oct: foreground photography, no help controls, legible quantities.

Uses local fixture only. Does not create a live order, invoice or payable QR.
"""
import unittest
from playwright.sync_api import expect
import browser_ui as ui
from browser_redesign_upsell import SmartUpsell, FINGERS, SIZES


class GlassPolish(SmartUpsell):
    def test_sauce_cups_have_equal_visible_size(self):
        for width, height in SIZES:
            with self.subTest(width=width):
                page, fixture = self.open(width, height)
                self.start(page)
                ui.element(page, 'kiosk-product-pick-combo').click()
                ui.screen(page, 'product')
                boxes = []
                for sauce in ['pick', 'hot', 'cheese', 'bbq']:
                    photo = ui.element(page, 'kiosk-photo-option-' + sauce)
                    page.wait_for_function('''id => {
                        const image = document.querySelector(`[data-testid="${id}"] img`);
                        return image?.complete && image.naturalWidth > 0;
                    }''', arg='kiosk-photo-option-' + sauce)
                    boxes.append(photo.locator('img').evaluate('''image => {
                        const canvas = document.createElement('canvas');
                        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
                        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
                        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                        let left = canvas.width, right = 0, top = canvas.height, bottom = 0;
                        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
                            if (pixels[(y * canvas.width + x) * 4 + 3] < 64) continue;
                            left = Math.min(left, x); right = Math.max(right, x + 1);
                            top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
                        }
                        const r = image.getBoundingClientRect(), scale = r.width / canvas.width;
                        return {width: (right-left)*scale, height: (bottom-top)*scale,
                            centerY: r.y + (top+bottom)/2*scale};
                    }'''))
                for key, tolerance in [('width', 1), ('height', 2), ('centerY', 1)]:
                    values = [box[key] for box in boxes]
                    self.assertLess(max(values) - min(values), tolerance, (key, boxes))
                ui.capture(page, f'glass-equal-sauces-{width}.png')
                self.assertEqual(len(fixture.orders), 0)

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
    unittest.main(defaultTest=[
        'GlassPolish.test_photography_and_quantity_controls_on_three_ipads',
        'GlassPolish.test_sauce_cups_have_equal_visible_size',
    ], verbosity=2)
