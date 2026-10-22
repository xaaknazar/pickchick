"""Order tracker redesign (M17/M18, brief 2026-10-12) against isolated HTTP fixtures.

The simulator export (EXPO_PUBLIC_ORDER_SIMULATOR=1) drives the test-flow tracker through
kitchen, assembly, ready takeaway, ready dine-in and handed over at 393x852 (scale 2), checks
the compact order block, the games carousel, the «Чек»/«Поддержка» tiles and the removed
address row, and saves viewport, bottom and stitched full-length screenshots.

CUSTOMER_AUTH_URL (optional) points at the Kaspi customer-auth export: the bank-paid sheet is
checked for kitchen, assembly and ready with its status-only «Чек» tile.
TRACKER_MODE=sim|kaspi|all selects the export to check (default: all when
CUSTOMER_AUTH_URL is set, otherwise sim). CI jobs can run each export independently.
Screenshots go to TRACKER_SHOTS_DIR (default .local/tracker-redesign). No external requests.
"""
from browser_network import isolated_context, route_fixture
from account_fixture import signed_in
import copy, json, os, subprocess, uuid
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4182').rstrip('/')
KASPI_URL = os.environ.get('CUSTOMER_AUTH_URL', '').rstrip('/')
MODE = os.environ.get('TRACKER_MODE', 'all' if KASPI_URL else 'sim')
assert MODE in ('sim', 'kaspi', 'all'), f'Unknown TRACKER_MODE: {MODE}'
assert MODE == 'sim' or KASPI_URL, 'CUSTOMER_AUTH_URL is required for Kaspi checks'
for url in filter(None, [URL, KASPI_URL]):
    assert urlparse(url).hostname in ('localhost', '127.0.0.1')
OUT = Path(os.environ.get('TRACKER_SHOTS_DIR', ROOT / '.local/tracker-redesign'))
OUT.mkdir(parents=True, exist_ok=True)
WIDTH, HEIGHT = 393, 852
CAT = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js';console.log(JSON.stringify(testCompleteCatalog))"], cwd=ROOT, text=True))
META = {'synthetic': True, 'namespace': 'pickchick-test'}
BRANCH = CAT['branch_id']
NOW = datetime.now(timezone.utc)
iso = lambda moment: moment.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
CREATED = iso(NOW - timedelta(minutes=6))
COMBO = next(p for p in CAT['products'] if p['id'] == 'pick-combo')
SELECTIONS = [{'group_id': g['id'], 'option_id': o['id'], 'quantity': o['default_quantity'], 'group_label': g['title'], 'option_label': o['label'], 'price_delta_minor': o['price_delta_minor']}
              for g in COMBO.get('modifier_groups', []) for o in g['options'] if o.get('default_quantity', 0) > 0]
LINE = {**{k: COMBO[k] for k in ['id', 'name', 'description', 'category', 'price_minor', 'image_id', 'prep_required', 'serving_label', 'nutrition', 'nutrition_provenance']},
        'line_id': 'pick-combo|' + '|'.join(f"{s['group_id']}:{s['option_id']}:{s['quantity']}" for s in SELECTIONS),
        'base_price_minor': COMBO['price_minor'], 'quantity': 1, 'line_total_minor': COMBO['price_minor'], 'selections': SELECTIONS}
QUOTE = {**META, 'quote_id': str(uuid.uuid4()), 'branch_id': BRANCH, 'catalog_version': CAT['catalog_version'], 'channel': 'mobile', 'service_mode': 'takeaway',
         'currency': 'KZT', 'total_minor': COMBO['price_minor'], 'lines': [LINE], 'payment_method': 'card', 'estimated_minutes': {'min': 7, 'max': 7},
         'created_at': CREATED, 'expires_at': '2099-01-01T00:00:00.000Z'}
ORDER = {**META, 'order_id': str(uuid.uuid4()), 'number': '12', 'branch_id': BRANCH, 'version': 2, 'state': 'preparing', 'payment_state': 'not_started',
         'payment_attempt_id': None, 'fiscal_state': 'not_applicable', 'snapshot': QUOTE,
         'tasks': [{'task_id': str(uuid.uuid4()), 'station': s, 'title': s, 'state': 'pending', 'mandatory': True} for s in ['prep', 'assembly']],
         'created_at': CREATED, 'updated_at': CREATED, 'cancellation_reason': None}
