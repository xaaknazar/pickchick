"""Off-site backups, backup.sh status and the restore-drill comparison, with fakes only.

A loopback S3 double checks every SigV4 signature; a fake `docker` stands in for the VPS
containers; the real `age` binary encrypts with a throwaway key. Nothing leaves this machine.
"""
import base64
import gzip
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
import urllib.parse

ROOT = Path(__file__).resolve().parents[2]
STAGING = ROOT / 'infra/staging'


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, STAGING / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


offsite = load('backup_offsite', 'backup-offsite.py')
drill = load('restore_drill', 'restore-drill.py')
ACCESS = 'TESTONLYACCESSKEY'
SECRET = 'TEST_ONLY_secret_not_real_0123456789'
HAS_AGE = shutil.which('age') is not None and shutil.which('age-keygen') is not None


class FakeS3(http.server.ThreadingHTTPServer):
    """Path-style S3 double: verifies SigV4 + Content-MD5, stores objects, lists, fails on demand."""

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.objects, self.order, self.fail, self.refuse = {}, [], 0, False
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    @property
    def endpoint(self):
        return 'http://127.0.0.1:' + str(self.server_address[1])

    def close(self):
        self.shutdown()
        self.server_close()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _verify(self, body):
        split = urllib.parse.urlsplit(self.path)
        query = dict(urllib.parse.parse_qsl(split.query, keep_blank_values=True))
        auth = self.headers['Authorization']
        signed = re.search(r'SignedHeaders=([^,]+)', auth).group(1).split(';')
        headers = {name: self.headers[name] for name in signed if name != 'host'}
        expected = offsite.sign_v4(self.command, self.headers['Host'], urllib.parse.unquote(split.path),
                                   query, headers, self.headers['x-amz-content-sha256'], ACCESS, SECRET,
                                   'us-east-1', self.headers['x-amz-date'])
        assert auth == expected, 'bad signature'
        assert {'host', 'x-amz-content-sha256', 'x-amz-date'} <= set(signed)
        if self.command == 'PUT':
            assert hashlib.sha256(body).hexdigest() == self.headers['x-amz-content-sha256']
            assert base64.b64encode(hashlib.md5(body).digest()).decode() == self.headers['content-md5']
            assert 'content-md5' in signed
        return split, query

    def _answer(self, status, body=b''):
        self.send_response(status)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        split, _ = self._verify(body)
        if self.server.refuse:
            return self._answer(403)
        if self.server.fail:
            self.server.fail -= 1
            return self._answer(500)
        key = split.path.split('/', 2)[2]
        self.server.objects[key] = body
        self.server.order.append(key)
        self._answer(200)

    def do_GET(self):
        split, query = self._verify(b'')
        parts = split.path.split('/', 2)
        if len(parts) == 2 or parts[2] == '':
            assert query['list-type'] == '2'
            keys = sorted(key for key in self.server.objects if key.startswith(query.get('prefix', '')))
            items = ''.join('<Contents><Key>%s</Key><Size>%d</Size></Contents>' % (key, len(self.server.objects[key]))
                            for key in keys)
            xml = ('<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                   + items + '<IsTruncated>false</IsTruncated></ListBucketResult>')
            return self._answer(200, xml.encode())
        body = self.server.objects.get(parts[2])
        self._answer(200, body) if body is not None else self._answer(404)


def env_text(endpoint, **extra):
    values = {'BACKUP_OFFSITE_ENABLED': 'true', 'BACKUP_S3_ENDPOINT': endpoint, 'BACKUP_S3_BUCKET': 'pc-backups',
              'BACKUP_S3_ACCESS_KEY_ID': ACCESS, 'BACKUP_S3_SECRET_ACCESS_KEY': SECRET, **extra}
    return ''.join(key + '=' + value + '\n' for key, value in values.items())


class Signing(unittest.TestCase):
    """Known answers from the AWS SigV4 S3 documentation examples."""
    KEY, SECRET = 'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'

    def test_get_object_example(self):
        auth = offsite.sign_v4('GET', 'examplebucket.s3.amazonaws.com', '/test.txt', {},
                               {'range': 'bytes=0-9', 'x-amz-content-sha256': offsite.EMPTY_SHA256,
                                'x-amz-date': '20130524T000000Z'}, offsite.EMPTY_SHA256, self.KEY, self.SECRET,
                               'us-east-1', '20130524T000000Z')
        self.assertEqual(auth, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
                               'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
                               'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')

    def test_list_objects_example(self):
        auth = offsite.sign_v4('GET', 'examplebucket.s3.amazonaws.com', '/', {'max-keys': '2', 'prefix': 'J'},
                               {'x-amz-content-sha256': offsite.EMPTY_SHA256, 'x-amz-date': '20130524T000000Z'},
                               offsite.EMPTY_SHA256, self.KEY, self.SECRET, 'us-east-1', '20130524T000000Z')
        self.assertTrue(auth.endswith('Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7'))


class Settings(unittest.TestCase):
    def test_defaults_are_off_and_https_is_required(self):
        self.assertEqual(offsite.parse_settings(None)['enabled'], False)
        self.assertEqual(offsite.parse_settings('')['pitr'], False)
        on = offsite.parse_settings(env_text('https://s3.example.kz'))
        self.assertEqual((on['scheme'], on['host'], on['bucket'], on['prefix']),
                         ('https', 's3.example.kz', 'pc-backups', 'pickchick-staging'))
        for name, value in [('BACKUP_S3_ENDPOINT', 'http://s3.example.kz'),
                            ('BACKUP_S3_ENDPOINT', 'https://user:pw@s3.example.kz'),
                            ('BACKUP_S3_ENDPOINT', 'https://s3.example.kz/bucket'),
                            ('BACKUP_S3_BUCKET', 'Bad_Bucket'),
                            ('BACKUP_S3_SECRET_ACCESS_KEY', 'short'),
                            ('BACKUP_S3_ADDRESSING', 'dns'),
                            ('BACKUP_OFFSITE_ENABLED', 'yes')]:
            with self.subTest(name=name, value=value):
                with self.assertRaises(offsite.OffsiteError) as caught:
                    offsite.parse_settings(env_text('https://s3.example.kz', **{name: value}))
                self.assertEqual(str(caught.exception), name)
        with self.assertRaises(offsite.OffsiteError):
            offsite.parse_settings('BACKUP_PITR_ENABLED=true\n')

    def test_env_file_must_be_private(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name, 'backup-offsite.env')
            self.assertIsNone(offsite.private_text(path))
            path.write_text(env_text('https://s3.example.kz'))
            path.chmod(0o644)
            with self.assertRaises(offsite.OffsiteError) as caught:
                offsite.private_text(path)
            self.assertNotIn(SECRET, str(caught.exception))
            path.chmod(0o600)
            self.assertIn('BACKUP_S3_BUCKET', offsite.private_text(path))

    def test_example_files_are_placeholders(self):
        example = (STAGING / 'backup-offsite.env.example').read_text()
        settings = offsite.parse_settings(example)
        self.assertEqual((settings['enabled'], settings['pitr']), (False, False))
        self.assertRegex(example, r'BACKUP_S3_SECRET_ACCESS_KEY=\n')
        self.assertRegex(example, r'BACKUP_S3_ACCESS_KEY_ID=\n')

    def test_pitr_sql_is_restart_safe_and_shell_plain(self):
        enable = offsite.pitr_sql('enable')
        self.assertIn("ALTER SYSTEM SET archive_mode = 'on';", enable)
        self.assertIn("archive_timeout = '60s'", enable)
        self.assertIn('cmp -s %p /var/lib/postgresql/wal-archive/%f', enable)
        self.assertIn('mv /var/lib/postgresql/wal-archive/.%f.tmp /var/lib/postgresql/wal-archive/%f', enable)
        self.assertNotIn('$', enable)
        disable = offsite.pitr_sql('disable').splitlines()
        self.assertEqual(disable[0], "ALTER SYSTEM SET archive_command = '/bin/true';")
        with self.assertRaises(offsite.OffsiteError):
            offsite.pitr_sql('enable', archive='/tmp/x; rm -rf /')


class Client(unittest.TestCase):
    def setUp(self):
        self.server = FakeS3()
        self.addCleanup(self.server.close)
        self.settings = offsite.parse_settings(env_text(self.server.endpoint))
        self.s3 = offsite.S3(self.settings, timeout=5, sleep=lambda seconds: None)

    def test_put_get_list_with_retries_and_refusal(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name, 'object.bin')
            path.write_bytes(os.urandom(70_000))
            self.server.fail = 2
            self.assertEqual(self.s3.put_file(self.s3.key('dumps', 'a.bin'), path), 70_000)
            self.assertEqual(self.server.objects['pickchick-staging/dumps/a.bin'], path.read_bytes())
            self.assertEqual(self.s3.list('pickchick-staging/dumps/'),
                             [{'key': 'pickchick-staging/dumps/a.bin', 'size': 70_000}])
            copy = Path(name, 'copy.bin')
            self.s3.get_file('pickchick-staging/dumps/a.bin', copy)
            self.assertEqual(copy.read_bytes(), path.read_bytes())
            self.server.fail = 3
            with self.assertRaises(offsite.OffsiteError):
                self.s3.put_file(self.s3.key('dumps', 'b.bin'), path)
            self.server.fail, self.server.refuse = 0, True
            with self.assertRaises(offsite.OffsiteError) as caught:
                self.s3.put_file(self.s3.key('dumps', 'c.bin'), path)
            self.assertIn('HTTP 403', str(caught.exception))
            self.assertNotIn(SECRET, str(caught.exception))
            with self.assertRaises(offsite.OffsiteError):
                self.s3.key('..', 'escape')


FAKE_DOCKER = r'''#!/usr/bin/env python3
"""Fake docker for backup tests: psql counts, pg_dump bytes, and exec find/cat/rm on a dir."""
import json, os, sys, pathlib
args = sys.argv[1:]
fail = os.environ.get('FAKE_DOCKER_FAIL', '')
root = pathlib.Path(os.environ.get('FAKE_CONTAINER_ROOT', '/nonexistent'))
log = pathlib.Path(os.environ['FAKE_DOCKER_LOG'])
with log.open('a') as out:
    out.write(json.dumps(args) + '\n')
if 'psql' in args:
    counter = pathlib.Path(str(log) + '.counts')
    calls = int(counter.read_text()) if counter.exists() else 0
    counter.write_text(str(calls + 1))
    tables = {'commerce_orders': 10 + calls, 'branches': 1}
    print(json.dumps({'capturedAt': '2026-10-20T02:15:0%dZ' % calls, 'migration': '070_cloud_x.sql',
                      'tables': tables}))
    sys.exit(0)
if 'pg_dump' in args:
    if fail == 'pg_dump':
        sys.exit(1)
    sys.stdout.buffer.write(b'PGDMP synthetic dump bytes ' * 100)
    sys.exit(0)
if args[:1] == ['exec'] and args[2] in ('find', 'cat', 'rm'):
    target = root / args[3 if args[2] != 'rm' else 4].lstrip('/')
    if args[2] == 'find':
        for path in sorted(target.iterdir()):
            if path.is_file():
                print('/' + str(path.relative_to(root)))
    elif args[2] == 'cat':
        sys.stdout.buffer.write(target.read_bytes())
    else:
        target.unlink(missing_ok=True)
    sys.exit(0)
if args[:1] == ['exec'] and args[2] == 'pg_basebackup':
    sys.stdout.buffer.write(b'synthetic base tar ' * 1000)
    sys.exit(0)
sys.exit(2)
'''


@unittest.skipUnless(HAS_AGE, 'age is required')
class BackupScript(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix='pickchick-backup-test-'))
        self.addCleanup(shutil.rmtree, self.directory)
        self.root = self.directory / 'staging'
        for sub in ('secrets', 'backups', 'current/infra/staging', 'bin', 'container/var/lib/postgresql/wal-archive'):
            (self.root / sub if sub != 'bin' and not sub.startswith('container') else self.directory / sub).mkdir(
                parents=True, exist_ok=True)
        self.identity = self.directory / 'identity.agekey'
        subprocess.run(['age-keygen', '-o', str(self.identity)], check=True, capture_output=True)
        public = subprocess.run(['age-keygen', '-y', str(self.identity)], check=True, capture_output=True,
                                text=True).stdout.strip()
        (self.root / 'secrets/backup-recipient.txt').write_text(public + '\n')
        (self.root / 'secrets/staging.env').write_text('')
        (self.root / 'current/release.env').write_text('RELEASE_SHA=' + 'a' * 40 + '\n')
        fake = self.directory / 'bin/docker'
        fake.write_text(FAKE_DOCKER)
        fake.chmod(0o755)
        self.server = FakeS3()
        self.addCleanup(self.server.close)
        self.log = self.directory / 'docker.log'

    def configure(self, **extra):
        path = self.root / 'secrets/backup-offsite.env'
        path.write_text(env_text(self.server.endpoint, **extra))
        path.chmod(0o600)

    def run_backup(self, **env):
        return subprocess.run(['bash', str(STAGING / 'backup.sh')], capture_output=True, text=True, timeout=120,
                              env={'PATH': str(self.directory / 'bin') + ':' + os.environ['PATH'],
                                   'PICKCHICK_STAGING_ROOT': str(self.root), 'FAKE_DOCKER_LOG': str(self.log),
                                   'FAKE_CONTAINER_ROOT': str(self.directory / 'container'), **env})

    def status(self, name):
        return json.loads((self.root / 'backups' / name).read_text())

    def decrypt(self, path):
        return subprocess.run(['age', '-d', '-i', str(self.identity), str(path)], check=True,
                              capture_output=True).stdout

    def test_local_copy_manifest_and_offsite_upload(self):
        self.configure()
        result = self.run_backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        dumps = sorted((self.root / 'backups').glob('cloud-*.dump.age'))
        self.assertEqual(len(dumps), 1)
        dump = dumps[0]
        self.assertTrue(self.decrypt(dump).startswith(b'PGDMP synthetic'))
        manifest = json.loads(self.decrypt(Path(str(dump).replace('.dump.age', '.manifest.json.age'))))
        self.assertEqual(manifest['dump'], dump.name)
        self.assertEqual((manifest['before']['tables']['commerce_orders'],
                          manifest['after']['tables']['commerce_orders']), (10, 11))
        sha = (Path(str(dump) + '.sha256')).read_text().split()[0]
        self.assertEqual(sha, hashlib.sha256(dump.read_bytes()).hexdigest())
        prefix = 'pickchick-staging/dumps/'
        self.assertEqual(self.server.order, [prefix + dump.name,
                                             prefix + dump.name.replace('.dump.age', '.manifest.json.age'),
                                             prefix + dump.name + '.sha256'])
        self.assertEqual(self.server.objects[prefix + dump.name], dump.read_bytes())
        status = self.status('backup-status.json')
        self.assertEqual((status['ok'], status['lastSuccessAt']), (True, status['lastAttemptAt']))
        remote = self.status('offsite-status.json')
        self.assertEqual((remote['enabled'], remote['ok'], remote['sizeBytes']), (True, True, dump.stat().st_size))
        self.assertEqual(os.stat(self.root / 'backups/offsite-status.json').st_mode & 0o777, 0o600)
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        # No PITR: base-backup is a no-op and never touches docker.
        self.assertNotIn('pg_basebackup', self.log.read_text())

    def test_storage_failure_keeps_local_copy_and_records_the_stage(self):
        self.configure()
        self.assertEqual(self.run_backup().returncode, 0)
        first = self.status('offsite-status.json')['lastSuccessAt']
        self.server.refuse = True
        os.utime(self.root / 'backups/backup-status.json')
        import time as clock
        clock.sleep(1.1)  # a new stamp for the second dump
        result = self.run_backup()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('FAILED at stage offsite', result.stderr)
        self.assertIn('HTTP 403', result.stderr)
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        status = self.status('backup-status.json')
        self.assertEqual((status['ok'], status['stage']), (False, 'offsite'))
        self.assertIsNotNone(status['lastSuccessAt'])
        remote = self.status('offsite-status.json')
        self.assertEqual((remote['ok'], remote['lastSuccessAt']), (False, first))
        self.assertEqual(len(list((self.root / 'backups').glob('cloud-*.dump.age'))), 2)

    def test_dump_failure_leaves_no_partial_file(self):
        result = self.run_backup(FAKE_DOCKER_FAIL='pg_dump')
        self.assertNotEqual(result.returncode, 0)
        status = self.status('backup-status.json')
        self.assertEqual((status['ok'], status['stage'], status['lastSuccessAt']), (False, 'dump', None))
        self.assertEqual([path.name for path in (self.root / 'backups').iterdir()
                          if path.name.startswith('cloud-')], [])

    def test_without_offsite_configuration_only_local_copies_are_made(self):
        result = self.run_backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.status('offsite-status.json')['enabled'], False)
        self.assertEqual(self.server.order, [])
        self.assertTrue(self.status('backup-status.json')['ok'])

    def run_offsite(self, *args):
        return subprocess.run(['python3', str(STAGING / 'backup-offsite.py'), *args], capture_output=True, text=True,
                              timeout=60, env={'PATH': str(self.directory / 'bin') + ':' + os.environ['PATH'],
                                               'PICKCHICK_STAGING_ROOT': str(self.root),
                                               'FAKE_DOCKER_LOG': str(self.log),
                                               'FAKE_CONTAINER_ROOT': str(self.directory / 'container')})

    def test_wal_shipping_encrypts_uploads_and_only_then_removes(self):
        archive = self.directory / 'container/var/lib/postgresql/wal-archive'
        segments = {'000000010000000000000001': os.urandom(4096) + b'\0' * 60_000,
                    '000000010000000000000002': b'\0' * 65_536,
                    '00000002.history': b'1\t0/3000000\tno recovery target specified\n'}
        for name, data in segments.items():
            (archive / name).write_bytes(data)
        (archive / '.000000010000000000000003.tmp').write_bytes(b'partial copy')
        self.configure(BACKUP_PITR_ENABLED='true')
        self.server.refuse = True
        failed = self.run_offsite('ship-wal')
        self.assertNotEqual(failed.returncode, 0)
        wal = self.status('wal-status.json')
        self.assertEqual((wal['ok'], wal['pending']), (False, 3))
        self.assertIn('oldestPendingAt', wal)
        self.assertEqual(len(list(archive.iterdir())), 4)
        self.server.refuse = False
        shipped = self.run_offsite('ship-wal')
        self.assertEqual(shipped.returncode, 0, shipped.stderr)
        wal = self.status('wal-status.json')
        self.assertEqual((wal['ok'], wal['pending'], wal['lastSegment']), (True, 0, '00000002.history'))
        self.assertNotIn('oldestPendingAt', wal)
        self.assertEqual([path.name for path in archive.iterdir()], ['.000000010000000000000003.tmp'])
        for name, data in segments.items():
            stored = self.server.objects['pickchick-staging/wal/' + name + '.gz.age']
            self.assertNotIn(b'no recovery target', stored)
            encrypted = self.directory / 'stored.age'
            encrypted.write_bytes(stored)
            self.assertEqual(gzip.decompress(self.decrypt(encrypted)), data)
        self.assertLess(len(self.server.objects['pickchick-staging/wal/000000010000000000000002.gz.age']), 2000)
        base = self.run_offsite('base-backup')
        self.assertEqual(base.returncode, 0, base.stderr)
        self.assertIn('lastBaseBackupAt', self.status('wal-status.json'))
        [key] = [key for key in self.server.objects if key.startswith('pickchick-staging/base/base-')]
        encrypted.write_bytes(self.server.objects[key])
        self.assertTrue(gzip.decompress(self.decrypt(encrypted)).startswith(b'synthetic base tar'))
        self.assertIn('"-X", "fetch"', self.log.read_text())

    def test_pitr_commands_are_noops_until_enabled(self):
        self.configure()
        for command in ('ship-wal', 'base-backup'):
            self.assertEqual(self.run_offsite(command).returncode, 0)
        self.assertFalse((self.root / 'backups/wal-status.json').exists())
        self.assertFalse(self.log.exists())


