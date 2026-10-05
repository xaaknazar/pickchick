"""Real checkout UI against isolated bank-free HTTP fixtures; no external requests escape."""
import json, os, re, subprocess
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
INVALID_HOSTED=os.environ.get('CHECKOUT_HOSTED_INVALID_TEST')=='1'
HOSTED=os.environ.get('CHECKOUT_HOSTED_TEST')=='1' or INVALID_HOSTED
API_ORIGIN=re.search(r"API_URL = '([^']+)'",(ROOT/'apps/mobile/src/api.ts').read_text()).group(1)
errors=[]
with sync_playwright() as p:
 browser=p.chromium.launch()
 for width,height in [(320,568),(393,852),(768,1024),(852,393)]:
  context=browser.new_context(viewport={'width':width,'height':height},reduced_motion='reduce')
  context.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",'+json.dumps(json.dumps(envelope))+');')
  state={'payment_method':'kaspi','hosted_calls':0,'method_calls':0,'phase':'awaiting_restaurant','created':False,'paid':False,'drop':True,'keys':[],'payments':0,'quotes':0,'quote_keys':[],'quote_drop':True,'quote_total':'420000' if width==393 else '419000','revision':1,'held_routes':[],'teardown':False,'blocked':True,'comment':'','quote_comment':'','feedback':None,'feedback_posts':0,'feedback_drop':True,'config_reads':0,'config_offline':False,'expiry':(datetime.now(timezone.utc)+timedelta(minutes=3)).isoformat().replace('+00:00','Z')}
  def order():
   return {**({'paymentMethod':state['payment_method']} if HOSTED else {}),'orderId':ORDER,'revision':hex(state['revision'])[2:].zfill(64),'restaurant':'ТЦ Abay Plaza','branchId':BRANCH,'createdAt':'2026-09-30T00:00:00.000Z','updatedAt':'2026-09-30T00:01:00.000Z','kitchenStage':'assembly' if state['phase']=='preparing' else None,'displayNumber':'2' if state['paid'] else None,'totalMinor':'419000','serviceMode':'takeaway','kitchenComment':state['comment'] or None,'phase':state['phase'],'expiresAt':state['expiry'] if state['phase']=='awaiting_payment' else None,'receipt':'deferred','receiptUrl':None,'items':[{'productId':'pick-combo','title':'Pick Combo','quantity':1,'totalMinor':'419000','modifiers':['Coca-Cola 0,5 л','Фирменный соус']} ]}
  def route(r):
   if state['teardown']:r.abort();return
   path=urlparse(r.request.url).path; method=r.request.method
   body=r.request.post_data_json if r.request.post_data else None
   if path.startswith('/v1/customer-checkout/') and path.endswith('/feedback'):
    assert r.request.headers.get('accept')=='application/json'
    assert r.request.headers.get('authorization')=='Bearer '+envelope['tokens']['access_token']
   elif path.startswith('/v1/customer-checkout/') and not path.endswith('/availability'):
    assert r.request.headers.get('accept')=='application/json; profile=pickchick.checkout-wallets-v1'
   data=None
   if path=='/v1/customers/me':data={'customer':customer}
   elif path=='/v1/customer-checkout/availability' and method=='GET':data={'enabled':True,'fresh':True,'signature':'a'*64,'products':[{'id':p['id'],'available':True,'stoppedOptions':[]} for p in CATALOG['products']]}
   elif path=='/v1/auth/config':data={'enabled':True,'delivery_consent_required':True,'consent_version':'fixture-v1','terms_url':'https://example.test/terms','privacy_url':'https://example.test/privacy'}
   elif path=='/v1/capabilities':data={'schema_version':1,'environment':'staging','data_mode':'pilot','ordering_enabled':False,'features':{'phone_auth':True,'test_order_flow':True,**{k:False for k in ['payments','fiscal','checkout','loyalty']}}}
   elif path=='/v1/branches':data={'branches':[{'id':BRANCH,'code':'TEST','name':'ТЦ Abay Plaza','timezone':'Asia/Almaty','ordering_enabled':False}]}
   elif path=='/v1/branches/'+BRANCH+'/menu':data={'schema_version':1,'branch_id':BRANCH,'release_id':'10000000-0000-4000-8000-000000000008','version':1,'published_at':'2026-09-07T00:00:00Z','items':[]}
   elif path=='/v1/test/catalog':data=CATALOG
   elif path=='/v1/content/branches/'+BRANCH:data={'schema_version':1,'branch_id':BRANCH,'promos':[],'games':[]}
   elif path=='/v1/customer-checkout/feedback' and method=='GET':
    data={'feedback':[{'orderId':ORDER,**state['feedback']}] if state['feedback'] else []}
   elif path==f'/v1/customer-checkout/orders/{ORDER}/feedback' and method in ('GET','POST'):
    assert state['created'] and state['paid'] and state['phase']=='handed_over',state
    if method=='POST':
     state['feedback_posts']+=1
     assert set(body)=={'rating','comment'} and type(body['rating']) is int and 1<=body['rating']<=5
     assert isinstance(body['comment'],str) and len(body['comment'])<=500 and body['comment']==body['comment'].strip()
     if state['feedback_drop']:state['feedback_drop']=False;r.abort();return
     now=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
     state['feedback']={'rating':body['rating'],'comment':body['comment'] or None,'createdAt':state['feedback']['createdAt'] if state['feedback'] else now,'updatedAt':now}
    data={'orderId':ORDER,'enabled':True,'feedback':state['feedback'],'preparationStartedAt':None,'readyAt':None}
   elif path=='/v1/customer-checkout/config':
    state['config_reads']+=1
    if state['config_offline']:r.abort();return
    data={**({'paymentMethods':['kaspi','card','apple_pay','google_pay']} if HOSTED else {}),'enabled':True,'branchId':'7a6f6d98-395d-4462-b5e4-b0364a4a8ec1','restaurant':'ТЦ Abay Plaza','fiscalPolicy':'deferred_pilot','orderCommentEnabled':True}
   elif path=='/v1/customer-checkout/quotes':
    assert page.get_by_test_id('kaspi-connecting').count()==1, 'Quotes must start inside the connecting scene'
    state['quotes']+=1;state['quote_keys'].append(body['key'])
    assert 'totalMinor' not in body
    assert body['branchId']=='7a6f6d98-395d-4462-b5e4-b0364a4a8ec1'
    state['quote_comment']=body.get('kitchenComment','')
    assert len(state['quote_comment'])<=60
    if state['quote_drop']:state['quote_drop']=False;r.abort();return
    data={'quoteId':'40000000-0000-4000-8000-000000000005','totalMinor':state['quote_total'],'expiresAt':future,'serviceMode':body['serviceMode'],'kitchenComment':state['quote_comment'] or None}
   elif path=='/v1/customer-checkout/orders':
    if state['blocked']:
     r.fulfill(status=403,json={'code':'FORBIDDEN','message_key':'errors.forbidden','trace_id':'40000000-0000-4000-8000-000000000009','retryable':False},headers={'Access-Control-Allow-Origin':'*'});return
    if method=='GET':data={'orders':[order()] if state['created'] and state['phase']!='failed' else []}
    else:
     state['keys'].append(body['key']);state['created']=True;state['comment']=state['quote_comment']
     if state['drop']:state['drop']=False;r.abort();return
     data=order()
   elif path==f'/v1/customer-checkout/orders/{ORDER}' and method=='GET':data=order()
   elif path==f'/v1/customer-checkout/orders/{ORDER}/payment-method':
    assert state['created'] and state['phase']=='ready_to_pay'
    assert body=={'method':'card'}
    state['method_calls']+=1;state['payment_method']='card';state['revision']+=1;data=order()
   elif path==f'/v1/customer-checkout/orders/{ORDER}/hosted-payment':
    assert state['created'] and state['payment_method']=='card'
    state['hosted_calls']+=1
    if state['hosted_calls']>1:
     r.fulfill(status=409,json={'code':'PAYMENT_CHECK_REQUIRED','message_key':'errors.payment_check_required','trace_id':ORDER,'retryable':False},headers={'Access-Control-Allow-Origin':'*'});return
    assert state['phase']=='ready_to_pay'
    state['payments']+=1;state['phase']='awaiting_payment';state['revision']+=1
    data={'orderId':ORDER,'attemptId':'40000000-0000-4000-8000-000000000006','checkoutUrl':API_ORIGIN+'/v1/integrations/tiptoppay/checkout#'+'a'*64,'expiresAt':future}
    if INVALID_HOSTED:
     invalid={320:'https://untrusted.example/v1/integrations/tiptoppay/checkout#'+'a'*64,393:API_ORIGIN.replace('https:','http:')+'/v1/integrations/tiptoppay/checkout#'+'a'*64,768:API_ORIGIN+'/wrong-path#'+'a'*64}
     if width in invalid:data['checkoutUrl']=invalid[width]
     else:data['expiresAt']='2000-01-01T00:00:00Z'
   elif path=='/v1/integrations/tiptoppay/checkout':
    assert HOSTED
    r.fulfill(status=200,content_type='text/html',body='<h1>Isolated bank-free hosted fixture</h1>');return
   elif path==f'/v1/customer-checkout/orders/{ORDER}/payment':
    assert state['payment_method']=='kaspi'
    assert not state['config_offline'] and state['quotes']>=2 and state['created'], 'No invoice before completed checks and accepted order'
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
  expect(button).to_be_enabled()
  assert not state['keys'] and state['payments']==0 and state['quotes']==0
  if HOSTED:
   state.update(blocked=False,drop=False,quote_drop=False,quote_total='419000',quotes=2)
   page.get_by_test_id('payment-method').click()
   expect(page.get_by_test_id('payment-method-apple_pay')).to_have_count(0)
   expect(page.get_by_test_id('payment-method-google_pay')).to_have_count(0)
   page.get_by_test_id('payment-method-card').click()
   if INVALID_HOSTED:
    button.click()
    expect(page.get_by_text('Связь прервалась. Заказ сохранён - повторно оплачивать не нужно.',exact=True)).to_be_visible(timeout=15000)
    assert len(context.pages)==1 and state['payments']==1 and state['hosted_calls']==1
    expect(page.get_by_test_id('kaspi-paid')).to_have_count(0)
    page.wait_for_timeout(500)
    assert state['hosted_calls']==1
    state['teardown']=True
    for held in state['held_routes']:
     try:held.abort()
     except Exception:pass
    page.wait_for_timeout(100)
    context.unroute_all(behavior='ignoreErrors');context.close()
    continue
   with context.expect_page() as popup_info:button.click()
   popup=popup_info.value
   expect(popup.get_by_text('Isolated bank-free hosted fixture')).to_be_visible()
   expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Ждём оплату · Банковская карта')
   assert state['payments']==1 and state['method_calls']==1 and state['hosted_calls']==1
   popup.close()
   expect(page.get_by_test_id('kaspi-paid')).to_have_count(0)
   page.wait_for_timeout(250)
   assert state['payments']==1
   page.screenshot(path=str(OUT/f'hosted-{width}.png'))
   page.get_by_role('button',name='Открыть страницу оплаты',exact=True).click()
   page.wait_for_timeout(300)
   assert state['hosted_calls']==2 and state['payments']==1
   expect(page.get_by_test_id('kaspi-paid')).to_have_count(0)
   page.reload()
   expect(page.get_by_test_id('kaspi-waiting')).to_be_visible(timeout=15000)
   assert state['payments']==1 and state['hosted_calls']==2
   state['phase']='paid';state['paid']=True;state['revision']+=1
   page.wait_for_timeout(150);state['held'].fulfill(json=order(),headers={'Access-Control-Allow-Origin':'*'})
   expect(page.get_by_test_id('kaspi-paid')).to_contain_text('Оплачено')
   state['teardown']=True
   for held in state['held_routes']:
    try:held.abort()
    except Exception:pass
   context.unroute_all(behavior='ignoreErrors');context.close()
   continue
  # A definitive account rejection is only checked after explicit payment.
  button.click()
  expect(page.get_by_text('Оплата Kaspi ещё не открыта для вашего аккаунта. Корзина сохранена - можно вернуться к ней позже.',exact=True)).to_be_visible()
  expect(button).to_be_enabled()
  assert not state['keys'] and state['payments']==0 and state['quotes']==0
  total=page.get_by_test_id('kaspi-checkout-total')
  assert total.evaluate('(el) => parseFloat(getComputedStyle(el).lineHeight) >= parseFloat(getComputedStyle(el).fontSize) * 1.3')
  page.screenshot(path=str(OUT/f'blocked-{width}.png'))
  state['blocked']=False
  # Lost configuration connection cannot disable payment. Cancelling preparation
  # stops retries without creating a quote, order or invoice.
  state['config_offline']=True
  button.click()
  expect(page.get_by_test_id('kaspi-connecting')).to_be_visible()
  page.get_by_role('button',name='Вернуться к оформлению',exact=True).click()
  expect(button).to_be_enabled()
  config_reads=state['config_reads']
  page.wait_for_timeout(2600)
  assert state['config_reads']==config_reads and state['quotes']==0 and not state['keys'] and state['payments']==0
  page.get_by_role('radio',name='В зале',exact=True).click()
  expect(page.get_by_role('radio',name='В зале',exact=True)).to_have_attribute('aria-checked','true')
  assert state['quotes']==0, 'Changing details cannot create a quote before pay'
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
  # Rapid duplicate UI taps share one preparation, then transport recovers
  # automatically. Neither the button screen nor animation displays an error.
  button.evaluate('(el) => { el.click(); el.click(); }')
  expect(page.get_by_test_id('kaspi-connecting')).to_be_visible()
  assert state['quotes']==0 and not state['keys'] and state['payments']==0
  expect(page.get_by_text('Не удалось загрузить оформление. Корзина сохранена. Проверяем связь автоматически.',exact=True)).to_have_count(0)
  state['config_offline']=False
  if width==393:
   expect(page.get_by_text('Сумма заказа изменилась. Проверьте её и нажмите оплату ещё раз.',exact=True)).to_be_visible(timeout=10000)
   assert not state['keys'] and state['payments']==0
   expect(button).to_be_enabled()
   button.click()
  expect(page.get_by_test_id('kaspi-waiting')).to_contain_text('Ждём оплату в Kaspi',timeout=10000)
  page.screenshot(path=str(OUT/f'invoice-{width}.png'))
  assert len(state['keys'])==2 and state['keys'][0]==state['keys'][1], state
  assert state['payments']==1 and state['quotes']==(3 if width==393 else 2)
  assert state['quote_keys'][0]==state['quote_keys'][1], 'Lost quote response must reuse its key'
  assert state['comment']=='Соус отдельно, пожалуйста',state
  # Lost status connection recovers without a tap or another bank payment command.
  page.wait_for_timeout(150)
  previous_watch=state['held']
  previous_watch.abort()
  expect(page.get_by_text('Связь прервалась. Восстанавливаем статус заказа автоматически.',exact=True)).to_have_count(0)
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
  state['phase']='awaiting_restaurant';state['created']=False;state['revision']+=1
  button.click()
  if width==393:
   expect(page.get_by_text('Сумма заказа изменилась. Проверьте её и нажмите оплату ещё раз.',exact=True)).to_be_visible(timeout=10000)
   assert state['payments']==1
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
  for phase,scene in [('preparing','assembly'),('ready','ready-takeaway')]:
   page.wait_for_timeout(150)
   state['phase']=phase;state['revision']+=1
   state['held'].fulfill(json=order(),headers={'Access-Control-Allow-Origin':'*'})
   expect(page.get_by_test_id('order-chef-'+scene)).to_be_visible()
  # Issued orders leave the tracker and load a separate server-backed review.
  page.wait_for_timeout(150)
  state['phase']='handed_over';state['revision']+=1
  state['held'].fulfill(json=order(),headers={'Access-Control-Allow-Origin':'*'})
  completed=page.get_by_test_id('completed-order')
  expect(completed).to_be_visible()
  expect(page.get_by_test_id('completed-order-number')).to_contain_text('№ 2')
  expect(page.get_by_test_id('completed-order-total')).to_contain_text('4 190')
  expect(page.get_by_test_id('order-status-close')).to_have_count(0)
  expect(page.get_by_test_id('order-chef-ready-takeaway')).to_have_count(0)
  expect(page.get_by_test_id('order-play-blocks')).to_have_count(0)
  expect(page.get_by_test_id('completed-item-0')).to_contain_text('Coca-Cola 0,5 л')
  expect(page.get_by_test_id('completed-item-0')).to_contain_text('Фирменный соус')
  expect(page.get_by_test_id('order-kitchen-comment')).to_contain_text('Соус отдельно, пожалуйста')
  expect(page.get_by_test_id('completed-receipt-unavailable')).to_be_visible()
  expect(page.get_by_test_id('completed-order-receipt')).to_have_count(0)
  rating=page.get_by_test_id('completed-rating-4')
  expect(rating).to_be_enabled(timeout=10000)
  rating.click()
  expect(rating).to_have_attribute('aria-checked','true')
  review_comment=page.get_by_test_id('completed-review-comment')
  review_comment.fill('Всё понравилось. Спасибо!')
  save=page.get_by_test_id('completed-review-save')
  save.click()
  expect(page.get_by_test_id('completed-review-error')).to_be_visible()
  assert state['feedback_posts']==1 and state['feedback'] is None
  expect(page.get_by_test_id('completed-review-saved')).to_have_count(0)
  expect(review_comment).to_have_value('Всё понравилось. Спасибо!')
  expect(save).to_be_enabled()
  save.click()
  expect(page.get_by_test_id('completed-review-saved')).to_be_visible(timeout=10000)
  assert state['feedback_posts']==2 and state['feedback']['rating']==4 and state['feedback']['comment']=='Всё понравилось. Спасибо!'
  expect(save).to_be_disabled()
  assert state['payments']==2
  page.screenshot(path=str(OUT/f'completed-review-{width}.png'))
  page.get_by_test_id('completed-order-close').click()
  expect(page.get_by_test_id('screen-M12')).not_to_be_visible()
  page.goto(URL+'/orders')
  history=page.get_by_test_id('order-history-'+ORDER)
  expect(history).to_be_visible()
  expect(history).to_contain_text('Pick Combo ×1')
  expect(history.get_by_text('Ваша оценка',exact=True)).to_be_visible()
  # RN Web button selected state has no aria-selected; verify the exact visible star pattern.
  stars=[page.get_by_test_id(f'order-history-rate-{ORDER}-{value}').inner_text() for value in range(1,6)]
  assert stars[0] and len(set(stars[:4]))==1 and stars[4]!=stars[0],stars
  # A new star selection from history overrides the previously saved rating.
  page.get_by_test_id(f'order-history-rate-{ORDER}-5').click()
  sheet=page.get_by_test_id('order-sheet')
  close=page.get_by_test_id('completed-order-close')
  expect(close).to_be_visible()
  expect(page.get_by_test_id('completed-rating-5')).to_have_attribute('aria-checked','true')
  # Reopening loads authoritative feedback before the editor can save.
  expect(page.get_by_test_id('completed-rating-5')).to_be_enabled(timeout=10000)
  expect(review_comment).to_have_value('Всё понравилось. Спасибо!')
  expect(save).to_be_enabled()
  page.wait_for_timeout(450)
  sb=sheet.bounding_box();cb=close.bounding_box()
  assert sb['y']>=20 and cb['y']>=sb['y']+20 and cb['height']>=44,(sb,cb)
  save.click()
  expect(page.get_by_test_id('completed-review-saved')).to_be_visible()
  assert state['feedback_posts']==3 and state['feedback']['rating']==5
  page.screenshot(path=str(OUT/f'history-completed-{width}.png'))
  close.click()
  expect(page.get_by_test_id(f'order-history-open-{ORDER}')).to_be_visible()
  # Reload the app to prove history/detail rehydrate from HTTP, not the hook cache.
  page.reload()
  expect(history.get_by_text('Ваша оценка',exact=True)).to_be_visible(timeout=10000)
  for value in range(1,6):expect(page.get_by_test_id(f'order-history-rate-{ORDER}-{value}')).to_have_text(stars[0])
  page.get_by_test_id(f'order-history-open-{ORDER}').click()
  expect(page.get_by_test_id('completed-rating-5')).to_have_attribute('aria-checked','true')
  # Reopening loads authoritative feedback before the editor can save.
  expect(page.get_by_test_id('completed-rating-5')).to_be_enabled(timeout=10000)
  expect(review_comment).to_have_value('Всё понравилось. Спасибо!')
  expect(page.get_by_test_id('completed-review-saved')).to_be_visible()
  expect(save).to_be_disabled()
  assert state['feedback_posts']==3 and state['payments']==2
  close.click()
  # A bank-confirmed unpaid cancellation disappears while the order list is open.
  state['phase']='awaiting_payment';state['paid']=False;state['revision']+=1
  page.goto(URL+'/orders')
  expect(page.get_by_test_id(f'order-history-open-{ORDER}')).to_be_visible()
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
print(('PASS: invalid hosted responses blocked on four sizes' if INVALID_HOSTED else 'PASS: hosted browser close/reopen/reload require trusted bank status on four sizes') if HOSTED else 'PASS: 4 sizes, no pre-pay quote, actionable offline checkout, cancellation, duplicate taps, same-key quote/order recovery, price confirmation, touch targets, persisted recovery, unknown blocks retry, definitive failure retries, paid/kitchen/completed stages, server-backed review save/retry/reload, no overflow')
