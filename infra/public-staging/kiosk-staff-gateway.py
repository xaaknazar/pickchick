#!/usr/bin/env python3
"""Add only the kiosk staff code route; retain all installed public files and routes.

Audit 19.10, kiosk lane (findings 3.3, 3.4, 4.3): demo mode, a late «Начать заново» on a QR
and the service reset of a stuck kiosk need `POST /v1/kiosk-checkout/staff/verify` (device
credentials only, answer `{valid:true}` or an error code). The installed gateway lists every
kiosk path explicitly, so a new API route stays unreachable until this block is added.
`infra/staging/release-kiosk-checkout.py` cannot add it: it is the one-time installed778
release and refuses any gateway that already holds kiosk checkout routes.

Same guarded pattern as `device-center-gateway.py`: run on the VPS from verified source with
exact successful CI, CAS pins and the shared lock. Only the PickChick gateway is recreated;
no DB, identity, payment or roadmap change. Without this route the kiosk shows «Код
сотрудника не настроен на сервере» and everything else keeps working.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT/'infra/domains/kiosk-staff.Caddyfile'
ROUTE = '/v1/kiosk-checkout/staff/verify'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('kiosk_staff_gateway_parent', ROOT/'infra/roadmap/remote-deploy.py')
p = load('kiosk_staff_gateway_ci', ROOT/'infra/backoffice-login/release.py')
d = load('kiosk_staff_gateway_device_center', ROOT/'infra/public-staging/device-center-gateway.py')
START = '\t# BEGIN KIOSK STAFF CODE\n'
END = '\t# END KIOSK STAFF CODE\n'
compose_candidate, neighbors = d.compose_candidate, d.neighbors


def candidate(original, source):
    r.require(original.count('\n\t@backoffice_get {') == 1, 'Exact route boundary required')
    r.require(ROUTE not in original and START not in original,
              'Staff code route already exists; inspect original outcome')
    r.require(source.count(START) == source.count(END) == 1, 'Source route block missing')
    block = START + source.split(START)[1].split(END)[0] + END
    r.require(block.count('method ') == 1 and '\t\tmethod POST\n' in block and
              block.count('path ' + ROUTE + '\n') == 1 and
              block.count('\t\tpath ') == 1 and 'max_size 1KB' in block and
              'header X-PickChick-Data kiosk' in block and 'header_up -Cookie' in block and
              'header_up -Authorization' in block and 'header_up -X-Device-Id' in block and
              'response_header_timeout 5s' in block,
              'Expected bounded credential-isolated route required')
    anchor = '\t@backoffice_get {'
    result = original.replace(anchor, block + '\n' + anchor, 1)
    r.require(result.replace(block+'\n', '', 1) == original, 'Unrelated route changed')
    return result


def anonymous_answer(status, headers):
    """Through the new route an unauthenticated device gets the API's own 400/401."""
    return status in (400, 401) and headers.get('X-PickChick-Data') == 'kiosk'


def verify(manifest, baseline):
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(r.verify_public_asset, manifest['files'].items()))
    for path, expected in baseline.items():
        response = r.http(path)
        r.require((response[0], response[1]) == expected, 'Existing endpoint changed: '+path)
    r.require(r.http('/health/live')[0] == 200 and r.http('/kitchen-live/health')[0] == 200,
              'Application health changed')
    status, _, headers = r.http(ROUTE, method='POST', body={})
    r.require(anonymous_answer(status, headers), 'Staff code endpoint or device guard failed')


