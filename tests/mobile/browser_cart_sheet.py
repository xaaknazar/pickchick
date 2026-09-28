"""Customer payment UI: local catalog fixtures, no simulator or bank requests."""
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from account_fixture import signed_in
ROOT=Path(__file__).resolve().parents[2]
URL=os.environ.get('MOBILE_RECOVERY_URL','http://127.0.0.1:4197').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1','localhost')
OUT=ROOT/'.local/cart-sheet';OUT.mkdir(exist_ok=True,parents=True)
CATALOG=json.loads(subprocess.run(['node','--input-type=module','-e',"import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js'; console.log(JSON.stringify(testCompleteCatalog))"],cwd=ROOT,capture_output=True,text=True,check=True).stdout)
BRANCH=CATALOG['branch_id']
READS={
 '/v1/capabilities':{'schema_version':1,'environment':'staging','data_mode':'synthetic','ordering_enabled':False,'features':{'test_order_flow':True,**{k:False for k in ['phone_auth','payments','fiscal','checkout','loyalty']}}},
 '/v1/branches':{'branches':[{'id':BRANCH,'code':'TEST','name':'ТЦ Abay Plaza','timezone':'Asia/Almaty','ordering_enabled':False}]},
 '/v1/branches/'+BRANCH+'/menu':{'schema_version':1,'branch_id':BRANCH,'release_id':'10000000-0000-4000-8000-000000000008','version':1,'published_at':'2026-09-07T00:00:00Z','items':[]},
 '/v1/test/catalog':CATALOG,
 # Screens with games/promotions read the public branch content, even without checkout.
 '/v1/content/branches/'+BRANCH:{'schema_version':1,'branch_id':BRANCH,'promos':[],'games':[]},
}
PREFERENCES='pickchick.mobile.preferences.v1'
# Legacy QA recovery data must survive the customer UI change unchanged.
LEGACY={key:'preserve-old-fixture' for key in ['pickchick.test.customer.v1','pickchick.test.pending-order.v1']}
errors=[];requests=[];violations=[]
def route(r):
 path=urlparse(r.request.url).path;requests.append((r.request.method,path))
 if r.request.method=='GET' and path in READS:r.fulfill(json=READS[path],headers={'Access-Control-Allow-Origin':'*'})
 else:
  if r.request.method != 'GET':violations.append((r.request.method,path))
  r.abort()
