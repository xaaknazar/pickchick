"""Bento menu of the kiosk redesign 2026-10-13 against the exported web UI.

Run after exporting apps/kiosk, with the same environment as browser_ui.py (local preview
server, KIOSK_UI_URL). Every API request is answered by browser_ui.Fixture; no order is
created. Screenshots of every section with two cart lines at 1024x1366, 820x1180 and
744x1133, Kazakh and English headers, a 19-drink section (scrolling) and the empty cart are
written to KIOSK_MENU_OUTPUT for comparison with
docs/design/kiosk-redesign-2026-10-13/images/menu-*.webp.
"""
import copy
import os
import unittest
from pathlib import Path

from playwright.sync_api import expect

import browser_ui as ui

ui.OUTPUT = Path(os.environ.get('KIOSK_MENU_OUTPUT', '.local/kiosk-redesign-menu'))
SIZES = [(1024, 1366), (820, 1180), (744, 1133)]
SECTIONS = ['combo', 'duo', 'sets', 'extras', 'drinks']
HITS = {'combo': 'master-combo', 'duo': 'finger-duo', 'sets': 'fingers-25',
        'extras': 'burger', 'drinks': 'lemonade'}


def grown(catalog, category, total):
    """A section grown to `total` products: copies of its fixture products under new ids."""
    result = copy.deepcopy(catalog)
    section = [p for p in result['products'] if p['category'] == category]
    extra = []
    while len(section) + len(extra) < total:
        base = section[len(extra) % len(section)]
        number = len(extra) + 1
        extra.append({**copy.deepcopy(base), 'id': f"{base['id']}-x{number}",
                      'name': f"{base['name']} #{number}"})
    result['products'] += extra
    return result


def many_drinks(catalog, total=19):
    """The live catalog grows to 19 drinks."""
    return grown(catalog, 'Напитки', total)


def clipped(page, selector, allowed=()):
    """Texts under `selector` cut by an ellipsis or a line clamp, except `allowed` (catalog
    descriptions are clamped to two lines by design)."""
    found = page.evaluate('''(selector) => [...document.querySelectorAll(selector)]
        .flatMap(root => [...root.querySelectorAll('div[dir="auto"], span')])
        .filter(e => {
            if (e.childElementCount || !e.textContent.trim() || !e.getBoundingClientRect().width)
                return false;
            const style = getComputedStyle(e);
            const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
            return e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + line * .5;
        })
        .map(e => e.textContent)''', selector)
    return [text for text in found if text not in allowed]


