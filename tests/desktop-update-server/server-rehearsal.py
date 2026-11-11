#!/usr/bin/env python3
"""Rehearsal of infra/desktop-updates/remote-deploy.py with real Docker and the pinned Caddy image.

Builds a throw-away copy of the server layout: the public gateway of infra/public-staging and a
stand-in for the outer HTTPS proxy. Then runs what the operator runs: a failed install that must
roll back, the install, the updater of the programs reading the feed through the gateway, a publish
that must not restart anything, refusals and a withdraw. Linux with Docker and a clean committed
checkout only (CI); nothing outside the temporary directory and four named containers/networks.

    python3 tests/desktop-update-server/server-rehearsal.py
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

REPO = Path(__file__).resolve().parents[2]
PORT = 18443
ORIGIN = 'http://127.0.0.1:%d' % PORT
OUTER = 'pickchick-rehearsal-outer'
NETWORKS = ['deploy_default', 'pickchick-staging_ingress']
POS_BYTES = 64 * 1024 * 1024 + 123
KITCHEN_BYTES = 9_500_000


def sh(command, check=True, **options):
    result = subprocess.run(command, text=True, capture_output=True, **options)
    if check and result.returncode != 0:
        raise RuntimeError('Command failed: %s\n%s\n%s' % (' '.join(map(str, command)), result.stdout, result.stderr))
    return result.stdout.strip()


def step(text):
    print('[rehearsal] ' + text, flush=True)


def identity(name):
    return sh(['docker', 'inspect', '--format', '{{.Id}} {{.State.StartedAt}}', name])


def status(path):
    request = urllib.request.Request(ORIGIN + path)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def fake_installer(directory, app, version, size, prefix):
    data = b'MZ' + os.urandom(size - 2)
    directory.mkdir(parents=True, exist_ok=True)
    name = prefix + version + '-x64.exe'
    (directory / name).write_bytes(data)
    return directory / name, hashlib.sha256(data).hexdigest()


def client(app, current, expect, sha256=None):
    command = ['node', 'tests/desktop-update-server/feed-client.mjs', '--feed', ORIGIN + '/desktop-updates/',
               '--app', app, '--current', current, '--expect', expect]
    if sha256:
        command += ['--sha256', sha256]
    report = json.loads(sh(command, cwd=REPO).splitlines()[-1])
    step('program %s %s: %s, %d pieces' % (app, current, report['result'], report['pieces']))
    return report


def main():
    temporary = Path(tempfile.mkdtemp(prefix='pickchick-feed-rehearsal-'))
    root = temporary / 'server'
    old_public = root / 'public-https/releases' / ('a' * 40)
    staging = old_public / 'infra/public-staging'
    api = root / 'releases' / ('b' * 40)
    image = re.search(r'^\s+image: (\S+)$', (REPO / 'infra/public-staging/compose.yaml').read_text(), re.M).group(1)
    summary = {}
    try:
        step('server layout with the repository gateway, image ' + image)
        (staging / 'public-web/operations/assets').mkdir(parents=True)
        files = {'operations/index.html': b'<!doctype html><title>kiosk</title>',
                 'operations/assets/app.js': b'console.log("rehearsal")'}
        for name, data in files.items():
            (staging / 'public-web' / name).write_bytes(data)
        (staging / 'public-web/.release.json').write_text(json.dumps({
            'source_sha': 'a' * 40, 'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}))
        for name in ['gateway.Caddyfile', 'compose.yaml']:
            shutil.copyfile(REPO / 'infra/public-staging' / name, staging / name)
        api.mkdir(parents=True)
        (root / 'current').symlink_to(api)
        (root / 'public-https/current').symlink_to(old_public)
        for network in NETWORKS:
            sh(['docker', 'network', 'create', network])
        sh(['docker', 'compose', '-f', str(staging / 'compose.yaml'), 'up', '-d', '--wait', 'gateway'])
        outer = temporary / 'outer.Caddyfile'
        outer.write_text('{\n\tadmin off\n\tauto_https off\n}\n:8080 {\n\treverse_proxy pickchick-public-gateway:8080 {\n'
                         '\t\theader_up Host pickchick.185.129.51.103.nip.io\n\t}\n}\n')
        sh(['docker', 'run', '-d', '--name', OUTER, '--network', 'deploy_default',
            '-p', '127.0.0.1:%d:8080' % PORT, '-v', str(outer) + ':/etc/caddy/Caddyfile:ro', image,
            'caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])
        for _ in range(30):
            with contextlib.suppress(OSError):
                if status('/health/live') == 200:
                    break
            time.sleep(1)
        else:
            raise RuntimeError('Gateway did not answer through the outer proxy')

        step('package of this commit and the feeds')
        archive = temporary / 'package.tar.gz'
        packaged = json.loads(sh([sys.executable, 'infra/desktop-updates/package.py', str(archive)], cwd=REPO))
        package = temporary / 'package'
        with tarfile.open(archive) as source:
            source.extractall(package, filter='data')
        spec = importlib.util.spec_from_file_location('desktop_updates', package / 'infra/desktop-updates/remote-deploy.py')
        d = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(d)
        d.b.ROOT, d.b.LOCK, d.b.ORIGIN, d.FEED_ORIGIN = root, root / '.market-release.lock', ORIGIN, ORIGIN
        d.os.getuid = lambda: 1000

        made = temporary / 'made'
        feed1, hashes1 = temporary / 'feed-1', {}
        for app, size, package_directory in [('pos', POS_BYTES, 'apps/pos-desktop'),
                                             ('kitchen', KITCHEN_BYTES, 'apps/kitchen-desktop')]:
            version = json.loads((REPO / package_directory / 'package.json').read_text())['version']
            path, hashes1[app] = fake_installer(made, app, version, size, d.APPS[app])
            # The same script the Windows build runs.
            sh(['node', 'scripts/desktop-update-feed.mjs', '--app', app, '--installer', str(path),
                '--out', str(feed1)], cwd=REPO)
        versions = {app: json.loads((feed1 / app / 'latest.json').read_text())['version'] for app in hashes1}
        first = 'kitchen-%s-pos-%s' % (versions['kitchen'], versions['pos'])
        kitchen_next = '.'.join(versions['kitchen'].split('.')[:2] + [str(int(versions['kitchen'].split('.')[2]) + 1)])
        feed2 = temporary / 'feed-2'
        path, kitchen_hash = fake_installer(feed2 / 'kitchen', 'kitchen', kitchen_next, KITCHEN_BYTES, d.APPS['kitchen'])
        (feed2 / 'kitchen/latest.json').write_text(json.dumps({
            'app': 'kitchen', 'version': kitchen_next, 'file': path.name, 'sha256': kitchen_hash,
            'bytes': KITCHEN_BYTES, 'apply': 'idle'}, indent=2) + '\n')
        second = 'kitchen-%s-pos-%s' % (kitchen_next, versions['pos'])

        def run(arguments, expect=0):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = d.main(arguments)
            report = json.loads(output.getvalue().strip().splitlines()[-1])
            if code != expect:
                raise RuntimeError('%s ended %d: %s' % (arguments[0], code, json.dumps(report)))
            return report

        expected1 = ['--expected-pos-sha256', hashes1['pos'], '--expected-kitchen-sha256', hashes1['kitchen']]
        report = run(['inspect', '--feed', str(feed1)] + expected1)
        assert (report['gateway_route_installed'], report['feed_container'], report['next_step']) == (False, False, 'install')
        assert report['feed_host_reaches_gateway'] is True
        install = ['install', '--package', str(package), '--feed', str(feed1),
                   '--expected-source-sha', packaged['source_sha'],
                   '--expected-public-release', report['expected_public_release'],
                   '--expected-api-release', report['expected_api_release'],
                   '--expected-gateway-sha256', report['expected_gateway_sha256']] + expected1
        assert run(install)['status'] == 'inspected'
        gateway_before = identity('pickchick-public-gateway')
        assert identity('pickchick-public-gateway') == gateway_before and status('/desktop-updates/pos/latest.json') == 404

        step('install that fails its last check must put the old gateway back')
        real_refusals = d.verify_refusals

        def injected(origin, manifests):
            raise RuntimeError('rehearsal: injected failure after the gateway switch')

        d.verify_refusals = injected
        report = run(install + ['--apply'], expect=1)
        d.verify_refusals = real_refusals
        assert report['status'] == 'rolled_back' and report['phase'] == 'verify', report
        assert status('/desktop-updates/pos/latest.json') == 404 and status('/health/live') == 200
        assert status('/kiosk') == 200 and status('/assets/app.js') == 200
        names = sh(['docker', 'ps', '-a', '--format', '{{.Names}}']).splitlines()
        assert d.SIDECAR not in names, names
        assert d.NETWORK not in sh(['docker', 'network', 'ls', '--format', '{{.Name}}']).splitlines()
        assert (root / 'public-https/current').resolve() == old_public and not d.b.LOCK.exists()
        summary['failed_install_rolled_back'] = True

        step('install')
        report = run(install + ['--apply'])
        assert report['status'] == 'deployed', report
        summary['install'] = report['published']
        assert status('/kiosk') == 200 and status('/assets/app.js') == 200 and status('/health/live') == 200
        inspected = json.loads(sh(['docker', 'inspect', d.SIDECAR]))[0]
        assert inspected['HostConfig']['ReadonlyRootfs'] and not inspected['HostConfig']['PortBindings']
        assert list(inspected['NetworkSettings']['Networks']) == [d.NETWORK]
        assert all(not mount['RW'] for mount in inspected['Mounts'])
        pos = client('pos', '0.4.9', versions['pos'], hashes1['pos'])
        assert pos['pieces'] == -(-POS_BYTES // d.CHUNK_BYTES), pos
        client('kitchen', '0.3.0', versions['kitchen'], hashes1['kitchen'])
        client('pos', versions['pos'], 'current')
        summary['program_read_feed_in_pieces'] = pos['pieces']

        step('a whole installer in one slow response: the gateway write limit')
        started = time.time()
        slow = subprocess.run(['curl', '-s', '-o', '/dev/null', '--limit-rate', '400k', '--max-time', '90',
                               '-w', '%{size_download}', ORIGIN + '/desktop-updates/pos/' + d.APPS['pos'] +
                               versions['pos'] + '-x64.exe'], text=True, capture_output=True)
        summary['slow_whole_response'] = {'curl_exit': slow.returncode, 'bytes': int(slow.stdout or 0),
                                          'of': POS_BYTES, 'seconds': round(time.time() - started)}
        step(json.dumps(summary['slow_whole_response']))

        step('publish: one pointer, no container restarts')
        before = {name: identity(name) for name in ['pickchick-public-gateway', d.SIDECAR, OUTER]}
        publish = ['publish', '--feed', str(feed2), '--expected-current', first, '--expected-kitchen-sha256', kitchen_hash]
        assert run(publish)['status'] == 'inspected' and os.readlink(root / 'desktop-updates/feed/current') == 'releases/' + first
        report = run(publish + ['--apply'])
        assert report['status'] == 'deployed' and report['feed_release'] == second, report
        assert before == {name: identity(name) for name in before}
        client('kitchen', versions['kitchen'], kitchen_next, kitchen_hash)
        client('pos', versions['pos'], 'current')
        assert status('/desktop-updates/kitchen/' + d.APPS['kitchen'] + versions['kitchen'] + '-x64.exe') == 404
        summary['publish'] = report['published']

        step('refusals')
        for arguments, reason in [
                (publish + ['--apply'], 'not --expected-current'),
                (['publish', '--feed', str(feed2), '--expected-current', second,
                  '--expected-kitchen-sha256', kitchen_hash, '--apply'], 'higher than the published'),
                (['publish', '--feed', str(feed2), '--expected-current', second,
                  '--expected-kitchen-sha256', 'f' * 64], 'operator named'),
                (install + ['--apply'], 'Current public pointer changed')]:
            try:
                run(arguments)
            except RuntimeError as error:
                assert reason in str(error), (reason, str(error))
            else:
                raise AssertionError('Not refused: ' + reason)
        for path in ['/desktop-updates/', '/desktop-updates/pos/', '/desktop-updates/releases/',
                     '/desktop-updates/current/pos/latest.json', '/desktop-updates/pos/latest.json.tmp']:
            assert status(path) == 404, path
        assert before == {name: identity(name) for name in before}

        step('withdraw')
        report = run(['withdraw', '--to', first, '--expected-current', second, '--apply'])
        assert report['status'] == 'deployed'
        client('kitchen', versions['kitchen'], 'current')
        assert before == {name: identity(name) for name in before}
        report = run(['inspect'])
        assert report['published_release'] == first and report['releases_on_disk'] == sorted([first, second])
        assert report['gateway_route_installed'] and report['feed_container'] and not report['deployment_lock_present']
        summary['withdraw'] = report['published']
        summary['ok'] = True
    finally:
        step('cleanup')
        for command in [
                ['docker', 'rm', '-f', OUTER],
                ['docker', 'rm', '-f', 'pickchick-public-gateway', 'pickchick-desktop-updates'],
                ['docker', 'network', 'rm', 'pickchick-desktop-updates_ingress'] + NETWORKS]:
            sh(command, check=False)
        shutil.rmtree(temporary, ignore_errors=True)
    print(json.dumps(summary, indent=2))
    return 0 if summary.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())
