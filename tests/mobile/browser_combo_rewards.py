"""Commercial combo UI with isolated fixtures. No real invoices, payments or catalogue writes."""
from browser_network import isolated_context, route_fixture
import json, os, subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[2]
URL=os.environ.get('CUSTOMER_AUTH_URL','http://127.0.0.1:4199').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1','localhost')
OUT=ROOT/'.local/combo-rewards-ui'; OUT.mkdir(parents=True,exist_ok=True)
CAT=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js'; console.log(JSON.stringify(testCompleteCatalog))"],cwd=ROOT,text=True))
BRANCH=CAT['branch_id']; CUSTOMER='40000000-0000-4000-8000-000000000001'
future=(datetime.now(timezone.utc)+timedelta(hours=2)).isoformat().replace('+00:00','Z')
customer={'id':CUSTOMER,'phone':'+77000000000','nickname':'UI test','birth_date':None,'gender':None,'profile_completed_at':None,'created_at':'2026-09-07T10:00:00.000Z'}
envelope={'version':1,'device_id':'40000000-0000-4000-8000-000000000004','tokens':{'access_token':'a'*64,'refresh_token':'b'*64,'access_expires_at':future,'session_id':'40000000-0000-4000-8000-000000000002','customer':customer},'challenge':None,'otp_request':None,'verify_intent':None,'refresh_request_id':None,'closing':None}
errors=[]
with sync_playwright() as p:
 browser=p.chromium.launch()
 for width,height in [(393,852),(320,568)]:
  context=isolated_context(browser,viewport={'width':width,'height':height},reduced_motion='reduce')
  context.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",'+json.dumps(json.dumps(envelope))+');')
  state={'earned':7,'writes':[]}
  def route(r):
   path=urlparse(r.request.url).path; method=r.request.method; data=None
   if method not in ('GET','OPTIONS'):

    if path.startswith('/v1/customer-checkout/'):state['writes'].append(path)
    r.abort();return
   if path=='/v1/customers/me':data={'customer':customer}
   elif path=='/v1/auth/config':data={'enabled':True,'delivery_consent_required':True,'consent_version':'fixture-v1','terms_url':'https://example.test/terms','privacy_url':'https://example.test/privacy'}
   elif path=='/v1/capabilities':data={'schema_version':1,'environment':'staging','data_mode':'pilot','ordering_enabled':False,'features':{'phone_auth':True,'test_order_flow':True,**{k:False for k in ['payments','fiscal','checkout','loyalty']}}}
   elif path=='/v1/branches':data={'branches':[{'id':BRANCH,'code':'TEST','name':'ТЦ Abay Plaza','timezone':'Asia/Almaty','ordering_enabled':False}]}
   elif path=='/v1/branches/'+BRANCH+'/menu':data={'schema_version':1,'branch_id':BRANCH,'release_id':'10000000-0000-4000-8000-000000000008','version':1,'published_at':'2026-09-07T00:00:00Z','items':[]}
   elif path=='/v1/test/catalog':data=CAT
   elif path=='/v1/content/branches/'+BRANCH:data={'schema_version':1,'branch_id':BRANCH,'promos':[],'games':[]}
   elif path=='/v1/customer-checkout/config':data={'enabled':True,'branchId':BRANCH,'restaurant':'ТЦ Abay Plaza','fiscalPolicy':'deferred_pilot','orderCommentEnabled':True}
   elif path=='/v1/customer-checkout/availability':data={'enabled':True,'fresh':True,'signature':'a'*64,'products':[{'id':v['id'],'available':True,'stoppedOptions':[]} for v in CAT['products']]}
   elif path=='/v1/customer-checkout/orders':data={'orders':[]}
   elif path=='/v1/customer-checkout/feedback':data={'feedback':[]}
   elif path=='/v1/customer-checkout/combo-rewards':
    n=state['earned'];data={'enabled':True,'programId':'40000000-0000-4000-8000-000000000010','giftProductId':'pick-combo','earnedUnits':n,'completedCycles':n//7,'currentStamps':n%7,'availableGifts':n//7,'usedGifts':0,'reservedGifts':0,'reconciliationRequired':False,'visibleStamps':7 if n==7 else n%7,'remainingToNextGift':7-n%7}
   else:r.abort();return
   r.fulfill(json=data,headers={'Access-Control-Allow-Origin':'*'})
  route_fixture(context,'**/v1/**',route)
  page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  for n in [0,1,2,7]:
   state['earned']=n;page.goto(URL+'/profile')
   expect(page.get_by_test_id('profile-combo-reward-details')).to_have_attribute('aria-label',f'Комбо-бонус. Купи 7 комбо, 8-е в подарок. Куплено комбо: {n}. Условия акции',timeout=25000)
  page.get_by_test_id('profile-combo-reward').scroll_into_view_if_needed()
  page.screenshot(path=str(OUT/f'profile-{width}.png'))
  page.goto(URL+'/cart')
  toggle=page.get_by_test_id('cart-use-combo-gift')
  expect(toggle).to_have_attribute('aria-checked','false',timeout=25000)
  toggle.click();expect(toggle).to_have_attribute('aria-checked','true')
  expect(page.get_by_test_id('cart-checkout')).to_be_enabled()
  page.screenshot(path=str(OUT/f'cart-{width}.png'))
  toggle.click();expect(toggle).to_have_attribute('aria-checked','false')
  toggle.click();page.get_by_test_id('cart-checkout').click()
  expect(page.get_by_test_id('kaspi-checkout-submit')).to_contain_text('Заказать подарок')
  expect(page.get_by_test_id('kaspi-checkout-total')).to_contain_text('0')
  page.screenshot(path=str(OUT/f'gift-checkout-{width}.png'))
  assert not state['writes'],state['writes']
  # A trusted refund reduces the server balance. No local stamp or gift survives a reload.
  state['earned']=6;page.goto(URL+'/profile')
  expect(page.get_by_test_id('profile-combo-reward-progress')).to_contain_text('Ещё 1 комбо до подарка')
  page.goto(URL+'/cart');expect(page.get_by_test_id('cart-use-combo-gift')).to_have_count(0)
  context.close()
 browser.close()
assert not errors,errors
print('PASS combo profile, selectable gift, zero-total summary and refund refresh: 393x852, 320x568; no payment requests')
