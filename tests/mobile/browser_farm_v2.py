"""PICK FARM v2 interaction journey in a browser, against the real engine over isolated HTTP.

Covers immediate actions with a slow server, sweep harvest/water/plant batching, the
older-API fallback, hold-and-drag with edge scrolling, continuous building, wheel zoom and
the level-up celebration. Needs `pnpm --filter @pickchick/farm-game build` and a web export
served at FARM_UI_URL (default http://127.0.0.1:4196). Screenshots go to .local/farm-v2.
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
URL = os.environ.get('FARM_UI_URL', 'http://127.0.0.1:4196').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost')
OUT = Path(os.environ.get('FARM_SHOTS', str(ROOT / '.local/farm-v2')))
OUT.mkdir(parents=True, exist_ok=True)
LATENCY = float(os.environ.get('FARM_LATENCY', '0.6'))
NEW_RULES = {'water', 'waterMany', 'harvestMany', 'plantMany'}
HOUR = 3600000

ENGINE = """import {createFarm, applyFarmCommand} from './packages/farm-game/dist/index.js';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const p=JSON.parse(input);
if (p.build) {
  let now = 1770000000000, s = {...createFarm(now), coins: 60000, xp: 100};
  const run = (c) => { s = applyFarmCommand(s, c, now); };
  for (let y = 29; y < 32; y++) for (let x = 29; x < 34; x++) run({type: 'buyPlot', x, y});
  run({type: 'buyTree', x: 35, y: 29, cropId: 'apple'});
  run({type: 'buyDecoration', decorationId: 'path', x: 28, y: 32});
  // Row y=29 strawberries become ripe; row y=30 tomatoes keep growing; row y=31 stays empty.
  for (const plot of s.plots.filter((v) => v.kind === 'bed' && v.y === 29)) run({type: 'plant', plotId: plot.id, cropId: 'strawberry'});
  now += 1800 * 1000 + 1000;
  for (const plot of s.plots.filter((v) => v.kind === 'bed' && v.y === 30)) run({type: 'plant', plotId: plot.id, cropId: 'tomato'});
  s.coins = 3000;
  // Today's gift is already taken, so the daily card does not cover this journey.
  s.progression.daily = {day: Math.floor(now / 86400000), streak: 1};
  s.revision += 1;
  console.log(JSON.stringify({state: s, now}));
} else {
  try { console.log(JSON.stringify({state: applyFarmCommand(p.state, p.command, p.now)})); }
  catch (e) { console.log(JSON.stringify({error: e.code || 'INVALID_REQUEST'})); }
}"""


def engine(payload):
    return json.loads(subprocess.check_output(
        ['node', '--input-type=module', '-e', ENGINE], input=json.dumps(payload), cwd=ROOT, text=True))


customer = {'id': '40000000-0000-4000-8000-000000000001', 'phone': '+77000000000', 'nickname': 'Farm test',
            'birth_date': None, 'gender': None, 'profile_completed_at': None, 'created_at': '2026-09-07T10:00:00.000Z'}
future = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
envelope = {'version': 1, 'device_id': '40000000-0000-4000-8000-000000000004',
            'tokens': {'access_token': 'a' * 64, 'refresh_token': 'b' * 64, 'access_expires_at': future,
                       'session_id': '40000000-0000-4000-8000-000000000002', 'customer': customer},
            'challenge': None, 'otp_request': None, 'verify_intent': None, 'refresh_request_id': None, 'closing': None}


def journey(browser, width, height, legacy):
    tag = f'{width}{"-legacy" if legacy else ""}'
    fixture = engine({'build': True})
    saved = {'state': fixture['state'], 'now': fixture['now']}
    calls, errors, ids = [], [], set()

    def route(r):
        parsed = urlparse(r.request.url)
        if parsed.hostname in ('localhost', '127.0.0.1'):
            return r.continue_()
        status = 200
        if parsed.path == '/v1/customers/me':
            data = {'customer': customer}
        elif parsed.path == '/v1/auth/config':
            data = {'enabled': True, 'delivery_consent_required': True, 'consent_version': 'fixture', 'channels': ['telegram'],
                    'channel_selection': 'automatic', 'whatsapp_fallback_enabled': False,
                    'terms_url': 'https://example.test/terms', 'privacy_url': 'https://example.test/privacy'}
        elif parsed.path.startswith('/v1/customer-farm'):
            # A current API runs protocol 3; an older one rejects it and the client steps down.
            if legacy and 'protocol=3' in r.request.url:
                return r.fulfill(status=503, json={'code': 'FARM_UNAVAILABLE', 'minimumProtocol': 2},
                                 headers={'Access-Control-Allow-Origin': '*'})
            assert ('protocol=2' if legacy else 'protocol=3') in r.request.url, r.request.url
            if r.request.method == 'POST':
                body = r.request.post_data_json
                command = body['command']
                if legacy and command['type'] in NEW_RULES:
                    return r.fulfill(status=400, json={'code': 'INVALID_REQUEST'},
                                     headers={'Access-Control-Allow-Origin': '*'})
                if body['commandId'] not in ids:
                    assert body['expectedRevision'] == saved['state']['revision'], (body, saved['state']['revision'])
                    result = engine({'state': saved['state'], 'command': command, 'now': saved['now']})
                    if 'error' in result:
                        return r.fulfill(status=400, json={'code': result['error']},
                                         headers={'Access-Control-Allow-Origin': '*'})
                    saved['state'] = result['state']
                    ids.add(body['commandId'])
                    calls.append(command)
            data = {'state': saved['state'], 'serverNow': saved['now']}
        else:
            return r.abort()
        r.fulfill(status=status, json=data, headers={'Access-Control-Allow-Origin': '*'})

    context = browser.new_context(viewport={'width': width, 'height': height}, device_scale_factor=2)
    context.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",' + json.dumps(json.dumps(envelope)) + ');')
    # A slow mobile network, simulated in the page so the test thread is never blocked.
    context.add_init_script('''(() => { const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('/v1/customer-farm/commands')) await new Promise((r) => setTimeout(r, %d));
        return original(input, init); }; })();''' % int(LATENCY * 1000))
    context.route('**/*', route)
    page = context.new_page()
    page.set_default_timeout(10000)
    page.on('pageerror', lambda error: errors.append(str(error)))

    def shot(name):
        page.screenshot(path=str(OUT / f'{name}-{tag}.png'))

    def world_box():
        return page.get_by_test_id('pick-farm-world').locator(':scope > div').first.bounding_box()

    def screen(x, y, lift=0):
        box = world_box()
        scale = box['width'] / 900
        return box['x'] + (450 + (x - y) * 48) * scale, box['y'] + (300 + (x + y - 63) * 24 - lift) * scale

    def tap(x, y, lift=0):
        page.mouse.click(*screen(x, y, lift))

    def sweep(cells, lift=0):
        points = [screen(x, y, lift) for x, y in cells]
        page.mouse.move(*points[0])
        page.mouse.down()
        for a, b in zip(points, points[1:]):
            for i in range(1, 9):
                page.mouse.move(a[0] + (b[0] - a[0]) * i / 8, a[1] + (b[1] - a[1]) * i / 8)
                page.wait_for_timeout(8)
        page.mouse.up()

    def plot(x, y):
        return next(v for v in saved['state']['plots'] if v['x'] == x and v['y'] == y)

    def settle(count, timeout=12):
        deadline = time.monotonic() + timeout
        while len(calls) < count and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        assert len(calls) >= count, (count, [c['type'] for c in calls])

    page.goto(URL + '/games/pick-farm')
    expect(page.get_by_test_id('pick-farm-screen')).to_be_visible(timeout=20000)
    page.wait_for_function('Array.from(document.images).every(i => i.complete)')
    page.wait_for_timeout(600)
    shot('01-open')
    coins = saved['state']['coins']

    # 1. Tap harvest is instant: the plant disappears long before the slow server answers.
    first = plot(29, 29)
    started = time.monotonic()
    tap(29, 29, 30)
    expect(page.get_by_test_id(f'pick-farm-badge-ready-{first["id"]}')).to_have_count(0, timeout=2000)
    visible_ms = (time.monotonic() - started) * 1000
    assert visible_ms < LATENCY * 1000, visible_ms
    assert page.get_by_test_id('pick-farm-coins').inner_text().strip().startswith(str(coins)), 'coins only after confirmation'
    page.wait_for_timeout(250)
    shot('02-harvest-in-flight')
    settle(1)
    assert calls[-1] == {'type': 'harvest', 'plotId': first['id'], 'destination': 'sell'}
    expect(page.get_by_test_id('pick-farm-coins')).to_contain_text(str(saved['state']['coins']), timeout=3000)

    # 2. Sweep over the rest of the ripe row: batched (or single commands on the older API).
    before = len(calls)
    sweep([(30, 29), (31, 29), (32, 29), (33, 29)], 30)
    page.wait_for_timeout(200)
    shot('03-sweep-harvest')
    harvested = lambda: all(plot(x, 29)['cropId'] is None for x in range(29, 34))
    deadline = time.monotonic() + 10
    while not harvested() and time.monotonic() < deadline:
        page.wait_for_timeout(100)
    assert harvested(), [plot(x, 29) for x in range(29, 34)]
    kinds = [c['type'] for c in calls[before:]]
    assert ('harvestMany' in kinds) != legacy, kinds
    # Timing decides the split; a sweep is never more requests than plots, batches when supported.
    assert len(kinds) <= (4 if legacy else 3), kinds

    # 3. Water the growing tomato row by sweeping across it.
    before = len(calls)
    page.mouse.wheel(0, -400)
    page.wait_for_timeout(500)
    sweep([(29, 30), (31, 30), (33, 30)], 20)
    page.wait_for_timeout(350)
    shot('04-water-sweep')
    if legacy:
        expect(page.get_by_text('Лейка заработает после обновления сервера фермы.')).to_be_visible(timeout=6000)
        assert all(c['type'] not in NEW_RULES for c in calls[before:]), calls[before:]
    else:
        deadline = time.monotonic() + 10
        while sum(1 for x in range(29, 34) if plot(x, 30)['timing']['harvestWindowSeconds'] != 129600) < 5 and time.monotonic() < deadline:
            page.wait_for_timeout(100)
        assert all(plot(x, 30)['timing']['harvestWindowSeconds'] != 129600 for x in range(29, 34))
        expect(page.get_by_test_id(f'pick-farm-growth-{plot(31, 30)["id"]}-wet')).to_have_count(1)

    # 4. Plant mode: choose seeds on an empty bed, then sweep along the empty row.
    before = len(calls)
    tap(29, 31)
    expect(page.get_by_test_id('pick-farm-panel-seeds')).to_be_visible()
    shot('05-seeds')
    page.get_by_test_id('pick-farm-seed-carrot').click()
    expect(page.get_by_test_id('pick-farm-seed-mode')).to_be_visible()
    sweep([(30, 31), (31, 31), (32, 31), (33, 31)])
    deadline = time.monotonic() + 10
    while any(plot(x, 31)['cropId'] != 'carrot' for x in range(29, 34)) and time.monotonic() < deadline:
        page.wait_for_timeout(100)
    assert all(plot(x, 31)['cropId'] == 'carrot' for x in range(29, 34)), ([plot(x, 31)['cropId'] for x in range(29, 34)], calls[before:], [plot(x, 31)['id'] for x in range(29, 34)])
    kinds = [c['type'] for c in calls[before:]]
    assert ('plantMany' in kinds) != legacy, kinds
    page.get_by_role('button', name='Закончить посадку').click()

    # 5. Hold and drag the apple tree to a new cell; the move is saved on release.
    tree = plot(35, 29)
    start = screen(35, 29, 40)
    page.mouse.move(*start)
    page.mouse.down()
    page.wait_for_timeout(450)
    target = screen(36, 27, 40)
    for i in range(1, 13):
        page.mouse.move(start[0] + (target[0] - start[0]) * i / 12, start[1] + (target[1] - start[1]) * i / 12)
        page.wait_for_timeout(16)
    shot('06-drag')
    page.mouse.up()
    settle(len(calls) + 1)
    assert calls[-1] == {'type': 'movePlot', 'plotId': tree['id'], 'x': 36, 'y': 27}, calls[-1]

    # 6. Building mode continues after a purchase with the next price.
    page.get_by_test_id('pick-farm-shop').click()
    page.get_by_role('button', name='Грядка', exact=False).first.click()
    expect(page.get_by_test_id('pick-farm-panel-place')).to_be_visible()
    count = len(saved['state']['plots'])
    page.get_by_role('button', name='Разместить', exact=False).click()
    page.wait_for_timeout(150)
    page.get_by_role('button', name='Разместить', exact=False).click()
    shot('07-building')
    deadline = time.monotonic() + 10
    while len(saved['state']['plots']) < count + 2 and time.monotonic() < deadline:
        page.wait_for_timeout(100)
    assert len(saved['state']['plots']) == count + 2
    page.get_by_role('button', name='Отменить размещение').click()

    # 7. A confirmed level-up shows the celebration with what it unlocked.
    saved['state']['xp'] = 349
    saved['state']['revision'] += 1
    saved['now'] += 3 * HOUR
    page.reload()
    expect(page.get_by_test_id('pick-farm-screen')).to_be_visible(timeout=20000)
    page.wait_for_timeout(600)
    ready_tomato = plot(31, 30)
    tap(31, 30, 30)
    expect(page.get_by_test_id('pick-farm-level-up')).to_be_visible(timeout=6000)
    page.wait_for_timeout(500)
    shot('08-level-up')
    page.get_by_test_id('pick-farm-level-up').click()
    assert ready_tomato['cropId'] == 'tomato'
    assert not errors, errors
    context.close()
    return calls


with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in [(844, 390), (667, 375)]:
        journey(browser, width, height, legacy=False)
    journey(browser, 844, 390, legacy=True)
    browser.close()
print('Farm v2: instant actions, sweeps (batched and legacy), watering, drag, building, level-up passed; isolated HTTP only.')
