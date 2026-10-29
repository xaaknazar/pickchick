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
REVIEW_ACCOUNT_PROFILE=storefront runs the same checks on the App Store profile export
(PICKCHICK_PREVIEW_OUTPUT=storefront: the published catalogue, no test-order client; second
review 29.10.2026: the fixture served only /v1/test/catalog, so it timed out there).
"""
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from browser_network import route_fixture
import browser_slide_to_pay as bar
from browser_slide_to_pay import (BRANCH, DRAFT_KEY, URL, add, checkout_traffic, errors,
                                  new_state, release, slide)

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / os.environ.get('REVIEW_ACCOUNT_SHOTS', '.local/review-account')
OUT.mkdir(parents=True, exist_ok=True)
PROFILE = os.environ.get('REVIEW_ACCOUNT_PROFILE', 'qa')
assert PROFILE in ('qa', 'storefront'), PROFILE
STOREFRONT = PROFILE == 'storefront'
test_requests = []
if STOREFRONT:
    # The published storefront: the back-office seed of the same menu (as browser_store_walk.py).
    SEED = json.loads(subprocess.check_output(
        ['node', '--input-type=module', '-e',
         "import {mockupCatalogDraft} from './packages/catalog-admin/dist/seed.js';"
         "console.log(JSON.stringify(mockupCatalogDraft))"], cwd=ROOT, text=True))
    PUBLICATION = {'branch': {'id': BRANCH, 'code': 'ABAY', 'name': 'ТЦ Abay Plaza', 'timezone': 'Asia/Almaty',
                              'ordering_enabled': True},
                   'channel': 'mobile', 'version': 6, 'published_at': '2026-10-28T00:00:00.000Z',
                   'payload': {**SEED, 'content_source': 'operator', 'content_reviewed': True}}


def make_context(browser, state, width, height, reduced):
    ctx, page = bar.make_context(browser, state, width, height, reduced)
    if STOREFRONT:
        def storefront(route):
            path = urlparse(route.request.url).path
            cors = {'Access-Control-Allow-Origin': '*'}
            if path.startswith('/v1/test/'):
                test_requests.append(route.request.method + ' ' + path)
                return route.abort()
            if path == '/v1/customer-checkout/catalog':
                return route.fulfill(json=PUBLICATION, headers=cors)
            if path == '/v1/customer-checkout/availability':
                return route.fulfill(
                    json={'enabled': True, 'fresh': True, 'orderingOpen': True, 'signature': 'a' * 64,
                          'products': [{'id': p['id'], 'available': True, 'stoppedOptions': []}
                                       for p in SEED['products']]},
                    headers={**cors, 'X-Catalog-Version': str(PUBLICATION['version']),
                             'X-Availability-Signature': 'a' * 64,
                             'Access-Control-Expose-Headers': 'X-Catalog-Version, X-Availability-Signature'})
            if path == '/v1/capabilities':
                return route.fulfill(json={'schema_version': 1, 'environment': 'production',
                                           'data_mode': 'pilot', 'ordering_enabled': False,
                                           'features': {'phone_auth': True, 'test_order_flow': False,
                                                        **{k: False for k in ['payments', 'fiscal', 'checkout',
                                                                              'loyalty']}}},
                                     headers=cors)
            return route.fallback()
        # Registered after the shared fixture, so it answers these paths first.
        route_fixture(ctx, '**/v1/**', storefront)
    return ctx, page
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
    # The App Store profile has no test-order client at all.
    assert not test_requests, test_requests
    print(f'PASS App Review account ({PROFILE}, synthetic 403 FORBIDDEN on POST /orders): RU/EN/KK neutral text and '
          '«Как проходит заказ», no connecting scene or «Проверить оплату», one quote + one refused create '
          'per explicit press or slide, no invoice, nothing after 22 s, basket kept, intent dropped, '
          'demo opens with the basket, restart sends nothing; screenshots in ' + str(OUT))
