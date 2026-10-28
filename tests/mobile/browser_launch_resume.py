"""The app always opens on the menu, never on a payment screen (owner 28.10.2026, TestFlight 26).

Owner: «Мы закрыли оплату (X). Закрыли приложение, вышли, обратно заходим - сразу выходит окно
"Отправляется счёт". При входе должна открываться главная страница.»

Runs against the customer-auth web export (EXPO_PUBLIC_CUSTOMER_AUTH=server,
EXPO_PUBLIC_KASPI_CHECKOUT=1, EXPO_PUBLIC_UNPAID_TEST_ORDERS=1, EXPO_PUBLIC_PUBLISHED_CATALOG=0)
with local fixtures only: no bank, no real customer, no VPS request. A relaunch is a new page in
the same browser storage (the app's AsyncStorage is localStorage on the web).
  A  slide -> «Отправляем счёт» stays -> X -> relaunch: the menu (not /checkout), no payment
     state, no banner for the closed intent, zero POST; the cart opens as the cart; a changed cart
     paid again reopens the same order with «Это ваш прошлый заказ ...» and creates or sends
     nothing (1 quote, 1 order, 1 payment command in all); relaunched again on the cart route,
     the cart is the cart
  B  slide -> invoice in Kaspi -> the app is closed without X (iOS killed it): relaunch -> the
     menu with «Заказ ждёт оплаты в Kaspi - Открыть заказ» above the cart bar (393 and 320 pt,
     44 pt targets, the menu content ends above it); «Открыть заказ» opens the payment state of the same order (GET only); its X
     closes it for good: back on the menu without the banner, a relaunch shows none
  C  the banner's own X hides it for good (closedAt in the intent), also after a relaunch; the cart
     then opens as the cart; nothing is sent
  D  paid in Kaspi while the app was closed: relaunch -> the menu, no banner, the intent is
     removed and the paid lines leave the restored cart (as the payment screen does)
  E  «sending» not closed + relaunch: the banner says «Проверяем оплату заказа», never
     «Отправляем счёт»; the RU/KK/EN wording fits at 320 pt with large text
"""
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from browser_slide_to_pay import (URL, DRAFT_KEY, add, content_bottom, errors, make_context,
                                  new_state, pay_button, posts, release, slide, stored, wait_quiet)
from browser_checkout_traps import order

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / os.environ.get('LAUNCH_RESUME_SHOTS', '.local/launch-resume')
OUT.mkdir(parents=True, exist_ok=True)
ORDER_ID = order('sending')['orderId']
MESSAGES = json.loads((ROOT / 'apps/mobile/src/i18n/messages.json').read_text())


def counts(state):
    return state['quotes'], state['creates'], state['payments']


def path(page):
    return urlparse(page.url).path.rstrip('/') or '/'


def relaunch(ctx, page, route='/'):
    """Close the app and open it again: a new page in the same storage."""
    page.close()
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL + route)
    return page


def on_menu(page):
    expect(page.get_by_test_id('screen-M06').filter(visible=True)).to_be_visible(timeout=25000)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=15000)
    assert path(page) == '/menu', page.url
    for scene in ('kaspi-waiting', 'kaspi-connecting', 'kaspi-paid', 'kaspi-failed'):
        expect(page.get_by_test_id(scene)).to_have_count(0)
    expect(page.get_by_test_id('screen-M12')).to_have_count(0)
    expect(page.get_by_test_id('order-sheet')).to_have_count(0)
    expect(page.get_by_text('Отправляем счёт', exact=False)).to_have_count(0)


def banner(page):
    return page.get_by_test_id('payment-resume-banner').filter(visible=True)


def banner_geometry(page, width):
    box = banner(page).bounding_box()
    tabs = page.get_by_test_id('floating-tab-bar').bounding_box()
    assert box and box['x'] >= 0 and box['x'] + box['width'] <= width, (box, width)
    assert box['y'] + box['height'] <= tabs['y'], (box, tabs)
    bar = page.get_by_test_id('cart-shortcut').filter(visible=True)
    if bar.count():
        cart = bar.bounding_box()
        assert box['y'] + box['height'] <= cart['y'], ('above the cart bar', box, cart)
    for test_id in ('payment-resume-open', 'payment-resume-close'):
        target = page.get_by_test_id(test_id).filter(visible=True).bounding_box()
        assert target['height'] >= 44 and target['width'] >= 44, (test_id, target)
        hit = page.evaluate('([x, y, id]) => !!document.elementFromPoint(x, y)?.closest(`[data-testid="${id}"]`)',
                            [target['x'] + target['width'] / 2, target['y'] + target['height'] / 2, test_id])
        assert hit, ('covered', test_id)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    return box