SESSION = {**META, 'session_id': str(uuid.uuid4()), 'token': 'a' * 64, 'expires_at': '2099-01-01T00:00:00.000Z', 'channel': 'mobile'}
CAPABILITIES = {'schema_version': 1, 'environment': 'staging', 'data_mode': 'synthetic', 'ordering_enabled': False,
                'features': {**{k: False for k in ['phone_auth', 'payments', 'fiscal', 'checkout', 'loyalty']}, 'test_order_flow': True}}
BRANCHES = {'branches': [{'id': BRANCH, 'code': 'TEST', 'name': 'ТЦ Abay Plaza', 'timezone': 'Asia/Almaty', 'ordering_enabled': False}]}
MENU = {'schema_version': 1, 'branch_id': BRANCH, 'release_id': str(uuid.uuid4()), 'version': 1, 'published_at': CREATED, 'items': []}
CONTENT = {'schema_version': 1, 'branch_id': BRANCH, 'promos': [], 'games': []}
ADDRESS = json.loads((ROOT / 'config/restaurant-locations.json').read_text())['locations'][0]['address']
errors = []
try:
    from PIL import Image  # Optional: only the stitched full-length screenshot needs Pillow.
except ImportError:
    Image = None


def settle(page):
    page.wait_for_timeout(350)
    page.wait_for_function('() => [...document.images].every((img) => img.complete)', timeout=15000)
    page.wait_for_timeout(150)


def capture(page, name):
    """Viewport at the top, viewport at the bottom, and (with Pillow) the stitched sheet."""
    scroll = page.get_by_test_id('order-status-scroll')
    scroll.evaluate('(el) => { el.scrollTop = 0; }')
    settle(page)
    top = page.screenshot(path=str(OUT / f'{name}.png'))
    total, view = scroll.evaluate('(el) => [el.scrollHeight, el.clientHeight]')
    box = scroll.bounding_box()
    parts = []
    for y in list(range(0, max(total - view, 0), view)) + [max(total - view, 0)]:
        scroll.evaluate('(el, y) => { el.scrollTop = y; }', y)
        page.wait_for_timeout(120)
        parts.append((scroll.evaluate('(el) => el.scrollTop'), page.screenshot(clip=box)))
    settle(page)
    page.screenshot(path=str(OUT / f'{name}-bottom.png'))
    if Image is None:
        return
    scale = 2
    head = Image.open(BytesIO(top))
    canvas = Image.new('RGB', (head.width, round((box['y'] + total + HEIGHT - box['y'] - box['height']) * scale)))
    canvas.paste(head.crop((0, 0, head.width, round(box['y'] * scale))), (0, 0))
    for offset, data in parts:
        canvas.paste(Image.open(BytesIO(data)), (round(box['x'] * scale), round((box['y'] + offset) * scale)))
    tail = head.crop((0, round((box['y'] + box['height']) * scale), head.width, head.height))
    canvas.paste(tail, (0, canvas.height - tail.height))
    canvas.save(OUT / f'{name}-full.png')


def check_bottom(page, playing_title, tiles):
    """Brief section 4: compact order, carousel, tiles; no address row, no long dash."""
    items = page.get_by_test_id('order-status-items')
    expect(items).to_contain_text('Ваш заказ')
    expect(items).to_contain_text('1 поз. · 4 190 ₸')
    expect(items).to_contain_text('Pick Combo')
    expect(items).to_contain_text('×1')
    games = page.get_by_test_id('order-games')
    expect(games).to_be_visible()
    expect(page.get_by_test_id('order-games-title')).to_have_text(playing_title)
    expect(page.get_by_test_id('order-games-counter')).to_have_text('1 / 3')
    for test_id in ['order-play-blocks', 'order-play-pick-man', 'order-play-magic-sort']:
        expect(page.get_by_test_id(test_id)).to_have_count(1)
    expect(page.get_by_test_id('order-play-pick-farm')).to_have_count(0)
    card = page.get_by_test_id('order-play-blocks').bounding_box()
    assert round(card['width']) == 300 and round(card['height']) == 200, card
    second = page.get_by_test_id('order-play-pick-man').bounding_box()
    assert round(second['x'] - card['x']) == 312 and second['x'] < WIDTH, (card, second)
    dots = [page.get_by_test_id(f'order-games-dot-{i}').bounding_box() for i in range(3)]
    assert [round(d['width']) for d in dots] == [18, 6, 6], dots
    for test_id in tiles:
        tile = page.get_by_test_id(test_id)
        expect(tile).to_be_visible()
        assert tile.bounding_box()['height'] >= 44
    sheet_text = page.get_by_test_id('order-status-scroll').inner_text()
    assert ADDRESS not in sheet_text and 'Ждём вас в зале' not in sheet_text and 'Заберите с собой' not in sheet_text
    assert '—' not in sheet_text, 'UI copy uses a plain hyphen'
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')


