"""Real local manager API + temporary PostgreSQL. No VPS or auth fixture bypass."""
import json
import sys
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

config = json.loads(Path(sys.argv[1]).read_text())
output = Path(config['output'])
headers = {'Authorization': 'Bearer ' + config['manager']['token']}
base = config['apiUrl'] + '/v1/admin/catalog/branches/' + config['branch']
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1680, 'height': 1040}, device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    def at(test_id):
        return page.get_by_test_id(test_id)
    def capture(name):
        page.evaluate("""async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}""")
        page.screenshot(path=str(output / name))
    def apply():
        at('editor-apply').click()
        expect(at('product-editor')).to_have_count(0)
    page.goto(config['url'])
    assert page.locator('script[type=module]').get_attribute('src') == './app.js'
    at('credential-file').set_input_files({'name': 'synthetic-manager.json', 'mimeType': 'application/json', 'buffer': json.dumps(config['manager']).encode()})
    at('nav-items').click()
    at('seed').click()
    expect(at('catalog-products').locator('tr')).to_have_count(24)
    assert page.locator('.sidebar').evaluate('(e)=>getComputedStyle(e).backgroundColor') == 'rgb(9, 16, 32)'
    capture('catalog-1680.png')
    response = page.request.get(base, headers=headers)
    assert response.status == 200
    initial = response.json()['draft']['payload']
    first = initial['products'][0]
    pid = first['id']
    at('catalog-search').fill(first['sku'])
    expect(at('catalog-products').locator('tr')).to_have_count(1)
    at('catalog-search').fill('')
    at('category-filter').select_option(first['category_id'])
    assert at('catalog-products').locator('tr').count() < 24
    at('category-filter').select_option('')
    at('edit-' + pid).click()
    long_name = 'Pick Combo — большая порция с подробным названием для проверки читаемости'
    at('edit-name-ru').fill(long_name)
    at('edit-name-kk').fill('Pick Combo — сынақ атауы')
    at('edit-description-ru').fill('Описание управляющего с составом и особенностями подачи.')
    at('edit-price').fill('5250,17')
    at('edit-image').select_option('i8.jpg')
    at('editor-tab-details').click()
    at('edit-weight').fill('480')
    at('edit-energy_kcal').fill('610')
    at('edit-protein_g').fill('32.5')
    at('edit-nutrition-status').select_option('operator_entered')
    at('edit-allergens').fill('Глютен\nМолоко')
    at('edit-allergens-status').select_option('declared')
    capture('editor-nutrition-1680.png')
    at('editor-tab-modifiers').click()
    at('edit-option-0-0-price').fill('25,50')
    at('edit-option-0-0-label-kk').fill('Сынақ нұсқасы')
    page.set_viewport_size({'width': 1024, 'height': 768})
    capture('editor-modifiers-1024.png')
    footer = at('editor-apply').bounding_box()
    assert footer['y'] >= 0 and footer['y'] + footer['height'] <= 768
    at('editor-tab-preview').click()
    capture('editor-preview-1024.png')
    apply()
    expect(at('product-' + pid)).to_contain_text(long_name)
    expect(at('product-' + pid)).to_contain_text('5 250,17 ₸')
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    at('content-reviewed').check()
    attempts = []
    def lose_committed_save(route):
        attempts.append(route.request.post_data_json)
        response = route.fetch()
        assert response.status == 200
        route.abort('failed')
    page.route('**/v1/admin/catalog/branches/*/draft', lose_committed_save)
    at('save-draft').click()
    expect(at('recover')).to_be_enabled()
    page.unroute('**/v1/admin/catalog/branches/*/draft', lose_committed_save)
    page.reload()
    expect(at('recover')).to_be_visible()
    recovered = []
    page.on('request', lambda request: recovered.append(request.post_data_json) if request.method == 'PUT' else None)
    at('recover').click()
    expect(at('recover')).to_have_count(0)
    assert attempts == recovered[:1]
    state = page.request.get(base, headers=headers).json()
    assert state['draft']['revision'] == 2
    assert state['draft']['payload']['products'][0]['modifier_groups'][0]['options'][0]['price_delta_minor'] == '2550'
    at('publish-open').click()
    expect(at('publish-confirm')).to_be_enabled()
    at('publish-confirm').click()
    expect(page.locator('.save-bar')).to_contain_text('Активная версия v1')
    page.set_viewport_size({'width': 1440, 'height': 900})
    capture('catalog-published-1440.png')
    at('edit-' + pid).click()
    at('edit-name-ru').fill('Локальная правка, которую нельзя потерять')
    apply()
    state = page.request.get(base, headers=headers).json()
    payload = state['draft']['payload']
    payload['products'][0]['name']['ru'] = 'Изменение другого редактора'
    response = page.request.put(base + '/draft', headers=headers, data={'expected_revision': state['draft']['revision'], 'request_id': str(uuid.uuid4()), 'payload': payload})
    assert response.status == 200
    at('save-draft').click()
    expect(at('resolve-conflict')).to_be_visible()
    expect(at('product-' + pid)).to_contain_text('Локальная правка, которую нельзя потерять')
    capture('catalog-conflict-1440.png')
    at('resolve-conflict').click()
    expect(at('resolve-conflict')).to_have_count(0)
    expect(at('product-' + pid)).to_contain_text('Изменение другого редактора')
    # A referenced upsell cannot be silently removed, including after confirmation.
    protected = initial['upsell_product_ids'][0]
    at('remove-' + protected).click()
    expect(page.get_by_role('alert')).to_contain_text('Сначала исправьте связанные позиции')
    expect(at('catalog-products').locator('tr')).to_have_count(24)
    at('add-product').click()
    at('edit-id').fill(pid)
    at('edit-sku').fill('synthetic-new')
    at('edit-name-ru').fill('Новая синтетическая позиция')
    at('edit-price').fill('1,999')
    at('editor-apply').click()
    expect(at('editor-error')).to_contain_text('ID уже используется')
    expect(at('editor-error')).to_contain_text('корректную сумму')
    at('edit-id').fill('synthetic-new')
    at('edit-price').fill('1500')
    apply()
    expect(at('catalog-products').locator('tr')).to_have_count(25)
    at('remove-synthetic-new').click()
    expect(at('catalog-products').locator('tr')).to_have_count(24)
    at('save-draft').click()
    expect(at('save-draft')).to_be_disabled()
    at('publish-open').click()
    expect(at('publish-confirm')).to_be_disabled()
    page.get_by_role('button', name='Вернуться', exact=True).click()
    page.set_viewport_size({'width': 1024, 'height': 768})
    page.evaluate('window.scrollTo(0,0)')
    capture('catalog-1024.png')
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    box = at('save-draft').bounding_box()
    assert box['y'] >= 0 and box['y'] + box['height'] <= 768
    # Stored strings are data, including after a real save and full document reload.
    hostile_name = '<img src=x onerror="window.__catalogXss=1">'
    hostile_description = '<script>window.__catalogXss=2</script>'
    at('edit-' + pid).click()
    at('edit-name-ru').fill(hostile_name)
    at('edit-description-ru').fill(hostile_description)
    apply()
    at('save-draft').click()
    expect(at('publish-open')).to_be_enabled()
    stored = page.request.get(base, headers=headers).json()['draft']['payload']['products'][0]
    assert stored['name']['ru'] == hostile_name
    assert stored['description']['ru'] == hostile_description
    page.reload()
    expect(at('product-' + pid)).to_contain_text(hostile_name)
    assert page.locator('img[src="x"]').count() == 0
    assert page.evaluate('window.__catalogXss') is None
    assert config['manager']['token'] not in page.content()
    assert config['manager']['token'] not in page.url
    at('edit-' + pid).click()
    expect(at('edit-description-ru')).to_have_value(hostile_description)
    at('editor-close').click()
    at('logout').click()
    expect(at('credential-file')).to_be_visible()
    assert page.evaluate('sessionStorage.getItem("pickchick.backoffice.credential.v1")') is None
    assert not errors, errors
    browser.close()
print('Backoffice browser: real auth, seed24, forms/modifiers, retry, conflict, publish, 3 desktop/tablet sizes PASS')