def scenario_closed_sending(browser, width, height):
    # The owner's report on TestFlight 26, step by step.
    state = new_state(pay_result='sending')
    ctx, page = make_context(browser, state, width, height, 'reduce')
    page.goto(URL + '/menu')
    add(page)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
    expect(page.get_by_test_id('cart-pay-handle').filter(visible=True)).to_be_visible(timeout=15000)
    slide(page, 1.0)
    scene = page.get_by_test_id('kaspi-waiting')
    expect(scene).to_contain_text('Отправляем счёт', timeout=15000)
    for _ in range(100):
        if state['payments']:
            break
        page.wait_for_timeout(100)
    assert counts(state) == (1, 1, 1), state
    page.get_by_test_id('kaspi-state-close').click()
    page.get_by_test_id('kaspi-close-confirm').click()
    expect(pay_button(page)).to_be_enabled(timeout=10000)
    saved = stored(page, DRAFT_KEY, orderId=ORDER_ID, sendInvoice=False)
    # «Closed» is written into the intent itself (before: only in this run's memory).
    assert isinstance(saved.get('closedAt'), int) and saved['closedAt'] > 0, saved
    before = len(posts(state))
    # Relaunch: the menu, never the payment screen; nothing for the closed intent.
    page = relaunch(ctx, page)
    on_menu(page)
    wait_quiet(page, 3000)
    on_menu(page)
    expect(page.get_by_test_id('payment-resume-banner')).to_have_count(0)
    assert len(posts(state)) == before, posts(state)[before:]
    assert json.loads(page.evaluate('(key) => localStorage.getItem(key)', DRAFT_KEY))['closedAt'] == saved['closedAt']
    page.screenshot(path=str(OUT / f'A-relaunch-menu-{width}.png'))
    # The cart opens as the cart: its line, its pay button, no payment state.
    page.get_by_test_id('open-cart').filter(visible=True).click()
    expect(page.get_by_test_id('screen-M09')).to_be_visible(timeout=10000)
    expect(pay_button(page)).to_be_enabled(timeout=15000)
    expect(page.get_by_test_id('cart-quantity-pick-combo')).to_have_text('1')
    wait_quiet(page, 1500)
    expect(page.get_by_test_id('kaspi-waiting')).to_have_count(0)
    assert len(posts(state)) == before, posts(state)[before:]
    page.screenshot(path=str(OUT / f'A-relaunch-cart-{width}.png'))
    # Paying again (here with a changed cart) reopens the same order and says which one it is;
    # no new quote, order or payment command.
    page.get_by_test_id('cart-plus-pick-combo').click()
    expect(page.get_by_test_id('cart-quantity-pick-combo')).to_have_text('2')
    expect(pay_button(page)).to_be_enabled(timeout=10000)
    pay_button(page).click()
    scene = page.get_by_test_id('kaspi-waiting')
    expect(scene).to_contain_text('Отправляем счёт', timeout=10000)
    earlier = page.get_by_test_id('kaspi-earlier-order')
    expect(earlier).to_contain_text('Это ваш прошлый заказ на 4 190 ₸')
    wait_quiet(page)
    assert counts(state) == (1, 1, 1), state
    assert len(posts(state)) == before, posts(state)[before:]
    # The explicit tap opened it again (a restart while it waits would offer it on the menu).
    reopened = json.loads(page.evaluate('(key) => localStorage.getItem(key)', DRAFT_KEY))
    assert reopened['orderId'] == ORDER_ID and 'closedAt' not in reopened and reopened['sendInvoice'] is False, reopened
    page.screenshot(path=str(OUT / f'A-pay-again-same-order-{width}.png'))
    # Closed again, then the app restored right on the cart route (web): the cart, not payment.
    page.get_by_test_id('kaspi-state-close').click()
    page.get_by_test_id('kaspi-close-confirm').click()
    expect(pay_button(page)).to_be_enabled(timeout=10000)
    stored(page, DRAFT_KEY, orderId=ORDER_ID, sendInvoice=False)
    page = relaunch(ctx, page, '/cart')
    expect(pay_button(page)).to_be_enabled(timeout=25000)
    wait_quiet(page)
    expect(page.get_by_test_id('kaspi-waiting')).to_have_count(0)
    assert counts(state) == (1, 1, 1), state
    release(state)
    ctx.close()


