"""Orders design and live transitions against isolated HTTP fixtures; no real orders or messages."""
import copy, json, os, subprocess, uuid
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from account_fixture import signed_in
ROOT=Path(__file__).resolve().parents[2]
URL=os.environ.get('MOBILE_RECOVERY_URL','http://127.0.0.1:4197').rstrip('/')
assert urlparse(URL).hostname in ('localhost','127.0.0.1')
OUT=ROOT/'.local/orders-ui';OUT.mkdir(parents=True,exist_ok=True)
CAT=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import {testCompleteCatalog} from './packages/test-order-flow/dist/complete-catalog.js';console.log(JSON.stringify(testCompleteCatalog))"],cwd=ROOT,text=True))
META={'synthetic':True,'namespace':'pickchick-test'}
BRANCH=CAT['branch_id'];NOW='2026-09-25T12:00:00.000Z'
SESSION={**META,'session_id':str(uuid.uuid4()),'token':'a'*64,'expires_at':'2099-01-01T00:00:00.000Z','channel':'mobile'}
LINE={'id':'pick-combo','name':'Pick Combo','description':'Fixture','category':'Комбо','price_minor':'419000','image_id':'i7.jpg','prep_required':True,'quantity':1,'line_total_minor':'419000'}
QUOTE={**META,'quote_id':str(uuid.uuid4()),'branch_id':BRANCH,'catalog_version':'mockup-v0.2','channel':'mobile','service_mode':'takeaway','currency':'KZT','total_minor':'419000','lines':[LINE],'created_at':NOW,'expires_at':'2099-01-01T00:00:00.000Z'}
BASE={**META,'order_id':str(uuid.uuid4()),'number':'12','branch_id':BRANCH,'version':2,'state':'preparing','payment_state':'not_started','payment_attempt_id':None,'fiscal_state':'not_applicable','snapshot':QUOTE,'tasks':[{'task_id':str(uuid.uuid4()),'station':s,'title':s,'state':'pending','mandatory':True} for s in ['prep','assembly']],'created_at':NOW,'updated_at':NOW,'cancellation_reason':None}
errors=[]
with sync_playwright() as p:
 browser=p.chromium.launch()
 for width,height in [(320,568),(393,852),(768,1024),(852,393)]:
  ctx=browser.new_context(viewport={'width':width,'height':height},reduced_motion='reduce');signed_in(ctx)
  ctx.add_init_script('localStorage.setItem("pickchick.test.customer.v1",'+json.dumps(json.dumps(SESSION))+')')
  order=copy.deepcopy(BASE);feedback={'review':None,'tickets':[]};waiting=[];keys=[];lost=[False]
  def intercept(r):
   path=urlparse(r.request.url).path;data=None
   if path=='/v1/test/orders/watch':
    if r.request.post_data_json['versions'][0]['version']==order['version']:waiting.append(r);return
    data={**META,'orders':[order]}
   elif path=='/v1/test/orders':data={**META,'orders':[order]}
   elif path.endswith('/feedback'):
    if r.request.method=='POST':
     body=r.request.post_data_json;key=r.request.headers['idempotency-key']
     if key not in keys:
      keys.append(key)
      if body['kind']=='review':feedback['review']={'id':str(uuid.uuid4()),'stars':body['stars'],'text':body['text']}
      else:feedback['tickets'].append({'id':str(uuid.uuid4()),'text':body['text'],'status':'new'})
     if body['kind']=='ticket' and not lost[0]:lost[0]=True;r.abort();return
    data=feedback
   elif path=='/v1/test/catalog':data=CAT
   elif path=='/v1/capabilities':data={'schema_version':1,'environment':'staging','data_mode':'synthetic','ordering_enabled':False,'features':{**{k:False for k in ['phone_auth','payments','fiscal','checkout','loyalty']},'test_order_flow':True}}
   elif path=='/v1/branches':data={'branches':[{'id':BRANCH,'code':'TEST','name':'ТЦ Abay Plaza','timezone':'Asia/Almaty','ordering_enabled':False}]}
   elif path.endswith('/menu'):data={'schema_version':1,'branch_id':BRANCH,'release_id':str(uuid.uuid4()),'version':1,'published_at':NOW,'items':[]}
   elif '/content/branches/' in path:data={'schema_version':1,'branch_id':BRANCH,'promos':[],'games':[]}
   else:r.abort();return
   r.fulfill(json=data,headers={'Access-Control-Allow-Origin':'*'})
  ctx.route('**/v1/**',intercept);page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(URL+'/orders');expect(page.get_by_test_id('history-order-'+order['order_id'])).to_be_visible(timeout=20000)
  expect(page.get_by_text('Статус проверен',exact=False)).to_have_count(0)
  expect(page.get_by_test_id('launch-reveal')).to_have_count(0,timeout=10000)
  page.screenshot(path=str(OUT/f'orders-{width}.png'))
  page.get_by_test_id('history-order-'+order['order_id']).click()
  expect(page.get_by_test_id('connected-order-state')).to_have_text('Готовим для вас')
  expect(page.get_by_role('dialog',name='Статус заказа')).to_be_visible()
  sheet=page.get_by_test_id('order-sheet').bounding_box();assert sheet['y']>0 and sheet['height']<height
  expect(page.get_by_test_id('order-status-items')).to_be_visible()
  page.get_by_test_id('order-status-close').click()
  expect(page.get_by_role('dialog',name='Статус заказа')).to_have_count(0)
  page.get_by_test_id('history-order-'+order['order_id']).click()
  expect(page.get_by_test_id('order-chef-cooking')).to_be_visible()
  page.get_by_test_id('order-more').click()
  actions=page.get_by_test_id('order-actions-dialog')
  expect(actions).to_be_visible()
  expect(actions.get_by_text('Обновить статус',exact=True)).to_have_count(0)
  expect(actions.get_by_text('Отменить заказ',exact=True)).to_have_count(0)
  page.get_by_test_id('order-actions-close').click()
  expect(actions).to_have_count(0)
  def advance(state,prep,assembly):
   order['state']=state;order['version']+=1;order['tasks'][0]['state']=prep;order['tasks'][1]['state']=assembly
   page.wait_for_timeout(100)
   for route in waiting[:]:route.fulfill(json={**META,'orders':[order]});waiting.remove(route)
  advance('preparing','done','pending');expect(page.get_by_test_id('connected-order-state')).to_have_text('Собираем заказ',timeout=10000)
  expect(page.get_by_test_id('order-chef-assembly')).to_be_visible()
  page.screenshot(path=str(OUT/f'details-{width}.png'))
  advance('ready','done','done');expect(page.get_by_test_id('connected-order-state')).to_have_text('Заказ готов!')
  expect(page.get_by_test_id('order-chef-ready-takeaway')).to_be_visible()
  expect(page.get_by_test_id('order-rate')).to_have_count(0)
  expect(page.get_by_test_id('order-status-items')).to_have_count(0)
  advance('fulfilled','done','done');expect(page.get_by_test_id('connected-order-state')).to_have_text('Приятного аппетита!')
  page.get_by_test_id('order-rate').click();page.get_by_test_id('rating-5').click()
  page.get_by_test_id('feedback-text').fill('Спасибо, всё вкусно');page.get_by_test_id('feedback-submit').click()
  expect(page.get_by_text('Спасибо за отзыв',exact=True)).to_be_visible()
  page.screenshot(path=str(OUT/f'review-{width}.png'))
  page.goto(URL+'/screen/M20');page.get_by_test_id('order-support').click()
  page.get_by_test_id('feedback-text').fill('Вопрос по составу заказа');page.get_by_test_id('feedback-submit').click()
  expect(page.get_by_test_id('feedback-submit')).to_have_text('Повторить отправку')
  page.get_by_test_id('feedback-submit').click();expect(page.get_by_text('Обращение принято',exact=True)).to_be_visible()
  assert len(feedback['tickets'])==1 and len(keys)==2
  page.screenshot(path=str(OUT/f'support-{width}.png'))
  page.goto(URL+'/screen/M21');expect(page.get_by_text('По этому заказу деньги не списывались, фискальный чек не выпускался. Состав заказа ниже не является чеком.',exact=True)).to_be_visible()
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  ctx.unroute_all(behavior='ignoreErrors');ctx.close()
 browser.close()
assert not errors,errors
print('PASS orders: 4 viewports, kitchen events -> assembly -> ready -> issued, review, support retry, honest receipt')
