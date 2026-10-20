"""Restore drills and PITR against real throwaway PostgreSQL containers (local Docker only).

Uses the pinned cloud-db image of infra/staging/compose.yaml, `--network none` containers with
synthetic rows, the loopback S3 double and a throwaway age key. Skipped without Docker/age or
without the image locally (never pulls). Run:
  python3 -m unittest tests/operations/test_restore_drill_docker.py
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_backup_offsite import FakeS3, STAGING, drill, env_text, offsite  # noqa: E402

IMAGE = drill.IMAGE


def available():
    if not shutil.which('docker') or not shutil.which('age-keygen'):
        return False
    return subprocess.run(['docker', 'image', 'inspect', IMAGE], capture_output=True).returncode == 0


def sh(*args, **kwargs):
    return subprocess.run(list(args), check=True, capture_output=True, timeout=300, **kwargs)


@unittest.skipUnless(available(), 'Docker with the pinned postgres image and age are required')
class RestoreDrill(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix='pickchick-drill-test-'))
        self.addCleanup(shutil.rmtree, self.directory, True)
        self.identity = self.directory / 'identity.agekey'
        sh('age-keygen', '-o', str(self.identity))
        self.recipient = sh('age-keygen', '-y', str(self.identity), text=True).stdout.strip()
        self.source = 'pickchick-drill-source-' + secrets.token_hex(4)
        sh('docker', 'run', '-d', '--name', self.source, '--network', 'none', '--memory', '512m',
           '-e', 'POSTGRES_PASSWORD=' + secrets.token_hex(8), '-e', 'POSTGRES_DB=pickchick_cloud', IMAGE)
        self.addCleanup(subprocess.run, ['docker', 'rm', '-f', '-v', self.source], capture_output=True)
        drill.wait_ready(self.source)

    def sql(self, statement):
        return sh('docker', 'exec', self.source, 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
                  '-U', 'postgres', '-d', 'pickchick_cloud', '-c', statement, text=True).stdout.strip()

    def seed(self):
        self.sql("""CREATE TABLE schema_migrations(version text PRIMARY KEY, checksum text, scope text,
                      applied_at timestamptz DEFAULT now());
                    INSERT INTO schema_migrations(version, checksum, scope) VALUES
                      ('069_cloud_a.sql', 'x', 'cloud'), ('070_cloud_b.sql', 'y', 'cloud'),
                      ('099_edge_c.sql', 'z', 'edge');
                    CREATE TABLE drill_orders(id serial PRIMARY KEY, total_minor bigint NOT NULL);
                    CREATE TABLE drill_empty(id int);
                    INSERT INTO drill_orders(total_minor) SELECT 1000 * g FROM generate_series(1, 25) g;""")

    def encrypt(self, data, path):
        sh('age', '-r', self.recipient, '-o', str(path), input=data)

    def drill(self, *args):
        with open(self.identity) as key:
            return subprocess.run(['python3', str(STAGING / 'restore-drill.py'), *args, '--identity', '-',
                                   '--image', IMAGE], stdin=key, capture_output=True, text=True, timeout=600)

    def test_dump_drill_restores_in_isolation_and_checks_counts(self):
        self.seed()
        before = self.sql(drill.COUNTS_SQL)
        dump = sh('docker', 'exec', self.source, 'pg_dump', '-U', 'postgres', '-d', 'pickchick_cloud',
                  '--format=custom', '--no-owner', '--no-acl').stdout
        after = self.sql(drill.COUNTS_SQL)
        path = self.directory / 'cloud-20261020T021500Z.dump.age'
        self.encrypt(dump, path)
        Path(str(path) + '.sha256').write_text(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + str(path) + '\n')
        manifest = self.directory / 'cloud-20261020T021500Z.manifest.json.age'
        self.encrypt(json.dumps({'version': 1, 'dump': path.name, 'before': json.loads(before),
                                 'after': json.loads(after)}).encode(), manifest)
        result = self.drill('dump', '--dump', str(path), '--require-manifest')
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((report['ok'], report['checksum'], report['migration'], report['tables'], report['problems']),
                         (True, 'verified', '070_cloud_b.sql', 3, []))
        self.assertEqual(report['rows'], 25 + 3)
        # No drill container survives, and the source was never touched.
        self.assertEqual(sh('docker', 'ps', '-aq', '--filter', 'label=pickchick.restore-drill=1').stdout, b'')
        self.assertEqual(self.sql('SELECT count(*) FROM drill_orders'), '25')
        # A manifest that expects more rows than the dump holds fails the drill.
        data = json.loads(after)
        data['tables']['drill_orders'] = 30
        self.encrypt(json.dumps({'version': 1, 'dump': path.name, 'before': data, 'after': data}).encode(), manifest)
        failed = self.drill('dump', '--dump', str(path))
        self.assertEqual(failed.returncode, 1)
        self.assertEqual([problem['table'] for problem in json.loads(failed.stdout)['problems']], ['drill_orders'])
        # A damaged file is refused before anything is restored.
        path.write_bytes(path.read_bytes()[:-1] + b'x')
        damaged = self.drill('dump', '--dump', str(path))
        self.assertEqual((damaged.returncode, json.loads(damaged.stdout)['error']),
                         (1, 'sha256 mismatch: the encrypted dump is damaged'))

    def test_pitr_archive_ship_base_backup_and_point_in_time_restore(self):
        server = FakeS3()
        self.addCleanup(server.close)
        root = self.directory / 'staging'
        (root / 'secrets').mkdir(parents=True)
        (root / 'backups').mkdir()
        (root / 'secrets/backup-recipient.txt').write_text(self.recipient + '\n')
        env_file = root / 'secrets/backup-offsite.env'
        env_file.write_text(env_text(server.endpoint, BACKUP_PITR_ENABLED='true', BACKUP_DB_CONTAINER=self.source))
        env_file.chmod(0o600)
        environment = {**os.environ, 'PICKCHICK_STAGING_ROOT': str(root)}

        def offsite_command(*args):
            result = subprocess.run(['python3', str(STAGING / 'backup-offsite.py'), *args], capture_output=True,
                                    text=True, timeout=600, env=environment)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result

        # The documented enable path: ALTER SYSTEM via psql, then one restart of cloud-db.
        sh('docker', 'exec', '-i', self.source, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres',
           '-d', 'pickchick_cloud', input=offsite.pitr_sql('enable').encode())
        sh('docker', 'restart', self.source)
        drill.wait_ready(self.source)
        self.assertEqual(self.sql('SHOW archive_mode'), 'on')
        self.seed()
        offsite_command('base-backup')
        self.sql('INSERT INTO drill_orders(total_minor) VALUES (1), (2), (3)')
        time.sleep(1.5)
        target = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        time.sleep(1.5)
        self.sql('INSERT INTO drill_orders(total_minor) VALUES (4), (5)')
        self.sql('SELECT pg_switch_wal()')
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            listed = sh('docker', 'exec', self.source, 'ls', '/var/lib/postgresql/wal-archive', text=True).stdout
            if self.sql("SELECT last_archived_wal FROM pg_stat_archiver") in listed.split():
                break
            time.sleep(0.5)
        offsite_command('ship-wal')
        status = json.loads((root / 'backups/wal-status.json').read_text())
        self.assertEqual((status['ok'], status['pending']), (True, 0))
        self.assertIn('lastBaseBackupAt', status)
        self.assertEqual(self.sql("SELECT failed_count FROM pg_stat_archiver"), '0')
        self.assertEqual(sh('docker', 'exec', self.source, 'ls', '/var/lib/postgresql/wal-archive').stdout, b'')
        # Restore only from what reached the off-site storage.
        wal_dir = self.directory / 'wal'
        wal_dir.mkdir()
        base = None
        for key, data in server.objects.items():
            if key.startswith('pickchick-staging/wal/'):
                (wal_dir / key.rsplit('/', 1)[1]).write_bytes(data)
            elif key.startswith('pickchick-staging/base/'):
                base = self.directory / key.rsplit('/', 1)[1]
                base.write_bytes(data)
        self.assertIsNotNone(base)
        result = self.drill('pitr', '--base', str(base), '--wal-dir', str(wal_dir), '--target-time', target,
                            '--show-counts', '--timeout', '180')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(report['ok'])
        # Rows committed before the target are back; the two committed after it are not.
        self.assertEqual(report['tables']['drill_orders'], 25 + 3)
        self.assertEqual(report['migration'], '070_cloud_b.sql')
        self.assertLessEqual(report['lastReplayedCommit'], target)
        self.assertEqual(self.sql('SELECT count(*) FROM drill_orders'), '30')
        self.assertEqual(sh('docker', 'volume', 'ls', '-q', '--filter', 'label=pickchick.restore-drill=1').stdout,
                         b'')


if __name__ == '__main__':
    unittest.main()