with sync_playwright() as p:
 browser=p.chromium.launch()
 for width,height in [(320,568),(393,852),(768,1024),(852,393)]:
  context=browser.new_context(viewport={'width':width,'height':height},reduced_motion='reduce');signed_in(context);context.route('**/v1/**',route)
  page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto(URL+'/menu')
  page.get_by_test_id('product-pick-combo').click(timeout=20000);page.get_by_test_id('product-add').click()
  expect(page.get_by_test_id('screen-M09')).not_to_be_visible()
  page.get_by_test_id('open-cart').click()
  cart=page.get_by_test_id('screen-M09');expect(cart).to_be_visible()
  sheet=page.get_by_test_id('order-sheet').last
  box=sheet.bounding_box(); assert box['y'] > 10 and box['y'] + box['height'] <= height+1, box
  expect(page.get_by_test_id('cart-checkout')).to_contain_text('4 190')
  page.get_by_test_id('cart-plus-pick-combo').click();expect(page.get_by_test_id('cart-quantity-pick-combo')).to_have_text('2')
  page.get_by_test_id('cart-minus-pick-combo').click();expect(page.get_by_test_id('cart-quantity-pick-combo')).to_have_text('1')
  page.get_by_test_id('cart-edit-pick-combo').click()
  expect(page.get_by_test_id('product-add').last).to_have_accessible_name('Сохранить: 4 190 ₸')
  page.get_by_test_id('photo-replace-drink-0').last.click()
  page.get_by_test_id('photo-option-water').click()
  page.get_by_test_id('photo-replacement-apply').click()
  expect(page.get_by_test_id('photo-replacement-dialog')).not_to_be_visible()
  expect(cart).to_contain_text('Bonaqua')
  page.wait_for_function("() => { const imgs=[...document.querySelectorAll('[data-testid=screen-M09] img')]; return imgs.length && imgs.every(i=>i.complete && i.naturalWidth); }")
  page.screenshot(path=str(OUT/f'cart-{width}.png'))
  page.get_by_test_id('cart-promo-open').click();page.get_by_test_id('cart-promo-input').fill('HELLO')
  page.get_by_test_id('cart-promo-check').click();expect(page.get_by_test_id('cart-promo-result')).to_contain_text('не изменилась')
  expect(page.get_by_test_id('cart-checkout')).to_contain_text('4 190')
  page.get_by_test_id('cart-checkout').click()
  checkout=page.get_by_test_id('screen-M12');expect(checkout).to_be_visible()
  expect(checkout.get_by_text('Как заберёте заказ?',exact=True)).to_be_visible()
  checkout.get_by_role('radio',name='В зале',exact=True).click()
  expect(checkout.get_by_role('radio',name='В зале',exact=True)).to_have_attribute('aria-checked','true')
  expect(checkout.get_by_test_id('checkout-apple-pay')).to_contain_text('Подключается')
  checkout.get_by_test_id('checkout-add-card').click();expect(checkout.get_by_test_id('checkout-card-info')).to_be_visible()
  expect(checkout).not_to_contain_text('Доставка')
  checkout.get_by_test_id('scroll-M12').evaluate('(e)=>e.scrollTop=0')
  page.screenshot(path=str(OUT/f'checkout-{width}.png'))
  footer=checkout.get_by_test_id('bottom-actions');before=footer.bounding_box()
  checkout.get_by_test_id('scroll-M12').evaluate('(e)=>e.scrollTop=e.scrollHeight')
  assert abs(footer.bounding_box()['y']-before['y'])<1
  assert before['y']+before['height'] <= height+1
  checkout.get_by_test_id('checkout-close').click();expect(checkout).not_to_be_visible()
  expect(cart).to_be_visible();page.get_by_test_id('cart-close').click();expect(cart).not_to_be_visible()
  page.goto(URL+'/menu');page.get_by_test_id('open-cart').click();expect(cart).to_be_visible()
  expect(page.get_by_test_id('cart-quantity-pick-combo')).to_have_text('1')
  page.get_by_test_id('cart-minus-pick-combo').click();expect(page.get_by_text('Здесь пока тихо',exact=True)).to_be_visible()
  expect(page.get_by_test_id('cart-checkout')).to_have_count(0)
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  context.close()
 # Non-reduced opening and handle dismissal; never intercept the content scroll.
 context=browser.new_context(viewport={'width':393,'height':852},reduced_motion='no-preference');signed_in(context);context.route('**/v1/**',route)
 page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto(URL+'/menu')
 page.get_by_test_id('product-pick-combo').click(timeout=20000);page.get_by_test_id('product-add').click()
 expect(page.get_by_test_id('screen-M09')).not_to_be_visible()
 page.get_by_test_id('open-cart').click()
 page.get_by_test_id('cart-close').click();page.goto(URL+'/menu')
 # Start the measurement on the actual click. On a cold CI export, auto-wait
 # for hydration/splash can exceed the old timer before the sheet even opens.
 page.get_by_test_id('open-cart').wait_for(state='visible')
 page.evaluate("""() => {
   window.sheetFrames=[];
   const start = event => {
     if (!event.target.closest('[data-testid="open-cart"]')) return;
     document.removeEventListener('click', start, true);
     const until=performance.now()+1500;
     function tick(){
       const el=document.querySelector('[data-testid="order-sheet"]');
       if(el)window.sheetFrames.push(el.getBoundingClientRect().y);
       if(performance.now()<until)requestAnimationFrame(tick);
     }
     requestAnimationFrame(tick);
   };
   document.addEventListener('click', start, true);
 }""")
 page.get_by_test_id('open-cart').click();page.wait_for_timeout(500)
 frames=page.evaluate('sheetFrames');assert len(frames)>4 and max(frames)-min(frames)>80,frames
 handle=page.get_by_test_id('sheet-handle').bounding_box();x=handle['x']+handle['width']/2;y=handle['y']+handle['height']/2
 page.mouse.move(x,y);page.mouse.down();page.mouse.move(x,y+140,steps=12);page.mouse.up()
 expect(page.get_by_test_id('order-sheet')).not_to_be_visible()
 page.get_by_test_id('open-cart').click();page.wait_for_timeout(400)
 page.keyboard.press('Escape');expect(page.get_by_test_id('order-sheet')).not_to_be_visible()
 context.close()
 browser.close()
assert not errors,errors
assert not violations,violations
print('PASS: four viewports, sheet bounds, editing, quantity, promo, checkout, return and empty state')
