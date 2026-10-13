"""Simple products open as a sheet over the menu (kiosk redesign 2026-10-13, §3 of
docs/design/kiosk-redesign-2026-10-13/product-and-payment.md) against the exported web UI.

Run after exporting apps/kiosk, with the same environment as browser_ui.py (local preview
server, KIOSK_UI_URL). Every API request is answered by browser_ui.Fixture; no order is
created and nothing leaves the machine. The fixture catalog has a sauce with sizes (Соус
фирменный: 60 мл, 0,3 л, 0,4 л, 0,5 л), so the size sheet is the sauce itself. Screenshots of
the sauce sheet (with sizes) and the toast sheet (no choice) at 1024x1366, 820x1180 and
744x1133, Kazakh and English at 1024, go to KIOSK_REDESIGN_OUTPUT for comparison with
images/product-sauce-sheet.webp and images/product-simple-sheet.webp.
"""
import os
import unittest
from pathlib import Path

from playwright.sync_api import expect

import browser_ui as ui
from browser_redesign_menu import clipped, many_drinks

ui.OUTPUT = Path(os.environ.get('KIOSK_REDESIGN_OUTPUT', '.local/kiosk-redesign-sheet'))
SIZES = [(1024, 1366), (820, 1180), (744, 1133)]
SAUCE_SIZES = ['size-0', 'size-1', 'size-2', 'size-3']


def scale(width):
    return min(1.08, max(.8, width / 1024))


