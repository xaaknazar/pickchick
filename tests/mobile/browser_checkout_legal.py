"""Prior pilot customer: explicit current consent before financial commands, bank-free fixtures."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from browser_network import route_fixture
from browser_checkout_traps import context, fresh_state, open_checkout, refusal, customer, fulfill, release, errors
OUT=Path('.local/checkout-legal');OUT.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
    browser=p.chromium.launch()
    for width,height in [(320,568),(393,852)]:
      state=fresh_state(); consent={'accepted':False,'patches':0,'fail':True}
      def handler(route,path,method,body):
        if path=='/v1/customer-checkout/orders' and method=='GET':return fulfill(route,{'orders':[]})
        if path=='/v1/customer-checkout/quotes':refusal(route,403,'FORBIDDEN');return True
        return False
      ctx,page=context(browser,state,handler,width=width,height=height)
      def me(route):
        if route.request.method=='PATCH':
          assert route.request.post_data_json=={'legal_consents':{'terms_version':'fixture-v2','privacy_version':'fixture-v2','accepted':True}}
          consent['patches']+=1
          if consent['fail']:
            consent['fail']=False;refusal(route,503,'SERVICE_UNAVAILABLE');return
          consent['accepted']=True
        route.fulfill(json={'customer':customer,'legal':{'version':'fixture-v2','accepted':consent['accepted'],'terms_url':'https://example.test/terms','privacy_url':'https://example.test/privacy'}},headers={'Access-Control-Allow-Origin':'*'})
      route_fixture(ctx,'**/v1/customers/me',me)
      button=open_checkout(page);button.click()
      accept=page.get_by_test_id('checkout-legal-accept')
      expect(accept).to_be_visible()
      assert state['quotes']==state['creates']==state['payments']==consent['patches']==0
      page.get_by_test_id('checkout-legal-close').click()
      expect(accept).to_have_count(0)
      assert not consent['accepted']
      button.click();expect(accept).to_be_visible();accept.click()
      expect(page.get_by_text('Не удалось сохранить согласие. Попробуйте ещё раз.',exact=True)).to_be_visible()
      assert state['quotes']==state['creates']==state['payments']==0
      page.screenshot(path=str(OUT/f'consent-{width}.png'))
      accept.click()
      expect(accept).to_have_count(0)
      expect(page.get_by_text('Оплата Kaspi ещё не открыта для вашего аккаунта.',exact=True)).to_be_visible()
      assert consent['accepted'] and consent['patches']==2 and state['quotes']==1
      assert state['creates']==state['payments']==0
      assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
      release(state);ctx.close()
    browser.close()
assert not errors,errors
print('PASS checkout consent: 320/393, explicit acceptance, cancel, failed save, retry; no order or invoice')