def main(a):
    os.umask(0o077)
    for value in (a.source_sha, a.expected_api_sha, a.expected_public_sha):
        r.require(re.fullmatch('[a-f0-9]{40}', value), 'Exact commit required')
    p.verify_ci(json.loads(a.ci_proof.read_text()), a.source_sha)
    # Source artifact is checked against the caller-provided, locally verified digest.
    r.require(p.digest(SOURCE.read_bytes()) == a.source_config_sha256, 'Source configuration differs')
    a.expected_api_release = str(r.ROOT/'releases'/a.expected_api_sha)
    a.expected_public_release = str(r.ROOT/'public-https/releases'/a.expected_public_sha)
    old, api, before = r.baseline(a)
    original = old/'infra/public-staging/gateway.Caddyfile'
    new_text = candidate(original.read_text(), SOURCE.read_text())
    manifest = r.public_files(old)
    baseline = {path: r.http(path)[:2] for path in ['/v1/capabilities', '/roadmap/health']}
    r.require(all(status == 200 for status, _ in baseline.values()), 'Baseline health failed')
    r.require(r.http(ROUTE, method='POST', body={})[0] == 404, 'Unexpected original route')
    if not a.apply:
        print(json.dumps({'validated': True, 'source_sha': a.source_sha, 'applied': False}))
        return
    outcome = {'source_sha': a.source_sha, 'status': 'preparing'}
    with r.lock(a.source_sha):
        r.require(r.baseline(a) == (old, api, before), 'Baseline drift after lock')
        release = r.ROOT/'public-https/releases'/a.source_sha
        r.require(not release.exists(), 'Immutable candidate already exists')
        target = release/'infra/public-staging'
        target.mkdir(parents=True)
        journal = release/'kiosk-staff-release.json'
        switched = False
        try:
            shutil.copytree(old/'infra/public-staging/public-web', target/'public-web')
            r.require(r.public_files(release) == manifest, 'Public backup/copy differs')
            config = target/'gateway.Caddyfile'
            config.write_text(new_text)
            config.chmod(0o644)
            shutil.copyfile(original, release/'gateway.before')
            r.require((release/'gateway.before').read_bytes() == original.read_bytes(), 'Backup differs')
            old_compose = json.loads(r.run(r.compose(old/'infra/public-staging/compose.yaml')+
                                          ['config', '--format', 'json']))
            new_compose = compose_candidate(old_compose, config, target/'public-web')
            r.save(target/'compose.yaml', new_compose)
            r.save(release/'ci-proof.json', json.loads(a.ci_proof.read_text()))
            r.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                   '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges:true',
                   '--tmpfs', '/tmp', '--tmpfs', '/config', '--tmpfs', '/data',
                   '-v', str(config)+':/etc/caddy/Caddyfile:ro', new_compose['services']['gateway']['image'],
                   'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])
            r.require(r.baseline(a) == (old, api, before), 'Baseline changed during prepare')
            switched = True
            r.run(r.compose(target/'compose.yaml') +
                  ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', 'gateway'], timeout=120)
            r.require(r.gateway_mounts() == {'/etc/caddy/Caddyfile': str(config),
                      '/srv/public': str(target/'public-web')}, 'Candidate mounts differ')
            verify(manifest, baseline)
            neighbors(before)
            r.require(r.pointer(r.ROOT/'current') == api and
                      r.pointer(r.ROOT/'public-https/current') == old, 'Pointer drift')
            r.switch(r.ROOT/'public-https/current', release)
            outcome.update(status='deployed', gateway_sha256=r.digest(config),
                           previous_public_release=str(old), neighbors_preserved=True)
            r.save(journal, outcome)
        except r.Uncertain:
            outcome.update(status='uncertain', lock_retained=True)
            r.save(journal, outcome)
            raise
        except BaseException:
            try:
                if switched:
                    r.run(r.compose(old/'infra/public-staging/compose.yaml')+
                          ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', 'gateway'], timeout=120)
                pointer = r.pointer(r.ROOT/'public-https/current')
                r.require(pointer in (old, release), 'Foreign public pointer')
                if pointer == release:
                    r.switch(r.ROOT/'public-https/current', old)
                r.baseline(a)
                neighbors(before)
                r.require(r.http(ROUTE, method='POST', body={})[0] == 404, 'Rollback route failed')
                outcome.update(status='rolled_back')
                r.save(journal, outcome)
            except BaseException:
                r.save(journal, {**outcome, 'status': 'rollback_unverified', 'lock_retained': True})
                raise
            # Preserve evidence and release only our verified rolled-back lease.
    print(json.dumps(outcome))
    r.require(outcome['status'] == 'deployed', 'Gateway release rolled back')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    for name in ('source-sha', 'source-config-sha256', 'expected-api-sha',
                 'expected-public-sha', 'expected-gateway-sha256'):
        parser.add_argument('--'+name, required=True)
    parser.add_argument('--ci-proof', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    main(parser.parse_args())
