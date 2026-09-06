"""Read-only HTTPS/public-ingress checks; creates no customer or financial data."""
import argparse
import json
import ssl
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='https://pickchick.185.129.51.103.nip.io')
    parser.add_argument('--expect-test-flow', choices=['enabled', 'disabled'], default='enabled')
    args = parser.parse_args()
    base = args.url.rstrip('/')
    context = ssl.create_default_context()
    checks = []

    def request(path, method='GET', headers=None):
        req = urllib.request.Request(base + path, method=method, headers=headers or {})
        try:
            response = urllib.request.urlopen(req, timeout=15, context=context)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read(128 * 1024)
            checks.append({'method': method, 'path': path, 'status': response.status})
            return response.status, response.headers, json.loads(raw) if raw else None

    status, headers, caps = request('/v1/capabilities')
    assert status == 200
    assert headers['X-PickChick-Data'] == 'synthetic'
    assert headers['Access-Control-Allow-Origin'] == '*'
    assert headers.get('Access-Control-Allow-Credentials') is None
    assert caps['environment'] == 'staging' and caps['data_mode'] == 'synthetic'
    assert caps['ordering_enabled'] is False
    assert all(caps['features'][name] is False for name in ['phone_auth', 'checkout', 'payments', 'fiscal', 'loyalty'])
    enabled = args.expect_test_flow == 'enabled'
    assert caps['features']['test_order_flow'] is enabled

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
        ('/v1/capabilities', 'HEAD'),
        ('/v1/test/staff', 'POST'),
        ('/v1/test/sessions', 'GET'),
        ('/v1/test/catalog', 'POST'),
        ('/v1/test/manager/orders', 'POST'),
        ('/v1/test/orders/not-a-uuid', 'GET'),
        ('/v1/test/orders/10000000-0000-4000-8000-000000000003', 'DELETE'),
    ]:
        status, headers, denied = request(path, method)
        assert status == 404 and denied['code'] == 'NOT_FOUND'
        assert headers.get('Access-Control-Allow-Origin') is None
    status, headers, catalog = request('/v1/test/catalog')
    assert status == (200 if enabled else 404)
    if enabled:
        assert catalog['synthetic'] is True and catalog['namespace'] == 'pickchick-test'
        assert len(catalog['products']) == 11
        assert headers['Access-Control-Allow-Origin'] == '*'
        for path in ['/v1/test/orders', '/v1/test/kitchen', '/v1/test/display', '/v1/test/manager/orders']:
            status, headers, denied = request(path)
            assert status == 401 and denied['code'] == 'UNAUTHORIZED'
            assert headers['Access-Control-Allow-Origin'] == '*'
            assert headers.get('Access-Control-Allow-Credentials') is None
    for path, method in [('/v1/test/catalog', 'GET'), ('/v1/test/sessions', 'POST'), ('/v1/test/orders', 'POST')]:
        status, headers, _ = request(path, 'OPTIONS', {
            'Origin': 'http://localhost:8081',
            'Access-Control-Request-Method': method,
            'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key',
        })
        assert status == 204 and headers['Access-Control-Allow-Origin'] == '*'
        assert headers['Access-Control-Allow-Methods'] == method
        assert {value.strip().lower() for value in headers['Access-Control-Allow-Headers'].split(',')} == {'authorization', 'content-type', 'idempotency-key'}
        assert headers.get('Access-Control-Allow-Credentials') is None
    for path, method in [('/v1/test/staff', 'POST'), ('/v1/test/catalog', 'POST'), ('/v1/test/orders', 'DELETE'), ('/internal/v1/edge/sync/ack', 'POST')]:
        status, headers, denied = request(path, 'OPTIONS', {
            'Origin': 'http://localhost:8081', 'Access-Control-Request-Method': method,
        })
        assert status == 404 and denied['code'] == 'NOT_FOUND'
        assert headers.get('Access-Control-Allow-Origin') is None
    print(json.dumps({'url': base, 'checks': checks, 'result': 'passed'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