def kaspi_invoice_then_killed(browser, width, height, pay_result='awaiting_payment'):
    state = new_state(pay_result=pay_result)
    ctx, page = make_context(browser, state, width, height, 'reduce')
    page.goto(URL + '/menu')
    add(page)
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
    expect(page.get_by_test_id('cart-pay-handle').filter(visible=True)).to_be_visible(timeout=15000)
    slide(page, 1.0)
    text = 'Ждём оплату в Kaspi' if pay_result == 'awaiting_payment' else 'Отправляем счёт'
    expect(page.get_by_test_id('kaspi-waiting')).to_contain_text(text, timeout=15000)
    for _ in range(100):
        if state['payments']:
            break
        page.wait_for_timeout(100)
    assert counts(state) == (1, 1, 1), state
    saved = stored(page, DRAFT_KEY, orderId=ORDER_ID)
    assert 'closedAt' not in saved, saved
    return state, ctx, page


def scenario_not_closed(browser, width, height):
    state, ctx, page = kaspi_invoice_then_killed(browser, width, height)
    before = len(posts(state))
    # iOS closed the app while the customer was in Kaspi.kz (no X): relaunch.
    page = relaunch(ctx, page)
    on_menu(page)
    offer = banner(page)
    expect(offer).to_be_visible(timeout=15000)
    expect(offer).to_contain_text('Заказ ждёт оплаты в Kaspi')
    expect(offer).to_contain_text('Открыть заказ')
    expect(page.get_by_test_id('payment-resume-open').filter(visible=True)).to_have_attribute(
        'aria-label', 'Заказ ждёт оплаты в Kaspi')
    expect(page.get_by_test_id('payment-resume-close').filter(visible=True)).to_have_attribute(
        'aria-label', 'Скрыть напоминание об оплате')
    banner_geometry(page, width)
    wait_quiet(page, 2000)
    on_menu(page)
    assert len(posts(state)) == before, posts(state)[before:]
    page.screenshot(path=str(OUT / f'B-relaunch-banner-{width}.png'))
    # The menu keeps its content above the banner (and the cart bar under it), as for the bar.
    top = banner(page).bounding_box()['y']
    assert content_bottom(page, 'M06') <= top + 1, (content_bottom(page, 'M06'), top)
    # «Открыть заказ»: the payment state of the same order, read only.
    page.get_by_test_id('payment-resume-open').filter(visible=True).click()
    sheet = page.get_by_test_id('order-sheet')
    expect(sheet.get_by_test_id('kaspi-waiting')).to_contain_text('Ждём оплату в Kaspi', timeout=15000)
    expect(sheet.get_by_test_id('kaspi-open-app')).to_be_visible()
    assert path(page) == '/checkout', page.url
    wait_quiet(page, 1500)
    assert counts(state) == (1, 1, 1) and len(posts(state)) == before, (state, posts(state)[before:])
    page.screenshot(path=str(OUT / f'B-banner-opened-{width}.png'))
    # Its X asks (the bank may act), then closes it for good: back on the menu, no banner.
    sheet.get_by_test_id('kaspi-state-close').click()
    page.get_by_test_id('kaspi-close-confirm').click()
    expect(page.get_by_test_id('order-sheet')).to_have_count(0, timeout=10000)
    on_menu(page)
    expect(page.get_by_test_id('payment-resume-banner')).to_have_count(0, timeout=10000)
    closed = stored(page, DRAFT_KEY, orderId=ORDER_ID, sendInvoice=False)
    assert closed.get('closedAt'), closed
    page = relaunch(ctx, page)
    on_menu(page)
    wait_quiet(page, 2500)
    expect(page.get_by_test_id('payment-resume-banner')).to_have_count(0)
    assert counts(state) == (1, 1, 1) and len(posts(state)) == before, (state, posts(state)[before:])
    release(state)
    ctx.close()


def scenario_banner_x(browser, width, height):
    state, ctx, page = kaspi_invoice_then_killed(browser, width, height)
    before = len(posts(state))
    page = relaunch(ctx, page)
    on_menu(page)
    expect(banner(page)).to_be_visible(timeout=15000)
    page.get_by_test_id('payment-resume-close').filter(visible=True).click()
    expect(page.get_by_test_id('payment-resume-banner')).to_have_count(0)
    closed = stored(page, DRAFT_KEY, orderId=ORDER_ID, sendInvoice=False)
    assert closed.get('closedAt'), closed
    page.screenshot(path=str(OUT / f'C-banner-hidden-{width}.png'))
    page = relaunch(ctx, page)
    on_menu(page)
    wait_quiet(page, 2500)
    expect(page.get_by_test_id('payment-resume-banner')).to_have_count(0)
    page.get_by_test_id('open-cart').filter(visible=True).click()
    expect(pay_button(page)).to_be_enabled(timeout=15000)
    wait_quiet(page, 1500)
    expect(page.get_by_test_id('kaspi-waiting')).to_have_count(0)
    assert counts(state) == (1, 1, 1) and len(posts(state)) == before, (state, posts(state)[before:])
    release(state)
    ctx.close()


