"""Kiosk redesign 2026-10-13: the smart upsell and its way to payment.

Exported kiosk (test simulator) with browser_ui's local API fixture: fingers in the order
suggest the burger, a burger suggests fingers, both mains suggest the lemonade; an added item
turns green and a second tap takes it out; RU on the 13-inch (1024x1366), 11-inch (820x1180) and
mini (744x1133) iPads plus KZ, with no text cut and every action on screen. «К оплате» and «Без
допов» open the existing payment-method screen in the simulator (Kaspi and card), and the
payment, the order number and «В заказе» -> order page keep working. A line stopped while the
guest is on the screen is shown and blocks payment.

With KIOSK_STORYBOOK_URL (a fresh Storybook build of this checkout), the real commercial
controller with its in-memory adapter (Kiosk/UpsellCheckout) proves that «К оплате» opens the
existing Kaspi QR screen when Kaspi QR is the only method, and the method screen otherwise.

Screenshots go to KIOSK_UI_OUTPUT (default .local/kiosk-ui). No VPS, bank, fiscal or SMS
requests are sent; the QR in the Storybook adapter is synthetic and not payable.
"""
import json
import os
import unittest
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

import browser_ui as ui

SIZES = [(1024, 1366), (820, 1180), (744, 1133)]
FINGERS = [('combo', 'pick-combo')]
BURGER = [('combo', 'burger-combo')]
BOTH = [('combo', 'pick-combo'), ('extras', 'burger')]
# Texts cut by an ellipsis or a line clamp (a few points of Montserrat Black glyphs above the
# line box are not a cut line), which no upsell text may need.
CUT_TEXT = '''(root) => [...root.querySelectorAll('div')].filter((e) => {
    const s = getComputedStyle(e);
    const clamp = s.webkitLineClamp && s.webkitLineClamp !== 'none';
    if (s.textOverflow !== 'ellipsis' && !clamp) return false;
    return e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 4;
}).map((e) => e.textContent)'''


def illustrations(card, expected=None):
    """The bg1-bg4 card illustrations drawn inside `card`. With `expected`, waits up to 3 s
    for that count (the card's images mount a frame or two after the screen on a busy runner)."""
    count = lambda: card.locator('img').evaluate_all(  # noqa: E731
        '(all) => all.filter((i) => /\\/bg\\/bg[1-4]\\b/.test(i.currentSrc || i.src)).length')
    found = count()
    for _ in range(30):
        if expected is None or found == expected:
            break
        card.page.wait_for_timeout(100)
        found = count()
    return found


def tiles(page):
    return sorted(page.locator('[data-testid^="kiosk-upsell-tile-"]').evaluate_all(
        '(all) => all.map((e) => e.dataset.testid.replace("kiosk-upsell-tile-", ""))'))


