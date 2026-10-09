"""Open-field farm with isolated HTTP fixtures and the actual v2 game engine.
Scenario adapted for contextual gestures; not executed during the farm-gestures edit.
"""
from browser_network import isolated_context, route_fixture
import json
import os
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('FARM_UI_URL', 'http://127.0.0.1:4188').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost')
OUT = ROOT / '.local/farm-ui'
OUT.mkdir(parents=True, exist_ok=True)
NOW = 1770000000000


def engine(payload):
    script = """import {createFarm,applyFarmCommand,CROPS} from './packages/farm-game/dist/index.js';
    let input=''; for await (const chunk of process.stdin) input+=chunk;
    const p=JSON.parse(input);
    console.log(JSON.stringify(p.state ? applyFarmCommand(p.state,p.command,p.now) : {state:createFarm(p.now),crops:CROPS}));"""
    return json.loads(subprocess.check_output(
        ['node', '--input-type=module', '-e', script], input=json.dumps(payload), cwd=ROOT, text=True))


fixture = engine({'now': NOW})
CROPS = {crop['id']: crop for crop in fixture['crops']}
customer = {'id': '40000000-0000-4000-8000-000000000001', 'phone': '+77000000000',
            'nickname': 'Farm test', 'birth_date': None, 'gender': None,
            'profile_completed_at': None, 'created_at': '2026-09-07T10:00:00.000Z'}
future = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
envelope = {'version': 1, 'device_id': '40000000-0000-4000-8000-000000000004',
            'tokens': {'access_token': 'a' * 64, 'refresh_token': 'b' * 64,
                       'access_expires_at': future, 'session_id': '40000000-0000-4000-8000-000000000002',
                       'customer': customer}, 'challenge': None, 'otp_request': None,
            'verify_intent': None, 'refresh_request_id': None, 'closing': None}