def scenario_paid_while_closed(browser, width, height):
    state, ctx, page = kaspi_invoice_then_killed(browser, width, height)
    before = len(posts(state))
    page.close()
    state['phase'] = 'paid'
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL + '/')
    on_menu(page)
    page.wait_for_function('(key) => localStorage.getItem(key) === null', arg=DRAFT_KEY, timeout=15000)
    # The paid lines leave the restored cart, as the payment screen does; no banner, no screen.
    expect(page.get_by_test_id('cart-shortcut').filter(visible=True)).to_have_count(0, timeout=10000)
    wait_quiet(page, 2000)
    on_menu(page)
    expect(page.get_by_test_id('payment-resume-banner')).to_have_count(0)
    assert counts(state) == (1, 1, 1) and len(posts(state)) == before, (state, posts(state)[before:])
    page.screenshot(path=str(OUT / f'D-paid-while-closed-{width}.png'))
    release(state)
    ctx.close()


def scenario_sending_wording(browser, width, height):
    state, ctx, page = kaspi_invoice_then_killed(browser, width, height, pay_result='sending')
    before = len(posts(state))
    page = relaunch(ctx, page)
    on_menu(page)
    offer = banner(page)
    expect(offer).to_contain_text('Проверяем оплату заказа', timeout=15000)
    banner_geometry(page, width)
    # RU, KK and EN (the app's own locale, kept in its preferences) fit at 320 pt, also with the
    # largest text the banner allows (x1.4, maxFontSizeMultiplier).
    for lang in ('ru', 'kk', 'en'):
        entry = next(entry for entry in MESSAGES if entry['ru'] == 'Проверяем оплату заказа')
        action = next(entry for entry in MESSAGES if entry['ru'] == 'Открыть заказ')
        if lang != 'ru':
            page.evaluate("""(locale) => {
              const key = 'pickchick.mobile.preferences.v1';
              const prefs = JSON.parse(localStorage.getItem(key));
              localStorage.setItem(key, JSON.stringify({...prefs, locale}));
            }""", lang)
            page = relaunch(ctx, page)
            expect(page.get_by_test_id('screen-M06').filter(visible=True)).to_be_visible(timeout=25000)
        offer = banner(page)
        expect(offer).to_contain_text(entry[lang], timeout=15000)
        expect(offer).to_contain_text(action[lang])
        banner_geometry(page, width)
        page.screenshot(path=str(OUT / f'E-sending-banner-{lang}-{width}.png'))
        fit = page.get_by_test_id('payment-resume-banner').filter(visible=True).evaluate('''(e) => {
          const texts = [...e.querySelectorAll('div[dir="auto"]')].filter((n) => n.textContent.trim());
          for (const t of texts) {
            const style = getComputedStyle(t);
            t.style.fontSize = (parseFloat(style.fontSize) * 1.4) + 'px';
            t.style.lineHeight = (parseFloat(style.lineHeight) * 1.4) + 'px';
          }
          const r = e.getBoundingClientRect();
          const ok = texts.every((t) => t.scrollWidth <= t.clientWidth + 1 && t.getBoundingClientRect().right <= r.right + 1)
            && r.right <= innerWidth;
          return {ok, count: texts.length};
        }''')
        assert fit['ok'] and fit['count'] >= 2, (lang, fit)
        page.screenshot(path=str(OUT / f'E-sending-banner-{lang}-large-{width}.png'))
    assert len(posts(state)) == before, posts(state)[before:]
    release(state)
    ctx.close()


if __name__ == '__main__':
    SELECTED = os.environ.get('LAUNCH_RESUME', 'ABCDE').upper()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        if 'A' in SELECTED:
            scenario_closed_sending(browser, 393, 852)
            scenario_closed_sending(browser, 320, 568)
        if 'B' in SELECTED:
            scenario_not_closed(browser, 393, 852)
            scenario_not_closed(browser, 320, 568)
        if 'C' in SELECTED:
            scenario_banner_x(browser, 393, 852)
        if 'D' in SELECTED:
            scenario_paid_while_closed(browser, 393, 852)
        if 'E' in SELECTED:
            scenario_sending_wording(browser, 320, 568)
        browser.close()
    assert not errors, errors
    print('PASS launch resume (' + SELECTED + '): a closed «Отправляем счёт» never comes back after a relaunch '
          '(menu, no payment state, no banner, zero POST, the cart is the cart, paying again reopens the same '
          'order with its notice and sends nothing new); a payment left open is offered by a banner above the '
          'cart bar that opens the same order read-only and whose X (or the payment X) closes it for good; '
          'a paid order is tidied up with its cart lines; «sending» reads «Проверяем оплату заказа»')
