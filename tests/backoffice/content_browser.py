"""Content comes from real scoped BO publications over HTTP; catalog/login are local UI fixtures."""
import json,sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'mobile'))
from account_fixture import signed_in
c=json.loads(Path(sys.argv[1]).read_text());branch=c['branch'];output=Path('.local/backoffice-content');output.mkdir(parents=True,exist_ok=True)
assert urlparse(c['url']).hostname=='127.0.0.1'
assert urlparse(c['upstream']).hostname=='127.0.0.1'
with sync_playwright() as pw:
 browser=pw.chromium.launch();context=browser.new_context(viewport={'width':393,'height':852},reduced_motion='reduce');signed_in(context);errors=[];reads=[]
 def route_api(route):
  path=urlparse(route.request.url).path
  if path.startswith('/v1/content/'):
   assert route.request.method=='GET';assert 'authorization' not in route.request.headers
   response=context.request.get(c['upstream']+path+'?channel=mobile');assert response.status==200;reads.append(path);route.fulfill(response=response,headers={'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});return
  data=None
  if path=='/v1/capabilities':data={'schema_version':1,'environment':'staging','data_mode':'synthetic','ordering_enabled':False,'features':{k:False for k in ['test_order_flow','phone_auth','payments','fiscal','checkout','loyalty']}}
  elif path=='/v1/branches':data={'branches':[{'id':branch,'code':'SYN','name':'Synthetic BO point','timezone':'Asia/Almaty','ordering_enabled':False}]}
  elif path==f'/v1/branches/{branch}/menu':data={'schema_version':1,'branch_id':branch,'release_id':'10000000-0000-4000-8000-000000000008','version':1,'published_at':'2026-09-06T00:00:00Z','items':[]}
  if data is not None:route.fulfill(json=data,headers={'Access-Control-Allow-Origin':'*'})
  else:route.abort()
 context.route('**/v1/**',route_api)
 page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
 for path in ['/games/pick-man','/games/pick-blocks','/screen/M27']:
  page.goto(c['url']+path)
  try:expect(page.get_by_test_id('game-unavailable')).to_be_visible(timeout=12000)
  except Exception:
   page.screenshot(path=str(output/'failure.png'));print(json.dumps({'text':page.locator('body').inner_text(),'errors':errors,'reads':reads}));raise
  assert page.get_by_test_id('blocks-board').count()==0;assert page.get_by_test_id('game-field').count()==0
 page.goto(c['url']+'/events');expect(page.get_by_test_id('events-games')).to_be_visible(timeout=20000)
 for id in ['pick-blocks-open','pick-man-open','pickrun-open']:expect(page.get_by_test_id(id)).to_have_count(0)
 page.goto(c['url']+'/menu');hero=page.get_by_test_id('hero-promotion');expect(hero).to_have_attribute('aria-label','Акция из бэк-офиса, подробнее',timeout=20000);hero.click();expect(page.get_by_text('Опубликовано управляющим',exact=True)).to_be_visible();page.wait_for_function("document.querySelector('[data-testid=promotion-dialog]')?.getBoundingClientRect().top < 2");page.screenshot(path=str(output/'promotion-393.png'));assert reads;assert not errors,errors
 print(json.dumps({'result':'PASS','real_publication_http_reads':len(reads),'disabled_routes':3,'promotion':True,'errors':errors}))
 browser.close()
