import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('desktop_updates', ROOT / 'infra/desktop-updates/remote-deploy.py')
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
b = d.b

GATEWAY_IMAGE = 'caddy:pinned'


def installer(seed, size=1_200_000):
    return (b'MZ' + hashlib.sha256(seed.encode()).digest() * (size // 32 + 1))[:size]


def write_app(directory, app, version, seed=None, apply=None):
    data = installer(seed or app + version)
    directory.mkdir(parents=True, exist_ok=True)
    name = d.APPS[app] + version + '-x64.exe'
    (directory / name).write_bytes(data)
    manifest = {'app': app, 'version': version, 'file': name,
                'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
    if apply:
        manifest['apply'] = apply
    (directory / 'latest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def write_feed(feed, versions):
    return {app: write_app(feed / app, app, version) for app, version in versions.items()}


def hashes(manifests):
    return {app: manifest['sha256'] for app, manifest in manifests.items()}


class World:
    """A server that exists only in memory and in a temporary directory: Docker and HTTP answers."""

    def __init__(self, root):
        self.root = root
        self.public = root / 'public-https/releases' / ('a' * 40)
        self.api = root / 'releases' / ('b' * 40)
        staging = self.public / 'infra/public-staging'
        (staging / 'public-web/operations').mkdir(parents=True)
        (staging / 'public-web/operations/index.html').write_text('kiosk')
        (staging / 'public-web/.release.json').write_text(json.dumps({'source_sha': 'a' * 40, 'files': {
            'operations/index.html': hashlib.sha256(b'kiosk').hexdigest()}}))
        (staging / 'gateway.Caddyfile').write_text((ROOT / 'infra/public-staging/gateway.Caddyfile').read_text())
        (staging / 'compose.yaml').write_text('installed')
        self.api.mkdir(parents=True)
        (root / 'current').symlink_to(self.api)
        (root / 'public-https/current').symlink_to(self.public)
        self.gateway = {'/etc/caddy/Caddyfile': str(staging / 'gateway.Caddyfile'),
                        '/srv/public': str(staging / 'public-web')}
        self.sidecar = None
        self.generation = {'pickchick-public-gateway': 1, 'pickchick-staging-api-1': 1}
        self.commands = []
        self.fail = None
        self.break_feed = False

    def compose_json(self):
        return {'name': 'pickchick-public', 'services': {'gateway': {
            'image': GATEWAY_IMAGE, 'networks': {'front': None},
            'volumes': [{'type': 'bind', 'source': source, 'target': target, 'read_only': True}
                        for target, source in self.gateway.items()]}},
            'networks': {'front': {'name': 'deploy_default', 'external': True}}}

    def run(self, command, timeout=90):
        self.commands.append(command)
        text = ' '.join(command)
        if self.fail and self.fail in text:
            self.fail = None
            raise RuntimeError('Command failed: docker (output withheld)')
        if command[:3] == ['docker', 'ps', '-a']:
            return '\n'.join(self.generation)
        if command[:2] == ['docker', 'inspect']:
            name = command[-1]
            if '{{json .Mounts}}' in command:
                mounts = self.gateway if name == b.GATEWAY else self.sidecar
                return json.dumps([{'Destination': k, 'Source': v} for k, v in mounts.items()])
            if '{{.State.Running}}' in command:
                return 'true' if self.sidecar else 'false'
            return '%s-%d|image|started-%d' % (name, self.generation[name], self.generation[name])
        if command[:2] == ['docker', 'run']:
            return ''
        if command[:2] == ['docker', 'exec']:
            return self.read(command[-1].split('8080', 1)[1]).decode()
        if command[:2] == ['docker', 'compose']:
            file = Path(command[command.index('-f') + 1])
            if 'config' in command:
                return json.dumps(self.compose_json())
            if command[-1] == 'feed':
                env = dict(line.split('=', 1) for line in
                           Path(command[command.index('--env-file') + 1]).read_text().splitlines())
                assert env['DESKTOP_UPDATES_IMAGE'] == GATEWAY_IMAGE
                self.sidecar = {'/etc/caddy/Caddyfile': env['DESKTOP_UPDATES_CONFIG'],
                                '/srv/feed': env['DESKTOP_UPDATES_FEED_DIR']}
                self.generation[d.SIDECAR] = 1
                return ''
            if 'down' in command:
                self.sidecar = None
                self.generation.pop(d.SIDECAR, None)
                return ''
            if command[-1] == 'gateway':
                if file.read_text() == 'installed':
                    staging = self.public / 'infra/public-staging'
                    self.gateway = {'/etc/caddy/Caddyfile': str(staging / 'gateway.Caddyfile'),
                                    '/srv/public': str(staging / 'public-web')}
                else:
                    definition = json.loads(file.read_text())
                    assert d.NETWORK_KEY in definition['services']['gateway']['networks']
                    self.gateway = {v['target']: v['source'] for v in
                                    definition['services']['gateway']['volumes']}
                self.generation[b.GATEWAY] += 1
                return ''
        raise AssertionError('Unexpected command: ' + text)

    def read(self, path):
        """The feed container: the two files of each application under the current pointer."""
        if not self.sidecar or not re.search(d.PATHS, path):
            return None
        target = Path(self.sidecar['/srv/feed']) / 'current' / path.removeprefix(d.PREFIX + '/')
        return target.read_bytes() if target.is_file() else None

    def fetch(self, url, headers=None, method='GET', limit=d.CHUNK_BYTES):
        path = '/' + url.split('/', 3)[3]
        routed = d.ROUTE in Path(self.gateway['/etc/caddy/Caddyfile']).read_text()
        if path == '/health/live':
            return 200, b'{"service":"pickchick-public-gateway","alive":true}', {}
        data = self.read(path) if routed and method in ('GET', 'HEAD') else None
        if data is None:
            return 404, b'', {}
        if self.break_feed and path.endswith('.exe'):
            data = data[:-1] + b'!'
        answer = {'Content-Length': str(len(data)), 'Cache-Control': 'no-store'}
        if method == 'HEAD':
            return 200, b'', answer
        if headers and 'Range' in headers:
            first, last = map(int, headers['Range'].removeprefix('bytes=').split('-'))
            answer['Content-Range'] = 'bytes %d-%d/%d' % (first, last, len(data))
            return 206, data[first:last + 1], answer
        return 200, data, answer

    def http(self, path, **_):
        status, body, headers = self.fetch('https://host' + path)
        return (502, b'', headers) if path == '/v1/capabilities' else (status, body, headers)

    @contextlib.contextmanager
    def active(self):
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(b, 'ROOT', self.root))
            stack.enter_context(patch.object(b, 'LOCK', self.root / '.market-release.lock'))
            stack.enter_context(patch.object(b, 'run', self.run))
            stack.enter_context(patch.object(b, 'http', self.http))
            stack.enter_context(patch.object(b, 'verify_public_asset', lambda item: None))
            stack.enter_context(patch.object(d, 'fetch', self.fetch))
            stack.enter_context(patch.object(d, 'RESERVE_BYTES', 0))
            stack.enter_context(patch.object(d.os, 'getuid', lambda: 1000))
            yield self


def call(arguments):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        code = d.main(arguments)
    return code, json.loads(output.getvalue().strip().splitlines()[-1])


class PureRules(unittest.TestCase):
    def test_route_serves_exactly_the_names_the_installed_program_asks_for(self):
        client = (ROOT / 'apps/pos-desktop/updater.mjs').read_text()
        for app, prefix in d.APPS.items():
            self.assertIn("%s: '%s'," % (app, prefix), client)
            for version in ['0.5.0', '0.5.1', '1.0.0', '10.20.30', '9999.0.9999']:
                self.assertTrue(re.search(d.PATHS, '/desktop-updates/%s/%s%s-x64.exe' % (app, prefix, version)))
            self.assertTrue(re.search(d.PATHS, '/desktop-updates/%s/latest.json' % app))
        self.assertIn('export const CHUNK_BYTES = 4 * 1024 * 1024;', client)
        self.assertEqual(d.CHUNK_BYTES, 4 * 1024 * 1024)
        for path in ['/desktop-updates', '/desktop-updates/', '/desktop-updates/pos/', '/desktop-updates/pos',
                     '/desktop-updates/pos/latest.json.tmp', '/desktop-updates/pos/latest.json/',
                     '/desktop-updates/pos/PickChick-POS-Setup-0.5.0-x64.exe.blockmap',
                     '/desktop-updates/pos/PickChick-Kitchen-Setup-0.4.0-x64.exe',
                     '/desktop-updates/pos/PickChick-POS-Setup-01.5.0-x64.exe',
                     '/desktop-updates/pos/PickChick-POS-Setup-0.5-x64.exe',
                     '/desktop-updates/pos/PickChick-POS-Setup-10000.0.0-x64.exe',
                     '/desktop-updates/pos/PickChick-POS-Portable-0.5.0-x64.exe',
                     '/desktop-updates/current/pos/latest.json', '/desktop-updates/releases/x/pos/latest.json',
                     '/desktop-updates/pos/../kitchen/latest.json', '/x/desktop-updates/pos/latest.json',
                     '/desktop-updates/POS/latest.json']:
            self.assertIsNone(re.search(d.PATHS, path), path)

    def test_gateway_and_feed_container_use_one_expression_without_braces(self):
        self.assertNotIn('{', d.PATHS)
        self.assertNotIn(' ', d.PATHS)
        sidecar = (ROOT / 'infra/desktop-updates/sidecar.Caddyfile').read_text()
        self.assertIn('\t\tpath_regexp feed ' + d.PATHS + '\n', sidecar)
        self.assertIn('\t\tpath_regexp desktop_updates ' + d.PATHS + '\n', d.ROUTE)
        self.assertIn('method GET HEAD', d.ROUTE)
        self.assertIn('method GET HEAD', sidecar)
        self.assertNotIn('browse', sidecar)
        self.assertIn('root * /srv/feed/current', sidecar)

    def test_feed_container_is_closed_and_never_pulls(self):
        compose = (ROOT / 'infra/desktop-updates/compose.yaml').read_text()
        for line in ['pull_policy: never', 'container_name: ' + d.SIDECAR, 'read_only: true',
                     'cap_drop: [ALL]', "security_opt: ['no-new-privileges:true']",
                     'name: ' + d.NETWORK, 'internal: true', ':/srv/feed:ro', ':/etc/caddy/Caddyfile:ro']:
            self.assertIn(line, compose)
        self.assertNotIn('ports:', compose)
        self.assertNotIn('docker.sock', compose)
        gateway = (ROOT / 'infra/public-staging/compose.yaml').read_text()
        self.assertIn("'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/health/live'", gateway)
        self.assertIn("'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/health/live'", compose)

    def test_route_is_added_once_before_the_fallback_and_nothing_else_moves(self):
        old = (ROOT / 'infra/public-staging/gateway.Caddyfile').read_text()
        new = d.add_route(old)
        self.assertEqual(new.replace('\n' + d.ROUTE, '', 1), old)
        self.assertLess(new.index(d.ROUTE), new.rindex('\n\thandle {'))
        self.assertEqual(d.add_route(new), new)
        for broken, reason in [
                (new.replace('dial_timeout 2s\n\t\t\t\tresponse_header_timeout 5s\n\t\t\t}\n\t\t}\n\t}\n' + d.END,
                             'dial_timeout 9s\n\t\t\t\tresponse_header_timeout 5s\n\t\t\t}\n\t\t}\n\t}\n' + d.END),
                 'differs'),
                (old + d.START, 'markers'),
                (old.replace('@operations {', '@operations {\n\t\tpath /desktop-updates/*'), 'Unrecognized'),
                (old.replace('\n\thandle {', '\n\thandle /x {'), 'fallback')]:
            with self.assertRaisesRegex(RuntimeError, reason):
                d.add_route(broken)

    def test_gateway_definition_changes_only_two_sources_and_one_network(self):
        old = {'name': 'pickchick-public', 'services': {'gateway': {
            'image': GATEWAY_IMAGE, 'networks': {'front': None, 'roadmap_ingress': None},
            'volumes': [{'target': '/etc/caddy/Caddyfile', 'source': '/old/config', 'read_only': True},
                        {'target': '/srv/public', 'source': '/old/public', 'read_only': True}]}},
            'networks': {'front': {'external': True}, 'roadmap_ingress': {'external': True}}}
        snapshot = json.dumps(old)
        new = d.gateway_candidate(old, Path('/new/config'), Path('/new/public'))
        self.assertEqual(json.dumps(old), snapshot)
        self.assertEqual({v['target']: v['source'] for v in new['services']['gateway']['volumes']},
                         {'/etc/caddy/Caddyfile': '/new/config', '/srv/public': '/new/public'})
        self.assertEqual(new['networks'].pop(d.NETWORK_KEY), {'name': d.NETWORK, 'external': True})
        self.assertIsNone(new['services']['gateway']['networks'].pop(d.NETWORK_KEY, 'absent'))
        new['services']['gateway']['volumes'] = old['services']['gateway']['volumes']
        self.assertEqual(new, old)
        third = json.loads(snapshot)
        third['services']['gateway']['volumes'].append({'target': '/srv/extra', 'source': '/x', 'read_only': True})
        other = json.loads(snapshot)
        other['services']['other'] = {}
        writable = json.loads(snapshot)
        writable['services']['gateway']['volumes'][0]['read_only'] = False
        for refused in (third, other, writable):
            with self.assertRaises(RuntimeError):
                d.gateway_candidate(refused, Path('/new/config'), Path('/new/public'))

    def test_feed_is_accepted_only_as_ci_lays_it_out(self):
        with tempfile.TemporaryDirectory() as temporary:
            feed = Path(temporary) / 'feed'
            manifests = write_feed(feed, {'pos': '0.5.1', 'kitchen': '0.4.1'})
            self.assertEqual(d.verify_feed(feed, hashes(manifests)), manifests)
            self.assertEqual(d.release_name(manifests), 'kitchen-0.4.1-pos-0.5.1')
            with self.assertRaisesRegex(RuntimeError, 'exactly the applications'):
                d.verify_feed(feed, {'pos': manifests['pos']['sha256']})
            with self.assertRaisesRegex(RuntimeError, 'operator named'):
                d.verify_feed(feed, {**hashes(manifests), 'pos': 'f' * 64})

            def refused(reason, change):
                other = Path(tempfile.mkdtemp(dir=temporary)) / 'feed'
                made = write_feed(other, {'pos': '0.5.1'})
                change(other, made['pos'])
                with self.assertRaisesRegex(RuntimeError, reason):
                    d.verify_feed(other, hashes(made))

            name = manifests['pos']['file']

            def rewrite(**fields):
                def change(other, manifest):
                    (other / 'pos/latest.json').write_text(json.dumps({**manifest, **fields}))
                return change

            refused('exactly latest.json', lambda other, _: (other / 'pos/extra.txt').write_text('x'))
            refused('only pos/ and kitchen/', lambda other, _: (other / 'web').mkdir())
            refused('size differs', lambda other, _: (other / 'pos' / name).write_bytes(installer('pos0.5.1')[:-1]))
            refused('hash differs', lambda other, _: (other / 'pos' / name).write_bytes(installer('other')))
            refused('not a Windows executable', lambda other, manifest: (
                (other / 'pos' / name).write_bytes(b'PK' + installer('pos0.5.1')[2:])))
            refused('would refuse', rewrite(version='0.5.2'))
            refused('would refuse', rewrite(app='kitchen'))
            refused('would refuse', rewrite(apply='always'))
            refused('would refuse', rewrite(bytes=999_999))
            refused('would refuse', rewrite(sha256='A' * 64))
            refused('keys differ', rewrite(url='https://example.org/x.exe'))
            refused('not JSON', lambda other, _: (other / 'pos/latest.json').write_text('{'))

            def symlinked(other, _):
                (other / 'pos' / name).rename(other / 'real.exe')
                (other / 'pos' / name).symlink_to(other / 'real.exe')

            refused('only pos/ and kitchen/|size differs', symlinked)
            self.assertEqual(d.read_manifest(json.dumps({**manifests['pos'], 'apply': 'now'}), 'pos')['apply'], 'now')

    def test_only_a_higher_version_replaces_a_published_one(self):
        old = {'pos': {'version': '0.5.0'}, 'kitchen': {'version': '0.4.0'}}
        self.assertEqual(d.plan({'kitchen': {'version': '0.4.1'}}, old), {'kitchen': 'new', 'pos': 'carried'})
        self.assertEqual(d.plan({'pos': {'version': '0.10.0'}, 'kitchen': {'version': '1.0.0'}}, old),
                         {'kitchen': 'new', 'pos': 'new'})
        for version in ['0.5.0', '0.4.9', '0.0.99']:
            with self.assertRaisesRegex(RuntimeError, 'higher than the published 0.5.0'):
                d.plan({'pos': {'version': version}}, old)

    def test_served_feed_is_read_the_way_a_device_reads_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            feed = Path(temporary)
            data = installer('big', d.CHUNK_BYTES * 2 + 777)
            manifest = write_app(feed / 'pos', 'pos', '0.5.1')
            (feed / 'pos' / manifest['file']).write_bytes(data)
            manifest.update(sha256=hashlib.sha256(data).hexdigest(), bytes=len(data))
            asked = []

            def server(shift=0, total=len(data), redirect=False, cache='no-store'):
                def fetch(url, headers=None, method='GET', limit=d.CHUNK_BYTES):
                    asked.append((method, url.rsplit('/', 1)[1], (headers or {}).get('Range')))
                    if url.endswith('latest.json'):
                        return (302 if redirect else 200), json.dumps(manifest).encode(), {'Cache-Control': cache}
                    if method == 'HEAD':
                        return 200, b'', {'Content-Length': str(total)}
                    first, last = map(int, headers['Range'].removeprefix('bytes=').split('-'))
                    return 206, data[first + shift:last + 1 + shift], {
                        'Content-Range': 'bytes %d-%d/%d' % (first, last, total)}
                return fetch

            with patch.object(d, 'fetch', server()):
                d.verify_served('https://host', {'pos': manifest})
            self.assertEqual([item[2] for item in asked if item[2]],
                             ['bytes=0-4194303', 'bytes=4194304-8388607', 'bytes=8388608-8389384'])
            for fake, reason in [(server(shift=1), 'piece differs|hash differs'),
                                 (server(total=len(data) + 1), 'size differs'),
                                 (server(redirect=True), 'manifest differs'),
                                 (server(cache='max-age=600'), 'manifest differs')]:
                with patch.object(d, 'fetch', fake), self.assertRaisesRegex(RuntimeError, reason):
                    d.verify_served('https://host', {'pos': manifest})

    def test_a_redirect_is_an_answer_not_a_path_to_follow(self):
        class Opener:
            def open(self, request, timeout):
                raise d.urllib.error.HTTPError(request.full_url, 302, 'Found', {'Location': 'https://x'}, None)

        with patch.object(d.urllib.request, 'build_opener', return_value=Opener()) as build:
            self.assertEqual(d.fetch('https://host/desktop-updates/pos/latest.json')[0], 302)
        self.assertIs(build.call_args.args[0], d._NoRedirect)
        self.assertIsNone(d._NoRedirect().redirect_request(None, None, 302, 'Found', {}, 'https://x'))


class ServerSteps(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.temporary = Path(self.directory.name)
        self.world = World(self.temporary / 'server')
        self.package = self.temporary / 'package'
        files = {}
        for name in sorted(d.PACKAGE_FILES):
            (self.package / name).parent.mkdir(parents=True, exist_ok=True)
            (self.package / name).write_bytes((ROOT / name).read_bytes())
            files[name] = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
        (self.package / 'desktop-updates-package.json').write_text(
            json.dumps({'source_sha': 'c' * 40, 'files': files}))
        self.first = write_feed(self.temporary / 'feed-1', {'pos': '0.5.0', 'kitchen': '0.4.0'})

    def install_arguments(self, feed='feed-1', manifests=None):
        manifests = manifests or self.first
        return ['install', '--package', str(self.package), '--feed', str(self.temporary / feed),
                '--expected-source-sha', 'c' * 40,
                '--expected-public-release', str(self.world.public),
                '--expected-api-release', str(self.world.api),
                '--expected-gateway-sha256', hashlib.sha256(
                    (ROOT / 'infra/public-staging/gateway.Caddyfile').read_bytes()).hexdigest(),
                '--expected-pos-sha256', manifests['pos']['sha256'],
                '--expected-kitchen-sha256', manifests['kitchen']['sha256']]

    def install(self):
        with patch.object(d, '__file__', str(self.package / 'infra/desktop-updates/remote-deploy.py')):
            code, outcome = call(self.install_arguments() + ['--apply'])
        self.assertEqual((code, outcome['status']), (0, 'deployed'))
        return outcome

    def publish_arguments(self, feed, manifests, current):
        arguments = ['publish', '--feed', str(self.temporary / feed), '--expected-current', current]
        for app, manifest in manifests.items():
            arguments += ['--expected-%s-sha256' % app, manifest['sha256']]
        return arguments

    def test_inspect_gives_the_values_install_expects_and_changes_nothing(self):
        with self.world.active():
            code, report = call(['inspect', '--feed', str(self.temporary / 'feed-1'),
                                 '--expected-pos-sha256', self.first['pos']['sha256'],
                                 '--expected-kitchen-sha256', self.first['kitchen']['sha256']])
        self.assertEqual(code, 0)
        self.assertEqual(report['expected_public_release'], str(self.world.public))
        self.assertEqual(report['expected_api_release'], str(self.world.api))
        self.assertEqual((report['gateway_route_installed'], report['feed_container'],
                          report['published_release'], report['next_step'], report['next_release']),
                         (False, False, None, 'install', 'kitchen-0.4.0-pos-0.5.0'))
        self.assertTrue(report['feed_host_reaches_gateway'])
        self.assertFalse((self.world.root / 'desktop-updates').exists())
        self.assertTrue(all(c[:2] != ['docker', 'compose'] for c in self.world.commands))

    def test_install_without_apply_only_checks(self):
        with self.world.active(), patch.object(
                d, '__file__', str(self.package / 'infra/desktop-updates/remote-deploy.py')):
            code, outcome = call(self.install_arguments())
        self.assertEqual((code, outcome['status'], outcome['applied']), (0, 'inspected', False))
        self.assertFalse((self.world.root / 'desktop-updates').exists())
        self.assertFalse((self.world.root / '.market-release.lock').exists())
        self.assertIsNone(self.world.sidecar)

    def test_install_starts_the_feed_then_moves_the_gateway_and_devices_get_both_files(self):
        with self.world.active():
            outcome = self.install()
            root = self.world.root
            new_public = root / 'public-https/releases' / ('c' * 40)
            self.assertEqual((root / 'public-https/current').resolve(), new_public)
            self.assertEqual(os.readlink(root / 'desktop-updates/feed/current'), 'releases/kitchen-0.4.0-pos-0.5.0')
            self.assertEqual(self.world.gateway['/etc/caddy/Caddyfile'],
                             str(new_public / 'infra/public-staging/gateway.Caddyfile'))
            config = (new_public / 'infra/public-staging/gateway.Caddyfile').read_text()
            self.assertEqual(config.replace('\n' + d.ROUTE, '', 1),
                             (ROOT / 'infra/public-staging/gateway.Caddyfile').read_text())
            self.assertEqual(self.world.sidecar['/srv/feed'], str(root / 'desktop-updates/feed'))
            order = [' '.join(c[-3:]) for c in self.world.commands if c[:2] == ['docker', 'compose'] and 'up' in c]
            self.assertEqual([item.split()[-1] for item in order], ['feed', 'gateway'])
            self.assertEqual(sum('validate' in c for c in self.world.commands), 2)
            self.assertFalse((root / '.market-release.lock').exists())
            self.assertEqual(outcome['published'], {'kitchen': '0.4.0', 'pos': '0.5.0'})
            self.assertEqual(outcome['unchanged_services'], ['pickchick-staging-api-1'])
            d.verify_served(d.FEED_ORIGIN, self.first)
            mode = (root / 'desktop-updates/feed/releases/kitchen-0.4.0-pos-0.5.0/pos/latest.json').stat().st_mode
            self.assertEqual(mode & 0o777, 0o644)
            # A second install is refused before anything is touched.
            with patch.object(d, '__file__', str(self.package / 'infra/desktop-updates/remote-deploy.py')):
                with self.assertRaisesRegex(RuntimeError, 'Current public pointer changed'):
                    call(self.install_arguments() + ['--apply'])

    def test_failed_install_puts_the_old_gateway_back_and_can_be_repeated(self):
        for failure in ['break_feed', 'gateway_up', 'feed_up']:
            with self.subTest(failure):
                world = World(self.temporary / ('server-' + failure))
                self.world = world
                with world.active(), patch.object(
                        d, '__file__', str(self.package / 'infra/desktop-updates/remote-deploy.py')):
                    if failure == 'break_feed':
                        world.break_feed = True
                    else:
                        world.fail = 'wait-timeout 60 ' + failure.split('_')[0]
                    code, outcome = call(self.install_arguments() + ['--apply'])
                    self.assertEqual((code, outcome['status']), (1, 'rolled_back'))
                    staging = world.public / 'infra/public-staging'
                    self.assertEqual(world.gateway['/etc/caddy/Caddyfile'], str(staging / 'gateway.Caddyfile'))
                    self.assertEqual((world.root / 'public-https/current').resolve(), world.public)
                    self.assertIsNone(world.sidecar)
                    self.assertFalse((world.root / 'desktop-updates/feed/current').is_symlink())
                    self.assertFalse((world.root / '.market-release.lock').exists())
                    self.assertEqual(d.fetch(d.FEED_ORIGIN + '/desktop-updates/pos/latest.json')[0], 404)
                    world.break_feed, world.fail = False, None
                    code, outcome = call(self.install_arguments() + ['--apply'])
                    self.assertEqual((code, outcome['status']), (0, 'deployed'))

    def test_unconfirmed_rollback_keeps_the_lock(self):
        with self.world.active(), patch.object(
                d, '__file__', str(self.package / 'infra/desktop-updates/remote-deploy.py')):
            self.world.break_feed = True
            real = self.world.run

            def run(command, timeout=90):
                if 'down' in command:
                    raise RuntimeError('Command failed: docker (output withheld)')
                return real(command, timeout)

            with patch.object(b, 'run', run), self.assertRaisesRegex(RuntimeError, 'lock retained'):
                call(self.install_arguments() + ['--apply'])
            self.assertTrue((self.world.root / '.market-release.lock/owner.json').is_file())

    def test_install_refuses_a_foreign_package_feed_or_baseline(self):
        with self.world.active():
            with self.assertRaisesRegex(RuntimeError, 'script of the package'):
                call(self.install_arguments())
            with patch.object(d, '__file__', str(self.package / 'infra/desktop-updates/remote-deploy.py')):
                (self.package / 'infra/desktop-updates/compose.yaml').write_text('changed')
                with self.assertRaisesRegex(RuntimeError, 'hash mismatch'):
                    call(self.install_arguments())
                (self.package / 'infra/desktop-updates/compose.yaml').write_bytes(
                    (ROOT / 'infra/desktop-updates/compose.yaml').read_bytes())
                only_pos = write_feed(self.temporary / 'feed-pos', {'pos': '0.5.0'})
                arguments = self.install_arguments('feed-pos', {**self.first, **only_pos})
                with self.assertRaisesRegex(RuntimeError, 'exactly the applications'):
                    call(arguments)
                with self.assertRaisesRegex(RuntimeError, 'both pos/ and kitchen/'):
                    call(arguments[:-2])
                arguments = self.install_arguments()
                arguments[arguments.index('--expected-gateway-sha256') + 1] = 'e' * 64
                with self.assertRaisesRegex(RuntimeError, 'gateway configuration changed'):
                    call(arguments)
                with patch.object(d, 'alias_reaches_gateway', lambda: False):
                    with self.assertRaisesRegex(RuntimeError, 'does not reach'):
                        call(self.install_arguments())
        self.assertFalse((self.world.root / 'desktop-updates').exists())

    def test_publish_moves_one_pointer_and_restarts_nothing(self):
        with self.world.active():
            self.install()
            second = write_feed(self.temporary / 'feed-2', {'kitchen': '0.4.1'})
            arguments = self.publish_arguments('feed-2', second, 'kitchen-0.4.0-pos-0.5.0')
            before = dict(self.world.generation)
            code, outcome = call(arguments)
            self.assertEqual((code, outcome['status'], outcome['feed_release']),
                             (0, 'inspected', 'kitchen-0.4.1-pos-0.5.0'))
            self.assertEqual(os.readlink(self.world.root / 'desktop-updates/feed/current'),
                             'releases/kitchen-0.4.0-pos-0.5.0')
            count = len(self.world.commands)
            code, outcome = call(arguments + ['--apply'])
            self.assertEqual((code, outcome['status']), (0, 'deployed'))
            self.assertEqual(outcome['published'], {'kitchen': '0.4.1', 'pos': '0.5.0'})
            self.assertEqual(self.world.generation, before)
            self.assertTrue(all(c[:2] in (['docker', 'ps'], ['docker', 'inspect'])
                                for c in self.world.commands[count:]))
            d.verify_served(d.FEED_ORIGIN, {'kitchen': second['kitchen'], 'pos': self.first['pos']})
            self.assertEqual(d.fetch(d.FEED_ORIGIN + '/desktop-updates/kitchen/' + self.first['kitchen']['file'])[0], 404)
            self.assertFalse((self.world.root / '.market-release.lock').exists())
            # The same or an older version, a stale expectation and a missing hash are refused.
            for feed, versions, current, reason in [
                    ('feed-3', {'kitchen': '0.4.1'}, 'kitchen-0.4.1-pos-0.5.0', 'higher than the published 0.4.1'),
                    ('feed-4', {'pos': '0.4.9'}, 'kitchen-0.4.1-pos-0.5.0', 'higher than the published 0.5.0'),
                    ('feed-5', {'pos': '0.5.1'}, 'kitchen-0.4.0-pos-0.5.0', 'not --expected-current')]:
                made = write_feed(self.temporary / feed, versions)
                with self.assertRaisesRegex(RuntimeError, reason):
                    call(self.publish_arguments(feed, made, current) + ['--apply'])
            with self.assertRaisesRegex(RuntimeError, 'exactly the applications'):
                call(['publish', '--feed', str(self.temporary / 'feed-5'),
                      '--expected-current', 'kitchen-0.4.1-pos-0.5.0', '--apply'])
            self.assertEqual(os.readlink(self.world.root / 'desktop-updates/feed/current'),
                             'releases/kitchen-0.4.1-pos-0.5.0')

    def test_publish_that_devices_cannot_read_goes_back_and_can_be_repeated(self):
        with self.world.active():
            self.install()
            second = write_feed(self.temporary / 'feed-2', {'pos': '0.5.1', 'kitchen': '0.4.1'})
            arguments = self.publish_arguments('feed-2', second, 'kitchen-0.4.0-pos-0.5.0') + ['--apply']
            real = d.verify_served
            calls = []

            def served(origin, manifests, installers=True):
                calls.append(manifests)
                if manifests == second and installers:
                    raise RuntimeError('Served installer hash differs: pos')
                return real(origin, manifests, installers)

            with patch.object(d, 'verify_served', served):
                code, outcome = call(arguments)
            self.assertEqual((code, outcome['status'], outcome['detail']),
                             (1, 'rolled_back', 'Served installer hash differs: pos'))
            feed = self.world.root / 'desktop-updates/feed'
            self.assertEqual(os.readlink(feed / 'current'), 'releases/kitchen-0.4.0-pos-0.5.0')
            self.assertFalse((feed / 'releases/kitchen-0.4.1-pos-0.5.1').exists())
            self.assertFalse((self.world.root / '.market-release.lock').exists())
            d.verify_served(d.FEED_ORIGIN, self.first)
            code, outcome = call(arguments)
            self.assertEqual((code, outcome['status']), (0, 'deployed'))

    def test_withdraw_points_back_at_a_published_release_only(self):
        with self.world.active():
            self.install()
            second = write_feed(self.temporary / 'feed-2', {'pos': '0.5.1'})
            call(self.publish_arguments('feed-2', second, 'kitchen-0.4.0-pos-0.5.0') + ['--apply'])
            before = dict(self.world.generation)
            for to, current, reason in [
                    ('kitchen-0.4.0-pos-0.5.1', 'kitchen-0.4.0-pos-0.5.1', 'another published release'),
                    ('kitchen-0.4.0-pos-0.4.0', 'kitchen-0.4.0-pos-0.5.1', 'No such feed release'),
                    ('../releases/kitchen-0.4.0-pos-0.5.0', 'kitchen-0.4.0-pos-0.5.1', 'another published release'),
                    ('kitchen-0.4.0-pos-0.5.0', 'kitchen-0.4.0-pos-0.5.0', 'not --expected-current')]:
                with self.assertRaisesRegex(RuntimeError, reason):
                    call(['withdraw', '--to', to, '--expected-current', current, '--apply'])
            code, outcome = call(['withdraw', '--to', 'kitchen-0.4.0-pos-0.5.0',
                                  '--expected-current', 'kitchen-0.4.0-pos-0.5.1', '--apply'])
            self.assertEqual((code, outcome['status'], outcome['action']), (0, 'deployed', 'withdraw'))
            self.assertEqual(self.world.generation, before)
            d.verify_served(d.FEED_ORIGIN, self.first)
            _, report = call(['inspect'])
            self.assertEqual(report['published_release'], 'kitchen-0.4.0-pos-0.5.0')
            self.assertEqual(report['releases_on_disk'], ['kitchen-0.4.0-pos-0.5.0', 'kitchen-0.4.0-pos-0.5.1'])
            self.assertTrue(report['gateway_route_installed'] and report['feed_container'])

    def test_publish_needs_the_installed_layout(self):
        with self.world.active():
            second = write_feed(self.temporary / 'feed-2', {'pos': '0.5.1'})
            with self.assertRaisesRegex(RuntimeError, 'run install'):
                call(self.publish_arguments('feed-2', second, 'kitchen-0.4.0-pos-0.5.0'))
            self.install()
            self.world.sidecar = None
            with self.assertRaisesRegex(RuntimeError, 'not running'):
                call(self.publish_arguments('feed-2', second, 'kitchen-0.4.0-pos-0.5.0'))

    def test_only_the_operator_account_and_complete_arguments_run(self):
        with self.world.active(), patch.object(d.os, 'getuid', lambda: 0):
            with self.assertRaisesRegex(RuntimeError, 'UID 1000'):
                call(['inspect'])
        for arguments in [['publish'], ['withdraw', '--to', 'x'], ['inspect', '--apply'], ['install', '--apply'],
                          ['withdraw', '--to', 'x', '--expected-current', 'y', '--feed', 'z']]:
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                d.main(arguments)

    def test_package_holds_exactly_the_reviewed_files(self):
        source = (ROOT / 'infra/desktop-updates/package.py').read_text()
        for name in d.PACKAGE_FILES:
            self.assertIn("'" + name + "'", source)
        self.assertEqual(source.count("'infra/"), len(d.PACKAGE_FILES))


if __name__ == '__main__':
    unittest.main()
