#!/usr/bin/env python3
"""CAS activation of an already deployed Devices portal. No deployment or enrollment.

Run on the VPS as its existing operator. Default emits a read-only plan. Only the
portal is stopped/started, with its original config inode, key and container intact.
Unknown outcomes retain the shared release lock and a private byte-verified backup.
Restore is an explicit operation against that exact attempt, never an automatic retry.
"""
import argparse
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
PINS = {'update-deploy.py': '6cca519fde806b9bdb74924c955a22a21d717679a9ab2e7a44ad89d3dcce8416',
        'remote-deploy.py': 'b8b1140d8150fac08374cc49313b322037b226d40a1b15c7eaa6e7eb14b23777',
        '../roadmap/remote-deploy.py': 'cd40654d2f347ba8f76385012e8067a91d56417c491805bedad8212697297de6'}
for name, expected in PINS.items():
    if hashlib.sha256((HERE / name).read_bytes()).hexdigest() != expected:
        raise RuntimeError('Reviewed portal dependency changed')
spec = importlib.util.spec_from_file_location('device_portal_update', HERE / 'update-deploy.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
b, STATE = u.b, u.STATE
API = 'pickchick-staging-api-1'
LINK_FILES = ('infra/kitchen-portal/agent.mjs', 'infra/kitchen-portal/link.mjs',
              'apps/kitchen/server.mjs', 'apps/kitchen/terminal-cookie.mjs')
JOBS = ('Local kitchen UI and recovery', 'iPad kiosk state, bundles and browser recovery',
        'Design screens and interaction smoke', 'Private staging image and restricted database role',
        'Cloud-edge fulfillment transport and recovery', 'Build, contracts and PostgreSQL integration',
        'Foundation static checks and transaction invariants', 'Foundation POS and backoffice integration',
        'Foundation server account and Kaspi fixtures', 'Foundation simulator browser regressions',
        'Foundation mobile bundles and checkout recovery')
BUNDLE_FILES = ('infra/kitchen-portal/activate-device-access.py', 'infra/kitchen-portal/update-deploy.py',
                'infra/kitchen-portal/remote-deploy.py', 'infra/roadmap/remote-deploy.py',
                'db/edge/migrations/020_terminal_access.sql', 'infra/windows/native-device-access-worker.mjs')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def unique(pairs):
    result = {}
    for key, value in pairs:
        b.require(key not in result, 'Duplicate JSON field')
        result[key] = value
    return result


def decode(data):
    return json.loads(data, object_pairs_hook=unique)


def private_bytes(path, limit=4 * 1024 * 1024):
    path = Path(path)
    b.require(not any(p.is_symlink() for p in [path, *path.parents]), 'Symlink operator input')
    info = path.stat()
    b.require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and
              info.st_mode & 0o077 == 0 and info.st_size <= limit, 'Protected bounded operator file required')
    return path.read_bytes()


def write_new(path, data):
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    b.require(private_bytes(path, max(len(data), 1)) == data, 'Private evidence readback failed')


def save_new(path, value):
    write_new(path, (json.dumps(value, sort_keys=True, indent=2) + '\n').encode())


def check_bundle(source):
    root = HERE.parent.parent
    manifest = decode(private_bytes(root / 'device-access-operator.json'))
    b.require(manifest.get('format') == 'pickchick-device-access-operator-v1' and
              manifest.get('source_sha') == source and set(manifest.get('files', {})) == set(BUNDLE_FILES),
              'Exact standalone operator bundle required')
    for name, expected in manifest['files'].items():
        b.require(sha(private_bytes(root / name)) == expected, 'Operator bundle file changed')


