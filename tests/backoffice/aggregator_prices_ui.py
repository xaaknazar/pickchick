"""Cutover CC-3: back-office aggregator price fields in the real editor.

Real local catalog API with PostgreSQL behind the operator proxy. Only publication_support is
injected at the browser boundary (the harness API runs without CATALOG_AGGREGATOR_PRICES_ENABLED),
so the editor can be seen both with the flag on and off. Every product field the editor does not
show must come back from the server exactly as it was (round trip). Synthetic data only.
"""
import json
import re
import sys
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

config = json.loads(Path(sys.argv[1]).read_text())
output = Path(config['output'])
branch = config['branch']
headers = {'Authorization': 'Bearer ' + config['manager']['token']}
base = config['apiUrl'] + '/v1/admin/catalog/branches/' + branch
PID = 'pick-combo'

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1440, 'height': 960}, device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())

    def at(test_id):
        return page.get_by_test_id(test_id)

    def capture(name):
        page.evaluate("""async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}""")
        page.screenshot(path=str(output / name))

    support = {'value': None}

    def catalog_state(route):
        response = route.fetch()
        body = response.json()
        if response.status == 200 and support['value'] is not None and 'branch' in body:
            body['publication_support'] = support['value']
        route.fulfill(response=response, json=body)

    page.route(re.compile(r'.*/v1/admin/catalog/branches/' + branch + r'(/draft|/draft/seed|/publish)?$'), catalog_state)

    def server_product(product_id=PID):
        state = page.request.get(base, headers=headers).json()
        return next(p for p in state['draft']['payload']['products'] if p['id'] == product_id)

    def differences(actual, wanted):
        return {k: (actual.get(k), wanted.get(k)) for k in set(actual) | set(wanted) if actual.get(k) != wanted.get(k)}

    def apply():
        at('editor-apply').click()
        expect(at('product-editor')).to_have_count(0)

    def save():
        # The button is disabled while the request runs too: wait for the committed answer.
        with page.expect_response(lambda r: r.request.method == 'PUT' and r.url.endswith('/draft')) as saved:
            at('save-draft').click()
        assert saved.value.status == 200, saved.value.status
        expect(at('save-draft')).to_be_disabled()

    page.goto(config['url'])
    at('credential-file').set_input_files({'name': 'manager.json', 'mimeType': 'application/json', 'buffer': json.dumps(config['manager']).encode()})
    at('nav-items').click()
    at('seed').click()
    expect(at('catalog-products').locator('tr')).to_have_count(24)

    # ---- A product with every field the editor keeps but does not show by the prices ----
    state = page.request.get(base, headers=headers).json()
    payload = state['draft']['payload']
    product = next(p for p in payload['products'] if p['id'] == PID)
    product['channel_prices_minor'] = {'mobile': '429000', 'yandex_eda': '459000', 'glovo': '469050'}
    product['kitchen_route'] = 'prep'
    product['combo_components'] = [{'product_id': 'fingers', 'quantity': 3}]
    product['modifier_groups'][0]['options'][0]['linked_product_id'] = 'cola'
    product['modifier_groups'][0]['options'][1]['nutrition_multiplier'] = 1.5
    response = page.request.put(base + '/draft', headers=headers, data={'expected_revision': state['draft']['revision'], 'request_id': str(uuid.uuid4()), 'payload': payload})
    assert response.status == 200, response.text()
    original = server_product()
    assert original['channel_prices_minor'] == product['channel_prices_minor']

    # ---- Flag on: table line and editor section ----
    support['value'] = {'mobile': False, 'kiosk': False, 'pos': True, 'aggregator_prices': True}
    at('reload').click()
    expect(at('aggregator-prices-' + PID)).to_have_text('Яндекс Еда: 4 590 ₸ · Glovo: 4 690,50 ₸')
    expect(at('aggregator-prices-burger')).to_have_text('Яндекс Еда: - · Glovo: -')
    at('edit-' + PID).click()
    section = at('edit-aggregator-prices')
    expect(section).to_be_visible()
    expect(section).to_contain_text('Цены агрегаторов публикуются только на кассу')
    expect(at('edit-price-yandex_eda')).to_have_value('4590')
    expect(at('edit-price-glovo')).to_have_value('4690,50')
    expect(at('edit-price-mobile')).to_have_value('4290')
    section.scroll_into_view_if_needed()
    capture('editor-aggregator-prices-on.png')
    # Round trip: apply without a change, save, the server product is exactly the original.
    apply()
    save()
    assert server_product() == original, differences(server_product(), original)

    # Edit one channel, clear the other: only those keys change.
    at('edit-' + PID).click()
    at('edit-price-yandex_eda').fill('4 690')
    at('edit-price-glovo').fill('')
    apply()
    expect(at('aggregator-prices-' + PID)).to_have_text('Яндекс Еда: 4 690 ₸ · Glovo: -')
    save()
    expected = json.loads(json.dumps(original))
    expected['channel_prices_minor'] = {'mobile': '429000', 'yandex_eda': '469000'}
    assert server_product() == expected, differences(server_product(), expected)

    # A new aggregator price on a product without channel prices creates just that key.
    burger = server_product('burger')
    at('edit-burger').click()
    at('edit-price-glovo').fill('2790')
    apply()
    save()
    burger['channel_prices_minor'] = {'glovo': '279000'}
    assert server_product('burger') == burger

    # Invalid input is refused in the editor and never reaches the draft.
    at('edit-' + PID).click()
    at('edit-price-yandex_eda').fill('abc')
    at('editor-apply').click()
    expect(at('editor-error')).to_contain_text('Укажите цену в Яндекс Еде или оставьте поле пустым.')
    at('editor-close').click()
    expect(at('product-editor')).to_have_count(0)
    assert server_product() == expected

    # ---- Flag off: no section for products without aggregator prices; saved ones stay visible
    # with the blocking note, and publication is refused before any request ----
    support['value'] = None
    at('reload').click()
    expect(at('aggregator-prices-water')).to_have_count(0)
    at('edit-water').click()
    expect(at('product-editor')).to_be_visible()
    expect(at('edit-aggregator-prices')).to_have_count(0)
    at('editor-close').click()
    at('edit-' + PID).click()
    expect(at('edit-aggregator-prices')).to_contain_text('Публикация цен агрегаторов на кассу ещё не включена')
    capture('editor-aggregator-prices-off.png')
    at('editor-close').click()
    publishes = []
    page.on('request', lambda r: publishes.append(r.url) if r.method == 'POST' and r.url.endswith('/publish') else None)

    def refused_publish(text):
        at('content-reviewed').check()
        save()
        at('publish-open').click()
        at('publish-confirm').click()
        expect(page.get_by_role('alert').filter(has_text=text)).to_be_visible()

    # The own-channel override keeps its historical message first.
    refused_publish('одну базовую цену')
    at('edit-' + PID).click()
    at('edit-price-mobile').fill('')
    apply()
    # Then the aggregator prices, with their own message, still without any request.
    refused_publish('Цены Яндекс Еды и Glovo пока нельзя публиковать')
    assert publishes == []
    final = json.loads(json.dumps(expected))
    final['channel_prices_minor'] = {'yandex_eda': '469000'}
    assert server_product() == final
    assert errors == [], errors
    browser.close()
print('aggregator prices UI: ok')
