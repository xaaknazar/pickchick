"""Synthetic HTTPS journey; private tokens are never printed or placed in URLs."""
import argparse
import json
import os
import pathlib
import re
import ssl
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('Redirect refused; credentials stay on the selected origin')


def private_json(path):
    info = path.lstat()
    assert stat.S_ISREG(info.st_mode) and info.st_mode & 0o077 == 0 and info.st_size < 16384
    return json.loads(path.read_text())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='https://pickchick.185.129.51.103.nip.io')
    parser.add_argument('--staff-dir', type=pathlib.Path)
    parser.add_argument('--verify-state', type=pathlib.Path)
    args = parser.parse_args()
    base = args.url.rstrip('/')
    parsed = urllib.parse.urlsplit(base)
    assert not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
    assert parsed.path == '' and (
        parsed.scheme == 'https' and parsed.hostname == 'pickchick.185.129.51.103.nip.io'
        or parsed.scheme == 'http' and parsed.hostname in ['localhost', '127.0.0.1']
    )
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    checks = []

    def request(path, token=None, body=None, key=None, expected=(200, 201)):
        headers = {'Origin': 'http://127.0.0.1:4180'}
        if token:
            assert re.fullmatch('[a-f0-9]{64}', token)
            headers['Authorization'] = 'Bearer ' + token
        if body is not None:
            headers['Content-Type'] = 'application/json'
        if key:
            headers['Idempotency-Key'] = key
        req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            response = opener.open(req, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            checks.append({'method': req.method, 'path': path, 'status': response.status})
            assert response.status in expected, 'Unexpected status for ' + path
            assert response.headers['Access-Control-Allow-Origin'] == '*'
            assert response.headers.get('Access-Control-Allow-Credentials') is None
            data = json.loads(response.read(2 * 1024 * 1024))
            if response.status < 400 and path.startswith('/v1/test/'):
                assert data['synthetic'] is True and data['namespace'] == 'pickchick-test'
            return data

    def command(path, token, body, expected=(200, 201), key=None):
        return request('/v1/test/' + path, token, body, key or str(uuid.uuid4()), expected)

    if args.verify_state:
        saved = private_json(args.verify_state)
        assert saved['url'] == base
        for record in saved['orders']:
            order = request('/v1/test/orders/' + record['order_id'], record['token'])
            assert order['state'] == record['state']
            assert order['payment_state'] == record['payment_state']
            assert order['fiscal_state'] == 'not_applicable'
        print(json.dumps({'event': 'test_flow_restart_read_passed', 'checks': len(checks)}))
        return

    assert args.staff_dir, '--staff-dir is required for the synthetic journey'
    directory = args.staff_dir.lstat()
    assert stat.S_ISDIR(directory.st_mode) and directory.st_mode & 0o077 == 0
    staff = {}
    for path in args.staff_dir.glob('*.json'):
        credential = private_json(path)
        role = credential['role']
        assert credential['synthetic'] is True and credential['namespace'] == 'pickchick-test'
        assert role in ['prep', 'assembly', 'display', 'manager']
        if role not in staff or credential['expires_at'] > staff[role]['expires_at']:
            staff[role] = credential
    assert set(staff) == {'prep', 'assembly', 'display', 'manager'}
    tokens = {role: value['token'] for role, value in staff.items()}
    capabilities = request('/v1/capabilities')
    assert capabilities['ordering_enabled'] is False and capabilities['features']['test_order_flow'] is True
    assert all(capabilities['features'][name] is False for name in ['phone_auth', 'checkout', 'payments', 'fiscal', 'loyalty'])
    catalog = request('/v1/test/catalog')
    product = next(item for item in catalog['products'] if item['prep_required'])
    sessions = {channel: command('sessions', None, {'channel': channel}) for channel in ['mobile', 'kiosk']}
    orders = []
    for channel, session in sessions.items():
        quote = command('quotes', session['token'], {
            'catalog_version': catalog['catalog_version'], 'service_mode': 'takeaway',
            'items': [{'product_id': product['id'], 'quantity': 1}],
        })
        key = str(uuid.uuid4())
        body = {'quote_id': quote['quote_id']}
        order = command('orders', session['token'], body, key=key)
        replay = command('orders', session['token'], body, key=key)
        assert replay == order and order['snapshot']['channel'] == channel
        assert order['payment_state'] == 'not_started' and order['tasks'] == []
        orders.append(order)
    request('/v1/test/orders/' + orders[0]['order_id'], sessions['kiosk']['token'], expected=(404,))
    request('/v1/test/manager/orders', sessions['mobile']['token'], expected=(403,))
    first = orders[0]
    prefix = 'orders/' + first['order_id']
    first = command(prefix + '/simulated-payment', sessions['mobile']['token'], {'expected_version': first['version'], 'outcome': 'unknown'})
    assert first['payment_state'] == 'simulated_unknown' and first['tasks'] == []
    command(prefix + '/simulated-payment', sessions['mobile']['token'], {'expected_version': first['version'], 'outcome': 'approved'}, expected=(409,))
    command(prefix + '/cancel', sessions['mobile']['token'], {'expected_version': first['version'], 'reason': 'Synthetic smoke'}, expected=(409,))
    first = command(prefix + '/resolve-payment', tokens['manager'], {'expected_version': first['version'], 'outcome': 'approved'})
    second = command('orders/' + orders[1]['order_id'] + '/simulated-payment', sessions['kiosk']['token'], {'expected_version': orders[1]['version'], 'outcome': 'approved'})
    orders = [first, second]
    kitchen = request('/v1/test/kitchen', tokens['prep'])
    assert all(any(row['order_id'] == order['order_id'] for row in kitchen['orders']) for order in orders)
    display = request('/v1/test/display', tokens['display'])
    assert all(any(row['number'] == order['number'] for row in display['preparing']) for order in orders)
    persisted = []
    for order in orders:
        prefix = 'orders/' + order['order_id']
        assembly = next(task for task in order['tasks'] if task['station'] == 'assembly')
        command(prefix + '/tasks/' + assembly['task_id'] + '/complete', tokens['prep'], {'expected_version': order['version']}, expected=(403,))
        command(prefix + '/tasks/' + assembly['task_id'] + '/complete', tokens['assembly'], {'expected_version': order['version']}, expected=(409,))
        for task in [task for task in order['tasks'] if task['station'] == 'prep']:
            order = command(prefix + '/tasks/' + task['task_id'] + '/complete', tokens['prep'], {'expected_version': order['version']})
        order = command(prefix + '/tasks/' + assembly['task_id'] + '/complete', tokens['assembly'], {'expected_version': order['version']})
        assert order['state'] == 'ready'
        display = request('/v1/test/display', tokens['display'])
        assert any(row['number'] == order['number'] for row in display['ready'])
        order = command(prefix + '/handoff', tokens['assembly'], {'expected_version': order['version']})
        assert order['state'] == 'fulfilled' and order['fiscal_state'] == 'not_applicable'
        persisted.append({'order_id': order['order_id'], 'token': sessions[order['snapshot']['channel']]['token'], 'state': order['state'], 'payment_state': order['payment_state']})
    # Keep a protected customer read credential for the API-restart persistence check.
    state_dir = pathlib.Path(__file__).resolve().parents[2] / '.local/test-flow-smoke'
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    assert stat.S_ISDIR(state_dir.lstat().st_mode) and state_dir.lstat().st_mode & 0o077 == 0
    state_file = state_dir / (str(uuid.uuid4()) + '.json')
    with os.fdopen(os.open(state_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as file:
        json.dump({'url': base, 'orders': persisted}, file)
        file.flush()
        os.fsync(file.fileno())
    print(json.dumps({'event': 'test_flow_https_smoke_passed', 'checks': len(checks), 'orders': len(orders), 'state_file': str(state_file)}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'event': 'test_flow_https_smoke_failed', 'detail': 'Inspect the failed stage locally; credentials are omitted.'}), file=sys.stderr)
        sys.exit(1)
