"""Kiosk redesign 2026-10-13: the Kaspi QR payment screen and «Начать заново».

Run after exporting apps/kiosk, with the same environment as browser_ui.py. The exported web
build runs the test simulator, which has no Kaspi QR; the commercial controller with its QR is
reached through the staff demo mode (owner decision 2026-10-11): a 5 s hold on the start logo,
then the in-memory demo transport. The demo QR is not payable and every screen carries the
«ДЕМО» badge, the demo warning and the demo outcome buttons; the rest is the live layout.

Checked: the QR screen on the 13-inch (1024x1366), 11-inch (820x1180) and mini (744x1133) iPads
in RU, plus KZ and EN on the 13-inch, with nothing cut and every action on screen; and
«Начать заново» -> «Начать заново?» -> the start screen. After it the abandoned demo order is
never read or settled again (it would turn paid after 12 s if it were), and the next guest's
order is a new one that becomes the first paid demo number. The local API fixture sees no quote,
order or payment request at all. Screenshots go to KIOSK_REDESIGN_OUTPUT (default
.local/kiosk-redesign-payment).
"""
import json
import os
import unittest
from pathlib import Path

from playwright.sync_api import expect

import browser_ui as ui

OUTPUT = Path(os.environ.get('KIOSK_REDESIGN_OUTPUT', '.local/kiosk-redesign-payment'))
SIZES = [(1024, 1366), (820, 1180), (744, 1133)]
ORDER_PATHS = ('/v1/test/quotes', '/v1/test/orders', '/v1/test/sessions')
# Texts cut by an ellipsis or a line clamp (Montserrat Black glyphs may rise a few points above
# their line box; that is not a cut).
CUT_TEXT = '''(root) => [...root.querySelectorAll('div')].filter((e) => {
    const s = getComputedStyle(e);
    const clamp = s.webkitLineClamp && s.webkitLineClamp !== 'none';
    if (s.textOverflow !== 'ellipsis' && !clamp) return false;
    return e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 4;
}).map((e) => e.textContent)'''
COPY = {
    'ru': {'title': 'Оплата', 'restart': 'Начать заново', 'staff': 'Позвать сотрудника',
           'waiting': 'Ждём оплату - экран обновится сам', 'step': 'Откройте Kaspi.kz',
           'valid': 'QR действует', 'cancel': 'Отменить оплату'},
    'kk': {'title': 'Төлем', 'restart': 'Басынан бастау', 'staff': 'Қызметкерді шақыру',
           'waiting': 'Төлемді күтеміз - экран өзі жаңарады', 'step': 'Kaspi.kz ашыңыз',
           'valid': 'QR жарамды', 'cancel': 'Төлемді тоқтату'},
    'en': {'title': 'Payment', 'restart': 'Start over', 'staff': 'Call a team member',
           'waiting': 'Waiting for payment - the screen updates itself', 'step': 'Open Kaspi.kz',
           'valid': 'QR valid for', 'cancel': 'Cancel payment'},
}


def hold(page, identifier, milliseconds):
    box = ui.element(page, identifier).bounding_box()
    page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    page.mouse.down()
    page.wait_for_timeout(milliseconds)
    page.mouse.up()


def capture(page, filename):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    previous = ui.OUTPUT
    ui.OUTPUT = OUTPUT
    try:
        ui.capture(page, filename)
    finally:
        ui.OUTPUT = previous


