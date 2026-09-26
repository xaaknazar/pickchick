"""End-to-end cashier source design against isolated PostgreSQL, including a real lost ACK."""
import json
import re
import sys
import uuid
from pathlib import Path
from urllib.request import Request, urlopen
from playwright.sync_api import expect, sync_playwright
from touch_layout import audit_touch_layout

fixture = json.loads(Path(sys.argv[1]).read_text())
url = fixture['url']
output = Path(fixture['output'])

def pin(page, digits):
    for digit in digits:
        page.get_by_role('button', name=digit, exact=True).click()

def bounded(locator, width, height):
    expect(locator).to_be_visible()
    box = locator.bounding_box()
    assert box and box['width'] >= 48 and box['height'] >= 48, box
    assert box['x'] >= 0 and box['y'] >= 0, box
    assert box['x'] + box['width'] <= width + 1 and box['y'] + box['height'] <= height + 1, box

def capture(page, name):
    page.evaluate('async () => {await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));}')
    page.screenshot(path=str(output / name))

def kitchen(path, body=None):
    c = fixture['cook']
    headers = {'Authorization': 'Bearer '+c['token'], 'X-Staff-Session-Id': c['session_id'], 'X-Terminal-Id': c['terminal_id']}
    if body is not None: headers.update({'Content-Type': 'application/json', 'Idempotency-Key': str(uuid.uuid4())})
    req = Request(fixture['edgeUrl']+'/edge/v1/fulfillment/'+path, headers=headers, data=None if body is None else json.dumps(body).encode())
    with urlopen(req) as response:
        return json.load(response)

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1920, 'height': 1080}, reduced_motion='reduce', has_touch=True)
    # WAN is unavailable throughout. The application may only use its local origin.
    external = []
    def lan_only(route):
        if route.request.url.startswith(url+'/'): route.continue_()
        else:
            external.append(route.request.url)
            route.abort()
    context.route('**/*', lan_only)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        page.goto(url)
        audit_touch_layout(page,output,"pin")
        for width, height in ((1920,1080),(1366,768),(1366,705),(1024,600),(390,844)):
            page.set_viewport_size({'width':width, 'height':height})
            for key in ('1','5','0','⌫'):
                bounded(page.locator('.pin-key').filter(has_text=re.compile('^'+re.escape(key)+'$')),width,height)
            keypad=page.locator('.pin-keypad').bounding_box()
            footer=page.locator('.pin-connection').bounding_box()
            assert footer['y'] >= keypad['y']+keypad['height'], 'PIN footer overlaps keypad'
            capture(page,f'pin-{width}-{height}.png')
        page.set_viewport_size({'width':1920, 'height':1080})
        page.evaluate("window.pinNodes = [document.querySelector('[data-screen-label=\"A Блокировка\"]'), document.querySelector('.pin-logo img'), document.querySelector('.pin-key')]")
        pin(page, '9999')
        expect(page.get_by_text('Неверный PIN или рабочее место недоступно', exact=True).first).to_be_visible()
        assert page.evaluate('window.pinNodes.every(node => node.isConnected)'), 'PIN changes recreated the screen or keypad'
        next_clock = page.evaluate("""() => {
          window.realDateNow = Date.now;
          Date.now = () => window.realDateNow() + 60000;
          return new Date(Date.now()).toLocaleTimeString('ru-RU',{timeZone:'Asia/Almaty',hour:'2-digit',minute:'2-digit'});
        }""")
        expect(page.get_by_text('Касса 1 · '+next_clock, exact=True)).to_be_visible()
        assert page.evaluate('window.pinNodes.every(node => node.isConnected)'), 'Clock update recreated PIN screen'
        page.evaluate('Date.now = window.realDateNow')
        pin(page, '2468')
        expect(page.locator('.shift-open-card')).to_be_visible()
        audit_touch_layout(page,output,'opening')
        for width,height in ((1366,768),(1366,705),(1024,600),(390,844)):
            page.set_viewport_size({'width':width,'height':height})
            card=page.locator('.shift-open-card')
            expect(card).to_be_visible()
            bounded(page.get_by_role('button',name='Открыть смену',exact=True),width,height)
            assert card.evaluate('(e)=>e.scrollHeight<=e.clientHeight+1'), 'Opening float form requires scrolling'
            assert card.bounding_box()['width'] <= 520
            for key in page.locator('.shift-open-keys [role=button]').all():
                box=key.bounding_box()
                assert box['height'] >= 44 and box['width'] >= 44
            capture(page,f'opening-cash-{width}-{height}.png')
        page.set_viewport_size({'width':1920,'height':1080})
        page.get_by_role('button', name='Открыть смену', exact=True).click()
        expect(page.get_by_text('КОМБО', exact=True)).to_be_visible()
        audit_touch_layout(page,output,'menu')
        page.get_by_role('button',name='НАПИТКИ',exact=True).tap()
        page.get_by_role('button',name='КОМБО',exact=True).tap()
        for width, height in ((1920,1080),(1366,768),(1280,800),(1024,768),(768,1024),(390,844)):
            page.set_viewport_size({'width':width, 'height':height})
            bounded(page.get_by_role('button',name='ПЕРЕДАТЬ НА КУХНЮ',exact=True),width,height)
            if width == 1366:
                bounded(page.get_by_role('button',name='Полный экран',exact=True),width,height)
                assert page.locator('.product-grid').evaluate('(e)=>getComputedStyle(e).gridTemplateColumns.split(" ").length') == 4
                assert page.locator('.product-photo').first.evaluate('(e)=>getComputedStyle(e).backgroundSize') == 'cover'
                for tile in page.locator('.product-card').all(): bounded(tile,width,height)
            capture(page,f'order-{width}.png')
            page.get_by_role('button',name='Pick Combo').first.click()
            bounded(page.get_by_role('button',name='В заказ · 4 190 ₸',exact=True),width,height)
            if width == 1366:
                choices=page.locator('.modifier-choice')
                assert choices.first.evaluate('(e)=>getComputedStyle(e.parentElement).gridTemplateColumns.split(" ").length') == 3
                assert choices.first.evaluate('(e)=>parseFloat(getComputedStyle(e).paddingLeft)') >= 10
                scroll=page.locator('.product-modal > div').nth(1)
                scroll.evaluate('(e)=>{e.scrollTop=120;window.modifierScroll=e;}')
                page.locator('.modifier-choice').first.click()
                assert page.evaluate('window.modifierScroll.isConnected'), 'Modifier tap replaced scroll surface'
            capture(page,f'modifiers-{width}.png')
            page.get_by_role('button',name='✕',exact=True).last.click()
        page.set_viewport_size({'width':1920,'height':1080})
        page.get_by_role('button',name='НА КОМПАНИЮ',exact=True).click()
        page.get_by_role('button',name='25 фингерсов').first.click()
        audit_touch_layout(page,output,'wizard-sauces','.product-modal')
        page.get_by_role('button',name='Все фирменные',exact=True).click()
        page.get_by_role('button',name='Дальше',exact=True).click()
        audit_touch_layout(page,output,'wizard-drinks','.product-modal')
        page.locator('.product-modal').get_by_role('button',name='✕',exact=True).click()
        page.get_by_role('button',name='КОМБО',exact=True).click()
        page.get_by_role('button',name='СМЕНА',exact=True).click()
        page.get_by_role('button',name='Внести деньги',exact=True).click()
        audit_touch_layout(page,output,'cash','dialog')
        dialog=page.locator('dialog')
        for k in '10000':dialog.get_by_role('button',name=k,exact=True).click()
        expect(dialog.locator('output')).to_have_text('10 000 ₸')
        dialog.get_by_role('button',name='Сохранить',exact=True).click()
        expect(dialog).to_have_count(0)
        expect(page.get_by_text('10 000 ₸',exact=True).first).to_be_visible()
        page.get_by_role('button',name='Блокировать',exact=True).click()
        pin(page,'1357')
        expect(page.get_by_text('КОМБО',exact=True)).to_be_visible()
        page.get_by_role('button',name='СТОП-ЛИСТ',exact=True).click()
        page.get_by_role('button',name='Доступность Pick Combo',exact=True).click()
        audit_touch_layout(page,output,'stop-dialog','.stop-modal')
        page.get_by_role('button',name='На 1 час',exact=True).click()
        expect(page.get_by_text('Позиция остановлена на локальном сервере',exact=True)).to_be_visible()
        page.get_by_role('button',name='Доступность Pick Combo',exact=True).click()
        page.get_by_role('button',name='ЗАКАЗ',exact=True).click()

        page.get_by_role('button',name='Pick Combo').first.click()
        audit_touch_layout(page,output,'modifier','.product-modal')
        page.get_by_role('button',name='В заказ · 4 190 ₸',exact=True).click()
        page.get_by_role('button',name='✎ Комментарий для кухни',exact=True).click()
        audit_touch_layout(page,output,'comment','.comment-modal')
        page.get_by_role('button',name='Без лука',exact=True).click()
        page.get_by_role('button',name='Сохранить в заказ',exact=True).click()
        page.get_by_role('button',name='+ Гость: имя на табло',exact=True).click()
        audit_touch_layout(page,output,'guest','.guest-modal')
        for k in 'ӘЛИЯ':page.get_by_role('button',name=k,exact=True).click()
        page.get_by_role('button',name='Готово',exact=True).click()
        expect(page.get_by_role('button',name='Отложить заказ',exact=True)).to_have_count(0)
        page.reload()
        expect(page.get_by_role('button',name='✎ Без лука',exact=True)).to_be_visible()
        page.get_by_role('button',name='НА КУХНЮ · 4 190 ₸',exact=True).click()
        audit_touch_layout(page,output,'checkout','.payment-modal')
        capture(page,'checkout-1920.png')
        creations=[]
        def lost_ack(route):
            if route.request.method!='POST':route.continue_();return
            creations.append((route.request.headers['idempotency-key'],route.request.post_data_json))
            result=route.fetch()
            assert result.status==201
            if len(creations)==1:route.abort('connectionreset')
            else:route.fulfill(response=result)
        page.route(url+'/edge/v1/orders',lost_ack)
        page.get_by_role('button',name='ПЕРЕДАТЬ БЕЗ ОПЛАТЫ',exact=True).click()
        expect(page.get_by_role('button',name='Проверить результат',exact=True)).to_be_visible()
        page.reload()
        page.get_by_role('button',name='Проверить результат',exact=True).click()
        expect(page.get_by_text('Заказ передан на кухню',exact=True)).to_be_visible()
        assert len(creations)==2 and creations[0]==creations[1]
        audit_touch_layout(page,output,'success','.success-modal')
        capture(page,'success-1920.png')
        orders=kitchen('kitchen?stationId='+fixture['prep'])['items']
        assert len(orders)==1
        order=orders[0]
        assert order['tasks'][0]['details']['description']=='Без лука'
        display=kitchen('display')['items']
        assert display==[{'number':order['displayNumber'],'name':'Әлия','state':'preparing'}],display
        def action(name, task=None):
            global order
            data={'action':name,'expectedVersion':order['version']}
            if task:data.update({'taskId':task['taskId'],'expectedTaskVersion':task['version']})
            kitchen('orders/'+order['orderId']+'/actions',data)
            order=kitchen('orders/'+order['orderId']+'?stationId='+fixture['prep'])
        for task in order['tasks']:
            action('start_task',task)
            current=next(t for t in order['tasks'] if t['taskId']==task['taskId'])
            action('complete_task',current)
        action('ready')
        assert kitchen('display')['items'][0]['state']=='ready'
        action('handoff')
        assert kitchen('display')['items']==[]
        # Close the same shared register shift with a recorded cash discrepancy.
        next_order=page.get_by_role('button',name='Следующий заказ · 8',exact=True)
        if next_order.is_visible():next_order.click()
        page.set_viewport_size({'width':1366,'height':768})
        page.get_by_role('button',name='ЗАКАЗЫ',exact=True).click()
        bounded(page.get_by_role('button',name='Открыть',exact=True).first,1366,768)
        bounded(page.get_by_role('button',name='Чек',exact=True).first,1366,768)
        audit_touch_layout(page,output,'orders')
        page.get_by_role('button',name='Открыть',exact=True).first.click()
        audit_touch_layout(page,output,'order-details','dialog')
        page.locator('dialog').get_by_role('button',name='Закрыть',exact=True).click()
        capture(page,'orders-1366.png')
        page.get_by_role('button',name='СТОП-ЛИСТ',exact=True).click()
        audit_touch_layout(page,output,'stops')
        assert page.locator('[data-screen-label="H Стоп-лист"]').evaluate('(e)=>getComputedStyle(e).animationName') == 'none'
        for toggle in page.locator('[aria-label^="Доступность"]').all():
            box=toggle.bounding_box()
            assert box['width'] >= 44 and box['height'] >= 44
        page.set_viewport_size({'width':1920,'height':1080})
        page.get_by_role('button',name='Блокировать',exact=True).click()
        pin(page,'2468')
        page.get_by_role('button',name='СМЕНА',exact=True).click()
        audit_touch_layout(page,output,'shift')
        page.get_by_role('button',name='Закрыть смену',exact=True).click()
        audit_touch_layout(page,output,'close-summary','.close-shift-modal')
        page.get_by_role('button',name='Дальше',exact=True).click()
        audit_touch_layout(page,output,'close-cash','.close-shift-modal')
        # Count zero against 10,000 entered earlier, requiring a touchscreen reason.
        page.get_by_role('button',name='Дальше',exact=True).click()
        expect(page.get_by_text('Причина расхождения',exact=True)).to_be_visible()
        audit_touch_layout(page,output,'close-reason','.comment-modal')
        for key in 'ТЕСТ':page.get_by_role('button',name=key,exact=True).click()
        page.get_by_role('button',name='Сохранить причину',exact=True).click()
        page.get_by_role('button',name='Дальше',exact=True).click()
        page.get_by_role('button',name='Дальше',exact=True).click()
        audit_touch_layout(page,output,'close-pin','.close-shift-modal')
        pin(page,'2468')
        expect(page.get_by_text('Личный PIN выдаёт управляющий. Проверка на локальном сервере.',exact=True)).to_be_visible()
        assert external==[],external
        assert errors==[],errors
    except Exception:
        page.screenshot(path=str(output/'failure.png'))
        print('RENDER_ERRORS',errors)
        print(page.locator('body').inner_text()[-1800:])
        raise
    context.close();browser.close()
print('POS v2: 16 workstation viewports plus mobile, touch targets and reachability, local PIN/shift/cash movement, restored draft, lost ACK, kitchen and named display passed; WAN blocked.')
