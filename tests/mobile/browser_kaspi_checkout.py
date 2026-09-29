"""Real checkout UI against isolated bank-free HTTP fixtures; no external requests escape."""
import json, os, subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[2]
URL=os.environ.get('CUSTOMER_AUTH_URL','http://127.0.0.1:4196').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1','localhost')
OUT=ROOT/'.local/kaspi-checkout-ui';OUT.mkdir(parents=True,exist_ok=True)
CATALOG=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js'; console.log(JSON.stringify(testCompleteCatalog))"],cwd=ROOT,text=True))
BRANCH=CATALOG['branch_id']; CUSTOMER='40000000-0000-4000-8000-000000000001'; ORDER='40000000-0000-4000-8000-000000000003'
future=(datetime.now(timezone.utc)+timedelta(hours=2)).isoformat().replace('+00:00','Z')
customer={'id':CUSTOMER,'phone':'+77000000000','nickname':'UI test','birth_date':None,'gender':None,'profile_completed_at':None,'created_at':'2026-09-07T10:00:00.000Z'}
envelope={'version':1,'device_id':'40000000-0000-4000-8000-000000000004','tokens':{'access_token':'a'*64,'refresh_token':'b'*64,'access_expires_at':future,'session_id':'40000000-0000-4000-8000-000000000002','customer':customer},'challenge':None,'otp_request':None,'verify_intent':None,'refresh_request_id':None,'closing':None}
errors=[]
with sync_playwright() as p:
 browser=p.chromium.launch()
 for width,height in [(320,568),(393,852),(768,1024)]:
  context=browser.new_context(viewport={'width':width,'height':height},reduced_motion='reduce')
  context.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",'+json.dumps(json.dumps(envelope))+');')
  state={'phase':'awaiting_restaurant','created':False,'paid':False,'drop':True,'keys':[],'payments':0,'revision':1,'held_routes':[],'teardown':False}
  def order():
   return {'orderId':ORDER,'revision':hex(state['revision'])[2:].zfill(64),'restaurant':'ТЦ Abay Plaza','displayNumber':'2' if state['paid'] else None,'totalMinor':'419000','serviceMode':'takeaway','phase':state['phase'],'expiresAt':future if state['phase']=='awaiting_payment' else None,'receipt':'deferred','receiptUrl':None,'items':[{'productId':'pick-combo','title':'Pick Combo','quantity':1,'modifiers':['Coca-Cola 0,5 л','Фирменный соус']} ]}
  def route(r):
   if state['teardown']:r.abort();return
   path=urlparse(r.request.url).path; method=r.request.method
   body=r.request.post_data_json if r.request.post_data else None
   data=None
   if path=='/v1/customers/me':data={'customer':customer}
   elif path=='/v1/auth/config':data={'enabled':True,'delivery_consent_required':True,'consent_version':'fixture-v1','terms_url':'https://example.test/terms','privacy_url':'https://example.test/privacy'}
   elif path=='/v1/capabilities':data={'schema_version':1,'environment':'staging','data_mode':'pilot','ordering_enabled':False,'features':{'phone_auth':True,'test_order_flow':True,**{k:False for k in ['payments','fiscal','checkout','loyalty']}}}
   elif path=='/v1/branches':data={'branches':[{'id':BRANCH,'code':'TEST','name':'ТЦ Abay Plaza','timezone':'Asia/Almaty','ordering_enabled':False}]}
   elif path=='/v1/branches/'+BRANCH+'/menu':data={'schema_version':1,'branch_id':BRANCH,'release_id':'10000000-0000-4000-8000-000000000008','version':1,'published_at':'2026-09-07T00:00:00Z','items':[]}
   elif path=='/v1/test/catalog':data=CATALOG
   elif path=='/v1/content/branches/'+BRANCH:data={'schema_version':1,'branch_id':BRANCH,'promos':[],'games':[]}
   elif path=='/v1/customer-checkout/config':data={'enabled':True,'branchId':BRANCH,'restaurant':'ТЦ Abay Plaza','fiscalPolicy':'deferred_pilot'}
   elif path=='/v1/customer-checkout/quotes':
    assert 'totalMinor' not in body
    data={'quoteId':'40000000-0000-4000-8000-000000000005','totalMinor':'419000','expiresAt':future,'serviceMode':body['serviceMode']}
   elif path=='/v1/customer-checkout/orders':
    if method=='GET':data={'orders':[order()] if state['created'] else []}
    else:
     state['keys'].append(body['key']);state['created']=True
     if state['drop']:state['drop']=False;r.abort();return
     data=order()
   elif path==f'/v1/customer-checkout/orders/{ORDER}/payment':
    state['payments']+=1;state['phase']='awaiting_payment';state['revision']+=1;data=order()
   elif path==f'/v1/customer-checkout/orders/{ORDER}/watch':
    # Hold until the test advances the trusted projection; no quick-loop fixtures.
    if state['phase']=='awaiting_restaurant':state['phase']='ready_to_pay';state['revision']+=1
    else:state['held']=r;state['held_routes'].append(r);return
    data=order()
   else:r.abort();return
   r.fulfill(json=data,headers={'Access-Control-Allow-Origin':'*'})
  context.route('**/v1/**',route)
  page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto(URL+'/menu')
  page.get_by_test_id('product-pick-combo').click(timeout=25000);page.get_by_test_id('product-add').click()
  page.get_by_test_id('open-cart').click();page.get_by_test_id('cart-checkout').click()
  button=page.get_by_test_id('kaspi-checkout-submit')
  try:expect(button).to_be_enabled(timeout=10000)
  except Exception:
   print(page.locator('body').inner_text());print(errors);page.screenshot(path=str(OUT/'failure.png'));raise
  page.screenshot(path=str(OUT/f'checkout-{width}.png'))
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
  box=button.bounding_box();assert box['height']>=48 and box['y']+box['height']<=height+1,box
  button.click();expect(page.get_by_role('button',name='Проверить соединение')).to_be_visible()
  page.get_by_role('button',name='Проверить соединение').click()
  send=page.get_by_role('button',name='Отправить счёт на 4 190 ₸');expect(send).to_be_visible(timeout=15000)
  send.click();expect(page.get_by_text('Счёт отправлен в Kaspi',exact=True)).to_be_visible(timeout=10000)
  page.screenshot(path=str(OUT/f'invoice-{width}.png'))
  assert len(state['keys'])==2 and state['keys'][0]==state['keys'][1], state
  assert state['payments']==1
  state['phase']='paid';state['paid']=True;state['revision']+=1
  page.wait_for_timeout(100)
  state['held'].fulfill(json=order(),headers={'Access-Control-Allow-Origin':'*'})
  expect(page.get_by_text('Оплата получена',exact=True)).to_be_visible()
  expect(page.get_by_text('№ 2',exact=True)).to_be_visible()
  page.screenshot(path=str(OUT/f'paid-{width}.png'))
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
  page.get_by_role('button',name='В меню',exact=True).click()
  expect(page.get_by_test_id('screen-M12')).not_to_be_visible()
  state['teardown']=True
  for held in state['held_routes']:
   try:held.abort()
   except Exception:pass
  page.wait_for_timeout(50)
  context.unroute_all(behavior='ignoreErrors')
  context.close()
 browser.close()
assert not errors,errors
print('PASS: 3 sizes, touch targets, persisted recovery, single payment command, no horizontal overflow')
