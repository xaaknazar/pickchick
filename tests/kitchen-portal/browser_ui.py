"""Real portal/edge/PG via loopback; external DNS and WAN requests blocked."""
import http.client
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
f=json.loads(Path(sys.argv[1]).read_text())
origin='https://kitchen.example'
lost=[]
def transport(route):
    req=route.request
    if not req.url.startswith(origin+'/'):
        route.abort();return
    h={k:v for k,v in req.all_headers().items() if k not in ('host','content-length')}
    h['Host']='kitchen.example'
    conn=http.client.HTTPConnection('127.0.0.1',f['port'],timeout=15)
    conn.request(req.method,urlsplit(req.url).path+('?' + urlsplit(req.url).query if urlsplit(req.url).query else ''),body=req.post_data,headers=h)
    r=conn.getresponse();body=r.read();headers={k:v for k,v in r.getheaders() if k.lower() not in ('transfer-encoding','connection','content-length')}
    if req.method=='POST' and req.url.endswith('/actions') and not lost:
        lost.append((req.post_data,req.headers.get('idempotency-key')));route.abort('failed')
    else:route.fulfill(status=r.status,body=body,headers=headers)
    conn.close()
with sync_playwright() as p:
    browser=p.chromium.launch()
    context=browser.new_context(viewport={'width':1366,'height':768},has_touch=True)
    context.route('**/*',transport)
    pages={};errors=[]
    for mode,path in [('prep','/kitchen/prep'),('assembly','/kitchen/assembly'),('display','/display')]:
        page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)));page.goto(origin+path)
        page.locator('#staff-login').fill('kitchen.synthetic');page.locator('#staff-password').fill(f['password']);page.locator('#sign-in').click()
        expect(page.locator('#logout')).to_be_visible();expect(page.locator('#refresh')).to_be_enabled()
        if mode=='display':expect(page.get_by_test_id('display')).to_be_visible();assert page.locator('#mode-kitchen').count()==0
        else:expect(page.locator('[data-station="'+f[mode]+'"]')).to_have_attribute('aria-pressed','true')
        pages[mode]=page
    # Signing into the other modes must not revoke prep, or take its browser lease.
    prep=pages['prep'];prep.locator('#refresh').click();expect(prep.locator('#refresh')).to_be_enabled()
    ticket=prep.locator('[data-order="'+f['orderId']+'"]');ticket.locator('[data-command]').first.click()
    expect(prep.get_by_test_id('recovery')).to_be_visible();prep.reload();expect(prep.get_by_test_id('recovery')).to_be_visible()
    repeats=[];prep.on('request',lambda r:repeats.append((r.post_data,r.headers.get('idempotency-key'))) if r.url.endswith('/actions') else None)
    prep.locator('#retry').click();expect(prep.get_by_test_id('recovery')).to_have_count(0);assert repeats==lost
    for mode in ['prep','assembly']:
        page=pages[mode];page.locator('#refresh').click();expect(page.locator('#refresh')).to_be_enabled()
        ticket=page.locator('[data-order="'+f['orderId']+'"]')
        for _ in range(15):
            b=ticket.locator('[data-command]').first
            if not b.count() or b.inner_text() in ('Заказ собран','Подтвердить выдачу'):break
            expect(b).to_be_enabled();b.click();expect(page.locator('#refresh')).to_be_enabled()
        page.screenshot(path=f['output']+'/'+mode+'.png')
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    assembly=pages['assembly'];ticket=assembly.locator('[data-order="'+f['orderId']+'"]');number=ticket.locator('.number').inner_text()
    ticket.get_by_role('button',name='Заказ собран',exact=True).click();expect(ticket.get_by_role('button',name='Подтвердить выдачу')).to_be_enabled()
    board=pages['display'];board.locator('#refresh').click();expect(board.locator('.ready .numbers')).to_contain_text(number);board.screenshot(path=f['output']+'/display.png')
    ticket.get_by_role('button',name='Подтвердить выдачу').click();expect(ticket).to_have_count(0)
    board.locator('#refresh').click();expect(board.locator('#refresh')).to_be_enabled();assert number not in board.locator('.ready .numbers').inner_text()
    assert not errors,errors
    context.close();browser.close()
print('PASS three screens, scoped sessions/journals, exact replay, ready/display/handoff')
