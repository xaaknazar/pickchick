"""Portal with cloud screens: real renderer, fake edge/cloud via loopback; WAN blocked."""
import http.client
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

f = json.loads(Path(sys.argv[1]).read_text())
origin = 'https://kitchen.example'


def control(action):
    conn = http.client.HTTPConnection('127.0.0.1', f['control'], timeout=30)
    conn.request('POST', '/' + action)
    state = json.loads(conn.getresponse().read())
    conn.close()
    return state


def transport(route):
    req = route.request
    if not req.url.startswith(origin + '/'):
        route.abort()
        return
    h = {k: v for k, v in req.all_headers().items() if k not in ('host', 'content-length')}
    h['Host'] = 'kitchen.example'
    url = urlsplit(req.url)
    conn = http.client.HTTPConnection('127.0.0.1', f['port'], timeout=20)
    conn.request(req.method, url.path + ('?' + url.query if url.query else ''), body=req.post_data, headers=h)
    r = conn.getresponse()
    body = r.read()
    headers = {k: v for k, v in r.getheaders() if k.lower() not in ('transfer-encoding', 'connection', 'content-length')}
    route.fulfill(status=r.status, body=body, headers=headers)
    conn.close()


def refresh(page):
    page.locator('#refresh').click()
    expect(page.locator('#refresh')).to_be_enabled()


def pair(page, role):
    expect(page.get_by_test_id('cloud-pairing')).to_be_visible()
    page.locator('#cloud-code').fill(control('code/' + role)['code'])
    page.locator('#cloud-pair').click()


with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={'width': 1366, 'height': 768}, has_touch=True)
    context.route('**/*', transport)
    errors = []
    control('edge-down')

    # Cashier off, fresh browser: only a screen code, no cook login.
    prep = context.new_page()
    prep.on('pageerror', lambda e: errors.append(str(e)))
    prep.goto(origin + '/kitchen/prep')
    prep.screenshot(path=f['output'] + '/cloud-pairing.png')
    pair(prep, 'prep')
    edge = prep.locator('[data-stream="edge"]')
    cloud = prep.locator('[data-stream="cloud"]')
    expect(cloud).to_have_text('Сервер: на связи')
    expect(edge).to_have_text('Касса: нужен вход повара')
    cloud_ticket = prep.locator('[data-order="' + f['cloudOrder'] + '"]')
    expect(cloud_ticket.locator('[data-source="cloud"]')).to_have_text('Сервер')
    assert prep.locator('[data-order="' + f['edgeOrder'] + '"]').count() == 0
    assert prep.evaluate('document.cookie') == '', 'screen cookie is HttpOnly'
    prep.screenshot(path=f['output'] + '/cashier-off-screen-only.png')
    before = control('state')
    cloud_ticket.locator('[data-command]').first.click()
    expect(prep.locator('#refresh')).to_be_enabled()
    after = control('state')
    assert after['cloudCommands'] == before['cloudCommands'] + 1, after
    assert after['edgeActions'] == before['edgeActions'], after

    # Reload: still bound by the cookie, no code asked again.
    prep.reload()
    expect(cloud).to_have_text('Сервер: на связи')
    assert prep.get_by_test_id('cloud-pairing').count() == 0

    # Cashier back: a cook login adds the cashier stream and its orders.
    control('edge-up')
    prep.locator('#cook-login').click()
    prep.locator('#staff-login').fill('kitchen.synthetic')
    prep.locator('#staff-password').fill(f['password'])
    prep.locator('#sign-in').click()
    expect(prep.locator('#logout')).to_be_visible()
    expect(edge).to_have_text('Касса: на связи')
    edge_ticket = prep.locator('[data-order="' + f['edgeOrder'] + '"]')
    expect(edge_ticket.locator('[data-source="edge"]')).to_have_text('Касса')
    assert prep.evaluate('document.documentElement.scrollWidth<=innerWidth')
    prep.screenshot(path=f['output'] + '/both-online.png')

    control('cloud-down')
    refresh(prep)
    expect(cloud).to_have_text('Сервер: нет связи')
    expect(edge).to_have_text('Касса: на связи')
    prep.screenshot(path=f['output'] + '/server-offline.png')
    control('cloud-up')
    control('edge-down')
    refresh(prep)
    expect(edge).to_have_text('Касса: нет связи')
    expect(cloud).to_have_text('Сервер: на связи')
    expect(edge_ticket).to_have_class(re.compile('owner-offline'))
    prep.screenshot(path=f['output'] + '/cashier-offline.png')

    # Revoked in the back office: next poll returns the page to the code screen.
    control('revoke')
    prep.locator('#refresh').click()
    expect(prep.get_by_test_id('cloud-pairing')).to_be_visible()
    expect(prep.get_by_role('alert')).to_contain_text('Экран отключён от сервера')
    prep.screenshot(path=f['output'] + '/revoked.png')

    # Customer display bound as its own screen.
    board = context.new_page()
    board.on('pageerror', lambda e: errors.append(str(e)))
    board.goto(origin + '/display')
    pair(board, 'display')
    expect(board.get_by_test_id('display')).to_be_visible()
    board.screenshot(path=f['output'] + '/display.png')
    prep.set_viewport_size({'width': 1024, 'height': 768})
    assert prep.evaluate('document.documentElement.scrollWidth<=innerWidth')
    assert not errors, errors
    context.close()
    browser.close()
print('PASS screen code without cashier/cook, cook adds cashier, per-stream status, revoke, display')
