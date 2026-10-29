"""App Review account on the payment step (review 29.10.2026, brief addendum A).

The production server answers 403 FORBIDDEN to POST /v1/customer-checkout/orders for the App Review
phone (services/api/src/customer-checkout-controller.ts). Before this fix the cart kept
«Связываемся с рестораном» with «Проверить оплату», which resent POST /orders, and after 20 s said
«Ресторан не подтверждает заказ»; the FORBIDDEN text read «Оплата Kaspi ещё не открыта для вашего
аккаунта». Here the fixture answers a synthetic 403 FORBIDDEN on POST /orders (the quote is fine)
and the test checks, in RU (393 x 852), EN and KK (320 x 568), pressing «Оплатить» and sliding the
cart bar:
  - the cart shows «Для этого аккаунта оплата заказов выключена. Как проходит заказ - можно
    посмотреть без оплаты.» (EN «Ordering is turned off for this account...») and the button
    «Как проходит заказ» / «How ordering works»; no connecting scene, no «Проверить оплату»;
  - exactly one quote and one refused create per explicit action, no invoice (/payment) ever, and
    nothing more after 22 s (past the 20 s «restaurant does not answer» threshold);
  - the basket keeps its line, the saved intent is gone, a reload sends nothing and shows no
    resume banner;
  - «Как проходит заказ» opens /demo-order with this basket and sends nothing.
Runs against the customer-auth web export (CUSTOMER_AUTH_URL) with local fixtures only.
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
import browser_slide_to_pay as bar
from browser_slide_to_pay import (DRAFT_KEY, URL, add, checkout_traffic, errors, make_context,
                                  new_state, release, slide)

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / os.environ.get('REVIEW_ACCOUNT_SHOTS', '.local/review-account')
OUT.mkdir(parents=True, exist_ok=True)
TEXT = {
    'ru': ('Для этого аккаунта оплата заказов выключена. Как проходит заказ - можно посмотреть без оплаты.',
           'Как проходит заказ'),
    'en': ('Ordering is turned off for this account. You can see how ordering works without payment.',
           'How ordering works'),
    'kk': ('Бұл аккаунт үшін тапсырыстарды төлеу өшірілген. Тапсырыстың қалай өтетінін төлемсіз көруге болады.',
           'Тапсырыс қалай орындалады'),
}
STUCK = ('Связываемся с рестораном', 'Ресторан не подтверждает заказ', 'Проверить оплату',
         'The restaurant has not confirmed', 'Contacting the restaurant')


def body(page):
    return page.evaluate('document.body.innerText')


def set_language(page, language):
    page.goto(URL + '/screen/M34')
    page.get_by_test_id('language-' + language).click(timeout=25000)
    expect(page.get_by_test_id('language-' + language)).to_have_attribute('aria-checked', 'true')


def refused_in_cart(page, state, language, actions):
    text, button = TEXT[language]
    notice = page.get_by_test_id('checkout-forbidden')
    expect(notice).to_be_visible(timeout=15000)
    expect(notice).to_contain_text(text)
    expect(page.get_by_test_id('checkout-forbidden-demo')).to_have_text(button)
    expect(page.get_by_test_id('kaspi-connecting')).to_have_count(0)
    expect(page.get_by_test_id('kaspi-close-order')).to_have_count(0)
    expect(page.get_by_test_id('cart-quantity-pick-combo')).to_have_text('1')
    assert page.evaluate('(key) => localStorage.getItem(key)', DRAFT_KEY) is None, 'intent dropped'
    assert (state['quotes'], state['creates'], state['payments']) == (actions, actions, 0), state
    assert not any(stuck in body(page) for stuck in STUCK), body(page)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'horizontal scroll'


def scenario_press_wait_demo(browser):
    state = new_state(forbid_orders=True)
    ctx, page = make_context(browser, state, 393, 852, 'reduce')
    page.goto(URL + '/menu')
    add(page)
    page.get_by_test_id('open-cart').click()
    expect(bar.pay_button(page)).to_be_enabled(timeout=15000)
    bar.pay_button(page).click()
    refused_in_cart(page, state, 'ru', 1)
    page.screenshot(path=str(OUT / 'forbidden-ru-393.png'))
    # No retry loop: nothing more after the 20 s threshold of «Ресторан не подтверждает заказ».
    page.wait_for_timeout(22000)
    refused_in_cart(page, state, 'ru', 1)
    assert not any('/payment' in path for path in state['paths']), state['paths']
    # A second explicit press is one more quote and one more refused create, never more.
    bar.pay_button(page).click()
    page.wait_for_timeout(3000)
    refused_in_cart(page, state, 'ru', 2)
    # «Как проходит заказ»: the demonstration with this basket, nothing sent.
    before = len(checkout_traffic(state))
    page.get_by_test_id('checkout-forbidden-demo').click()
    expect(page.get_by_test_id('demo-start')).to_be_visible(timeout=15000)
    assert page.url.split('?')[0].endswith('/demo-order'), page.url
    page.screenshot(path=str(OUT / 'forbidden-demo-393.png'))
    page.get_by_test_id('demo-start').click()
    expect(page.get_by_test_id('demo-approve')).to_be_visible()
    expect(page.get_by_test_id('review-demo')).to_contain_text('Pick Combo')
    assert len(checkout_traffic(state)) == before, checkout_traffic(state)
    # A restart: no resume banner, no request that could create an order, the basket is kept.
    page.goto(URL + '/menu')
    expect(page.get_by_test_id('cart-shortcut').filter(visible=True)).to_be_visible(timeout=25000)
    page.wait_for_timeout(3000)
    expect(page.get_by_test_id('payment-resume-banner')).to_have_count(0)
    assert len(checkout_traffic(state)) == before, checkout_traffic(state)
    release(state)
    ctx.close()


def scenario_language(browser, language, via_slide):
    state = new_state(forbid_orders=True)
    ctx, page = make_context(browser, state, 320, 568, 'reduce')
    set_language(page, language)
    page.goto(URL + '/menu')
    add(page)
    if via_slide:
        slide(page, 1.0)
    else:
        page.get_by_test_id('open-cart').click()
        expect(bar.pay_button(page)).to_be_enabled(timeout=15000)
        bar.pay_button(page).click()
    refused_in_cart(page, state, language, 1)
    page.screenshot(path=str(OUT / f'forbidden-{language}-{"slide" if via_slide else "press"}-320.png'))
    page.wait_for_timeout(3000)
    refused_in_cart(page, state, language, 1)
    release(state)
    ctx.close()


if __name__ == '__main__':
    with sync_playwright() as p:
        browser = p.chromium.launch()
        scenario_press_wait_demo(browser)
        scenario_language(browser, 'en', via_slide=False)
        scenario_language(browser, 'kk', via_slide=True)
        scenario_language(browser, 'ru', via_slide=True)
        browser.close()
    assert not errors, errors
    print('PASS App Review account (synthetic 403 FORBIDDEN on POST /orders): RU/EN/KK neutral text and '
          '«Как проходит заказ», no connecting scene or «Проверить оплату», one quote + one refused create '
          'per explicit press or slide, no invoice, nothing after 22 s, basket kept, intent dropped, '
          'demo opens with the basket, restart sends nothing; screenshots in ' + str(OUT))
