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
        expect(ui.element(page, 'kiosk-order-number')).to_have_text('№' + order['number'])
        expect(ui.element(page, 'kiosk-order-state')).to_have_text('Готовим ваш заказ')
        self.assertEqual(fixture.orders[order['order_id']]['payment_state'], 'simulated_approved')
        self.assertEqual(fixture.orders[order['order_id']]['state'], 'preparing')

        # The new ticket uses an opaque surface so number readability does not
        # depend on decorative imagery, gradient loading or reduced motion.
        ticket_surface = ui.element(page, 'kiosk-order-number').evaluate('''number => ({
            text: getComputedStyle(number).color,
            surface: getComputedStyle(number.parentElement).backgroundColor,
            screen: getComputedStyle(number.closest('[data-testid="kiosk-screen-order"]')).backgroundColor,
            fontSize: parseFloat(getComputedStyle(number).fontSize),
        })''')
        self.assertEqual(ticket_surface['surface'], 'rgb(255, 255, 255)')
        self.assertEqual(ticket_surface['screen'], 'rgb(0, 71, 187)')
        self.assertGreaterEqual(ticket_surface['fontSize'], 100)
        number_rect = ui.assert_bounded(page, 'kiosk-order-number', width, height)
        expect(ui.element(page, 'kiosk-order-number')).to_have_css('color', 'rgb(0, 71, 187)')
        ui.assert_bounded(page, 'kiosk-next-guest', width, height)
        ui.assert_no_overflow(page, width)
        ui.capture(page, 'web-order-ticket-1024.png')
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
            'ticket_surface': ticket_surface,
            'entrypoints': sorted(fixture.entrypoints),
            'unexpected_requests': fixture.unexpected,
            'network': 'Every API request fulfilled/aborted by local fixture; no VPS requests.',
        }, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    # Inherited helpers include the full suite: select only this bounded check.
    unittest.main(defaultTest='KioskPaymentSuccess.test_review_payment_and_readable_order_number',
                  verbosity=2)
