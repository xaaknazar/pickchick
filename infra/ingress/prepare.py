#!/usr/bin/env python3
"""Prepare private candidate files on VPS only. No network/container changes or key export.

Requires the shared lock and exact inspected hashes/CI. Separate from cutover. The
receipt must be completed with successful route baselines before --check can pass.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import uuid

from plan import IMAGE, NETWORK, digest, gateway, gateway_compose, require, sites, tls_allowed, tls_guard
from switch import HERE, INGRESS, LOCK, OLD, ROOT, identities, inspect, run, save, source_guard


def main(a):
    os.umask(0o077)
    require(ROOT.is_dir(), 'VPS-local preparation only')
    source_guard(a.sha, a.ci_proof, a.source_manifest)
    current = (ROOT / 'public-https/current').resolve(strict=True)
    require(current.name == a.expected_public_sha, 'Public release changed')
    front = Path('/opt/idrink/deploy/Caddyfile').read_bytes()
    public = sites(front, a.expected_front_sha256)
    original = (current / 'infra/public-staging/gateway.Caddyfile').read_bytes()
    transformed = gateway(original, a.expected_gateway_sha256)
    old = inspect(OLD)
    require(old['Image'] == IMAGE.split('@')[1] and old['State']['Running'], 'Old ingress differs')
    old_compose = current / 'infra/public-staging/compose.yaml'
    require(digest(old_compose.read_bytes()) == a.expected_compose_sha256, 'Compose CAS differs')
    before = identities()
    folder = INGRESS / 'releases' / a.sha
    target = ROOT / 'public-https/releases' / a.sha
    require(not folder.exists() and not target.exists(), 'Immutable candidate already exists')
    names = run(['docker', 'exec', OLD, 'find', '/data', '-type', 'f']).decode().splitlines()
    selected = [n.removeprefix('/data/') for n in names if tls_allowed(n.removeprefix('/data/'))]
    tls_guard(selected)
    config = json.loads(run(['docker', 'compose', '-f', str(old_compose), 'config', '--format', 'json']))
    candidate = gateway_compose(config, target / 'infra/public-staging/gateway.Caddyfile')
    LOCK.mkdir(mode=0o700)
    owner = {'id': str(uuid.uuid4()), 'sha': a.sha, 'action': 'own-ingress-prepare'}
    save(LOCK / 'owner.json', owner)
    # Failure retains this owned lock; no live service or pointer has changed.
    require(digest(Path('/opt/idrink/deploy/Caddyfile').read_bytes()) == a.expected_front_sha256 and
            identities() == before, 'Drift after lock')
    folder.mkdir(parents=True, mode=0o700)
    web = target / 'infra/public-staging'
    web.mkdir(parents=True, mode=0o755)
    (folder / 'data').mkdir(mode=0o700);(folder / 'config').mkdir(mode=0o700)
    (folder / 'Caddyfile').write_bytes(public)
    os.chmod(folder / 'Caddyfile', 0o644)
    (folder / 'runtime.env').write_text(f'INGRESS_UID={os.getuid()}\nINGRESS_GID={os.getgid()}\n')
    shutil.copyfile(HERE / 'compose.yaml', folder / 'compose.yaml')
    (folder / 'gateway.Caddyfile').write_bytes(transformed)
    save(folder / 'gateway-compose.json', candidate)
    (web / 'gateway.Caddyfile').write_bytes(transformed)
    # Caddy's rootless/read-only profile still needs read permission on its config.
    os.chmod(web / 'gateway.Caddyfile', 0o644)
    shutil.copyfile(folder / 'gateway-compose.json', web / 'compose.yaml')
    shutil.copytree(current / 'infra/public-staging/public-web', web / 'public-web')
    hashes = {}
    for relative in selected:
        dest = folder / 'data' / relative
        dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        content = run(['docker', 'exec', OLD, 'cat', '/data/' + relative])
        with dest.open('xb') as f:
            os.chmod(dest, 0o600);f.write(content)
        hashes[relative] = digest(content)
    # Recursive directory permissions include intermediate ACME directories.
    for p in (folder / 'data').rglob('*'):
        if p.is_dir():os.chmod(p, 0o700)
    require(identities() == before, 'Neighbor drift during prepare')
    receipt = {'source_sha': a.sha, 'prepared_at': datetime.now(timezone.utc).isoformat(),
               'front_sha256': a.expected_front_sha256, 'gateway_sha256': a.expected_gateway_sha256,
               'gateway_compose_sha256': a.expected_compose_sha256,
               'old_container_id': old['Id'], 'gateway_container_id': inspect('pickchick-public-gateway')['Id'],
               'public_release': str(current), 'neighbors': before, 'tls_files': hashes,
               'cutover_date_almaty': None, 'observation_mode': 'manual-30min', 'http_checks': []}
    save(folder / 'receipt.json', receipt)
    require(json.loads((LOCK / 'owner.json').read_text()) == owner, 'Lock owner changed')
    (LOCK / 'owner.json').unlink();LOCK.rmdir()
    print(json.dumps({'prepared': True, 'candidate': str(folder), 'live_switch': False,
                      'ready_to_cutover': False, 'next': 'Record healthy route baselines, then --check'}))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for name in ['sha', 'expected-public-sha', 'expected-front-sha256',
                 'expected-gateway-sha256', 'expected-compose-sha256']:
        p.add_argument('--' + name, required=True)
    p.add_argument('--ci-proof', type=Path, required=True)
    p.add_argument('--source-manifest', type=Path, required=True)
    try:main(p.parse_args())
    except BaseException:
        raise SystemExit('STOP: preparation guard failed; inspect protected candidate and owned lock.') from None
