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
        # `docker compose run` jobs: listed by Docker, never part of a snapshot of the step.
        self.oneoff = set()
        # Names Docker lists once and no longer has when they are inspected.
        self.vanishing = []
        self.signals = {}
        # The public address: the gateway's own health text, requests that get no answer, an API
        # answer that changes by itself, a path something in front answers on its own.
        self.health = b'{"service":"pickchick-public-gateway","alive":true}'
        self.blips = 0
        self.drifting = False
        self.asked = 0
        self.stuck = None
        self.slept = []

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
            if 'label=com.docker.compose.oneoff=True' in command:
                return '\n'.join(sorted(self.oneoff))
            gone = [self.vanishing.pop()] if self.vanishing else []
            return '\n'.join([*self.generation, *sorted(self.oneoff), *gone])
        if command[:2] == ['docker', 'inspect']:
            name = command[-1]
            if name not in self.generation and name not in self.oneoff:
                raise RuntimeError('Command failed: docker (output withheld)')
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
            return 200, self.health, {}
        if path == self.stuck:
            return 200, b'{}', {'Cache-Control': 'no-store'}
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
        if self.blips:
            self.blips -= 1
            raise OSError(111, 'Connection refused')
        status, body, headers = self.fetch('https://host' + path)
        if path == '/v1/capabilities':
            self.asked += 1
            return 502, (b'%d' % self.asked if self.drifting else b''), headers
        return status, body, headers

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
            # The handlers an --apply run sets are recorded, not given to the test process.
            stack.enter_context(patch.object(d.signal, 'signal', self.signals.__setitem__))
            stack.enter_context(patch.object(d.time, 'sleep', self.slept.append))
            yield self


def call(arguments):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        code = d.main(arguments)
    return code, json.loads(output.getvalue().strip().splitlines()[-1])