def swipe_carousel(page):
    """The carousel follows the scroll position; nothing moves on its own.

    React Native Web replaces the node's scrollTo() with the RN signature, so set scrollLeft.
    """
    track = page.get_by_test_id('order-games-track')
    page.wait_for_timeout(600)
    expect(page.get_by_test_id('order-games-counter')).to_have_text('1 / 3')
    track.evaluate('(el) => { el.scrollLeft = 312; }')
    expect(page.get_by_test_id('order-games-counter')).to_have_text('2 / 3')
    assert round(page.get_by_test_id('order-games-dot-1').bounding_box()['width']) == 18
    settle(page)
    page.get_by_test_id('order-games').screenshot(path=str(OUT / 'tracker-carousel-2.png'))
    track.evaluate('(el) => { el.scrollLeft = el.scrollWidth; }')
    expect(page.get_by_test_id('order-games-counter')).to_have_text('3 / 3')
    settle(page)
    page.get_by_test_id('order-games').screenshot(path=str(OUT / 'tracker-carousel-3.png'))
    track.evaluate('(el) => { el.scrollLeft = 0; }')
    expect(page.get_by_test_id('order-games-counter')).to_have_text('1 / 3')


def play_from_order(page, prefix, reopen=None):
    """Exercise navigation and touch input on web; native presentation is a separate check."""
    source_url = page.url
    for tile, game, screen, exit_button in [
        ('order-play-blocks', 'pick-blocks', 'pick-blocks-screen', lambda: page.get_by_test_id('blocks-exit')),
        ('order-play-pick-man', 'pick-man', 'pick-man-screen', lambda: page.get_by_test_id('pick-man-exit')),
        ('order-play-magic-sort', 'magic-sort', 'magic-sort-screen', lambda: page.get_by_role('button', name='Выйти из Magic Sort')),
    ]:
        page.get_by_test_id(tile).click()
        page.wait_for_url('**/games/' + game + '?**')
        assert parse_qs(urlparse(page.url).query).get('from') == ['order'], page.url
        expect(page.get_by_test_id(screen)).to_be_visible()
        expect(page.get_by_test_id('order-status-scroll')).not_to_be_visible()
        if game == 'pick-man':
            expect(exit_button()).to_have_attribute('aria-label', 'К заказу')
            page.get_by_test_id('pick-man-start').click()
            board = page.get_by_test_id('pick-man-board')
            expect(board).to_be_visible()
            before = page.get_by_test_id(screen).bounding_box()
            box = board.bounding_box()
            x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
            touch = page.context.new_cdp_session(page)
            for dx, dy in [(0, 65), (-65, 0), (65, 0), (0, -65)]:
                touch.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
                for step in range(1, 5):
                    touch.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x + dx * step / 4, 'y': y + dy * step / 4}]})
                    page.wait_for_timeout(20)
                touch.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
                assert page.get_by_test_id(screen).bounding_box() == before
            touch.detach()
            page.get_by_test_id('pick-man-pause').click()
            expect(page.get_by_text('К заказу', exact=True)).to_be_visible()
            page.wait_for_function('JSON.parse(localStorage.getItem("pickchick.pick-man.v1"))?.game.desired === "up"')
            page.screenshot(path=str(OUT / f'{prefix}-pick-man-gestures.png'))
        exit_button().click()
        page.wait_for_url(source_url)
        if reopen:
            reopen()
        expect(page.get_by_test_id('order-status-scroll')).to_be_visible()


