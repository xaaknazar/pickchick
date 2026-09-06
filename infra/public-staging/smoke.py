"""Read-only HTTPS/public-ingress checks; creates no customer or financial data."""
import argparse
import json
import ssl
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='https://pickchick.185.129.51.103.nip.io')
    args = parser.parse_args()
    base = args.url.rstrip('/')
    context = ssl.create_default_context()
    checks = []

    def request(path, method='GET'):
        req = urllib.request.Request(base + path, method=method)
        try:
            response = urllib.request.urlopen(req, timeout=15, context=context)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read(128 * 1024)
            checks.append({'method': method, 'path': path, 'status': response.status})
            return response.status, response.headers, json.loads(raw)

    status, headers, caps = request('/v1/capabilities')
    assert status == 200
    assert headers['X-PickChick-Data'] == 'synthetic'
    assert headers['Access-Control-Allow-Origin'] == '*'
    assert headers.get('Access-Control-Allow-Credentials') is None
    assert caps['environment'] == 'staging' and caps['data_mode'] == 'synthetic'
    assert caps['ordering_enabled'] is False
    assert all(value is False for value in caps['features'].values())

    status, headers, branches = request('/v1/branches')
    assert status == 200
    assert headers['Access-Control-Allow-Origin'] == '*'
    assert len(branches['branches']) == 1
    branch = branches['branches'][0]
    assert branch['id'] == '10000000-0000-4000-8000-000000000003'
    assert branch['ordering_enabled'] is False
    status, headers, menu = request('/v1/branches/' + branch['id'] + '/menu')
    assert status == 200 and menu['branch_id'] == branch['id']
    assert headers['Access-Control-Allow-Origin'] == '*'
    assert menu['schema_version'] == 1 and len(menu['items']) >= 1
    assert all(item['currency'] == 'KZT' and item['price_minor'].isdigit() for item in menu['items'])
    status, headers, health = request('/health/live')
    assert status == 200 and health['alive'] is True
    assert headers['Access-Control-Allow-Origin'] == '*'
    for path, method in [
        ('/internal/v1/edge/sync/pull', 'GET'),
        ('/internal/v1/edge/sync/ack', 'POST'),
        ('/health/ready', 'GET'),
        ('/v1/branches', 'POST'),
        ('/v1/capabilities', 'POST'),
        ('/v1/orders', 'POST'),
        ('/v1/auth/otp', 'POST'),
        ('/v1/staff', 'GET'),
        ('/v1/branches/20000000-0000-4000-8000-000000000003/menu', 'GET'),
        ('/', 'GET'),
    ]:
        status, headers, denied = request(path, method)
        assert status == 404 and denied['code'] == 'NOT_FOUND'
        assert headers.get('Access-Control-Allow-Origin') is None
    print(json.dumps({'url': base, 'checks': checks, 'result': 'passed'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