class SmartUpsell(ui.KioskUI):
    def open(self, width=820, height=1180, clock=False):
        if not clock:
            return super().open(width, height)
        # The page clock lets the minute's catalog re-read happen at once (it keeps running).
        context = self.browser.new_context(viewport={'width': width, 'height': height},
                                           reduced_motion='reduce')
        context.clock.install()
        fixture = ui.Fixture(self.catalog)
        context.route('**/*', fixture.route)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        self.contexts.append((context, page, fixture, errors))
        page.goto(ui.URL)
        ui.screen(page, 'welcome')
        return page, fixture

    def order(self, page, products):
        for category, product_id in products:
            ui.element(page, 'kiosk-category-' + category).click()
            card = ui.element(page, 'kiosk-product-' + product_id)
            card.scroll_into_view_if_needed()
            card.click()
            if category in ('extras', 'drinks'):
                # Simple products open as the sheet over the menu (product-and-payment.md §3).
                expect(ui.element(page, 'kiosk-product-sheet')).to_be_visible()
                ui.element(page, 'kiosk-sheet-add').click()
                expect(ui.element(page, 'kiosk-product-sheet')).to_have_count(0)
            else:
                ui.screen(page, 'product')
                ui.element(page, 'kiosk-product-add').click()
            ui.screen(page, 'menu')

    def upsell(self, products, width=1024, height=1366, clock=False):
        page, fixture = self.open(width, height, clock)
        self.start(page)
        self.order(page, products)
        ui.element(page, 'kiosk-menu-checkout').click()
        ui.screen(page, 'upsell')
        expect(page.get_by_test_id('kiosk-upsell-board')).to_be_visible()
        return page, fixture

    def check_layout(self, page, width, height):
        for identifier in ['kiosk-header-back', 'kiosk-language-kk',
                           'kiosk-language-ru', 'kiosk-language-en', 'kiosk-step-pills',
                           'kiosk-upsell-cart', 'kiosk-upsell-skip', 'kiosk-upsell-continue']:
            ui.assert_bounded(page, identifier, width, height)
        ui.assert_no_overflow(page, width)
        self.assertEqual(ui.element(page, 'kiosk-screen-upsell').evaluate(CUT_TEXT), [],
                         'A text of the upsell is cut')
        # Rows may scroll horizontally; each control must be reachable without page overflow.
        for kind in ('sauces', 'drinks'):
            row = ui.element(page, 'kiosk-upsell-' + kind + '-carousel')
            row.scroll_into_view_if_needed()
            expect(row).to_be_visible()
            self.assertLessEqual(row.bounding_box()['width'], width)
        footer = ui.element(page, 'kiosk-upsell-footer')
        ui.assert_bounded(page, 'kiosk-upsell-footer', width, height)

    def sheet_add(self, page, product, size=None):
        ui.element(page, 'kiosk-upsell-' + product).first.click()
        expect(ui.element(page, 'kiosk-product-sheet')).to_be_visible()
        if size is not None:
            ui.element(page, 'kiosk-sheet-size-' + size).click()
        ui.element(page, 'kiosk-sheet-add').click()
        expect(ui.element(page, 'kiosk-product-sheet')).to_have_count(0)
        ui.screen(page, 'upsell')

    def test_recommendations_and_all_drinks_on_three_ipads(self):
        for width, height in SIZES:
            page, fixture = self.upsell(FINGERS, width, height)
            hero = ui.element(page, 'kiosk-upsell-hero')
            expect(hero).to_contain_text('Добавьте бургер')
            self.assertEqual(illustrations(hero), 0)
            self.assertEqual(illustrations(ui.element(page, 'kiosk-upsell-tile-sauce'), 1), 1)
            drinks = page.get_by_test_id('kiosk-upsell-drinks-carousel')
            ids = drinks.locator('[data-testid^="kiosk-upsell-tile-"]').evaluate_all(
                '(all) => all.map(e => e.dataset.testid.replace("kiosk-upsell-tile-", ""))')
            self.assertEqual(ids[0], 'lemonade')
            self.assertGreater(len(ids), 3)
            expected = {p['id'] for p in fixture.catalog['products']
                        if p['category'] == 'Напитки' and p.get('available', True)}
            self.assertEqual(set(ids), expected)
            for product_id in ids:
                tile = drinks.get_by_test_id('kiosk-upsell-tile-' + product_id)
                tile.scroll_into_view_if_needed()
                expect(tile).to_be_in_viewport()
            for locale in ('ru', 'kk', 'en'):
                ui.element(page, 'kiosk-language-' + locale).click()
                self.check_layout(page, width, height)
                ui.capture(page, f'upsell-all-{locale}-{width}.png')
            self.assertEqual(len(fixture.orders), 0)

    def test_quantities_sizes_and_skip_restore_the_original_order(self):
        page, fixture = self.upsell(BURGER, 820, 1180)
        expect(ui.element(page, 'kiosk-upsell-hero')).to_contain_text('Добавьте фингерсы')
        self.sheet_add(page, 'sauce', 'size-1')
        count = ui.element(page, 'kiosk-upsell-quantity-sauce')
        expect(count).to_have_text('1')
        for quantity in range(2, 6):
            ui.element(page, 'kiosk-upsell-plus-sauce').click()
            expect(count).to_have_text(str(quantity))
        ui.element(page, 'kiosk-upsell-minus-sauce').click()
        expect(count).to_have_text('4')
        lines = ui.stored(page, ui.FLOW_KEY)['cart']
        sauce = next(line for line in lines if line['productId'] == 'sauce')
        self.assertEqual(sauce['quantity'], 4)
        self.assertIn(('size', 'size-1', 1), ui.selection_set(sauce))
        self.sheet_add(page, 'lemonade')
        ui.element(page, 'kiosk-upsell-plus-lemonade').click()
        expect(ui.element(page, 'kiosk-upsell-quantity-lemonade')).to_have_text('2')
        ui.capture(page, 'upsell-quantity-and-volume-820.png')
        ui.element(page, 'kiosk-upsell-skip').click()
        ui.screen(page, 'loyalty')
        self.assertEqual([line['productId'] for line in ui.stored(page, ui.FLOW_KEY)['cart']],
                         ['burger-combo'])
        self.assertEqual(len(fixture.orders), 0)

    def test_existing_drink_can_grow_and_skip_undoes_only_the_extras(self):
        page, fixture = self.upsell(FINGERS + [('drinks', 'cola')], 1024, 1366)
        expect(ui.element(page, 'kiosk-upsell-quantity-cola')).to_have_text('1')
        ui.element(page, 'kiosk-upsell-plus-cola').click()
        expect(ui.element(page, 'kiosk-upsell-quantity-cola')).to_have_text('2')
        self.sheet_add(page, 'sauce')
        ui.element(page, 'kiosk-upsell-skip').click()
        ui.screen(page, 'loyalty')
        lines = ui.stored(page, ui.FLOW_KEY)['cart']
        self.assertEqual([line['productId'] for line in lines], ['pick-combo', 'cola'])
        self.assertEqual(lines[1]['quantity'], 1)
        self.assertEqual(len(fixture.orders), 0)

    def test_both_mains_keep_lemonade_first_and_quantity_in_sync(self):
        page, fixture = self.upsell(BOTH, 744, 1133)
        hero = ui.element(page, 'kiosk-upsell-hero')
        expect(hero).to_contain_text('Добавьте лимонад')
        hero.get_by_test_id('kiosk-upsell-lemonade').click()
        ui.element(page, 'kiosk-sheet-add').click()
        # The recommendation and carousel represent the same product, never two orders.
        quantities = page.get_by_test_id('kiosk-upsell-quantity-lemonade')
        expect(quantities).to_have_count(2)
        for item in quantities.all():
            expect(item).to_have_text('1')
        hero.get_by_test_id('kiosk-upsell-plus-lemonade').click()
        for item in quantities.all():
            expect(item).to_have_text('2')
        self.assertEqual(len(fixture.orders), 0)

    def test_review_with_photos_time_and_qr_only_then_synthetic_payment(self):
        page, fixture = self.upsell(FINGERS, 820, 1180)
        ui.element(page, 'kiosk-upsell-cart').click()
        ui.screen(page, 'cart')
        ui.element(page, 'kiosk-header-back').click()
        ui.screen(page, 'menu')
        ui.element(page, 'kiosk-menu-checkout').click()
        self.sheet_add(page, 'lemonade')
        ui.element(page, 'kiosk-upsell-continue').click()
        ui.screen(page, 'loyalty')
        expect(ui.element(page, 'kiosk-payment-method-kaspi')).to_be_visible()
        expect(page.get_by_test_id('kiosk-payment-method-card')).to_have_count(0)
        expect(page.get_by_test_id('kiosk-payment-method-kaspi_invoice')).to_have_count(0)
        expect(page.get_by_text('10-13', exact=False).first).to_be_visible()
        photos = page.locator('[data-testid^="kiosk-review-photo-"]')
        expect(photos).to_have_count(2)
        for photo in photos.all():
            expect(photo).to_be_visible()
        ui.capture(page, 'review-photos-qr-820.png')
        ui.element(page, 'kiosk-review-create').click()
        ui.screen(page, 'payment')
        self.assertEqual(len(fixture.orders), 1)
        order = next(iter(fixture.orders.values()))
        self.assertEqual({line['id'] for line in order['snapshot']['lines']}, {'pick-combo', 'lemonade'})
        ui.element(page, 'kiosk-payment-approve').click()
        ui.screen(page, 'order')
        expect(ui.element(page, 'kiosk-order-number')).to_have_text(order['number'])

    def test_a_line_stopped_on_the_screen_is_shown_and_blocks_payment(self):
        page, fixture = self.upsell(FINGERS, 1024, 1366, clock=True)
        expect(ui.element(page, 'kiosk-upsell-continue')).to_be_enabled()
        # The kitchen stops the Pick Combo's drink; the minute's catalog re-read finds it.
        product = next(p for p in fixture.catalog['products'] if p['id'] == 'pick-combo')
        drink = next(g for g in product['modifier_groups'] if g['id'] == 'drink')
        for option in drink['options']:
            if option['default_quantity']:
                option['available'] = False
        page.clock.fast_forward('01:05')
        expect(ui.element(page, 'kiosk-upsell-check-cart')).to_be_visible(timeout=20000)
        expect(ui.element(page, 'kiosk-upsell-continue')).to_be_disabled()
        expect(ui.element(page, 'kiosk-upsell-skip')).to_be_disabled()
        expect(ui.element(page, 'kiosk-upsell-total')).to_have_text('Проверьте корзину')
        ui.capture(page, 'upsell-stopped-line-1024.png')
        ui.element(page, 'kiosk-upsell-open-cart').click()
        ui.screen(page, 'cart')
        expect(page.locator('[data-testid^="kiosk-unavailable-line-pick-combo"]')).to_be_visible()
        self.assertEqual(len(fixture.orders), 0)

