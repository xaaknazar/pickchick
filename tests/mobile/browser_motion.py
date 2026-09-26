"""Local UI motion/layout review. Uses synthetic GET fixtures, never a live backend."""
import json, os, subprocess
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from account_fixture import signed_in

URL=os.environ.get('MOBILE_RECOVERY_URL','http://127.0.0.1:4186').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1','localhost')
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'.local/mobile-motion/screens';OUT.mkdir(parents=True,exist_ok=True)
CAT=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js';console.log(JSON.stringify(testCompleteCatalog))"],cwd=ROOT,text=True))
BRANCH=CAT['branch_id'];errors=[];results=[]
def fixture(route):
 path=urlparse(route.request.url).path
 data={
  '/v1/capabilities':{'schema_version':1,'environment':'staging','data_mode':'synthetic','ordering_enabled':False,'features':{'test_order_flow':True,**{k:False for k in ['phone_auth','payments','fiscal','checkout','loyalty']}}},
  '/v1/branches':{'branches':[{'id':BRANCH,'code':'TEST','name':'Локальная проверка','timezone':'Asia/Almaty','ordering_enabled':False}]},
  '/v1/branches/'+BRANCH+'/menu':{'schema_version':1,'branch_id':BRANCH,'release_id':'10000000-0000-4000-8000-000000000008','version':1,'published_at':'2026-09-07T00:00:00Z','items':[]},
  '/v1/test/catalog':CAT,
 }
 if route.request.method=='GET' and path in data:route.fulfill(json=data[path],headers={'Access-Control-Allow-Origin':'*'})
 else:route.abort()

def bounded(page):
 assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),page.url
 for el in page.get_by_test_id('bottom-actions').all():
  if not el.is_visible():continue
  box=el.bounding_box();assert box['y']>=0 and box['y']+box['height']<=page.viewport_size['height']+1,box

with sync_playwright() as p:
 b=p.chromium.launch()
 for width,height in [(320,568),(393,852),(768,1024)]:
  c=b.new_context(viewport={'width':width,'height':height},has_touch=True,reduced_motion='no-preference');signed_in(c);c.route('**/v1/**',fixture)
  page=c.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  for n in range(1,36):
   if n in (27,28): continue  # PICK RUN is temporarily removed by the owner.
   screen=f'M{n:02}'
   page.goto(URL+f'/screen/{screen}?preview=1');page.get_by_test_id('open-design-review').wait_for(timeout=20000)
   page.wait_for_timeout(240);bounded(page)
   if screen=='M18':
    number=page.get_by_test_id('ready-order-number')
    expect(number).to_have_text('083')
    assert number.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1'), 'Ready order number is clipped'
   page.screenshot(path=str(OUT/f'{screen}-{width}.png'))
  page.goto(URL+'/menu');expect(page.get_by_test_id('product-pick-combo')).to_be_visible(timeout=20000)
  # Header transitions must not change its geometry on crossing the old threshold.
  header=page.get_by_test_id('storefront-header'); heights=[]
  for y in [0,40,80,100,120,180]:
   page.get_by_test_id('scroll-M06').evaluate('(e,y)=>e.scrollTop=y',y);page.wait_for_timeout(50);heights.append(header.bounding_box()['height'])
  assert max(heights)-min(heights)<1,heights
  page.get_by_test_id('product-pick-combo').click();expect(page.get_by_test_id('product-content')).to_be_visible();page.wait_for_timeout(350)
  media=page.get_by_test_id('product-media');content=page.get_by_test_id('product-content')
  assert abs(media.bounding_box()['y']+media.bounding_box()['height']-content.bounding_box()['y'])<2
  gradients=media.locator('div').evaluate_all("els=>els.map(e=>getComputedStyle(e).backgroundImage).filter(v=>v.includes('linear-gradient'))")
  assert any('rgb(4, 20, 58) 100%' in g for g in gradients),gradients
  assert page.get_by_test_id('product-close').bounding_box()['width']>=44
  bounded(page);page.screenshot(path=str(OUT/f'pick-combo-{width}.png'))
  # A press animates smoothly and releasing outside must not navigate.
  button=page.get_by_test_id('product-add');box=button.bounding_box();page.mouse.move(box['x']+20,box['y']+20);page.mouse.down();page.wait_for_timeout(110)
  assert float(button.evaluate('(e)=>getComputedStyle(e).opacity'))<.95
  page.mouse.move(0,0);page.mouse.up();page.wait_for_timeout(200)
  expect(page.get_by_test_id('product-add')).to_be_visible();assert float(button.evaluate('(e)=>getComputedStyle(e).opacity'))>.99
  # Changing the system preference live restores the poster and disables movement.
  page.emulate_media(reduced_motion='reduce');page.wait_for_timeout(250);assert page.locator('video').count()==0
  button.click();page.get_by_test_id('open-cart').click();expect(page.get_by_test_id('screen-M09')).to_be_visible();bounded(page)
  page.screenshot(path=str(OUT/f'cart-{width}.png'));results.append({'size':f'{width}x{height}','screens':33,'combo_blend':True,'header_stable':True,'press_cancel':True,'live_reduced_motion':True})
  c.close()
 b.close()
assert not errors,errors
(OUT.parent/'result.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
print(json.dumps({'result':'PASS','checks':results,'runtime_errors':errors}))
