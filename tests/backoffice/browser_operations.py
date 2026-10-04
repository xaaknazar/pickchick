"""Full navigation and durable forms against a real local database; no browser API mocks."""
import json,sys
from datetime import datetime, timedelta
from urllib.parse import urlparse, parse_qs
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
def stage(name):print('[backoffice operations] '+name,flush=True)
stage('launch')
c=json.loads(Path(sys.argv[1]).read_text());out=Path(c['output'])
with sync_playwright() as pw:
 browser=pw.chromium.launch();page=browser.new_page(viewport={'width':1680,'height':1040});errors=[]
 page.set_default_timeout(15000);page.set_default_navigation_timeout(15000)
 page.on('pageerror',lambda e:errors.append(str(e)))
 def report_event(kind,request,status=None):
  parsed=urlparse(request.url)
  if '/v1/admin/backoffice/branches/' in parsed.path and '/orders/' not in parsed.path:
   print('[backoffice report] '+json.dumps({'event':kind,'method':request.method,'query':parse_qs(parsed.query),'status':status,'failure':request.failure if kind=='failed' else None}),flush=True)
 page.on('request',lambda request:report_event('request',request))
 page.on('response',lambda response:report_event('response',response.request,response.status))
 page.on('requestfinished',lambda request:report_event('finished',request))
 page.on('requestfailed',lambda request:report_event('failed',request))
 page.goto(c['url']);at=page.get_by_test_id
 at('credential-file').set_input_files({'name':'synthetic-manager.json','mimeType':'application/json','buffer':json.dumps(c['manager']).encode()})
 expect(at('nav-dash')).to_be_visible();expect(at('op-refresh')).to_be_visible()
 assert page.locator('.nav-item').count()==16
 def navigate(section):
  nav=at('nav-'+section)
  if not nav.is_visible():page.locator('.nav-secondary summary').click()
  nav.click()
 def snapshot_request(request,period):
  return '/v1/admin/backoffice/branches/' in request.url and '/orders/' not in request.url and request.method=='GET' and parse_qs(urlparse(request.url).query).get('period')==[period]
 for section in ['orders','items','stoplist','stock','reports','finance','promo','games','guests','tickets','reviews','stations','devices','shifts','audit','dash']:
  stage('navigation '+section);navigate(section);expect(page.locator('main h1')).to_be_visible();assert page.locator('.nav-item[aria-current=page]').count()==1
 navigate('reports')
 stage('report periods')
 for period in ['yesterday','year']:
  stage('preset '+period)
  expect(at('op-refresh')).to_be_enabled()
  # Read the actual upstream response before handing it to Chromium. Its CDP
  # resource may disappear after the application consumes the streaming body.
  captured_preset={}
  def capture_preset(route):
   assert snapshot_request(route.request,period)
   upstream=route.fetch()
   captured_preset.update(status=upstream.status,body=upstream.json(),url=route.request.url)
   route.fulfill(response=upstream)
  route_pattern='**/v1/admin/backoffice/branches/*?period='+period
  page.route(route_pattern,capture_preset)
  try:
   with page.expect_response(lambda r:snapshot_request(r.request,period),timeout=15000) as pending:
    at('period-'+period).click()
   expect(at('op-refresh')).to_be_enabled()
   stage('preset ready '+period)
   assert pending.value.status==200 and captured_preset['status']==200
   assert parse_qs(urlparse(captured_preset['url']).query)=={'period':[period]}
   body=captured_preset['body'];assert body['period']==period
   assert body['period_start']<body['period_end']
   expect(at('period-'+period)).to_have_attribute('aria-pressed','true')
   # Enabled controls alone also occur on errors. Prove the app accepted and
   # rendered this real response, rather than hiding a failed model load.
   expect(page.locator('.content')).not_to_contain_text('Данные недоступны')
   expect(page.locator('.content .op-bars')).to_be_visible()
   expect(page.locator('.content .op-bar')).to_have_count(len(body['chart']))
   for day in body['chart']:expect(page.locator('.content progress[aria-label="'+day['day']+'"]').first).to_be_visible()
  finally:
   page.unroute(route_pattern,capture_preset)
 stage('custom report range')
 # Choosing custom dates keeps the previously applied range until explicit Apply.
 at('period-custom').click();expect(at('period-start')).to_be_visible()
 expect(at('period-year')).to_have_attribute('aria-pressed','true')
 start=(datetime.now()-timedelta(days=2)).strftime('%Y-%m-%d')
 end=datetime.now().strftime('%Y-%m-%d')
 at('period-start').fill(start);at('period-end').fill(end)
 expect(at('op-refresh')).to_be_enabled()
 with page.expect_response(lambda r:snapshot_request(r.request,'year'),timeout=15000) as pending:at('op-refresh').click()
 expect(at('op-refresh')).to_be_enabled()
 assert parse_qs(urlparse(pending.value.url).query)['period']==['year']
 expect(at('period-start')).to_have_value(start);expect(at('period-end')).to_have_value(end)
 expect(at('period-year')).to_have_attribute('aria-pressed','true')
 at('period-start').fill(end);at('period-end').fill(start);at('period-apply').click()
 assert not at('period-end').evaluate('(e)=>e.validity.valid')
 at('period-start').fill(start);at('period-end').fill(end)
 # Capture the real upstream body before fulfillment; Chromium may discard its CDP resource.
 captured_custom={}
 def delayed_custom(route):
  response=route.fetch()
  captured_custom.update(status=response.status,body=response.json(),url=route.request.url)
  expect(at('op-refresh')).to_be_disabled()
  expect(at('period-apply')).to_be_disabled()
  page.wait_for_timeout(250)
  route.fulfill(response=response)
 page.route('**/v1/admin/backoffice/branches/*?period=custom*',delayed_custom)
 expect(at('op-refresh')).to_be_enabled()
 with page.expect_response(lambda r:snapshot_request(r.request,'custom'),timeout=15000) as pending:at('period-apply').click()
 expect(at('op-refresh')).to_be_enabled()
 page.unroute('**/v1/admin/backoffice/branches/*?period=custom*',delayed_custom)
 assert pending.value.status==200 and captured_custom['status']==200
 query=parse_qs(urlparse(captured_custom['url']).query)
 assert query['period']==['custom'] and query['start_date']==[start] and query['end_date']==[end]
 body=captured_custom['body'];assert body['period']=='custom' and body['period_start']<body['period_end']
 expect(at('period-custom')).to_have_attribute('aria-pressed','true')
 expect(page.locator('.content')).not_to_contain_text('Данные недоступны')
 expect(page.locator('.content .op-bars')).to_be_visible()
 expect(page.locator('.content .op-bar')).to_have_count(len(body['chart']))
 for day in body['chart']:expect(page.locator('.content progress[aria-label="'+day['day']+'"]')).to_be_visible()
 expect(at('period-start')).to_have_value(start);expect(at('period-end')).to_have_value(end)
 expect(at('op-refresh')).to_be_enabled()
 with page.expect_response(lambda r:snapshot_request(r.request,'custom'),timeout=15000) as pending:at('op-refresh').click()
 expect(at('op-refresh')).to_be_enabled()
 assert parse_qs(urlparse(pending.value.url).query)==query
 stage('offline recovery')
 # Fail a real request and verify the previous period's report is not shown as current.
 page.context.set_offline(True);at('period-day').click()
 expect(page.locator('.content')).to_contain_text('Данные недоступны')
 assert page.locator('.content .op-bars').count()==0
 page.context.set_offline(False)
 expect(at('op-refresh')).to_be_enabled()
 with page.expect_response(lambda r:snapshot_request(r.request,'day'),timeout=15000) as pending:at('op-refresh').click()
 expect(at('op-refresh')).to_be_enabled()
 assert pending.value.status==200
 stage('source cashier shift')
 # A real source shift includes its orders before today's boundary and exposes no invented money totals.
 navigate('shifts');at('cashier-shift-'+c['shiftId']).click()
 expect(at('cashier-shift-select')).to_have_value(c['shiftId'])
 expect(at('cashier-shift-orders')).to_be_visible()
 at('cashier-shift-orders').click();expect(page.locator('.content')).to_contain_text('№42')
 page.locator('.content').get_by_role('button',name='Открыть',exact=True).click()
 expect(page.locator('dialog')).to_contain_text('Synthetic shift combo')
 page.locator('dialog').get_by_role('button',name='Закрыть',exact=True).click()
 navigate('finance');expect(page.locator('.content')).to_contain_text('Подтверждённые оплаты, возвраты и фискальные итоги этой смены пока не передаются')
 expect(at('op-refresh')).to_be_enabled()
 with page.expect_response(lambda r:snapshot_request(r.request,'day'),timeout=15000) as pending:at('period-day').click()
 expect(at('op-refresh')).to_be_enabled()
 assert pending.value.status==200;expect(at('cashier-shift-select')).to_have_value('')
 stage('stock durable forms')
 navigate('stock');at('op-add-ingredient').click();at('op-name').fill('Synthetic chicken');at('op-minimum').fill('100');at('op-reason').fill('Create ingredient for acceptance');at('op-save').click();expect(at('op-editor')).to_have_count(0)
 def stock(button,quantity,cost=None):
  at(button).click();at('op-reference').fill('SYN-'+quantity);at('op-stock-quantity-0').fill(quantity)
  if cost:at('op-stock-cost-0').fill(cost)
  at('op-reason').fill('Synthetic inventory acceptance');at('op-save').click();expect(page.locator('dialog')).to_have_count(0)
 stock('op-receipt','1000','3500');stock('op-waste','100');stock('op-count','800')
 navigate('shifts');at('op-add-employee').click();at('op-name').fill('Synthetic employee');at('op-reason').fill('Roster acceptance');at('op-save').click();expect(at('op-editor')).to_have_count(0)
 at('op-add-shift').click();at('op-name').fill('Synthetic shift');at('op-reason').fill('Open management shift');at('op-save').click();expect(at('op-editor')).to_have_count(0)
 navigate('tickets');at('op-add-ticket').click();at('op-name').fill('Synthetic complaint');at('op-description').fill('<img src=x onerror=alert(1)>');at('op-reason').fill('Synthetic guest question');at('op-save').click();expect(at('op-editor')).to_have_count(0)
 page.reload();expect(at('op-refresh')).to_be_visible();assert page.locator('img[src=x]').count()==0
 stage('screenshots')
 for width in [1680,1024,393]:
  page.set_viewport_size({'width':width,'height':1040 if width==1680 else 852 if width==393 else 768})
  for section in ['dash','orders','stoplist','finance','shifts']:
   navigate(section);page.evaluate("async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}");page.screenshot(path=str(out/f'{section}-{width}.png'))
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),section
 navigate('shifts');at('cashier-shift-'+c['shiftId']).click();expect(at('cashier-shift-orders')).to_be_visible()
 for width in [1680,393]:
  page.set_viewport_size({'width':width,'height':1040 if width==1680 else 852})
  page.screenshot(path=str(out/f'shift-detail-{width}.png'),full_page=True)
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
 assert errors==[],errors
 print(json.dumps({'result':'PASS','sections':16,'sizes':[1680,1024,393],'errors':errors}))
 stage('browser close');browser.close();stage('complete')
