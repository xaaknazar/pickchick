"""Explicit local demonstration: no live orders/bank, same basket after all stages."""
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from browser_network import isolated_context, route_fixture

URL=os.environ.get('MOBILE_REVIEW_DEMO_URL','http://127.0.0.1:4198').rstrip('/')
assert urlparse(URL).hostname in ('localhost','127.0.0.1')
OUT=Path('.local/review-demo-evidence');OUT.mkdir(parents=True,exist_ok=True)
KEY='pickchick.demonstration.order.v1'
PREF='pickchick.mobile.preferences.v1'
ORDER={'version':1,'synthetic':True,'stage':'payment','serviceMode':'takeaway',
       'lines':[{'name':'Пик Комбо','quantity':2,'totalMinor':'500000','productId':'pick-combo'}],
       'totalMinor':'500000'}

with sync_playwright() as p:
    browser=p.chromium.launch()
    for width,height in [(320,568),(393,852)]:
      for lang in ('kk','ru','en'):
        ctx=isolated_context(browser,viewport={'width':width,'height':height},reduced_motion='reduce')
        mutations=[];errors=[]
        def api(route):
          if route.request.method not in ('GET','OPTIONS'):
            mutations.append(route.request.method+' '+urlparse(route.request.url).path)
          route.abort()
        route_fixture(ctx,'**/v1/**',api)
        preferences={'version':2,'catalogMode':'design','diningMode':'takeaway','locale':lang,
          'nickname':'','branchId':None,'releaseId':'mockup-v0.3','lines':[{'id':'toast','quantity':2}]}
        page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(URL)
        page.evaluate('([a,b,c,d])=>{localStorage.setItem(a,JSON.stringify(b));localStorage.setItem(c,JSON.stringify(d));}',[KEY,ORDER,PREF,preferences])
        page.goto(URL+'/demo-order')
        expect(page.get_by_test_id('demo-approve')).to_be_visible()
        before=page.evaluate('(key)=>JSON.parse(localStorage.getItem(key)).lines',PREF)
        page.get_by_test_id('demo-decline').click()
        expect(page.get_by_test_id('demo-retry')).to_be_visible()
        page.reload()
        expect(page.get_by_test_id('demo-retry')).to_be_visible()
        page.get_by_test_id('demo-retry').click()
        expect(page.get_by_test_id('launch-reveal')).to_have_count(0,timeout=20000)
        page.screenshot(path=str(OUT/f'payment-{lang}-{width}.png'))
        page.get_by_test_id('demo-approve').click()
        expect(page.get_by_test_id('connected-order-number')).to_contain_text('DEMO-1')
        expect(page.get_by_test_id('demo-ready')).to_be_visible()
        page.reload()
        expect(page.get_by_test_id('demo-ready')).to_be_visible()
        expect(page.get_by_test_id('launch-reveal')).to_have_count(0,timeout=20000)
        page.screenshot(path=str(OUT/f'preparing-{lang}-{width}.png'))
        page.get_by_test_id('demo-ready').click()
        page.get_by_test_id('demo-collect').click()
        expect(page.get_by_test_id('demo-reset')).to_be_visible()
        assert page.evaluate('(key)=>JSON.parse(localStorage.getItem(key)).stage',KEY)=='fulfilled'
        assert page.evaluate('(key)=>JSON.parse(localStorage.getItem(key)).lines',PREF)==before
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        page.get_by_test_id('demo-reset').click()
        expect(page.get_by_test_id('demo-start')).to_be_visible()
        # Create a new isolated snapshot from the real local basket, not the seed above.
        expect(page.get_by_test_id('demo-start')).to_be_enabled()
        page.get_by_test_id('demo-start').click()
        expect(page.get_by_test_id('demo-approve')).to_be_visible()
        assert page.evaluate('(key)=>JSON.parse(localStorage.getItem(key)).lines',PREF)==before
        assert not mutations,mutations
        assert not errors,errors
        ctx.close()
    browser.close()
print('Review demo: 320/393, kk/ru/en, decline/retry/success/ready/collection/reload/reset/basket preservation; no API mutations')
