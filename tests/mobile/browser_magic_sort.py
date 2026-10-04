"""Magic Sort journeys on a loopback Expo export, using the actual seeded engine."""
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
from account_fixture import ACCOUNT, signed_in

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('MAGIC_SORT_UI_URL', 'http://127.0.0.1:4190').rstrip('/')
assert urlparse(URL).hostname in ('localhost', '127.0.0.1'), 'Only a loopback export may be tested'
OUT = ROOT / '.local/magic-sort/browser'
OUT.mkdir(parents=True, exist_ok=True)


def fixture():
    source = """
      import {createLevel,pour,parseGame,isWon} from './apps/mobile/src/games/magic-sort/engine.ts';
      const game=createLevel(1), first=game.witness[0];
      const afterFirst=pour(game,first.from,first.to);
      const illegal=Array.from({length:25},(_,to)=>to).find(to=>
        to!==first.from && !pour(game,first.from,to));
      let won=game;
      for(const move of game.witness) won=pour(won,move.from,move.to);
      if(!parseGame(game)||!afterFirst||illegal===undefined||!isWon(won)) throw Error('Invalid engine fixture');
      let hash=2166136261;
      for(const char of process.argv[1]) hash=Math.imul(hash^char.charCodeAt(0),16777619);
      console.log(JSON.stringify({game,afterFirst,illegal,won,
        key:'pickchick.magic-sort.v1:demo-'+(hash>>>0).toString(16)}));
    """
    return json.loads(subprocess.check_output(
        ['node', '--input-type=module', '-e', source, ACCOUNT['phone']], cwd=ROOT, text=True))


FIXTURE = fixture()
KEY = FIXTURE['key']


def saved(page):
    return page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))', KEY)


def wait_history(page, count):
    page.wait_for_function("""({key,count})=>{
      const raw=localStorage.getItem(key);
      return raw && JSON.parse(raw).history.length===count;
    }""", arg={'key': KEY, 'count': count}, timeout=10000)
    return saved(page)


def bottle(page, index):
    return page.get_by_test_id('magic-sort-collector' if index == 24 else f'magic-sort-bottle-{index}')


def pour(page, move, count):
    bottle(page, move['from']).click()
    bottle(page, move['to']).click()
    state = wait_history(page, count)
    assert state['history'][-1] == move
    return state


