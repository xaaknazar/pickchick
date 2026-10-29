"""EXPO_PUBLIC_UPCOMING_PAYMENTS=1 in a browser (review 29.10.2026: until now only unit-tested).

The flag brings back the owner's 27.10 list in «Способ оплаты»: Kaspi.kz chosen, Apple Pay (Google
Pay on Android) and «Банковская карта» greyed out with «СКОРО», not selectable. Off by default and
dropped from every release archive (scripts/mobile/ios_release.py); this export exists only to show
the owner what the flag does. Checks at 393 x 852:
  - the selector lists three rows, only Kaspi.kz is a choosable radio, the other two are disabled
    with «СКОРО» and their accessible name «..., скоро»; a tap on them changes nothing;
  - the cart bar handle and the pay button stay Kaspi; nothing is sent while looking.
Export: EXPO_PUBLIC_CUSTOMER_AUTH=server EXPO_PUBLIC_KASPI_CHECKOUT=1 EXPO_PUBLIC_UNPAID_TEST_ORDERS=1
EXPO_PUBLIC_PUBLISHED_CATALOG=0 EXPO_PUBLIC_UPCOMING_PAYMENTS=1; URL in UPCOMING_PAYMENTS_URL.
"""
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from browser_slide_to_pay import add, checkout_traffic, errors, make_context, new_state, release

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('UPCOMING_PAYMENTS_URL', 'http://127.0.0.1:4198').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost')
OUT = ROOT / os.environ.get('UPCOMING_PAYMENTS_SHOTS', '.local/upcoming-payments')
OUT.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch()
    state = new_state()
    ctx, page = make_context(browser, state, 393, 852, 'reduce')
    page.goto(URL + '/menu')
    add(page)
    expect(page.get_by_test_id('cart-pay-handle').filter(visible=True)).to_have_attribute(
        'aria-label', 'Оплатить через Kaspi', timeout=15000)
    page.get_by_test_id('open-cart').click()
    expect(page.get_by_test_id('screen-M09').get_by_test_id('cart-pay')).to_contain_text('Kaspi.kz', timeout=15000)
    page.get_by_test_id('cart-payment-method').click()
    sheet = page.get_by_test_id('cart-payment-sheet')
    expect(sheet).to_be_visible()
    expect(sheet.get_by_role('radio')).to_have_count(3)
    expect(page.get_by_test_id('cart-payment-kaspi')).to_have_attribute('aria-checked', 'true')
    for method, name in (('apple_pay', 'Apple Pay'), ('card', 'Банковская карта')):
        row = page.get_by_test_id('cart-payment-' + method)
        expect(row).to_have_attribute('aria-disabled', 'true')
        expect(row).to_have_attribute('aria-label', f'{name}, скоро')
        expect(row).to_contain_text('СКОРО')
        # Disabled: a tap (forced past Playwright's own enabled check) chooses nothing.
        row.click(force=True)
        expect(sheet).to_be_visible()
        expect(page.get_by_test_id('cart-payment-kaspi')).to_have_attribute('aria-checked', 'true')
    page.screenshot(path=str(OUT / 'selector-flag-393.png'))
    page.get_by_test_id('cart-payment-close').click()
    expect(page.get_by_test_id('screen-M09').get_by_test_id('cart-pay')).to_contain_text('Kaspi.kz')
    assert not checkout_traffic(state), checkout_traffic(state)
    release(state)
    ctx.close()
    browser.close()
assert not errors, errors
print('PASS EXPO_PUBLIC_UPCOMING_PAYMENTS=1: «Способ оплаты» shows Kaspi.kz chosen, Apple Pay and the bank card '
      'disabled with «СКОРО» (not choosable), the handle and the pay button stay Kaspi, nothing sent; '
      'screenshot in ' + str(OUT))
