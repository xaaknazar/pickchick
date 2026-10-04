"""Exercise the actual pinned Caddy allowlist against a disposable local fixture."""
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CADDY = 'caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648'
NODE = os.environ.get('GATEWAY_FIXTURE_IMAGE', 'node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203')
assert re.fullmatch(r'pickchick-api:[a-f0-9]{40}|node:24\.16\.0-bookworm-slim@sha256:[a-f0-9]{64}', NODE)
def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.PIPE, timeout=120).strip()

context = json.loads(docker('context', 'inspect'))[0]
assert context['Endpoints']['docker']['Host'].startswith(('unix://', 'npipe://')), 'Local disposable Docker only'
assert not os.environ.get('DOCKER_HOST'), 'Do not override the selected local engine'
name = 'pickchick-gateway-fixture-' + uuid.uuid4().hex[:10]
containers = []
network_created = False
with tempfile.TemporaryDirectory(prefix='pickchick-gateway-') as directory:
    public = Path(directory)
    front=(ROOT/'infra/public-staging/front-site.Caddyfile').read_text().replace('pickchick.185.129.51.103.nip.io {', ':8080 {')
    (public/'front.Caddyfile').write_text(front)
    (public / 'backoffice').mkdir()
    (public / 'backoffice/index.html').write_text('<p>Isolated catalog editor fixture</p>')
    try:
        # Dedicated bridge; the only published port is ephemeral and loopback-only.
        docker('network', 'create', name)
        network_created = True
        for suffix, image, options, command in [
            ('api', NODE, ['--network-alias', 'pickchick-staging-api-1', '-v', str(ROOT / 'tests/operations/gateway-upstream.mjs') + ':/fixture.mjs:ro'], ['node', '/fixture.mjs']),
            ('gateway', CADDY, ['--network-alias', 'pickchick-public-gateway', '-p', '127.0.0.1::8080', '-v', str(ROOT / 'infra/public-staging/gateway.Caddyfile') + ':/etc/caddy/Caddyfile:ro', '-v', str(public) + ':/srv/public:ro'], ['caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']),
            ('front', CADDY, ['-p', '127.0.0.1::8080', '-v', str(public/'front.Caddyfile')+':/etc/caddy/Caddyfile:ro'], ['caddy','run','--config','/etc/caddy/Caddyfile','--adapter','caddyfile']),
        ]:
            container = name + '-' + suffix
            docker('run', '-d', '--name', container, '--network', name, *options, image, *command)
            containers.append(container)
        deadline = time.monotonic() + 10
        while True:
            state = json.loads(docker('inspect', containers[-1]))[0]
            ports = state['NetworkSettings']['Ports'].get('8080/tcp')
            if ports:
                port = ports[0]['HostPort']
                break
            if time.monotonic() >= deadline:
                raise RuntimeError('Fixture loopback port was not allocated')
            time.sleep(.2)
        origin = 'http://127.0.0.1:' + port
        def request(path, method='GET', body=None, headers=None):
            data = None if body is None else json.dumps(body).encode()
            req = urllib.request.Request(origin + path, data=data, method=method, headers={
                'Content-Type': 'application/json', **(headers or {}),
            })
            try:
                result = urllib.request.urlopen(req, timeout=35)
            except urllib.error.HTTPError as error:
                result = error
            return result.status, {key.lower(): value for key, value in result.headers.items()}, result.read()
        deadline = time.monotonic() + 20
        while True:
            try:
                assert request('/health/live')[0] == 200
                break
            except (OSError, AssertionError):
                if time.monotonic() >= deadline:
                    raise RuntimeError('Isolated gateway did not start')
                time.sleep(.2)
        branch = '40000000-0000-4000-8000-000000000001'
        path = '/v1/admin/catalog/branches/' + branch
        headers = {'Authorization': 'Bearer ' + 'a' * 64, 'Cookie': 'fixture=blocked',
                   'X-Device-Id': branch, 'Origin': 'https://untrusted.example.test'}
        status, meta, raw = request(path, headers=headers)
        body = json.loads(raw)
        assert status == 200 and body['authorization'] == headers['Authorization']
        assert body['cookie'] is None and body['device'] is None
        assert meta.get('x-pickchick-data') == 'catalog', meta
        assert not any(key.lower() == 'access-control-allow-origin' for key in meta)
        assert request(path + '/draft', 'PUT', {'padding': 'x' * (150 * 1024)}, headers)[0] == 200
        assert request(path + '/draft', 'PUT', {'padding': 'x' * (321 * 1024)}, headers)[0] == 413
        assert request(path + '/publish', 'POST', {'padding': 'x' * (17 * 1024)}, headers)[0] == 413
        assert request('/v1/test/quotes', 'POST', {'padding': 'x' * (17 * 1024)}, headers)[0] == 413
        preflight = request('/v1/test/orders/watch', 'OPTIONS', headers={**headers, 'Access-Control-Request-Method':'POST'})
        assert preflight[0] == 204
        assert preflight[1]['access-control-allow-origin'] == '*'
        # Farm preflight is limited to its two paths and exact GET/POST verbs.
        for farm_path in ['/v1/customer-farm', '/v1/customer-farm/commands']:
            for verb in ['GET', 'POST']:
                farm_preflight = request(farm_path, 'OPTIONS', headers={**headers, 'Access-Control-Request-Method': verb})
                assert farm_preflight[0] == 204, farm_preflight[:2]
                assert farm_preflight[1]['access-control-allow-origin'] == '*'
                assert farm_preflight[1]['access-control-allow-methods'] == 'GET,POST'
            for verb in ['DELETE', 'PUT', 'GETPOST']:
                assert request(farm_path, 'OPTIONS', headers={**headers, 'Access-Control-Request-Method': verb})[0] == 404
        assert request('/v1/customer-farm/unknown', 'OPTIONS', headers={**headers, 'Access-Control-Request-Method': 'POST'})[0] == 404
        started = time.monotonic()
        watched = request('/v1/test/orders/watch', 'POST', {'versions':[]}, headers)
        assert watched[0] == 200 and time.monotonic()-started >= 10
        assert json.loads(watched[2])['authorization'] == headers['Authorization']
        assert json.loads(watched[2])['cookie'] is None
        assert request('/v1/test/orders/watch', headers=headers)[0] == 404
        public_data = json.loads(request('/v1/catalog/branches/' + branch, headers=headers)[2])
        assert public_data['authorization'] is None and public_data['cookie'] is None
        for invalid, method in [(path, 'DELETE'), (path + '/credential', 'POST'),
                                ('/v1/auth/otp/request', 'POST'), ('/internal/v1/edge/sync/pull', 'POST')]:
            assert request(invalid, method, {}, headers)[0] == 404
        editor_status, editor_headers, editor_body = request('/backoffice/')
        assert editor_status == 200
        assert editor_body.decode() == '<p>Isolated catalog editor fixture</p>'
        assert editor_headers.get('x-frame-options') == 'DENY'
        assert editor_headers.get('referrer-policy') == 'no-referrer'
        assert "script-src 'self'" in editor_headers.get('content-security-policy', '')
        assert "frame-ancestors 'none'" in editor_headers.get('content-security-policy', '')
        redirected = request('/backoffice')
        assert redirected[0] in (200, 308), redirected[:2]
        if redirected[0] == 308:
            assert redirected[1].get('location') == '/backoffice/'
        print('PASS pinned gateway: scoped body caps, manager token forwarding, public token stripping, denied routes, backoffice prefix')
    finally:
        for container in reversed(containers):
            subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        if network_created:
            subprocess.run(['docker', 'network', 'rm', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