def geometry(page):
    page.wait_for_function("""()=>{
      const b=document.querySelector('[data-testid="magic-sort-board"]')?.getBoundingClientRect();
      return b && b.width>0 && b.height>0;
    }""")
    # RN Web onLayout settles independently from the first render.
    page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    bounds = page.evaluate("""()=>{
      const ids=['magic-sort-board','magic-sort-collector','magic-sort-undo',
        'magic-sort-hint','magic-sort-restart','magic-sort-pause',
        ...Array.from({length:24},(_,i)=>'magic-sort-bottle-'+i)];
      return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,
        boxes:Object.fromEntries(ids.map(id=>[id,
          document.querySelector('[data-testid="'+id+'"]')?.getBoundingClientRect().toJSON()]))};
    }""")
    assert not bounds['overflow'], bounds
    for name, box in bounds['boxes'].items():
        assert box and box['width'] > 0 and box['height'] > 0, name
        assert box['x'] >= -1 and box['y'] >= -1, (name, box)
        assert box['right'] <= bounds['width'] + 1 and box['bottom'] <= bounds['height'] + 1, (name, box, bounds)
    for i in range(24):
        expect(bottle(page, i)).to_be_visible()
    return bounds


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    errors, blocked, contexts = [], [], []

    def open_game(size=(390, 844), path='/games/magic-sort', motion='reduce'):
        context = browser.new_context(viewport={'width': size[0], 'height': size[1]},
                                      reduced_motion=motion, has_touch=True)
        contexts.append(context)
        signed_in(context)
        context.add_init_script("""(()=>{
          const key=%s;
          if(localStorage.getItem(key)===null) localStorage.setItem(key,%s);
        })();""" % (json.dumps(KEY), json.dumps(json.dumps(FIXTURE['game']))))

        def network(route):
            request = route.request
            target = urlparse(request.url)
            if target.hostname == urlparse(URL).hostname and not target.path.startswith('/v1/'):
                route.continue_()
            else:
                blocked.append({'method': request.method, 'path': target.path})
                route.abort()

        context.route('**/*', network)
        page = context.new_page()
        page.set_default_timeout(10000)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + path)
        return page

    page = open_game()
    expect(page.get_by_test_id('magic-sort-screen')).to_be_visible(timeout=20000)
    expect(page.get_by_test_id('magic-sort-board')).to_be_visible()
    geometry(page)
    assert saved(page) == FIXTURE['game']
    page.get_by_test_id('magic-sort-help').click()
    expect(page.get_by_test_id('magic-sort-panel-confirm')).to_be_visible()
    expect(page.get_by_text('Монеты и награды не начисляются.', exact=False)).to_be_visible()
    page.get_by_test_id('magic-sort-panel-confirm').click()
    page.screenshot(path=str(OUT / 'level-390.png'))

    first = FIXTURE['game']['witness'][0]
    bottle(page, first['from']).click()
    bottle(page, FIXTURE['illegal']).click()
    expect(page.get_by_test_id('magic-sort-notice')).to_contain_text('нельзя перелить')
    assert saved(page) == FIXTURE['game'], 'Illegal pour must not persist a move'
    bottle(page, first['from']).click()  # Cancel the still-selected source.
    assert pour(page, first, 1) == FIXTURE['afterFirst']
    page.get_by_test_id('magic-sort-undo').click()
    assert wait_history(page, 0) == FIXTURE['game']
    pour(page, first, 1)
    before = saved(page)
    page.reload()
    expect(page.get_by_test_id('magic-sort-board')).to_be_visible()
    assert saved(page) == before, 'Reload must restore the exact account-scoped progress'
    page.get_by_test_id('magic-sort-restart').click()
    expect(page.get_by_test_id('magic-sort-panel-confirm')).to_be_visible()
    assert saved(page) == before, 'Opening reset confirmation must not reset progress'
    page.get_by_role('button', name='Продолжить уровень', exact=True).click()
    assert saved(page) == before, 'Cancelling reset must preserve progress'
    page.get_by_test_id('magic-sort-restart').click()
    page.get_by_test_id('magic-sort-panel-confirm').click()
    assert wait_history(page, 0) == FIXTURE['game']

    # Every winning move is made through the actual bottle controls. Neither the
    # final board nor history is injected; the witness comes from this engine.
    for count, move in enumerate(FIXTURE['game']['witness'], 1):
        pour(page, move, count)
    assert saved(page) == FIXTURE['won']
    expect(page.get_by_test_id('magic-sort-won')).to_be_visible()
    expect(page.get_by_role('button', name='Следующий уровень', exact=True)).to_be_visible()
    page.screenshot(path=str(OUT / 'won-390.png'))
    page.get_by_role('button', name='Следующий уровень', exact=True).click()
    state = wait_history(page, 0)
    assert state['seed'] == (FIXTURE['game']['seed'] + 1) % (2 ** 32)
    expect(page.get_by_test_id('magic-sort-won')).to_have_count(0)

    for size in [(320, 568), (430, 932)]:
        narrow = open_game(size=size)
        expect(narrow.get_by_test_id('magic-sort-board')).to_be_visible(timeout=20000)
        geometry(narrow)
        pour(narrow, first, 1)
        narrow.get_by_test_id('magic-sort-undo').click()
        assert wait_history(narrow, 0) == FIXTURE['game']
        narrow.screenshot(path=str(OUT / f'level-{size[0]}.png'))

    # Exercise the actual animation lifecycle separately from the fast winning
    # journey: rapid taps cannot enqueue another move, and pausing cancels the
    # pending transfer before its completion callback may persist it.
    animated = open_game(motion='no-preference')
    expect(animated.get_by_test_id('magic-sort-board')).to_be_visible(timeout=20000)
    source_box = bottle(animated, first['from']).bounding_box()
    target_box = bottle(animated, first['to']).bounding_box()
    def rapid_tap(box):
        animated.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    bottle(animated, first['from']).click()
    rapid_tap(target_box)
    expect(animated.get_by_test_id('magic-sort-pour')).to_be_visible()
    rapid_tap(target_box)
    rapid_tap(source_box)
    assert saved(animated) == FIXTURE['game'], 'Pending animation must not persist early'
    animated.get_by_test_id('magic-sort-pause').click()
    expect(animated.get_by_test_id('magic-sort-resume')).to_be_visible()
    expect(animated.get_by_test_id('magic-sort-pour')).to_have_count(0)
    animated.wait_for_timeout(950)  # Past the original 760ms animation callback.
    assert saved(animated) == FIXTURE['game'], 'Paused animation must never commit later'
    animated.get_by_test_id('magic-sort-resume').click()
    bottle(animated, first['from']).click()
    rapid_tap(target_box)
    expect(animated.get_by_test_id('magic-sort-pour')).to_be_visible()
    rapid_tap(target_box)
    rapid_tap(source_box)
    assert wait_history(animated, 1) == FIXTURE['afterFirst']
    animated.wait_for_timeout(950)
    assert saved(animated) == FIXTURE['afterFirst'], 'Rapid taps must commit exactly one transfer'

    assert not errors, errors
    assert all(request['method'] == 'GET' for request in blocked), blocked
    print(json.dumps({'result': 'PASS', 'bottles': 24, 'witness_moves': len(FIXTURE['game']['witness']),
                      'sizes': ['320x568', '390x844', '430x932'],
                      'normal_motion_pending_cancel_and_single_commit': True,
                      'external_requests_blocked': len(blocked), 'screenshots': str(OUT)}))
    for context in contexts:
        context.close()
    browser.close()
