"""Unified menu back-office UI: photo upload, channel/cashier status and remote stop controls.

Catalog, draft, publication and the photo upload use the real local API with PostgreSQL and
sharp. The cashier delivery status and the stop list v2 are mocked at the browser boundary, so
their transitions (pending -> applied, rejected, analyst/disabled views) are deterministic.
"""
import json
import re
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

config = json.loads(Path(sys.argv[1]).read_text())
output = Path(config['output'])
branch = config['branch']
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')


def iso(delta_seconds=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=delta_seconds)).isoformat().replace('+00:00', 'Z')


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1440, 'height': 960}, device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())

    def at(test_id):
        return page.get_by_test_id(test_id)

    def capture(name):
        page.evaluate("""async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}""")
        page.screenshot(path=str(output / name))

    # ---- Cashier delivery status, injected into the real catalog state -------------------
    # Before a draft exists a connected mobile channel hides seeding, so channels connect after it.
    status = {
        'support': None,
        'delivery': None,
        'published_at': None,
    }

    def catalog_state(route):
        response = route.fetch()
        body = response.json()
        if response.status == 200 and status['support']:
            body['publication_support'] = status['support']
            if body.get('published') and status['delivery']:
                body['edge_delivery'] = {
                    **status['delivery'],
                    'catalog_version': body['published']['version'],
                }
                if status['published_at']:
                    body['published']['published_at'] = status['published_at']
        route.fulfill(response=response, json=body)

    page.route(re.compile(r'.*/v1/admin/catalog/branches/' + branch + r'$'), catalog_state)

    page.goto(config['url'])
    at('credential-file').set_input_files({'name': 'manager.json', 'mimeType': 'application/json', 'buffer': json.dumps(config['manager']).encode()})
    at('nav-items').click()
    at('seed').click()
    expect(at('catalog-products').locator('tr')).to_have_count(24)
    status['support'] = {'mobile': True, 'kiosk': True, 'pos': True}
    at('reload').click()
    for key, label in [('mobile', 'Приложение'), ('kiosk', 'Киоск'), ('pos', 'Касса')]:
        expect(at('channel-' + key)).to_have_text(label + ': подключено')
    expect(page.locator('.table-help')).to_contain_text('«Стоп»')
    pid = at('catalog-products').locator('tr').first.get_attribute('data-testid').removeprefix('product-')
    row = at('product-' + pid)

    # ---- Photo upload ------------------------------------------------------------------
    at('edit-' + pid).click()
    expect(page.get_by_text('Показывать в меню', exact=True)).to_be_visible()
    expect(at('edit-kitchen-route').locator('option[value=""]')).to_have_text(re.compile('^По умолчанию: '))
    # A type the server never accepts is refused in the browser, without a request.
    uploads = []
    page.on('request', lambda r: uploads.append(r) if r.method == 'POST' and r.url.endswith('/assets') else None)
    at('edit-photo-file').set_input_files({'name': 'animation.gif', 'mimeType': 'image/gif', 'buffer': b'GIF89a' + bytes(32)})
    expect(at('edit-photo-error')).to_contain_text('JPEG, PNG, WebP или HEIC')
    assert uploads == []
    # Bytes that are not an image get the server's precise reason through the proxy.
    at('edit-photo-file').set_input_files({'name': 'fake.jpg', 'mimeType': 'image/jpeg', 'buffer': b'not a photo at all' * 4})
    expect(at('edit-photo-error')).to_contain_text('JPEG, PNG, WebP или HEIC')
    assert len(uploads) == 1
    # A large photo is re-encoded in the browser to fit the 300 KB staff-portal body limit
    # (pickchick.kz front); the server answer is stubbed so nothing is stored.
    assets_route = re.compile(r'.*/v1/admin/catalog/branches/' + branch + r'/assets$')

    def refuse_upload(route):
        if route.request.method != 'POST':
            return route.fallback()
        route.fulfill(status=413, json={'code': 'PAYLOAD_TOO_LARGE'})

    page.route(assets_route, refuse_upload)
    big = Path(config['big_photo']).read_bytes()
    assert len(big) > 280_000, len(big)
    with page.expect_request(lambda r: r.method == 'POST' and r.url.endswith('/assets')) as sent:
        at('edit-photo-file').set_input_files(config['big_photo'])
    assert sent.value.headers['content-type'] == 'image/jpeg', sent.value.headers
    assert 0 < len(sent.value.post_data_buffer) <= 280_000, len(sent.value.post_data_buffer)
    expect(at('edit-photo-error')).to_be_visible()
    page.unroute(assets_route, refuse_upload)
    photo = Path(config['photo']).read_bytes()
    with page.expect_request(lambda r: r.method == 'POST' and r.url.endswith('/assets')) as sent:
        at('edit-photo-file').set_input_files(config['photo'])
    request = sent.value
    assert request.headers['content-type'] == 'image/jpeg', request.headers
    assert UUID.match(request.headers['idempotency-key']), request.headers
    assert 'authorization' in request.headers
    assert len(request.post_data_buffer) == len(photo)
    expect(at('edit-photo-status')).to_contain_text('Загруженное фото')
    expect(at('edit-photo-progress')).to_be_hidden()
    preview = at('edit-photo-preview').locator('img[data-photo="uploaded"]')
    expect(preview).to_be_visible()
    src = preview.get_attribute('src')
    assert re.fullmatch(r'/v1/media/catalog/[a-f0-9]{64}\.card\.webp', src), src
    page.wait_for_function("(img)=>img.complete && img.naturalWidth>0", arg=preview.element_handle())
    assert preview.evaluate('(img)=>img.naturalWidth') <= 640
    at('edit-tile-color-enabled').check()
    at('edit-tile-color').fill('#ff6600')
    at('edit-cutout').check()
    at('edit-kitchen-route').select_option('assembly_item')
    at('edit-image').select_option('i8.jpg')
    capture('photo-editor-1440.png')
    at('editor-apply').click()
    expect(at('product-editor')).to_have_count(0)
    expect(row.locator('img[data-photo="uploaded"]')).to_be_visible()
    expect(row).to_contain_text('Своё фото')
    # Removing the photo falls back to the key; restoring keeps the uploaded reference.
    at('edit-' + pid).click()
    at('edit-photo-remove').click()
    expect(at('edit-photo-status')).to_contain_text('запасное фото')
    at('editor-close').click()
    expect(at('product-editor')).to_have_count(0)

    # ---- Save, publish and the cashier delivery ---------------------------------------
    at('content-reviewed').check()
    at('save-draft').click()
    expect(at('save-draft')).to_be_disabled()
    status['delivery'] = {
        'menu_version': 3,
        'release_id': str(uuid.uuid4()),
        'device_id': str(uuid.uuid4()),
        'status': 'pending',
        'acknowledged_at': None,
        'edge_active_version': 2,
        'observed_at': iso(),
    }
    at('publish-open').click()
    expect(at('publish-copy')).to_contain_text('киоск получат новые цены, фото и состав сразу')
    expect(at('publish-copy')).to_contain_text('Касса получит меню после подтверждения')
    at('publish-confirm').click()
    expect(page.locator('.save-bar')).to_contain_text('Активная версия v1')
    expect(at('edge-delivery')).to_contain_text('Касса: ожидает')
    expect(at('edge-delivery')).to_contain_text('сейчас на кассе версия 2')
    expect(at('edge-delivery-warning')).to_have_count(0)
    at('channel-status').scroll_into_view_if_needed()
    capture('delivery-pending-1440.png')
    # The 10 s status poll picks up the cashier acknowledgement without a reload.
    status['delivery'] = {**status['delivery'], 'status': 'applied', 'menu_version': 4, 'acknowledged_at': iso(), 'edge_active_version': 4}
    expect(at('edge-delivery')).to_contain_text('Касса: применено (версия 4)', timeout=15000)
    status['delivery'] = {**status['delivery'], 'status': 'rejected', 'reject_reason': 'MEDIA_UNAVAILABLE'}
    at('reload').click()
    expect(at('edge-delivery')).to_contain_text('Касса: отклонено — касса не смогла загрузить фото')
    at('channel-status').scroll_into_view_if_needed()
    capture('delivery-rejected-1440.png')
    status['delivery'] = {k: v for k, v in status['delivery'].items() if k != 'reject_reason'}
    status['delivery']['status'] = 'pending'
    status['published_at'] = iso(-11 * 60)
    at('reload').click()
    expect(at('edge-delivery-warning')).to_contain_text('больше 10 минут')
    status['published_at'] = None
    status['support'] = {'mobile': True, 'kiosk': False, 'pos': False}
    at('reload').click()
    expect(at('channel-pos')).to_have_text('Касса: не подключено')
    page.unroute(re.compile(r'.*/v1/admin/catalog/branches/' + branch + r'$'))

    # ---- Stop list v2 (mocked API) ----------------------------------------------------
    product_variant = str(uuid.uuid4())
    option_variant = str(uuid.uuid4())
    stops = {'role': 'manager', 'enabled': True, 'fresh': True, 'phase': 'idle', 'gets': 0, 'posts': [], 'times': []}

    def verdict(state):
        return {'command_id': str(uuid.uuid4()), 'stopped': True, 'state': state, 'result_version': 7, 'actor_label': 'Управляющий', 'created_at': iso(-300), 'resolved_at': iso(-290)}

    def stop_body():
        phase = stops['phase']
        product = {
            'catalog_ref': {'product_id': pid}, 'variant_id': product_variant, 'kind': 'product',
            'name_ru': 'Пик комбо', 'product_name_ru': 'Пик комбо', 'group_name_ru': None, 'listed': True,
            'stopped': phase == 'applied', 'version': 4 if phase == 'applied' else 3,
            'source': 'backoffice' if phase == 'applied' else None, 'expires_at': iso(3600) if phase == 'applied' else None,
            'shift_scoped': False, 'sales_blocked': phase != 'idle',
            'pending': None if phase in ('idle', 'applied') else {
                'command_id': stops['command'], 'stopped': True, 'duration': 'hour', 'state': phase,
                'actor_label': 'Синтетический управляющий', 'created_at': iso(-2), 'expires_at': iso(118),
            },
            'last_result': None if phase != 'applied' else {**verdict('applied'), 'resolved_at': iso(), 'result_version': 4},
        }
        option = {
            'catalog_ref': {'product_id': pid, 'group_id': 'sauce', 'option_id': 'cheese'}, 'variant_id': option_variant,
            'kind': 'option', 'name_ru': 'Сырный соус', 'product_name_ru': 'Пик комбо', 'group_name_ru': 'Соус',
            'listed': True, 'stopped': True, 'version': 7, 'source': 'pos', 'expires_at': None, 'shift_scoped': True,
            'sales_blocked': True, 'pending': None, 'last_result': None,
        }
        extra = []
        for state in ['conflict', 'no_open_shift', 'expired']:
            extra.append({**option, 'variant_id': str(uuid.UUID(int=len(extra) + 1)), 'catalog_ref': {'product_id': 'p-' + state},
                          'kind': 'product', 'name_ru': 'Позиция ' + state, 'product_name_ru': 'Позиция ' + state, 'group_name_ru': None,
                          'stopped': False, 'sales_blocked': False, 'source': None, 'shift_scoped': False, 'last_result': verdict(state)})
        hidden = {**option, 'variant_id': str(uuid.UUID(int=99)), 'catalog_ref': {'product_id': 'hidden'}, 'kind': 'product',
                  'name_ru': 'Скрытая позиция', 'product_name_ru': 'Скрытая позиция', 'group_name_ru': None, 'listed': False,
                  'stopped': False, 'sales_blocked': False, 'source': None, 'shift_scoped': False}
        writable = stops['enabled'] and stops['role'] == 'manager'
        return {
            'schema_version': 2, 'branch_id': branch, 'role': stops['role'], 'as_of': iso(),
            'remote_stops': {'enabled': stops['enabled'], 'edge_ready': True, 'writable': writable},
            'catalog': {'version': 1, 'published_at': iso(-600)},
            'availability': {'device_id': str(uuid.uuid4()), 'revision': '9', 'observed_at': iso(0 if stops['fresh'] else -900),
                             'fresh': stops['fresh'], 'stopped_count': 2, 'states_reported': True, 'source': 'edge_transport'},
            'items': [product, option, *extra, hidden],
            'unknown_stops': [{'variant_id': str(uuid.uuid4()), 'name_ru': 'Старый напиток', 'kind': 'variant', 'version': 2,
                               'source': 'pos', 'expires_at': None, 'shift_scoped': False}],
        }

    def stops_route(route):
        req = route.request
        if req.method == 'POST':
            body = req.post_data_json
            stops['posts'].append(body)
            stops['phase'] = 'pending'
            stops['gets'] = 0
            stops['command'] = str(uuid.uuid4())
            route.fulfill(status=202, json={
                'command_id': stops['command'], 'branch_id': branch, 'variant_id': product_variant,
                'catalog_ref': body['catalog_ref'], 'stopped': body['stopped'], 'duration': body['duration'],
                'expected_version': body['expected_version'], 'state': 'pending', 'created_at': iso(), 'expires_at': iso(120),
            })
            return
        if stops['phase'] in ('pending', 'delivered'):
            stops['times'].append(time.monotonic())
            stops['gets'] += 1
            if stops['gets'] == 2:
                stops['phase'] = 'delivered'
            elif stops['gets'] >= 3:
                stops['phase'] = 'applied'
        route.fulfill(status=200, json=stop_body())

    page.route('**/v1/admin/backoffice/branches/*/stops', stops_route)
    at('nav-stoplist').click()
    expect(at('stoplist-v2')).to_be_visible()
    expect(at('stop-blocker')).to_have_count(0)
    expect(at('stop-freshness')).to_have_count(0)
    toggle = at('stop-toggle-' + product_variant)
    expect(toggle).to_have_text('Стоп')
    expect(at('stop-toggle-' + option_variant)).to_have_text('Вернуть в продажу')
    expect(at('stop-row-' + option_variant)).to_contain_text('Касса · до конца смены')
    expect(at('stop-state-' + str(uuid.UUID(int=1)))).to_have_text('Касса изменила позицию — обновите')
    expect(at('stop-state-' + str(uuid.UUID(int=2)))).to_have_text('Нет открытой смены')
    expect(at('stop-state-' + str(uuid.UUID(int=3)))).to_have_text('Касса не ответила за 2 минуты')
    expect(at('stop-row-' + str(uuid.UUID(int=99)))).to_contain_text('Скрыта из меню')
    expect(at('stop-toggle-' + str(uuid.UUID(int=99)))).to_have_count(0)
    expect(page.get_by_text('Старый напиток', exact=True)).to_be_visible()
    capture('stoplist-1440.png')
    toggle.click()
    expect(at('stop-dialog')).to_be_visible()
    at('stop-duration-hour').check()
    at('stop-reason').fill('Закончилась курица')
    at('stop-submit').click()
    expect(at('stop-dialog')).to_have_count(0)
    expect(at('stop-state-' + product_variant)).to_have_text('Ждём подтверждения кассы…')
    expect(at('stop-toggle-' + product_variant)).to_be_disabled()
    capture('stoplist-pending-1440.png')
    # Fast polling (2 s) while waiting: applied well before the 10 s slow cadence.
    expect(at('stop-state-' + product_variant)).to_contain_text('Применено кассой', timeout=9000)
    expect(at('stop-toggle-' + product_variant)).to_have_text('Вернуть в продажу')
    expect(at('stop-row-' + product_variant)).to_contain_text('На стопе')
    expect(at('stop-row-' + product_variant)).to_contain_text('Бэк-офис')
    gaps = [b - a for a, b in zip(stops['times'], stops['times'][1:])]
    assert gaps and max(gaps) < 4.5, gaps
    assert len(stops['posts']) == 1, stops['posts']
    post = stops['posts'][0]
    assert UUID.match(post['request_id']), post
    assert {k: v for k, v in post.items() if k != 'request_id'} == {
        'catalog_ref': {'product_id': pid}, 'stopped': True, 'duration': 'hour',
        'reason': 'Закончилась курица', 'expected_version': 3,
    }, post
    # Search narrows rows locally.
    at('stop-search').fill('Сырный')
    expect(at('stop-rows').locator('tr')).to_have_count(1)
    at('stop-search').fill('')
    # Offline cashier: prominent freshness warning.
    stops['fresh'] = False
    at('op-refresh').click()
    expect(at('stop-freshness')).to_contain_text('Касса не на связи')
    # Server flag off: controls hidden with an explanation.
    stops['fresh'] = True
    stops['enabled'] = False
    at('op-refresh').click()
    expect(at('stop-blocker')).to_contain_text('выключен на сервере')
    expect(page.locator('[data-testid^="stop-toggle-"]')).to_have_count(0)
    # Analyst: controls visible but disabled.
    stops['enabled'] = True
    stops['role'] = 'analyst'
    at('op-refresh').click()
    expect(at('stop-blocker')).to_contain_text('только для просмотра')
    expect(at('stop-toggle-' + product_variant)).to_be_disabled()
    expect(at('stop-toggle-' + option_variant)).to_be_disabled()
    capture('stoplist-analyst-1440.png')
    for width, height in [(1024, 768), (393, 852)]:
        page.set_viewport_size({'width': width, 'height': height})
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'), width
        at('stop-row-' + product_variant).scroll_into_view_if_needed()
        capture(f'stoplist-analyst-{width}.png')
    page.unroute('**/v1/admin/backoffice/branches/*/stops')
    assert not errors, errors
    browser.close()
print(json.dumps({'result': 'PASS', 'upload_requests': len(uploads)}))