def stopped(case, arguments, reason, error=RuntimeError):
    """A run that ends with an error line: the outcome it printed on stdout before that, or None."""
    output = io.StringIO()
    with contextlib.redirect_stdout(output), case.assertRaisesRegex(error, reason):
        d.main(arguments)
    lines = output.getvalue().strip().splitlines()
    case.assertLessEqual(len(lines), 1)
    return json.loads(lines[0]) if lines else None


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
            refused('would refuse', rewrite(bytes=999_999))
            # Stricter than the program on purpose, and said so: it would take these three.
            refused('feed builder does not write', rewrite(apply=None))
            refused('feed builder does not write', rewrite(bytes=1200000.0))
            refused('feed builder does not write', lambda other, manifest: (other / 'pos/latest.json').write_text(
                json.dumps(manifest).replace('1200000', '1.2e6')))
            refused('feed builder does not write', rewrite(apply='always'))
            refused('feed builder does not write', rewrite(bytes='1200000'))
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

    def test_a_foreign_answer_of_the_feed_host_is_not_the_gateway_and_never_an_error(self):
        ours = b'{"service":"pickchick-public-gateway","alive":true}'
        with patch.object(d, 'fetch', lambda *a, **k: (200, ours, {})):
            self.assertTrue(d.alias_reaches_gateway())
        for answer in [(200, b'[]', {}), (200, b'null', {}), (200, b'"pickchick-public-gateway"', {}),
                       (200, b'<html>', {}), (200, b'{"service":"idrink"}', {}), (502, ours, {})]:
            with patch.object(d, 'fetch', lambda *a, **k: answer):
                self.assertFalse(d.alias_reaches_gateway(), answer)
        for error in [RuntimeError('Response is larger than expected'), OSError(111, 'Connection refused'),
                      d.urllib.error.URLError('no route')]:
            def broken(*a, **k):
                raise error

            with patch.object(d, 'fetch', broken):
                self.assertFalse(d.alias_reaches_gateway(), error)

        # An answer that breaks off is an error of the step in words.
        class Opener:
            def open(self, request, timeout):
                raise d.http.client.IncompleteRead(b'half')

        with patch.object(d.urllib.request, 'build_opener', return_value=Opener()):
            with self.assertRaisesRegex(RuntimeError, r'The answer broke off \(IncompleteRead\): https://host/x'):
                d.fetch('https://host/x')
            self.assertFalse(d.alias_reaches_gateway())


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
        self.signed = ['--package', str(self.package), '--expected-source-sha', 'c' * 40]
        running = patch.object(d, '__file__', str(self.package / 'infra/desktop-updates/remote-deploy.py'))
        running.start()
        self.addCleanup(running.stop)

    def install_arguments(self, feed='feed-1', manifests=None):
        manifests = manifests or self.first
        return ['install', *self.signed, '--feed', str(self.temporary / feed),
                '--expected-public-release', str(self.world.public),
                '--expected-api-release', str(self.world.api),
                '--expected-gateway-sha256', hashlib.sha256(
                    (ROOT / 'infra/public-staging/gateway.Caddyfile').read_bytes()).hexdigest(),
                '--expected-pos-sha256', manifests['pos']['sha256'],
                '--expected-kitchen-sha256', manifests['kitchen']['sha256']]

    def install(self):
        code, outcome = call(self.install_arguments() + ['--apply'])
        self.assertEqual((code, outcome['status']), (0, 'deployed'))
        return outcome

    def publish_arguments(self, feed, manifests, current):
        arguments = ['publish', *self.signed, '--feed', str(self.temporary / feed), '--expected-current', current]
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
        with self.world.active():
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
            with self.assertRaisesRegex(RuntimeError, 'Current public pointer changed'):
                call(self.install_arguments() + ['--apply'])

    def test_failed_install_puts_the_old_gateway_back_and_can_be_repeated(self):
        for failure in ['break_feed', 'gateway_up', 'feed_up']:
            with self.subTest(failure):
                world = World(self.temporary / ('server-' + failure))
                self.world = world
                with world.active():
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
        with self.world.active():
            self.world.break_feed = True
            real = self.world.run

            def run(command, timeout=90):
                if 'down' in command:
                    raise RuntimeError('Command failed: docker (output withheld)')
                return real(command, timeout)

            with patch.object(b, 'run', run):
                outcome = stopped(self, self.install_arguments() + ['--apply'], 'lock retained')
            self.assertEqual((outcome['status'], outcome['lock_retained'], outcome['phase'], outcome['reason'],
                              outcome['rollback_reason'], outcome['rollback_detail']),
                             ('rollback_needs_review', True, 'verify', 'RuntimeError',
                              'RuntimeError', 'Command failed: docker (output withheld)'))
            self.assertRegex(outcome['detail'], '^Served installer hash differs: ')
            self.assertEqual(json.loads(Path(outcome['journal']).read_text()), outcome)
            self.assertTrue((self.world.root / '.market-release.lock/owner.json').is_file())

    def test_install_refuses_a_foreign_package_feed_or_baseline(self):
        with self.world.active():
            with patch.object(d, '__file__', str(ROOT / 'infra/desktop-updates/remote-deploy.py')):
                for arguments in [self.install_arguments(),
                                  ['publish', *self.signed, '--feed', 'x', '--expected-current', 'y'],
                                  ['withdraw', *self.signed, '--to', 'x', '--expected-current', 'y']]:
                    with self.assertRaisesRegex(RuntimeError, 'script of the package'):
                        call(arguments)
            with self.assertRaisesRegex(RuntimeError, 'source SHA mismatch'):
                call(['withdraw', '--package', str(self.package), '--expected-source-sha', 'd' * 40,
                      '--to', 'x', '--expected-current', 'y'])
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
            # The proxy in front of the feed host answers the feed path by itself (a redirect).
            real = self.world.fetch

            def front(url, headers=None, method='GET', limit=d.CHUNK_BYTES):
                if url == d.FEED_ORIGIN + '/desktop-updates/pos/latest.json':
                    return 308, b'', {}
                return real(url, headers, method, limit)

            with patch.object(d, 'fetch', front):
                with self.assertRaisesRegex(RuntimeError, 'feed path already answers'):
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
                call(['publish', *self.signed, '--feed', str(self.temporary / 'feed-5'),
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
                    call(['withdraw', *self.signed, '--to', to, '--expected-current', current, '--apply'])
            code, outcome = call(['withdraw', *self.signed, '--to', 'kitchen-0.4.0-pos-0.5.0',
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
                          ['publish', '--feed', 'x', '--expected-current', 'y'],
                          ['withdraw', *self.signed, '--to', 'x', '--expected-current', 'y', '--feed', 'z']]:
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                d.main(arguments)

    def after_the_lock(self, change):
        """Runs `change` right after the step took the shared lock, before its own re-check."""
        real = b.lock

        @contextlib.contextmanager
        def lock(sha):
            with real(sha) as owner:
                change()
                yield owner

        return patch.object(b, 'lock', lock)

    def test_a_refusal_after_the_lock_gives_the_lock_back_and_the_step_repeats(self):
        lock = self.world.root / '.market-release.lock'
        with self.world.active():
            # install: another service appears between the first snapshot and the lock.
            with self.after_the_lock(lambda: self.world.generation.update({'neighbour-1': 1})):
                with self.assertRaisesRegex(RuntimeError, 'Baseline drift after lock; nothing was changed '
                                                          'and the release lock is free'):
                    call(self.install_arguments() + ['--apply'])
            self.assertFalse(lock.exists())
            self.assertFalse((self.world.root / 'desktop-updates').exists())
            self.assertIsNone(self.world.sidecar)
            self.assertEqual(self.world.generation[b.GATEWAY], 1)
            # install: the release directory of this commit appears after the dry-run checks.
            taken = self.world.root / 'public-https/releases' / ('c' * 40)
            with self.after_the_lock(taken.mkdir):
                with self.assertRaisesRegex(RuntimeError, 'Immutable release already exists.*lock is free'):
                    call(self.install_arguments() + ['--apply'])
            self.assertFalse(lock.exists())
            taken.rmdir()
            self.install()
            # publish and withdraw: the same for a container and for the published release.
            second = write_feed(self.temporary / 'feed-2', {'pos': '0.5.1'})
            arguments = self.publish_arguments('feed-2', second, 'kitchen-0.4.0-pos-0.5.0') + ['--apply']
            with self.after_the_lock(lambda: self.world.generation.update({'neighbour-2': 1})):
                with self.assertRaisesRegex(RuntimeError, 'Drift after lock; nothing was changed'):
                    call(arguments)
            self.assertFalse(lock.exists())
            self.assertEqual(os.readlink(self.world.root / 'desktop-updates/feed/current'),
                             'releases/kitchen-0.4.0-pos-0.5.0')
            self.assertFalse((self.world.root / 'desktop-updates/feed/releases/kitchen-0.4.0-pos-0.5.1').exists())
            # An interruption (Ctrl+C) in the same place is such a refusal too.
            def interrupt():
                raise KeyboardInterrupt

            with self.after_the_lock(lambda: None), patch.object(d, 'published', interrupt):
                with self.assertRaisesRegex(RuntimeError, 'Interrupted: KeyboardInterrupt; nothing was changed'):
                    with patch.object(d, 'current_release', lambda a: (
                            self.world.root / 'desktop-updates/feed/releases/kitchen-0.4.0-pos-0.5.0', self.first)):
                        call(arguments)
            self.assertFalse(lock.exists())
            code, outcome = call(arguments)
            self.assertEqual((code, outcome['status']), (0, 'deployed'))

    def test_a_held_lock_or_a_taken_release_name_is_refused_by_the_dry_run_too(self):
        with self.world.active():
            taken = self.world.root / 'public-https/releases' / ('c' * 40)
            taken.mkdir()
            with self.assertRaisesRegex(RuntimeError, 'Immutable release already exists'):
                call(self.install_arguments())
            taken.rmdir()
            lock = self.world.root / '.market-release.lock'
            lock.mkdir()
            (lock / 'owner.json').write_text(json.dumps(
                {'id': 'x', 'sha': 'e' * 40, 'action': 'roadmap', 'token': 'not printed'}))
            with self.assertRaisesRegex(RuntimeError, 'release lock is held'):
                call(self.install_arguments())
            _, report = call(['inspect'])
            self.assertEqual((report['deployment_lock_present'], report['deployment_lock_owner']),
                             (True, {'action': 'roadmap', 'sha': 'e' * 40}))
            (lock / 'owner.json').unlink()
            lock.rmdir()
            self.install()
            second = write_feed(self.temporary / 'feed-2', {'pos': '0.5.1'})
            lock.mkdir()
            for arguments in [self.publish_arguments('feed-2', second, 'kitchen-0.4.0-pos-0.5.0'),
                              self.publish_arguments('feed-2', second, 'kitchen-0.4.0-pos-0.5.0') + ['--apply']]:
                with self.assertRaisesRegex(RuntimeError, 'release lock is held'):
                    call(arguments)
            self.assertTrue(lock.is_dir())
            _, report = call(['inspect'])
            self.assertIsNone(report['deployment_lock_owner'])

    def test_the_lock_names_this_step_while_it_runs(self):
        seen = []
        real = d.verify_refusals

        def refusals(origin, manifests):
            seen.append(json.loads((self.world.root / '.market-release.lock/owner.json').read_text()))
            return real(origin, manifests)

        with self.world.active(), patch.object(d, 'verify_refusals', refusals):
            self.install()
            second = write_feed(self.temporary / 'feed-2', {'pos': '0.5.1'})
            call(self.publish_arguments('feed-2', second, 'kitchen-0.4.0-pos-0.5.0') + ['--apply'])
            call(['withdraw', *self.signed, '--to', 'kitchen-0.4.0-pos-0.5.0',
                  '--expected-current', 'kitchen-0.4.0-pos-0.5.1', '--apply'])
        self.assertEqual([(owner['action'], owner['sha'], owner['feed_release']) for owner in seen[-3:]],
                         [('desktop-updates-install', 'c' * 40, 'kitchen-0.4.0-pos-0.5.0'),
                          ('desktop-updates-publish', 'c' * 40, 'kitchen-0.4.0-pos-0.5.1'),
                          ('desktop-updates-withdraw', 'c' * 40, 'kitchen-0.4.0-pos-0.5.0')])
        self.assertTrue(all(re.fullmatch('[0-9a-f-]{36}', owner['id']) for owner in seen))
        self.assertFalse((self.world.root / '.market-release.lock').exists())

    def test_one_off_jobs_of_the_server_are_not_services(self):
        job = 'pickchick-staging-provision-run-0a1b2c3d4e5f'
        with self.world.active():
            # Present at the first snapshot, gone when the gateway is switched.
            self.world.oneoff.add(job)
            real = self.world.run

            def run(command, timeout=90):
                if command[:2] == ['docker', 'compose'] and command[-1] == 'gateway':
                    self.world.oneoff.discard(job)
                return real(command, timeout)

            with patch.object(b, 'run', run):
                outcome = self.install()
            self.assertEqual(outcome['unchanged_services'], ['pickchick-staging-api-1'])
            # Appears while the installers of a new version are read, and one more is listed by
            # Docker and already removed when the step asks about it.
            second = write_feed(self.temporary / 'feed-2', {'pos': '0.5.1', 'kitchen': '0.4.1'})
            served = d.verify_served

            def verify(origin, manifests, installers=True):
                self.world.oneoff.add(job)
                self.world.vanishing.append('pickchick-staging-provision-run-ffffffffffff')
                return served(origin, manifests, installers)

            with patch.object(d, 'verify_served', verify):
                code, outcome = call(self.publish_arguments('feed-2', second, 'kitchen-0.4.0-pos-0.5.0')
                                     + ['--apply'])
            self.assertEqual((code, outcome['status']), (0, 'deployed'))
            self.assertNotIn(job, d.containers())
            # A service that is not a one-off job still stops the step.
            third = write_feed(self.temporary / 'feed-3', {'pos': '0.5.2'})

            def restart(origin, manifests, installers=True):
                if installers:
                    self.world.generation['pickchick-staging-api-1'] += 1
                return served(origin, manifests, installers)

            with patch.object(d, 'verify_served', restart):
                code, outcome = call(self.publish_arguments('feed-3', third, 'kitchen-0.4.1-pos-0.5.1')
                                     + ['--apply'])
            self.assertEqual((code, outcome['status'], outcome['detail']),
                             (1, 'rolled_back', 'A container changed during a file-only step'))
            self.assertFalse((self.world.root / '.market-release.lock').exists())

    def test_a_container_that_stays_missing_is_an_error_not_a_guess(self):
        with self.world.active():
            self.world.vanishing = ['ghost'] * 3
            with self.assertRaisesRegex(RuntimeError, 'Command failed'):
                d.containers()
            self.world.vanishing = ['ghost'] * 2
            self.assertEqual(sorted(d.containers()), ['pickchick-public-gateway', 'pickchick-staging-api-1'])

            def slow(command, timeout=90):
                raise b.Uncertain('Command timed out; inspect Docker before any retry')

            with patch.object(b, 'run', slow), self.assertRaises(b.Uncertain):
                d.containers()

    def test_an_apply_run_outlives_its_terminal_and_a_stop_request_goes_the_way_back(self):
        with self.world.active():
            call(self.install_arguments())
            self.assertEqual(self.world.signals, {})
            real = self.world.run

            def run(command, timeout=90):
                if command[:2] == ['docker', 'compose'] and command[-1] == 'gateway' and \
                        Path(command[command.index('-f') + 1]).read_text() != 'installed':
                    # What the SIGTERM handler raises, in the middle of the gateway switch.
                    self.world.signals[d.signal.SIGTERM](d.signal.SIGTERM, None)
                return real(command, timeout)

            with patch.object(b, 'run', run):
                code, outcome = call(self.install_arguments() + ['--apply'])
            self.assertEqual((code, outcome['status'], outcome['reason']), (1, 'rolled_back', 'SystemExit'))
            self.assertIs(self.world.signals[d.signal.SIGHUP], d.signal.SIG_IGN)
            self.assertFalse((self.world.root / '.market-release.lock').exists())
            self.assertIsNone(self.world.sidecar)
            self.install()

    def test_the_journal_names_how_far_a_run_came(self):
        deployments = self.world.root / 'desktop-updates/deployments'
        seen = []

        def note(real):
            def hook(*arguments, **options):
                # What would be left on disk if the process were killed at this point.
                owner = json.loads((self.world.root / '.market-release.lock/owner.json').read_text())
                (path,) = deployments.glob(owner['action'].removeprefix('desktop-updates-') + '-*.json')
                record = json.loads(path.read_text())
                seen.append((record['action'], record['status'], record['phase']))
                return real(*arguments, **options)
            return hook

        def last(action):
            (path,) = deployments.glob(action + '-*.json')
            record = json.loads(path.read_text())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            return record['status'], record['phase'], record['feed_release']

        with self.world.active(), patch.object(d, 'copy_release', note(d.copy_release)), \
                patch.object(d, 'sidecar_serves', note(d.sidecar_serves)), \
                patch.object(d, 'verify_refusals', note(d.verify_refusals)):
            self.install()
            self.assertEqual(last('install'), ('deployed', 'publish_pointers', 'kitchen-0.4.0-pos-0.5.0'))
            second = write_feed(self.temporary / 'feed-2', {'pos': '0.5.1'})
            call(self.publish_arguments('feed-2', second, 'kitchen-0.4.0-pos-0.5.0') + ['--apply'])
            self.assertEqual(last('publish'), ('deployed', 'verify', 'kitchen-0.4.0-pos-0.5.1'))
            call(['withdraw', *self.signed, '--to', 'kitchen-0.4.0-pos-0.5.0',
                  '--expected-current', 'kitchen-0.4.0-pos-0.5.1', '--apply'])
            self.assertEqual(last('withdraw'), ('deployed', 'verify', 'kitchen-0.4.0-pos-0.5.0'))
        self.assertEqual(seen, [('install', 'preparing', 'prepare'),
                                ('install', 'preparing', 'start_feed_container'),
                                ('install', 'preparing', 'verify'), ('install', 'preparing', 'verify'),
                                ('publish', 'preparing', 'copy'), ('publish', 'preparing', 'verify'),
                                ('withdraw', 'preparing', 'verify')])

    def test_an_ending_that_keeps_the_lock_is_printed_by_the_step_itself(self):
        lock = self.world.root / '.market-release.lock'
        with self.world.active():
            real = self.world.run

            def hangs(command, timeout=90):
                if command[:2] == ['docker', 'compose'] and command[-1] == 'gateway':
                    raise b.Uncertain('Command timed out; inspect Docker before any retry')
                return real(command, timeout)

            with patch.object(b, 'run', hangs):
                outcome = stopped(self, self.install_arguments() + ['--apply'], 'timed out', b.Uncertain)
            self.assertEqual((outcome['status'], outcome['lock_retained'], outcome['phase'], outcome['reason'],
                              outcome['detail']),
                             ('uncertain', True, 'switch_gateway', 'Uncertain',
                              'Command timed out; inspect Docker before any retry'))
            self.assertEqual(json.loads(Path(outcome['journal']).read_text()), outcome)
            # Nothing was taken back: the feed container runs, and the lock names the step.
            self.assertIsNotNone(self.world.sidecar)
            _, report = call(['inspect'])
            self.assertEqual((report['deployment_lock_present'], report['deployment_lock_owner']),
                             (True, {'action': 'desktop-updates-install', 'sha': 'c' * 40,
                                     'feed_release': 'kitchen-0.4.0-pos-0.5.0'}))
            # A repeat is refused, and a refusal prints no outcome: its error line is the whole answer.
            self.assertIsNone(stopped(self, self.install_arguments() + ['--apply'],
                                      'A feed installation already exists'))
            self.assertTrue(lock.is_dir())

    def test_a_publish_that_cannot_go_back_says_what_failed_both_ways(self):
        with self.world.active():
            self.install()
            second = write_feed(self.temporary / 'feed-2', {'pos': '0.5.1'})
            real = b.switch
            moves = []

            def switch(path, target):
                moves.append(str(target))
                if len(moves) == 2:
                    raise OSError(5, 'Input/output error')
                return real(path, target)

            def refusals(origin, manifests):
                raise RuntimeError('Feed answers outside its two files: /desktop-updates/')

            with patch.object(b, 'switch', switch), patch.object(d, 'verify_refusals', refusals):
                outcome = stopped(self, self.publish_arguments('feed-2', second, 'kitchen-0.4.0-pos-0.5.0')
                                  + ['--apply'], 'Rollback is not confirmed; deployment lock retained')
            self.assertEqual(moves, ['releases/kitchen-0.4.0-pos-0.5.1', 'releases/kitchen-0.4.0-pos-0.5.0'])
            self.assertEqual({key: outcome[key] for key in ['status', 'lock_retained', 'phase', 'reason', 'detail',
                                                             'rollback_reason']},
                             {'status': 'rollback_needs_review', 'lock_retained': True, 'phase': 'verify',
                              'reason': 'RuntimeError', 'detail': 'Feed answers outside its two files: /desktop-updates/',
                              'rollback_reason': 'OSError'})
            self.assertEqual(json.loads(Path(outcome['journal']).read_text()), outcome)
            # What devices get now is the new release; the lock tells the next person which step it was.
            self.assertEqual(os.readlink(self.world.root / 'desktop-updates/feed/current'),
                             'releases/kitchen-0.4.0-pos-0.5.1')
            _, report = call(['inspect'])
            self.assertEqual(report['deployment_lock_owner'],
                             {'action': 'desktop-updates-publish', 'sha': 'c' * 40,
                              'feed_release': 'kitchen-0.4.0-pos-0.5.1'})

    def test_a_step_whose_lock_was_touched_still_says_how_it_ended(self):
        lock = self.world.root / '.market-release.lock'
        real = d.verify_refusals

        def refusals(origin, manifests):
            (lock / 'owner.json').write_text(json.dumps({'id': 'theirs', 'sha': 'e' * 40, 'action': 'roadmap'}))
            return real(origin, manifests)

        with self.world.active(), patch.object(d, 'verify_refusals', refusals):
            outcome = stopped(self, self.install_arguments() + ['--apply'], 'Lock owner changed')
        self.assertEqual((outcome['status'], outcome['phase']), ('deployed', 'publish_pointers'))
        self.assertNotIn('lock_retained', outcome)
        self.assertEqual(json.loads((lock / 'owner.json').read_text())['id'], 'theirs')

    def test_the_way_back_of_an_install_is_confirmed_at_the_public_address(self):
        def server(change):
            """A new server where `change` happens the moment the old gateway is started again."""
            world = World(self.temporary / ('server-%d' % len(list(self.temporary.glob('server-*')))))
            self.world = world
            real = world.run

            def run(command, timeout=90):
                result = real(command, timeout)
                if command[:2] == ['docker', 'compose'] and command[-1] == 'gateway' and \
                        Path(command[command.index('-f') + 1]).read_text() == 'installed':
                    change(world)
                return result

            world.break_feed = True
            return world, patch.object(b, 'run', run)

        # The old gateway is back, and the public address says something else from then on.
        world, run = server(lambda world: setattr(world, 'health', b'{"service":"somebody-else"}'))
        with world.active(), run:
            outcome = stopped(self, self.install_arguments() + ['--apply'], 'Rollback is not confirmed')
            self.assertEqual((outcome['status'], outcome['lock_retained'], outcome['rollback_detail']),
                             ('rollback_needs_review', True, 'Existing endpoint differs after rollback: /health/live'))
            self.assertEqual(world.slept, [3, 3])
            self.assertTrue((world.root / '.market-release.lock').is_dir())
        # The old gateway answers at its first address, the address of the devices leads elsewhere.
        world, run = server(lambda world: None)
        with world.active(), run:
            real_fetch = world.fetch

            def elsewhere(url, headers=None, method='GET', limit=d.CHUNK_BYTES):
                if url == d.FEED_ORIGIN + '/health/live' and world.generation[b.GATEWAY] == 3:
                    return 200, b'{"service":"somebody-else"}', {}
                return real_fetch(url, headers, method, limit)

            with patch.object(d, 'fetch', elsewhere):
                outcome = stopped(self, self.install_arguments() + ['--apply'], 'Rollback is not confirmed')
            self.assertEqual((outcome['status'], outcome['rollback_detail']),
                             ('rollback_needs_review', 'The feed host does not reach the gateway after rollback'))
        # Something in front of the gateway keeps answering the feed path.
        world, run = server(lambda world: setattr(world, 'stuck', '/desktop-updates/pos/latest.json'))
        with world.active(), run:
            outcome = stopped(self, self.install_arguments() + ['--apply'], 'Rollback is not confirmed')
            self.assertEqual((outcome['status'], outcome['rollback_detail']),
                             ('rollback_needs_review', 'The feed path still answers after rollback'))
        # The new container needs a moment: one request without an answer is no verdict.
        world, run = server(lambda world: setattr(world, 'blips', 1))
        with world.active(), run:
            code, outcome = call(self.install_arguments() + ['--apply'])
            self.assertEqual((code, outcome['status']), (1, 'rolled_back'))
            self.assertRegex(outcome['detail'], '^Served installer hash differs: ')
            self.assertEqual(world.slept, [3])
            self.assertFalse((world.root / '.market-release.lock').exists())
            world.break_feed = False
            self.assertEqual(call(self.install_arguments() + ['--apply'])[1]['status'], 'deployed')
        # What the API says changed by itself while the step ran: the step fails and goes back
        # cleanly, because on the way back the API is asked for its status only.
        world = World(self.temporary / 'server-api')
        self.world = world
        world.drifting = True
        with world.active():
            code, outcome = call(self.install_arguments() + ['--apply'])
            self.assertEqual((code, outcome['status'], outcome['detail']),
                             (1, 'rolled_back', 'Existing endpoint changed: /v1/capabilities'))
            self.assertEqual(world.slept, [])
            self.assertFalse((world.root / '.market-release.lock').exists())
        # A step that never touched the gateway asks the public address nothing on its way back.
        world = World(self.temporary / 'server-feed')
        self.world = world
        with world.active():
            world.fail = 'wait-timeout 60 feed'
            asked = []
            real_http = world.http
            with patch.object(b, 'http', lambda path, **options: (asked.append(path), real_http(path))[1]):
                code, outcome = call(self.install_arguments() + ['--apply'])
            self.assertEqual((code, outcome['status'], outcome['phase']), (1, 'rolled_back', 'start_feed_container'))
            self.assertEqual(asked, ['/health/live', '/v1/capabilities'])

    def test_an_install_that_fails_after_its_last_pointer_goes_all_the_way_back(self):
        with self.world.active():
            root = self.world.root
            new_public = root / 'public-https/releases' / ('c' * 40)
            real = b.digest

            def digest(path):
                if (root / 'public-https/current').resolve() == new_public:
                    raise OSError(5, 'Input/output error')
                return real(path)

            with patch.object(b, 'digest', digest):
                code, outcome = call(self.install_arguments() + ['--apply'])
            self.assertEqual((code, outcome['status'], outcome['phase'], outcome['reason']),
                             (1, 'rolled_back', 'publish_pointers', 'OSError'))
            self.assertEqual((root / 'public-https/current').resolve(), self.world.public)
            self.assertFalse((root / 'desktop-updates/sidecar/current').is_symlink())
            self.assertFalse((root / 'desktop-updates/feed/current').is_symlink())
            self.assertEqual(self.world.gateway['/etc/caddy/Caddyfile'],
                             str(self.world.public / 'infra/public-staging/gateway.Caddyfile'))
            self.assertIsNone(self.world.sidecar)
            self.assertFalse(new_public.exists())
            self.assertEqual(d.fetch(d.FEED_ORIGIN + '/desktop-updates/pos/latest.json')[0], 404)
            self.assertFalse((root / '.market-release.lock').exists())
            self.install()

    def test_a_withdraw_that_devices_cannot_read_goes_back_and_keeps_both_releases(self):
        with self.world.active():
            self.install()
            second = write_feed(self.temporary / 'feed-2', {'pos': '0.5.1'})
            call(self.publish_arguments('feed-2', second, 'kitchen-0.4.0-pos-0.5.0') + ['--apply'])
            arguments = ['withdraw', *self.signed, '--to', 'kitchen-0.4.0-pos-0.5.0',
                         '--expected-current', 'kitchen-0.4.0-pos-0.5.1', '--apply']

            def refusals(origin, manifests):
                raise RuntimeError('Feed answers outside its two files: /desktop-updates/')

            with patch.object(d, 'verify_refusals', refusals):
                code, outcome = call(arguments)
            self.assertEqual((code, outcome['status'], outcome['phase'], outcome['detail']),
                             (1, 'rolled_back', 'verify', 'Feed answers outside its two files: /desktop-updates/'))
            feed = self.world.root / 'desktop-updates/feed'
            self.assertEqual(os.readlink(feed / 'current'), 'releases/kitchen-0.4.0-pos-0.5.1')
            self.assertEqual(sorted(path.name for path in (feed / 'releases').iterdir()),
                             ['kitchen-0.4.0-pos-0.5.0', 'kitchen-0.4.0-pos-0.5.1'])
            self.assertFalse((self.world.root / '.market-release.lock').exists())
            d.verify_served(d.FEED_ORIGIN, {'kitchen': self.first['kitchen'], 'pos': second['pos']})
            code, outcome = call(arguments)
            self.assertEqual((code, outcome['status']), (0, 'deployed'))

    def test_a_copy_that_breaks_off_is_set_aside_under_a_visible_name(self):
        releases = self.world.root / 'desktop-updates/feed/releases'
        real = d.shutil.copyfile
        breaks = []

        def copyfile(source, target, **options):
            if breaks and 'feed/releases' in str(target) and Path(target).name == 'latest.json':
                breaks.pop()
                Path(target).write_text('{"half')
                raise OSError(28, 'No space left on device')
            return real(source, target, **options)

        with self.world.active(), patch.object(d.shutil, 'copyfile', copyfile):
            breaks.append(1)
            code, outcome = call(self.install_arguments() + ['--apply'])
            self.assertEqual((code, outcome['status'], outcome['phase'], outcome['reason']),
                             (1, 'rolled_back', 'prepare', 'OSError'))
            (left,) = releases.iterdir()
            self.assertRegex(left.name, r'^kitchen-0\.4\.0-pos-0\.5\.0\.FAILED-[0-9a-f]{32}$')
            self.assertFalse((self.world.root / '.market-release.lock').exists())
            self.install()
            second = write_feed(self.temporary / 'feed-2', {'pos': '0.5.1', 'kitchen': '0.4.1'})
            arguments = self.publish_arguments('feed-2', second, 'kitchen-0.4.0-pos-0.5.0') + ['--apply']
            breaks.append(1)
            code, outcome = call(arguments)
            self.assertEqual((code, outcome['status'], outcome['phase'], outcome['reason']),
                             (1, 'rolled_back', 'copy', 'OSError'))
            names = sorted(path.name for path in releases.iterdir())
            self.assertEqual(len(names), 3)
            self.assertFalse([name for name in names if name.startswith('.')])
            self.assertEqual([re.sub('[0-9a-f]{32}$', '', name) for name in names],
                             ['kitchen-0.4.0-pos-0.5.0', 'kitchen-0.4.0-pos-0.5.0.FAILED-',
                              'kitchen-0.4.1-pos-0.5.1.FAILED-'])
            _, report = call(['inspect'])
            self.assertEqual(report['releases_on_disk'], ['kitchen-0.4.0-pos-0.5.0'])
            code, outcome = call(arguments)
            self.assertEqual((code, outcome['status']), (0, 'deployed'))

    def test_a_rebuilt_program_of_a_published_version_is_never_published_by_a_hint(self):
        with self.world.active():
            self.install()
            second = write_feed(self.temporary / 'feed-2', {'pos': '0.5.1'})
            publish = self.publish_arguments('feed-2', second, 'kitchen-0.4.0-pos-0.5.0')
            call(publish + ['--apply'])
            call(['withdraw', *self.signed, '--to', 'kitchen-0.4.0-pos-0.5.0',
                  '--expected-current', 'kitchen-0.4.0-pos-0.5.1', '--apply'])
            # The very same build again: the withdrawn release is named.
            for arguments in (publish, publish + ['--apply']):
                with self.assertRaisesRegex(RuntimeError, 'These builds are already on the server as '
                                            'kitchen-0.4.0-pos-0.5.1: withdraw --to it publishes them again'):
                    call(arguments)
            # The same version built again: other bytes, so the hint would publish the old ones.
            rebuilt = {'pos': write_app(self.temporary / 'feed-2b/pos', 'pos', '0.5.1', seed='rebuilt')}
            self.assertNotEqual(rebuilt['pos']['sha256'], second['pos']['sha256'])
            for arguments in (self.publish_arguments('feed-2b', rebuilt, 'kitchen-0.4.0-pos-0.5.0'),
                              self.publish_arguments('feed-2b', rebuilt, 'kitchen-0.4.0-pos-0.5.0') + ['--apply']):
                with self.assertRaisesRegex(RuntimeError, 'Other builds of the same versions are on the server as '
                                            'kitchen-0.4.0-pos-0.5.1: raise the version'):
                    call(arguments)
            # The same installer with another instruction for the devices is another release too.
            urgent = {'pos': write_app(self.temporary / 'feed-2c/pos', 'pos', '0.5.1', apply='now')}
            self.assertEqual(urgent['pos']['sha256'], second['pos']['sha256'])
            with self.assertRaisesRegex(RuntimeError, 'Other builds of the same versions'):
                call(self.publish_arguments('feed-2c', urgent, 'kitchen-0.4.0-pos-0.5.0'))
            self.assertEqual(os.readlink(self.world.root / 'desktop-updates/feed/current'),
                             'releases/kitchen-0.4.0-pos-0.5.0')
            self.assertFalse((self.world.root / '.market-release.lock').exists())
            code, outcome = call(['withdraw', *self.signed, '--to', 'kitchen-0.4.0-pos-0.5.1',
                                  '--expected-current', 'kitchen-0.4.0-pos-0.5.0', '--apply'])
            self.assertEqual((code, outcome['status']), (0, 'deployed'))
            d.verify_served(d.FEED_ORIGIN, {'kitchen': self.first['kitchen'], 'pos': second['pos']})

    def test_the_journal_decides_only_before_the_first_change(self):
        lock = self.world.root / '.market-release.lock'
        deployments = self.world.root / 'desktop-updates/deployments'
        real = b.save
        allowed = [0]
        written = []

        def save(path, value):
            if path.parent.name == 'deployments':
                written.append(value['phase'])
                if len(written) > allowed[0]:
                    # Half a file, the way a full disk or a revoked right leaves it.
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text('{"half')
                    raise PermissionError(13, 'Permission denied')
            return real(path, value)

        with self.world.active(), patch.object(b, 'save', save):
            # The first line cannot be written: a refusal while nothing is changed.
            self.assertIsNone(stopped(self, self.install_arguments() + ['--apply'],
                                      'The journal of the step cannot be written: PermissionError; '
                                      'nothing was changed and the release lock is free'))
            self.assertFalse(lock.exists())
            self.assertEqual(list(deployments.iterdir()), [])
            self.assertIsNone(self.world.sidecar)
            self.assertEqual(self.world.generation[b.GATEWAY], 1)
            # Every later line fails: the install ends as it would have ended and says what is missing.
            allowed[0], written[:] = 1, []
            code, outcome = call(self.install_arguments() + ['--apply'])
            self.assertEqual((code, outcome['status'], outcome['journal_not_written']),
                             (0, 'deployed', 'PermissionError'))
            self.assertEqual(written, ['prepare', 'start_feed_container', 'switch_gateway', 'verify',
                                       'publish_pointers', 'publish_pointers'])
            self.assertFalse(lock.exists())
            # The file holds the last state that was written whole, and no half of a later one.
            (journal,) = deployments.iterdir()
            self.assertEqual(str(journal), outcome['journal'])
            self.assertEqual((json.loads(journal.read_text())['phase'], journal.stat().st_mode & 0o777),
                             ('prepare', 0o600))
            # The way back does not depend on the journal either.
            second = write_feed(self.temporary / 'feed-2', {'pos': '0.5.1'})

            def refusals(origin, manifests):
                raise RuntimeError('Feed answers outside its two files: /desktop-updates/')

            allowed[0], written[:] = 1, []
            with patch.object(d, 'verify_refusals', refusals):
                code, outcome = call(self.publish_arguments('feed-2', second, 'kitchen-0.4.0-pos-0.5.0')
                                     + ['--apply'])
            self.assertEqual((code, outcome['status'], outcome['journal_not_written']),
                             (1, 'rolled_back', 'PermissionError'))
            self.assertFalse(lock.exists())
            self.assertEqual(os.readlink(self.world.root / 'desktop-updates/feed/current'),
                             'releases/kitchen-0.4.0-pos-0.5.0')
            self.assertEqual(sorted(path.name[:7] for path in deployments.iterdir()), ['install', 'publish'])
            # One line that could not be written is forgotten once the journal is whole again.
            allowed[0], written[:] = 99, []
            real_reached = d.reached

            def reached(journal, outcome, phase):
                if phase == 'verify':
                    allowed[0] = 0
                real_reached(journal, outcome, phase)
                allowed[0] = 99

            with patch.object(d, 'reached', reached):
                code, outcome = call(self.publish_arguments('feed-2', second, 'kitchen-0.4.0-pos-0.5.0')
                                     + ['--apply'])
            self.assertEqual((code, outcome['status']), (0, 'deployed'))
            self.assertNotIn('journal_not_written', outcome)
            self.assertEqual(json.loads(Path(outcome['journal']).read_text()), outcome)

    def test_a_lock_taken_or_a_stop_in_the_last_moment_leaves_the_lock_as_it_was(self):
        lock = self.world.root / '.market-release.lock'
        with self.world.active():
            real = d.lock_is_free
            asked = []

            def free():
                real()
                asked.append(1)
                if len(asked) == 1:
                    # Another release takes the lock right after the checks of this step.
                    lock.mkdir()
                    (lock / 'owner.json').write_text(json.dumps({'id': 'theirs', 'sha': 'e' * 40,
                                                                 'action': 'roadmap'}))

            with patch.object(d, 'lock_is_free', free):
                self.assertIsNone(stopped(self, self.install_arguments() + ['--apply'], 'release lock is held'))
            self.assertEqual(json.loads((lock / 'owner.json').read_text())['id'], 'theirs')
            self.assertFalse((self.world.root / 'desktop-updates').exists())
            (lock / 'owner.json').unlink()
            lock.rmdir()
            # The step is stopped while it writes its name into the lock it has just taken.
            real_save = b.save

            def save(path, value):
                if path.name == '.owner.json.tmp':
                    path.write_text('{"half')
                    raise KeyboardInterrupt
                return real_save(path, value)

            with patch.object(b, 'save', save):
                self.assertIsNone(stopped(self, self.install_arguments() + ['--apply'],
                                          'Interrupted: KeyboardInterrupt; nothing was changed and the '
                                          'release lock is free'))
            self.assertFalse(lock.exists())
            self.install()

    def test_package_holds_exactly_the_reviewed_files(self):
        source = (ROOT / 'infra/desktop-updates/package.py').read_text()
        for name in d.PACKAGE_FILES:
            self.assertIn("'" + name + "'", source)
        self.assertEqual(source.count("'infra/"), len(d.PACKAGE_FILES))


if __name__ == '__main__':
    unittest.main()
