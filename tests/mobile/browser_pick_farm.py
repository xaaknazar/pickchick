"""Farm UI with isolated synthetic HTTP fixtures. Never contacts a real account or provider."""
import json, os, subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[2]
URL=os.environ.get('FARM_UI_URL','http://127.0.0.1:4188').rstrip('/')
assert urlparse(URL).hostname in ('127.0.0.1','localhost')
OUT=ROOT/'.local/farm-ui'; OUT.mkdir(parents=True,exist_ok=True)
now=1770000000000
initial=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import {createFarm,applyFarmCommand} from './packages/farm-game/dist/index.js'; let s=createFarm(1770000000000); const crops=['carrot','tomato','strawberry','sunflower','tulip','apple']; for(let i=0;i<6;i++) s=applyFarmCommand(s,{type:'plant',plotId:i,cropId:crops[i]},1770000000000); console.log(JSON.stringify(s))"],cwd=ROOT,text=True))
customer={'id':'40000000-0000-4000-8000-000000000001','phone':'+77000000000','nickname':'Farm test','birth_date':None,'gender':None,'profile_completed_at':None,'created_at':'2026-09-07T10:00:00.000Z'}
future=(datetime.now(timezone.utc)+timedelta(hours=2)).isoformat()
envelope={'version':1,'device_id':'40000000-0000-4000-8000-000000000004','tokens':{'access_token':'a'*64,'refresh_token':'b'*64,'access_expires_at':future,'session_id':'40000000-0000-4000-8000-000000000002','customer':customer},'challenge':None,'otp_request':None,'verify_intent':None,'refresh_request_id':None,'closing':None}
with sync_playwright() as p:
 browser=p.chromium.launch()
 for width,height in [(852,393),(667,375),(1024,768)]:
  context=browser.new_context(viewport={'width':width,'height':height},reduced_motion='reduce')
  context.add_init_script('sessionStorage.setItem("pickchick.customer.session.v1",'+json.dumps(json.dumps(envelope))+');')
  state=json.loads(json.dumps(initial)); calls=[]; errors=[]
  def route(r):
   path=urlparse(r.request.url).path
   if urlparse(r.request.url).hostname in ('localhost','127.0.0.1'): r.continue_();return
   if path=='/v1/customers/me': data={'customer':customer}
   elif path=='/v1/auth/config': data={'enabled':True,'delivery_consent_required':True,'consent_version':'fixture','channels':['telegram'],'channel_selection':'automatic','whatsapp_fallback_enabled':False,'terms_url':'https://example.test/terms','privacy_url':'https://example.test/privacy'}
   elif path.startswith('/v1/customer-farm'):
    assert r.request.headers.get('authorization')=='Bearer '+'a'*64
    if r.request.method=='POST':
     body=r.request.post_data_json;calls.append(body)
     command=body['command']; assert body['expectedRevision']==state['revision']
     state['revision']+=1
     if command['type']=='harvest':
      plot=state['plots'][command['plotId']]; state['inventory'][plot['cropId']]+=3
      plot.update(cropId=None,plantedAt=None,harvests=0)
     elif command['type']=='sell':state['inventory'][command['cropId']]-=command['quantity'];state['coins']+=9
     elif command['type']=='plant':state['plots'][command['plotId']].update(cropId=command['cropId'],plantedAt=now+200000,harvests=0);state['coins']-=4
    data={'state':state,'serverNow':now+200000}
   else:r.abort();return
   r.fulfill(json=data,headers={'Access-Control-Allow-Origin':'*'})
  context.route('**/*',route)
  page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
  page.goto(URL+'/games/pick-farm')
  try: expect(page.get_by_test_id('pick-farm-screen')).to_be_visible(timeout=8000)
  except Exception:
   print(page.locator('body').inner_text());print(errors);page.screenshot(path=str(OUT/'failure.png'));raise
  expect(page.get_by_test_id('launch-reveal')).to_have_count(0)
  page.wait_for_function('Array.from(document.images).every(i => i.complete)')
  page.screenshot(path=str(OUT/f'farm-{width}.png'))
  page.get_by_role('button',name='Склад',exact=False).click()
  expect(page.get_by_test_id('pick-farm-panel-storage')).to_be_visible()
  page.wait_for_function('Array.from(document.images).every(i => i.complete)')
  expect(page.get_by_test_id('pick-farm-panel-storage').locator('img').first).to_be_attached()
  page.screenshot(path=str(OUT/f'storage-{width}.png'))
  page.get_by_role('button',name='Закрыть',exact=False).click()
  # Last empty plot has no foreground neighbour and remains reachable at all sizes.
  page.get_by_test_id('pick-farm-plot-0').click()
  expect(page.get_by_test_id('pick-farm-panel-plot').get_by_text('Морковь',exact=True)).to_be_visible()
  page.get_by_test_id('pick-farm-harvest').click()
  expect(page.get_by_test_id('pick-farm-seed-carrot')).to_be_visible()
  page.get_by_role('button',name='Закрыть панель').click()
  page.get_by_test_id('pick-farm-plot-11').click()
  page.get_by_test_id('pick-farm-seed-carrot').click()
  assert calls[-1]['command']['type']=='plant'
  expect(page.get_by_test_id('pick-farm-harvest')).to_be_disabled()
  page.get_by_role('button',name='Закрыть панель').click()
  page.get_by_role('button',name='Заказы',exact=False).click()
  expect(page.get_by_test_id('pick-farm-panel-orders').locator('img').first).to_be_attached()
  page.wait_for_function('Array.from(document.images).every(i => i.complete)')
  page.screenshot(path=str(OUT/f'orders-{width}.png'))
  assert not errors, errors
  context.close()
 browser.close()
print('Farm landscape 852/667/1024: load, storage, plant, orders passed; synthetic HTTP only.')
