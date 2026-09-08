"""Offline Pick Blocks journeys, persistence and touch geometry on a local export."""
import json
import os
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4182').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost'), 'Only a loopback export may be tested'
KEY = 'pickchick.pick-blocks.v1'
OUTPUT = ROOT / '.local/pick-blocks/browser'
OUTPUT.mkdir(parents=True, exist_ok=True)


def game_fixture(kind='movement'):
    # Generate rules-version-compatible fixtures from the actual engine. Full
    # serialized game boards are intentionally not copied into the repository.
    source = """
      import { createGame, parseGame } from './apps/mobile/src/games/pick-blocks/engine.ts';
      const game = createGame(29);
      game.active = {kind:'T', rotation:0, x:3, y:0};
      const scenario = process.argv[1];
      if (scenario === 'clear') {
        for (let y=16; y<20; y++) game.board[y] = Array.from({length:10}, (_,x)=>x===5?null:'J');
        game.active = {kind:'I', rotation:1, x:3, y:16};
      }
      if (scenario === 'over') {
        game.board[1][4] = 'J';
        game.board[1][5] = 'J';
        game.active = {kind:'O', rotation:0, x:4, y:-1};
        game.score = 120;
      }
      if (!parseGame(game)) throw new Error('Invalid browser fixture');
      console.log(JSON.stringify({version:1, best:75, game}));
    """
    result = subprocess.run(
        ['node', '--input-type=module', '-e', source, kind], cwd=ROOT,
        capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


def saved(page):
    return page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY)


def wait_saved(page, predicate):
    page.wait_for_function(
        """({key, predicate}) => {
          const raw = localStorage.getItem(key);
          return raw && new Function('value', 'return (' + predicate + ')')(JSON.parse(raw));
        }""", arg={'key': KEY, 'predicate': predicate}, timeout=5000,
    )
    return saved(page)


def pause(page):
    page.get_by_test_id('blocks-pause').click()
    expect(page.get_by_test_id('blocks-resume')).to_be_visible()
    return wait_saved(page, 'value.game !== null')


def resume(page):
    page.get_by_test_id('blocks-resume').click()
    expect(page.get_by_test_id('blocks-resume')).not_to_be_visible()
    expect(page.get_by_test_id('blocks-left')).to_be_enabled()


def assert_still_paused(page):
    expect(page.get_by_test_id('blocks-resume')).to_be_visible()
    before = saved(page)
    board_before = page.get_by_test_id('blocks-board').inner_html()
    page.wait_for_timeout(1100)
    assert saved(page) == before, 'Paused game must not advance or auto-save another move'
    assert page.get_by_test_id('blocks-board').inner_html() == board_before, 'Paused piece moved'
    expect(page.get_by_test_id('blocks-resume')).to_be_visible()