class CommercialUpsell(unittest.TestCase):
    """Real commercial controller through Storybook's in-memory adapter (Kiosk/UpsellCheckout)."""

    def setUp(self):
        self.url = os.environ.get('KIOSK_STORYBOOK_URL')
        if not self.url:
            self.skipTest('KIOSK_STORYBOOK_URL is not set')
        self.assertTrue(self.url.startswith('http://127.0.0.1:'))
        ui.OUTPUT.mkdir(parents=True, exist_ok=True)
        self.p = sync_playwright().start()
        self.browser = self.p.chromium.launch()

    def tearDown(self):
        self.browser.close()
        self.p.stop()

    def story(self, name, width=1024, height=1366):
        page = self.browser.new_page(viewport={'width': width, 'height': height},
                                     reduced_motion='reduce')
        errors, external = [], []
        page.on('pageerror', lambda e: errors.append(str(e)))

        def route(request):
            if urlparse(request.request.url).hostname == '127.0.0.1':
                request.continue_()
            else:
                external.append(request.request.url)
                request.abort()

        page.route('**/*', route)
        page.goto(f'{self.url}/iframe.html?id=kiosk-upsellcheckout--{name}&viewMode=story'
                  '&globals=a11y.manual:!true')
        expect(page.get_by_test_id('kiosk-screen-upsell')).to_be_visible(timeout=20000)
        expect(page.get_by_test_id('kiosk-upsell-continue')).to_be_enabled()
        return page, errors, external

    def test_every_new_order_reviews_then_uses_qr_without_invoice(self):
        report = []
        for name, button in [('qr-only', 'kiosk-upsell-continue'),
                             ('qr-only', 'kiosk-upsell-skip'),
                             ('qr-and-invoice', 'kiosk-upsell-continue')]:
            page, errors, external = self.story(name)
            page.get_by_test_id(button).click()
            expect(page.get_by_test_id('kiosk-screen-loyalty')).to_be_visible()
            expect(page.get_by_test_id('kiosk-payment-method-kaspi_invoice')).to_have_count(0)
            expect(page.get_by_test_id('kiosk-invoice-phone')).to_have_count(0)
            page.get_by_test_id('kiosk-review-create').click()
            expect(page.get_by_test_id('kiosk-payment-qr')).to_be_visible(timeout=20000)
            ui.capture(page, f'commercial-qr-{name}-{button}.png')
            self.assertEqual(errors, [])
            self.assertEqual(external, [])
            report.append({'story': name, 'pressed': button, 'reached': 'review then synthetic QR'})
            page.close()
        (ui.OUTPUT / 'upsell-commercial-result.json').write_text(json.dumps(
            {'synthetic': True, 'checks': report}, indent=2) + '\n')


if __name__ == '__main__':
    # SmartUpsell inherits browser_ui's helpers and tests: run only the upsell checks here.
    unittest.main(defaultTest=[f'SmartUpsell.{name}' for name in vars(SmartUpsell)
                               if name.startswith('test_')] + ['CommercialUpsell'],
                  verbosity=2)
