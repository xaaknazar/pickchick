"""Real temporary staff credentials/PG orders. The sole fault drops one real committed response."""
import json
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright
fixture = json.loads(Path(sys.argv[1]).read_text())
url, width, height = fixture['url'], fixture['width'], fixture['height']
workstation = fixture.get('mode') == 'workstation'

def activate(button):
    if workstation:
        button.tap()
    else:
        button.click()

assert urlparse(url).hostname == '127.0.0.1'
output = Path(fixture['output'])

def login(page, actor):
    if workstation:
        page.locator('#staff-login').fill('kitchen.synthetic')
        page.locator('#staff-password').fill(fixture['password'])
        page.locator('#sign-in').click()
        expect(page.locator('#logout')).to_be_visible()
        expect(page.locator('#refresh')).to_be_enabled()
        return
    page.locator('details.login-service').evaluate('(node) => node.open = true')
    page.locator('#credential').set_input_files({'name':'synthetic-staff.json','mimeType':'application/json','buffer':json.dumps(actor).encode()})
    expect(page.locator('#logout')).to_be_visible()
    expect(page.locator('#refresh')).to_be_enabled()

def capture(page, name):
    page.evaluate('async () => { await document.fonts.ready; await Promise.all([...document.images].map(i=>i.decode())); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); }')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow'
    filename = f'{width}-'+('workstation-' if workstation else '')+f'{name}.png'
    page.screenshot(path=str(output / filename))

