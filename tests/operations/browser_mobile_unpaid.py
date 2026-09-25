"""Opt-in real staging flow: mobile browser -> TEST kitchen -> display -> own status.

Only creates/finishes this run's synthetic order. Staff credentials remain private.
No fixtures for API responses; local demo-account fixture only gates the current Dev UI.
"""
import json
import os
from pathlib import Path
import sys
import time
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tests/mobile'))
from account_fixture import signed_in
HOST='https://pickchick.185.129.51.103.nip.io'
API=HOST+'/v1/test'
MOBILE=os.environ.get('MOBILE_URL','http://127.0.0.1:4198')
assert urlparse(MOBILE).hostname in ('127.0.0.1','localhost')
STAFF=Path(os.environ['TEST_FLOW_STAFF_DIR'])
OUT=ROOT/'.local/mobile-unpaid-e2e';OUT.mkdir(parents=True,exist_ok=True)

def credential(role):
 files=list(STAFF.glob(role+'-*.json')) or list(STAFF.glob(role+'.json'))
 assert len(files)==1
 assert files[0].stat().st_mode&0o077==0
 data=json.loads(files[0].read_text());assert data['role']==role
 return data['token']

def main():
 with sync_playwright() as p:
  browser=p.chromium.launch()
  operator=browser.new_context(viewport={'width':1440,'height':1000})
  pages={};tokens={role:credential(role) for role in ['prep','assembly','display','manager']}
  for role in ['prep','assembly','display']:
   page=operator.new_page();pages[role]=page
   page.goto(HOST+('/test/display' if role=='display' else '/test/kitchen/'+role))
   page.get_by_label('Ключ доступа',exact=True).fill(tokens[role])
   page.get_by_role('button',name='Открыть рабочий экран',exact=True).click()
   expect(page.locator('.staff-login')).to_have_count(0)
  ctx=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,reduced_motion='reduce')
  signed_in(ctx);mobile=ctx.new_page();errors=[];traffic=[];latencies=[];
  mobile.on('request',lambda r:traffic.append((r.method,r.url.split('?')[0])))
  mobile.on('pageerror',lambda e:errors.append(str(e)))
  mobile.goto(MOBILE+'/screen/M06')
  mobile.get_by_test_id('product-pick-combo').click(timeout=60000)
  mobile.get_by_test_id('modifier-drink-lemonade').click()
  mobile.get_by_test_id('modifier-plus-extras-toast').click()
  mobile.get_by_test_id('product-add').click()
  mobile.get_by_test_id('cart-checkout').click()
  expect(mobile.get_by_test_id('test-checkout-create')).to_have_text('Отправить на кухню')
  expect(mobile.get_by_test_id('test-payment-approve')).to_have_count(0)
  mobile.screenshot(path=str(OUT/'checkout.png'),full_page=True)
  with mobile.expect_response(lambda r:r.request.method=='POST' and r.url.split('?')[0]==API+'/orders') as response:
   mobile.get_by_test_id('test-checkout-create').click()
  assert response.value.ok
  order=response.value.json();number=order['number']
  assert order['state']=='preparing' and order['payment_state']=='not_started' and order['payment_attempt_id'] is None
  assert order['fiscal_state']=='not_applicable'
  current=mobile.get_by_test_id('screen-M17')
  expect(current.get_by_test_id('connected-order-state')).to_have_text('Готовится',timeout=15000)
  mobile.reload();expect(current.get_by_test_id('connected-order-number')).to_have_text(number,timeout=60000)
  if os.environ.get('REQUIRE_ORDER_EVENTS')=='1':
   mobile.wait_for_timeout(7000)
   assert ('POST',API+'/orders/watch') in traffic, 'Mobile must subscribe to changes'
   assert sum(1 for method,url in traffic if method=='GET' and url==API+'/orders')<=3, 'No three-second snapshot polling'
  prep=pages['prep'].locator('[data-order-number="'+number+'"]')
  assembly=pages['assembly'].locator('[data-order-number="'+number+'"]')
  expect(prep).to_contain_text('Фирменный лимонад',timeout=15000)
  expect(prep).to_contain_text('Тост, 1 шт')
  expect(assembly.get_by_role('button',name='Заказ собран',exact=True)).to_be_disabled()
  with pages['prep'].expect_response(lambda r:r.request.method=='POST' and '/tasks/' in r.url):
   prep.get_by_role('button',name='Весь заказ готов',exact=True).click()
  started=time.monotonic()
  expect(current.get_by_test_id('connected-order-state')).to_have_text('На сборке',timeout=15000)
  latencies.append(time.monotonic()-started)
  with pages['assembly'].expect_response(lambda r:r.request.method=='POST' and '/tasks/' in r.url):
   assembly.get_by_role('button',name='Заказ собран',exact=True).click()
  started=time.monotonic()
  expect(current.get_by_test_id('connected-order-state')).to_have_text('Можно забирать',timeout=15000)
  latencies.append(time.monotonic()-started)
  expect(pages['display'].locator('.display-numbers').get_by_text(number,exact=True)).to_be_visible(timeout=15000)
  for width in [320,390,430]:
   mobile.set_viewport_size({'width':width,'height':844})
   expect(current.get_by_test_id('connected-order-number')).to_have_text(number)
   mobile.screenshot(path=str(OUT/f'ready-{width}.png'),full_page=True)
   assert mobile.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  pages['assembly'].screenshot(path=str(OUT/'assembly.png'),full_page=True)
  if os.environ.get('REQUIRE_ORDER_EVENTS')=='1': ctx.set_offline(True)
  assembly.get_by_role('button',name='Выдать заказ',exact=True).click()
  if os.environ.get('REQUIRE_ORDER_EVENTS')=='1':
   mobile.wait_for_timeout(500)
   ctx.set_offline(False)
  expect(current.get_by_test_id('connected-order-state')).to_have_text('Выдан',timeout=15000)
  expect(pages['display'].locator('.display-numbers').get_by_text(number,exact=True)).to_have_count(0,timeout=15000)
  result=operator.request.get(API+'/orders/'+order['order_id'],headers={'Authorization':'Bearer '+tokens['manager']}).json()
  assert result['state']=='fulfilled' and result['payment_state']=='not_started' and result['payment_attempt_id'] is None
  assert not errors
  if os.environ.get('REQUIRE_ORDER_EVENTS')=='1': assert max(latencies)<2.5, latencies
  (OUT/'result.json').write_text(json.dumps({'passed':True,'number':number,'state':result['state'],'payment_state':result['payment_state'],'fiscal_state':result['fiscal_state'],'screens':[320,390,430],'event_latency_seconds':latencies,'events_required':os.environ.get('REQUIRE_ORDER_EVENTS')=='1'},indent=2)+'\n')
  print('PASS: unpaid mobile order, whole-ticket preparation, assembly, LED, live mobile status and handoff; '+number)
  ctx.unroute_all(behavior='ignoreErrors')
  operator.unroute_all(behavior='ignoreErrors')
  browser.close()
if __name__=='__main__':main()