class ProductSheet(ui.KioskUI):
    def open_with(self, width, height, catalog=None):
        context = self.browser.new_context(viewport={'width': width, 'height': height},
                                           reduced_motion='reduce')
        fixture = ui.Fixture(catalog or self.catalog)
        context.route('**/*', fixture.route)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        self.contexts.append((context, page, fixture, errors))
        page.goto(ui.URL)
        ui.screen(page, 'welcome')
        return page, fixture

    def sheet(self, page, category, product_id):
        ui.element(page, 'kiosk-category-' + category).click()
        card = ui.element(page, 'kiosk-product-' + product_id)
        card.scroll_into_view_if_needed()
        card.click()
        sheet = ui.element(page, 'kiosk-product-sheet')
        expect(sheet).to_be_visible()
        # Over the menu, not the product page.
        ui.screen(page, 'menu')
        self.assertEqual(page.get_by_test_id('kiosk-screen-product').count(), 0)
        return sheet

    def check_layout(self, page, width, height):
        ui.assert_no_overflow(page, width)
        sheet = ui.element(page, 'kiosk-product-sheet').bounding_box()
        self.assertAlmostEqual(sheet['y'] + sheet['height'], height, delta=1.5)
        self.assertAlmostEqual(sheet['width'], width, delta=1)
        self.assertGreater(sheet['y'], 120 * scale(width), 'the menu header stays visible above')
        for identifier in ['kiosk-sheet-close', 'kiosk-sheet-minus', 'kiosk-sheet-plus',
                           'kiosk-sheet-add', 'kiosk-sheet-name']:
            rect = ui.assert_bounded(page, identifier, width, height, minimum=20)
            self.assertGreaterEqual(rect['y'], sheet['y'] - 1, identifier)
        add = ui.element(page, 'kiosk-sheet-add').bounding_box()
        self.assertGreaterEqual(add['height'], 96 * scale(width) - 1)
        descriptions = {p['description'] for p in self.catalog['products']}
        cut = clipped(page, '[data-testid="kiosk-product-sheet"]', descriptions)
        for _ in range(10):
            if not cut:
                break
            page.wait_for_timeout(200)
            cut = clipped(page, '[data-testid="kiosk-product-sheet"]', descriptions)
        self.assertEqual(cut, [], 'a text of the sheet is cut')
        return sheet

    def test_sauce_sheet_with_sizes_on_three_ipads(self):
        for width, height in SIZES:
            with self.subTest(width=width):
                page, fixture = self.open_with(width, height)
                self.start(page)
                self.sheet(page, 'extras', 'sauce')
                expect(ui.element(page, 'kiosk-sheet-name')).to_have_text('Соус фирменный')
                expect(ui.element(page, 'kiosk-sheet-facts')).to_contain_text('60 г · 230 ккал ·')
                expect(ui.element(page, 'kiosk-sheet-kbju')).to_have_text('КБЖУ')
                tiles = [ui.element(page, 'kiosk-sheet-size-' + option) for option in SAUCE_SIZES]
                for tile in tiles:
                    expect(tile).to_be_visible()
                expect(tiles[0]).to_have_attribute('aria-checked', 'true')
                expect(tiles[0]).to_contain_text('60 мл')
                expect(tiles[0]).to_contain_text('390 ₸')
                expect(tiles[1]).to_contain_text('1 190 ₸')
                rows = {round(tile.bounding_box()['y']) for tile in tiles}
                self.assertEqual(len(rows), 1, 'the four sizes share one row')
                for tile in tiles:
                    self.assertAlmostEqual(tile.bounding_box()['height'], 96 * scale(width), delta=1.5)
                expect(ui.element(page, 'kiosk-sheet-add')).to_have_text('В корзину · 390 ₸')
                self.check_layout(page, width, height)
                ui.capture(page, f'sheet-sauce-{width}.png')
                # 0,3 л twice: the price follows the size and the quantity.
                tiles[1].click()
                expect(tiles[1]).to_have_attribute('aria-checked', 'true')
                expect(tiles[0]).to_have_attribute('aria-checked', 'false')
                expect(ui.element(page, 'kiosk-sheet-facts')).to_contain_text('0,3 л · 1150 ккал')
                ui.element(page, 'kiosk-sheet-plus').click()
                expect(ui.element(page, 'kiosk-sheet-quantity')).to_have_text('2')
                expect(ui.element(page, 'kiosk-sheet-add')).to_have_text('В корзину · 2 380 ₸')
                if width == 1024:
                    ui.capture(page, f'sheet-sauce-0.3-x2-{width}.png')
                ui.element(page, 'kiosk-sheet-add').click()
                expect(ui.element(page, 'kiosk-product-sheet')).to_have_count(0)
                ui.screen(page, 'menu')
                # The same line the product page puts in the cart: one unit of the size, twice.
                cart = ui.stored(page, ui.FLOW_KEY)['cart']
                self.assertEqual(cart, [{'productId': 'sauce', 'quantity': 2, 'selections': [
                    {'group_id': 'size', 'option_id': 'size-1', 'quantity': 1}]}])
                expect(ui.element(page, 'kiosk-cart-bar')).to_contain_text('2 380')
                expect(ui.element(page, 'kiosk-toast')).to_contain_text('Соус фирменный')
                self.assertFalse(ui.element(page, 'kiosk-menu-checkout').is_disabled())
                self.assertEqual(len(fixture.orders), 0)
                self.assertEqual(len(fixture.sessions), 0)

    def test_toast_sheet_without_choice_on_three_ipads(self):
        for width, height in SIZES:
            with self.subTest(width=width):
                page, fixture = self.open_with(width, height)
                self.start(page)
                self.sheet(page, 'extras', 'toast')
                expect(ui.element(page, 'kiosk-sheet-name')).to_have_text('Тост, 1 шт')
                expect(ui.element(page, 'kiosk-sheet-facts')).to_contain_text('40 г · 150 ккал ·')
                self.assertEqual(page.locator('[data-testid^="kiosk-sheet-size-"]').count(), 0)
                expect(ui.element(page, 'kiosk-sheet-add')).to_have_text('В корзину · 390 ₸')
                expect(ui.element(page, 'kiosk-sheet-minus')).to_be_disabled()
                self.check_layout(page, width, height)
                ui.capture(page, f'sheet-toast-{width}.png')
                if width == 1024:
                    # «КБЖУ» opens the protein, fat and carbs line.
                    ui.element(page, 'kiosk-sheet-kbju').click()
                    expect(ui.element(page, 'kiosk-sheet-macros')).to_have_text(
                        'Белки 4 г · Жиры 7 г · Углеводы 18 г')
                    self.check_layout(page, width, height)
                    ui.capture(page, f'sheet-toast-kbju-{width}.png')
                ui.element(page, 'kiosk-sheet-add').click()
                expect(ui.element(page, 'kiosk-product-sheet')).to_have_count(0)
                cart = ui.stored(page, ui.FLOW_KEY)['cart']
                self.assertEqual(cart, [{'productId': 'toast', 'quantity': 1, 'selections': []}])
                expect(ui.element(page, 'kiosk-cart-bar')).to_contain_text('390')
                # A second add from the sheet grows the same line, as on the product page.
                self.sheet(page, 'extras', 'toast')
                ui.element(page, 'kiosk-sheet-plus').click()
                ui.element(page, 'kiosk-sheet-add').click()
                expect(ui.element(page, 'kiosk-product-sheet')).to_have_count(0)
                cart = ui.stored(page, ui.FLOW_KEY)['cart']
                self.assertEqual(cart, [{'productId': 'toast', 'quantity': 3, 'selections': []}])
                expect(ui.element(page, 'kiosk-cart-bar')).to_contain_text('1 170')
                self.assertEqual(len(fixture.orders), 0)

    def test_kazakh_and_english_at_1024(self):
        width, height = 1024, 1366
        for lang, size_title, add in [('kk', 'Өлшемі', 'Себетке · 390 ₸'),
                                      ('en', 'Size', 'Add to cart · 390 ₸')]:
            with self.subTest(lang=lang):
                page, fixture = self.open_with(width, height)
                self.start(page)
                ui.element(page, 'kiosk-language-' + lang).click()
                sheet = self.sheet(page, 'extras', 'sauce')
                expect(sheet).to_contain_text(size_title)
                expect(ui.element(page, 'kiosk-sheet-add')).to_have_text(add)
                self.check_layout(page, width, height)
                ui.capture(page, f'sheet-sauce-{lang}-{width}.png')
                ui.element(page, 'kiosk-sheet-close').click()
                expect(ui.element(page, 'kiosk-product-sheet')).to_have_count(0)
                self.sheet(page, 'extras', 'toast')
                expect(ui.element(page, 'kiosk-sheet-add')).to_have_text(add)
                ui.element(page, 'kiosk-sheet-kbju').click()
                self.check_layout(page, width, height)
                ui.capture(page, f'sheet-toast-{lang}-{width}.png')
                self.assertEqual(ui.stored(page, ui.FLOW_KEY)['cart'], [])
                self.assertEqual(len(fixture.orders), 0)

    def test_closing_keeps_the_menu_and_combos_keep_the_product_page(self):
        catalog = many_drinks(self.catalog)
        page, fixture = self.open_with(820, 1180, catalog)
        self.start(page)
        ui.element(page, 'kiosk-category-drinks').click()
        last = catalog['products'][-1]['id']
        card = ui.element(page, 'kiosk-product-' + last)
        card.scroll_into_view_if_needed()
        offset = ui.element(page, 'kiosk-menu-scroll').evaluate('(e) => e.scrollTop')
        self.assertGreater(offset, 300, 'a scrolled section')
        card.click()
        expect(ui.element(page, 'kiosk-product-sheet')).to_be_visible()
        ui.capture(page, 'sheet-drink-over-scrolled-menu-820.png')
        # ✕ closes it; the dimmed menu (outside the sheet) closes it too.
        ui.element(page, 'kiosk-sheet-close').click()
        expect(ui.element(page, 'kiosk-product-sheet')).to_have_count(0)
        self.assertEqual(ui.element(page, 'kiosk-menu-scroll').evaluate('(e) => e.scrollTop'), offset)
        card.click()
        expect(ui.element(page, 'kiosk-product-sheet')).to_be_visible()
        ui.element(page, 'kiosk-sheet-scrim').click(position={'x': 400, 'y': 200})
        expect(ui.element(page, 'kiosk-product-sheet')).to_have_count(0)
        expect(ui.element(page, 'kiosk-category-drinks')).to_have_attribute('aria-selected', 'true')
        self.assertEqual(ui.stored(page, ui.FLOW_KEY)['cart'], [])
        # «+» on a drink without a choice still adds at once.
        ui.element(page, 'kiosk-product-plus-cola').click()
        expect(ui.element(page, 'kiosk-cart-bar')).to_contain_text('990')
        self.assertEqual(page.get_by_test_id('kiosk-product-sheet').count(), 0)
        # «+» on the sauce (a size to choose) opens the sheet rather than adding blindly.
        ui.element(page, 'kiosk-category-extras').click()
        ui.element(page, 'kiosk-product-plus-sauce').click()
        expect(ui.element(page, 'kiosk-product-sheet')).to_be_visible()
        ui.element(page, 'kiosk-sheet-close').click()
        # Combos keep their product page.
        ui.element(page, 'kiosk-category-combo').click()
        ui.element(page, 'kiosk-product-pick-combo').click()
        ui.screen(page, 'product')
        self.assertEqual(page.get_by_test_id('kiosk-product-sheet').count(), 0)
        self.assertEqual(len(fixture.orders), 0)


if __name__ == '__main__':
    # Inherited helpers include the full browser_ui suite: run only the sheet checks.
    unittest.main(defaultTest=[f'ProductSheet.{name}' for name in vars(ProductSheet)
                               if name.startswith('test_')], verbosity=2)
