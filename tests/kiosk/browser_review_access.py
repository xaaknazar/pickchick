"""Review-enabled commercial bundle, synthetic code, zero API/printer/network effects."""
import json
import os
from pathlib import Path
import unittest
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
import browser_ui as ui

URL = os.environ.get('KIOSK_UI_URL', 'http://127.0.0.1:4184')
OUT = Path(os.environ.get('KIOSK_UI_OUTPUT', '.local/kiosk-review-ui'))
CODE = 'Synthetic-Review-Only'
ui.OUTPUT = OUT

class ReviewAccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        OUT.mkdir(parents=True, exist_ok=True)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.contexts = []

    def tearDown(self):
        for ctx, page, calls, errors in self.contexts:
            self.assertEqual(calls, [], 'Review must never call any API, bank or printer')
            self.assertEqual(errors, [])
            ctx.close()

    def open(self, width=820, height=1180):
        ctx = self.browser.new_context(viewport={'width': width, 'height': height}, reduced_motion='reduce')
        calls, errors = [], []
        def route(r):
            parsed = urlsplit(r.request.url)
            if r.request.method != 'GET' or '/v1/' in parsed.path or parsed.netloc != urlsplit(URL).netloc:
                calls.append({'method': r.request.method, 'path': parsed.path})
                r.abort()
            else:
                r.continue_()
        ctx.route('**/*', route)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        self.contexts.append((ctx, page, calls, errors))
        page.clock.install()
        page.goto(URL)
        expect(ui.element(page, 'kiosk-enrollment-submit')).to_be_visible()
        expect(ui.element(page, 'kiosk-review-open')).to_be_visible()
        return page

    def enter(self, page, locale='ru'):
        ui.element(page, 'kiosk-language-' + locale).click()
        label = {'ru': 'Код проверки Apple', 'kk': 'Apple тексеру коды', 'en': 'Apple review code'}[locale]
        page.get_by_label(label, exact=True).fill(CODE)
        ui.element(page, 'kiosk-review-open').click()
        ui.screen(page, 'welcome')
        expect(ui.element(page, 'kiosk-demo-badge')).to_be_visible()
        ui.element(page, 'kiosk-language-' + locale).click()

    def order(self, page):
        ui.KioskUI.start(self, page)
        expect(page.get_by_test_id('photo-entry')).to_have_count(0)
        ui.KioskUI.add(self, page)
        ui.element(page, 'kiosk-menu-checkout').click()
        ui.element(page, 'kiosk-upsell-continue').click()
        ui.screen(page, 'loyalty')
        ui.element(page, 'kiosk-payment-method-kaspi').click()
        ui.element(page, 'kiosk-review-create').click()
        ui.screen(page, 'payment')

    def test_review_order_all_languages_exit_reload_and_idle_stay_isolated(self):
        for width, height, locale in [(768,1024,'ru'), (820,1180,'kk'), (1024,1366,'en')]:
            with self.subTest(locale=locale):
                page = self.open(width, height)
                page.get_by_label('Код проверки Apple', exact=True).fill('Incorrect-Review-Code')
                ui.element(page, 'kiosk-review-open').click()
                expect(page.get_by_text('Код не принят.', exact=False)).to_be_visible()
                expect(page.get_by_test_id('kiosk-demo-badge')).to_have_count(0)
                page.clock.fast_forward(2500)
                page.screenshot(path=str(OUT / f'access-error-{width}.png'))
                self.enter(page, locale)
                # Past the old 3-minute staff demo escape: still demo, never sales.
                page.clock.fast_forward(185000)
                expect(ui.element(page, 'kiosk-demo-badge')).to_be_visible()
                ui.element(page, 'kiosk-language-' + locale).click()
                self.order(page)
                expect(ui.element(page, 'kiosk-demo-qr-warning')).to_be_visible()
                ui.capture(page, f'review-qr-{width}.png')
                ui.element(page, 'kiosk-demo-paid').click()
                ui.screen(page, 'order')
                expect(ui.element(page, 'kiosk-order-number')).to_have_text('Д-123')
                ui.capture(page, f'review-order-{width}.png')
                ui.element(page, 'kiosk-demo-exit').click()
                expect(ui.element(page, 'kiosk-review-open')).to_be_visible()
                expect(page.get_by_test_id('kiosk-demo-badge')).to_have_count(0)
                page.reload()
                expect(ui.element(page, 'kiosk-review-open')).to_be_visible()
                self.enter(page)
                self.order(page)
                ui.element(page, 'kiosk-demo-unknown').click()
                expect(ui.element(page, 'kiosk-demo-badge')).to_be_visible()
                page.reload()
                expect(ui.element(page, 'kiosk-review-open')).to_be_visible()
                self.assertEqual(page.evaluate('Object.keys(localStorage).filter(k => /pickchick/.test(k))'), [])
        (OUT / 'result.json').write_text(json.dumps({'viewports': 3, 'apiRequests': 0, 'realOrders': 0, 'syntheticCode': True}))

if __name__ == '__main__':
    unittest.main()
