"""Shift controls on isolated browser fixtures; no VPS or restaurant operations."""
import json
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from browser_staff_display import Handler, BRANCH, SYNTHETIC, TOKENS

OUT=Path('.local/service-shift-ui');OUT.mkdir(parents=True,exist_ok=True)
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
url=f'http://127.0.0.1:{server.server_port}'
try:
 with sync_playwright() as p:
  browser=p.chromium.launch()
  for width,height in [(1280,720),(1920,1080)]:
   context=browser.new_context(viewport={'width':width,'height':height},reduced_motion='reduce')
   state={'shift':None,'commands':[],'drop':False,'count':0}
   def intercept(route):
    request=route.request;path=urlparse(request.url).path.removeprefix('/v1/test')
    assert request.headers.get('authorization')=='Bearer '+TOKENS['manager']
    if request.method=='GET' and path=='/manager/orders': data={**SYNTHETIC,'orders':[]}
    elif request.method=='GET' and path=='/shift': data={**SYNTHETIC,'shift':state['shift']}
    elif request.method=='POST' and path in ['/shift/open','/shift/close']:
     old=state['shift'];body=request.post_data_json
     assert body=={'previous_shift_id':old['shift_id'] if old else None,'expected_version':old['version'] if old else None}
     assert request.headers.get('idempotency-key')
     state['commands'].append(path)
     if path.endswith('/open'):
      assert old is None or old['state']=='closed'
      state['count']+=1
      state['shift']={'shift_id':f'30000000-0000-4000-8000-{state["count"]:012d}','number':str(state['count']),'state':'open','version':1,'opened_at':'2026-09-25T10:00:00.000Z','closed_at':None}
     else:
      assert old['state']=='open'
      state['shift']={**old,'state':'closed','version':2,'closed_at':'2026-09-25T11:00:00.000Z'}
     if state['drop']:
      state['drop']=False;route.abort('failed');return
     data={**SYNTHETIC,'shift':state['shift']}
    else: raise AssertionError((request.method,path))
    route.fulfill(json=data,headers={'Access-Control-Allow-Origin':'*'})
   context.route('**/v1/test/**',intercept)
   page=context.new_page();page.clock.install();page.goto(url+'/manager')
   page.get_by_label('Ключ доступа',exact=True).fill(TOKENS['manager'])
   page.get_by_role('button',name='Открыть рабочий экран',exact=True).click()
   panel=page.get_by_role('region',name='Смена ресторанной очереди')
   panel.get_by_role('button',name='Открыть смену',exact=True).click()
   expect(panel.get_by_role('heading',name='Смена открыта',exact=True)).to_be_visible()
   panel.get_by_role('button',name='Закрыть смену',exact=True).click()
   expect(panel.get_by_text('Заказы на кухне сохранятся',exact=False)).to_be_visible()
   panel.get_by_role('button',name='Продолжить смену',exact=True).click()
   assert state['commands']==['/shift/open']
   panel.get_by_role('button',name='Закрыть смену',exact=True).click()
   page.screenshot(path=str(OUT/f'confirm-{width}.png'))
   state['drop']=True
   panel.get_by_role('button',name='Подтвердить закрытие смены',exact=True).click()
   expect(panel.get_by_role('heading',name='Смена закрыта',exact=True)).to_be_visible()
   page.reload()
   expect(panel.get_by_role('heading',name='Смена закрыта',exact=True)).to_be_visible()
   assert state['commands']==['/shift/open','/shift/close']
   panel.get_by_role('button',name='Открыть смену',exact=True).click()
   expect(panel.get_by_role('heading',name='Смена открыта',exact=True)).to_be_visible()
   panel.get_by_role('button',name='Закрыть смену',exact=True).click()
   # Another manager already closed/reopened. Old confirmation must not close this new shift.
   state['shift']={**state['shift'],'shift_id':'30000000-0000-4000-8000-000000000003','number':'3'}
   page.clock.fast_forward(4000)
   expect(panel.get_by_role('button',name='Подтвердить закрытие смены',exact=True)).to_have_count(0)
   expect(panel.get_by_role('button',name='Закрыть смену',exact=True)).to_be_enabled()
   assert state['commands']==['/shift/open','/shift/close','/shift/open']
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
   page.screenshot(path=str(OUT/f'shift-{width}.png'))
   context.close()
  browser.close()
 print('PASS: 1280/1920 shift open, explicit close confirmation, lost acknowledgement, reload and stale-confirmation guard; no real orders')
finally:
 server.shutdown();server.server_close();thread.join()
