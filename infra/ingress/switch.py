#!/usr/bin/env python3
"""Separate-night guarded own-ingress cutover. Never stops/removes iDrink services.

Candidate preparation is server-local; keys remain on VPS. Apply requires a private
reviewed receipt, exact green CI, fresh PickChick backup, domain/heartbeat gates and
all expected route checks. Failed cutover restores gateway and the old ingress.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import ssl
import subprocess
import time
import uuid

from plan import ADDRESS, HOSTS, IMAGE, NETWORK, SUBNET, UPSTREAMS
from plan import digest, gateway, gateway_compose, require, sites, subnet_guard, tls_guard, window

HERE = Path(__file__).resolve().parent
ROOT = Path('/opt/pickchick-staging')
INGRESS = Path('/opt/pickchick-ingress')
OLD = 'deploy-caddy-1'
NEW = 'pickchick-ingress'
LOCK = ROOT / '.market-release.lock'


def run(args, timeout=40, data=None, check=True):
    p = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    if check:
        require(p.returncode == 0, 'Command failed; protected output withheld')
    return p.stdout


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def save(path, value):
    with path.open('x') as f:
        os.chmod(path, 0o600)
        json.dump(value, f, indent=2)


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def identities():
    ids = run(['docker', 'ps', '-aq']).decode().splitlines()
    return {c['Name']: {'id': c['Id'], 'image': c['Image'], 'state': c['State']['Status'],
                        'started': c['State']['StartedAt']}
            for c in json.loads(run(['docker', 'inspect', *ids]))
            if c['Name'] not in ['/' + OLD, '/' + NEW, '/pickchick-public-gateway']}


def fresh_backup(now):
    p = ROOT / 'backups/backup-status.json'
    status = json.loads(p.read_text())
    # Actual backup.sh schema is verified before any future live invocation.
    require(status.get('ok') is True, 'Successful backup required')
    stamp = status.get('lastSuccessAt')
    require(isinstance(stamp, str), 'Backup status timestamp schema differs')
    age = (now - datetime.fromisoformat(stamp.replace('Z', '+00:00'))).total_seconds()
    require(0 <= age <= 3600, 'Fresh backup within one hour required')


def source_guard(sha, proof, manifest):
    require(re.fullmatch('[a-f0-9]{40}', sha), 'Exact SHA required')
    m = json.loads(manifest.read_text())
    require(m.get('source_sha') == sha, 'Source manifest SHA differs')
    source = HERE.parents[1]
    required = ['infra/ingress/' + n for n in ['plan.py', 'switch.py', 'prepare.py', 'Caddyfile', 'compose.yaml']]
    required += ['infra/backoffice-login/release.py', 'infra/domains/release-alias.py']
    for name in required:
        require(m.get('files', {}).get(name) == digest((source / name).read_bytes()),
                'Source file hash differs')
    ci = load_module('own_ingress_ci', source / 'infra/backoffice-login/release.py')
    ci.verify_ci(json.loads(proof.read_text()), sha)


def file_guard(path, expected):
    require(path.is_file() and not path.is_symlink(), 'Regular file required')
    require(digest(path.read_bytes()) == expected, 'File CAS changed')


def http(host, path):
    require(host in HOSTS and path.startswith('/') and '\n' not in path, 'Unreviewed public URL')
    c = http.client.HTTPSConnection(host, timeout=35)
    try:
        c.sock = ssl.create_default_context().wrap_socket(
            socket.create_connection(('127.0.0.1', 443), timeout=35), server_hostname=host)
        start = time.monotonic()
        c.request('GET', path)
        r = c.getresponse()
        body = r.read()
        return {'status': r.status, 'hsts': r.getheader('Strict-Transport-Security'),
                'location': r.getheader('Location'), 'body': body, 'seconds': time.monotonic() - start}
    finally:
        c.close()


def probes(checks):
    required = {'/health/live', '/v1/auth/config', '/v1/customer-checkout/availability',
                '/backoffice/', '/kitchen/prep', '/kitchen/assembly', '/display'}
    require(required <= {p['path'].split('?')[0] for p in checks}, 'Required route evidence missing')
    require(HOSTS <= {p['host'] for p in checks}, 'Host coverage missing')
    for p in checks:
        result = http(p['host'], p['path'])
        require(all(result[k] == p[k] for k in ['status', 'hsts', 'location']), 'Route/header drift')
        if p['path'].split('?')[0] in required:
            require(p['status'] == 200, 'Required application route is not healthy')
        if p.get('body_sha256'):
            require(digest(result['body']) == p['body_sha256'], 'Response digest differs')
    config = json.loads(http('api.pickchick.kz', '/v1/auth/config')['body'])
    require(config.get('channels') == ['telegram'], 'Telegram-only config differs')
    require(config.get('terms_url') == 'https://pickchick.kz/legal/terms' and
            config.get('privacy_url') == 'https://pickchick.kz/legal/privacy', 'Domain gate not ready')
    availability = json.loads(http('api.pickchick.kz', '/v1/customer-checkout/availability')['body'])
    require(availability.get('fresh') is True, 'Cashier heartbeat is not fresh')
    signature = availability.get('signature')
    require(isinstance(signature, str) and re.fullmatch('[A-Za-z0-9_.:-]{1,256}', signature),
            'Availability signature schema differs')
    result = http('pickchick.185.129.51.103.nip.io',
                  '/v1/customer-checkout/availability?after=' + signature)
    require(result['status'] == 200 and 18 <= result['seconds'] <= 33, 'Long-poll failed')


def rollback(start_old, restore_gateway, stop_new, clock=time.monotonic):
    start = clock()
    errors = []
    # Every recovery action is attempted, even after failure of another one.
    for action in [stop_new, restore_gateway, start_old]:
        try:
            action()
        except BaseException:
            errors.append(True)
    require(not errors and clock() - start < 60, 'Rollback unverified or exceeded one minute')


def main(a):
    os.umask(0o077)
    require(ROOT.is_dir(), 'VPS-local tool only')
    require(not LOCK.exists(), 'Another server operation owns the lock')
    source_guard(a.sha, a.ci_proof, a.source_manifest)
    require(a.receipt.is_file() and not a.receipt.is_symlink() and
            a.receipt.stat().st_mode & 0o077 == 0, 'Private reviewed receipt required')
    proof = json.loads(a.receipt.read_text())
    require(proof.get('source_sha') == a.sha, 'Receipt source differs')
    folder = a.candidate.resolve()
    require(folder == INGRESS / 'releases' / a.sha, 'Immutable VPS candidate path required')
    front = Path('/opt/idrink/deploy/Caddyfile')
    file_guard(front, proof['front_sha256'])
    require((folder / 'Caddyfile').read_bytes() == sites(front.read_bytes(), proof['front_sha256']),
            'PickChick site bytes differ')
    file_guard(folder / 'compose.yaml', digest((HERE / 'compose.yaml').read_bytes()))
    old = inspect(OLD)
    require(old['Id'] == proof['old_container_id'] and old['State']['Running'], 'Old ingress drift')
    require(old['Image'] == IMAGE.split('@')[1], 'Image differs from current ingress')
    require(inspect('pickchick-public-gateway')['Id'] == proof['gateway_container_id'], 'Gateway drift')
    require(identities() == proof['neighbors'], 'Neighbor container drift')
    current = (ROOT / 'public-https/current').resolve(strict=True)
    require(str(current) == proof['public_release'], 'Public pointer drift')
    original = current / 'infra/public-staging/gateway.Caddyfile'
    file_guard(original, proof['gateway_sha256'])
    expected = gateway(original.read_bytes(), proof['gateway_sha256'])
    for route in [b'/v1/kiosk-checkout/device-presence', b'/v1/kiosk-checkout/staff/verify']:
        require(route in expected and route in original.read_bytes(), 'Existing device/staff route missing')
    require((folder / 'gateway.Caddyfile').read_bytes() == expected, 'Candidate gateway differs')
    old_compose_path = current / 'infra/public-staging/compose.yaml'
    file_guard(old_compose_path, proof['gateway_compose_sha256'])
    old_compose = json.loads(run(['docker', 'compose', '-f', str(old_compose_path),
                                 'config', '--format', 'json']))
    require(json.loads((folder / 'gateway-compose.json').read_text()) ==
            gateway_compose(old_compose, ROOT / 'public-https/releases' / a.sha / 'infra/public-staging/gateway.Caddyfile'), 'Unrelated compose change')
    networks = json.loads(run(['docker', 'network', 'inspect',
                              *run(['docker', 'network', 'ls', '-q']).decode().splitlines()]))
    subnet_guard(networks)
    active_old_network = json.loads(run(['docker', 'network', 'inspect', 'deploy_default']))[0]
    names = {c['Name'] for c in active_old_network['Containers'].values()}
    require(names - {'deploy-caddy-1', 'deploy-db-1', 'deploy-server-1'} == UPSTREAMS,
            'Upstream inventory changed')
    paths = proof['tls_files']
    tls_guard(paths)
    data = folder / 'data'
    require(data.is_dir() and not data.is_symlink() and data.stat().st_mode & 0o777 == 0o700,
            'Private TLS directory required')
    require(not any(p.is_symlink() for p in data.rglob('*')), 'TLS symlink refused')
    actual = {str(p.relative_to(data)): digest(p.read_bytes()) for p in data.rglob('*') if p.is_file()}
    require(not any(p.is_symlink() for p in data.rglob('*')) and actual == paths, 'TLS copy differs')
    require((folder / 'config').is_dir() and not list((folder / 'config').iterdir()),
            'Config must be empty; do not import old autosave')
    for path, checksum in paths.items():
        require(digest(run(['docker', 'exec', OLD, 'cat', '/data/' + path])) == checksum,
                'Existing certificate changed after copy')
    require((folder / 'runtime.env').read_text() ==
            f'INGRESS_UID={data.stat().st_uid}\nINGRESS_GID={data.stat().st_gid}\n', 'TLS owner differs')
    prefix = ['docker', 'compose', '--env-file', str(folder / 'runtime.env'), '-f', str(folder / 'compose.yaml')]
    new_gateway = ['docker', 'compose', '-f', str(folder / 'gateway-compose.json')]
    old_gateway = ['docker', 'compose', '-f', str(old_compose_path)]
    run(prefix + ['config', '--quiet'])
    # Validation is network-isolated and never touches live certificate storage.
    for config in ['Caddyfile', 'gateway.Caddyfile']:
        run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
             '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges:true',
             '--tmpfs', '/data', '--tmpfs', '/config', '--tmpfs', '/tmp',
             '-v', str(folder / config) + ':/etc/caddy/Caddyfile:ro', IMAGE,
             'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])
    probes(proof['http_checks'])
    public_release = ROOT / 'public-https/releases' / a.sha
    require((public_release / 'infra/public-staging/compose.yaml').read_bytes() ==
            (folder / 'gateway-compose.json').read_bytes(), 'Durable public compose missing')
    require((public_release / 'infra/public-staging/gateway.Caddyfile').read_bytes() == expected,
            'Durable gateway config missing')
    public_before = current / 'infra/public-staging/public-web'
    public_after = public_release / 'infra/public-staging/public-web'
    def web_hashes(root):
        require(root.is_dir() and not any(p.is_symlink() for p in root.rglob('*')), 'Public web shape differs')
        return {str(p.relative_to(root)): digest(p.read_bytes()) for p in root.rglob('*') if p.is_file()}
    require(web_hashes(public_before) == web_hashes(public_after), 'Public web copy differs')
    if not a.apply:
        print('Candidate checks passed; no live cutover.')
        return
    now = datetime.now(timezone.utc)
    window(now, proof['cutover_date_almaty'])
    fresh_backup(now)
    require(proof.get('device_center_opened') is True and proof.get('kiosk_staff_opened') is True,
            'Authenticated device-center and kiosk-staff UI verification required')
    require(proof.get('observation_mode') in ['manual-30min', 'watchdog-24h'], 'Observation required')
    if proof['observation_mode'] == 'watchdog-24h':
        require(proof.get('watchdog_test_received') is True and
                (now - datetime.fromisoformat(proof['telegram_since'])).total_seconds() >= 86400,
                'Watchdog evidence incomplete')
    LOCK.mkdir(mode=0o700)
    owner = {'id': str(uuid.uuid4()), 'action': 'own-caddy-1106', 'sha': a.sha}
    save(LOCK / 'owner.json', owner)
    outcome = {'status': 'preparing', 'source_sha': a.sha}
    touched = False
    try:
        file_guard(front, proof['front_sha256'])
        file_guard(original, proof['gateway_sha256'])
        require(identities() == proof['neighbors'], 'Drift after lock')
        save(folder / 'rollback.json', {'old_gateway_compose': str(old_compose_path),
             'old_gateway_sha256': proof['gateway_sha256'], 'old_public_release': str(current)})
        for name, content in [('gateway.before', original.read_bytes()),
                              ('front.before', front.read_bytes()),
                              ('gateway-compose.before', old_compose_path.read_bytes())]:
            with (folder / name).open('xb') as f:
                os.chmod(folder / name, 0o600);f.write(content)
        # Original files/containers are retained. A /28 never trusts other legacy containers.
        run(['docker', 'network', 'create', '--subnet', SUBNET, NETWORK])
        run(['docker', 'network', 'connect', '--alias', 'pickchick-staff-login', NETWORK,
             'pickchick-staff-login'])
        touched = True
        run(new_gateway + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '20', 'gateway'])
        run(['docker', 'stop', '--time', '5', OLD])
        run(prefix + ['up', '-d', '--no-deps', 'caddy'])
        require(inspect(NEW)['NetworkSettings']['Networks'][NETWORK]['IPAddress'] == ADDRESS,
                'New ingress IP differs')
        probes(proof['http_checks'])
        require(identities() == proof['neighbors'], 'Neighbor changed')
        deadline = time.monotonic() + 1800
        while time.monotonic() < deadline:
            time.sleep(min(30, max(0, deadline - time.monotonic())))
            probes(proof['http_checks'])
            require(identities() == proof['neighbors'], 'Neighbor drift during observation')
        # Gateway compose persists its extra network and config on later service restart.
        require((ROOT / 'public-https/current').resolve(strict=True) == current, 'Public pointer drift')
        target = ROOT / 'public-https/current'
        tmp = target.with_name('.current-' + uuid.uuid4().hex)
        tmp.symlink_to(public_release);tmp.replace(target)
        outcome['status'] = 'switched_observed_30min_legacy_retained'
    except BaseException:
        if touched:
            rollback(lambda: run(['docker', 'start', OLD], timeout=15),
                     lambda: run(old_gateway + ['up', '-d', '--no-deps', '--wait',
                                               '--wait-timeout', '15', 'gateway'], timeout=25),
                     lambda: run(['docker', 'stop', '--time', '3', NEW], timeout=10, check=False))
        outcome['status'] = 'rolled_back_or_preparation_stopped'
        save(folder / 'result.json', outcome)
        # Retain owned lock for operator inspection after any failed phase.
        raise
    save(folder / 'result.json', outcome)
    require(json.loads((LOCK / 'owner.json').read_text()) == owner, 'Lock owner changed')
    (LOCK / 'owner.json').unlink();LOCK.rmdir()
    print(json.dumps(outcome))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--candidate', required=True, type=Path)
    parser.add_argument('--receipt', required=True, type=Path)
    parser.add_argument('--ci-proof', required=True, type=Path)
    parser.add_argument('--source-manifest', required=True, type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--apply', action='store_true')
    try:
        main(parser.parse_args())
    except BaseException:
        raise SystemExit('STOP: ingress guard failed; protected details withheld. Inspect owned lock.') from None
