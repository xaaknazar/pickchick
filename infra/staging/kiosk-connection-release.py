#!/usr/bin/env python3
"""Narrow, owner-authorized kiosk long-poll ingress change. No API/DB mutations.

Run on the VPS. Private evidence stays in --directory (0700). Every subprocess
output is captured; only named checks and non-secret proof metadata are printed.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path('/opt/pickchick-staging')
FRONT = Path('/opt/idrink/deploy/Caddyfile')
CADDY = 'deploy-caddy-1'
API = 'pickchick-staging-api-1'
LOCK = ROOT / '.market-release.lock'
SITE = 'pickchick.185.129.51.103.nip.io {'
PROBE_TRACE_ID = 'e3c9367b-21bf-4cc7-bc0a-a66fce86d8bc'
BLOCK = '''\t# Kiosk availability may wait 25 seconds for an unchanged snapshot.
\t@kiosk_availability_watch {
\t\tmethod GET
\t\tpath /v1/kiosk-checkout/availability
\t}
\thandle @kiosk_availability_watch {
\t\treverse_proxy pickchick-public-gateway:8080 {
\t\t\ttransport http {
\t\t\t\tdial_timeout 2s
\t\t\t\tresponse_header_timeout 32s
\t\t\t}
\t\t}
\t}
'''.encode()


class Stop(Exception):
    pass


class Uncertain(Stop):
    pass


def require(ok, name):
    if not ok:
        raise Stop(name)


def digest(value):
    if not isinstance(value, bytes):
        value = json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(value).hexdigest()


def candidate(raw):
    require(raw.count(SITE.encode()) == 1, 'front.unique_site')
    require(b'@kiosk_availability_watch' not in raw, 'front.route_already_present')
    start = raw.index(SITE.encode())
    # Site lines are not rewritten; add immediately before its final catch-all.
    end = raw.find(b'\n}', start)
    require(end != -1, 'front.site_end')
    site = raw[start:end]
    require(site.count(b'\n\thandle {') == 1, 'front.unique_default')
    require(b'response_header_timeout 8s' in site, 'front.default_timeout')
    at = start + site.index(b'\n\thandle {') + 1
    result = raw[:at] + BLOCK + raw[at:]
    require(result.replace(BLOCK, b'', 1) == raw, 'front.exact_insertion')
    return result


def private(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_mode & 0o077 == 0,
            'private.input')
    return path.read_bytes()


def save(path, value, replace=False):
    raw = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True).encode()
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | (os.O_TRUNC if replace else os.O_EXCL)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, 'wb') as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(raw)
        f.flush()
        os.fsync(f.fileno())


def run(args, data=None, timeout=45):
    try:
        p = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Uncertain('command.completion_unknown') from None
    require(p.returncode == 0, 'command.' + args[0] + '.exit')
    return p.stdout


def docker(*args, data=None, timeout=45):
    return run(['docker', '--host', 'unix:///var/run/docker.sock', *args], data, timeout)


def meta(path):
    require(path.is_file() and not path.is_symlink(), 'front.regular_file')
    s = path.stat()
    return {'uid': s.st_uid, 'gid': s.st_gid, 'mode': s.st_mode, 'inode': s.st_ino}


def inventory():
    ids = docker('ps', '-aq').decode().split()
    rows = json.loads(docker('inspect', *ids))
    return {r['Name'].lstrip('/'): {'id': r['Id'], 'image': r['Image'],
            'started': r['State']['StartedAt'], 'running': r['State']['Running'],
            'config': r['Config'], 'host': r['HostConfig'],
            'mounts': sorted(r['Mounts'], key=lambda m: m['Destination'])} for r in rows}


def adapted(raw):
    return json.loads(docker('exec', '-i', CADDY, 'caddy', 'adapt', '--config', '-',
                             '--adapter', 'caddyfile', data=raw))


def live():
    return json.loads(docker('exec', CADDY, 'wget', '-qO-', 'http://127.0.0.1:2019/config/'))


def validate(raw):
    docker('exec', '-i', CADDY, 'caddy', 'validate', '--config', '-', '--adapter',
           'caddyfile', data=raw)


def reload(raw):
    docker('exec', '-i', CADDY, 'caddy', 'reload', '--config', '-', '--adapter',
           'caddyfile', data=raw)


def probes():
    results = {}
    for host, paths in {
        'api.pickchick.kz': ['/health/live', '/v1/kiosk-checkout/config'],
        'pickchick.185.129.51.103.nip.io': ['/v1/kiosk-checkout/config', '/backoffice/',
                                          '/kitchen/', '/display/', '/v1/auth/config'],
        '185.129.51.103.nip.io': ['/'],
        'pickchick.kz': ['/aquarium/'],
    }.items():
        for path in paths:
            try:
                # The API echoes a valid request ID, keeping its auth-error body comparable.
                request = urllib.request.Request('https://' + host + path,
                                                 headers={'X-Request-Id': PROBE_TRACE_ID})
                r = urllib.request.urlopen(request, timeout=15)
            except urllib.error.HTTPError as e:
                r = e
            body = r.read()
            value = {'status': r.status, 'url': r.geturl()}
            # Static neighbors and auth config should be byte-identical.
            if path not in ['/health/live', '/aquarium/', '/backoffice/']:
                value['body_digest'] = digest(body)
            results[host + path] = value
    require(results['api.pickchick.kz/health/live']['status'] == 200, 'probe.api_health')
    for h in ['api.pickchick.kz', 'pickchick.185.129.51.103.nip.io']:
        require(results[h + '/v1/kiosk-checkout/config']['status'] == 400, 'probe.kiosk_auth_gate')
    return results


def lock_owner(token):
    require(LOCK.is_dir(), 'lock.missing')
    require(json.loads(private(LOCK / 'owner.json')) == token, 'lock.foreign')


def release_lock(token):
    lock_owner(token)
    require(sorted(p.name for p in LOCK.iterdir()) == ['owner.json'], 'lock.extra_files')
    (LOCK / 'owner.json').unlink()
    LOCK.rmdir()


def write_front(raw, expected_hash, metadata, image):
    require(meta(FRONT) == metadata, 'front.metadata_drift')
    # Existing mount inode and owner must survive. The isolated helper has one bind,
    # no network, no capabilities, and the already installed immutable API image.
    script = '''const fs=require('node:fs'),crypto=require('node:crypto');
const h=x=>crypto.createHash('sha256').update(x).digest('hex');
const path='/target',before=fs.statSync(path);
if(h(fs.readFileSync(path))!==process.argv[1])process.exit(20);
const raw=fs.readFileSync(0);if(h(raw)!==process.argv[2])process.exit(21);
const fd=fs.openSync(path,'w');fs.writeFileSync(fd,raw);fs.fsyncSync(fd);fs.closeSync(fd);
const after=fs.statSync(path);
if(before.ino!==after.ino||before.uid!==after.uid||before.gid!==after.gid||before.mode!==after.mode||h(fs.readFileSync(path))!==process.argv[2])process.exit(22);'''
    docker('run', '--rm', '-i', '--pull', 'never', '--network', 'none', '--read-only',
           '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user',
           str(metadata['uid']) + ':' + str(metadata['gid']), '--mount',
           'type=bind,source=' + str(FRONT) + ',target=/target', '--entrypoint', 'node',
           image, '-e', script, expected_hash, digest(raw), data=raw)
    require(meta(FRONT) == metadata and digest(FRONT.read_bytes()) == digest(raw),
            'front.write_verified')


def inspect(folder):
    require(not LOCK.exists(), 'lock.exists')
    folder.mkdir(mode=0o700, parents=False)
    before = FRONT.read_bytes()
    change = candidate(before)
    baseline = {'captured_at': time.time(), 'containers': inventory(), 'metadata': meta(FRONT),
                'before_digest': digest(before), 'candidate_digest': digest(change),
                'live_config': live(), 'probes': probes()}
    require(baseline['live_config'] == adapted(before), 'front.live_file_drift')
    validate(change)
    require(inventory() == baseline['containers'], 'inspect.container_drift')
    require(FRONT.read_bytes() == before and live() == baseline['live_config'], 'inspect.front_drift')
    save(folder / 'front.before.Caddyfile', before)
    save(folder / 'front.candidate.Caddyfile', change)
    save(folder / 'baseline.json', baseline)
    return {'status': 'prepared', 'baseline_sha256': digest(private(folder / 'baseline.json')),
            'backup': str(folder / 'front.before.Caddyfile'), 'backup_sha256': digest(before)}


def load(folder, expected, fresh=True):
    raw = private(folder / 'baseline.json')
    require(digest(raw) == expected, 'baseline.digest')
    b = json.loads(raw)
    if fresh:
        require(0 <= time.time() - b['captured_at'] < 3600, 'baseline.fresh')
    before, new = private(folder / 'front.before.Caddyfile'), private(folder / 'front.candidate.Caddyfile')
    require(digest(before) == b['before_digest'] and digest(new) == b['candidate_digest'], 'backup.digest')
    require(candidate(before) == new, 'candidate.exact')
    return b, before, new


def unchanged(b, raw):
    require(inventory() == b['containers'], 'containers.changed')
    require(meta(FRONT) == b['metadata'], 'front.metadata_drift')
    require(FRONT.read_bytes() == raw, 'front.file_drift')
    require(live() == adapted(raw), 'front.live_config_drift')
    require(probes() == b['probes'], 'neighbors.probes_changed')


def apply(folder, expected):
    b, old, new = load(folder, expected)
    require(not LOCK.exists(), 'lock.exists')
    unchanged(b, old)
    owner = {'task': 'kiosk-connection-1116', 'id': str(uuid.uuid4()),
             'created_at': datetime.now(timezone.utc).isoformat()}
    LOCK.mkdir(mode=0o700)
    save(LOCK / 'owner.json', owner)
    attempted = False
    try:
        unchanged(b, old)
        validate(new)
        lock_owner(owner)
        save(folder / 'state.json', {'status': 'applying', 'owner': owner})
        attempted = True
        write_front(new, b['before_digest'], b['metadata'], b['containers'][API]['image'])
        reload(new)
        unchanged(b, new)
        save(folder / 'state.json', {'status': 'applied', 'owner': owner}, True)
    except Uncertain:
        save(folder / 'uncertain.json', {'status': 'inspect_before_recovery', 'owner': owner})
        raise
    except Exception:
        if attempted:
            # Do not overwrite an intervening writer or hide container changes.
            lock_owner(owner)
            require(inventory() == b['containers'], 'rollback.container_drift')
            current = FRONT.read_bytes()
            require(current in (old, new), 'rollback.foreign_file')
            require(live() in (adapted(old), adapted(new)), 'rollback.foreign_live_config')
            validate(old)
            if current != old:
                write_front(old, digest(new), b['metadata'], b['containers'][API]['image'])
            reload(old)
            unchanged(b, old)
            save(folder / 'state.json', {'status': 'rolled_back', 'owner': owner}, True)
        release_lock(owner)
        raise
    release_lock(owner)
    return {'status': 'applied', 'route': '/v1/kiosk-checkout/availability',
            'timeout_seconds': 32, 'default_timeout_seconds': 8,
            'containers_unchanged': True, 'neighbor_probes_unchanged': True,
            'backup': str(folder / 'front.before.Caddyfile'), 'lock_released': True}



def rollback(folder, expected):
    # Exact backups and current-state CAS protect recovery even after baseline expiry.
    b, old, new = load(folder, expected, fresh=False)
    state = json.loads(private(folder / 'state.json'))
    require(state['status'] == 'applied', 'rollback.not_applied')
    require(not LOCK.exists(), 'lock.exists')
    unchanged(b, new)
    owner = {'task': 'kiosk-connection-1116-rollback', 'id': str(uuid.uuid4())}
    LOCK.mkdir(mode=0o700)
    save(LOCK / 'owner.json', owner)
    # Any failure retains the owned lock and evidence for inspection.
    unchanged(b, new)
    validate(old)
    write_front(old, digest(new), b['metadata'], b['containers'][API]['image'])
    reload(old)
    unchanged(b, old)
    save(folder / 'state.json', {'status': 'rolled_back', 'owner': owner}, True)
    release_lock(owner)
    return {'status': 'rolled_back', 'lock_released': True}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode', choices=['inspect', 'apply', 'rollback'])
    p.add_argument('--directory', required=True, type=Path)
    p.add_argument('--baseline-sha256')
    a = p.parse_args()
    require(a.directory.parent == ROOT / 'maintenance', 'directory.parent')
    require(not a.directory.is_symlink(), 'directory.symlink')
    if a.mode == 'inspect':
        result = inspect(a.directory)
    else:
        require(re.fullmatch(r'[0-9a-f]{64}', a.baseline_sha256 or '') is not None, 'baseline.required')
        result = (apply if a.mode == 'apply' else rollback)(a.directory, a.baseline_sha256)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Stop as e:
        print(json.dumps({'status': 'STOP', 'check': str(e)}))
        raise SystemExit(1) from None
    except Exception as e:
        print(json.dumps({'status': 'STOP', 'check': 'unexpected', 'type': type(e).__name__}))
        raise SystemExit(1) from None
