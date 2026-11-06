import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
c=json.loads(Path(sys.argv[1]).read_text())
with sync_playwright() as pw:
 browser=pw.chromium.launch(); page=browser.new_page(viewport={'width':1280,'height':800});page.set_default_timeout(15000)
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 def login(actor):
  page.locator('details.login-service').evaluate('(n)=>n.open=true')
  page.locator('#credential').set_input_files({'name':'synthetic.json','mimeType':'application/json','buffer':json.dumps(actor).encode()})
  expect(page.locator('#logout')).to_be_visible()
 page.goto(c['url']);login(c['cook'])
 expect(page.get_by_text('Проверка после восстановления',exact=True)).to_be_visible()
 expect(page.get_by_role('button',name='Проверить заказ',exact=True)).to_have_count(0)
 expect(page.locator('[data-command]')).to_have_count(0)
 page.locator('#logout').click();login(c['manager'])
 button=page.get_by_role('button',name='Проверить заказ',exact=True);expect(button).to_be_enabled();button.click()
 for width,height in [(1280,800),(768,1024)]:
  page.set_viewport_size({'width':width,'height':height})
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  page.screenshot(path=c['output']+'/kitchen-review-'+str(width)+'.png')
 sent=[]
 def intercept(route):
  sent.append(route.request.post_data_json)
  if len(sent)==1:route.fulfill(status=503,json={'code':'temporary'})
  elif len(sent)==2:
   response=route.fetch();assert response.status==200;route.abort()
  else:route.fulfill(response=route.fetch())
 page.route('**/restore-review',intercept)
 page.get_by_label('Результат сверки').select_option('retire')
 page.get_by_label('Что проверили и почему').fill('Сверили с сотрудниками: заказ уже выдан.')
 page.get_by_role('button',name='Сохранить',exact=True).click()
 expect(page.get_by_role('dialog').get_by_role('status')).to_contain_text('Сохранение не подтверждено')
 page.reload();button.click()
 expect(page.get_by_label('Что проверили и почему')).to_be_disabled()
 page.get_by_role('button',name='Повторить',exact=True).click()
 expect(page.get_by_role('dialog').get_by_role('status')).to_contain_text('Сохранение не подтверждено')
 page.get_by_role('button',name='Повторить',exact=True).click()
 expect(page.get_by_role('dialog').get_by_role('status')).to_contain_text('Заказ убран из очереди')
 assert len(sent)==3 and sent[0]==sent[1]==sent[2]
 page.get_by_role('button',name='Закрыть',exact=True).click()
 expect(page.locator('[data-order]')).to_have_count(0)
 assert not errors,errors
 browser.close()
print('real kitchen restore: role boundary, persistent exact retry, lost committed response passed')
