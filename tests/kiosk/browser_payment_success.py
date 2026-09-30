"""Targeted kiosk review/payment/number proof with the existing local API fixture.

Run after exporting apps/kiosk, with the same environment as browser_ui.py.
This deliberately runs one 1024x1366 journey, not the full kiosk suite. Every
API request is intercepted by browser_ui.Fixture; no real order or payment.
"""
import json
import unittest

from playwright.sync_api import expect

import browser_ui as ui


class KioskPaymentSuccess(ui.KioskUI):
    def test_review_payment_and_readable_order_number(self):
        width, height = 1024, 1366
        page, fixture = self.open(width, height)
        self.start(page)
        self.add(page)
        self.review(page)
        ui.screen(page, 'loyalty')
        self.assertEqual(len(fixture.orders), 0)

        # Both radios remain reachable; choosing one must update its actual
        # accessibility state rather than only the visual border.
        ui.element(page, 'kiosk-payment-method-card').click()
        expect(ui.element(page, 'kiosk-payment-method-card')).to_have_attribute('aria-checked', 'true')
        ui.element(page, 'kiosk-payment-method-kaspi').click()
        expect(ui.element(page, 'kiosk-payment-method-kaspi')).to_have_attribute('aria-checked', 'true')
        expect(ui.element(page, 'kiosk-payment-method-card')).to_have_attribute('aria-checked', 'false')
        ui.assert_bounded(page, 'kiosk-review-create', width, height)
        ui.assert_no_overflow(page, width)
        # S8 mounts a light pattern, header pattern and brand mark asynchronously.
        page.wait_for_function('''() => document.querySelector(
            '[data-testid="kiosk-screen-loyalty"]')?.querySelectorAll('img').length >= 3''')
        ui.capture(page, 'web-review-1024.png')

        ui.element(page, 'kiosk-review-create').click()
        ui.screen(page, 'payment')
        self.assertEqual(len(fixture.orders), 1)
        order = next(iter(fixture.orders.values()))
        self.assertEqual(order['state'], 'awaiting_test_payment')
        self.assertEqual(order['snapshot']['total_minor'], '419000')
        self.assertEqual(ui.stored(page, ui.FLOW_KEY)['paymentMethod'], 'kaspi')
        ui.assert_bounded(page, 'kiosk-payment-approve', width, height)
        ui.assert_no_overflow(page, width)
        expect(ui.element(page, 'kiosk-screen-payment').locator('img').first).to_be_visible()
        ui.capture(page, 'web-payment-1024.png')

        ui.element(page, 'kiosk-payment-approve').click()
        ui.screen(page, 'order')
        expect(ui.element(page, 'kiosk-order-number')).to_have_text(order['number'])
        expect(ui.element(page, 'kiosk-order-state')).to_have_text('Готовим ваш заказ')
        self.assertEqual(fixture.orders[order['order_id']]['payment_state'], 'simulated_approved')
        self.assertEqual(fixture.orders[order['order_id']]['state'], 'preparing')

        # Require the full-screen pattern image to have mounted before capture:
        # checking only existing images would vacuously pass during Expo Image
        # mounting, producing a misleading solid-blue success frame.
        page.wait_for_function('''() => {
            const root = document.querySelector('[data-testid="kiosk-screen-order"]');
            return root && [...root.querySelectorAll('img')].some(image => {
                const rect = image.getBoundingClientRect();
                return rect.width >= innerWidth - 1 && rect.height >= innerHeight - 1 &&
                    image.complete && image.naturalWidth > 0;
            });
        }''')
        gradients = ui.element(page, 'kiosk-screen-order').locator('div').evaluate_all('''elements =>
            elements.map(element => ({
                background: getComputedStyle(element).backgroundImage,
                width: element.getBoundingClientRect().width,
                height: element.getBoundingClientRect().height,
            })).filter(layer => layer.background.includes('linear-gradient') &&
                layer.width >= innerWidth - 1 && layer.height >= innerHeight - 1)
        ''')
        self.assertTrue(any('rgba(0, 40, 110, 0.74)' in layer['background'] and
                            'rgba(0, 26, 80, 0.92)' in layer['background']
                            for layer in gradients), gradients)
        number_rect = ui.assert_bounded(page, 'kiosk-order-number', width, height)
        expect(ui.element(page, 'kiosk-order-number')).to_have_css('color', 'rgb(255, 103, 31)')
        ui.assert_bounded(page, 'kiosk-next-guest', width, height)
        ui.assert_no_overflow(page, width)
        ui.capture(page, 'web-order-darkened-1024.png')
        self.assertEqual(len(fixture.orders), 1)
        creates = [r for r in fixture.requests
                   if r['method'] == 'POST' and r['path'] == '/v1/test/orders']
        payments = [r for r in fixture.requests if r['path'].endswith('/simulated-payment')]
        self.assertEqual(len(creates), 1)
        self.assertEqual(len(payments), 1)
        self.assertEqual(fixture.unexpected, [])
        (ui.OUTPUT / 'payment-success-result.json').write_text(json.dumps({
            'viewport': {'width': width, 'height': height},
            'order_number': order['number'],
            'order_state': fixture.orders[order['order_id']]['state'],
            'payment_state': fixture.orders[order['order_id']]['payment_state'],
            'total_minor': order['snapshot']['total_minor'],
            'order_creates': len(creates),
            'simulated_payment_commands': len(payments),
            'order_number_rect': number_rect,
            'full_screen_gradients': gradients,
            'entrypoints': sorted(fixture.entrypoints),
            'unexpected_requests': fixture.unexpected,
            'network': 'Every API request fulfilled/aborted by local fixture; no VPS requests.',
        }, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    # Inherited helpers include the full suite: select only this bounded check.
    unittest.main(defaultTest='KioskPaymentSuccess.test_review_payment_and_readable_order_number',
                  verbosity=2)
