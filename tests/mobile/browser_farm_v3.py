"""PICK FARM protocol 3 journey in a browser, against the real engine over isolated HTTP.

Daily gift, locked land and its expansion, building the coop, buying and feeding chickens,
collecting milk in the barn, the order board and goods in storage; then the same app against
an API that still runs protocol 2 (legacy mode hides every v3 feature). Needs
`pnpm --filter @pickchick/farm-game build` and a web export served at FARM_UI_URL
(default http://127.0.0.1:4196). Screenshots go to .local/farm-v3.
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
OUT = Path(os.environ.get('FARM_SHOTS', str(ROOT / '.local/farm-v3')))
OUT.mkdir(parents=True, exist_ok=True)
LATENCY = float(os.environ.get('FARM_LATENCY', '0.4'))
HOUR = 3600000

ENGINE = """import {createFarm, applyFarmCommand} from './packages/farm-game/dist/index.js';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const p=JSON.parse(input);
if (p.build) {
  const now = 1770000000000;
  let t = now - 2 * 3600000;
  let s = {...createFarm(t), coins: 6000, xp: 400};
  const run = (c) => { s = applyFarmCommand(s, c, t); };
  for (let y = 28; y < 31; y++) for (let x = 28; x < 32; x++) run({type: 'buyPlot', x, y});
  run({type: 'buyTree', x: 33, y: 28, cropId: 'apple'});
  for (const plot of s.plots.filter((v) => v.kind === 'bed' && v.y === 28)) run({type: 'plant', plotId: plot.id, cropId: 'strawberry'});
  s.inventory = {...s.inventory, tomato: 4};
  run({type: 'buyPen', pen: 'barn'});
  run({type: 'buyAnimal', kind: 'cow'});
  run({type: 'buyAnimal', kind: 'cow'});
  run({type: 'feedAnimals', kind: 'cow'});
  t = now - 30 * 60000;
  for (const plot of s.plots.filter((v) => v.kind === 'bed' && v.y === 29)) run({type: 'plant', plotId: plot.id, cropId: 'tomato'});
  s.inventory = {carrot: 30, tomato: 30, strawberry: 30, sunflower: 30, tulip: 30, apple: 30};
  s.progression.goods = {egg: 6, milk: 1};
  s.progression.products = {...s.progression.products, jam: 3, pancakes: 3, bouquet: 3, juice: 3};
  s.coins = 6000;
  if (p.legacy) {
    // An API on protocol 2 knows none of the v3 fields.
    for (const k of ['land', 'pens', 'animals', 'nextAnimalId', 'goods', 'board', 'daily']) delete s.progression[k];
    for (const k of ['pancakes', 'milkshake']) delete s.progression.products[k];
  }
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
    fixture = engine({'build': True, 'legacy': legacy})
    saved = {'state': fixture['state'], 'now': fixture['now']}
    calls, errors, ids, protocols = [], [], set(), set()

    def route(r):
        parsed = urlparse(r.request.url)
        if parsed.hostname in ('localhost', '127.0.0.1'):
            return r.continue_()
        cors = {'Access-Control-Allow-Origin': '*'}
        if parsed.path == '/v1/customers/me':
            return r.fulfill(json={'customer': customer}, headers=cors)
        if parsed.path == '/v1/auth/config':
            return r.fulfill(json={'enabled': True, 'delivery_consent_required': True, 'consent_version': 'fixture',
                                   'channels': ['telegram'], 'channel_selection': 'automatic',
                                   'whatsapp_fallback_enabled': False, 'terms_url': 'https://example.test/terms',
                                   'privacy_url': 'https://example.test/privacy'}, headers=cors)
        if not parsed.path.startswith('/v1/customer-farm'):
            return r.abort()
        protocol = parsed.query.split('protocol=')[-1]
        protocols.add(protocol)
        if protocol != ('2' if legacy else '3'):
            return r.fulfill(status=503, json={'code': 'FARM_UNAVAILABLE', 'minimumProtocol': 2 if legacy else 3},
                             headers=cors)
        if r.request.method == 'POST':
            body = r.request.post_data_json
            if body['commandId'] not in ids:
                assert body['expectedRevision'] == saved['state']['revision'], (body, saved['state']['revision'])
                result = engine({'state': saved['state'], 'command': body['command'], 'now': saved['now']})
                if 'error' in result:
                    return r.fulfill(status=400, json={'code': result['error']}, headers=cors)
                saved['state'] = result['state']
                ids.add(body['commandId'])
                calls.append(body['command'])
        r.fulfill(json={'state': saved['state'], 'serverNow': saved['now']}, headers=cors)

    context = browser.new_context(viewport={'width': width, 'height': height}, device_scale_factor=2)
    context.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",' + json.dumps(json.dumps(envelope)) + ');')
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

    def settle(kind, timeout=10):
        deadline = time.monotonic() + timeout
        while not any(c['type'] == kind for c in calls) and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        assert any(c['type'] == kind for c in calls), (kind, [c['type'] for c in calls])

    def zoom_out(steps=3):
        box = page.get_by_test_id('pick-farm-world').bounding_box()
        page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
        for _ in range(steps):
            page.mouse.wheel(0, 300)
            page.wait_for_timeout(120)
        page.wait_for_timeout(400)

    def wait_for(check, timeout=10):
        deadline = time.monotonic() + timeout
        while not check() and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        assert check(), [c['type'] for c in calls]

    def open_hud(label):
        # Narrow screens keep gift, tasks and storage in a sliding tray.
        button = page.get_by_role('button', name=label, exact=True)
        if not button.count() and page.get_by_test_id('pick-farm-hud-more').count():
            page.get_by_test_id('pick-farm-hud-more').click()
            expect(page.get_by_test_id('pick-farm-hud-tray')).to_be_visible()
            shot('hud-tray')
        page.get_by_role('button', name=label, exact=True).click()

    def close_panel():
        page.get_by_role('button', name='Закрыть панель').first.click()
        page.wait_for_timeout(250)

    page.goto(URL + '/games/pick-farm')
    expect(page.get_by_test_id('pick-farm-screen')).to_be_visible(timeout=20000)
    page.wait_for_function('Array.from(document.images).every(i => i.complete)')
    page.wait_for_timeout(700)

    if legacy:
        assert protocols == {'3', '2'}, protocols
        expect(page.get_by_test_id('pick-farm-daily')).to_have_count(0)
        expect(page.get_by_test_id('pick-farm-daily-button')).to_have_count(0)
        expect(page.get_by_test_id('pick-farm-locked-land')).to_have_count(0)
        expect(page.get_by_test_id('pick-farm-pen-sign-coop')).to_have_count(0)
        zoom_out()
        shot('01-legacy-overview')
        page.get_by_test_id('pick-farm-shop').click()
        expect(page.get_by_test_id('pick-farm-shop-coop')).to_have_count(0)
        close_panel()
        page.get_by_role('button', name='Заказы фермы').click()
        expect(page.get_by_test_id('pick-farm-board-0')).to_have_count(0)
        close_panel()
        # The whole 32x32 field stays open on an older save.
        page.get_by_test_id('pick-farm-shop').click()
        page.get_by_role('button', name='Грядка', exact=False).first.click()
        expect(page.get_by_test_id('pick-farm-panel-place')).to_be_visible()
        page.get_by_role('button', name='Отменить размещение').click()
        assert not errors, errors
        context.close()
        return

    # 1. The daily gift greets the returning player; coins arrive after confirmation.
    expect(page.get_by_test_id('pick-farm-daily')).to_be_visible()
    shot('01-daily')
    coins = saved['state']['coins']
    page.get_by_test_id('pick-farm-daily-claim').click()
    settle('claimDaily')
    expect(page.get_by_test_id('pick-farm-daily')).to_have_count(0)
    expect(page.get_by_test_id('pick-farm-coins')).to_contain_text(str(saved['state']['coins']), timeout=4000)
    assert saved['state']['coins'] == coins + 20

    # 2. Overview: locked wild land around the open square, coop sign, barn with cows, scenery.
    expect(page.get_by_test_id('pick-farm-locked-land')).to_have_count(1)
    zoom_out()
    shot('02-overview')

    # 3. A tap on locked land opens the expansion. Buying it is an event: the camera steps
    # back, the dark ring fades in a wave, new signs fall onto the new edge, confetti.
    tap(40, 31)
    expect(page.get_by_test_id('pick-farm-panel-land')).to_be_visible()
    shot('03-land-panel')
    page.get_by_test_id('pick-farm-expand-land').click()
    expect(page.get_by_test_id('pick-farm-land-reveal')).to_have_count(1, timeout=2000)
    page.wait_for_timeout(900)
    shot('04-land-wave')
    settle('expandLand')
    assert saved['state']['progression']['land'] == 1
    expect(page.get_by_test_id('pick-farm-land-reveal')).to_have_count(0, timeout=4000)
    shot('04-land-open')

    # 4. Panels stack: shop -> coop -> Back returns to the shop.
    page.get_by_test_id('pick-farm-shop').click()
    page.get_by_test_id('pick-farm-shop-coop').click()
    expect(page.get_by_test_id('pick-farm-panel-coop')).to_be_visible()
    page.get_by_test_id('pick-farm-panel-back').click()
    expect(page.get_by_test_id('pick-farm-panel-shop')).to_be_visible()
    page.get_by_test_id('pick-farm-shop-coop').click()
    expect(page.get_by_test_id('pick-farm-panel-coop')).to_be_visible()
    page.wait_for_timeout(500)
    shot('05-coop-sign')
    page.get_by_test_id('pick-farm-buy-pen-coop').click()
    settle('buyPen')
    for _ in range(3):
        page.get_by_test_id('pick-farm-buy-animal-coop').click()
        page.wait_for_timeout(120)
    wait_for(lambda: len([a for a in saved['state']['progression'].get('animals', []) if a['kind'] == 'chicken']) == 3)
    close_panel()
    chickens = [a['id'] for a in saved['state']['progression']['animals'] if a['kind'] == 'chicken']
    # Hungry chickens sit on their spots with a carrot bubble.
    for cid in chickens:
        expect(page.get_by_test_id(f'pick-farm-hungry-{cid}')).to_have_count(1)
    page.wait_for_timeout(300)
    shot('06-hungry')

    # 5. Tap a hungry chicken: it is fed alone. A sweep over the other two feeds them.
    spots = [(2.4, 1.0), (0.5, 1.6), (1.6, 1.45)]
    yard = lambda i: (19.5 + spots[i][0], 10.5 + spots[i][1])
    before = len(calls)
    tap(*yard(0), 22)
    wait_for(lambda: any(c['type'] == 'feedAnimals' for c in calls[before:]))
    feeds = [c for c in calls[before:] if c['type'] == 'feedAnimals']
    assert feeds[0] == {'type': 'feedAnimals', 'kind': 'chicken', 'animalIds': [chickens[0]]}, feeds
    page.wait_for_timeout(200)
    before = len(calls)
    a, b = screen(*yard(2), 22), screen(*yard(1), 22)
    page.mouse.move(*a)
    page.mouse.down()
    for i in range(1, 13):
        page.mouse.move(a[0] + (b[0] - a[0]) * i / 12, a[1] + (b[1] - a[1]) * i / 12)
        page.wait_for_timeout(16)
    page.mouse.up()
    wait_for(lambda: all(x['fedAt'] is not None for x in saved['state']['progression']['animals'] if x['kind'] == 'chicken'))
    swept = sorted(i for c in calls[before:] if c['type'] == 'feedAnimals' for i in c['animalIds'])
    assert swept == sorted(chickens[1:]), calls[before:]
    page.wait_for_timeout(2600)
    shot('07-chickens-stroll')

    # 6. Cows were fed two hours ago: a tap on one cow takes its milk; a tap on the barn
    # building takes the rest; holding the barn opens its card.
    cows = [x['id'] for x in saved['state']['progression']['animals'] if x['kind'] == 'cow']
    milk = saved['state']['progression']['goods']['milk']
    expect(page.get_by_test_id('pick-farm-pen-badge-barn')).to_have_count(1)
    before = len(calls)
    cx, cy = screen(24.5 + 2.75, 9.4 + 1.35, 32)
    assert 0 < cx < width and 60 < cy < height, (cx, cy)
    page.mouse.click(cx, cy)
    page.wait_for_timeout(200)
    shot('08-milk-tap')
    wait_for(lambda: any(c['type'] == 'collectAnimals' for c in calls[before:]))
    assert [c for c in calls[before:] if c['type'] == 'collectAnimals'][0] == {
        'type': 'collectAnimals', 'kind': 'cow', 'animalIds': [cows[0]]}
    before = len(calls)
    tap(24.5 + 1.2, 9.4 + 0.9, 45)
    wait_for(lambda: saved['state']['progression']['goods']['milk'] == milk + 2)
    assert {'type': 'collectAnimals', 'kind': 'cow'} in calls[before:], calls[before:]
    hx, hy = screen(24.5 + 1.2, 9.4 + 0.9, 45)
    page.mouse.move(hx, hy)
    page.mouse.down()
    page.wait_for_timeout(500)
    page.mouse.up()
    expect(page.get_by_test_id('pick-farm-panel-barn')).to_be_visible()
    shot('09-barn-hold')
    close_panel()

    # 7. Order board: an order is a medium event (flash and coins); the slot waits.
    open_hud('Заказы фермы')
    expect(page.get_by_test_id('pick-farm-board-0')).to_be_visible()
    shot('10-board')
    page.get_by_test_id('pick-farm-board-fulfill-0').click()
    page.wait_for_timeout(250)
    shot('11-board-coins')
    settle('fulfillBoard')
    expect(page.get_by_test_id('pick-farm-board-0')).to_contain_text('Новый заказ через', timeout=4000)
    page.get_by_test_id('pick-farm-board-skip-1').click()
    settle('skipBoard')
    close_panel()

    # 8. Eggs and milk wait in storage next to the harvest (in the tray on narrow screens).
    open_hud('Склад урожая')
    expect(page.get_by_test_id('pick-farm-sell-good-egg')).to_be_visible()
    shot('12-storage')
    page.get_by_test_id('pick-farm-sell-good-egg').click()
    settle('sellGood')
    close_panel()
    assert not errors, errors
    context.close()


with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in [(844, 390), (667, 375)]:
        journey(browser, width, height, legacy=False)
    journey(browser, 844, 390, legacy=True)
    browser.close()
print('Farm v3: daily gift, land expansion, coop, chickens, milk, order board, goods and legacy protocol 2 passed; isolated HTTP only.')
