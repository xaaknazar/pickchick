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
 for width,height in [(320,568),(393,852),(768,1024),(852,393)]:
  context=browser.new_context(viewport={'width':width,'height':height},reduced_motion='reduce')
  context.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",'+json.dumps(json.dumps(envelope))+');')
  state={'phase':'awaiting_restaurant','created':False,'paid':False,'drop':True,'keys':[],'payments':0,'revision':1,'held_routes':[],'teardown':False,'blocked':True,'comment':'','quote_comment':'','expiry':(datetime.now(timezone.utc)+timedelta(minutes=3)).isoformat().replace('+00:00','Z')}
  def order():
   return {'orderId':ORDER,'revision':hex(state['revision'])[2:].zfill(64),'restaurant':'ТЦ Abay Plaza','branchId':BRANCH,'createdAt':'2026-09-30T00:00:00.000Z','updatedAt':'2026-09-30T00:01:00.000Z','kitchenStage':'assembly' if state['phase']=='preparing' else None,'displayNumber':'2' if state['paid'] else None,'totalMinor':'419000','serviceMode':'takeaway','kitchenComment':state['comment'] or None,'phase':state['phase'],'expiresAt':state['expiry'] if state['phase']=='awaiting_payment' else None,'receipt':'deferred','receiptUrl':None,'items':[{'productId':'pick-combo','title':'Pick Combo','quantity':1,'totalMinor':'419000','modifiers':['Coca-Cola 0,5 л','Фирменный соус']} ]}
  def route(r):
   if state['teardown']:r.abort();return
   path=urlparse(r.request.url).path; method=r.request.method
   body=r.request.post_data_json if r.request.post_data else None
   if path.startswith('/v1/customer-checkout/') and not path.endswith('/availability'):
    assert r.request.headers.get('accept')=='application/json; profile="pickchick.checkout-comments-v1"'
   data=None
   if path=='/v1/customers/me':data={'customer':customer}
   elif path=='/v1/customer-checkout/availability' and method=='GET':data={'enabled':True,'fresh':True,'signature':'a'*64,'products':[{'id':p['id'],'available':True,'stoppedOptions':[]} for p in CATALOG['products']]}
   elif path=='/v1/auth/config':data={'enabled':True,'delivery_consent_required':True,'consent_version':'fixture-v1','terms_url':'https://example.test/terms','privacy_url':'https://example.test/privacy'}
   elif path=='/v1/capabilities':data={'schema_version':1,'environment':'staging','data_mode':'pilot','ordering_enabled':False,'features':{'phone_auth':True,'test_order_flow':True,**{k:False for k in ['payments','fiscal','checkout','loyalty']}}}
   elif path=='/v1/branches':data={'branches':[{'id':BRANCH,'code':'TEST','name':'ТЦ Abay Plaza','timezone':'Asia/Almaty','ordering_enabled':False}]}
   elif path=='/v1/branches/'+BRANCH+'/menu':data={'schema_version':1,'branch_id':BRANCH,'release_id':'10000000-0000-4000-8000-000000000008','version':1,'published_at':'2026-09-07T00:00:00Z','items':[]}
   elif path=='/v1/test/catalog':data=CATALOG
   elif path=='/v1/content/branches/'+BRANCH:data={'schema_version':1,'branch_id':BRANCH,'promos':[],'games':[]}
   elif path=='/v1/customer-checkout/config':data={'enabled':True,'branchId':'7a6f6d98-395d-4462-b5e4-b0364a4a8ec1','restaurant':'ТЦ Abay Plaza','fiscalPolicy':'deferred_pilot','orderCommentEnabled':True}
   elif path=='/v1/customer-checkout/quotes':
    assert 'totalMinor' not in body
    assert body['branchId']=='7a6f6d98-395d-4462-b5e4-b0364a4a8ec1'
    state['quote_comment']=body.get('kitchenComment','')
    assert len(state['quote_comment'])<=60
    data={'quoteId':'40000000-0000-4000-8000-000000000005','totalMinor':'419000','expiresAt':future,'serviceMode':body['serviceMode'],'kitchenComment':state['quote_comment'] or None}
   elif path=='/v1/customer-checkout/orders':
    if state['blocked']:
     r.fulfill(status=403,json={'code':'FORBIDDEN','message_key':'errors.forbidden','trace_id':'40000000-0000-4000-8000-000000000009','retryable':False},headers={'Access-Control-Allow-Origin':'*'});return
    if method=='GET':data={'orders':[order()] if state['created'] and state['phase']!='failed' else []}
    else:
     state['keys'].append(body['key']);state['created']=True;state['comment']=state['quote_comment']
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
  page.get_by_test_id('open-cart').click()
  page.screenshot(path=str(OUT/f'cart-{width}.png'))
  page.get_by_test_id('cart-checkout').click()
  button=page.get_by_test_id('kaspi-checkout-submit')
  expect(page.get_by_text('Оплата Kaspi ещё не открыта для вашего аккаунта. Корзина сохранена - можно вернуться к ней позже.',exact=True)).to_be_visible()
  expect(button).to_be_disabled()
  assert not state['keys'] and state['payments']==0
  total=page.get_by_test_id('kaspi-checkout-total')
  assert total.evaluate('(el) => parseFloat(getComputedStyle(el).lineHeight) >= parseFloat(getComputedStyle(el).fontSize) * 1.3')
  page.screenshot(path=str(OUT/f'blocked-{width}.png'))
  state['blocked']=False
  page.get_by_role('button',name='Проверить соединение').click()
  try:expect(button).to_be_enabled(timeout=10000)
  except Exception:
   print(page.locator('body').inner_text());print(errors);page.screenshot(path=str(OUT/'failure.png'));raise
  with page.expect_response(lambda response: urlparse(response.url).path=='/v1/customer-checkout/quotes' and response.request.post_data_json['serviceMode']=='dine_in'):
   page.get_by_role('radio',name='В зале',exact=True).click()
  expect(button).to_be_enabled(timeout=10000)
  expect(page.get_by_role('radio',name='В зале',exact=True)).to_have_attribute('aria-checked','true')
  # Customer instructions survive closing the sheet and bind to the submitted quote.
  comment=page.get_by_test_id('checkout-comment-input')
  expect(comment).to_be_editable()
  comment.fill('Соус отдельно, пожалуйста')
  comment.blur()
  page.get_by_test_id('checkout-close').click()
  if width==393:
   page.get_by_test_id('cart-close').click()
   page.reload()
   page.get_by_test_id('open-cart').click(timeout=20000)
  page.get_by_test_id('cart-checkout').click()
  expect(comment).to_have_value('Соус отдельно, пожалуйста')
  expect(button).to_be_enabled(timeout=10000)
  comment.scroll_into_view_if_needed()
  page.screenshot(path=str(OUT/f'checkout-{width}.png'))
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
  box=button.bounding_box();assert box['height']>=48 and box['y']+box['height']<=height+1,box
  button.click();expect(page.get_by_role('button',name='Проверить соединение')).to_be_visible()
  page.get_by_role('button',name='Проверить соединение').click()
  expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Ждём оплату в Kaspi',timeout=10000)
  page.screenshot(path=str(OUT/f'invoice-{width}.png'))
  assert len(state['keys'])==2 and state['keys'][0]==state['keys'][1], state
  assert state['payments']==1
  assert state['comment']=='Соус отдельно, пожалуйста',state
  # Lost status connection recovers without a tap or another bank payment command.
  page.wait_for_timeout(150)
  previous_watch=state['held']
  previous_watch.abort()
  expect(page.get_by_text('Связь прервалась. Восстанавливаем статус заказа автоматически.',exact=True)).to_be_visible()
  page.wait_for_timeout(1500)
  assert state['held'] is not previous_watch
  assert state['payments']==1
  expect(page.get_by_test_id('kaspi-invoice-countdown')).to_be_visible()
  state['expiry']='2000-01-01T00:00:00Z';state['revision']+=1
  state['held'].fulfill(json=order(),headers={'Access-Control-Allow-Origin':'*'})
  expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Проверяем отмену счёта')
  expect(page.get_by_test_id('kaspi-open-app')).to_have_count(0)
  expect(page.get_by_test_id('kaspi-retry-payment')).to_have_count(0)
  page.screenshot(path=str(OUT/f'expiry-{width}.png'))
  state['expiry']=(datetime.now(timezone.utc)+timedelta(minutes=3)).isoformat().replace('+00:00','Z')
  # An ambiguous bank response must never expose a second payment command.
  state['phase']='checking';state['revision']+=1
  page.wait_for_timeout(100);state['held'].fulfill(json=order(),headers={'Access-Control-Allow-Origin':'*'})
  expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Уточняем оплату')
  expect(page.get_by_test_id('kaspi-retry-payment')).to_have_count(0)
  state['phase']='failed';state['revision']+=1
  page.wait_for_timeout(100);state['held'].fulfill(json=order(),headers={'Access-Control-Allow-Origin':'*'})
  expect(page.get_by_test_id('kaspi-failed')).to_contain_text('Счёт не оплачен')
  page.screenshot(path=str(OUT/f'failed-{width}.png'))
  page.get_by_test_id('kaspi-retry-payment').click()
  expect(button).to_be_enabled(timeout=10000)
  state['phase']='awaiting_restaurant';state['revision']+=1
  button.click()
  expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Ждём оплату в Kaspi',timeout=10000)
  assert len(state['keys'])==3 and state['keys'][2]!=state['keys'][0] and state['payments']==2,state
  state['phase']='paid';state['paid']=True;state['revision']+=1
  page.wait_for_timeout(100)
  state['held'].fulfill(json=order(),headers={'Access-Control-Allow-Origin':'*'})
  expect(page.get_by_test_id('kaspi-paid')).to_contain_text('Оплачено')
  page.screenshot(path=str(OUT/f'confirmation-{width}.png'))
  if width != 393:page.get_by_test_id('kaspi-track-order').click()
  expect(page.get_by_text('Оплата получена',exact=True)).to_be_visible()
  expect(page.get_by_test_id('connected-order-number')).to_contain_text('№ 2')
  expect(page.get_by_test_id('order-chef-cooking')).to_be_visible()
  expect(page.get_by_text('Соус отдельно, пожалуйста',exact=True)).to_be_visible()
  page.screenshot(path=str(OUT/f'paid-{width}.png'))
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
  for phase,scene in [('preparing','assembly'),('ready','ready-takeaway'),('handed_over','ready-takeaway')]:
   page.wait_for_timeout(150)
   state['phase']=phase;state['revision']+=1
   state['held'].fulfill(json=order(),headers={'Access-Control-Allow-Origin':'*'})
   expect(page.get_by_test_id('order-chef-'+scene)).to_be_visible()
  expect(page.get_by_text('Приятного аппетита!',exact=True)).to_be_visible()
  page.get_by_test_id('order-status-close').click()
  expect(page.get_by_test_id('screen-M12')).not_to_be_visible()
  page.goto(URL+'/orders')
  page.get_by_role('button',name='Открыть заказ 2',exact=True).click()
  sheet=page.get_by_test_id('order-sheet')
  close=page.get_by_test_id('order-status-close')
  expect(close).to_be_visible()
  page.wait_for_timeout(450)
  sb=sheet.bounding_box();cb=close.bounding_box()
  assert sb['y']>=20 and cb['y']>=sb['y']+20 and cb['height']>=44,(sb,cb)
  page.screenshot(path=str(OUT/f'history-status-{width}.png'))
  close.click()
  expect(page.get_by_role('button',name='Открыть заказ 2',exact=True)).to_be_visible()
  # A bank-confirmed unpaid cancellation disappears while the order list is open.
  state['phase']='awaiting_payment';state['paid']=False;state['revision']+=1
  page.goto(URL+'/orders')
  expect(page.get_by_role('button',name='Открыть заказ',exact=True)).to_be_visible()
  page.wait_for_timeout(150)
  state['phase']='failed';state['revision']+=1
  state['held'].fulfill(json=order(),headers={'Access-Control-Allow-Origin':'*'})
  expect(page.get_by_text('Заказов пока нет',exact=True)).to_be_visible()
  assert state['payments']==2
  state['teardown']=True
  for held in state['held_routes']:
   try:held.abort()
   except Exception:pass
  page.wait_for_timeout(50)
  context.unroute_all(behavior='ignoreErrors')
  context.close()
 browser.close()
assert not errors,errors
print('PASS: 4 sizes, touch targets, persisted recovery, unknown blocks retry, definitive failure retries, paid/kitchen stages, no overflow')
