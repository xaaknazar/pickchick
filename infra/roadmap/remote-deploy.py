#!/usr/bin/env python3
"""Inspect or deploy an extracted roadmap package on the existing PickChick VPS.

Only our public gateway and the independent roadmap container may be restarted.
No business database, API, credentials, financial command or neighboring service is changed.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import hashlib
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

ROOT = Path('/opt/pickchick-staging')
STATE = ROOT / 'roadmap'
LOCK = ROOT / '.market-release.lock'
ORIGIN = 'https://pickchick.185.129.51.103.nip.io'
GATEWAY = 'pickchick-public-gateway'
SERVICE = 'pickchick-roadmap'
MARKER_START = '\t# BEGIN PICKCHICK ROADMAP\n'
MARKER_END = '\t# END PICKCHICK ROADMAP\n'
ROUTE = MARKER_START + '''\t@roadmap {
\t\tpath /roadmap /roadmap/*
\t}
\thandle @roadmap {
\t\theader X-PickChick-Data project
\t\treverse_proxy pickchick-roadmap:4192 {
\t\t\theader_up -Authorization
\t\t\theader_up -X-Device-Id
\t\t\ttransport http {
\t\t\t\tdial_timeout 2s
\t\t\t\tresponse_header_timeout 5s
\t\t\t}
\t\t}
\t}
''' + MARKER_END


class Uncertain(RuntimeError):
    """A timed-out Docker command may still be completing; retain the owned lock."""


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(command, timeout=90):
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Uncertain('Command timed out; inspect Docker before any retry') from None
    require(result.returncode == 0, 'Command failed: ' + command[0] + ' (output withheld)')
    return result.stdout.strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    path.chmod(0o600)


def pointer(path):
    require(path.is_symlink(), 'Expected symlink is missing: ' + str(path))
    return path.resolve(strict=True)


def switch(path, target):
    temporary = path.with_name('.' + path.name + '-' + uuid.uuid4().hex)
    temporary.symlink_to(target)
    temporary.replace(path)


def compose(path, env=None):
    return ['docker', 'compose'] + (['--env-file', str(env)] if env else []) + ['-f', str(path)]


def sidecar(release):
    return compose(release / 'infra/roadmap/compose.yaml', release / 'roadmap-release.env')


def remove_failed_first_container(release):
    """Remove only this stopped first-install container; retain all files and volumes."""
    found = run(['docker', 'ps', '-aq', '--filter', 'name=^/' + SERVICE + '$'])
    if not found:
        return
    mounts = json.loads(run(['docker', 'inspect', '--format', '{{json .Mounts}}', SERVICE]))
    require(any(m.get('Destination') == '/app' and m.get('Source') ==
                str(release / 'apps/roadmap') for m in mounts),
            'First-install cleanup refuses a container from another release')
    require(run(['docker', 'inspect', '--format', '{{.State.Running}}', SERVICE]) == 'false',
            'First-install cleanup requires a stopped container')
    # No --force: if something restarted it concurrently, Docker must refuse removal.
    # No --volumes: review metadata and the team key must survive this rollback.
    run(['docker', 'rm', SERVICE])


def containers():
    names = run(['docker', 'ps', '-a', '--format', '{{.Names}}']).splitlines()
    result = {}
    for name in names:
        raw = run(['docker', 'inspect', '--format',
                   '{{.Id}}|{{.Image}}|{{.State.StartedAt}}', name])
        result[name] = raw.split('|')
    return result


def gateway_mounts():
    mounts = json.loads(run(['docker', 'inspect', '--format', '{{json .Mounts}}', GATEWAY]))
    return {m['Destination']: m['Source'] for m in mounts}


def public_files(release):
    web = release / 'infra/public-staging/public-web'
    manifest = json.loads((web / '.release.json').read_text())
    require(isinstance(manifest.get('files'), dict) and manifest['files'], 'Public manifest is empty')
    for name, sha in manifest['files'].items():
        parts = Path(name).parts
        require(not Path(name).is_absolute() and '..' not in parts, 'Unsafe public manifest path')
        target = web / name
        require(target.is_file() and not target.is_symlink() and digest(target) == sha,
                'Existing public asset does not match its manifest')
    return manifest


def verify_package(package, sha):
    require(package.is_dir() and not package.is_symlink(), 'Package must be an extracted directory')
    manifest = json.loads((package / 'roadmap-package.json').read_text())
    require(manifest.get('source_sha') == sha, 'Package source SHA mismatch')
    required = {'apps/roadmap/server.mjs', 'apps/roadmap/model.mjs',
                'apps/roadmap/dist/project.json', 'apps/roadmap/dist/index.html',
                'apps/roadmap/dist/styles.css', 'apps/roadmap/dist/app.js',
                'infra/roadmap/compose.yaml', 'infra/roadmap/remote-deploy.py'}
    files = manifest.get('files', {})
    require(required.issubset(files), 'Package is incomplete')
    for name, expected in files.items():
        path = Path(name)
        require(not path.is_absolute() and '..' not in path.parts and
                (name.startswith('apps/roadmap/') or name.startswith('infra/roadmap/')),
                'Unsafe package path')
        target = package / path
        require(target.is_file() and not any(p.is_symlink() for p in [target, *target.parents]),
                'Package paths must be ordinary files/directories')
        require(digest(target) == expected, 'Package file hash mismatch')
    return manifest


def add_route(source):
    require(source.count(MARKER_START) == source.count(MARKER_END) <= 1, 'Invalid roadmap markers')
    if MARKER_START in source:
        return source[:source.index(MARKER_START)] + ROUTE + source[source.index(MARKER_END) + len(MARKER_END):]
    require('/roadmap' not in source, 'Unrecognized existing roadmap route; review manually')
    location = source.rfind('\n\thandle {')
    require(location >= 0, 'Gateway fallback not found')
    return source[:location] + '\n' + ROUTE + source[location:]


def http(path, *, method='GET', body=None, opener=None):
    headers = {'Origin': ORIGIN}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(ORIGIN + path, method=method, headers=headers,
                                     data=None if body is None else json.dumps(body).encode())
    try:
        with (opener.open(request, timeout=15) if opener else urllib.request.urlopen(request, timeout=15)) as response:
            maximum = 8 * 1024 * 1024
            data = response.read(maximum + 1)
            require(len(data) <= maximum, 'HTTP response exceeds 8 MiB: ' + path)
            return response.status, data, response.headers
    except urllib.error.HTTPError as error:
        return error.code, b'', error.headers


def verify_public_asset(item):
    """Hash complete public files, including videos, without buffering their contents."""
    name, expected = item
    path = '/kiosk' if name == 'operations/index.html' else '/' + name.removeprefix('operations/')
    request = urllib.request.Request(ORIGIN + path)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            status = response.status
            actual = hashlib.sha256()
            while chunk := response.read(1024 * 1024):
                actual.update(chunk)
    except urllib.error.HTTPError as error:
        raise RuntimeError('Existing public HTTP asset unavailable: ' + path +
                           ' (status ' + str(error.code) + ')') from None
    require(status == 200 and actual.hexdigest() == expected,
            'Existing public HTTP asset changed: ' + path + ' (status ' + str(status) + ')')


def verify_public(manifest, sha):
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(verify_public_asset, manifest['files'].items()))
    for path in ['/', '/.release.json', '/roadmap/.env', '/roadmap/server.mjs', '/roadmap/data/roadmap.sqlite']:
        require(http(path)[0] == 404, 'A private path is publicly accessible')
    status, body, _ = http('/roadmap/health')
    require(status == 200 and json.loads(body).get('sourceSha') == sha, 'Public roadmap release mismatch')
    require(http('/roadmap/api/project')[0] == 401, 'Roadmap data must require authentication')
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    key = (STATE / 'secrets/team-key').read_text().strip()
    status, _, headers = http('/roadmap/api/session', method='POST', body={'key': key}, opener=opener)
    require(status in (200, 201, 204), 'Roadmap sign-in smoke failed')
    cookie = headers.get('Set-Cookie', '').lower()
    require('httponly' in cookie and 'secure' in cookie and 'samesite=strict' in cookie and
            'path=/roadmap' in cookie, 'Roadmap session cookie is missing required attributes')
    require(http('/roadmap/api/project', opener=opener)[0] == 200, 'Authenticated roadmap read failed')


@contextmanager
def lock(sha):
    owner = {'id': str(uuid.uuid4()), 'sha': sha, 'action': 'roadmap'}
    LOCK.mkdir(mode=0o700)
    save(LOCK / 'owner.json', owner)
    try:
        yield owner
    except BaseException:
        # Retained unless the caller explicitly proved a complete rollback.
        raise
    else:
        require(json.loads((LOCK / 'owner.json').read_text())['id'] == owner['id'], 'Lock owner changed')
        (LOCK / 'owner.json').unlink()
        LOCK.rmdir()


def baseline(args):
    current = pointer(ROOT / 'public-https/current')
    api = pointer(ROOT / 'current')
    require(current == Path(args.expected_public_release), 'Current public pointer changed')
    require(api == Path(args.expected_api_release), 'Current API pointer changed')
    config = current / 'infra/public-staging/gateway.Caddyfile'
    require(digest(config) == args.expected_gateway_sha256, 'Current gateway configuration changed')
    mounts = gateway_mounts()
    require(mounts.get('/etc/caddy/Caddyfile') == str(config) and
            mounts.get('/srv/public') == str(current / 'infra/public-staging/public-web'),
            'Gateway mounts disagree with the current public pointer')
    public_files(current)
    return current, api, containers()


def unchanged(before):
    now = containers()
    for name, identity in before.items():
        if name not in (GATEWAY, SERVICE):
            require(now.get(name) == identity, 'A service outside roadmap/gateway changed')


def apply(args, package_manifest):
    source_sha = args.expected_source_sha
    outcome = {'source_sha': source_sha, 'status': 'preparing'}
    journal = STATE / 'deployments' / (source_sha + '-' + uuid.uuid4().hex + '.json')
    with lock(source_sha):
        old_public, old_api, before = baseline(args)
        old_roadmap = pointer(STATE / 'current') if (STATE / 'current').is_symlink() else None
        require((SERVICE in before) == (old_roadmap is not None), 'Roadmap container/current pointer disagree')
        if old_roadmap:
            mounts = json.loads(run(['docker', 'inspect', '--format', '{{json .Mounts}}', SERVICE]))
            require(any(m.get('Destination') == '/app' and m.get('Source') ==
                        str(old_roadmap / 'apps/roadmap') for m in mounts), 'Roadmap app mount mismatch')
        release = STATE / 'releases' / source_sha
        new_public = ROOT / 'public-https/releases' / source_sha
        require(not release.exists() and not new_public.exists(), 'Immutable release already exists')
        switched_gateway = False
        touched_sidecar = False
        try:
            outcome['phase'] = 'prepare_releases'
            os.umask(0o077)
            for directory in [STATE, STATE / 'data', STATE / 'secrets', STATE / 'backups']:
                directory.mkdir(parents=True, exist_ok=True, mode=0o700)
                require(not directory.is_symlink(), 'State directory must not be a symlink')
                require(directory.stat().st_uid == 1000, 'State must be owned by UID 1000')
                directory.chmod(0o700)
            key_file = STATE / 'secrets/team-key'
            if not key_file.exists():
                with key_file.open('x') as output:
                    output.write(secrets.token_urlsafe(32) + '\n')
            require(key_file.is_file() and not key_file.is_symlink() and key_file.stat().st_uid == 1000,
                    'Team key must be an ordinary owner-only file')
            key_file.chmod(0o600)
            for name in package_manifest['files']:
                target = release / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(args.package / name, target)
                target.chmod(0o644)
            for directory in (release / 'apps').rglob('*'):
                if directory.is_dir():
                    directory.chmod(0o755)
            (release / 'apps/roadmap').chmod(0o755)
            save(release / 'roadmap-package.json', package_manifest)
            (release / 'roadmap-release.env').write_text(
                'ROADMAP_APP_DIR=' + str(release / 'apps/roadmap') + '\n' +
                'ROADMAP_STATE_ROOT=' + str(STATE) + '\nROADMAP_ORIGIN=' + ORIGIN + '\n')
            manifest = public_files(old_public)
            candidate = new_public / 'infra/public-staging'
            candidate.mkdir(parents=True)
            shutil.copytree(old_public / 'infra/public-staging/public-web', candidate / 'public-web')
            old_config = old_public / 'infra/public-staging/gateway.Caddyfile'
            config = candidate / 'gateway.Caddyfile'
            config.write_text(add_route(old_config.read_text()))
            config.chmod(0o644)
            gateway_compose = json.loads(run(compose(old_public / 'infra/public-staging/compose.yaml') +
                                             ['config', '--format', 'json']))
            gateway = gateway_compose['services']['gateway']
            gateway.setdefault('networks', {})['roadmap_ingress'] = None
            gateway_compose.setdefault('networks', {})['roadmap_ingress'] = {
                'name': 'pickchick-roadmap_ingress', 'external': True}
            for volume in gateway['volumes']:
                if volume['target'] == '/etc/caddy/Caddyfile':
                    volume['source'] = str(config)
                elif volume['target'] == '/srv/public':
                    volume['source'] = str(candidate / 'public-web')
            save(candidate / 'compose.yaml', gateway_compose)
            public_files(new_public)
            run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                 '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges:true',
                 '--tmpfs', '/tmp', '--tmpfs', '/config', '--tmpfs', '/data',
                 '-v', str(config) + ':/etc/caddy/Caddyfile:ro', gateway['image'],
                 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])
            baseline(args)
            outcome['phase'] = 'backup_and_start_roadmap'
            if old_roadmap:
                touched_sidecar = True
                run(sidecar(old_roadmap) + ['stop', '--timeout', '15', 'roadmap'])
                running = run(['docker', 'inspect', '--format', '{{.State.Running}}', SERVICE])
                require(running == 'false', 'Roadmap must be stopped before SQLite snapshot')
                require(not any(path.is_symlink() for path in (STATE / 'data').rglob('*')),
                        'SQLite state snapshot must not follow symlinks')
                backup = STATE / 'backups' / (source_sha + '-' + uuid.uuid4().hex)
                shutil.copytree(STATE / 'data', backup)
                outcome['previous_state_backup'] = str(backup)
            touched_sidecar = True
            run(sidecar(release) + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', 'roadmap'], timeout=180)
            raw = run(['docker', 'exec', SERVICE, 'node', '-e',
                       "fetch('http://127.0.0.1:4192/roadmap/health').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())})"])
            require(json.loads(raw).get('sourceSha') == source_sha, 'Container source SHA mismatch')
            outcome['phase'] = 'switch_gateway'
            switched_gateway = True
            run(compose(candidate / 'compose.yaml') + ['up', '-d', '--no-deps', '--wait',
                                                       '--wait-timeout', '60', 'gateway'], timeout=120)
            require(gateway_mounts().get('/etc/caddy/Caddyfile') == str(config), 'New gateway mount mismatch')
            outcome['phase'] = 'verify_public'
            verify_public(manifest, source_sha)
            unchanged(before)
            require(pointer(ROOT / 'current') == old_api, 'API pointer changed')
            require(pointer(ROOT / 'public-https/current') == old_public, 'Public pointer changed concurrently')
            outcome['phase'] = 'publish_pointers'
            switch(STATE / 'current', release)
            switch(ROOT / 'public-https/current', new_public)
            outcome.update(status='deployed', public_release=str(new_public),
                           app_release=str(release), previous_public_release=str(old_public),
                           gateway_sha256=digest(config), public_manifest_sha256=digest(candidate / 'public-web/.release.json'),
                           unchanged_services=[n for n in before if n not in (GATEWAY, SERVICE)])
            save(journal, outcome)
        except Uncertain:
            outcome.update(status='uncertain', lock_retained=True)
            save(journal, outcome)
            raise
        except BaseException as error:
            try:
                if switched_gateway:
                    run(compose(old_public / 'infra/public-staging/compose.yaml') +
                        ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', 'gateway'], timeout=120)
                if touched_sidecar:
                    if old_roadmap:
                        run(sidecar(old_roadmap) + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', 'roadmap'], timeout=120)
                    else:
                        run(sidecar(release) + ['stop', '--timeout', '15', 'roadmap'])
                        remove_failed_first_container(release)
                if (STATE / 'current').is_symlink() and pointer(STATE / 'current') == release:
                    if old_roadmap:
                        switch(STATE / 'current', old_roadmap)
                    else:
                        (STATE / 'current').unlink()
                if pointer(ROOT / 'public-https/current') == new_public:
                    switch(ROOT / 'public-https/current', old_public)
                baseline(args)
                unchanged(before)
                outcome.update(status='rolled_back', reason=type(error).__name__,
                               detail=str(error), data_restored=False)
                save(journal, outcome)
            except BaseException:
                outcome.update(status='rollback_needs_review', lock_retained=True)
                save(journal, outcome)
                raise RuntimeError('Rollback is not confirmed; deployment lock retained') from None
            # Normal context exit releases only our lock after verified rollback.
    print(json.dumps(outcome))
    return 0 if outcome['status'] == 'deployed' else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', required=True, type=Path)
    parser.add_argument('--expected-source-sha', required=True)
    parser.add_argument('--expected-public-release', required=True)
    parser.add_argument('--expected-api-release', required=True)
    parser.add_argument('--expected-gateway-sha256', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    require(os.getuid() == 1000, 'Run as pickchick-ops (UID 1000), not root')
    require(re.fullmatch('[a-f0-9]{40}', args.expected_source_sha), 'Expected full source SHA')
    require(re.fullmatch('[a-f0-9]{64}', args.expected_gateway_sha256), 'Expected gateway SHA-256')
    args.package = args.package.absolute()
    manifest = verify_package(args.package, args.expected_source_sha)
    current, api, before = baseline(args)
    if not args.apply:
        print(json.dumps({'status': 'inspected', 'source_sha': args.expected_source_sha,
                          'current_public_release': str(current), 'current_api_release': str(api),
                          'gateway_sha256': args.expected_gateway_sha256,
                          'roadmap_installed': SERVICE in before, 'deployment_lock_present': LOCK.exists()}))
        return 0
    return apply(args, manifest)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, ValueError, KeyError, OSError) as error:
        # No subprocess logs, server payloads, session cookies or credentials in stdout.
        print(json.dumps({'status': 'failed', 'reason': str(error)}), file=sys.stderr)
        sys.exit(1)
