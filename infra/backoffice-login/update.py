#!/usr/bin/env python3
"""Update only the existing staff portal, retaining the stopped old container for rollback.

Exact green CI, immutable manifest, explicit baseline, private backup, CAS and shared lock.
No API/DB/public release, credential changes or Caddy reload. Run --help for arguments.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import time
import uuid

spec = importlib.util.spec_from_file_location('portal_release', Path(__file__).with_name('release.py'))
portal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portal)
d = portal.domain
NAME = 'pickchick-staff-login'
NETWORKS = {'deploy_default', 'pickchick-staging_ingress'}


def inspect(name):
    return json.loads(d.run(['docker', 'inspect', name]))[0]


def healthy(name):
    for _ in range(30):
        state = inspect(name)['State']
        if state.get('Health', {}).get('Status') == 'healthy':
            return
        d.require(state['Running'] and state.get('Health', {}).get('Status') != 'unhealthy', 'Portal unhealthy')
        time.sleep(1)
    raise RuntimeError('Portal health timed out')


def verify_artifact(root, sha):
    manifest = json.loads((root/'portal-manifest.json').read_text())
    d.require(manifest['source_sha'] == sha, 'Manifest source mismatch')
    for path, checksum in manifest['files'].items():
        f = root/path
        d.require(not Path(path).is_absolute() and '..' not in Path(path).parts and not f.is_symlink(), 'Invalid artifact path')
        d.require(d.digest(f.read_bytes()) == checksum, 'Artifact checksum mismatch')
    for required in ['apps/backoffice/dist/workspace.css', 'apps/backoffice/dist/assets/logo.png']:
        d.require(required in manifest['files'], 'Required design asset missing')


def portal_http():
    status, _, body = d.http('https://pickchick.kz/backoffice/auth/session')
    d.require(status == 200 and json.loads(body) == {'enabled': True, 'authenticated': False}, 'Session guard failed')
    d.require(d.http('https://pickchick.kz/backoffice/api/v1/admin/catalog/branches')[0] == 401, 'Anonymous API exposed')
    d.require(d.http('https://pickchick.kz/backoffice/')[0] == 200, 'Portal unavailable')


def replace_container(old_name, create, verify, rollback_verify):
    """Keep the original runtime untouched until ready; roll back any known failure."""
    renamed = created = False
    try:
        d.run(['docker', 'stop', NAME])
        d.run(['docker', 'rename', NAME, old_name])
        renamed = True
        create()
        created = True
        d.run(['docker', 'network', 'connect', 'pickchick-staging_ingress', NAME])
        d.run(['docker', 'start', NAME])
        healthy(NAME)
        verify()
    except d.Uncertain:
        raise  # State must be inspected; caller retains deployment lock.
    except Exception:
        try:
            if created:
                d.run(['docker', 'rm', '-f', NAME])
            if renamed:
                d.run(['docker', 'rename', old_name, NAME])
            d.run(['docker', 'start', NAME])
            healthy(NAME)
            rollback_verify()
        except Exception:
            raise d.Uncertain('Rollback unverified; deployment lock retained') from None
        raise


def main(a):
    os.umask(0o077)
    for sha in [a.source_sha, a.expected_portal_sha, a.expected_api_sha, a.expected_public_sha]:
        d.require(re.fullmatch('[a-f0-9]{40}', sha), 'Invalid SHA')
    portal.verify_ci(json.loads(a.ci_proof.read_text()), a.source_sha)
    root = Path(__file__).resolve().parents[2]
    verify_artifact(root, a.source_sha)
    d.guards(a)
    front = d.FRONT.read_bytes()
    d.require(d.digest(front) == a.expected_front_hash, 'Front changed')
    before = d.containers()
    neighbor = d.baseline_http()
    old = inspect(NAME)
    d.require(old['Config']['Image'] == 'pickchick-staff-login:'+a.expected_portal_sha, 'Portal source changed')
    d.require(old['State']['Running'] and old['State']['Health']['Status'] == 'healthy', 'Existing portal unhealthy')
    d.require(set(old['NetworkSettings']['Networks']) == NETWORKS, 'Portal networks differ')
    d.require(old['HostConfig']['ReadonlyRootfs'] and not old['HostConfig']['PortBindings'], 'Portal isolation differs')
    private = Path('/opt/pickchick-staging/secrets/backoffice-ceo.json')
    d.require(private.is_file() and not private.is_symlink() and private.stat().st_mode & 0o077 == 0, 'Private config permissions differ')
    expected_mount = [m for m in old['Mounts'] if m['Source'] == str(private) and m['Destination'] == '/run/ceo.json' and not m['RW']]
    d.require(len(expected_mount) == len(old['Mounts']) == 1, 'Portal mount differs')
    private_hash = d.digest(private.read_bytes())
    def unchanged():
        d.guards(a)
        d.require(d.FRONT.read_bytes() == front and d.containers() == before, 'Existing services changed')
        d.require(d.digest(private.read_bytes()) == private_hash, 'Credentials changed')
        d.require(d.baseline_http() == neighbor, 'Neighbor or payment capabilities changed')
    if not a.apply:
        print(json.dumps({'validated': True, 'source_sha': a.source_sha, 'existing_portal_sha': a.expected_portal_sha})); return
    owner = {'id': str(uuid.uuid4()), 'task': 'backoffice-mobbin', 'source_sha': a.source_sha}
    d.LOCK.mkdir(mode=0o700)
    (d.LOCK/'owner.json').write_text(json.dumps(owner))
    unlock = True
    try:
        unchanged()
        d.require(inspect(NAME)['Id'] == old['Id'], 'Portal changed after lock')
        release = d.ROOT/'backoffice-login'/a.source_sha
        release.mkdir(parents=True, exist_ok=False)
        # Contains configuration metadata; kept private and out of Git/report output.
        (release/'portal.before.json').write_text(json.dumps(old))
        (release/'credentials.before.json').write_bytes(private.read_bytes())
        (release/'front.before').write_bytes(front)
        (release/'ci-proof.json').write_bytes(a.ci_proof.read_bytes())
        (release/'portal-manifest.json').write_bytes((root/'portal-manifest.json').read_bytes())
        image = 'pickchick-staff-login:'+a.source_sha
        d.run(['docker', 'build', '--build-arg', 'RELEASE_SHA='+a.source_sha, '-t', image, '-f', str(root/'infra/backoffice-login/Dockerfile'), str(root/'apps/backoffice')])
        unchanged()
        d.require(inspect(NAME)['Id'] == old['Id'], 'Portal changed before replacement')
        rollback_name = NAME+'-backup-'+a.source_sha[:12]
        def create():
            d.run(['docker', 'create', '--name', NAME, '--restart', 'unless-stopped',
                   '--network', 'deploy_default', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                   '--memory', '512m', '--cpus', '1', '--pids-limit', '64', '--user', f'{private.stat().st_uid}:{private.stat().st_gid}',
                   '--mount', f'type=bind,src={private},dst=/run/ceo.json,readonly', '-e', 'BACKOFFICE_STAFF_FILE=/run/ceo.json',
                   '-e', 'BACKOFFICE_API_PORT=3100', '--health-cmd', 'node staff-health.mjs', '--health-interval', '10s',
                   '--health-timeout', '5s', '--health-retries', '3', image])
        def verify():
            unchanged()
            portal_http()
            for path in ['workspace.css', 'assets/logo.png']:
                status, _, body = d.http('https://pickchick.kz/backoffice/'+path)
                d.require(status == 200 and d.digest(body) == d.digest((root/'apps/backoffice/dist'/path).read_bytes()), 'Published asset differs')
        replace_container(rollback_name, create, verify, lambda: (unchanged(), portal_http()))
        result = {'source_sha': a.source_sha, 'previous_sha': a.expected_portal_sha, 'rollback_container': rollback_name,
                  'url': 'https://pickchick.kz/backoffice/', 'healthy': True, 'assets_verified': True,
                  'api_database_credentials_ingress_unchanged': True, 'existing_services_preserved': True}
        (release/'result.json').write_text(json.dumps(result, indent=2)+'\n')
        print(json.dumps(result))
    except d.Uncertain:
        unlock = False
        raise
    finally:
        if unlock:
            d.require(json.loads((d.LOCK/'owner.json').read_text()) == owner, 'Lock owner changed')
            (d.LOCK/'owner.json').unlink()
            d.LOCK.rmdir()


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for name in ['source-sha', 'expected-portal-sha', 'expected-api-sha', 'expected-public-sha', 'expected-front-hash', 'expected-gateway-hash']:
        p.add_argument('--'+name, required=True)
    p.add_argument('--ci-proof', type=Path, required=True)
    p.add_argument('--apply', action='store_true')
    main(p.parse_args())
