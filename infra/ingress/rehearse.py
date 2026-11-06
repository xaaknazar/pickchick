#!/usr/bin/env python3
"""Local, internal Docker network. Synthetic client -> ingress -> gateway -> echo.

Exercises real client-IP forwarding, spoof rejection, timeouts, host parity, legacy
exclusion and rollback. Never connects to VPS or banks; no public published ports.
"""
import concurrent.futures
import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

from plan import ADDRESS, HOSTS, SUBNET

HERE = Path(__file__).resolve().parent


def docker(*args, check=True):
    p = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=45)
    if check and p.returncode:
        raise RuntimeError('Local rehearsal failed: ' + args[0])
    return p.stdout.strip()


def main():
    context = json.loads(docker('context', 'inspect'))
    if not context[0]['Endpoints']['docker']['Host'].startswith('unix://'):
        raise ValueError('Local Unix Docker required')
    caddy = docker('image', 'inspect', 'caddy:2.11.4-alpine', '--format', '{{.Id}}')
    node = docker('image', 'inspect', 'node:22-bookworm-slim', '--format', '{{.Id}}')
    prefix = 'own-ingress-test-' + uuid.uuid4().hex[:8]
    net = prefix + '-net';client = prefix + '-client';echo = prefix + '-echo'
    gateway = prefix + '-gateway';old = prefix + '-old';new = prefix + '-new'
    report = {'synthetic': True, 'caddyImage': caddy, 'checks': {}}
    def request(front, host, path, method='GET', forged=False, port=80):
        headers = {'Host': host}
        if forged:headers['X-Forwarded-For'] = '203.0.113.99'
        args = {'hostname': front, 'port': port, 'path': path, 'method': method, 'headers': headers}
        program = "const t=Date.now();const q=require('node:http').request(" + json.dumps(args) + ",r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>console.log(JSON.stringify({status:r.statusCode,seconds:(Date.now()-t)/1000,hsts:r.headers['strict-transport-security']||null,location:r.headers.location||null,body:b}))) });q.on('error',()=>process.exit(1));q.setTimeout(35000,()=>process.exit(1));q.end()"
        return json.loads(docker('exec', client, 'node', '-e', program))
    def ready(front):
        for _ in range(60):
            try:
                if request(front, 'api.pickchick.kz', '/health/live')['status'] == 200:return
            except RuntimeError:pass
            time.sleep(.1)
        raise RuntimeError('Synthetic ingress not ready')
    try:
        docker('network', 'create', '--internal', '--subnet', SUBNET, net)
        with tempfile.TemporaryDirectory(prefix=prefix) as tmp:
            root = Path(tmp);root.chmod(0o755)
            sites = (HERE / 'Caddyfile').read_text()
            for host in HOSTS:
                sites = sites.replace('\n' + host + ' {', '\nhttp://' + host + ' {')
                if sites.startswith(host + ' {'):sites = 'http://' + sites
            (root / 'new.Caddyfile').write_text(sites)
            (root / 'old.Caddyfile').write_text('http://legacy.test {\n respond "legacy" 200\n}\n' + sites)
            def gateway_config(ip):
                return ('{\n auto_https off\n servers {\n trusted_proxies static ' + ip +
                        '\n trusted_proxies_strict\n }\n}\n:8080 {\n reverse_proxy ' + echo +
                        ':8080 {\n header_up X-PickChick-Client-IP {client_ip}\n }\n}\n')
            (root / 'gateway-old.Caddyfile').write_text(gateway_config('10.240.17.6'))
            (root / 'gateway-new.Caddyfile').write_text(gateway_config(ADDRESS))
            for file in root.iterdir():file.chmod(0o644)
            program = "const h=require('node:http');const f=(q,r)=>setTimeout(()=>{r.writeHead(200);r.end(JSON.stringify({client:q.headers['x-pickchick-client-ip']||null,forwarded:q.headers['x-forwarded-for']||null}))},q.url.includes('slow')?20000:0);h.createServer(f).listen(8080,'0.0.0.0');h.createServer(f).listen(4177,'0.0.0.0')"
            docker('run', '-d', '--name', echo, '--network', net, '--ip', '10.240.17.4',
                   '--network-alias', 'pickchick-staff-login', node, 'node', '-e', program)
            docker('run', '-d', '--name', client, '--network', net, '--ip', '10.240.17.5',
                   node, 'node', '-e', 'setInterval(()=>{},1000)')
            def start(name, config, ip, alias=None):
                command = ['run', '-d', '--name', name, '--network', net, '--ip', ip,
                           '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL',
                           '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges:true',
                           '--tmpfs', '/data:uid=1000,gid=1000', '--tmpfs', '/config:uid=1000,gid=1000',
                           '--tmpfs', '/tmp:uid=1000,gid=1000', '-v', str(root) + ':/etc/caddy:ro']
                if alias:command += ['--network-alias', alias]
                docker(*command, caddy, 'caddy', 'run', '--config', '/etc/caddy/' + config, '--adapter', 'caddyfile')
            start(gateway, 'gateway-old.Caddyfile', '10.240.17.3', 'pickchick-public-gateway')
            start(old, 'old.Caddyfile', '10.240.17.6');ready(old)
            before = {h:request(old, h, '/') for h in HOSTS}
            assert json.loads(request(old, 'api.pickchick.kz', '/health/live')['body'])['client'] == '10.240.17.5'
            docker('exec', gateway, 'caddy', 'reload', '--config', '/etc/caddy/gateway-new.Caddyfile', '--adapter', 'caddyfile')
            docker('stop', '--time', '2', old)
            start(new, 'new.Caddyfile', ADDRESS);ready(new)
            after = {h:request(new, h, '/') for h in HOSTS}
            # The echo exposes the proxy-hop address, which intentionally changes.
            # Public response status/headers and the resolved client must be identical.
            for h in HOSTS:
                assert all(before[h][k] == after[h][k] for k in ['status','hsts','location'])
                if before[h]['status'] == 200:
                    left,right = json.loads(before[h]['body']),json.loads(after[h]['body'])
                    assert left['client'] == right['client'] == '10.240.17.5'
                    assert left['forwarded'].split(',')[0].strip() == right['forwarded'].split(',')[0].strip() == '10.240.17.5'
            report['checks']['ownedHostParity'] = True
            # Caddy's unmatched HTTP host returns an empty 200; the legacy site
            # must not serve either its old body or the application upstream.
            assert request(new, 'legacy.test', '/')['body'] == ''
            report['checks']['legacyNotServed'] = True
            for forged in [False, True]:
                body = json.loads(request(new, 'api.pickchick.kz', '/health/live', forged=forged)['body'])
                assert body['client'] == '10.240.17.5', body
            staff = json.loads(request(new, 'pickchick.kz', '/backoffice/')['body'])
            assert staff['forwarded'] == '10.240.17.5'
            report['checks']['realClientIpGatewayAndStaff'] = True
            direct = json.loads(request(gateway, 'api.pickchick.kz', '/health/live', forged=True, port=8080)['body'])
            assert direct['client'] == '10.240.17.5'
            report['checks']['spoofedForwardedIpRejected'] = True
            assert request(new, 'api.pickchick.kz', '/v1/integrations/tiptoppay/example')['status'] == 503
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                tasks = {name: pool.submit(request, new, 'pickchick.185.129.51.103.nip.io', path, method)
                         for name,path,method in [('availability','/v1/customer-checkout/availability?slow=1','GET'),
                           ('orderWatch','/v1/test/orders/watch?slow=1','POST'),('default','/slow','GET')]}
                for name,future in tasks.items():
                    r = future.result();report['checks'][name] = {'status':r['status'],'seconds':r['seconds']}
            for name in ['availability', 'orderWatch']:
                assert report['checks'][name]['status'] == 200 and 19 <= report['checks'][name]['seconds'] < 33
            assert report['checks']['default']['status'] == 504 and 7 <= report['checks']['default']['seconds'] < 11
            started = time.monotonic()
            docker('stop', '--time', '2', new)
            docker('exec', gateway, 'caddy', 'reload', '--config', '/etc/caddy/gateway-old.Caddyfile', '--adapter', 'caddyfile')
            docker('start', old);ready(old)
            report['checks']['rollbackSeconds'] = round(time.monotonic()-started,2)
            assert report['checks']['rollbackSeconds'] < 60
            assert json.loads(request(old, 'api.pickchick.kz', '/health/live')['body'])['client'] == '10.240.17.5'
            assert request(old, 'legacy.test', '/')['status'] == 200
            print(json.dumps(report))
    finally:
        for name in [new, old, gateway, client, echo]:docker('rm', '-f', name, check=False)
        docker('network', 'rm', net, check=False)


if __name__ == '__main__':main()
