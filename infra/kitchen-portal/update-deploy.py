#!/usr/bin/env python3
"""Update only the existing portal; preserve gateway, private config and business services."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys
import uuid

spec = importlib.util.spec_from_file_location('portal_install', Path(__file__).with_name('remote-deploy.py'))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
b = d.b
STATE = d.STATE


def baseline(args):
    public, api, containers = b.baseline(args)
    old = b.pointer(STATE / 'current')
    b.require(old == Path(args.expected_kitchen_release), 'Kitchen pointer changed')
    mounts = json.loads(b.run(['docker', 'inspect', '--format', '{{json .Mounts}}', b.SERVICE]))
    b.require(any(m.get('Destination') == '/app' and m.get('Source') == str(old) for m in mounts), 'Kitchen app mount mismatch')
    config = STATE / 'private/config.json'
    b.require(config.is_file() and not config.is_symlink() and config.stat().st_uid == 1000 and config.stat().st_mode & 0o077 == 0, 'Protected portal config required')
    b.require(b.digest(config) == args.expected_config_sha256, 'Private config changed')
    b.require(json.loads(config.read_text())['origin'] == b.ORIGIN, 'Unexpected public origin')
    return old, public, api, containers


def unchanged(before):
    now = b.containers()
    for name, identity in before.items():
        if name != b.SERVICE:
            b.require(now.get(name) == identity, 'Unrelated service changed: ' + name)


def verify(sha):
    health = json.loads(b.http('/kitchen-live/health')[1])
    b.require(health.get('sourceSha') == sha, 'Unexpected deployed source')
    for module in ['app', 'api', 'model', 'runtime', 'types', 'demo', 'ticket-view']:
        status, body, headers = b.http('/kitchen-live/assets/' + module + '.js')
        b.require(status == 200 and body and 'javascript' in headers.get('Content-Type', ''), 'Missing kitchen module: ' + module)
    for mode, page in [('prep', '/kitchen/prep'), ('assembly', '/kitchen/assembly'), ('display', '/display')]:
        status, body, _ = b.http(page)
        b.require(status == 200 and b'/kitchen-live/assets/app.js' in body, 'Kitchen entry missing')
        b.require(b.http('/kitchen-live/' + mode + '/edge/v1/fulfillment/kitchen')[0] == 401, 'Anonymous queue exposed')
    for path in ['/kitchen-link/poll', '/kitchen-live/assets/server.mjs', '/kitchen-live/private/config.json']:
        b.require(b.http(path)[0] in (401, 404), 'Private route exposed')


def main():
    p = argparse.ArgumentParser()
    for name in ['package', 'expected-source-sha', 'expected-public-release', 'expected-api-release', 'expected-gateway-sha256', 'expected-kitchen-release', 'expected-config-sha256']:
        p.add_argument('--' + name, required=True)
    p.add_argument('--apply', action='store_true')
    a = p.parse_args()
    a.package = Path(a.package).absolute()
    b.require(os.getuid() == 1000 and re.fullmatch('[a-f0-9]{40}', a.expected_source_sha), 'Operator and full SHA required')
    manifest = d.manifest(a.package, a.expected_source_sha)
    b.require({'infra/kitchen-portal/healthcheck.mjs', 'apps/kitchen/dist/demo.js', 'apps/kitchen/dist/ticket-view.js'}.issubset(manifest['files']), 'Update package incomplete')
    baseline(a)
    if not a.apply:
        print(json.dumps({'status': 'inspected', 'source_sha': a.expected_source_sha}))
        return
    outcome = {'status': 'preparing', 'source_sha': a.expected_source_sha}
    with b.lock(a.expected_source_sha):
        old, public, api, before = baseline(a)
        release = STATE / 'releases' / a.expected_source_sha
        b.require(not release.exists(), 'Immutable release exists')
        touched = False
        try:
            for name in manifest['files']:
                target = release / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(a.package / name, target)
                target.chmod(0o644)
            env = release / 'portal.env'
            env.write_text('KITCHEN_RELEASE=' + str(release) + '\nKITCHEN_STATE=' + str(STATE) + '\nKITCHEN_SOURCE_SHA=' + a.expected_source_sha + '\n')
            env.chmod(0o600)
            sidecar = b.compose(release / 'infra/kitchen-portal/compose.yaml', env)
            b.run(sidecar + ['config', '--quiet'])
            baseline(a)
            touched = True
            b.run(sidecar + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', 'portal'], timeout=120)
            verify(a.expected_source_sha)
            unchanged(before)
            b.require(b.pointer(b.ROOT / 'public-https/current') == public and b.pointer(b.ROOT / 'current') == api, 'Unrelated pointer changed')
            b.require(b.digest(STATE / 'private/config.json') == a.expected_config_sha256, 'Config changed during deployment')
            b.switch(STATE / 'current', release)
            outcome.update(status='deployed', previous_release=str(old), release=str(release), unchanged_services=[n for n in before if n != b.SERVICE])
        except b.Uncertain:
            b.save(STATE / 'uncertain.json', outcome)
            raise
        except BaseException as error:
            if touched:
                # The previous version may already have a broken health probe. Restore
                # its container/config exactly, without claiming it becomes healthy.
                b.run(b.compose(old / 'infra/kitchen-portal/compose.yaml', old / 'portal.env') + ['up', '-d', '--no-deps', 'portal'], timeout=120)
            b.require(b.pointer(STATE / 'current') == old, 'Unexpected pointer during rollback')
            baseline(a)
            unchanged(before)
            outcome.update(status='rolled_back', reason=type(error).__name__)
        b.save(STATE / 'deployments' / (a.expected_source_sha + '-' + uuid.uuid4().hex + '.json'), outcome)
    print(json.dumps(outcome))
    sys.exit(0 if outcome['status'] == 'deployed' else 1)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'reason': str(error)}), file=sys.stderr)
        sys.exit(1)