def geometry(page):
    # onLayout and useWindowDimensions settle on separate animation frames.
    last = None
    stable_since = time.monotonic()
    deadline = stable_since + 8
    while time.monotonic() < deadline:
        current = page.evaluate("""() => {
          const ids = ['blocks-board','blocks-stage','blocks-controls','blocks-left',
            'blocks-right','blocks-rotate','blocks-down','blocks-drop'];
          return Object.fromEntries(ids.map(id => [id,
            document.querySelector('[data-testid="'+id+'"]')?.getBoundingClientRect().toJSON()]));
        }""")
        if current != last:
            stable_since = time.monotonic()
            last = current
        elif current.get('blocks-board') and time.monotonic() - stable_since >= .2:
            return current
        page.wait_for_timeout(40)
    raise AssertionError(f'Game layout did not settle: {last}')


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    errors = []
    requests = []
    contexts = []

    def open_game(snapshot=None, extra_script='', path='/games/pick-blocks', size=(393, 852)):
        context = browser.new_context(
            viewport={'width': size[0], 'height': size[1]}, reduced_motion='reduce',
        )
        contexts.append(context)

        def block_api(route):
            requests.append((route.request.method, urlparse(route.request.url).path))
            route.abort()

        context.route('**/v1/**', block_api)
        if snapshot is not None or extra_script:
            raw = json.dumps(snapshot, ensure_ascii=False) if snapshot is not None else None
            context.add_init_script(f"""
              const key = {json.dumps(KEY)};
              const raw = {json.dumps(raw)};
              if (raw !== null && localStorage.getItem(key) === null) localStorage.setItem(key, raw);
              {extra_script}
            """)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + path)
        return page

    # Entry from Events, rules, start and the complete five-button control path.
    page = open_game(path='/events')
    expect(page.get_by_test_id('pick-blocks-open')).to_be_visible(timeout=20000)
    page.get_by_test_id('pick-blocks-open').click()
    expect(page.get_by_test_id('blocks-start')).to_be_visible()
    page.get_by_test_id('blocks-help').click()
    expect(page.get_by_text('Игровые очки не переводятся в Чики.', exact=False)).to_be_visible()
    page.get_by_test_id('blocks-help-close').click()
    expect(page.get_by_test_id('blocks-start')).to_be_visible()
    page.screenshot(path=str(OUTPUT / 'intro.png'))
    page.get_by_test_id('blocks-start').click()
    expect(page.get_by_test_id('blocks-board')).to_be_visible()
    wait_saved(page, 'value.game && value.game.piecesPlaced === 0')
    page.get_by_test_id('blocks-drop').click()
    wait_saved(page, 'value.game.piecesPlaced === 1')
    page.get_by_test_id('blocks-help').click()
    page.get_by_test_id('blocks-help-close').click()
    assert_still_paused(page)

    # A deterministic T lets movement/rotation be asserted without a random O.
    moves = open_game(game_fixture())
    assert_still_paused(moves)
    resume(moves)
    moves.get_by_test_id('blocks-left').click()
    pause(moves)
    assert wait_saved(moves, 'value.game.active.x === 2')['game']['active']['x'] == 2
    resume(moves)
    moves.get_by_test_id('blocks-right').click()
    moves.get_by_test_id('blocks-rotate').click()
    moves.get_by_test_id('blocks-down').click()
    pause(moves)
    moved = wait_saved(moves, 'value.game.active.x === 3 && value.game.active.rotation === 1')
    assert moved['game']['active']['y'] >= 1 and moved['game']['score'] >= 1

    # Blur/focus, help, reload and leaving the route require an explicit resume.
    resume(moves)
    moves.evaluate("window.dispatchEvent(new Event('blur'))")
    moves.evaluate("window.dispatchEvent(new Event('focus'))")
    assert_still_paused(moves)
    moves.get_by_role('button', name='Как играть', exact=True).last.click()
    moves.get_by_test_id('blocks-help-close').click()
    assert_still_paused(moves)
    before_reload = saved(moves)
    moves.reload()
    assert_still_paused(moves)
    assert saved(moves) == before_reload
    moves.get_by_test_id('blocks-leave-paused').click()
    expect(moves.get_by_test_id('screen-M26')).to_be_visible()
    moves.get_by_test_id('pick-blocks-open').click()
    assert_still_paused(moves)
    assert saved(moves) == before_reload
    resume(moves)
    moves.get_by_test_id('blocks-exit').click()
    expect(moves.get_by_test_id('screen-M26')).to_be_visible()
    moves.get_by_test_id('pick-blocks-open').click()
    assert_still_paused(moves)

    # Four rows really clear through the rendered controls, with the engine's score.
    clear = open_game(game_fixture('clear'))
    resume(clear)
    clear.get_by_test_id('blocks-drop').click()
    result = wait_saved(clear, 'value.game.lines === 4')
    assert result['game']['score'] == 800, result['game']['score']
    assert result['best'] == 800
    assert all(cell is None for row in result['game']['board'] for cell in row)
    expect(clear.get_by_test_id('blocks-lines')).to_have_text('4')
    expect(clear.get_by_test_id('blocks-score')).to_have_text('800')
    clear.screenshot(path=str(OUTPUT / 'four-lines.png'))
    pause(clear)

    over = open_game(game_fixture('over'))
    resume(over)
    over.get_by_test_id('blocks-drop').click()
    expect(over.get_by_test_id('blocks-result')).to_have_text('120')
    wait_saved(over, 'value.game.over && value.best === 120')
    over.screenshot(path=str(OUTPUT / 'result.png'))
    over.reload()
    expect(over.get_by_test_id('blocks-replay')).to_be_visible()
    over.get_by_test_id('blocks-replay').click()
    replay = wait_saved(over, '!value.game.over && value.game.score === 0')
    assert replay['best'] == 120
    expect(over.get_by_test_id('blocks-best')).to_contain_text('120')
    pause(over)

    # The complete 10x20 field and all touch controls fit at each phone orientation.
    layout = open_game(game_fixture())
    resume(layout)
    for width, height in [(393, 852), (320, 568), (568, 320), (852, 393), (393, 852)]:
        old_size = layout.viewport_size
        layout.set_viewport_size({'width': width, 'height': height})
        settled = geometry(layout)
        if (old_size['width'] > old_size['height']) != (width > height):
            assert_still_paused(layout)
            resume(layout)
            settled = geometry(layout)
        field = settled['blocks-board']
        assert abs((field['height'] - 2) - 2 * (field['width'] - 2)) <= 1, field
        assert 0 <= field['x'] and 0 <= field['y'], field
        assert field['right'] <= width + 1 and field['bottom'] <= height + 1, field
        buttons = [settled['blocks-' + name] for name in ['left', 'right', 'rotate', 'down', 'drop']]
        for button in buttons:
            assert button['width'] >= 48 and button['height'] >= 48, (width, height, button)
            assert button['x'] >= 0 and button['y'] >= 0, button
            assert button['right'] <= width + 1 and button['bottom'] <= height + 1, button
            overlap = (min(field['right'], button['right']) > max(field['x'], button['x']) and
                       min(field['bottom'], button['bottom']) > max(field['y'], button['y']))
            assert not overlap, (field, button)
        layout.screenshot(path=str(OUTPUT / f'playing-{width}x{height}.png'))
    pause(layout)

    # One denied write shows recovery; retry persists without losing the live game.
    write_failure = open_game(extra_script="""
      const original = Storage.prototype.setItem;
      let failOnce = true;
      Storage.prototype.setItem = function(name, value) {
        if (name === key && failOnce) { failOnce = false; throw new DOMException('Quota', 'QuotaExceededError'); }
        return original.call(this, name, value);
      };
    """)
    write_failure.get_by_test_id('blocks-start').click()
    notice = write_failure.get_by_text('Игра пока не сохранилась. Повторить', exact=True)
    expect(notice).to_be_visible()
    assert saved(write_failure) is None
    notice.click()
    expect(notice).not_to_be_visible()
    wait_saved(write_failure, 'value.game && !value.game.over')
    pause(write_failure)

    # An unreadable existing game is kept intact, and retry restores it paused.
    original = game_fixture()
    read_failure = open_game(original, extra_script="""
      const original = Storage.prototype.getItem;
      let failOnce = true;
      Storage.prototype.getItem = function(name) {
        if (name === key && failOnce) { failOnce = false; throw new DOMException('Unavailable', 'SecurityError'); }
        return original.call(this, name);
      };
    """)
    expect(read_failure.get_by_test_id('blocks-start')).to_be_visible()
    assert saved(read_failure) == original
    read_failure.get_by_text('Игра пока не сохранилась. Повторить', exact=True).click()
    assert_still_paused(read_failure)
    assert saved(read_failure) == original

    assert errors == [], errors
    assert all(method == 'GET' for method, _ in requests), requests
    print(json.dumps({'result': 'PASS', 'api_requests_blocked': len(requests),
                      'phone_sizes': ['393x852', '320x568', '568x320', '852x393'],
                      'screenshots': str(OUTPUT)}, ensure_ascii=False))
    for context in contexts:
        context.close()
    browser.close()
