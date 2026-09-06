"""Geometry regressions on local fixtures. Never connects to the VPS."""
import os
import re
import unittest
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright
from kiosk_recovery import KioskRecovery, Fixture, BRANCH


class KioskLayout(KioskRecovery):
    # Inherit setup/helpers, not the eight existing recovery tests.
    def test_fixed_actions_in_portrait_landscape_and_short_viewports(self):
        self.start()
        self.add()
        for width, height in [(768, 1024), (820, 1180), (1024, 768), (1180, 820), (1024, 600)]:
            self.page.set_viewport_size({'width': width, 'height': height})
            self.assert_footer('.cart-bar', '.menu-scroll', height)
            if (width, height) == (1024, 768):
                Path('.local/layout-audit').mkdir(parents=True, exist_ok=True)
                self.page.screenshot(path='.local/layout-audit/kiosk-menu-after.png')
        self.page.get_by_role('button', name='Оформить заказ →', exact=True).click()
        for width, height in [(768, 1024), (1024, 600)]:
            self.page.set_viewport_size({'width': width, 'height': height})
            self.assert_footer('.kiosk-actions', '.kiosk-body', height)
        self.page.get_by_role('button', name='Продолжить →', exact=True).click()
        self.assert_footer('.kiosk-actions', '.kiosk-body', 600)
        self.page.get_by_role('button', name='Рассчитать тестовый заказ', exact=True).click()
        expect(self.page.get_by_text('Расчёт подтверждён сервером', exact=True)).to_be_visible()
        self.assert_footer('.kiosk-actions', '.kiosk-body', 600)
        self.assertFalse(any(path == '/orders' and method == 'POST' for method, path, *_ in self.fixture.requests))

    def assert_footer(self, selector, scroll, height):
        footer = self.page.locator(selector)
        expect(footer).to_be_visible()
        before = footer.bounding_box()
        self.assertAlmostEqual(before['y'] + before['height'], height, delta=2)
        self.page.locator(scroll).evaluate('(e)=>{e.scrollTop=e.scrollHeight}')
        after = footer.bounding_box()
        self.assertAlmostEqual(before['y'], after['y'], delta=1)
        self.assertLessEqual(self.page.locator(scroll).bounding_box()['y'] + self.page.locator(scroll).bounding_box()['height'], before['y'] + 1)
        for button in footer.get_by_role('button').all():
            self.assertGreaterEqual(button.bounding_box()['height'], 48)


class MobileLayout(unittest.TestCase):
    def test_tab_and_cart_stay_at_bottom_during_scroll_and_resize(self):
        url = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4182').rstrip('/')
        self.assertIn(urlparse(url).hostname, ('127.0.0.1', 'localhost'))
        with sync_playwright() as p:
            browser = p.chromium.launch()
            context = browser.new_context(viewport={'width': 390, 'height': 844})
            fixture = Fixture()
            def read_fixture(route):
                assert route.request.method == 'GET', 'Layout checks must never create orders'
                path = urlparse(route.request.url).path
                values = {
                    '/v1/capabilities': {'schema_version': 1, 'environment': 'staging', 'data_mode': 'synthetic',
                        'ordering_enabled': False, 'features': {'test_order_flow': True,
                        **{key: False for key in ['phone_auth', 'payments', 'fiscal', 'checkout', 'loyalty']}}},
                    '/v1/branches': {'branches': [{'id': BRANCH, 'code': 'TEST', 'name': 'Local UI fixture',
                        'timezone': 'Asia/Almaty', 'ordering_enabled': False}]},
                    '/v1/branches/' + BRANCH + '/menu': {'schema_version': 1, 'branch_id': BRANCH,
                        'release_id': '10000000-0000-4000-8000-000000000008', 'version': 1,
                        'published_at': '2026-09-06T00:00:00Z', 'items': []},
                    '/v1/test/catalog': fixture.catalog,
                }
                if path in values:
                    route.fulfill(json=values[path], headers={'Access-Control-Allow-Origin': '*'})
                else:
                    route.abort()
            context.route('**/v1/**', read_fixture)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(url + '/menu')
            expect(page.get_by_test_id('product-pick-combo')).to_be_visible(timeout=20000)
            page.get_by_test_id('product-pick-combo').click()
            expect(page.get_by_test_id('product-add')).to_be_visible()
            for height in [844, 568]:
                page.set_viewport_size({'width': 320, 'height': height})
                self.fixed(page, 'product-add', 'scroll-M07', height)
            page.get_by_test_id('product-add').click()
            expect(page.get_by_test_id('screen-M09')).to_be_visible()
            self.fixed(page, 'cart-checkout', 'scroll-M09', 568)
            page.get_by_role('button', name='Назад', exact=True).click()
            page.get_by_role('button', name='Закрыть блюдо', exact=True).click()
            for width, height in [(320, 568), (390, 667), (390, 844), (430, 932), (844, 390)]:
                page.set_viewport_size({'width': width, 'height': height})
                self.fixed(page, 'tab-menu', 'scroll-M06', height, bottom_gap=0)
                tab = page.get_by_test_id('tab-menu').bounding_box()
                cart = page.get_by_test_id('open-cart').bounding_box()
                self.assertGreaterEqual(tab['y'] - cart['y'] - cart['height'], 0)
                self.assertLessEqual(tab['y'] - cart['y'] - cart['height'], 18)
                self.assertEqual(page.get_by_test_id('open-design-review').count(), 0)
                for label in ['Меню', 'События', 'Заказы', 'Профиль']:
                    bounds = page.get_by_text(label, exact=True).last.bounding_box()
                    self.assertGreaterEqual(bounds['height'], 16)
                    self.assertLessEqual(bounds['y'] + bounds['height'], height)

                self.assertGreaterEqual(cart['height'], 48)
                if (width, height) == (390, 844):
                    Path('.local/layout-audit').mkdir(parents=True, exist_ok=True)
                    page.screenshot(path='.local/layout-audit/mobile-cart-after.png')
            for tab, screen in [('orders', 'M19'), ('events', 'M26'), ('profile', 'M30')]:
                page.get_by_test_id('tab-' + tab).click()
                expect(page.get_by_test_id('screen-' + screen)).to_be_visible()
                self.fixed(page, 'tab-' + tab, 'scroll-' + screen, 390, bottom_gap=0)
            self.assertEqual(errors, [])
            browser.close()

    def fixed(self, page, control, scroll, height, bottom_gap=None):
        target = page.get_by_test_id(control)
        expect(target).to_be_visible()
        before = target.bounding_box()
        self.assertLessEqual(before['y'] + before['height'], height + 1)
        self.assertGreaterEqual(before['height'], 48)
        if bottom_gap is not None:
            self.assertAlmostEqual(before['y'] + before['height'], height - bottom_gap, delta=2)
        page.get_by_test_id(scroll).evaluate('(e)=>{e.scrollTop=e.scrollHeight}')
        after = target.bounding_box()
        self.assertAlmostEqual(before['y'], after['y'], delta=1)
        self.assertGreaterEqual(before['y'], 0)


if __name__ == '__main__':
    suite = unittest.TestSuite([
        KioskLayout('test_fixed_actions_in_portrait_landscape_and_short_viewports'),
        MobileLayout('test_tab_and_cart_stay_at_bottom_during_scroll_and_resize'),
    ])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
