"""Product card and drinks sheet of the kiosk redesign 2026-10-13 against the exported web UI.

Run after exporting apps/kiosk, with the same environment as browser_ui.py (local preview
server, KIOSK_UI_URL). Every API request is answered by browser_ui.Fixture; no order is
created. Screenshots of Pick Combo (default, with the lemonade +200 picked) and of the drinks
sheet at 1024x1366, 820x1180 and 744x1133, Kazakh and English at 1024, the card with a missing
sauce and a combo with three sections are written to KIOSK_REDESIGN_OUTPUT for comparison with
docs/design/kiosk-redesign-2026-10-13/images/product-combo.webp and product-drinks-sheet.webp.
"""
import copy
import os
import unittest
from pathlib import Path

from playwright.sync_api import expect

import browser_ui as ui
from browser_redesign_menu import clipped

ui.OUTPUT = Path(os.environ.get('KIOSK_REDESIGN_OUTPUT', '.local/kiosk-redesign-product'))
SIZES = [(1024, 1366), (820, 1180), (744, 1133)]
NBSP = '\u00a0'


def scale(width):
    return min(1.08, max(.8, width / 1024))


def text_of(locator):
    return locator.inner_text().replace(NBSP, ' ')


class RedesignProduct(ui.KioskUI):
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

    def open_product(self, page, product_id='pick-combo', lang=None):
        self.start(page)
        if lang:
            ui.element(page, 'kiosk-language-' + lang).click()
        ui.element(page, 'kiosk-product-' + product_id).click()
        ui.screen(page, 'product')
        page.evaluate('() => document.fonts.ready')

    def assert_texts_fit(self, page, root):
        # Names step down after layout and font load; give them a moment to settle.
        cut = clipped(page, root)
        for _ in range(10):
            if not cut:
                break
            page.wait_for_timeout(200)
            cut = clipped(page, root)
        self.assertEqual(cut, [], 'a text is cut')

    def check_card(self, page, width, height, price, scrolls=False):
        s = scale(width)
        ui.assert_no_overflow(page, width)
        scroller = ui.element(page, 'kiosk-product-scroll')
        self.assertEqual(scroller.evaluate('(e) => e.scrollHeight > e.clientHeight + 1'), scrolls,
                         f'Pick Combo fits one {width}x{height} screen' if not scrolls else 'scrolls')
        add = ui.assert_bounded(page, 'kiosk-product-add', width, height)
        self.assertGreaterEqual(add['height'], 52)
        # The price with surcharges and quantity, in full (never cut by an ellipsis).
        self.assertIn(' · ' + price, text_of(ui.element(page, 'kiosk-product-add')))
        for control in ['kiosk-product-close', 'kiosk-product-help', 'kiosk-product-decrement',
                        'kiosk-product-increment', 'kiosk-product-details-open']:
            ui.assert_bounded(page, control, width, height, minimum=28)
        hero = ui.assert_bounded(page, 'kiosk-product-hero', width, height)
        self.assertLessEqual(abs(hero['y'] - 124 * s), 6, 'the hero starts at 124')
        self.assertGreaterEqual(hero['height'], 380 * s - 2)
        self.assertLessEqual(abs(hero['x'] - 16 * s), 2)
        self.assertLessEqual(abs(width - hero['x'] - hero['width'] - 16 * s), 2)
        if not scrolls:
            # Every tile stays above the glass panel.
            limit = page.get_by_test_id('kiosk-product-decrement').bounding_box()['y'] - 12 * s
            for tile in page.locator('[data-testid^="kiosk-modifier-"]').all():
                if not tile.is_visible():
                    continue
                box = tile.bounding_box()
                self.assertLessEqual(box['y'] + box['height'], limit, tile.get_attribute('data-testid'))
        self.assert_texts_fit(page, '[data-testid="kiosk-screen-product"]')

    def check_drinks_grid(self, page, width, shown_last):
        s = scale(width)
        section = ui.element(page, 'kiosk-section-drink')
        tiles = [t for t in section.locator('[data-testid^="kiosk-modifier-drink-"]').all()
                 if t.is_visible()]
        more = ui.element(page, 'kiosk-modifier-expand-drink')
        boxes = [t.bounding_box() for t in tiles] + [more.bounding_box()]
        self.assertEqual(len(boxes), 10, 'nine drinks and the «Ещё» tile')
        rows = sorted({round(b['y']) for b in boxes})
        self.assertEqual(len(rows), 2, 'two rows')
        for b in boxes:
            self.assertLessEqual(abs(b['height'] - 172 * s), 2, 'drink tiles are 172 high')
        self.assertEqual(sum(1 for b in boxes if round(b['y']) == rows[0]), 5, 'five across')
        self.assertEqual(tiles[-1].get_attribute('data-testid'), 'kiosk-modifier-drink-' + shown_last)
        expect(more).to_contain_text('Ещё 5')
        sauces = [t for t in ui.element(page, 'kiosk-section-sauce').locator(
            '[data-testid^="kiosk-modifier-sauce-"]').all() if t.is_visible()]
        self.assertEqual(len(sauces), 4)
        self.assertEqual(len({round(t.bounding_box()['y']) for t in sauces}), 1, 'four in a row')
        for t in sauces:
            self.assertLessEqual(abs(t.bounding_box()['height'] - 164 * s), 2)
        self.assertEqual(ui.element(page, 'kiosk-modifier-sauce-bbq').get_attribute('aria-disabled'),
                         'true', 'a stopped sauce is not pressable')

    def test_pick_combo_lemonade_and_drinks_sheet_on_three_ipads(self):
        for width, height in SIZES:
            with self.subTest(width=width, height=height):
                page, fixture = self.open_with(width, height)
                self.open_product(page)
                expect(ui.element(page, 'kiosk-product-title')).to_have_text('Pick Combo')
                expect(ui.element(page, 'kiosk-product-caption')).to_have_text('Комбо · 520 г')
                expect(ui.element(page, 'kiosk-product-composition')).to_have_attribute(
                    'aria-label', '4 фингерса, фри, соус, тост, коулслоу, напиток')
                self.assertIn('520 г · 1240 ккал', text_of(ui.element(page, 'kiosk-product-nutrition')))
                expect(ui.element(page, 'kiosk-product-hero')).to_contain_text('ХИТ НЕДЕЛИ')
                # The KBJU tiles and the «Добавить к заказу» list left the card.
                self.assertEqual(page.get_by_test_id('kiosk-modifier-plus-extras-toast').count(), 0)
                self.assertEqual(page.get_by_text('Добавить к заказу').count(), 0)
                self.assertEqual(page.get_by_text('Белки').count(), 0)
                expect(ui.element(page, 'kiosk-product-status')).to_have_text('Всё выбрано')
                self.assertEqual(text_of(ui.element(page, 'kiosk-product-summary')),
                                 'Coca-Cola 0.5 л · Фирменный соус')
                self.assertIn('Coca-Cola 0.5 л', text_of(ui.element(page, 'kiosk-section-value-drink')))
                self.check_card(page, width, height, '4 190 ₸')
                self.check_drinks_grid(page, width, 'iced-tea-unsweet')
                ui.capture(page, f'product-combo-{width}.png')

                ui.element(page, 'kiosk-modifier-drink-lemonade').click()
                expect(ui.element(page, 'kiosk-modifier-drink-lemonade')).to_have_attribute(
                    'aria-checked', 'true')
                self.assertIn('Лимонад 0.5 л +200 ₸', text_of(ui.element(page, 'kiosk-section-value-drink')))
                self.assertEqual(text_of(ui.element(page, 'kiosk-product-summary')),
                                 'Лимонад 0.5 л · Фирменный соус')
                self.check_card(page, width, height, '4 390 ₸')
                ui.capture(page, f'product-combo-lemonade-{width}.png')
                ui.element(page, 'kiosk-product-increment').click()
                expect(ui.element(page, 'kiosk-product-quantity')).to_have_text('2')
                self.assertIn('8 780 ₸', text_of(ui.element(page, 'kiosk-product-add')))
                ui.element(page, 'kiosk-product-decrement').click()
                self.assertIn('4 390 ₸', text_of(ui.element(page, 'kiosk-product-add')))

                ui.element(page, 'kiosk-modifier-expand-drink').click()
                sheet = ui.element(page, 'kiosk-drinks-sheet')
                expect(sheet).to_be_visible()
                box = sheet.bounding_box()
                self.assertLessEqual(abs(box['y'] + box['height'] - height), 1, 'a bottom sheet')
                self.assertLessEqual(box['height'], min(1110 * scale(width), height) + 1)
                self.assertGreater(box['height'], height * .75)
                for shelf in ['Газировка', 'Холодный чай', 'Лимонад, вода, сок']:
                    expect(sheet.get_by_role('heading', name=shelf, exact=True)).to_be_visible()
                expect(sheet).to_contain_text('Выберите напиток')
                expect(sheet).to_contain_text('Входит в Pick Combo')
                done = ui.element(page, 'kiosk-drinks-done')
                self.assertEqual(text_of(done).strip(), 'Готово · Лимонад 0.5 л +200 ₸')
                ui.assert_bounded(page, 'kiosk-drinks-done', width, height)
                ui.assert_bounded(page, 'kiosk-drinks-close', width, height)
                # Shelves: five across, the stopped Fuse Tea is shown but not pressable.
                lemonade = sheet.get_by_test_id('kiosk-modifier-drink-lemonade')
                expect(lemonade).to_have_attribute('aria-checked', 'true')
                self.assertEqual(sheet.get_by_test_id('kiosk-modifier-drink-fuse-watermelon')
                                 .get_attribute('aria-disabled'), 'true')
                soda = [sheet.get_by_test_id('kiosk-modifier-drink-' + i).bounding_box()
                        for i in ['cola-bottle', 'cola-can', 'fanta', 'sprite', 'cola-zero']]
                self.assertEqual(len({round(b['y']) for b in soda}), 1)
                self.assert_texts_fit(page, '[data-testid="kiosk-drinks-sheet"]')
                ui.capture(page, f'product-drinks-sheet-{width}.png')
                # A pick in the sheet updates the card at once; «Готово» closes the sheet.
                piko = sheet.get_by_test_id('kiosk-modifier-drink-piko')
                piko.scroll_into_view_if_needed()
                expect(piko).to_be_in_viewport()
                piko.click()
                self.assertEqual(text_of(done).strip(), 'Готово · Piko 0.2 л')
                done.click()
                expect(sheet).not_to_be_visible()
                self.assertIn('Piko 0.2 л', text_of(ui.element(page, 'kiosk-section-value-drink')))
                self.check_drinks_grid(page, width, 'piko')
                self.check_card(page, width, height, '4 190 ₸')
                self.assertEqual(len(fixture.orders), 0)

    def test_languages_keep_names_whole(self):
        for width, height in [(1024, 1366), (744, 1133)]:
            for lang, status, add in [('kk', 'Бәрі таңдалды', 'Себетке'), ('en', 'All set', 'Add to cart')]:
                with self.subTest(width=width, lang=lang):
                    page, fixture = self.open_with(width, height)
                    self.open_product(page, lang=lang)
                    expect(ui.element(page, 'kiosk-product-status')).to_have_text(status)
                    self.assertIn(add + ' · 4 190 ₸', text_of(ui.element(page, 'kiosk-product-add')))
                    self.check_card(page, width, height, '4 190 ₸')
                    ui.element(page, 'kiosk-modifier-drink-lemonade').click()
                    self.check_card(page, width, height, '4 390 ₸')
                    if width == 1024:
                        ui.capture(page, f'product-combo-{lang}-{width}.png')
                    ui.element(page, 'kiosk-modifier-expand-drink').click()
                    expect(ui.element(page, 'kiosk-drinks-sheet')).to_be_visible()
                    self.assert_texts_fit(page, '[data-testid="kiosk-drinks-sheet"]')
                    if width == 1024:
                        ui.capture(page, f'product-drinks-sheet-{lang}-{width}.png')
                    ui.element(page, 'kiosk-drinks-close').click()
                    expect(ui.element(page, 'kiosk-drinks-sheet')).not_to_be_visible()
                    self.assertEqual(len(fixture.orders), 0)

    def test_missing_sauce_disables_the_cart_button(self):
        catalog = copy.deepcopy(self.catalog)
        product = next(p for p in catalog['products'] if p['id'] == 'pick-combo')
        sauce = next(g for g in product['modifier_groups'] if g['id'] == 'sauce')
        for option in sauce['options']:
            option['default_quantity'] = 0
        width, height = 1024, 1366
        page, fixture = self.open_with(width, height, catalog)
        self.open_product(page)
        expect(ui.element(page, 'kiosk-product-status')).to_have_text('Выберите соус')
        self.assertEqual(text_of(ui.element(page, 'kiosk-product-summary')), 'Coca-Cola 0.5 л')
        self.assertTrue(ui.element(page, 'kiosk-product-add').is_disabled())
        self.assertIn('Выберите соус', text_of(ui.element(page, 'kiosk-section-value-sauce')))
        ui.capture(page, f'product-combo-missing-sauce-{width}.png')
        ui.element(page, 'kiosk-modifier-sauce-hot').click()
        expect(ui.element(page, 'kiosk-product-status')).to_have_text('Всё выбрано')
        self.assertFalse(ui.element(page, 'kiosk-product-add').is_disabled())
        self.check_card(page, width, height, '4 190 ₸')
        ui.element(page, 'kiosk-product-add').click()
        ui.screen(page, 'menu')
        expect(ui.element(page, 'kiosk-cart-bar')).to_contain_text('4 190')
        self.assertEqual(len(fixture.orders), 0)

    def test_nutrition_sheet_opens_from_the_hero(self):
        page, fixture = self.open_with(820, 1180)
        self.open_product(page)
        ui.element(page, 'kiosk-product-details-open').click()
        details = ui.element(page, 'kiosk-product-details-sheet')
        expect(details).to_be_visible()
        expect(details).to_contain_text('1240')
        expect(details).to_contain_text('Белки')
        ui.capture(page, 'product-details-820.png')
        ui.element(page, 'kiosk-product-details-close').click()
        expect(details).not_to_be_visible()
        self.assertEqual(len(fixture.orders), 0)

    def test_other_combos_duos_and_sets_follow_the_scheme(self):
        cases = [('combo', 'master-combo', '5 490 ₸', ['drink', 'sauce']),
                 ('duo', 'finger-duo', '7 990 ₸', ['drink', 'sauce']),
                 ('sets', 'fingers-25', '13 990 ₸', ['sauce'])]
        # A size-only extra (the sauce) opens the sheet over the menu, not this page:
        # browser_redesign_sheet.py covers it.
        for width, height in [(1024, 1366), (744, 1133)]:
            for category, product_id, price, sections in cases:
                with self.subTest(width=width, product=product_id):
                    page, fixture = self.open_with(width, height)
                    self.start(page)
                    ui.element(page, 'kiosk-category-' + category).click()
                    ui.element(page, 'kiosk-product-' + product_id).click()
                    ui.screen(page, 'product')
                    for number, group in enumerate(sections, 1):
                        expect(ui.element(page, 'kiosk-section-' + group)).to_contain_text(str(number))
                    self.assertEqual(page.get_by_test_id('kiosk-section-extras').count(), 0)
                    expect(ui.element(page, 'kiosk-product-status')).to_have_text('Всё выбрано')
                    scrolls = ui.element(page, 'kiosk-product-scroll').evaluate(
                        '(e) => e.scrollHeight > e.clientHeight + 1')
                    self.check_card(page, width, height, price, scrolls=scrolls)
                    ui.capture(page, f'product-{product_id}-{width}.png')
                    self.assertEqual(len(fixture.orders), 0)

    def test_three_sections_scroll_under_the_fixed_panel(self):
        catalog = copy.deepcopy(self.catalog)
        product = next(p for p in catalog['products'] if p['id'] == 'pick-combo')
        sauce = next(g for g in product['modifier_groups'] if g['id'] == 'sauce')
        product['modifier_groups'].insert(2, {**copy.deepcopy(sauce), 'id': 'dip',
                                              'title': 'Второй соус на выбор'})
        for width, height in [(1024, 1366), (744, 1133)]:
            with self.subTest(width=width):
                page, fixture = self.open_with(width, height, catalog)
                self.open_product(page)
                expect(ui.element(page, 'kiosk-section-dip')).to_contain_text('Второй соус')
                self.check_card(page, width, height, '4 190 ₸', scrolls=True)
                ui.fixed_action(page, 'kiosk-product-add', 'kiosk-product-scroll', width, height)
                last = ui.element(page, 'kiosk-modifier-dip-cheese').bounding_box()
                bar = page.get_by_test_id('kiosk-product-decrement').bounding_box()
                self.assertLess(last['y'] + last['height'], bar['y'], 'the last section clears the panel')
                ui.capture(page, f'product-three-sections-end-{width}.png')
                self.assertEqual(len(fixture.orders), 0)


if __name__ == '__main__':
    # Inherited helpers include the full browser_ui suite: run only the product card checks.
    unittest.main(defaultTest=[
        'RedesignProduct.test_pick_combo_lemonade_and_drinks_sheet_on_three_ipads',
        'RedesignProduct.test_languages_keep_names_whole',
        'RedesignProduct.test_missing_sauce_disables_the_cart_button',
        'RedesignProduct.test_nutrition_sheet_opens_from_the_hero',
        'RedesignProduct.test_three_sections_scroll_under_the_fixed_panel',
        'RedesignProduct.test_other_combos_duos_and_sets_follow_the_scheme',
    ], verbosity=2)
