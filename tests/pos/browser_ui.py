"""End-to-end cashier source design against isolated PostgreSQL, including a real lost ACK."""
import json
import sys
import uuid
from pathlib import Path
from urllib.request import Request, urlopen
from playwright.sync_api import expect, sync_playwright

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
    context = browser.new_context(viewport={'width': 1920, 'height': 1080}, reduced_motion='reduce')
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
        pin(page, '9999')
        expect(page.get_by_text('Неверный PIN или рабочее место недоступно', exact=True).first).to_be_visible()
        pin(page, '2468')
        page.get_by_role('button', name='Открыть смену', exact=True).click()
        expect(page.get_by_text('КОМБО', exact=True)).to_be_visible()
        for width, height in ((1920,1080),(1366,768),(1280,800),(1024,768),(768,1024),(390,844)):
            page.set_viewport_size({'width':width, 'height':height})
            bounded(page.get_by_role('button',name='ПЕРЕДАТЬ НА КУХНЮ',exact=True),width,height)
            capture(page,f'order-{width}.png')
            page.get_by_role('button',name='Pick Combo').first.click()
            bounded(page.get_by_role('button',name='В заказ · 4 190 ₸',exact=True),width,height)
            capture(page,f'modifiers-{width}.png')
            page.get_by_role('button',name='✕',exact=True).last.click()
        page.set_viewport_size({'width':1920,'height':1080})
        page.get_by_role('button',name='СМЕНА',exact=True).click()
        page.get_by_role('button',name='Внести деньги',exact=True).click()
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
        page.get_by_role('button',name='На 1 час',exact=True).click()
        expect(page.get_by_text('Позиция остановлена на локальном сервере',exact=True)).to_be_visible()
        page.get_by_role('button',name='Доступность Pick Combo',exact=True).click()
        page.get_by_role('button',name='ЗАКАЗ',exact=True).click()

        page.get_by_role('button',name='Pick Combo').first.click()
        page.get_by_role('button',name='В заказ · 4 190 ₸',exact=True).click()
        page.get_by_role('button',name='✎ Комментарий для кухни',exact=True).click()
        page.get_by_role('button',name='Без лука',exact=True).click()
        page.get_by_role('button',name='Сохранить в заказ',exact=True).click()
        page.get_by_role('button',name='+ Гость: имя на табло',exact=True).click()
        for k in 'ӘЛИЯ':page.get_by_role('button',name=k,exact=True).click()
        page.get_by_role('button',name='Готово',exact=True).click()
        page.get_by_role('button',name='Отложить заказ',exact=True).click()
        page.reload()
        page.get_by_role('button',name='Отложенные (1) · вернуть',exact=True).click()
        expect(page.get_by_role('button',name='✎ Без лука',exact=True)).to_be_visible()
        page.get_by_role('button',name='НА КУХНЮ · 4 190 ₸',exact=True).click()
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
        page.get_by_role('button',name='Блокировать',exact=True).click()
        pin(page,'2468')
        page.get_by_role('button',name='СМЕНА',exact=True).click()
        page.get_by_role('button',name='Закрыть смену',exact=True).click()
        page.get_by_role('button',name='Дальше',exact=True).click()
        # Count zero against 10,000 entered earlier, requiring a touchscreen reason.
        page.get_by_role('button',name='Дальше',exact=True).click()
        expect(page.get_by_text('Причина расхождения',exact=True)).to_be_visible()
        for key in 'ТЕСТ':page.get_by_role('button',name=key,exact=True).click()
        page.get_by_role('button',name='Сохранить причину',exact=True).click()
        page.get_by_role('button',name='Дальше',exact=True).click()
        page.get_by_role('button',name='Дальше',exact=True).click()
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
print('POS v2: six viewports, local PIN/shift/cash movement, held draft, lost ACK, kitchen and named display passed; WAN blocked.')
