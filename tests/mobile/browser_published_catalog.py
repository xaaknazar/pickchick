"""Published mobile UI with PostgreSQL quotes; fixture refuses order/payment commands."""
from browser_network import isolated_context, route_fixture
import json, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
fixture=json.loads(Path(sys.argv[1]).read_text()); URL=fixture['url']; OUT=Path(fixture['output']); CUSTOMER=fixture['customer']; BRANCH=fixture['branch']
assert urlparse(URL).hostname in ('127.0.0.1','localhost')
future=(datetime.now(timezone.utc)+timedelta(hours=2)).isoformat().replace('+00:00','Z')
customer={'id':CUSTOMER,'phone':'+77000000000','nickname':'Synthetic browser','birth_date':None,'gender':None,'profile_completed_at':None,'created_at':'2026-09-07T10:00:00.000Z'}
envelope={'version':1,'device_id':'40000000-0000-4000-8000-000000000004','tokens':{'access_token':'a'*64,'refresh_token':'b'*64,'access_expires_at':future,'session_id':'40000000-0000-4000-8000-000000000002','customer':customer},'challenge':None,'otp_request':None,'verify_intent':None,'refresh_request_id':None,'closing':None}
errors=[]; quotes=[]
with sync_playwright() as p:
 browser=p.chromium.launch();context=isolated_context(browser,viewport={'width':393,'height':852},reduced_motion='reduce')
 context.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",'+json.dumps(json.dumps(envelope))+');')
 def route(r):
  path=urlparse(r.request.url).path
  if path.startswith('/v1/customer-checkout/'):
   response=r.fetch(url=URL+path);r.fulfill(response=response)
   if path.endswith('/quotes'):
    quotes.append({'request':r.request.post_data_json,'status':response.status,'response':response.json()})
   return
  if path=='/health/live':data={'alive':True,'service':'api'}
  elif path=='/v1/capabilities':data={'schema_version':1,'environment':'staging','data_mode':'pilot','ordering_enabled':False,'features':{'phone_auth':True,'test_order_flow':True,**{k:False for k in ['payments','fiscal','checkout','loyalty']}}}
  elif path=='/v1/customers/me':data={'customer':customer}
  elif path=='/v1/auth/config':data={'enabled':True,'delivery_consent_required':True,'consent_version':'fixture-v1','terms_url':'https://example.test/terms','privacy_url':'https://example.test/privacy'}
  elif path=='/v1/content/branches/'+BRANCH:data={'schema_version':1,'branch_id':BRANCH,'promos':[],'games':[]}
  else: raise AssertionError('Unexpected external API '+path)
  r.fulfill(status=200,content_type='application/json',body=json.dumps(data))
 route_fixture(context,'https://pickchick.185.129.51.103.nip.io/**',route)
 page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(URL+'/menu');expect(page.get_by_test_id('product-burger')).to_contain_text('2 550,01',timeout=30000)
 page.get_by_test_id('product-burger').click();page.get_by_role('button',name='Увеличить: Extra sauce',exact=True).click();page.get_by_role('button',name='Увеличить: Director Burger',exact=True).click();page.get_by_test_id('product-add').click()
 page.get_by_test_id('open-cart').click();expect(page.get_by_test_id('cart-quantity-burger')).to_have_text('2');expect(page.get_by_test_id('cart-checkout')).to_contain_text('5 400,02')
 page.screenshot(path=str(OUT/'published-cart-before.png'))
 page.get_by_test_id('cart-checkout').click();page.get_by_test_id('kaspi-checkout-submit').click()
 expect(page.get_by_text('Оплата Kaspi ещё не открыта для вашего аккаунта.',exact=True)).to_be_visible(timeout=15000)
 assert quotes[0]['status']==200 and quotes[0]['response']['totalMinor']=='540002'
 page.get_by_test_id('checkout-close').click()
 # Add a second product before the next publication removes it.
 page.get_by_test_id('cart-close').click();page.get_by_test_id('product-side').click();page.get_by_test_id('product-add').click();page.get_by_test_id('open-cart').click()
 # The fixture refuses order creation; discard its deliberately unfinished command before a new checkout.
 page.evaluate('(key)=>localStorage.removeItem(key)', 'pickchick.commerce.pending.v1:'+CUSTOMER)
 page.request.post(URL+'/fixture/publish')
 # A publication updates the visible basket without navigation or reload.
 expect(page.get_by_test_id('cart-prices-updated')).to_contain_text('Цены обновились',timeout=3000)
 expect(page.get_by_test_id('cart-quantity-burger')).to_have_text('2')
 expect(page.get_by_test_id('cart-quantity-side')).to_have_text('1')
 expect(page.get_by_test_id('cart-checkout')).to_be_disabled()
 page.reload()
 expect(page.get_by_test_id('cart-quantity-side')).to_have_text('1',timeout=15000)
 page.get_by_test_id('cart-minus-side').click()
 expect(page.get_by_test_id('cart-quantity-side')).to_have_count(0)
 expect(page.get_by_test_id('cart-checkout')).to_contain_text('5 600,02')
 page.screenshot(path=str(OUT/'published-cart-updated.png'))
 page.get_by_test_id('cart-checkout').click();page.get_by_test_id('kaspi-checkout-submit').click();expect(page.get_by_text('Оплата Kaspi ещё не открыта для вашего аккаунта.',exact=True)).to_be_visible(timeout=15000)
 assert quotes[-1]['status']==200 and quotes[-1]['response']['totalMinor']=='560002';assert quotes[-1]['request']['items'][0]['selections']==[{'group_id':'side','option_id':'extra','quantity':1}]
 assert not errors,errors
 context.close();browser.close()
print(json.dumps({'browser':'passed','quotes':len(quotes),'publication_without_reload':True,'quantity_and_modifiers_retained':True,'removed_line_retained':True,'payments':0}))