def config_candidate(raw, enabled):
    config = decode(raw)
    b.require(isinstance(config, dict) and config.get('origin') == b.ORIGIN and
              re.fullmatch('[a-f0-9]{64}', config.get('key', '')) and
              type(config.get('terminalAccess', False)) is bool, 'Unexpected portal config')
    b.require(config.get('terminalAccess', False) is not enabled, 'Flag already changed; inspect instead of replay')
    text = raw.decode('utf-8')
    matches = list(re.finditer(r'"terminalAccess"\s*:\s*(true|false)', text))
    if 'terminalAccess' in config:
        b.require(len(matches) == 1, 'Ambiguous/escaped flag encoding')
        match = matches[0]
        result = (text[:match.start(1)] + ('true' if enabled else 'false') + text[match.end(1):]).encode()
    else:
        b.require(enabled and not matches, 'Initial activation only')
        end = len(text.rstrip()) - 1
        b.require(text[end] == '}', 'Config object boundary differs')
        result = (text[:end] + ',\n  "terminalAccess": true\n' + text[end:]).encode()
    after = decode(result)
    b.require(after == {**config, 'terminalAccess': enabled}, 'Unrelated private config changed')
    return result


def check_ci(proof, source):
    run, jobs = proof.get('run', {}), proof.get('jobs', {})
    rows = jobs.get('jobs', [])
    b.require(run.get('head_sha') == source and run.get('status') == 'completed' and
              run.get('conclusion') == 'success' and run.get('path') == '.github/workflows/ci.yml' and
              run.get('head_repository', {}).get('full_name') == 'xaaknazar/pickchick' and
              jobs.get('total_count') == len(JOBS) and len(rows) == len(JOBS), 'Exact full Foundation CI required')
    b.require(sorted(r.get('name', '') for r in rows) == sorted(JOBS) and
              all(r.get('head_sha') == source and r.get('conclusion') == 'success' and
                  r.get('status') == 'completed' for r in rows), 'Missing or stale CI job')


def check_ready(cloud, windows, args, manifest, now=None):
    now = time.time() if now is None else now
    for proof in (cloud, windows):
        b.require(proof.get('source_sha') == args.expected_source_sha and
                  proof.get('branch_id') == args.branch_id and proof.get('edge_device_id') == args.edge_device_id and
                  type(proof.get('completed_epoch')) in (int, float) and
                  0 <= now - proof['completed_epoch'] <= 21600, 'Foreign or stale readiness evidence')
    b.require(cloud.get('format') == 'pickchick-device-access-cloud-enabled-v1' and
              cloud.get('device_access_enabled') is True, 'Actual cloud enable required')
    worker, link = windows.get('worker', {}), windows.get('link', {})
    b.require(windows.get('format') == 'pickchick-device-access-ready-v1' and windows.get('schema') == 20 and
              windows.get('runtime_verified') is True and windows.get('grants_verified') is True and
              all(worker.get(k) is True for k in ('installed', 'enabled', 'running')) and
              link.get('verified') is True and link.get('running') is True, 'Actual activated Windows proof required')
    source = HERE.parent.parent
    b.require(windows.get('migrationChecksum020') == b.digest(source / 'db/edge/migrations/020_terminal_access.sql') and
              worker.get('script_sha256') == b.digest(source / 'infra/windows/native-device-access-worker.mjs') and
              link.get('files') == {name: manifest['files'][name] for name in LINK_FILES}, 'Windows/portal source bytes differ')


def inspect(name):
    return decode(b.run(['docker', 'inspect', name]))[0]


def public_mode(source, enabled, require_edge=True):
    health = decode(b.http('/kitchen-live/health')[1])
    b.require(health.get('sourceSha') == source and (not require_edge or health.get('edgeConnected') is True), 'Portal/link health differs')
    for mode in ('prep', 'assembly', 'display'):
        status, body, _ = b.http('/kitchen-live/' + mode + '/config.json')
        value = decode(body)
        b.require(status == 200 and (value.get('pairingEnabled') is True) == enabled, 'Public terminal mode differs')
        if enabled:
            b.require(value.get('mode') == mode and value.get('paired') is False and 'terminalId' not in value, 'Anonymous pairing config differs')
        else:
            b.require(re.fullmatch('[a-f0-9-]{36}', value.get('terminalId', '')), 'Legacy terminal configuration missing')
    for path in ('/kitchen-live/private/config.json', '/kitchen-live/assets/server.mjs', '/kitchen-link/poll'):
        b.require(b.http(path)[0] in (401, 404), 'Private portal route exposed')


