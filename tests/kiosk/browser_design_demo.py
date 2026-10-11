"""Staff demo mode on the exported kiosk web UI (owner decision 2026-10-11).

Run after exporting apps/kiosk, with the same environment as browser_ui.py. A 5 s hold on the
start screen logo turns the demo on; the whole guest path then reaches a non-payable QR and the
"Д-123" number while the local API fixture sees no quote, order or payment request at all.
"""
import json
import unittest

from playwright.sync_api import expect

import browser_ui as ui

ORDER_PATHS = ('/v1/test/quotes', '/v1/test/orders', '/v1/test/sessions')


def hold(page, identifier, milliseconds):
    box = ui.element(page, identifier).bounding_box()
    page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    page.mouse.down()
    page.wait_for_timeout(milliseconds)
    page.mouse.up()


class KioskDesignDemo(ui.KioskUI):
    def badge(self, page):
        expect(ui.element(page, 'kiosk-demo-badge')).to_be_visible()

    def test_logo_hold_demo_reaches_qr_and_number_without_orders(self):
        width, height = 820, 1180
        page, fixture = self.open(width, height)
        # A short touch on the logo does nothing.
        hold(page, 'kiosk-logo-hold', 800)
        page.wait_for_timeout(300)
        expect(page.get_by_test_id('kiosk-demo-dialog')).to_have_count(0)
        hold(page, 'kiosk-logo-hold', 5600)
        expect(page.get_by_text('Включить демо-режим?')).to_be_visible()
        ui.capture(page, 'demo-dialog-820.png')
        ui.element(page, 'kiosk-demo-confirm').click()
        ui.screen(page, 'welcome')
        self.badge(page)
        before = len(fixture.requests)

        self.start(page)
        self.badge(page)
        self.add(page)
        self.review(page)
        self.badge(page)
        # The demo checkout is ready even though no real checkout exists, and no notice is shown.
        expect(page.get_by_test_id('kiosk-error')).to_have_count(0)
        ui.element(page, 'kiosk-review-create').click()
        ui.screen(page, 'payment')
        self.badge(page)
        expect(page.get_by_text('ДЕМО - не оплачивать', exact=False)).to_be_visible()
        expect(ui.element(page, 'kiosk-demo-paid')).to_be_visible()
        ui.assert_no_overflow(page, width)
        ui.capture(page, 'demo-qr-820.png')

        ui.element(page, 'kiosk-demo-paid').click()
        ui.screen(page, 'order')
        self.badge(page)
        expect(ui.element(page, 'kiosk-order-number')).to_have_text('Д-123')
        ui.capture(page, 'demo-order-820.png')

        demo_requests = fixture.requests[before:]
        self.assertEqual([r for r in demo_requests if r['path'].startswith(ORDER_PATHS)], [])
        self.assertEqual(fixture.orders, {})
        self.assertEqual(fixture.unexpected, [])
        body = page.locator('body').inner_text()
        self.assertNotIn('не принимает заказы', body)

        # The badge leaves demo mode at once: the live kiosk is back on its start screen.
        ui.element(page, 'kiosk-demo-exit').click()
        ui.screen(page, 'welcome')
        expect(page.get_by_test_id('kiosk-demo-badge')).to_have_count(0)
        (ui.OUTPUT / 'design-demo-result.json').write_text(json.dumps({
            'viewport': {'width': width, 'height': height},
            'demo_number': 'Д-123',
            'requests_during_demo': [r['path'] for r in demo_requests],
            'orders_created': len(fixture.orders),
        }, ensure_ascii=False, indent=2) + '\n')

    def test_demo_is_off_after_reload(self):
        page, _ = self.open()
        hold(page, 'kiosk-logo-hold', 5600)
        ui.element(page, 'kiosk-demo-confirm').click()
        self.badge(page)
        page.reload()
        ui.screen(page, 'welcome')
        expect(page.get_by_test_id('kiosk-demo-badge')).to_have_count(0)


if __name__ == '__main__':
    # Inherited helpers include the full suite: select only the demo checks.
    unittest.main(defaultTest=[
        'KioskDesignDemo.test_logo_hold_demo_reaches_qr_and_number_without_orders',
        'KioskDesignDemo.test_demo_is_off_after_reload',
    ], verbosity=2)
