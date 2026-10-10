"""Kiosk build 13 in a branch in mode 'cloud' (ADR-0014), through Storybook's in-memory adapter.

The real controller and screens: KITCHEN_OFFLINE notice in KZ/RU/EN with checkout closed, and a
paid order showing the cloud kitchen number (300-599). The upsell/cart header title keeps a
readable width next to the language pill. No device credentials, server, bank or kitchen.
KIOSK_STORYBOOK_URL must point to this checkout's freshly built Storybook.
"""
import json
import os
import unittest
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

OFFLINE = {
    'ru': 'Кухня сейчас не на связи - заказ оформить нельзя. Пригласите сотрудника.',
    'kk': 'Ас үй қазір байланыста емес - тапсырыс беру мүмкін емес. Қызметкерді шақырыңыз.',
    'en': 'The kitchen is offline right now - orders cannot be placed. Please call a team member.',
}
SIZES = [(768, 1024), (820, 1180), (1024, 1366)]


class CloudKitchen(unittest.TestCase):
    def setUp(self):
        self.url = os.environ.get('KIOSK_STORYBOOK_URL', 'http://127.0.0.1:6008')
        self.assertTrue(self.url.startswith('http://127.0.0.1:'))
        self.output = Path(os.environ.get('KIOSK_CLOUD_OUTPUT', '.local/cloud-kitchen-browser'))
        self.output.mkdir(parents=True, exist_ok=True)
        self.p = sync_playwright().start()
        self.browser = self.p.chromium.launch()

    def tearDown(self):
        self.browser.close()
        self.p.stop()

    def open(self, story, width, height):
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
        page.goto(f'{self.url}/iframe.html?id=kiosk-{story}&viewMode=story'
                  '&globals=a11y.manual:!true')
        return page, errors, external

    def bounded(self, page, locator, width, height):
        rect = locator.bounding_box()
        self.assertIsNotNone(rect)
        self.assertGreaterEqual(rect['x'], -1)
        self.assertLessEqual(rect['x'] + rect['width'], width + 1)
        self.assertLessEqual(rect['y'] + rect['height'], height + 1)
        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), width)
        return rect

    def test_kitchen_offline_notice_in_three_languages(self):
        report = []
        for width, height in SIZES:
            for locale, story in [('ru', 'kitchen-offline'), ('kk', 'kitchen-offline-kk'),
                                  ('en', 'kitchen-offline-en')]:
                with self.subTest(width=width, locale=locale):
                    page, errors, external = self.open('cloudkitchen--' + story, width, height)
                    notice = page.get_by_test_id('kiosk-error')
                    expect(notice).to_be_visible(timeout=20000)
                    expect(notice).to_contain_text(OFFLINE[locale])
                    expect(notice).to_have_attribute('role', 'alert')
                    # Checkout is closed: the guest cannot start a payment.
                    expect(page.get_by_test_id('kiosk-review-create')).to_be_disabled()
                    self.bounded(page, notice, width, height)
                    page.screenshot(path=str(self.output / f'kitchen-offline-{locale}-{width}.png'))
                    self.assertEqual(errors, [])
                    self.assertEqual(external, [])
                    report.append({'width': width, 'locale': locale, 'notice': True})
                    page.close()
        (self.output / 'offline.json').write_text(json.dumps(report, indent=2) + '\n')

    def test_paid_order_shows_the_cloud_number(self):
        for width, height in SIZES:
            with self.subTest(width=width):
                page, errors, external = self.open('cloudkitchen--paid-number', width, height)
                expect(page.get_by_test_id('kiosk-screen-order')).to_be_visible(timeout=20000)
                number = page.get_by_test_id('kiosk-order-number')
                expect(number).to_contain_text('342')
                expect(page.get_by_test_id('kiosk-order-state')).to_have_text('Готовим ваш заказ')
                self.bounded(page, number, width, height)
                expect(page.get_by_test_id('kiosk-error')).to_have_count(0)
                page.screenshot(path=str(self.output / f'paid-number-{width}.png'))
                self.assertEqual(errors, [])
                self.assertEqual(external, [])
                page.close()

    def test_header_title_stays_readable_next_to_the_language_pill(self):
        # Build 11 fix (f2e34110): the upsell/cart header no longer squeezes its title.
        for story in ['header--eat-in', 'header--long-title']:
            with self.subTest(story=story):
                page, errors, external = self.open(story, 768, 1024)
                title = page.get_by_role('heading').first
                expect(title).to_be_visible(timeout=20000)
                self.assertGreaterEqual(title.bounding_box()['width'], 120)
                self.assertTrue(title.evaluate('(e) => e.textContent.length > 3'))
                page.screenshot(path=str(self.output / f'{story}-768.png'))
                self.assertEqual(errors, [])
                self.assertEqual(external, [])
                page.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
