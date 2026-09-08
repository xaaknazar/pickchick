"""Local Pick Man gameplay, persistence, auth and Events composition checks."""
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright
from account_fixture import signed_in

ROOT=Path(__file__).resolve().parents[2]
URL=os.environ.get('MOBILE_RECOVERY_URL','http://127.0.0.1:4182').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1','localhost')
KEY='pickchick.pick-man.v1'
OUTPUT=ROOT/'.local/pick-man/browser';OUTPUT.mkdir(parents=True,exist_ok=True)
errors=[]

def fixture(status):
    source="""import {createMaze} from './apps/mobile/src/games/pick-man/engine.ts';
      const g=createMaze(29);g.status=process.argv[1];if(g.status==='won')g.remaining=[];if(g.status==='over')g.lives=0;
      console.log(JSON.stringify({version:1,game:g,best:300}));"""
    return json.loads(subprocess.run(['node','--input-type=module','-e',source,status],cwd=ROOT,text=True,capture_output=True,check=True).stdout)

def saved(page):return page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))',KEY)

def open_page(browser,path='/games/pick-man',snapshot=None,guest=False,size=(393,852)):
    c=browser.new_context(viewport={'width':size[0],'height':size[1]})
    c.route('**/v1/**',lambda r:r.abort())
    if not guest:signed_in(c)
    if snapshot:c.add_init_script("if(!sessionStorage.getItem('maze-seeded')){localStorage.setItem(%s,%s);sessionStorage.setItem('maze-seeded','1')}"%(json.dumps(KEY),json.dumps(json.dumps(snapshot))))
    page=c.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto(URL+path)
    return page

with sync_playwright() as p:
    b=p.chromium.launch()
    page=open_page(b,'/events',guest=True)
    expect(page.get_by_test_id('events-games')).to_be_visible(timeout=20000)
    def y(test):return page.get_by_test_id(test).bounding_box()['y']
    assert y('events-streak')<y('events-games')<y('pick-blocks-open')<y('pick-man-open')<y('pickrun-open')
    assert page.get_by_text('Полёт на паутине над городом').count()==0
    page.screenshot(path=str(OUTPUT/'events-top.png'))
    page.get_by_test_id('pick-man-open').scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUTPUT/'events-games.png'))
    page.get_by_test_id('pick-man-open').click()
    expect(page.get_by_test_id('account-required-login')).to_be_visible()
    assert page.get_by_test_id('pick-man-start').count()==0
    page.context.close()

    page=open_page(b)
    expect(page.get_by_test_id('pick-man-start')).to_be_visible(timeout=20000)
    page.screenshot(path=str(OUTPUT/'intro.png'))
    page.get_by_test_id('pick-man-start').click()
    expect(page.get_by_test_id('pick-man-board')).to_be_visible()
    page.wait_for_function('(key)=>JSON.parse(localStorage.getItem(key))?.game.ticks>=5',arg=KEY)
    page.get_by_test_id('pick-man-up').click()
    page.get_by_test_id('pick-man-pause').click()
    expect(page.get_by_test_id('pick-man-resume')).to_be_visible()
    page.wait_for_timeout(200)
    before=saved(page);page.wait_for_timeout(700);assert saved(page)==before
    expect(page.get_by_test_id('pick-man-left')).to_be_disabled()
    page.screenshot(path=str(OUTPUT/'paused.png'))
    page.get_by_test_id('pick-man-rules').click()
    expect(page.get_by_test_id('pick-man-help-close')).to_be_visible()
    page.get_by_test_id('pick-man-help-close').click()
    expect(page.get_by_test_id('pick-man-resume')).to_be_visible()
    page.reload();expect(page.get_by_test_id('pick-man-resume')).to_be_visible(timeout=20000)
    assert saved(page)['game']['score']==before['game']['score']
    for width,height in [(393,852),(320,568),(852,393)]:
        page.set_viewport_size({'width':width,'height':height});page.wait_for_timeout(300)
        board=page.get_by_test_id('pick-man-board').bounding_box()
        assert board['x']>=0 and board['x']+board['width']<=width+1,board
        assert board['y']>=0 and board['y']+board['height']<=height+1,board
        for direction in ['up','down','left','right']:
            box=page.get_by_test_id('pick-man-'+direction).bounding_box();assert box['width']>=48 and box['height']>=48
        page.get_by_test_id('pick-man-resume').click()
        page.screenshot(path=str(OUTPUT/f'game-{width}.png'))
        page.get_by_test_id('pick-man-pause').click()
    page.get_by_test_id('pick-man-restart').click()
    page.get_by_test_id('pick-man-restart-confirm').click()
    expect(page.get_by_test_id('pick-man-lives')).to_have_text('♥♥♥')
    page.get_by_test_id('pick-man-pause').click()
    page.context.close()

    for status,button in [('won','pick-man-next'),('over','pick-man-again')]:
        page=open_page(b,snapshot=fixture(status))
        expect(page.get_by_test_id(button)).to_be_visible(timeout=20000)
        page.get_by_test_id(button).click();expect(page.get_by_test_id('pick-man-pause')).to_be_visible()
        if status=='won':expect(page.get_by_text('УРОВЕНЬ 2',exact=True)).to_be_visible()
        else:expect(page.get_by_test_id('pick-man-lives')).to_have_text('♥♥♥')
        page.context.close()
    assert not errors,errors
    b.close()
print('PASS: Events order and artwork, guest gate, movement, controls, pause/help/reload, three sizes, restart, victory and defeat; local-only.')