class DrillComparison(unittest.TestCase):
    def test_counts_sql_matches_backup_script(self):
        script = (STAGING / 'backup.sh').read_text()
        quoted = re.search(r'counts_sql="(.*?)"\ncounts\(\)', script, re.S).group(1).replace('\\"', '"')
        self.assertEqual(' '.join(quoted.split()), ' '.join(drill.COUNTS_SQL.split()))

    def test_restored_counts_must_lie_between_before_and_after(self):
        manifest = {'before': {'migration': '070.sql', 'tables': {'orders': 10, 'sessions': 5, 'gone': 1}},
                    'after': {'migration': '070.sql', 'tables': {'orders': 12, 'sessions': 4, 'gone': 1}}}
        good = {'migration': '070.sql', 'tables': {'orders': 11, 'sessions': 4, 'gone': 1}}
        self.assertEqual(drill.compare(good, manifest), [])
        bad = {'migration': '069.sql', 'tables': {'orders': 9, 'sessions': 5, 'extra': 0}}
        self.assertEqual([problem['check'] for problem in drill.compare(bad, manifest)],
                         ['migration', 'missing_table', 'unexpected_table', 'row_count'])

    def test_checksum_and_identity_are_enforced(self):
        with tempfile.TemporaryDirectory() as name:
            dump = Path(name, 'cloud-20261020T021500Z.dump.age')
            dump.write_bytes(b'encrypted')
            self.assertFalse(drill.verify_checksum(dump))
            Path(str(dump) + '.sha256').write_text(hashlib.sha256(b'encrypted').hexdigest() + '  ' + str(dump))
            self.assertTrue(drill.verify_checksum(dump))
            dump.write_bytes(b'damaged')
            with self.assertRaises(drill.DrillError):
                drill.verify_checksum(dump)
        with self.assertRaises(drill.DrillError):
            drill.Identity('not a key')


if __name__ == '__main__':
    unittest.main()
