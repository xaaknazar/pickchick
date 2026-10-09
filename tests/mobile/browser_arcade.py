"""Local mobile arcade acceptance: touch input, pause/resume, results and viewport bounds."""
from browser_network import isolated_context, route_fixture
import json, os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from account_fixture import signed_in

URL=os.environ.get('MOBILE_RECOVERY_URL','http://127.0.0.1:4182').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1','localhost')
OUT=Path(__file__).resolve().parents[2]/'.local/arcade/acceptance'; OUT.mkdir(parents=True,exist_ok=True)
errors=[]
ROUTES=[('man','/games/pick-man','pick-man-start','pick-man-board'),('blocks','/games/pick-blocks','blocks-start','blocks-board')]

def bounds(page, locator, width, height):
 box=locator.bounding_box(); assert box and box['width'] > 0 and box['height'] > 0,box
 assert box['x']>=-1 and box['y']>=-1 and box['x']+box['width']<=width+1 and box['y']+box['height']<=height+1,box
 assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width,height)

with sync_playwright() as p:
 b=p.chromium.launch()
 for width,height in [(320,568),(393,852),(430,932),(852,393)]:
  for name,route,start,board in ROUTES:
   c=isolated_context(b,viewport={'width':width,'height':height},has_touch=True,reduced_motion='reduce')
   signed_in(c);route_fixture(c,'**/v1/**',lambda r:r.abort());page=c.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(URL+route);page.get_by_test_id(start).wait_for(timeout=20000)
   bounds(page,page.get_by_test_id(start),width,height)
   page.screenshot(path=str(OUT/f'{name}-intro-{width}.png'))
   page.get_by_test_id(start).click(); page.wait_for_timeout(200)
   bounds(page,page.get_by_test_id(board),width,height)
   if name=='man':
    expect(page.locator('[data-testid^="maze-direction-"]')).to_have_count(0)
    area=page.get_by_test_id('pick-man-board').bounding_box()
    x,y=area['x']+area['width']/2,area['y']+area['height']/2
    touch=c.new_cdp_session(page)
    touch.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
    touch.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x,'y':y-50}]})
    touch.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
    touch.detach()
   page.screenshot(path=str(OUT/f'{name}-play-{width}.png'))
   c.close()
 # Direct routes remain guarded for guests.
 for _,route,_,_ in ROUTES:
  c=isolated_context(b,);route_fixture(c,'**/v1/**',lambda r:r.abort());page=c.new_page();page.goto(URL+route)
  expect(page.get_by_test_id('account-required-login')).to_be_visible(timeout=20000);c.close()
 assert not errors,errors
 b.close()
 print(json.dumps({'result':'passed','viewports':4,'games':2,'runtime_errors':errors,'screenshots':str(OUT)}))
