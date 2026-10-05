"""Open-field farm with isolated HTTP fixtures and the actual v2 game engine.
Progression journey prepared without execution; requires integrated engine and preview.
"""
import json
import os
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
ENGINE_ROOT = Path(os.environ.get('FARM_ENGINE_ROOT', str(ROOT)))
URL = os.environ.get('FARM_UI_URL', 'http://127.0.0.1:4195').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost')
OUT = ROOT / '.local/farm-progression'
OUT.mkdir(parents=True, exist_ok=True)
NOW = 1770000000000


def engine(payload):
    script = """import {createFarm,applyFarmCommand,CROPS} from './packages/farm-game/dist/index.js';
    let input=''; for await (const chunk of process.stdin) input+=chunk;
    const p=JSON.parse(input);
    console.log(JSON.stringify(p.state ? applyFarmCommand(p.state,p.command,p.now) : {state:createFarm(p.now),crops:CROPS}));"""
    return json.loads(subprocess.check_output(
        ['node', '--input-type=module', '-e', script], input=json.dumps(payload), cwd=ENGINE_ROOT, text=True))


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
    for width, height in [(844, 390), (667, 375)]:
        context = browser.new_context(viewport={'width': width, 'height': height}, reduced_motion='reduce')
        context.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",' + json.dumps(json.dumps(envelope)) + ');')
        saved = {'state': json.loads(json.dumps(fixture['state'])), 'now': NOW}
        calls, errors, ids = [], [], set()

        def route(r):
            parsed = urlparse(r.request.url)
            if parsed.hostname in ('localhost', '127.0.0.1'):
                r.continue_()
                return
            if parsed.path == '/v1/customers/me':
                data = {'customer': customer}
            elif parsed.path == '/v1/auth/config':
                data = {'enabled': True, 'delivery_consent_required': True, 'consent_version': 'fixture', 'channels': ['telegram'], 'channel_selection': 'automatic', 'whatsapp_fallback_enabled': False, 'terms_url': 'https://example.test/terms', 'privacy_url': 'https://example.test/privacy'}
            elif parsed.path.startswith('/v1/customer-farm'):
                assert r.request.headers.get('authorization') == 'Bearer ' + 'a' * 64
                if r.request.method == 'POST':
                    body = r.request.post_data_json
                    if body['commandId'] not in ids:
                        assert body['expectedRevision'] == saved['state']['revision']
                        saved['state'] = engine({'state': saved['state'], 'command': body['command'], 'now': saved['now']})
                        ids.add(body['commandId'])
                        calls.append(body)
                data = {'state': saved['state'], 'serverNow': saved['now']}
            else:
                r.abort()
                return
            r.fulfill(json=data, headers={'Access-Control-Allow-Origin': '*'})

        context.route('**/*', route)
        page = context.new_page()
        page.set_default_timeout(10000)
        page.on('pageerror', lambda error: errors.append(str(error)))

        def reload():
            page.goto(URL + '/games/pick-farm')
            expect(page.get_by_test_id('pick-farm-screen')).to_be_visible()
            expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
            page.wait_for_function('Array.from(document.images).every(i => i.complete)')

        def close():
            page.get_by_role('button', name='Закрыть панель', exact=True).click()

        def tap(x, y):
            world = page.get_by_test_id('pick-farm-world').locator(':scope > div').first.bounding_box()
            scale = world['width'] / 900
            page.mouse.click(world['x'] + (450 + (x-y)*48)*scale, world['y'] + (300+(x+y-63)*24)*scale)

        def command(action, kind):
            before = len(calls)
            action()
            page.wait_for_function("document.body.innerText.includes('Сохраняем') === false")
            deadline = time.monotonic() + 5
            while len(calls) == before and time.monotonic() < deadline:
                page.wait_for_timeout(50)
            # Assertions inspect acknowledged engine state, not an optimistic local receipt.
            assert len(calls) == before + 1, (kind, calls)
            assert calls[-1]['command']['type'] == kind

        def shop(section=None):
            page.get_by_test_id('pick-farm-shop').click()
            if section:
                page.get_by_role('button', name=section, exact=True).click()

        try:
            reload()
            assert not saved['state']['plots']
            shop()
            page.get_by_role('button', name='Грядка - 150 монет', exact=True).click()
            command(lambda: page.get_by_role('button', name='Разместить - 150 монет', exact=True).click(), 'buyPlot')
            bed = saved['state']['plots'][0]
            tap(bed['x'], bed['y'])
            command(lambda: page.get_by_test_id('pick-farm-seed-carrot').click(), 'plant')
            assert saved['state']['plots'][0]['timing']['growSeconds'] == 45
            saved['now'] += 44000
            reload()
            tap(bed['x'], bed['y'])
            assert calls[-1]['command']['type'] == 'plant'  # No premature harvest.
            close()
            saved['now'] += 1000
            reload()
            command(lambda: tap(bed['x'], bed['y']), 'harvest')
            page.get_by_role('button', name='Задания Алекса', exact=True).click()
            command(lambda: page.get_by_test_id('pick-farm-quest-first-harvest').click(), 'claimQuest')
            expect(page.get_by_test_id('pick-farm-quest-first-harvest')).to_have_count(0)
            assert 'first-harvest' in saved['state']['progression']['claimedQuests']
            close()
            shop('Украшения')
            page.get_by_test_id('pick-farm-decoration-path').click()
            tap(bed['x'] + 1, bed['y'])
            command(lambda: page.get_by_role('button', name='Разместить', exact=False).click(), 'buyDecoration')
            assert saved['state']['progression']['decorations'][0]['decorationId'] == 'path'
            page.screenshot(path=str(OUT / f'first-garden-{width}.png'))
            # Reserve welcome quota: default sale must retain three carrots and credit zero coins.
            shop('Заказы')
            command(lambda: page.get_by_test_id('pick-farm-reserve-welcome-basket').click(), 'setOrderReserve')
            close()
            tap(bed['x'], bed['y'])
            command(lambda: page.get_by_test_id('pick-farm-seed-carrot').click(), 'plant')
            saved['now'] += 45000
            reload()
            coins = saved['state']['coins']
            command(lambda: tap(bed['x'], bed['y']), 'harvest')
            assert saved['state']['coins'] == coins and saved['state']['inventory']['carrot'] == 3
            shop('Заказы')
            command(lambda: page.get_by_test_id('pick-farm-order-welcome-basket').click(), 'fulfill')
            assert saved['state']['inventory']['carrot'] == 0
            close()
            # Synthetic unlocked fixture, genuine engine commands for station/jobs/reward collection.
            saved['state']['xp'] = 10000
            saved['state']['coins'] = 10000
            saved['state']['inventory']['strawberry'] = 9
            saved['state']['revision'] += 1
            reload()
            shop('Мастерские')
            command(lambda: page.get_by_test_id('pick-farm-station-kitchen').click(), 'buyStation')
            command(lambda: page.get_by_test_id('pick-farm-produce-jam').click(), 'startProduction')
            job = saved['state']['progression']['stations'][0]['queue'][0]
            close()
            saved['now'] = job['readyAt']
            reload()
            shop('Мастерские')
            command(lambda: page.get_by_test_id(f"pick-farm-collect-kitchen-{job['id']}").click(), 'collectProduction')
            assert saved['state']['progression']['products']['jam'] == 1
            command(lambda: page.get_by_test_id('pick-farm-product-jam').click(), 'sellProduct')
            assert saved['state']['progression']['products']['jam'] == 0
            assert not errors, errors
            page.screenshot(path=str(OUT / f'workshop-{width}.png'))
        except Exception:
            page.screenshot(path=str(OUT / f'failure-{width}.png'))
            print(page.locator('body').inner_text())
            raise
        context.close()
    browser.close()
print('Farm progression: first 45s harvest, claim, decoration, order reserve, station production/collection/sale passed; isolated HTTP only.')
