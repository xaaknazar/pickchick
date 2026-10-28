"""Staff-only kiosk health line on the exported kiosk web UI (stage 2, lane kln).

Run after exporting apps/kiosk, with the same environment as browser_ui.py. The web export is the
simulator build (no commercial flag, no staff code), so the 5 s logo hold opens the staff dialog
and its "Состояние киоска" action shows the health line at once, with the commercial, staff code,
release and device presence facts marked for a check. No order, session or payment request is
sent; the commercial kiosk's server-checked code is covered by tests/kiosk/kiosk-health.test.mjs.
"""
import unittest

from playwright.sync_api import expect

import browser_ui as ui
from browser_design_demo import hold

ORDER_PATHS = ('/v1/test/quotes', '/v1/test/orders', '/v1/test/sessions')
FACTS = ('build', 'api', 'commercial', 'staff', 'heartbeat')


class KioskStaffHealth(ui.KioskUI):
    def test_staff_hold_opens_the_health_line_without_guest_effects(self):
        for width, height, locale in [(744, 1133, 'ru'), (1024, 1366, 'en')]:
            with self.subTest(width=width, locale=locale):
                page, fixture = self.open(width, height)
                if locale != 'ru':
                    ui.element(page, 'kiosk-language-' + locale).click()
                before = len(fixture.requests)
                hold(page, 'kiosk-logo-hold', 5600)
                expect(ui.element(page, 'kiosk-demo-dialog')).to_be_visible()
                ui.capture(page, f'staff-dialog-{width}.png')
                ui.element(page, 'kiosk-staff-health').click()
                expect(ui.element(page, 'kiosk-health')).to_be_visible()
                for fact in FACTS:
                    expect(ui.element(page, 'kiosk-health-' + fact)).to_be_visible()
                # The simulator build is never a restaurant build: these facts ask for a check.
                for fact in ('commercial', 'staff', 'heartbeat', 'build'):
                    expect(ui.element(page, f'kiosk-health-{fact}-check')).to_be_visible()
                text = ui.element(page, 'kiosk-health').inner_text()
                # A development export: the staging (or explicit local) API, never production.
                self.assertRegex(ui.element(page, 'kiosk-health-api').inner_text(),
                                 r'https?://\S+ \(staging\)')
                if locale == 'ru':
                    self.assertIn('Коммерческий режим', text)
                    self.assertIn('выключен - сборка без оплаты', text)
                else:
                    self.assertIn('Commercial mode', text)
                    self.assertIn('off - build without payments', text)
                ui.assert_no_overflow(page, width)
                ui.capture(page, f'staff-health-{width}.png')
                # Closing forgets the line: the next opening shows the staff actions again.
                ui.element(page, 'kiosk-demo-dismiss').click()
                expect(page.get_by_test_id('kiosk-demo-dialog')).to_have_count(0)
                hold(page, 'kiosk-logo-hold', 5600)
                expect(ui.element(page, 'kiosk-staff-health')).to_be_visible()
                expect(page.get_by_test_id('kiosk-health')).to_have_count(0)
                ui.element(page, 'kiosk-demo-dismiss').click()
                ui.screen(page, 'welcome')
                expect(page.get_by_test_id('kiosk-demo-badge')).to_have_count(0)
                self.assertEqual([r for r in fixture.requests[before:]
                                  if r['path'].startswith(ORDER_PATHS)], [])
                self.assertEqual(fixture.orders, {})
                self.assertEqual(fixture.unexpected, [])


if __name__ == '__main__':
    # Inherited helpers include the full suite: select only the health check.
    unittest.main(defaultTest=[
        'KioskStaffHealth.test_staff_hold_opens_the_health_line_without_guest_effects',
    ], verbosity=2)