with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={'width':width,'height':height}, has_touch=workstation)
    context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(url+'/') else route.abort())
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(url)
    if workstation:
        capture(page, 'password-login')
        page.locator('#staff-login').fill('kitchen.synthetic')
        page.locator('#staff-password').fill('Synthetic wrong password')
        page.locator('#password-toggle').click()
        expect(page.locator('#staff-password')).to_have_attribute('type', 'text')
        page.locator('#staff-password').press('Enter')
        expect(page.get_by_role('alert')).to_contain_text('Не удалось войти')
        expect(page.locator('#staff-password')).to_have_value('')
    login(page, fixture['cook'])
    if fixture.get('mode') == 'injection':
        expect(page.locator('h1')).to_contain_text('</h1><button id="acknowledge">Подмена</button><h1>')
        assert page.locator('#acknowledge').count()==0, 'Stored station text must never become actionable HTML'
        expect(page.get_by_text('Очередь пуста',exact=True)).to_be_visible()
        assert page.locator('[data-command]').count()==0
        capture(page, 'empty-stored-text')
        assert not errors, errors
        context.close()
        browser.close()
        print('PASS stored station text escaping and empty queue, no mutations')
        sys.exit(0)
    ticket = page.locator('[data-order="'+fixture['orderId']+'"]')
    expect(ticket).to_be_visible()
    expect(page.locator('[data-station]')).to_have_count(2 if workstation else 1)
    prep = page.locator('[data-station="'+fixture['prep']+'"]')
    if workstation:
        assert fixture['cook']['role'] == 'kitchen', 'Switching must not require elevated role'
        assembly = page.locator('[data-station="'+fixture['assembly']+'"]')
        for station in [prep, assembly]:
            bounds = station.bounding_box()
            assert bounds['height'] >= 72 and bounds['width'] >= 200, 'Stations must have large touch targets'
        expect(page.locator('[data-station]').first).to_have_attribute('data-station', fixture['prep'])
        activate(prep)
        expect(prep).to_have_attribute('aria-pressed', 'true')
        expect(assembly).to_have_attribute('aria-pressed', 'false')
    capture(page, 'prep')
    first_command = []
    def lose_response(route):
        first_command.append((route.request.post_data, route.request.headers.get('idempotency-key')))
        route.fetch()  # Real successful LAN transaction; only the response is lost.
        route.abort('failed')
        page.unroute('**/edge/v1/fulfillment/orders/*/actions', lose_response)
    page.route('**/edge/v1/fulfillment/orders/*/actions', lose_response)
    activate(ticket.locator('[data-command]').first)
    expect(page.get_by_test_id('recovery')).to_be_visible()
    expect(page.locator('#retry')).to_be_enabled()
    for station in page.locator('[data-station]').all():
        expect(station).to_be_disabled()
    expect(page.locator('#mode-display')).to_be_disabled()
    if workstation:
        # Dispatching a click even on a disabled DOM control cannot bypass model recovery.
        assembly.dispatch_event('click')
        expect(prep).to_have_attribute('aria-pressed', 'true')
        expect(assembly).to_have_attribute('aria-pressed', 'false')
    capture(page, 'recovery')
    page.reload()
    expect(page.get_by_test_id('recovery')).to_be_visible()
    retried = []
    page.on('request', lambda req: retried.append((req.post_data, req.headers.get('idempotency-key'))) if req.method=='POST' else None)
    activate(page.locator('#retry'))
    expect(page.get_by_test_id('recovery')).to_have_count(0)
    assert retried == first_command, 'Exact body and idempotency key must survive reload'
    ticket = page.locator('[data-order="'+fixture['orderId']+'"]')
    for _ in range(10):
        buttons = ticket.locator('[data-command]')
        if buttons.count() == 0: break
        button = buttons.first
        expect(button).to_be_enabled()
        activate(button)
        expect(page.locator('#refresh')).to_be_enabled()
    assert ticket.locator('[data-command]').count()==0
    if workstation:
        activate(assembly)
        expect(assembly).to_have_attribute('aria-pressed', 'true')
        expect(prep).to_have_attribute('aria-pressed', 'false')
    else:
        page.locator('#logout').click()
        login(page, fixture['packer'])
    ticket = page.locator('[data-order="'+fixture['orderId']+'"]')
    expect(ticket).to_be_visible()
    capture(page, 'assembly')
    # Complete own assembly items; preparation components remain visible as context.
    for _ in range(10):
        button = ticket.locator('[data-command]').first
        if button.count()==0 or button.inner_text()=='Заказ собран': break
        expect(button).to_be_enabled()
        activate(button)
        expect(page.locator('#refresh')).to_be_enabled()
    ready = ticket.get_by_role('button',name='Заказ собран',exact=True)
    expect(ready).to_be_enabled()
    activate(ready)
    expect(ticket.get_by_role('button',name='Подтвердить выдачу')).to_be_enabled()
    number = ticket.locator('.number').inner_text()
    activate(page.locator('#mode-display'))
    expect(page.get_by_test_id('display')).to_be_visible()
    expect(page.locator('.ready .numbers')).to_contain_text(number)
    assert page.locator('[data-order]').count()==0
    assert 'Synthetic' not in page.get_by_test_id('display').inner_text()
    capture(page, 'display')
    activate(page.locator('#mode-kitchen'))
    ticket = page.locator('[data-order="'+fixture['orderId']+'"]')
    activate(ticket.get_by_role('button',name='Подтвердить выдачу'))
    expect(ticket).to_have_count(0)
    # A transport outage leaves stale data explicit and does not invent success.
    count = page.locator('[data-order]').count()
    page.route('**/edge/v1/fulfillment/kitchen?*', lambda route: route.abort('failed'))
    page.locator('#refresh').click()
    expect(page.get_by_role('alert')).to_contain_text('Нет ответа локального узла')
    assert page.locator('[data-order]').count() == count
    capture(page, 'offline')
    page.unroute('**/edge/v1/fulfillment/kitchen?*')
    page.locator('#logout').click()
    expect(page.locator('#staff-login')).to_be_visible()
    page.locator('details.login-service').evaluate('(node) => node.open = true')
    bad = {**fixture['cook'], 'token':'0'*64}
    page.locator('#credential').set_input_files({'name':'invalid-synthetic.json','mimeType':'application/json','buffer':json.dumps(bad).encode()})
    expect(page.get_by_role('alert')).to_be_visible()
    assert page.locator('[data-order]').count() == 0
    assert page.locator('#logout').count() == 0
    assert not errors, errors
    context.close()
    browser.close()
print(f'PASS real LAN kitchen {width}x{height}; exact retry, prep/assembly, LED, handoff')
