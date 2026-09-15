"""Real local edge fixture, no mocked staff identity or order implementation.

Launched by browser.test.mjs; the only deliberate transport fault drops a real
committed create response. Fixture credentials are temporary and never printed.
"""
import json
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

fixture = json.loads(Path(sys.argv[1]).read_text())
url = fixture['url']
assert urlparse(url).hostname == '127.0.0.1'
output = Path(fixture['output'])


def sign_in(page, actor):
    page.locator('details.login-service').evaluate('(node) => node.open = true')
    page.get_by_test_id('pos-staff-file').set_input_files({
        'name': 'synthetic-session.json', 'mimeType': 'application/json',
        'buffer': json.dumps(actor).encode(),
    })


def bounded(page, test_id, width, height):
    target = page.get_by_test_id(test_id)
    expect(target).to_be_visible()
    box = target.bounding_box()
    assert box and box['width'] >= 48 and box['height'] >= 48, (test_id, box)
    assert box['x'] >= 0 and box['y'] >= 0, (test_id, box)
    assert box['x'] + box['width'] <= width + 1 and box['y'] + box['height'] <= height + 1, (test_id, box)


def capture(page, filename):
    page.wait_for_function('() => [...document.images].every(i => i.complete && i.naturalWidth)')
    page.evaluate('async () => { await Promise.all([...document.images].map(i => i.decode())); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }')
    page.screenshot(path=str(output / filename))


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    for width, height in ((1280, 800), (1920, 1080)):
        context = browser.new_context(viewport={'width': width, 'height': height})
        context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(url + '/') else route.abort())
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(url)
        actor = fixture['cashiers'][str(width)]
        bad = {**actor, 'token': '0' * 64}
        sign_in(page, bad)
        expect(page.get_by_test_id('pos-error')).to_contain_text('Сессия закончилась')
        expect(page.get_by_test_id('pos-staff-file')).to_be_visible()
        sign_in(page, actor)
        add = page.get_by_test_id('pos-add-' + fixture['variant'])
        expect(add).to_be_enabled()
        page.evaluate('() => document.fonts.ready')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        bounded(page, 'pos-calculate', width, height)
        # A second tab may not take the same physical terminal's journal lease.
        second = context.new_page()
        second.goto(url)
        sign_in(second, actor)
        expect(second.get_by_test_id('pos-error')).to_contain_text('другом окне')
        second.close()
        add.click()
        add.click()
        expect(page.get_by_test_id('pos-quantity-' + fixture['variant'])).to_have_text('2')
        expect(page.get_by_test_id('pos-total')).to_have_text('6 980 ₸')
        button_box = add.bounding_box()
        card_box = page.get_by_test_id('pos-product-' + fixture['variant']).bounding_box()
        assert button_box['y'] + button_box['height'] <= card_box['y'] + card_box['height'], (button_box, card_box)
        capture(page, f'pos-sale-{width}.png')
        # Catalog search and inner scroll cannot move the fixed actions away.
        page.get_by_test_id('pos-search').fill('Синтетическая')
        expect(page.get_by_test_id('pos-products').locator('article')).to_have_count(13)
        page.get_by_test_id('pos-products').evaluate('(e) => e.scrollTop = e.scrollHeight')
        bounded(page, 'pos-calculate', width, height)
        page.get_by_test_id('pos-search').fill('')
        page.reload()
        expect(page.get_by_test_id('pos-quantity-' + fixture['variant'])).to_have_text('2')
        page.get_by_test_id('pos-calculate').click()
        expect(page.get_by_test_id('pos-create')).to_be_enabled()
        bounded(page, 'pos-create', width, height)
        capture(page, f'pos-quote-{width}.png')
        creations = []

        def lose_first_response(route):
            request = route.request
            if request.method != 'POST':
                route.continue_()
                return
            creations.append((request.headers['idempotency-key'], request.post_data_json))
            response = route.fetch()
            assert response.status == 201
            if len(creations) == 1:
                route.abort('connectionreset')
            else:
                route.fulfill(response=response)

        page.route(url + '/edge/v1/orders', lose_first_response)
        page.get_by_test_id('pos-create').click()
        expect(page.get_by_test_id('pos-recovery')).to_be_visible()
        expect(page.get_by_test_id('pos-review')).to_have_count(0)
        page.reload()
        expect(page.get_by_test_id('pos-recovery')).to_be_visible()
        page.get_by_test_id('pos-recover').click()
        expect(page.get_by_test_id('pos-order')).to_be_visible()
        expect(page.get_by_test_id('pos-recovery')).to_have_count(0)
        assert len(creations) == 2 and creations[0] == creations[1]
        order_id = page.get_by_test_id('pos-order-id').text_content()
        expect(page.get_by_test_id('pos-kitchen-state')).to_have_text('Не передан на кухню')
        assert not page.get_by_role('button', name='Оплатить', exact=True).count()
        capture(page, f'pos-order-{width}.png')
        page.reload()
        expect(page.get_by_test_id('pos-order-id')).to_have_text(order_id)
        page.get_by_test_id('pos-cancel').click()
        reason = f'Синтетическая проверка UI {width}: полная причина'
        page.get_by_test_id('pos-reason').fill(reason)
        expect(page.get_by_test_id('pos-reason')).to_have_value(reason)
        page.get_by_test_id('pos-confirm').click()
        expect(page.get_by_test_id('pos-kitchen-state')).to_have_text('Отменён')
        expect(page.get_by_text('Причина отмены: ' + reason, exact=True)).to_be_visible()
        page.get_by_test_id('pos-logout').click()
        expect(page.get_by_test_id('pos-sign-in')).to_be_visible()
        assert page.evaluate('Object.keys(sessionStorage).length') == 0
        assert actor['token'] not in page.evaluate('JSON.stringify(localStorage)')
        assert errors == [], errors
        context.close()
        print(f'PASS POS {width}x{height}: real auth, fixed actions, reload, lost-create recovery, cancellation')
    context = browser.new_context(viewport={'width': 1280, 'height': 800})
    context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(url + '/') else route.abort())
    page = context.new_page()
    page.goto(url)
    sign_in(page, fixture['manager'])
    add = page.get_by_test_id('pos-add-' + fixture['variant'])
    expect(add).to_be_enabled()
    stop_button = page.locator('[data-stop="' + fixture['variant'] + '"]')
    stop_button.click()
    page.get_by_test_id('pos-reason').fill('Синтетическая проверка стоп-листа')
    page.get_by_test_id('pos-confirm').click()
    expect(stop_button).to_have_text('Снять стоп')
    expect(add).to_be_disabled()
    stop_button.click()
    page.get_by_test_id('pos-reason').fill('Синтетическая проверка снятия стопа')
    page.get_by_test_id('pos-confirm').click()
    expect(add).to_be_enabled()
    page.locator('[data-view="status"]').click()
    page.get_by_role('button', name='Закрыть приём неоплаченных заказов', exact=True).click()
    expect(page.get_by_role('button', name='Открыть приём неоплаченных заказов', exact=True)).to_be_enabled()
    page.get_by_role('button', name='Открыть приём неоплаченных заказов', exact=True).click()
    expect(page.get_by_role('button', name='Закрыть приём неоплаченных заказов', exact=True)).to_be_enabled()
    capture(page, 'pos-status-manager-1280.png')
    context.close()
    print('PASS manager: real stop-list and versioned ordering commands')
    browser.close()