def test_flow(browser):
    ctx = isolated_context(browser, viewport={'width': WIDTH, 'height': HEIGHT}, device_scale_factor=2, reduced_motion='reduce', has_touch=True)
    signed_in(ctx)
    ctx.add_init_script('localStorage.setItem("pickchick.test.customer.v1",' + json.dumps(json.dumps(SESSION)) + ')')
    order = copy.deepcopy(ORDER)
    waiting, teardown = [], [False]

    def intercept(r):
        if teardown[0]:
            r.abort(); return
        path = urlparse(r.request.url).path
        if path == '/v1/test/orders/watch':
            if r.request.post_data_json['versions'][0]['version'] == order['version']:
                waiting.append(r); return
            data = {**META, 'orders': [order]}
        elif path == '/v1/test/orders': data = {**META, 'orders': [order]}
        elif path.endswith('/feedback'): data = {'review': None, 'tickets': []}
        elif path == '/v1/test/catalog': data = CAT
        elif path == '/v1/capabilities': data = CAPABILITIES
        elif path == '/v1/branches': data = BRANCHES
        elif path.endswith('/menu'): data = MENU
        elif '/content/branches/' in path: data = CONTENT
        else:
            r.abort(); return
        r.fulfill(json=data, headers={'Access-Control-Allow-Origin': '*'})

    route_fixture(ctx, '**/v1/**', intercept)
    page = ctx.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL + '/orders')
    expect(page.get_by_test_id('launch-reveal')).to_have_count(0, timeout=20000)
    page.get_by_test_id('history-order-' + order['order_id']).click(timeout=20000)

    def advance(state, prep, assembly, mode='takeaway'):
        order['state'] = state; order['version'] += 1; order['updated_at'] = iso(datetime.now(timezone.utc))
        order['tasks'][0]['state'] = prep; order['tasks'][1]['state'] = assembly
        order['snapshot']['service_mode'] = mode
        page.wait_for_timeout(100)
        for route in waiting[:]:
            route.fulfill(json={**META, 'orders': [order]}); waiting.remove(route)

    stages = [
        ('kitchen', None, 'Готовим для вас', 'cooking', 'Пока готовим - сыграйте'),
        ('assembly', ('preparing', 'done', 'pending'), 'Собираем заказ', 'assembly', 'Пока готовим - сыграйте'),
        ('ready-takeaway', ('ready', 'done', 'done'), 'Заказ готов!', 'ready-takeaway', 'Ещё один раунд?'),
        ('ready-dine-in', ('ready', 'done', 'done', 'dine_in'), 'Заказ готов!', 'ready', 'Ещё один раунд?'),
        ('handed-over', ('fulfilled', 'done', 'done'), 'Приятного аппетита!', 'ready-takeaway', 'Ещё один раунд?'),
    ]
    for name, step, title, scene, playing in stages:
        if step:
            advance(*step)
        expect(page.get_by_test_id('connected-order-state')).to_have_text(title, timeout=10000)
        expect(page.get_by_test_id('order-chef-' + scene)).to_be_visible()
        check_bottom(page, playing, ['order-receipt', 'order-support'])
        expect(page.get_by_test_id('order-rate')).to_have_count(1 if name == 'handed-over' else 0)
        if name == 'kitchen':
            swipe_carousel(page)
        capture(page, f'tracker-{name}')
    play_from_order(page, 'sim')
    teardown[0] = True
    for held in waiting:
        try: held.abort()
        except Exception: pass
    page.wait_for_timeout(50)
    ctx.close()