def baseline(args, raw, enabled, healthy=True):
    old, public, api, neighbors = u.baseline(args)
    b.require(old == STATE / 'releases' / args.expected_source_sha, 'Deploy the same-source portal package first')
    b.require(sha(raw) == args.expected_config_sha256, 'Reviewed config CAS differs')
    manifest = u.d.manifest(old, args.expected_source_sha)
    b.require(b.digest(old / 'kitchen-package.json') == args.expected_manifest_sha256 and
              set(LINK_FILES).issubset(manifest['files']) and
              'apps/kitchen/dist/components/PasswordReset.js' in manifest['files'], 'Exact Devices portal package required')
    portal = inspect(b.SERVICE)
    mounts = {m['Destination']: m for m in portal['Mounts']}
    b.require(portal['State']['Running'] is True or not healthy, 'Portal is not running')
    b.require(mounts.get('/app', {}).get('Source') == str(old) and mounts['/app']['RW'] is False and
              mounts.get('/run/secrets/config.json', {}).get('Source') == str(STATE / 'private/config.json') and
              mounts['/run/secrets/config.json']['RW'] is False, 'Portal mounts differ')
    api_state = inspect(API)
    b.require(api_state['State']['Running'] is True and api_state['Image'] == args.expected_api_image and
              api_state['Config']['Labels'].get('org.opencontainers.image.revision') == args.expected_source_sha,
              'Running API source/image differs')
    if args.mode == 'enable':
        flags = [x for x in api_state['Config']['Env'] if x.startswith('BACKOFFICE_DEVICE_ACCESS_ENABLED=')]
        b.require(flags == ['BACKOFFICE_DEVICE_ACCESS_ENABLED=true'], 'Live cloud Devices flag is off')
    if healthy:
        public_mode(args.expected_source_sha, enabled, args.mode == 'enable')
    b.require(set(neighbors).issuperset(('pickchick-kaspi-bridge', 'pickchick-kaspi-worker', 'pickchick-kiosk-kaspi-qr-worker')), 'Expected bank neighbors missing')
    return {'portal': neighbors[b.SERVICE], 'neighbors': {n: v for n, v in neighbors.items() if n != b.SERVICE},
            'public': str(public), 'api': str(api), 'release': str(old), 'manifest': manifest,
            'gateway_sha256': args.expected_gateway_sha256, 'manifest_sha256': args.expected_manifest_sha256,
            'api_image': args.expected_api_image}


def cas_write(path, before, after, identity):
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        b.require((info.st_dev, info.st_ino) == tuple(identity) and info.st_uid == os.getuid() and
                  info.st_mode & 0o077 == 0 and os.read(fd, len(before) + 1) == before, 'Config inode/bytes changed')
        os.lseek(fd, 0, os.SEEK_SET)
        view = memoryview(after)
        while view:
            count = os.write(fd, view)
            b.require(count > 0, 'Incomplete config write')
            view = view[count:]
        os.ftruncate(fd, len(after))
        os.fsync(fd)
        b.require(private_bytes(path) == after, 'Config write readback failed')
    finally:
        os.close(fd)


@contextmanager
def lease(source, state, owner_id=None):
    if owner_id:
        owner = decode(private_bytes(b.LOCK / 'owner.json'))
        b.require(owner.get('id') == owner_id and owner.get('sha') == source and
                  owner.get('action') == 'portal-device-access' and owner.get('state') == str(state), 'Foreign retained lock')
    else:
        owner = {'id': str(uuid.uuid4()), 'sha': source, 'action': 'portal-device-access', 'state': str(state)}
        b.LOCK.mkdir(mode=0o700)
        save_new(b.LOCK / 'owner.json', owner)
    try:
        yield owner
    except BaseException:
        raise  # Preserve the owned lock and all evidence; no hidden retry/rollback.
    else:
        b.require(decode(private_bytes(b.LOCK / 'owner.json')) == owner, 'Lock owner changed')
        (b.LOCK / 'owner.json').unlink()
        b.LOCK.rmdir()


