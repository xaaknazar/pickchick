"""Magic Sort journeys on a loopback Expo export, using the actual seeded engine."""
from browser_network import isolated_context, route_fixture
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
      import {createLevel,createPuzzle,legalMoves,pour,parseGame,isWon} from './apps/mobile/src/games/magic-sort/engine.ts';
      import {serializeRecord} from './apps/mobile/src/games/magic-sort/storage.ts';
      import {POUR_DURATION,POUR_TIMELINE} from './apps/mobile/src/games/magic-sort/motion.ts';
      const game=createPuzzle(), first=game.witness[0];
      // A longer winning route: the witness with a two-pour detour that returns
      // to the same board, found on the actual engine rather than hard-coded.
      const sig=s=>JSON.stringify([s.bottles,s.collector]);
      let longer=null, walk=game;
      for(let k=0;k<=game.witness.length && !longer;k++){
        for(const a of legalMoves(walk)){
          const s1=pour(walk,a.from,a.to);
          const b=legalMoves(s1).find(b=>sig(pour(s1,b.from,b.to))===sig(walk));
          if(b){longer=[...game.witness.slice(0,k),a,b,...game.witness.slice(k)];break;}
        }
        if(k<game.witness.length) walk=pour(walk,game.witness[k].from,game.witness[k].to);
      }
      let replay=game;
      for(const m of longer??[]) replay=replay&&pour(replay,m.from,m.to);
      if(!longer||!replay||!isWon(replay)) throw Error('No longer winning route');
      let legacy=createLevel(7);
      legacy=pour(legacy,legacy.witness[0].from,legacy.witness[0].to);
      const afterFirst=pour(game,first.from,first.to);
      const illegal=Array.from({length:25},(_,to)=>to).find(to=>
        to!==first.from && !pour(game,first.from,to));
      let won=game,collectorBefore=null,collectorMove=null,collectorAfter=null,ordinaryBefore=null,ordinaryMove=null,ordinaryAfter=null;
      for(const move of game.witness) {
        const next=pour(won,move.from,move.to);
        if(move.to===24 && !collectorMove){collectorBefore=won;collectorMove=move;collectorAfter=next;}
        if(move.to!==24 && !ordinaryMove){ordinaryBefore=won;ordinaryMove=move;ordinaryAfter=next;}
        won=next;
      }
      if(!parseGame(game)||!afterFirst||illegal===undefined||!isWon(won)) throw Error('Invalid engine fixture');
      let hash=2166136261;
      for(const char of process.argv[1]) hash=Math.imul(hash^char.charCodeAt(0),16777619);
      const scope='demo-'+(hash>>>0).toString(16);
      console.log(JSON.stringify({game,afterFirst,illegal,won,collectorBefore,collectorMove,collectorAfter,ordinaryBefore,ordinaryMove,ordinaryAfter,POUR_DURATION,POUR_TIMELINE,
        longer,legacy,record:serializeRecord(game.witness.length),
        key:'pickchick.magic-sort.v1:'+scope,recordKey:'pickchick.magic-sort.record.v1:'+scope}));
    """
    return json.loads(subprocess.check_output(
        ['node', '--input-type=module', '-e', source, ACCOUNT['phone']], cwd=ROOT, text=True))


FIXTURE = fixture()
FLOW_ONLY = os.environ.get('MAGIC_SORT_FLOW_ONLY') == 'collector-320'
KEY = FIXTURE['key']
RECORD_KEY = FIXTURE['recordKey']
SHOTS = os.environ.get('MAGIC_SORT_SHOTS')


def shot(page, name):
    page.screenshot(path=str(OUT / name))
    if SHOTS:
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(SHOTS) / name))


def plural(count):
    tens, ones = count % 100, count % 10
    word = 'ходов' if 11 <= tens <= 14 else 'ход' if ones == 1 else 'хода' if 2 <= ones <= 4 else 'ходов'
    return f'{count} {word}'


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


FLOW_FRAME = """({before,after,move})=>{
  const node=id=>document.querySelector('[data-testid="'+id+'"]');
  const source=node('magic-sort-source-fill'),target=node('magic-sort-target-fill');
  if(!source||!target)return null;
  const height=el=>parseFloat(getComputedStyle(el).height);
  const sourceUnit=height(source.parentElement)/4;
  const targetUnit=height(target.parentElement)/(move.to===24?16:4);
  const sourceHeight=height(source),targetHeight=height(target);
  const fromBefore=before.bottles[move.from].length*sourceUnit;
  const fromAfter=after.bottles[move.from].length*sourceUnit;
  const toBefore=(move.to===24?before.collector:before.bottles[move.to]).length*targetUnit;
  const toAfter=(move.to===24?after.collector:after.bottles[move.to]).length*targetUnit;
  const pouring=node('magic-sort-pour'),r=pouring.getBoundingClientRect();
  const css=getComputedStyle(pouring),m=new DOMMatrixReadOnly(css.transform);
  const width=parseFloat(css.width),h=parseFloat(css.height);
  const offset=-h*.475;
  const sourceMouth={x:r.x+r.width/2+m.c*offset,y:r.y+r.height/2+m.d*offset};
  const receiver=node(move.to===24?'magic-sort-collector':'magic-sort-bottle-'+move.to);
  const glass=receiver.firstElementChild.getBoundingClientRect();
  const targetMouth={x:glass.x+glass.width/2,y:glass.y+(move.to===24?glass.width:glass.height)*.025};
  const center=id=>{const b=node(id).getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};};
  const streamSource=center('magic-sort-source-mouth'),streamTarget=center('magic-sort-target-mouth');
  return {sourceHeight,targetHeight,fromBefore,fromAfter,toBefore,toAfter,
    fraction:(fromBefore-sourceHeight)/(fromBefore-fromAfter),
    targetFraction:(targetHeight-toBefore)/(toAfter-toBefore),
    sourceMouth,targetMouth,streamSource,streamTarget,
    sourceBounds:r.toJSON(),movesBounds:node('magic-sort-moves').getBoundingClientRect().toJSON(),
    streamOpacity:parseFloat(getComputedStyle(node('magic-sort-stream')).opacity)};
}"""


def flow_frame(page, before, after, move, low, high):
    args = {'before': before, 'after': after, 'move': move, 'low': low, 'high': high}
    page.wait_for_function("""args=>{
      const frame=(%s)(args);
      return frame && frame.fraction>=args.low && frame.fraction<=args.high &&
        (args.low<.98 || frame.streamOpacity<.01);
    }""" % FLOW_FRAME, arg=args, timeout=5000)
    frame = page.evaluate(FLOW_FRAME, args)
    assert frame and low <= frame['fraction'] <= high, frame
    assert abs(frame['fraction'] - frame['targetFraction']) < .04, frame
    return frame


def assert_stream_attached(frame):
    for mouth, stream in [('sourceMouth', 'streamSource'), ('targetMouth', 'streamTarget')]:
        distance = ((frame[mouth]['x'] - frame[stream]['x']) ** 2 +
                    (frame[mouth]['y'] - frame[stream]['y']) ** 2) ** .5
        assert distance <= 4, (mouth, distance, frame)
    assert frame['streamOpacity'] > .5, frame


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    errors, blocked, contexts = [], [], []

    def open_game(size=(390, 844), path='/games/magic-sort', motion='reduce', snapshot=None):
        context = isolated_context(browser,viewport={'width': size[0], 'height': size[1]},
                                      reduced_motion=motion, has_touch=True)
        contexts.append(context)
        signed_in(context)
        context.add_init_script("""(()=>{
          const key=%s;
          if(localStorage.getItem(key)===null) localStorage.setItem(key,%s);
        })();""" % (json.dumps(KEY), json.dumps(json.dumps(snapshot if snapshot is not None else FIXTURE['game']))))

        def network(route):
            request = route.request
            target = urlparse(request.url)
            if target.hostname == urlparse(URL).hostname and not target.path.startswith('/v1/'):
                route.continue_()
            else:
                blocked.append({'method': request.method, 'path': target.path})
                route.abort()

        route_fixture(context,'**/*', network)
        page = context.new_page()
        page.set_default_timeout(10000)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + path)
        return page

    if not FLOW_ONLY:
        page = open_game()
        expect(page.get_by_test_id('magic-sort-screen')).to_be_visible(timeout=20000)
        expect(page.get_by_test_id('magic-sort-board')).to_be_visible()
        geometry(page)
        assert saved(page) == FIXTURE['game']
        expect(page.get_by_test_id('magic-sort-moves')).to_have_text('Ходы: 0')
        expect(page.get_by_test_id('magic-sort-record')).to_have_text('Рекорд: -')
        assert page.evaluate('(k)=>localStorage.getItem(k)', RECORD_KEY) is None
        page.get_by_test_id('magic-sort-help').click()
        expect(page.get_by_test_id('magic-sort-panel-confirm')).to_be_visible()
        expect(page.get_by_text('Монеты и награды не начисляются.', exact=False)).to_be_visible()
        page.get_by_test_id('magic-sort-panel-confirm').click()
        page.screenshot(path=str(OUT / 'level-390.png'))

        first = FIXTURE['game']['witness'][0]
        bottle(page, first['from']).click()
        bottle(page, FIXTURE['illegal']).click()
        expect(bottle(page, FIXTURE['illegal']).locator(':scope > div')).to_have_css('transform', 'matrix(1, 0, 0, 1, 0, -7)')
        expect(bottle(page, first['from']).locator(':scope > div')).to_have_css('transform', 'matrix(1, 0, 0, 1, 0, 0)')
        assert saved(page) == FIXTURE['game'], 'Illegal pour must not persist a move'
        bottle(page, FIXTURE['illegal']).click()  # Cancel the newly selected source.
        assert pour(page, first, 1) == FIXTURE['afterFirst']
        expect(page.get_by_test_id('magic-sort-moves')).to_have_text('Ходы: 1')
        page.get_by_test_id('magic-sort-undo').click()
        assert wait_history(page, 0) == FIXTURE['game']
        expect(page.get_by_test_id('magic-sort-moves')).to_have_text('Ходы: 0')
        pour(page, first, 1)
        before = saved(page)
        page.reload()
        expect(page.get_by_test_id('magic-sort-board')).to_be_visible()
        assert saved(page) == before, 'Reload must restore the exact account-scoped progress'
        page.get_by_test_id('magic-sort-restart').click()
        expect(page.get_by_test_id('magic-sort-panel-confirm')).to_be_visible()
        assert saved(page) == before, 'Opening reset confirmation must not reset progress'
        expect(page.get_by_text('Новая раскладка')).to_have_count(0)
        page.get_by_role('button', name='Продолжить игру', exact=True).click()
        assert saved(page) == before, 'Cancelling reset must preserve progress'
        page.get_by_test_id('magic-sort-restart').click()
        page.get_by_test_id('magic-sort-panel-confirm').click()
        assert wait_history(page, 0) == FIXTURE['game']

        # Every winning move is made through the actual bottle controls. Neither the
        # final board nor history is injected; the witness comes from this engine.
        witness = FIXTURE['game']['witness']
        for count, move in enumerate(witness, 1):
            pour(page, move, count)
            if count == 20:
                shot(page, 'counter-390.png')
        assert saved(page) == FIXTURE['won']
        best = len(witness)
        expect(page.get_by_test_id('magic-sort-won')).to_be_visible()
        expect(page.get_by_text(f'Отсортировано за {plural(best)}.', exact=True)).to_be_visible()
        expect(page.get_by_test_id('magic-sort-best')).to_have_text(f'Ваш рекорд: {plural(best)}')
        expect(page.get_by_test_id('magic-sort-new-record')).to_have_text('Новый рекорд!')
        expect(page.get_by_test_id('magic-sort-record')).to_have_text(f'Рекорд: {best}')
        page.wait_for_function('([k,v])=>localStorage.getItem(k)===v', arg=[RECORD_KEY, FIXTURE['record']])
        expect(page.get_by_role('button', name='Следующий уровень', exact=True)).to_have_count(0)
        shot(page, 'won-390.png')
        page.reload()
        expect(page.get_by_test_id('magic-sort-won')).to_be_visible(timeout=20000)
        expect(page.get_by_test_id('magic-sort-best')).to_have_text(f'Ваш рекорд: {plural(best)}')
        expect(page.get_by_test_id('magic-sort-new-record')).to_have_count(0)
        page.get_by_role('button', name='Сыграть снова', exact=True).click()
        assert wait_history(page, 0) == FIXTURE['game'], 'Play again restarts the same layout'
        expect(page.get_by_test_id('magic-sort-won')).to_have_count(0)
        expect(page.get_by_test_id('magic-sort-moves')).to_have_text('Ходы: 0')
        expect(page.get_by_test_id('magic-sort-record')).to_have_text(f'Рекорд: {best}')
        shot(page, 'replay-390.png')

        # A second win with more moves keeps the earlier (smaller) record.
        longer = FIXTURE['longer']
        for count, move in enumerate(longer, 1):
            pour(page, move, count)
        expect(page.get_by_test_id('magic-sort-won')).to_be_visible()
        expect(page.get_by_text(f'Отсортировано за {plural(len(longer))}.', exact=True)).to_be_visible()
        expect(page.get_by_test_id('magic-sort-best')).to_have_text(f'Ваш рекорд: {plural(best)}')
        expect(page.get_by_test_id('magic-sort-new-record')).to_have_count(0)
        page.wait_for_timeout(300)
        assert page.evaluate('(k)=>localStorage.getItem(k)', RECORD_KEY) == FIXTURE['record']
        shot(page, 'won-again-390.png')

        # A saved random layout from an earlier build moves to the fixed puzzle.
        migrated = open_game(snapshot=FIXTURE['legacy'])
        expect(migrated.get_by_test_id('magic-sort-board')).to_be_visible(timeout=20000)
        expect(migrated.get_by_test_id('magic-sort-notice')).to_have_text(
            'Теперь у всех одна раскладка. Отсортируйте её за меньшее число ходов.')
        migrated.wait_for_function('(k)=>JSON.parse(localStorage.getItem(k)).seed===%d' % FIXTURE['game']['seed'], arg=KEY)
        assert saved(migrated) == FIXTURE['game']

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
        animated.wait_for_timeout(FIXTURE['POUR_DURATION'] + 150)  # Past the cancelled completion callback.
        assert saved(animated) == FIXTURE['game'], 'Paused animation must never commit later'
        animated.get_by_test_id('magic-sort-resume').click()
        bottle(animated, first['from']).click()
        rapid_tap(target_box)
        expect(animated.get_by_test_id('magic-sort-pour')).to_be_visible()
        rapid_tap(target_box)
        rapid_tap(source_box)
        assert wait_history(animated, 1) == FIXTURE['afterFirst']
        animated.wait_for_timeout(FIXTURE['POUR_DURATION'] + 150)
        assert saved(animated) == FIXTURE['afterFirst'], 'Rapid taps must commit exactly one transfer'

    for size in ([(320, 568)] if FLOW_ONLY else [(390, 844), (320, 568)]):
        for kind in (['collector'] if FLOW_ONLY else ['ordinary', 'collector']):
            before, move, after = (FIXTURE[kind + suffix] for suffix in ['Before', 'Move', 'After'])
            flowing = open_game(size=size, motion='no-preference', snapshot=before)
            expect(flowing.get_by_test_id('magic-sort-board')).to_be_visible(timeout=20000)
            geometry(flowing)
            bottle(flowing, move['from']).click()
            bottle(flowing, move['to']).click()
            early = flow_frame(flowing, before, after, move, .12, .45)
            assert_stream_attached(early)
            assert early['sourceBounds']['top'] >= early['movesBounds']['bottom'] - .5, early
            assert saved(flowing) == before, 'Visual flow must precede the durable commit'
            flowing.screenshot(path=str(OUT / f'flow-{kind}-{size[0]}.png'))
            later = flow_frame(flowing, before, after, move, .55, .92)
            assert later['sourceHeight'] < early['sourceHeight'] - 1, (early, later)
            assert later['targetHeight'] > early['targetHeight'] + 1, (early, later)
            assert_stream_attached(later)
            assert saved(flowing) == before
            # Both levels have arrived while the bottle is returning, before
            # its completion callback may commit the move.
            arrived = flow_frame(flowing, before, after, move, .98, 1.02)
            assert abs(arrived['sourceHeight'] - arrived['fromAfter']) < 1, arrived
            assert abs(arrived['targetHeight'] - arrived['toAfter']) < 1, arrived
            assert saved(flowing) == before
            flowing.screenshot(path=str(OUT / f'arrival-{kind}-{size[0]}.png'))
            flowing.get_by_test_id('magic-sort-pause').click()
            expect(flowing.get_by_test_id('magic-sort-pour')).to_have_count(0)
            flowing.wait_for_timeout(FIXTURE['POUR_DURATION'] + 150)
            assert saved(flowing) == before, 'Pausing after flow must restore the committed baseline'
            flowing.get_by_test_id('magic-sort-resume').click()
            assert pour(flowing, move, len(before['history']) + 1) == after

    assert not errors, errors
    assert all(request['method'] == 'GET' for request in blocked), blocked
    print(json.dumps({'result': 'PASS', 'suite': 'collector-320-only' if FLOW_ONLY else 'full', 'bottles': 24, 'witness_moves': 0 if FLOW_ONLY else len(FIXTURE['game']['witness']),
                      'sizes': ['320x568'] if FLOW_ONLY else ['320x568', '390x844', '430x932'],
                      'normal_motion_pending_cancel_and_single_commit': None if FLOW_ONLY else True,
                      'continuous_source_drain_target_rise_and_mouth_anchors': True,
                      'record': None if FLOW_ONLY else {'best': len(FIXTURE['game']['witness']), 'longer_win': len(FIXTURE['longer'])},
                      'external_requests_blocked': len(blocked), 'screenshots': str(OUT)}))
    for context in contexts:
        context.close()
    browser.close()