def kaspi_flow(browser):
    customer_id = '40000000-0000-4000-8000-000000000001'
    order_id = '40000000-0000-4000-8000-000000000003'
    future = iso(datetime.now(timezone.utc) + timedelta(hours=2))
    customer = {'id': customer_id, 'phone': '+77000000000', 'nickname': 'UI test', 'birth_date': None, 'gender': None, 'profile_completed_at': None, 'created_at': '2026-09-07T10:00:00.000Z'}
    envelope = {'version': 1, 'device_id': '40000000-0000-4000-8000-000000000004', 'tokens': {'access_token': 'a' * 64, 'refresh_token': 'b' * 64, 'access_expires_at': future,
                'session_id': '40000000-0000-4000-8000-000000000002', 'customer': customer}, 'challenge': None, 'otp_request': None, 'verify_intent': None,
                'refresh_request_id': None, 'closing': None}
    state = {'phase': 'preparing', 'stage': 'cooking', 'revision': 1, 'held': [], 'teardown': False}

    def order():
        return {'orderId': order_id, 'revision': hex(state['revision'])[2:].zfill(64), 'restaurant': 'ТЦ Abay Plaza', 'branchId': BRANCH, 'createdAt': CREATED,
                'updatedAt': iso(datetime.now(timezone.utc)), 'kitchenStage': state['stage'] if state['phase'] == 'preparing' else None, 'displayNumber': '12',
                'totalMinor': '419000', 'serviceMode': 'takeaway', 'kitchenComment': None, 'phase': state['phase'], 'expiresAt': None, 'receipt': 'deferred',
                'receiptUrl': None, 'items': [{'productId': 'pick-combo', 'title': 'Pick Combo', 'quantity': 1, 'totalMinor': '419000', 'modifiers': [s['option_label'] for s in SELECTIONS]}]}

    ctx = isolated_context(browser, viewport={'width': WIDTH, 'height': HEIGHT}, device_scale_factor=2, reduced_motion='reduce', has_touch=True)
    ctx.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",' + json.dumps(json.dumps(envelope)) + ');')

    def route(r):
        if state['teardown']:
            r.abort(); return
        path = urlparse(r.request.url).path; method = r.request.method
        if path == '/v1/customers/me': data = {'customer': customer, 'legal': {'version':'fixture-v1','terms_url':'https://example.test/terms','privacy_url':'https://example.test/privacy','accepted':True}}
        elif path == '/v1/auth/config': data = {'enabled': True, 'delivery_consent_required': True, 'consent_version': 'fixture-v1', 'terms_url': 'https://example.test/terms', 'privacy_url': 'https://example.test/privacy'}
        elif path == '/v1/capabilities': data = {**CAPABILITIES, 'data_mode': 'pilot', 'features': {**CAPABILITIES['features'], 'phone_auth': True}}
        elif path == '/v1/branches': data = BRANCHES
        elif path == '/v1/branches/' + BRANCH + '/menu': data = MENU
        elif path == '/v1/test/catalog': data = CAT
        elif path == '/v1/content/branches/' + BRANCH: data = CONTENT
        elif path == '/v1/customer-checkout/availability': data = {'enabled': True, 'fresh': True, 'signature': 'a' * 64, 'products': [{'id': p['id'], 'available': True, 'stoppedOptions': []} for p in CAT['products']]}
        elif path == '/v1/customer-checkout/config': data = {'enabled': True, 'branchId': '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1', 'restaurant': 'ТЦ Abay Plaza', 'fiscalPolicy': 'deferred_pilot', 'orderCommentEnabled': True}
        elif path == '/v1/customer-checkout/feedback' and method == 'GET': data = {'feedback': []}
        elif path == '/v1/customer-checkout/orders' and method == 'GET': data = {'orders': [order()]}
        elif path == f'/v1/customer-checkout/orders/{order_id}/watch':
            state['held'].append(r); return
        else:
            r.abort(); return
        r.fulfill(json=data, headers={'Access-Control-Allow-Origin': '*'})

    route_fixture(ctx, '**/v1/**', route)
    page = ctx.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(KASPI_URL + '/orders')
    page.get_by_test_id(f'order-history-open-{order_id}').click(timeout=25000)

    def advance(phase, stage=None):
        state['phase'] = phase; state['stage'] = stage; state['revision'] += 1
        page.wait_for_timeout(150)
        for held in state['held'][:]:
            held.fulfill(json=order(), headers={'Access-Control-Allow-Origin': '*'}); state['held'].remove(held)

    for name, step, scene, playing in [
        ('kitchen', None, 'cooking', 'Пока готовим - сыграйте'),
        ('assembly', ('preparing', 'assembly'), 'assembly', 'Пока готовим - сыграйте'),
        ('ready-takeaway', ('ready',), 'ready-takeaway', 'Ещё один раунд?'),
    ]:
        if step:
            advance(*step)
        expect(page.get_by_test_id('order-chef-' + scene)).to_be_visible(timeout=10000)
        check_bottom(page, playing, ['order-receipt'])
        receipt = page.get_by_test_id('order-receipt')
        expect(receipt).to_contain_text('Фискальный чек пока не выпускается - Webkassa подключается.')
        assert receipt.get_attribute('role') != 'button', 'Status-only receipt tile is not an action'
        expect(page.get_by_test_id('order-support')).to_have_count(0)
        capture(page, f'kaspi-tracker-{name}')
    # History's native Modal closes before opening a game. Back returns to the same history;
    # reopening the same order must still show its current state, without starting a new order.
    play_from_order(page, 'kaspi', lambda: page.get_by_test_id(f'order-history-open-{order_id}').click())
    state['teardown'] = True
    for held in state['held']:
        try: held.abort()
        except Exception: pass
    page.wait_for_timeout(50)
    ctx.close()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        if MODE in ('sim', 'all'):
            test_flow(browser)
        if MODE in ('kaspi', 'all'):
            kaspi_flow(browser)
        browser.close()
    assert not errors, errors
    stages = {'sim': '5 test-flow stages', 'kaspi': '3 Kaspi stages', 'all': '5 test-flow + 3 Kaspi stages'}[MODE]
    print(f'PASS tracker redesign: {stages}, compact order, games carousel, tiles, no address row; shots in {OUT}')


if __name__ == '__main__':
    main()