def restart_config(args, state, record, before, after):
    config = STATE / 'private/config.json'
    current = inspect(b.SERVICE)
    b.require([current['Id'], current['Image'], current['State']['StartedAt']] == record['portal'], 'Portal changed since reviewed plan')
    b.run(['docker', 'stop', '--time', '15', current['Id']], timeout=60)
    b.require(inspect(b.SERVICE)['State']['Running'] is False, 'Portal stop not verified')
    cas_write(config, before, after, record['config_identity'])
    b.run(['docker', 'start', current['Id']], timeout=60)
    deadline = time.monotonic() + 45
    while True:
        try:
            public_mode(args.expected_source_sha, decode(after).get('terminalAccess', False), args.mode == 'enable')
            break
        except Exception:
            if time.monotonic() >= deadline:
                raise RuntimeError('Portal mode/health not verified; retain lock and inspect') from None
            time.sleep(1)
    live = inspect(b.SERVICE)
    b.require([live['Id'], live['Image']] == record['portal'][:2] and live['State']['Running'] is True, 'Portal identity changed')
    b.require(private_bytes(config) == after and b.pointer(STATE / 'current') == Path(record['release']) and
              b.pointer(b.ROOT / 'current') == Path(record['api']) and
              b.pointer(b.ROOT / 'public-https/current') == Path(record['public']), 'Config or release pointers changed')
    u.unchanged(record['neighbors'])
    mounted = b.run(['docker', 'exec', current['Id'], 'node', '-e',
                     "console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/run/secrets/config.json')).digest('hex'))"])
    b.require(mounted == sha(after), 'Container did not retain the config bind inode')
    result = {'format': 'pickchick-device-access-portal-v1', 'source_sha': args.expected_source_sha,
              'branch_id': args.branch_id, 'edge_device_id': args.edge_device_id,
              'terminal_access_enabled': decode(after).get('terminalAccess', False), 'completed_epoch': time.time(),
              'config_sha256': sha(after), 'key_and_other_config_preserved': True,
              'neighbors_unchanged': True, 'pairing_or_password_test_performed': False}
    save_new(state / ('restored.json' if args.mode == 'restore' else 'result.json'), result)
    return result