class RedesignPayment(ui.KioskUI):
    def open(self, width=1024, height=1366, catalog=None):
        # The page clock runs on real time until the QR is shown, then holds the wall time so
        # the demo QR neither counts down nor turns paid while the screens are checked.
        context = self.browser.new_context(viewport={'width': width, 'height': height},
                                           reduced_motion='reduce')
        context.clock.install()
        fixture = ui.Fixture(catalog or self.catalog)
        context.route('**/*', fixture.route)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        self.contexts.append((context, page, fixture, errors))
        page.goto(ui.URL)
        ui.screen(page, 'welcome')
        return page, fixture

    def demo_qr(self, width, height):
        """The staff demo from the start logo to its Kaspi QR, with three items in the order."""
        page, fixture = self.open(width, height)
        hold(page, 'kiosk-logo-hold', 5600)
        ui.element(page, 'kiosk-demo-confirm').click()
        expect(ui.element(page, 'kiosk-demo-badge')).to_be_visible()
        before = len(fixture.requests)
        self.start(page)
        self.add(page)
        ui.element(page, 'kiosk-menu-checkout').click()
        ui.screen(page, 'upsell')
        for product in ('sauce', 'lemonade'):
            plus = page.get_by_test_id('kiosk-upsell-plus-' + product).filter(visible=True)
            if plus.count():
                plus.click()
                expect(ui.element(page, 'kiosk-product-sheet')).to_be_visible()
                ui.element(page, 'kiosk-sheet-add').click()
        ui.element(page, 'kiosk-upsell-continue').click()
        # The demo offers QR and invoice, so the method screen stays in the path.
        ui.screen(page, 'loyalty')
        ui.element(page, 'kiosk-payment-method-kaspi').click()
        ui.element(page, 'kiosk-review-create').click()
        ui.screen(page, 'payment')
        expect(ui.element(page, 'kiosk-payment-qr')).to_be_visible()
        # Playwright's Python clock takes seconds.
        page.clock.set_fixed_time((page.evaluate('Date.now()') + 1500) / 1000)
        return page, fixture, before

    def check_screen(self, page, width, height, locale):
        text = COPY[locale]
        screen = ui.element(page, 'kiosk-screen-payment')
        expect(screen.get_by_role('heading', name=text['title'])).to_be_visible()
        expect(screen.get_by_role('heading', name='Kaspi QR')).to_be_visible()
        expect(ui.element(page, 'kiosk-step-payment')).to_be_visible()
        expect(ui.element(page, 'kiosk-payment-qr-plate')).to_be_visible()
        expect(ui.element(page, 'kiosk-payment-qr-timer')).to_contain_text(text['valid'])
        expect(ui.element(page, 'kiosk-payment-qr-timer')).to_contain_text('02:5')
        expect(ui.element(page, 'kiosk-payment-steps')).to_contain_text(text['step'])
        expect(ui.element(page, 'kiosk-payment-waiting-status')).to_have_text(text['waiting'])
        expect(ui.element(page, 'kiosk-payment-restart')).to_have_text(text['restart'])
        # The staff demo previews its own cancellation where the live screen calls staff.
        expect(ui.element(page, 'kiosk-payment-cancel')).to_have_text(text['cancel'])
        expect(page.get_by_test_id('kiosk-payment-stars')).to_have_attribute('aria-hidden', 'true')
        for identifier in ['kiosk-header-help', 'kiosk-language-kk', 'kiosk-language-ru',
                           'kiosk-language-en', 'kiosk-step-pills', 'kiosk-payment-restart',
                           'kiosk-payment-cancel']:
            ui.assert_bounded(page, identifier, width, height)
        ui.assert_no_overflow(page, width)
        self.assertEqual(screen.evaluate(CUT_TEXT), [], 'A text of the QR screen is cut')
        # Every part of the screen is on it without scrolling, the panel last.
        panel = ui.element(page, 'kiosk-payment-panel').bounding_box()
        self.assertLessEqual(panel['y'] + panel['height'], height + 1)
        for identifier in ['kiosk-payment-amount', 'kiosk-payment-qr-plate',
                           'kiosk-payment-qr-timer', 'kiosk-payment-steps', 'kiosk-demo-paid']:
            rect = ui.element(page, identifier).bounding_box()
            assert rect['x'] >= 0 and rect['x'] + rect['width'] <= width + 1, (identifier, rect)
            assert rect['y'] >= 0 and rect['y'] + rect['height'] <= panel['y'] + 1, (identifier, rect)
        qr = ui.element(page, 'kiosk-payment-qr').bounding_box()
        plate = ui.element(page, 'kiosk-payment-qr-plate').bounding_box()
        return {'qr': qr, 'plate': plate, 'panel': panel}

    def test_qr_screen_on_three_ipads_and_in_three_languages(self):
        report = []
        for width, height in SIZES:
            with self.subTest(width=width):
                page, fixture, before = self.demo_qr(width, height)
                geometry = self.check_screen(page, width, height, 'ru')
                expect(ui.element(page, 'kiosk-header-subtitle')).to_have_text('С собой')
                expect(ui.element(page, 'kiosk-payment-items')).to_contain_text('Pick Combo')
                capture(page, f'payment-qr-{width}.png')
                report.append({'width': width, 'height': height, 'locale': 'ru', **geometry})
                if width == 1024:
                    for locale in ('kk', 'en'):
                        ui.element(page, 'kiosk-language-' + locale).click()
                        geometry = self.check_screen(page, width, height, locale)
                        capture(page, f'payment-qr-{locale}-{width}.png')
                        report.append({'width': width, 'height': height, 'locale': locale,
                                       **geometry})
                self.assertEqual([r for r in fixture.requests[before:]
                                  if r['path'].startswith(ORDER_PATHS)], [])
        (OUTPUT / 'payment-qr-result.json').write_text(json.dumps(
            {'synthetic': True, 'mode': 'staff demo (in-memory transport)', 'checks': report},
            ensure_ascii=False, indent=2) + '\n')

    def test_start_over_returns_to_start_and_leaves_the_old_order_alone(self):
        width, height = 1024, 1366
        page, fixture, before = self.demo_qr(width, height)
        # The dialog first: going back keeps the QR.
        ui.element(page, 'kiosk-payment-restart').click()
        dialog = ui.element(page, 'kiosk-restart-dialog')
        expect(dialog).to_contain_text('Начать заново?')
        expect(dialog).to_contain_text(
            'Заказ не будет оплачен, корзина очистится. Если вы уже оплатили - не нажимайте, '
            'позовите сотрудника.')
        expect(ui.element(page, 'kiosk-restart-dismiss')).to_have_text('Вернуться к оплате')
        expect(ui.element(page, 'kiosk-restart-confirm')).to_have_text('Начать заново')
        capture(page, f'payment-restart-dialog-{width}.png')
        ui.element(page, 'kiosk-restart-dismiss').click()
        expect(page.get_by_test_id('kiosk-restart-dialog')).to_have_count(0)
        expect(ui.element(page, 'kiosk-payment-qr')).to_be_visible()
        # «Позвать сотрудника» on the live screen is the help dialog; in the demo it is the
        # cancellation preview. Help stays one tap away in the header.
        ui.element(page, 'kiosk-header-help').click()
        expect(ui.element(page, 'kiosk-help')).to_be_visible()
        ui.element(page, 'kiosk-help').get_by_role('button', name='Закрыть').click()
        expect(page.get_by_test_id('kiosk-help')).to_have_count(0)

        ui.element(page, 'kiosk-payment-restart').click()
        ui.element(page, 'kiosk-restart-confirm').click()
        ui.screen(page, 'welcome')
        expect(page.get_by_test_id('kiosk-screen-payment')).to_have_count(0)
        expect(page.get_by_test_id('kiosk-restart-dialog')).to_have_count(0)
        expect(ui.element(page, 'kiosk-demo-badge')).to_be_visible()
        capture(page, f'payment-restart-start-{width}.png')
        # Time runs again: an abandoned demo QR would turn paid after 12 s if it were read.
        page.clock.set_system_time(page.evaluate('Date.now()') / 1000)
        page.wait_for_timeout(14000)
        ui.screen(page, 'welcome')
        expect(page.get_by_test_id('kiosk-order-number')).to_have_count(0)

        # The next guest: a fresh order and QR, and its payment is the first paid demo number,
        # so nothing settled the abandoned order in between.
        self.start(page)
        self.add(page)
        ui.element(page, 'kiosk-menu-checkout').click()
        ui.screen(page, 'upsell')
        ui.element(page, 'kiosk-upsell-continue').click()
        ui.screen(page, 'loyalty')
        ui.element(page, 'kiosk-payment-method-kaspi').click()
        ui.element(page, 'kiosk-review-create').click()
        ui.screen(page, 'payment')
        expect(ui.element(page, 'kiosk-payment-qr')).to_be_visible()
        expect(ui.element(page, 'kiosk-payment-items')).to_have_text('Pick Combo')
        ui.element(page, 'kiosk-demo-paid').click()
        ui.screen(page, 'order')
        expect(ui.element(page, 'kiosk-order-number')).to_have_text('Д-123')
        self.assertEqual([r for r in fixture.requests[before:]
                          if r['path'].startswith(ORDER_PATHS)], [])
        self.assertEqual(fixture.orders, {})
        (OUTPUT / 'payment-restart-result.json').write_text(json.dumps({
            'synthetic': True,
            'mode': 'staff demo (in-memory transport)',
            'restart': 'dialog -> start screen',
            'abandoned_order_settled': False,
            'next_order_number': 'Д-123',
            'live_api_order_requests': 0,
        }, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    # RedesignPayment inherits browser_ui's helpers and tests: run only these checks.
    unittest.main(defaultTest=[f'RedesignPayment.{name}' for name in vars(RedesignPayment)
                               if name.startswith('test_')], verbosity=2)