class RedesignMenu(ui.KioskUI):
    def open_with(self, width, height, catalog=None, reduced='reduce'):
        context = self.browser.new_context(viewport={'width': width, 'height': height},
                                           reduced_motion=reduced)
        fixture = ui.Fixture(catalog or self.catalog)
        context.route('**/*', fixture.route)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        self.contexts.append((context, page, fixture, errors))
        page.goto(ui.URL)
        ui.screen(page, 'welcome')
        return page, fixture

    def fill_cart(self, page):
        # Pick Combo has choices: its card opens the product page. Coca-Cola has none: "+" adds.
        self.add(page)
        ui.element(page, 'kiosk-category-drinks').click()
        ui.element(page, 'kiosk-product-plus-cola').click()
        expect(ui.element(page, 'kiosk-cart-feedback')).to_contain_text('Coca-Cola')
        expect(ui.element(page, 'kiosk-cart-bar')).to_contain_text('5 180')
        # The add toast (2.4 s) is not part of the compared layout.
        expect(page.get_by_test_id('kiosk-toast')).to_have_count(0, timeout=6000)

    def check_layout(self, page, width, height, section):
        ui.assert_no_overflow(page, width)
        bar = ui.assert_bounded(page, 'kiosk-menu-checkout', width, height)
        self.assertGreaterEqual(bar['height'], 52)
        for key in SECTIONS:
            tile = ui.assert_bounded(page, 'kiosk-category-' + key, width, height)
            self.assertLessEqual(tile['x'] + tile['width'], 202 * min(1.08, max(.8, width / 1024)) + 1)
        hit = ui.assert_bounded(page, 'kiosk-product-' + HITS[section], width, height)
        self.assertGreater(hit['width'], width * .7, 'the hit spans the grid')
        descriptions = {p['description'] for p in self.catalog['products']}
        # Long names are fitted after layout and font load; give the fit a moment to settle.
        cut = clipped(page, '[data-testid="kiosk-screen-menu"]', descriptions)
        for _ in range(10):
            if not cut:
                break
            page.wait_for_timeout(200)
            cut = clipped(page, '[data-testid="kiosk-screen-menu"]', descriptions)
        self.assertEqual(cut, [], f'{section}: a text is cut')
        branch = ui.element(page, 'kiosk-header-subtitle')
        self.assertTrue(branch.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1'))
        # Cards that fit stay above the checkout panel (the grid ends 156 pt above the bottom).
        scroller = ui.element(page, 'kiosk-menu-scroll')
        scrolls = scroller.evaluate('(e) => e.scrollHeight > e.clientHeight + 1')
        if not scrolls:
            limit = height - 156 * min(1.08, max(.8, width / 1024)) + 2
            for card in page.locator('[data-testid^="kiosk-product-plus-"]').all():
                box = card.bounding_box()
                self.assertLessEqual(box['y'] + box['height'], limit, card.get_attribute('data-testid'))
        return scrolls

    def test_sections_with_cart_on_three_ipads(self):
        for width, height in SIZES:
            with self.subTest(width=width, height=height):
                page, fixture = self.open_with(width, height)
                self.start(page)
                self.fill_cart(page)
                for section in SECTIONS:
                    ui.element(page, 'kiosk-category-' + section).click()
                    expect(ui.element(page, 'kiosk-category-' + section)).to_have_attribute(
                        'aria-selected', 'true')
                    expect(ui.element(page, 'kiosk-product-' + HITS[section])).to_be_visible()
                    scrolls = self.check_layout(page, width, height, section)
                    self.assertFalse(scrolls, f'{section} fits {width}x{height}')
                    ui.capture(page, f'menu-{section}-{width}.png')
                # Both lines are in the panel; the summary opens the cart page.
                expect(ui.element(page, 'kiosk-cart-feedback')).to_contain_text('Pick Combo, Coca-Cola')
                self.assertFalse(ui.element(page, 'kiosk-menu-checkout').is_disabled())
                ui.element(page, 'kiosk-cart-open').click()
                ui.screen(page, 'cart')
                self.assertEqual(len(fixture.orders), 0)

    def test_kazakh_and_english_headers_fit(self):
        for width, height in SIZES:
            for lang in ['kk', 'en']:
                with self.subTest(width=width, lang=lang):
                    page, fixture = self.open_with(width, height)
                    self.start(page)
                    self.fill_cart(page)
                    ui.element(page, 'kiosk-language-' + lang).click()
                    for section in ['combo', 'extras']:
                        ui.element(page, 'kiosk-category-' + section).click()
                        self.check_layout(page, width, height, section)
                        if lang == 'kk' or width == 744:
                            ui.capture(page, f'menu-{section}-{lang}-{width}.png')
                    self.assertEqual(len(fixture.orders), 0)

    def test_nineteen_drinks_scroll_under_the_panel(self):
        catalog = many_drinks(self.catalog)
        for width, height in SIZES:
            with self.subTest(width=width, height=height):
                page, fixture = self.open_with(width, height, catalog)
                self.start(page)
                self.fill_cart(page)
                ui.element(page, 'kiosk-category-drinks').click()
                scrolls = self.check_layout(page, width, height, 'drinks')
                self.assertTrue(scrolls, '19 drinks must scroll')
                ui.capture(page, f'menu-drinks19-top-{width}.png')
                last_id = catalog['products'][-1]['id']
                last = ui.element(page, 'kiosk-product-' + last_id)
                last.scroll_into_view_if_needed()
                scroller = ui.element(page, 'kiosk-menu-scroll')
                scroller.evaluate('(e) => {e.scrollTop = e.scrollHeight;}')
                ui.assert_bounded(page, 'kiosk-menu-checkout', width, height)
                plus = ui.element(page, 'kiosk-product-plus-' + last_id).bounding_box()
                checkout = ui.element(page, 'kiosk-cart-bar').bounding_box()
                self.assertLess(plus['y'] + plus['height'], height - 112 * min(1.08, max(.8, width / 1024)),
                                'the last card clears the checkout panel at the end of the scroll')
                ui.capture(page, f'menu-drinks19-end-{width}.png')
                self.assertGreater(checkout['height'], 0)
                self.assertEqual(len(fixture.orders), 0)

    def test_ten_extras_still_fit(self):
        # Three rows of cards fit on every iPad; only a longer section scrolls.
        catalog = grown(self.catalog, 'Допы', 10)
        for width, height in SIZES:
            with self.subTest(width=width, height=height):
                page, fixture = self.open_with(width, height, catalog)
                self.start(page)
                ui.element(page, 'kiosk-category-extras').click()
                self.assertFalse(self.check_layout(page, width, height, 'extras'))
                if width == 744:
                    ui.capture(page, f'menu-extras10-{width}.png')
                self.assertEqual(len(fixture.orders), 0)

    def test_empty_cart_disables_checkout(self):
        for width, height in SIZES:
            with self.subTest(width=width, height=height):
                page, fixture = self.open_with(width, height)
                self.start(page)
                self.assertTrue(ui.element(page, 'kiosk-menu-checkout').is_disabled())
                self.assertTrue(ui.element(page, 'kiosk-cart-open').is_disabled())
                self.check_layout(page, width, height, 'combo')
                ui.capture(page, f'menu-empty-{width}.png')
                self.assertEqual(len(fixture.orders), 0)


if __name__ == '__main__':
    # Inherited helpers include the full browser_ui suite: run only the menu checks.
    unittest.main(defaultTest=[
        'RedesignMenu.test_sections_with_cart_on_three_ipads',
        'RedesignMenu.test_kazakh_and_english_headers_fit',
        'RedesignMenu.test_nineteen_drinks_scroll_under_the_panel',
        'RedesignMenu.test_ten_extras_still_fit',
        'RedesignMenu.test_empty_cart_disables_checkout',
    ], verbosity=2)