def operate(args):
    config = STATE / 'private/config.json'
    state = STATE / 'device-access' / args.operation_id
    raw = private_bytes(config)
    check_ci(decode(private_bytes(args.ci_proof)), args.expected_source_sha)
    if args.mode == 'restore':
        b.require(args.owner_id, 'Restore needs the retained lock owner')
        record = decode(private_bytes(state / 'attempt.json'))
        b.require(record['source_sha'] == args.expected_source_sha and record['operation_id'] == args.operation_id and
                  record['branch_id'] == args.branch_id and record['edge_device_id'] == args.edge_device_id,
                  'Foreign recovery attempt')
        before, after = private_bytes(state / 'before.json'), private_bytes(state / 'after.json')
        b.require(sha(before) == record['before_sha256'] and sha(after) == record['after_sha256'] and
                  raw in (before, after), 'Unknown config state; do not overwrite')
        b.require(args.expected_config_sha256 == sha(raw), 'Review actual recovery config hash')
        actual = baseline(args, raw, decode(raw).get('terminalAccess', False), healthy=False)
        b.require(actual['portal'][:2] == record['portal'][:2] and
                  all(actual[k] == record[k] for k in actual if k not in ('portal', 'manifest')), 'Recovery baseline changed')
        record['portal'] = actual['portal']
        if not args.apply:
            return {'status': 'restore-plan', 'applied': False, 'original_flag': decode(before).get('terminalAccess', False)}
        with lease(args.expected_source_sha, state, args.owner_id):
            return restart_config(args, state, record, raw, before)
    b.require(not args.owner_id, 'Retained lock may only be resumed by explicit restore')
    enabled = args.mode == 'enable'
    after = config_candidate(raw, enabled)
    actual = baseline(args, raw, not enabled)
    proofs = {}
    if enabled:
        for name in ('cloud_proof', 'windows_proof'):
            b.require(getattr(args, name), 'Actual cloud/Windows proofs required')
            proofs[name] = private_bytes(getattr(args, name))
        check_ready(decode(proofs['cloud_proof']), decode(proofs['windows_proof']), args, actual['manifest'])
    record = {k: v for k, v in actual.items() if k != 'manifest'}
    info = config.stat()
    record.update(format='pickchick-device-access-portal-plan-v1', mode=args.mode, operation_id=args.operation_id,
                  source_sha=args.expected_source_sha, branch_id=args.branch_id, edge_device_id=args.edge_device_id,
                  before_sha256=sha(raw), after_sha256=sha(after), config_identity=[info.st_dev, info.st_ino],
                  proof_sha256={k: sha(v) for k, v in proofs.items()}, ci_sha256=sha(private_bytes(args.ci_proof)))
    if not args.apply:
        b.require(not state.exists(), 'Attempt retained; inspect or explicitly restore')
        return record
    b.require(args.plan and decode(private_bytes(args.plan)) == record, 'Exact reviewed plan/CAS required')
    with lease(args.expected_source_sha, state):
        # All checks repeat under the common release lock before creating an attempt.
        fresh = baseline(args, raw, not enabled)
        b.require({k: v for k, v in fresh.items() if k != 'manifest'} == actual_without_manifest(actual), 'Baseline changed under lease')
        state.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        state.mkdir(mode=0o700)
        write_new(state / 'before.json', raw)
        write_new(state / 'after.json', after)
        write_new(state / 'restore-drill.json', private_bytes(state / 'before.json'))
        b.require(private_bytes(state / 'restore-drill.json') == raw, 'Private config restore drill failed')
        save_new(state / 'attempt.json', record)  # Exclusive marker before the first stop/write.
        return restart_config(args, state, record, raw, after)


def actual_without_manifest(actual):
    return {k: v for k, v in actual.items() if k != 'manifest'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('enable', 'disable', 'restore'))
    for name in ('expected-source-sha', 'expected-public-release', 'expected-api-release', 'expected-gateway-sha256',
                 'expected-kitchen-release', 'expected-config-sha256', 'expected-manifest-sha256', 'expected-api-image',
                 'branch-id', 'edge-device-id', 'ci-proof', 'operation-id'):
        parser.add_argument('--' + name, required=True)
    for name in ('plan', 'cloud-proof', 'windows-proof', 'owner-id'):
        parser.add_argument('--' + name)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    b.require(os.getuid() == 1000, 'Use the existing VPS operator')
    b.require(re.fullmatch('[a-f0-9]{40}', args.expected_source_sha), 'Full source SHA required')
    for name in ('branch_id', 'edge_device_id', 'operation_id'):
        b.require(str(uuid.UUID(getattr(args, name))) == getattr(args, name), 'Canonical UUID required')
    for name in ('expected_config_sha256', 'expected_manifest_sha256', 'expected_gateway_sha256'):
        b.require(re.fullmatch('[a-f0-9]{64}', getattr(args, name)), 'Exact SHA256 pin required')
    b.require(re.fullmatch('sha256:[a-f0-9]{64}', args.expected_api_image), 'Exact API image required')
    check_bundle(args.expected_source_sha)
    print(json.dumps(operate(args), sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        # Never print config contents, passwords, keys, cookie data or subprocess output.
        print(json.dumps({'status': 'failed', 'detail': 'Inspect private evidence and retained release lock; no automatic retry.'}), file=sys.stderr)
        sys.exit(1)
