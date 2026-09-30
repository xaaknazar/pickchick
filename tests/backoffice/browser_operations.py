"""Full navigation and durable forms against a real local database; no browser API mocks."""
import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
c=json.loads(Path(sys.argv[1]).read_text());out=Path(c['output'])
with sync_playwright() as pw:
 browser=pw.chromium.launch();page=browser.new_page(viewport={'width':1680,'height':1040});errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(c['url']);at=page.get_by_test_id
 at('credential-file').set_input_files({'name':'synthetic-manager.json','mimeType':'application/json','buffer':json.dumps(c['manager']).encode()})
 expect(at('nav-dash')).to_be_visible();expect(at('op-refresh')).to_be_visible()
 assert page.locator('.nav-item').count()==15
 for section in ['orders','items','stock','reports','finance','promo','games','guests','tickets','reviews','stations','devices','shifts','audit','dash']:
  at('nav-'+section).click();expect(page.locator('main h1')).to_be_visible();assert page.locator('.nav-item[aria-current=page]').count()==1
 at('nav-stock').click();at('op-add-ingredient').click();at('op-name').fill('Synthetic chicken');at('op-minimum').fill('100');at('op-reason').fill('Create ingredient for acceptance');at('op-save').click();expect(at('op-editor')).to_have_count(0)
 def stock(button,quantity,cost=None):
  at(button).click();at('op-reference').fill('SYN-'+quantity);at('op-stock-quantity-0').fill(quantity)
  if cost:at('op-stock-cost-0').fill(cost)
  at('op-reason').fill('Synthetic inventory acceptance');at('op-save').click();expect(page.locator('dialog')).to_have_count(0)
 stock('op-receipt','1000','3500');stock('op-waste','100');stock('op-count','800')
 at('nav-shifts').click();at('op-add-employee').click();at('op-name').fill('Synthetic employee');at('op-reason').fill('Roster acceptance');at('op-save').click();expect(at('op-editor')).to_have_count(0)
 at('op-add-shift').click();at('op-name').fill('Synthetic shift');at('op-reason').fill('Open management shift');at('op-save').click();expect(at('op-editor')).to_have_count(0)
 at('nav-tickets').click();at('op-add-ticket').click();at('op-name').fill('Synthetic complaint');at('op-description').fill('<img src=x onerror=alert(1)>');at('op-reason').fill('Synthetic guest question');at('op-save').click();expect(at('op-editor')).to_have_count(0)
 page.reload();expect(at('op-refresh')).to_be_visible();assert page.locator('img[src=x]').count()==0
 for width in [1680,1024]:
  page.set_viewport_size({'width':width,'height':1040 if width==1680 else 768})
  for section in ['dash','stock','orders','finance','tickets','devices']:
   at('nav-'+section).click();page.evaluate("async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));}");page.screenshot(path=str(out/f'{section}-{width}.png'))
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),section
 assert errors==[],errors
 print(json.dumps({'result':'PASS','sections':15,'sizes':[1680,1024],'errors':errors}))
 browser.close()
