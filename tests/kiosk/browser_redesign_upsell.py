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
        for identifier in ['kiosk-header-back', 'kiosk-upsell-help', 'kiosk-language-kk',
                           'kiosk-language-ru', 'kiosk-language-en', 'kiosk-step-pills',
                           'kiosk-upsell-cart', 'kiosk-upsell-skip', 'kiosk-upsell-continue']:
            ui.assert_bounded(page, identifier, width, height)
        ui.assert_no_overflow(page, width)
        self.assertEqual(ui.element(page, 'kiosk-screen-upsell').evaluate(CUT_TEXT), [],
                         'A text of the upsell is cut')
        # The whole board fits above the bottom panel on every iPad: nothing to scroll to.
        footer = ui.element(page, 'kiosk-upsell-footer').bounding_box()
        cards = page.locator('[data-testid^="kiosk-upsell-tile-"], [data-testid="kiosk-upsell-hero"]')
        self.assertGreater(cards.count(), 0)
        for card in cards.all():
            rect = card.bounding_box()
            assert rect['x'] >= 0 and rect['x'] + rect['width'] <= width + 1, rect
            assert rect['y'] + rect['height'] <= footer['y'] + 1, (rect, footer)

    def test_fingers_order_suggests_a_burger_on_three_ipads(self):
        for width, height in SIZES:
            with self.subTest(width=width):
                page, fixture = self.upsell(FINGERS, width, height)
                expect(ui.element(page, 'kiosk-upsell-subtitle')).to_have_text(
                    'Вы взяли Pick Combo - к фингерсам подобрали')
                hero = ui.element(page, 'kiosk-upsell-hero')
                expect(hero).to_contain_text('Добавьте бургер')
                expect(hero).to_contain_text('2 390')
                expect(hero.get_by_test_id('kiosk-upsell-badge-toFingers')).to_have_text('К ФИНГЕРСАМ')
                # Nothing of the order is offered, and no cheese sauce exists in the catalog.
                self.assertEqual(tiles(page), ['cola', 'iced-tea', 'lemonade', 'sauce', 'sauce-hot'])
                self.assertEqual(page.get_by_test_id('kiosk-upsell-pick-combo').count(), 0)
                expect(ui.element(page, 'kiosk-upsell-badge-lemonade')).to_have_text('НАШ ЛИМОНАД')
                expect(ui.element(page, 'kiosk-step-extras')).to_contain_text('Допы')
                expect(ui.element(page, 'kiosk-upsell-cart')).to_contain_text('В заказе: Pick Combo')
                expect(ui.element(page, 'kiosk-upsell-total')).to_have_text('4 190 ₸')
                self.check_layout(page, width, height)
                ui.capture(page, f'upsell-fingers-{width}.png')
                if width in (1024, 744):
                    ui.element(page, 'kiosk-language-kk').click()
                    expect(ui.element(page, 'kiosk-upsell-subtitle')).to_have_text(
                        'Pick Combo - фингерстерге қоса ұсынамыз')
                    expect(ui.element(page, 'kiosk-upsell-continue')).to_have_text('Төлеуге')
                    self.check_layout(page, width, height)
                    ui.capture(page, f'upsell-fingers-kk-{width}.png')
                    ui.element(page, 'kiosk-language-en').click()
                    self.check_layout(page, width, height)
                    ui.capture(page, f'upsell-fingers-en-{width}.png')
                self.assertEqual(len(fixture.orders), 0)

    def test_burger_order_suggests_fingers_and_an_added_sauce_turns_green(self):
        for width, height in SIZES:
            with self.subTest(width=width):
                page, fixture = self.upsell(BURGER, width, height)
                expect(ui.element(page, 'kiosk-upsell-subtitle')).to_have_text(
                    'Вы взяли Burger Combo - к бургеру подобрали')
                hero = ui.element(page, 'kiosk-upsell-hero')
                expect(hero).to_contain_text('Добавьте фингерсы')
                expect(hero).to_contain_text('от 690 ₸ за штуку')
                expect(hero.get_by_test_id('kiosk-upsell-badge-toBurger')).to_have_text('К БУРГЕРУ')
                plus = ui.element(page, 'kiosk-upsell-plus-sauce')
                expect(plus).to_have_attribute('aria-label', '+ Фирменный')
                plus.click()
                expect(plus).to_have_attribute('aria-label', 'Убрать одну: Фирменный')
                expect(ui.element(page, 'kiosk-upsell-cart')).to_contain_text(
                    'В заказе: Burger Combo + Соус фирменный')
                expect(ui.element(page, 'kiosk-upsell-total')).to_have_text('4 180 ₸')
                cart = ui.stored(page, ui.FLOW_KEY)['cart']
                self.assertEqual([line['productId'] for line in cart], ['burger-combo', 'sauce'])
                # Still offered (green) after the add, unlike what the guest brought.
                self.assertIn('sauce', tiles(page))
                self.check_layout(page, width, height)
                ui.capture(page, f'upsell-burger-{width}.png')
                if width == 1024:
                    # The hero is a toggle as well; a second tap on the card takes it out.
                    ui.element(page, 'kiosk-upsell-fingers').click()
                    expect(ui.element(page, 'kiosk-upsell-plus-fingers')).to_have_attribute(
                        'aria-label', 'Убрать одну: Фингерс, 1 шт')
                    ui.capture(page, 'upsell-burger-added-hero-1024.png')
                    ui.element(page, 'kiosk-upsell-fingers').click()
                    plus.click()
                    expect(plus).to_have_attribute('aria-label', '+ Фирменный')
                    cart = ui.stored(page, ui.FLOW_KEY)['cart']
                    self.assertEqual([line['productId'] for line in cart], ['burger-combo'])
                self.assertEqual(len(fixture.orders), 0)

    def test_both_mains_offer_the_lemonade(self):
        for width, height in [(1024, 1366), (744, 1133)]:
            with self.subTest(width=width):
                page, fixture = self.upsell(BOTH, width, height)
                expect(ui.element(page, 'kiosk-upsell-subtitle')).to_have_text(
                    'Вы взяли Pick Combo +1 - подобрали к заказу')
                hero = ui.element(page, 'kiosk-upsell-hero')
                expect(hero).to_contain_text('Добавьте лимонад')
                expect(hero.get_by_test_id('kiosk-upsell-badge-lemonade')).to_be_visible()
                self.assertEqual(tiles(page), ['cola', 'iced-tea', 'sauce', 'sauce-hot'])
                self.assertEqual(page.get_by_test_id('kiosk-upsell-burger').count(), 0)
                self.check_layout(page, width, height)
                ui.capture(page, f'upsell-both-{width}.png')
                self.assertEqual(len(fixture.orders), 0)

    def test_pay_reaches_payment_and_the_order_page_stays_reachable(self):
        page, fixture = self.upsell(FINGERS, 820, 1180)
        # «В заказе» opens the order page for changes; back from it is the menu.
        ui.element(page, 'kiosk-upsell-cart').click()
        ui.screen(page, 'cart')
        expect(ui.element(page, 'kiosk-cart-checkout')).to_be_enabled()
        ui.element(page, 'kiosk-header-back').click()
        ui.screen(page, 'menu')
        ui.element(page, 'kiosk-menu-checkout').click()
        ui.screen(page, 'upsell')
        # «Без допов»: the simulator offers Kaspi and card, so the method screen opens.
        ui.element(page, 'kiosk-upsell-skip').click()
        ui.screen(page, 'loyalty')
        expect(ui.element(page, 'kiosk-payment-method-kaspi')).to_be_visible()
        expect(ui.element(page, 'kiosk-payment-method-card')).to_be_visible()
        self.assertEqual(len(fixture.orders), 0)
        self.assertEqual(len(fixture.sessions), 0, 'The upsell must not allocate an ordering identity')
        # Back to the menu, add a drink on the upsell and go on with «К оплате».
        page.reload()
        ui.screen(page, 'menu')
        ui.element(page, 'kiosk-menu-checkout').click()
        ui.screen(page, 'upsell')
        ui.element(page, 'kiosk-upsell-plus-lemonade').click()
        expect(ui.element(page, 'kiosk-upsell-total')).to_have_text('5 380 ₸')
        ui.element(page, 'kiosk-upsell-continue').click()
        ui.screen(page, 'loyalty')
        ui.capture(page, 'upsell-pay-method-screen-820.png')
        ui.element(page, 'kiosk-review-create').click()
        ui.screen(page, 'payment')
        self.assertEqual(len(fixture.orders), 1)
        order = next(iter(fixture.orders.values()))
        self.assertEqual(order['snapshot']['total_minor'], '538000')
        self.assertEqual({line['id'] for line in order['snapshot']['lines']},
                         {'pick-combo', 'lemonade'})
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

    def test_kaspi_qr_only_goes_straight_to_the_qr(self):
        report = []
        for name, button in [('qr-only', 'kiosk-upsell-continue'), ('burger-order', 'kiosk-upsell-skip')]:
            page, errors, external = self.story(name)
            ui.capture(page, f'commercial-upsell-{name}-1024.png')
            page.get_by_test_id(button).click()
            expect(page.get_by_test_id('kiosk-screen-payment')).to_be_visible(timeout=20000)
            expect(page.get_by_test_id('kiosk-payment-qr')).to_be_visible()
            self.assertEqual(page.get_by_test_id('kiosk-screen-loyalty').count(), 0)
            page.wait_for_function('[...document.images].every(i => i.complete && i.naturalWidth > 0)')
            ui.capture(page, f'commercial-qr-after-{name}-1024.png')
            self.assertEqual(errors, [])
            self.assertEqual(external, [])
            report.append({'story': name, 'pressed': button, 'reached': 'kaspi-qr'})
            page.close()
        page, errors, external = self.story('qr-and-invoice')
        page.get_by_test_id('kiosk-upsell-continue').click()
        expect(page.get_by_test_id('kiosk-screen-loyalty')).to_be_visible(timeout=20000)
        expect(page.get_by_test_id('kiosk-payment-method-kaspi_invoice')).to_be_visible()
        ui.capture(page, 'commercial-method-screen-1024.png')
        self.assertEqual(errors, [])
        self.assertEqual(external, [])
        report.append({'story': 'qr-and-invoice', 'pressed': 'kiosk-upsell-continue',
                       'reached': 'payment-method screen'})
        (ui.OUTPUT / 'upsell-commercial-result.json').write_text(json.dumps(
            {'synthetic': True, 'checks': report}, indent=2) + '\n')


if __name__ == '__main__':
    # SmartUpsell inherits browser_ui's helpers and tests: run only the upsell checks here.
    unittest.main(defaultTest=[f'SmartUpsell.{name}' for name in vars(SmartUpsell)
                               if name.startswith('test_')] + ['CommercialUpsell'],
                  verbosity=2)
