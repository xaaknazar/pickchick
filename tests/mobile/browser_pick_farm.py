"""Open-field farm with isolated HTTP fixtures and the actual v2 game engine."""
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
        context = browser.new_context(viewport={'width': width, 'height': height}, reduced_motion='reduce')
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

        context.route('**/*', route)
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

        def select_plot(plot):
            page.get_by_role('button', name='Магазин', exact=True).click()
            label = f"{'Яблоня' if plot['kind'] == 'tree' else 'Грядка'} {plot['x'] + 1}, {plot['y'] + 1}"
            page.get_by_role('button', name=label, exact=True).click()
            expect(page.get_by_test_id('pick-farm-panel-plot')).to_be_visible()

        try:
            reload_field()
            assert saved['state']['version'] == 2 and not saved['state']['plots']
            page.screenshot(path=str(OUT / f'field-empty-{width}.png'))
            # Inverse coordinate selection: (32,30), a free cell below-left of the house.
            fit = min(1.3, max(.75, height / 520))
            page.get_by_test_id('pick-farm-world').click(position={
                'x': width / 2 - 96 * fit, 'y': height / 2 + 54 - 22 * fit})
            expect(page.get_by_test_id('pick-farm-panel-place')).to_be_visible()
            expect(page.get_by_text('Клетка 33, 31', exact=True)).to_be_visible()
            page.get_by_role('button', name='Купить - 150 монет', exact=True).click()
            expect(page.get_by_test_id('pick-farm-panel-place')).to_have_count(0)
            assert calls[-1]['command'] == {'type': 'buyPlot', 'x': 32, 'y': 30}
            bed = saved['state']['plots'][0]
            select_plot(bed)
            page.get_by_test_id('pick-farm-seed-carrot').click()
            expect(page.get_by_test_id('pick-farm-harvest')).to_be_disabled()
            assert calls[-1]['command']['type'] == 'plant'
            close_panel()
            saved['now'] += CROPS['carrot']['growSeconds'] * 1000
            reload_field()
            select_plot(bed)
            expect(page.get_by_test_id('pick-farm-harvest')).to_be_enabled()
            page.get_by_test_id('pick-farm-harvest').click()
            expect(page.get_by_test_id('pick-farm-seed-carrot')).to_be_visible()
            assert saved['state']['inventory']['carrot'] == CROPS['carrot']['harvestYield']
            page.get_by_test_id('pick-farm-seed-carrot').click()
            close_panel()
            saved['now'] += (CROPS['carrot']['growSeconds'] + CROPS['carrot']['harvestWindowSeconds']) * 1000
            reload_field()
            select_plot(bed)
            expect(page.get_by_test_id('pick-farm-harvest')).to_have_accessible_name('Очистить')
            page.wait_for_function('Array.from(document.images).every(i => i.complete && i.naturalWidth > 0)')
            page.screenshot(path=str(OUT / f'field-withered-{width}.png'))
            page.get_by_test_id('pick-farm-harvest').click()
            expect(page.get_by_test_id('pick-farm-seed-carrot')).to_be_visible()
            assert calls[-1]['command']['type'] == 'clear'
            assert saved['state']['inventory']['carrot'] == CROPS['carrot']['harvestYield']
            close_panel()
            page.get_by_role('button', name='Магазин', exact=True).click()
            page.get_by_role('button', name='Яблоня - 250 монет', exact=True).click()
            # Occupied bed is previewed and purchase disabled until stepped to a free cell.
            expect(page.get_by_role('button', name='Купить - 250 монет', exact=True)).to_be_disabled()
            page.get_by_role('button', name='На клетку вправо', exact=True).click()
            page.get_by_role('button', name='Купить - 250 монет', exact=True).click()
            expect(page.get_by_test_id('pick-farm-panel-place')).to_have_count(0)
            tree = saved['state']['plots'][1]
            assert tree['kind'] == 'tree' and tree['cropId'] == 'apple'
            # Three cycles retain the same permanent tree and begin another growth cycle.
            for _ in range(3):
                saved['now'] += CROPS['apple']['growSeconds'] * 1000
                reload_field()
                select_plot(tree)
                page.get_by_test_id('pick-farm-harvest').click()
                expect(page.get_by_test_id('pick-farm-harvest')).to_be_disabled()
                close_panel()
            assert saved['state']['plots'][1]['kind'] == 'tree'
            assert saved['state']['plots'][1]['harvests'] == 0
            select_plot(saved['state']['plots'][1])
            page.get_by_role('button', name='Переместить', exact=True).click()
            page.get_by_role('button', name='На клетку вправо', exact=True).click()
            page.get_by_role('button', name='Переместить сюда', exact=True).click()
            expect(page.get_by_test_id('pick-farm-panel-place')).to_have_count(0)
            assert calls[-1]['command']['type'] == 'movePlot'
            assert saved['state']['plots'][1]['x'] == 34
            page.get_by_role('button', name='Приблизить ферму', exact=True).click()
            page.get_by_role('button', name='Отдалить ферму', exact=True).click()
            before = len(calls)
            camera_before = page.get_by_test_id('pick-farm-world').evaluate('(el) => getComputedStyle(el.firstElementChild).transform')
            page.mouse.move(width / 2, height / 2)
            page.mouse.down()
            page.mouse.move(width / 2 + 90, height / 2 - 35, steps=8)
            page.mouse.up()
            camera_after = page.get_by_test_id('pick-farm-world').evaluate('(el) => getComputedStyle(el.firstElementChild).transform')
            assert camera_after != camera_before, 'Drag must translate the camera'
            drag_opened_panel = page.get_by_test_id('pick-farm-panel-place').count() != 0
            if drag_opened_panel:
                close_panel()
            assert len(calls) == before
            page.get_by_role('button', name='Вернуть ферму в центр', exact=True).click()
            page.screenshot(path=str(OUT / f'field-{width}.png'))
            page.get_by_role('button', name='Склад', exact=False).click()
            expect(page.get_by_test_id('pick-farm-panel-storage').locator('img').first).to_be_attached()
            page.screenshot(path=str(OUT / f'storage-{width}.png'))
            close_panel()
            page.get_by_role('button', name='Заказы', exact=True).click()
            expect(page.get_by_test_id('pick-farm-panel-orders').locator('img').first).to_be_attached()
            page.screenshot(path=str(OUT / f'orders-{width}.png'))
            # Synthetic art overview: six cultures in their true field positions.
            overview = json.loads(json.dumps(fixture['state']))
            overview['revision'] = saved['state']['revision'] + 1
            overview['coins'] = 10000
            overview['xp'] = 100
            for index, crop_id in enumerate(CROPS):
                command = {'type': 'buyTree', 'cropId': 'apple'} if crop_id == 'apple' else {'type': 'buyPlot'}
                command.update(x=31 + index % 3, y=30 + index // 3)
                overview = engine({'state': overview, 'command': command, 'now': NOW})
                if crop_id != 'apple':
                    overview = engine({'state': overview, 'command': {'type': 'plant', 'plotId': index, 'cropId': crop_id}, 'now': NOW})
                overview['plots'][index]['plantedAt'] = NOW - CROPS[crop_id]['growSeconds'] * 1000
            saved.update(state=overview, now=NOW)
            reload_field()
            page.wait_for_function('Array.from(document.images).every(i => i.complete && i.naturalWidth > 0)')
            page.screenshot(path=str(OUT / f'field-six-crops-{width}.png'))
            for plot in overview['plots']:
                crop = CROPS[plot['cropId']]
                plot['plantedAt'] = NOW - (crop['growSeconds'] + crop['harvestWindowSeconds']) * 1000
            reload_field()
            page.wait_for_function('Array.from(document.images).every(i => i.complete && i.naturalWidth > 0)')
            page.screenshot(path=str(OUT / f'field-six-withered-{width}.png'))
            assert not drag_opened_panel, "Drag incorrectly opened placement instead of panning"
            assert not errors, errors
        except Exception:
            print(page.locator('body').inner_text())
            print(errors)
            page.screenshot(path=str(OUT / f'failure-{width}.png'))
            raise
        context.close()
    browser.close()
print('Farm 852/667/1024: empty field, inverse cell purchase, planting, ready harvest, wilt/clear, permanent tree, pan/zoom, storage/orders passed; synthetic HTTP only.')
