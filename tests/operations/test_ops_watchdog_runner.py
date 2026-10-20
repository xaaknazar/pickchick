"""Host side of the ops watchdog with fake docker; never touches the real host or VPS."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'infra/staging/watchdog/run-watchdog.py'
spec = importlib.util.spec_from_file_location('ops_watchdog_runner', SOURCE)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

SECRET_TOKEN = '000000:TEST_ONLY_not_a_real_bot_token_xxxxxxxx'
SECRET_PASSWORD = 'ab' * 32
NOW = 1_760_000_000


def completed(stdout='', stderr='', returncode=0):
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


class FakeDocker:
    def __init__(self, containers=None, logs=None, probe=None, available=True):
        self.calls = []
        self.containers = containers if containers is not None else {
            name: {'status': 'running', 'running': True, 'health': None, 'restarts': 0,
                   'startedAt': '2026-10-08T01:02:03.123456789Z'} for name in runner.CONTAINERS.values()}
        self.logs = logs or {}
        self.probe = probe
        self.available = available

    def __call__(self, command, **kwargs):
        self.calls.append(command)
        assert command[0] == 'docker' and kwargs.get('timeout'), command
        sub = command[1]
        if not self.available:
            return completed(returncode=1, stderr='Cannot connect to the Docker daemon')
        if sub == 'version':
            return completed('29.7.2\n')
        if sub == 'inspect':
            info = self.containers.get(command[-1])
            return completed(json.dumps(info)) if info else completed(returncode=1, stderr='No such container')
        if sub == 'logs':
            stdout, stderr = self.logs.get(command[-1], ('', ''))
            return completed(stdout, stderr)
        if sub == 'exec':
            return completed(self.probe or '', returncode=0)
        raise AssertionError('unexpected docker command ' + sub)


def settings(**extra):
    text = '\n'.join(['WATCHDOG_TELEGRAM_BOT_TOKEN=' + SECRET_TOKEN, 'WATCHDOG_DB_PASSWORD=' + SECRET_PASSWORD]
                     + [key + '=' + value for key, value in extra.items()])
    return runner.parse_settings(text)


class Settings(unittest.TestCase):
    def test_defaults_and_secrets_are_not_retained(self):
        parsed = settings()
        self.assertEqual(parsed, {'window': 600, 'disks': ['/', '/var/lib/docker', '/opt/pickchick-staging/backups'],
                                  'backups': '/opt/pickchick-staging/backups',
                                  'network': 'pickchick-staging_private', 'probe_hours': 0,
                                  'fulfillment': None})
        self.assertNotIn(SECRET_TOKEN, json.dumps(parsed))
        self.assertNotIn(SECRET_PASSWORD, json.dumps(parsed))

    def test_invalid_values_name_the_key_only(self):
        for key, value in [('WATCHDOG_LOG_WINDOW_SECONDS', '60'), ('WATCHDOG_DISK_PATHS', 'relative/path'),
                           ('WATCHDOG_DISK_PATHS', '/;rm -rf /'), ('WATCHDOG_BACKUP_DIR', '/x y'),
                           ('WATCHDOG_STAGING_NETWORK', '-bad'), ('WATCHDOG_KASPI_SESSION_PROBE_HOURS', '1'),
                           ('WATCHDOG_FULFILLMENT_CONTAINER', 'x;rm')]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError) as error:
                settings(**{key: value})
            self.assertEqual(str(error.exception), key)


class Sanitizing(unittest.TestCase):
    def test_worker_lines_keep_only_whitelisted_fields(self):
        line = ('2026-10-09T05:58:00.123456789Z {"event":"kaspi_remote_attention","sessionRejected":true,'
                '"unknownOverdue":1,"errors":2,"phone":"+77000000000","token":"secret"}')
        self.assertEqual(runner.sanitize_worker_line('kaspi-remote-worker', line), {
            'at': '2026-10-09T05:58:00Z', 'event': 'kaspi_remote_attention', 'errors': 2,
            'unknownOverdue': 1, 'sessionProblem': True})
        tick = '2026-10-09T05:59:00Z {"event":"kiosk_kaspi_qr","submitted":1,"checked":0,"errors":0,"sessionProblem":false,"unknownOverdue":0}'
        self.assertEqual(runner.sanitize_worker_line('kiosk-qr-worker', tick), {
            'at': '2026-10-09T05:59:00Z', 'event': 'kiosk_kaspi_qr', 'errors': 0, 'unknownOverdue': 0,
            'submitted': 1, 'checked': 0, 'sessionProblem': False})
        # Pay lane attention shape (PM interface 19.10) and its recovery line.
        attention = ('2026-10-09T06:00:00Z {"event":"kaspi_remote_attention","sessionProblem":true,'
                     '"sessionRejected":true,"reason":"bridge_unreachable","unknownOverdue":0,"errors":0,'
                     '"pendingUnsent":2,"oldestUnsentSeconds":150,"detail":"http://10.0.0.1 secret"}')
        self.assertEqual(runner.sanitize_worker_line('kaspi-remote-worker', attention), {
            'at': '2026-10-09T06:00:00Z', 'event': 'kaspi_remote_attention', 'errors': 0, 'unknownOverdue': 0,
            'pendingUnsent': 2, 'oldestUnsentSeconds': 150, 'sessionProblem': True,
            'reason': 'bridge_unreachable'})
        recovered = ('2026-10-09T06:05:00Z {"event":"kaspi_remote_attention","recovered":true,'
                     '"sessionProblem":false}')
        self.assertEqual(runner.sanitize_worker_line('kaspi-remote-worker', recovered), {
            'at': '2026-10-09T06:05:00Z', 'event': 'kaspi_remote_attention', 'sessionProblem': False,
            'recovered': True})
        odd_reason = attention.replace('bridge_unreachable', 'Bearer abc')
        self.assertNotIn('reason', runner.sanitize_worker_line('kaspi-remote-worker', odd_reason))
        for role, text in [
            ('kiosk-qr-worker', line),  # another worker's event name
            ('kaspi-remote-worker', '2026-10-09T05:58:00Z not json at all'),
            ('kaspi-remote-worker', '{"event":"kaspi_remote_failed"}'),  # no docker timestamp
            ('kaspi-remote-worker', '2026-10-09T05:58:00Z {"event":"kaspi_remote_failed","x":"' + 'a' * 5000 + '"}'),
            ('kaspi-remote-worker', '2026-10-09T05:58:00Z {"event":"kaspi_remote","errors":true,"unknownOverdue":-1}x'),
        ]:
            with self.subTest(text=text[:60]):
                self.assertIsNone(runner.sanitize_worker_line(role, text))
        odd = runner.sanitize_worker_line(
            'kaspi-remote-worker', '2026-10-09T05:58:00Z {"event":"kaspi_remote","errors":true,"unknownOverdue":-1,"state":"weird"}')
        self.assertEqual(odd, {'at': '2026-10-09T05:58:00Z', 'event': 'kaspi_remote'})

    def test_fulfillment_lines_keep_counts_and_reason_codes_only(self):
        line = ('2026-10-09T05:58:00Z {"event":"fulfillment_transport_attention","deferred":2,"parked":1,'
                '"reasons":{"KITCHEN_OFFLINE":2,"phone +7700":1,"ITEM_STOPPED":"x"},"unresolvedFailures":1,'
                '"orderId":"abc"}')
        self.assertEqual(runner.sanitize_fulfillment_line(line), {
            'at': '2026-10-09T05:58:00Z', 'event': 'fulfillment_transport_attention', 'deferred': 2,
            'parked': 1, 'unresolvedFailures': 1, 'reasons': {'KITCHEN_OFFLINE': 2}})
        self.assertEqual(runner.sanitize_fulfillment_line(
            '2026-10-09T06:00:00Z {"event":"fulfillment_transport_attention","recovered":true}'),
            {'at': '2026-10-09T06:00:00Z', 'event': 'fulfillment_transport_attention', 'recovered': True})
        self.assertIsNone(runner.sanitize_fulfillment_line(
            '2026-10-09T06:00:00Z {"event":"fulfillment_transport","state":"applied"}'))

    def test_inspect_output_is_reduced_to_state(self):
        parsed = runner.parse_inspect(json.dumps({'status': 'running', 'running': True, 'health': 'healthy',
                                                  'restarts': 3, 'startedAt': '2026-10-08T01:02:03.5Z'}))
        self.assertEqual(parsed, {'present': True, 'status': 'running', 'running': True, 'health': 'healthy',
                                  'restarts': 3, 'startedAt': '2026-10-08T01:02:03Z'})
        never = runner.parse_inspect(json.dumps({'status': 'created', 'running': False, 'health': None,
                                                 'restarts': 0, 'startedAt': '0001-01-01T00:00:00Z'}))
        self.assertEqual((never['running'], never['startedAt']), (False, None))


class HostFacts(unittest.TestCase):
    def test_disk_usage_matches_df_and_deduplicates_filesystems(self):
        class Vfs:
            f_blocks, f_bfree, f_bavail, f_frsize = 1000, 200, 150, 4096
        devices = {'/': 1, '/opt/pickchick-staging/backups': 1, '/var/lib/docker': 2}

        def device(path):
            if path == '/missing':
                raise FileNotFoundError(path)
            return devices[path]
        result = runner.disk_usage(['/', '/opt/pickchick-staging/backups', '/var/lib/docker', '/missing'],
                                   statvfs=lambda path: Vfs, device=device)
        self.assertEqual([item['path'] for item in result], ['/', '/var/lib/docker', '/missing'])
        self.assertEqual(result[0], {'path': '/', 'usedPercent': 84.2, 'sizeBytes': 4096000, 'availBytes': 614400})
        self.assertEqual(result[2], {'path': '/missing', 'error': 'unavailable'})

    def test_backup_listing_reports_completed_copies_only_by_name(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            for index, stamp in enumerate(['20261007T021500Z', '20261008T021500Z', '20261009T021500Z']):
                path = directory / ('cloud-' + stamp + '.dump.age')
                path.write_bytes(b'x' * (index + 1))
                os.utime(path, (NOW + index, NOW + index))
            (directory / 'cloud-20261008T021500Z.dump.age.sha256').write_text('hash\n')
            (directory / 'cloud-20261009T021500Z.dump.age.tmp').write_text('partial')
            (directory / 'notes.txt').write_text('ignored')
            os.symlink(directory / 'notes.txt', directory / 'cloud-20261010T021500Z.dump.age')
            listing = runner.list_backups(str(directory))
            self.assertEqual([(item['name'], item['checksum'], item['sizeBytes']) for item in listing['files']], [
                ('cloud-20261009T021500Z.dump.age', False, 3),
                ('cloud-20261008T021500Z.dump.age', True, 2),
                ('cloud-20261007T021500Z.dump.age', False, 1)])
            self.assertRegex(listing['files'][0]['mtime'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
        self.assertEqual(runner.list_backups('/nonexistent/watchdog'), {'error': 'unavailable', 'files': []})

    def test_backup_status_files_are_whitelisted(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            (directory / 'backup-status.json').write_text(json.dumps({
                'lastAttemptAt': '2026-10-09T02:15:00Z', 'lastSuccessAt': None, 'ok': False, 'stage': 'offsite',
                'note': 'secret'}))
            (directory / 'offsite-status.json').write_text(json.dumps({
                'enabled': True, 'lastAttemptAt': '2026-10-09T02:16:00Z', 'lastSuccessAt': '2026-10-08T02:16:00Z',
                'ok': False, 'object': 'pickchick-staging/dumps/x', 'sizeBytes': 10}))
            (directory / 'wal.json').write_text('{}')
            os.symlink(directory / 'wal.json', directory / 'wal-status.json')
            listing = runner.list_backups(str(directory))
            self.assertEqual(listing['status'], {'lastAttemptAt': '2026-10-09T02:15:00Z', 'ok': False,
                                                 'stage': 'offsite'})
            self.assertEqual(listing['offsite'], {'enabled': True, 'lastAttemptAt': '2026-10-09T02:16:00Z',
                                                  'lastSuccessAt': '2026-10-08T02:16:00Z', 'ok': False,
                                                  'sizeBytes': 10})
            self.assertNotIn('wal', listing)
            (directory / 'backup-status.json').write_text('{"stage": "' + 'x' * 5000 + '"}')
            self.assertNotIn('status', runner.list_backups(str(directory)))

    def test_collect_uses_only_read_only_docker_commands_without_probe(self):
        logs = {'pickchick-kaspi-worker': (
            '2026-10-09T05:50:00Z {"event":"kaspi_remote","submitted":1,"checked":0,"errors":0,"sessionProblem":false,"unknownOverdue":0}\n',
            '2026-10-09T05:55:00Z {"event":"kaspi_remote_attention","sessionRejected":true,"unknownOverdue":0,"errors":1}\n'
            'Error: something else entirely with a secret ' + SECRET_TOKEN + '\n')}
        fake = FakeDocker(logs=logs)
        with tempfile.TemporaryDirectory() as name:
            facts = runner.collect(settings(WATCHDOG_DISK_PATHS='/', WATCHDOG_BACKUP_DIR=name), run=fake,
                                   now=lambda: NOW, state_dir=Path(name))
        self.assertEqual({call[1] for call in fake.calls}, {'version', 'inspect', 'logs'})
        self.assertTrue(all(call[1] != 'exec' for call in fake.calls))
        self.assertEqual(facts['collectorErrors'], [])
        self.assertEqual(facts['containers']['kaspi-bridge']['startedAt'], '2026-10-08T01:02:03Z')
        self.assertEqual([event['event'] for event in facts['workerEvents']['kaspi-remote-worker']],
                         ['kaspi_remote', 'kaspi_remote_attention'])
        self.assertTrue(facts['workerEvents']['kaspi-remote-worker'][1]['sessionProblem'])
        self.assertIsNone(facts['kaspiSessionProbe'])
        self.assertNotIn(SECRET_TOKEN, json.dumps(facts))
        self.assertEqual(facts['version'], 1)

    def test_fulfillment_container_logs_are_read_only_when_configured(self):
        logs = {'pickchick-fulfillment-worker': (
            '', '2026-10-09T05:55:00Z {"event":"fulfillment_transport_attention","deferred":1,"parked":0}\n')}
        fake = FakeDocker(logs=logs)
        facts = runner.collect(settings(WATCHDOG_DISK_PATHS='/'), run=fake, now=lambda: NOW,
                               state_dir=Path('/nonexistent'))
        self.assertEqual((facts['fulfillmentEvents'], facts['fulfillmentCollected']), ([], False))
        configured = runner.collect(settings(WATCHDOG_DISK_PATHS='/',
                                             WATCHDOG_FULFILLMENT_CONTAINER='pickchick-fulfillment-worker'),
                                    run=fake, now=lambda: NOW, state_dir=Path('/nonexistent'))
        self.assertTrue(configured['fulfillmentCollected'])
        self.assertEqual(configured['fulfillmentEvents'], [{
            'at': '2026-10-09T05:55:00Z', 'event': 'fulfillment_transport_attention', 'deferred': 1, 'parked': 0}])

    def test_missing_containers_and_docker_outage_are_explicit(self):
        missing = FakeDocker(containers={})
        facts = runner.collect(settings(WATCHDOG_DISK_PATHS='/'), run=missing, now=lambda: NOW,
                               state_dir=Path('/nonexistent'))
        self.assertEqual(facts['containers']['kaspi-remote-worker'], {'present': False})
        self.assertNotIn('logs', {call[1] for call in missing.calls})
        down = runner.collect(settings(WATCHDOG_DISK_PATHS='/'), run=FakeDocker(available=False),
                              now=lambda: NOW, state_dir=Path('/nonexistent'))
        self.assertEqual(down['collectorErrors'], ['docker_unavailable'])

    def test_optional_session_probe_reuses_session_check_and_respects_interval(self):
        output = '{"active":false,"reason":"not_verified","invoiceAttempted":false}\n'
        fake = FakeDocker(probe=output)
        with tempfile.TemporaryDirectory() as name:
            state = Path(name)
            config = settings(WATCHDOG_KASPI_SESSION_PROBE_HOURS='6', WATCHDOG_DISK_PATHS='/')
            first = runner.collect(config, run=fake, now=lambda: NOW, state_dir=state)
            execs = [call for call in fake.calls if call[1] == 'exec']
            self.assertEqual(execs, [['docker', 'exec', 'pickchick-kaspi-bridge', 'node',
                                      '--env-file=/run/kaspi/session.env', 'session-check.mjs']])
            self.assertEqual(first['kaspiSessionProbe'], {'checkedAt': runner.iso(NOW), 'active': False,
                                                          'reason': 'not_verified'})
            self.assertEqual(os.stat(state / 'kaspi-session-probe.json').st_mode & 0o777, 0o600)
            later = runner.collect(config, run=fake, now=lambda: NOW + 5 * 3600, state_dir=state)
            self.assertEqual(len([call for call in fake.calls if call[1] == 'exec']), 1)
            self.assertEqual(later['kaspiSessionProbe'], first['kaspiSessionProbe'])
            runner.collect(config, run=fake, now=lambda: NOW + 6 * 3600 + 1, state_dir=state)
            self.assertEqual(len([call for call in fake.calls if call[1] == 'exec']), 2)
            garbage = FakeDocker(probe='{"active":true,"invoiceAttempted":true}')
            (state / 'kaspi-session-probe.json').unlink()
            odd = runner.collect(config, run=garbage, now=lambda: NOW, state_dir=state)
            self.assertEqual(odd['kaspiSessionProbe']['active'], None)
            self.assertIn('probe_unavailable', odd['collectorErrors'])


class Launch(unittest.TestCase):
    def test_compose_command_and_environment_carry_paths_not_secrets(self):
        release = Path('/opt/pickchick-staging/releases/' + 'a' * 40)
        self.assertEqual(runner.compose_command(release, ['--dry-run']), [
            'docker', 'compose', '-p', 'pickchick-watchdog', '-f',
            str(release / 'infra/staging/watchdog/compose.yaml'), 'run', '--rm', '--no-deps', '-T', 'watchdog',
            '--dry-run'])
        environment = runner.compose_environment('a' * 40, settings(), 1001, 1002, {
            'PATH': '/usr/bin', 'HOME': '/home/pickchick-ops', 'WATCHDOG_TELEGRAM_BOT_TOKEN': SECRET_TOKEN,
            'DOCKER_HOST': 'tcp://elsewhere'})
        self.assertEqual(environment, {
            'PATH': '/usr/bin', 'HOME': '/home/pickchick-ops', 'WATCHDOG_RELEASE_SHA': 'a' * 40,
            'WATCHDOG_UID': '1001', 'WATCHDOG_GID': '1002',
            'WATCHDOG_ENV_FILE': '/opt/pickchick-staging/secrets/watchdog.env',
            'WATCHDOG_FACTS_FILE': '/opt/pickchick-staging/watchdog/host-facts.json',
            'WATCHDOG_STATE_DIR': '/opt/pickchick-staging/watchdog/state',
            'WATCHDOG_STAGING_NETWORK': 'pickchick-staging_private'})

    def test_runs_only_from_a_pinned_release_tree(self):
        with self.assertRaises(RuntimeError):
            runner.release_of(SOURCE)

    def test_source_never_mutates_containers(self):
        text = SOURCE.read_text()
        for verb in ['rm', 'stop', 'restart', 'kill', 'start', 'pull', 'build', 'prune', 'down', 'up', 'cp']:
            self.assertIsNone(re.search(r"'" + verb + r"'", text), verb)
        self.assertEqual(text.count("'exec'"), 1)
        compose = (ROOT / 'infra/staging/watchdog/compose.yaml').read_text()
        self.assertNotIn('docker.sock', compose)
        self.assertNotIn('ports:', compose)
        self.assertIn('read_only: true', compose)


if __name__ == '__main__':
    unittest.main()
