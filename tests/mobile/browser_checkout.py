"""Customer payment UI: local catalog fixtures, no simulator or bank requests."""
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from account_fixture import signed_in
ROOT=Path(__file__).resolve().parents[2]
URL=os.environ.get('MOBILE_RECOVERY_URL','http://127.0.0.1:4182').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1','localhost')
OUT=ROOT/'.local/checkout';OUT.mkdir(exist_ok=True,parents=True)
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
 else:violations.append((r.request.method,path));r.abort()
with sync_playwright() as p:
 browser=p.chromium.launch()
 for width,height in [(320,568),(393,852),(430,932)]:
  context=browser.new_context(viewport={'width':width,'height':height},reduced_motion='reduce');signed_in(context);context.route('**/v1/**',route)
  context.add_init_script('Object.entries('+json.dumps(LEGACY)+').forEach(([key,value])=>localStorage.setItem(key,value))')
  page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto(URL+'/menu')
  page.get_by_test_id('product-pick-combo').click(timeout=20000);page.get_by_test_id('product-add').click()
  page.get_by_test_id('cart-checkout').click()
  checkout=page.get_by_test_id('screen-M12');expect(checkout).to_be_visible()
  pay=page.get_by_test_id('checkout-pay-disabled');expect(pay).to_be_disabled()
  expect(pay).to_have_text('Оформление скоро появится')
  expect(checkout.get_by_test_id('bottom-actions')).to_contain_text('4 190')
  expect(page.get_by_test_id('test-checkout-create')).to_have_count(0)
  expect(checkout).not_to_contain_text('тест')
  expect(checkout).not_to_contain_text('Доставка')
  before=pay.bounding_box();assert before['height']>=48 and before['y']+before['height']<=height+1,before
  page.get_by_test_id('scroll-M12').evaluate('(e)=>e.scrollTop=e.scrollHeight')
  assert abs(pay.bounding_box()['y']-before['y'])<1
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  checkout.get_by_test_id('checkout-add-card').click()
  expect(checkout.get_by_test_id('checkout-card-info')).to_contain_text('после подключения банка')
  expect(checkout.locator('input')).to_have_count(0)
  page.get_by_test_id('scroll-M12').evaluate('(e)=>e.scrollTop=0')
  page.screenshot(path=str(OUT/f'payment-{width}.png'))
  checkout.get_by_test_id('checkout-close').click();expect(checkout).not_to_be_visible()
  expect(page.get_by_test_id('screen-M09')).to_be_visible()
  for screen in ['M13','M14','M15','M16','M17','M18','M19','M20','M21','M22']:
   page.goto(URL+'/screen/'+screen);expect(page.get_by_test_id('screen-'+screen)).to_be_visible()
   expect(page.get_by_test_id('test-payment-approve')).to_have_count(0)
   expect(page.get_by_test_id('test-payment-unknown')).to_have_count(0)
   expect(page.get_by_test_id('connected-order-number')).to_have_count(0)
  assert all(page.evaluate('(key)=>localStorage.getItem(key)',key)==value for key,value in LEGACY.items())
  assert page.evaluate('(key)=>JSON.parse(localStorage.getItem(key)).lines.length',PREFERENCES)==1
  context.close()
 context=browser.new_context(viewport={'width':393,'height':852});signed_in(context);context.route('**/v1/**',route)
 page=context.new_page();page.goto(URL+'/screen/M12');expect(page.get_by_text('В корзине пока пусто',exact=True)).to_be_visible(timeout=20000)
 expect(page.get_by_test_id('checkout-pay-disabled')).to_have_count(0)
 context.close();browser.close()
assert not violations,violations
assert not errors,errors
print(json.dumps({'success':True,'sizes':[320,393,430],'fixed_footer':True,'legacy_storage_preserved':True,'simulator_requests':0,'writes':0,'reads':len(requests)}))
