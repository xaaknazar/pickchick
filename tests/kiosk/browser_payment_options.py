"""Actual kiosk screens/controller through Storybook's in-memory payment adapter.

No device credentials, server requests, invoices or payable QR are created.
KIOSK_STORYBOOK_URL must point to this checkout's freshly built Storybook.
"""
import json
import os
import unittest
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

class PaymentOptions(unittest.TestCase):
    def test_only_qr_on_ipad_sizes(self):
        url = os.environ.get('KIOSK_STORYBOOK_URL', 'http://127.0.0.1:6008')
        self.assertTrue(url.startswith('http://127.0.0.1:'))
        output = Path(os.environ.get('KIOSK_PAYMENT_OUTPUT', '.local/payment-browser'))
        output.mkdir(parents=True, exist_ok=True)
        report = []
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for width, height in [(768,1024), (820,1180), (1024,1366)]:
                page = browser.new_page(viewport={'width': width,'height': height}, reduced_motion='reduce')
                errors, external = [], []
                page.on('pageerror', lambda e: errors.append(str(e)))
                def route(request):
                    target = urlparse(request.request.url)
                    if target.hostname == '127.0.0.1':
                        request.continue_()
                    else:
                        external.append(request.request.url)
                        request.abort()
                page.route('**/*', route)
                page.goto(url + '/iframe.html?id=kiosk-paymentcheckout--both-methods&viewMode=story&globals=a11y.manual:!true')
                qr = page.get_by_test_id('kiosk-payment-method-kaspi')
                invoice = page.get_by_test_id('kiosk-payment-method-kaspi_invoice')
                submit = page.get_by_test_id('kiosk-review-create')
                expect(submit).to_be_enabled()
                expect(qr).to_have_attribute('aria-checked','true')
                expect(invoice).to_have_count(0)
                expect(page.get_by_test_id('kiosk-invoice-phone')).to_have_count(0)
                expect(page.get_by_text('10-13', exact=False).first).to_be_visible()
                page.screenshot(path=str(output / f'qr-review-{width}.png'))
                submit.click()
                expect(page.get_by_test_id('kiosk-screen-payment')).to_be_visible()
                expect(page.get_by_test_id('kiosk-payment-qr')).to_be_visible()
                page.wait_for_function("[...document.images].every(i => i.complete && i.naturalWidth > 0)")
                page.get_by_test_id('kiosk-payment-qr').screenshot(path=str(output / f'qr-code-{width}.png'))
                page.screenshot(path=str(output / f'qr-waiting-{width}.png'))
                self.assertEqual(errors,[])
                self.assertEqual(external,[])
                report.append({'width':width,'height':height,'invoice':False,'qr':True,'errors':errors,'external_requests':external})
                page.close()
            browser.close()
        (output / 'result.json').write_text(json.dumps({'synthetic':True,'checks':report},indent=2)+'\n')

# Build 13 cloud kitchen checks share this Storybook run (the workflow file is held by another
# task): unittest.main also runs the TestCase imported here.
from browser_cloud_kitchen import CloudKitchen  # noqa: E402,F401

if __name__ == '__main__':
    unittest.main(verbosity=2)
