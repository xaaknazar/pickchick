"""Sample actual rendered tiles during wall/floor kicks and touch trajectory changes."""
from browser_network import isolated_context, route_fixture
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright
from account_fixture import signed_in

ROOT = Path(__file__).resolve().parents[2]
URL = os.environ.get('MOBILE_RECOVERY_URL', 'http://127.0.0.1:4197').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1', 'localhost')
KEY = 'pickchick.pick-blocks.v1'


def fixture(scenario):
    source = """
    import { createGame, parseGame } from './apps/mobile/src/games/pick-blocks/engine.ts';
    const game = createGame(29), scenario = process.argv[1];
    game.active = {
      left: {kind:'I',rotation:1,x:-2,y:5},
      right: {kind:'I',rotation:3,x:8,y:5},
      floor: {kind:'I',rotation:0,x:3,y:18},
      stack: {kind:'I',rotation:1,x:2,y:5},
      drag: {kind:'T',rotation:0,x:3,y:0},
    }[scenario];
    if(scenario==='stack') game.board[7][3]='J';
    if (!parseGame(game)) throw Error('Invalid trajectory fixture');
    console.log(JSON.stringify({version:1,best:75,game}));
    """
    return json.loads(subprocess.check_output(
        ['node', '--input-type=module', '-e', source, scenario], cwd=ROOT, text=True,
        stderr=subprocess.DEVNULL))


def open_game(browser, size, scenario, reduced='no-preference'):
    context = isolated_context(browser,viewport={'width':size[0], 'height':size[1]},
                                  has_touch=True, reduced_motion=reduced)
    signed_in(context)
    # Hold gravity while the resume overlay exits, so a floor fixture cannot
    # lock before the test touches it. RAF/native animation stays live throughout.
    context.add_init_script('''
      window.__blocksClockRunning=false;
      const interval=window.setInterval.bind(window);
      window.setInterval=(fn,delay,...args)=>interval(()=>{
        if(delay!==50 || window.__blocksClockRunning)fn(...args);
      },delay);
    ''')
    route_fixture(context,'**/v1/**', lambda route: route.abort())
    data = fixture(scenario)
    context.add_init_script(f'localStorage.setItem({json.dumps(KEY)}, {json.dumps(json.dumps(data))});')
    page = context.new_page()
    page.goto(URL+'/games/pick-blocks')
    page.get_by_test_id('blocks-resume').click()
    expect(page.get_by_test_id('blocks-board')).to_be_visible()
    page.get_by_test_id('blocks-board').click(trial=True)
    page.evaluate('window.__blocksClockRunning=true')
    return context, page, data


def touch_path(page, points, delay=0):
    box = page.get_by_test_id('blocks-board').bounding_box()
    cell = (box['width']-2)/10
    x, y = box['x']+box['width']/2, box['y']+box['height']/2
    session = page.context.new_cdp_session(page)
    session.send('Input.dispatchTouchEvent', {'type':'touchStart', 'touchPoints':[{'x':x,'y':y}]})
    for dx, dy in points:
        session.send('Input.dispatchTouchEvent', {'type':'touchMove',
                     'touchPoints':[{'x':x+dx*cell,'y':y+dy*cell}]})
        if delay: page.wait_for_timeout(delay)
    session.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]})
    session.detach()


results=[]
with sync_playwright() as p:
    browser=p.chromium.launch()
    for size in [(320,568),(393,852),(430,932),(852,393)]:
        for scenario in ['left','right','floor','stack']:
            context,page,data=open_game(browser,size,scenario)
            page.evaluate('''()=>{
              window.poses=[];window.capture=true;
              function frame(){
                const b=document.querySelector('[data-testid="blocks-board"]').getBoundingClientRect();
                const actor=document.querySelector('[data-testid="blocks-falling-piece"]');
                if(actor)window.poses.push([...actor.children].map(c=>{
                  const r=c.getBoundingClientRect(),cell=(b.width-2)/10;
                  return {x:(r.x-b.x-1)/cell,y:(r.y-b.y-1)/cell,
                    right:(r.right-b.x-1)/cell,bottom:(r.bottom-b.y-1)/cell};
                }));
                if(window.capture)requestAnimationFrame(frame);
              }requestAnimationFrame(frame);
            }''')
            touch_path(page,[])
            page.wait_for_timeout(180)
            page.evaluate('window.capture=false;window.__blocksClockRunning=false')
            poses=page.evaluate('window.poses')
            assert len(poses)>3, (size,scenario,len(poses))
            for row in poses:
                for tile in row:
                    assert tile['x']>=-.01 and tile['right']<=10.01, (size,scenario,tile)
                    assert tile['bottom']<=20.01, (size,scenario,tile)
                    for y,cells in enumerate(data['game']['board']):
                        for x,kind in enumerate(cells):
                            if kind:
                                overlap=(min(tile['right'],x+1)-max(tile['x'],x)>.01 and
                                         min(tile['bottom'],y+1)-max(tile['y'],y)>.01)
                                assert not overlap,(size,scenario,tile,(x,y))
            if scenario=='left' and size==(393,852):
                page.screenshot(path=str(ROOT/'.local/blocks-trajectory.png'))
            page.get_by_test_id('blocks-pause').click()
            saved=page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))',KEY)
            assert saved['game']['piecesPlaced']==0, (size,scenario,saved)
            assert saved['game']['active']['rotation'] != data['game']['active']['rotation'],scenario
            results.append({'size':size,'scenario':scenario,'frames':len(poses),'bounded':True})
            context.close()
    for reduced in ['reduce','no-preference']:
        for axis in ['horizontal','vertical']:
            context,page,data=open_game(browser,(393,852),'drag',reduced)
            points=[(1.1,0),(1.1,3.5)] if axis=='horizontal' else [(0,1.1),(2.5,3.1)]
            touch_path(page,points,140)
            page.get_by_test_id('blocks-pause').click()
            page.wait_for_function('(key)=>JSON.parse(localStorage.getItem(key)).game.active.y>0',arg=KEY) if axis=='vertical' else None
            saved=page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))',KEY)['game']
            assert saved['piecesPlaced']==0, (axis,saved)
            if axis=='horizontal':
                assert saved['active']['x']==4 and saved['score']==0,saved
            else:
                assert saved['active']['x']==3 and saved['score']>=3,saved
            results.append({'axis':axis,'reduced_motion':reduced,'trajectory_stable':True})
            context.close()
    browser.close()
(ROOT/'.local/blocks-trajectory.json').write_text(json.dumps(results,indent=2))
print(json.dumps(results))
