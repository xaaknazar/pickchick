"""Portal with cloud stream: real renderer, fake edge/cloud via loopback; WAN blocked."""
import http.client
import json
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


def login(page):
    page.locator('#staff-login').fill('kitchen.synthetic')
    page.locator('#staff-password').fill(f['password'])
    page.locator('#sign-in').click()
    expect(page.locator('#logout')).to_be_visible()


with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={'width': 1366, 'height': 768}, has_touch=True)
    context.route('**/*', transport)
    errors = []
    prep = context.new_page()
    prep.on('pageerror', lambda e: errors.append(str(e)))
    prep.goto(origin + '/kitchen/prep')
    login(prep)
    edge = prep.locator('[data-stream="edge"]')
    cloud = prep.locator('[data-stream="cloud"]')
    expect(edge).to_have_text('Касса: на связи')
    expect(cloud).to_have_text('Сервер: на связи')
    cloud_ticket = prep.locator('[data-order="' + f['cloudOrder'] + '"]')
    edge_ticket = prep.locator('[data-order="' + f['edgeOrder'] + '"]')
    expect(cloud_ticket.locator('[data-source="cloud"]')).to_have_text('Сервер')
    expect(edge_ticket.locator('[data-source="edge"]')).to_have_text('Касса')
    expect(cloud_ticket.locator('.number')).to_have_text('301')
    assert prep.locator('.ticket').count() == 2
    assert prep.evaluate('document.documentElement.scrollWidth<=innerWidth')
    prep.screenshot(path=f['output'] + '/both-online.png')

    board = context.new_page()
    board.on('pageerror', lambda e: errors.append(str(e)))
    board.goto(origin + '/display')
    login(board)
    expect(board.get_by_test_id('display')).to_contain_text('12')
    expect(board.get_by_test_id('display')).to_contain_text('301')
    board.screenshot(path=f['output'] + '/display-merged.png')

    # Cashier switched off: cloud ticket still workable, cashier ticket kept but blocked.
    before = control('edge-down')
    refresh(prep)
    expect(edge).to_have_text('Касса: нет связи')
    expect(cloud).to_have_text('Сервер: на связи')
    expect(edge_ticket).to_have_class(__import__('re').compile('owner-offline'))
    expect(edge_ticket.locator('[data-source="edge"]')).to_have_text('Касса · нет связи')
    expect(edge_ticket.locator('[data-command]').first).to_be_disabled()
    prep.screenshot(path=f['output'] + '/cashier-offline.png')
    action = cloud_ticket.locator('[data-command]').first
    expect(action).to_be_enabled()
    action.click()
    expect(prep.locator('#refresh')).to_be_enabled()
    after = control('state')
    assert after['cloudCommands'] == before['cloudCommands'] + 1, after
    assert after['edgeActions'] == before['edgeActions'], after
    expect(prep.get_by_test_id('recovery-cloud')).to_have_count(0)
    refresh(board)
    expect(board.get_by_test_id('display')).to_contain_text('301')

    # Server unreachable, cashier back.
    control('edge-up')
    control('cloud-down')
    refresh(prep)
    expect(edge).to_have_text('Касса: на связи')
    expect(cloud).to_have_text('Сервер: нет связи')
    prep.screenshot(path=f['output'] + '/server-offline.png')

    # Both unreachable: the existing error banner, both indicators off.
    control('edge-down')
    refresh(prep)
    expect(edge).to_have_text('Касса: нет связи')
    expect(cloud).to_have_text('Сервер: нет связи')
    expect(prep.locator('aside.error')).to_be_visible()
    prep.screenshot(path=f['output'] + '/both-offline.png')
    prep.set_viewport_size({'width': 1024, 'height': 768})
    assert prep.evaluate('document.documentElement.scrollWidth<=innerWidth')
    assert not errors, errors
    context.close()
    browser.close()
print('PASS cloud+edge queue, source badges, per-stream status, owner-only command, merged display')