with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in [(852, 393), (667, 375), (1024, 768)]:
        context = isolated_context(browser,viewport={'width': width, 'height': height}, reduced_motion='reduce')
        context.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",' +
                                json.dumps(json.dumps(envelope)) + ');')
        saved = {'state': json.loads(json.dumps(fixture['state'])), 'now': NOW}
        calls, errors, command_ids = [], [], set()

        def route(r):
            path = urlparse(r.request.url).path
            if urlparse(r.request.url).hostname in ('localhost', '127.0.0.1'):
                r.continue_()
                return
            if path == '/v1/customers/me':
                data = {'customer': customer}
            elif path == '/v1/auth/config':
                data = {'enabled': True, 'delivery_consent_required': True, 'consent_version': 'fixture',
                        'channels': ['telegram'], 'channel_selection': 'automatic',
                        'whatsapp_fallback_enabled': False, 'terms_url': 'https://example.test/terms',
                        'privacy_url': 'https://example.test/privacy'}
            elif path.startswith('/v1/customer-farm'):
                assert r.request.headers.get('authorization') == 'Bearer ' + 'a' * 64
                if r.request.method == 'POST':
                    body = r.request.post_data_json
                    if body['commandId'] not in command_ids:
                        assert body['expectedRevision'] == saved['state']['revision'], (width, body, saved['state']['revision'])
                        saved['state'] = engine({'state': saved['state'], 'command': body['command'], 'now': saved['now']})
                        command_ids.add(body['commandId'])
                        calls.append(body)
                data = {'state': saved['state'], 'serverNow': saved['now']}
            else:
                r.abort()
                return
            r.fulfill(json=data, headers={'Access-Control-Allow-Origin': '*'})

        route_fixture(context,'**/*', route)
        page = context.new_page()
        page.set_default_timeout(10000)
        page.on('pageerror', lambda error: errors.append(error.stack or str(error)))

        def reload_field():
            page.goto(URL + '/games/pick-farm')
            expect(page.get_by_test_id('pick-farm-screen')).to_be_visible(timeout=10000)
            expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
            page.wait_for_function('Array.from(document.images).every(i => i.complete)')

        def close_panel():
            page.get_by_role('button', name='Закрыть панель', exact=True).click()

        def tap_cell(x, y):
            world = page.get_by_test_id('pick-farm-world').locator(':scope > div').first.bounding_box()
            scale = world['width'] / 900
            point = {'x': world['x'] + (450 + (x - y) * 48) * scale,
                     'y': world['y'] + (300 + (x + y - 63) * 24) * scale}
            page.mouse.click(point['x'], point['y'])

        def done():
            button = page.get_by_role('button', name='Закончить посадку', exact=True)
            if button.count():
                button.click()

        def select_plot(plot):
            done()
            tap_cell(plot['x'], plot['y'])
            expect(page.get_by_test_id('pick-farm-panel-plot')).to_be_visible()

        try:
            reload_field()
            assert saved['state']['version'] == 2 and not saved['state']['plots']
            page.screenshot(path=str(OUT / f'field-empty-{width}.png'))
            page.get_by_test_id('pick-farm-shop').click()
            page.get_by_role('button', name='Грядка - 150 монет', exact=True).click()
            tap_cell(32, 30)
            expect(page.get_by_test_id('pick-farm-panel-place')).to_be_visible()
            page.get_by_role('button', name='Купить - 150 монет', exact=True).click()
            expect(page.get_by_test_id('pick-farm-panel-place')).to_have_count(0)
            assert calls[-1]['command'] == {'type': 'buyPlot', 'x': 32, 'y': 30}
            bed = saved['state']['plots'][0]
            # An empty bed opens seeds; choosing one plants directly.
            select_plot(bed)
            page.get_by_role('button', name='Посадить', exact=True).click()
            page.get_by_test_id('pick-farm-seed-carrot').click()
            page.wait_for_function("document.body.innerText.includes('Сохраняем') === false")
            assert calls[-1]['command']['type'] == 'plant'
            select_plot(bed)
            expect(page.get_by_role('button', name='Убрать посадку', exact=True)).to_be_visible()
            page.wait_for_function('Array.from(document.images).every(i => i.complete && i.naturalWidth > 0)')
            page.wait_for_timeout(650)  # Wait for the crop panel NativeImage CSS background mount.
            page.screenshot(path=str(OUT / f'crop-growing-{width}.png'))
            close_panel()
            saved['now'] += CROPS['carrot']['growSeconds'] * 1000
            reload_field()
            page.screenshot(path=str(OUT / f'harvest-sell-{width}.png'))
            tap_cell(bed['x'], bed['y'])
            page.wait_for_function("document.body.innerText.includes('Сохраняем') === false")
            assert calls[-1]['command'] == {'type': 'harvest', 'plotId': bed['id'], 'destination': 'sell'}
            assert saved['state']['inventory']['carrot'] == 0
            assert saved['state']['coins'] == 358  # 500 - 150 land - 4 seed + 12 harvest.
            assert not page.get_by_test_id('pick-farm-panel-plot').count()
            # Orders remain possible through an explicit storage destination.
            select_plot(bed)
            page.get_by_role('button', name='Посадить', exact=True).click()
            page.get_by_test_id('pick-farm-seed-carrot').click()
            page.wait_for_function("document.body.innerText.includes('Сохраняем') === false")
            saved['now'] += CROPS['carrot']['growSeconds'] * 1000
            reload_field()
            page.get_by_role('button', name='Как играть', exact=True).click()
            page.get_by_test_id('pick-farm-destination-storage').click()
            close_panel()
            page.screenshot(path=str(OUT / f'harvest-storage-{width}.png'))
            tap_cell(bed['x'], bed['y'])
            page.wait_for_function("document.body.innerText.includes('Сохраняем') === false")
            assert calls[-1]['command'] == {'type': 'harvest', 'plotId': bed['id'], 'destination': 'storage'}
            assert saved['state']['inventory']['carrot'] == 3 and saved['state']['coins'] == 354
            done()
            page.get_by_test_id('pick-farm-shop').click()
            page.get_by_role('button', name='Склад', exact=False).click()
            page.get_by_test_id('pick-farm-sell-carrot').click()
            expect(page.get_by_test_id('pick-farm-sell-carrot')).to_be_disabled()
            assert saved['state']['coins'] == 366
            close_panel()
            # Wilt and clear preserve land and do not produce inventory.
            select_plot(bed)
            page.get_by_role('button', name='Посадить', exact=True).click()
            page.get_by_test_id('pick-farm-seed-carrot').click()
            page.wait_for_function("document.body.innerText.includes('Сохраняем') === false")
            saved['now'] += (CROPS['carrot']['growSeconds'] + CROPS['carrot']['harvestWindowSeconds']) * 1000
            reload_field()
            select_plot(bed)
            expect(page.get_by_test_id('pick-farm-harvest')).to_have_accessible_name('Очистить')
            page.get_by_test_id('pick-farm-harvest').click()
            expect(page.get_by_test_id('pick-farm-seed-carrot')).to_be_visible()
            assert saved['state']['inventory']['carrot'] == 0
            close_panel()
            # Destructive mode always requires confirmation; cancelling is a no-op.
            select_plot(bed)
            page.get_by_role('button', name='Удалить грядку', exact=True).click()
            expect(page.get_by_test_id('pick-farm-panel-remove')).to_be_visible()
            before = len(calls)
            page.get_by_role('button', name='Оставить', exact=True).click()
            assert len(calls) == before and len(saved['state']['plots']) == 1
            select_plot(bed)
            page.get_by_role('button', name='Удалить грядку', exact=True).click()
            page.get_by_test_id('pick-farm-remove-confirm').click()
            expect(page.get_by_test_id('pick-farm-panel-remove')).to_have_count(0)
            assert len(saved['state']['plots']) == 0 and saved['state']['coins'] == 362
            done()
            page.get_by_test_id('pick-farm-shop').click()
            page.get_by_role('button', name='Яблоня - 275 монет', exact=True).click()
            tap_cell(32, 30)
            page.get_by_role('button', name='Купить - 275 монет', exact=True).click()
            expect(page.get_by_test_id('pick-farm-panel-place')).to_have_count(0)
            tree = saved['state']['plots'][0]
            assert tree['id'] != bed['id']
            tree_coins = saved['state']['coins']
            for harvest_index in range(3):
                saved['now'] += CROPS['apple']['growSeconds'] * 1000
                reload_field()
                tap_cell(tree['x'], tree['y'])
                page.wait_for_function("document.body.innerText.includes('Сохраняем') === false")
                assert calls[-1]['command']['destination'] == 'sell'
                assert saved['state']['coins'] == tree_coins + (harvest_index + 1) * 30
                assert saved['state']['inventory']['apple'] == 0
            assert saved['state']['plots'][0]['harvests'] == 0
            # Direct hold/drag: no move mode or confirmation footer.
            world_box = page.get_by_test_id('pick-farm-world').locator(':scope > div').first.bounding_box()
            scale = world_box['width'] / 900
            tx = world_box['x'] + (450 + (tree['x'] - tree['y']) * 48) * scale
            ty = world_box['y'] + (300 + (tree['x'] + tree['y'] - 63) * 24) * scale
            page.mouse.move(tx, ty)
            page.mouse.down()
            page.wait_for_timeout(450)
            page.mouse.move(tx + 48 * scale, ty + 24 * scale, steps=10)
            page.mouse.up()
            assert calls[-1]['command']['type'] == 'movePlot'
            done()
            before = len(calls)
            world = page.get_by_test_id('pick-farm-world')
            camera_before = world.evaluate('(el) => getComputedStyle(el.firstElementChild).transform')
            page.mouse.move(width / 2, height / 2)
            page.mouse.down()
            page.mouse.move(width / 2 + 90, height / 2 - 35, steps=8)
            page.mouse.up()
            camera_after = world.evaluate('(el) => getComputedStyle(el.firstElementChild).transform')
            assert camera_after == camera_before  # overview cannot pan below the fitted field
            assert len(calls) == before and not page.get_by_test_id('pick-farm-panel-place').count()
            page.get_by_role('button', name='Как играть', exact=True).click()
            page.get_by_role('button', name='Приблизить', exact=True).click()
            page.get_by_role('button', name='Весь участок', exact=True).click()
            close_panel()
            # Six-crop fixture exercises real engine, no production balances changed.
            overview = json.loads(json.dumps(fixture['state']))
            overview['revision'] = saved['state']['revision'] + 1
            overview['coins'], overview['xp'] = 10000, 100
            for index, crop_id in enumerate(CROPS):
                command = {'type': 'buyTree', 'cropId': 'apple'} if crop_id == 'apple' else {'type': 'buyPlot'}
                command.update(x=30 + index % 3, y=29 + index // 3)
                overview = engine({'state': overview, 'command': command, 'now': NOW})
                if crop_id != 'apple':
                    overview = engine({'state': overview, 'command': {'type': 'plant', 'plotId': index, 'cropId': crop_id}, 'now': NOW})
                overview['plots'][index]['plantedAt'] = NOW - CROPS[crop_id]['growSeconds'] * 1000
            saved.update(state=overview, now=NOW)
            reload_field()
            page.screenshot(path=str(OUT / f'field-six-crops-{width}.png'))
            page.get_by_test_id('pick-farm-shop').click()
            page.wait_for_function('Array.from(document.images).every(i => i.complete && i.naturalWidth > 0)')
            page.screenshot(path=str(OUT / f'shop-{width}.png'))
            close_panel()
            page.get_by_test_id('pick-farm-shop').click()
            page.get_by_role('button', name='Склад', exact=False).click()
            page.wait_for_function('Array.from(document.images).every(i => i.complete && i.naturalWidth > 0)')
            page.wait_for_timeout(650)  # RN Web NativeImage mounts its CSS background after the image event.
            page.screenshot(path=str(OUT / f'storage-{width}.png'))
            close_panel()
            page.get_by_test_id('pick-farm-shop').click()
            page.get_by_role('button', name='Заказы', exact=True).click()
            page.wait_for_function('Array.from(document.images).every(i => i.complete && i.naturalWidth > 0)')
            page.wait_for_timeout(650)
            page.screenshot(path=str(OUT / f'orders-{width}.png'))
            for plot in overview['plots']:
                crop = CROPS[plot['cropId']]
                plot['plantedAt'] = NOW - (crop['growSeconds'] + crop['harvestWindowSeconds']) * 1000
            reload_field()
            page.screenshot(path=str(OUT / f'field-six-withered-{width}.png'))
            # Fully insolvent fixture: a visible, server-validated route back into the loop.
            rescue = json.loads(json.dumps(fixture['state']))
            rescue['coins'] = 0
            saved.update(state=rescue, now=NOW)
            reload_field()
            page.get_by_role('button', name='Как играть', exact=True).click()
            page.get_by_test_id('pick-farm-recover').click()
            expect(page.get_by_test_id('pick-farm-recover')).to_have_count(0)
            assert saved['state']['coins'] == 0 and saved['state']['plots'][0]['cropId'] == 'carrot'
            assert not errors, errors
        except Exception:
            print(page.locator('body').inner_text())
            print(errors)
            page.screenshot(path=str(OUT / f'failure-{width}.png'))
            raise
        context.close()
    browser.close()
print('Farm tools 852/667/1024: empty field, inverse cell purchase, planting, default auto-sale, explicit storage/sale, escalating land, wilt/clear, permanent tree, pan/zoom, storage/orders passed; synthetic HTTP only.')
