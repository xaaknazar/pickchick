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
OUT=ROOT/os.environ.get('COMBO_REWARDS_OUT','.local/combo-rewards-ui'); OUT.mkdir(parents=True,exist_ok=True)
CAT=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js'; console.log(JSON.stringify(testCompleteCatalog))"],cwd=ROOT,text=True))
BRANCH=CAT['branch_id']; CUSTOMER='40000000-0000-4000-8000-000000000001'
future=(datetime.now(timezone.utc)+timedelta(hours=2)).isoformat().replace('+00:00','Z')
customer={'id':CUSTOMER,'phone':'+77000000000','nickname':'UI test','birth_date':None,'gender':None,'profile_completed_at':None,'created_at':'2026-09-07T10:00:00.000Z'}
envelope={'version':1,'device_id':'40000000-0000-4000-8000-000000000004','tokens':{'access_token':'a'*64,'refresh_token':'b'*64,'access_expires_at':future,'session_id':'40000000-0000-4000-8000-000000000002','customer':customer},'challenge':None,'otp_request':None,'verify_intent':None,'refresh_request_id':None,'closing':None}
errors=[]
def center(card):
 # Element shots for the owner: keep the card clear of the floating tab bar.
 card.evaluate("e=>e.scrollIntoView({block:'center'})");return card
with sync_playwright() as p:
 browser=p.chromium.launch()
 for width,height in [(393,852),(320,568)]:
  context=isolated_context(browser,viewport={'width':width,'height':height},reduced_motion='reduce')
  context.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",'+json.dumps(json.dumps(envelope))+');')
  state={'earned':6,'writes':[]}
  def route(r):
   path=urlparse(r.request.url).path; method=r.request.method; data=None
   if method not in ('GET','OPTIONS'):

    if path.startswith('/v1/customer-checkout/'):state['writes'].append(path)
    r.abort();return
   if path=='/v1/customers/me':data={'customer':customer,'legal':{'version':'fixture-v1','terms_url':'https://example.test/terms','privacy_url':'https://example.test/privacy','accepted':True}}
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
    # Owner rule 27.10.2026: six paid combos, the seventh is a gift.
    n=state['earned'];data={'enabled':True,'programId':'40000000-0000-4000-8000-000000000010','giftProductId':'pick-combo','earnedUnits':n,'completedCycles':n//6,'currentStamps':n%6,'availableGifts':n//6,'usedGifts':0,'reservedGifts':0,'reconciliationRequired':False,'visibleStamps':6 if n==6 else n%6,'remainingToNextGift':6-n%6}
   else:r.abort();return
   r.fulfill(json=data,headers={'Access-Control-Allow-Origin':'*'})
  route_fixture(context,'**/v1/**',route)
  page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  for n in [0,1,3,6]:
   state['earned']=n;page.goto(URL+'/profile')
   card='profile-combo-reward'
   expect(page.get_by_test_id(card+'-details')).to_have_attribute('aria-label',f'Комбо-бонус. Купи 6 комбо, 7-е в подарок. Куплено комбо: {n}. Условия акции',timeout=25000)
   expect(page.get_by_test_id(card)).to_contain_text('Купи 6 комбо.')
   # Six numbered slots and the gift slot; a completed slot only gains a green check.
   for i in range(1,8):expect(page.get_by_test_id(f'{card}-stamp-{i}')).to_be_visible()
   expect(page.get_by_test_id(f'{card}-stamp-8')).to_have_count(0)
   expect(page.locator(f'[data-testid^="{card}-stamp-"][data-testid$="-check"]')).to_have_count(n)
   expect(page.get_by_test_id(f'{card}-progress')).to_contain_text('Pick Combo в подарок доступен' if n==6 else f'Ещё {6-n} комбо до подарка')
   look=page.evaluate('''card=>{const bg=i=>getComputedStyle(document.querySelector(`[data-testid="${card}-stamp-${i}"]`)).backgroundColor;
    const check=document.querySelector(`[data-testid="${card}-stamp-1-check"]`);let ink=null;
    if(check){const glyphs=[...check.querySelectorAll('*')].filter(e=>e.textContent&&!e.children.length);ink=getComputedStyle(glyphs[glyphs.length-1]).color}
    return {first:bg(1),sixth:bg(6),ink,text:document.querySelector(`[data-testid="${card}-stamp-6"]`).textContent}}''',card)
   assert look['first']==look['sixth']=='rgb(19, 43, 69)',look
   if n: assert look['ink']=='rgb(95, 211, 160)',look
   if n<6: assert look['text']=='6',look
   center(page.get_by_test_id(card)).screenshot(path=str(OUT/f'profile-card-{n}-{width}.png'))
  page.screenshot(path=str(OUT/f'profile-{width}.png'))
  page.goto(URL+'/events')
  expect(page.get_by_test_id('events-combo-reward-progress')).to_contain_text('Pick Combo в подарок доступен',timeout=25000)
  expect(page.locator('[data-testid^="events-combo-reward-stamp-"][data-testid$="-check"]')).to_have_count(6)
  center(page.get_by_test_id('events-combo-reward')).screenshot(path=str(OUT/f'events-card-6-{width}.png'))
  page.get_by_test_id('events-combo-reward-details').click()
  expect(page.get_by_test_id('combo-reward-details')).to_contain_text('Твоё седьмое комбо')
  expect(page.get_by_test_id('combo-reward-details')).to_contain_text('После шести отметок')
  page.screenshot(path=str(OUT/f'rules-{width}.png'))
  page.get_by_test_id('combo-reward-close').click()
  page.goto(URL+'/cart')
  toggle=page.get_by_test_id('cart-use-combo-gift')
  expect(toggle).to_have_attribute('aria-checked','false',timeout=25000)
  toggle.click();expect(toggle).to_have_attribute('aria-checked','true')
  expect(page.get_by_test_id('cart-pay')).to_be_enabled()
  toggle.scroll_into_view_if_needed()
  page.screenshot(path=str(OUT/f'cart-{width}.png'))
  expect(page.locator('[data-testid^="cart-combo-reward-stamp-"][data-testid$="-check"]')).to_have_count(6)
  center(page.get_by_test_id('cart-combo-reward')).screenshot(path=str(OUT/f'cart-card-6-{width}.png'))
  toggle.click();expect(toggle).to_have_attribute('aria-checked','false')
  # Kaspi build (27.10.2026): the gift-only total is paid from the cart itself.
  toggle.click();expect(page.get_by_test_id('cart-checkout')).to_have_count(0)
  expect(page.get_by_test_id('cart-pay')).to_contain_text('Заказать подарок')
  expect(page.get_by_test_id('cart-pay')).not_to_contain_text('Kaspi')
  expect(page.get_by_test_id('screen-M09').get_by_test_id('cart-total')).to_contain_text('0')
  page.screenshot(path=str(OUT/f'gift-checkout-{width}.png'))
  assert not state['writes'],state['writes']
  # A trusted refund reduces the server balance. No local stamp or gift survives a reload.
  state['earned']=5;page.goto(URL+'/profile')
  expect(page.get_by_test_id('profile-combo-reward-progress')).to_contain_text('Ещё 1 комбо до подарка')
  page.goto(URL+'/cart');expect(page.get_by_test_id('cart-use-combo-gift')).to_have_count(0)
  context.close()
 browser.close()
assert not errors,errors
print('PASS 6+1 combo card (0/1/3/6 stamps, calm checks, 7 slots), events/cart cards, rules, selectable gift, zero-total summary and refund refresh: 393x852, 320x568; no payment requests')
