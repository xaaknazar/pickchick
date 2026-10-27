"""Three-language mobile journeys on isolated fixtures. No live API calls or notifications."""
import json, os, subprocess
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from browser_network import isolated_context, route_fixture
ROOT=Path(__file__).resolve().parents[2]
URL=os.environ.get('CUSTOMER_AUTH_URL','http://127.0.0.1:4198').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1','localhost')
OUT=ROOT/'.local/l10n-push/screens';OUT.mkdir(parents=True,exist_ok=True)
CAT=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js';console.log(JSON.stringify(testCompleteCatalog))"],cwd=ROOT,text=True))
BRANCH=CAT['branch_id'];CUSTOMER='40000000-0000-4000-8000-000000000001'
customer={'id':CUSTOMER,'phone':'+77000000000','nickname':'Меню','birth_date':None,'gender':None,'profile_completed_at':None,'created_at':'2026-09-07T10:00:00.000Z'}
envelope={'version':1,'device_id':'40000000-0000-4000-8000-000000000004','tokens':{'access_token':'a'*64,'refresh_token':'b'*64,'access_expires_at':'2099-01-01T00:00:00.000Z','session_id':'40000000-0000-4000-8000-000000000002','customer':customer},'challenge':None,'otp_request':None,'verify_intent':None,'refresh_request_id':None,'closing':None}
errors=[]
with sync_playwright() as p:
 browser=p.chromium.launch()
 for width,height in [(393,852),(320,568)]:
  ctx=isolated_context(browser,viewport={'width':width,'height':height},device_scale_factor=1,reduced_motion='reduce')
  ctx.add_init_script('if(!sessionStorage.getItem("seeded")){sessionStorage.setItem("pickchick.customer.session.v1",'+json.dumps(json.dumps(envelope))+');sessionStorage.setItem("seeded","1");}')
  preferences={'locale':'ru','orders':False,'promotions':False};mutations=[]
  def intercept(route):
   path=urlparse(route.request.url).path;method=route.request.method
   data=None
   if path=='/v1/customers/me':data={'customer':customer}
   elif path=='/v1/auth/config':data={'enabled':True,'delivery_consent_required':True,'consent_version':'fixture-v1','terms_url':'https://example.test/terms','privacy_url':'https://example.test/privacy'}
   elif path=='/v1/notifications/config':data={'enabled':True,'providers':['apns'],'consentVersion':'notifications-v1'}
   elif path=='/v1/customers/me/notification-preferences':
    if method=='PATCH':
     body=route.request.post_data_json;assert set(body)=={'locale'},body;preferences.update(body);mutations.append(body)
    data=preferences.copy()
   elif path=='/v1/customers/me/notifications':data={'items':[]}
   elif path=='/v1/capabilities':data={'schema_version':1,'environment':'staging','data_mode':'pilot','ordering_enabled':False,'features':{'phone_auth':True,'test_order_flow':True,**{k:False for k in ['payments','fiscal','checkout','loyalty']}}}
   elif path=='/v1/branches':data={'branches':[{'id':BRANCH,'code':'TEST','name':'ТЦ Abay Plaza','timezone':'Asia/Almaty','ordering_enabled':False}]}
   elif path==f'/v1/branches/{BRANCH}/menu':data={'schema_version':1,'branch_id':BRANCH,'release_id':'40000000-0000-4000-8000-000000000005','version':1,'published_at':'2026-09-07T00:00:00Z','items':[]}
   elif path=='/v1/test/catalog':data=CAT
   elif path=='/v1/test/sessions' and method=='POST':data={'synthetic':True,'namespace':'pickchick-test','session_id':'40000000-0000-4000-8000-000000000006','token':'c'*64,'expires_at':'2099-01-01T00:00:00.000Z','channel':'mobile'}
   elif path=='/v1/test/orders' and method=='GET':data={'synthetic':True,'namespace':'pickchick-test','orders':[]}
   elif path==f'/v1/content/branches/{BRANCH}':data={'schema_version':1,'branch_id':BRANCH,'promos':[],'games':[]}
   elif path=='/v1/customer-checkout/availability':data={'enabled':True,'fresh':True,'signature':'a'*64,'products':[{'id':x['id'],'available':True,'stoppedOptions':[]}for x in CAT['products']]}
   elif path=='/v1/customer-checkout/config':data={'enabled':True,'branchId':BRANCH,'restaurant':'ТЦ Abay Plaza','fiscalPolicy':'deferred_pilot','orderCommentEnabled':True}
   elif path=='/v1/customer-checkout/orders':data={'orders':[]}
   elif path=='/v1/customer-checkout/feedback':data={'feedback':[]}
   if data is None:
    if method!='GET':errors.append(f'unexpected mutation {method} {path}')
    route.abort();return
   route.fulfill(json=data,headers={'Access-Control-Allow-Origin':'*'})
  route_fixture(ctx,'**/v1/**',intercept,notification_fixture=None)
  page=ctx.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
  page.goto(URL+'/screen/M34');expect(page.get_by_test_id('language-kk')).to_be_visible(timeout=20000)
  expect(page.get_by_test_id('launch-reveal')).to_have_count(0,timeout=20000)
  for lang,title in [('kk','Қолданба тілі'),('en','App language'),('ru','Язык приложения')]:
   page.get_by_test_id('language-'+lang).click();expect(page.get_by_text(title,exact=True)).to_be_visible()
   expect(page.get_by_test_id('language-'+lang)).to_have_attribute('aria-checked','true')
   page.screenshot(path=str(OUT/f'settings-{lang}-{width}.png'),full_page=True)
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(lang,width)
   page.reload();expect(page.get_by_text(title,exact=True)).to_be_visible(timeout=20000)
   page.goto(URL+'/screen/M31')
   expect(page.get_by_test_id('launch-reveal')).to_have_count(0,timeout=20000)
   support={'ru':'Вопросы по заказу и оплате','kk':'Тапсырыс пен төлем туралы сұрақтар','en':'Order and payment questions'}
   expect(page.get_by_text(support[lang],exact=True)).to_be_visible(timeout=20000)
   fallback={'ru':'Пока поддержка работает в ресторане: обратитесь к сотруднику на кассе.','kk':'Әзірге қолдау мейрамханада көрсетіледі: кассадағы қызметкерге хабарласыңыз.','en':'For now, support is available in the restaurant. Please speak to a staff member at the till.'}
   expect(page.get_by_test_id('support-contact-fallback')).to_have_text(fallback[lang])
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),('support',lang,width)
   page.screenshot(path=str(OUT/f'support-{lang}-{width}.png'),full_page=True)
   page.goto(URL+'/screen/M34');expect(page.get_by_text(title,exact=True)).to_be_visible(timeout=20000)
  # Cart page (27.10.2026) in Kazakh and English: dining pill, payment method, total, pay button.
  for lang,words in [('kk',('Мейрамханада','Алып кету','Төлем тәсілі','Барлығы','Kaspi.kz арқылы төлеу')),('en',('Dine in','Takeaway','Payment method','Total','Pay with Kaspi.kz'))]:
   page.goto(URL+'/screen/M34');page.get_by_test_id('language-'+lang).click(timeout=20000)
   page.goto(URL+'/menu');page.get_by_test_id('product-pick-combo').click(timeout=20000);page.get_by_test_id('product-add').click();page.get_by_test_id('open-cart').click()
   cart=page.get_by_test_id('screen-M09');expect(cart).to_be_visible()
   for radio in words[:2]:expect(cart.get_by_role('radio',name=radio,exact=True)).to_be_visible()
   expect(page.get_by_test_id('cart-payment-method')).to_contain_text(words[2]);expect(cart.get_by_text(words[3],exact=True)).to_be_visible()
   expect(page.get_by_test_id('cart-pay')).to_have_accessible_name(words[4]+', 4 190 ₸',timeout=15000)
   # The visible button keeps the language's word order around the mark (KK: «Kaspi.kz арқылы төлеу»).
   assert page.get_by_test_id('cart-pay').evaluate("(e)=>e.innerText.replace(/\\s+/g,' ').trim()")==words[4],lang
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),('cart',lang,width)
   page.screenshot(path=str(OUT/f'cart-{lang}-{width}.png'))
   page.get_by_test_id('cart-clear').click();page.get_by_test_id('cart-clear-confirm').click();expect(page.get_by_test_id('cart-pay')).to_have_count(0)
  page.goto(URL+'/screen/M34');expect(page.get_by_test_id('language-en')).to_be_visible(timeout=20000)
  page.get_by_test_id('language-en').click();page.goto(URL+'/menu');expect(page.get_by_test_id('floating-tab-bar')).to_be_visible(timeout=20000)
  expect(page.get_by_test_id('launch-reveal')).to_have_count(0,timeout=20000)
  expect(page.get_by_test_id('tab-menu')).to_contain_text('Menu');expect(page.get_by_test_id('tab-orders')).to_contain_text('Orders')
  page.screenshot(path=str(OUT/f'menu-en-{width}.png'),full_page=True)
  page.get_by_test_id('tab-profile').click();expect(page.get_by_text('Меню',exact=True).first).to_be_visible()
  page.screenshot(path=str(OUT/f'profile-en-{width}.png'),full_page=True)
  assert all(set(x)=={'locale'}for x in mutations)
  ctx.close()
 browser.close()
assert not errors,errors
print('PASS: RU/KK/EN selection, persistence, KK/EN cart page, tabs, user nickname, web push gate at 393x852 and 320x568')
