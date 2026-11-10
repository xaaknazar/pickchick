import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('storage_audit',
    Path(__file__).resolve().parents[2] / 'infra/operations/server-storage-audit.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class StorageAudit(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'redis.conf'
        self.path.write_text('PRIVATE_SENTINEL_DO_NOT_READ')
        self.path.chmod(0o644)

    def test_0644_inside_0700_does_not_claim_public_host_access(self):
        with patch('builtins.open', side_effect=AssertionError('contents read')), \
             patch.object(Path, 'read_bytes', side_effect=AssertionError('contents read')), \
             patch.object(Path, 'read_text', side_effect=AssertionError('contents read')):
            report = m.redis_metadata(self.path)
        self.assertEqual(report['status'], 'review')
        self.assertTrue(report['otherReadBit'])
        self.assertFalse(report['otherDacReadPath'])
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(report))
        self.assertFalse(report['runtimeReadabilityVerified'])

    def test_unprotected_and_owner_only_modes(self):
        self.root.chmod(0o755)
        # Construct a metadata-only root under /tmp; check every real ancestor.
        report = m.redis_metadata(self.path)
        expected = all(parent.stat().st_mode & 0o001 for parent in self.path.parents)
        self.assertEqual(report['otherDacReadPath'], bool(expected))
        self.path.chmod(0o600)
        report = m.redis_metadata(self.path)
        self.assertEqual(report['status'], 'restricted_mode')
        self.assertFalse(report['otherReadBit'])

    def test_file_and_parent_links_are_not_followed(self):
        link = self.root / 'link'
        link.symlink_to(self.path)
        self.assertEqual(m.redis_metadata(link)['reason'], 'symlink_requires_manual_review')
        directory_link = self.root / 'directory-link'
        directory_link.symlink_to(self.root, target_is_directory=True)
        self.assertEqual(m.redis_metadata(directory_link / 'redis.conf')['reason'],
                         'symlink_requires_manual_review')

    def test_acl_and_missing_permissions_fail_closed(self):
        with patch.object(os, 'listxattr', return_value=['system.posix_acl_access']):
            self.assertEqual(m.redis_metadata(self.path)['reason'], 'acl_requires_manual_review')
        with patch.object(os, 'listxattr', side_effect=PermissionError('PRIVATE_SENTINEL')):
            report = m.redis_metadata(self.path)
            self.assertEqual(report['status'], 'unknown')
            self.assertNotIn('PRIVATE_SENTINEL', json.dumps(report))

    def test_missing_nonregular_and_relative_paths(self):
        self.assertEqual(m.redis_metadata(self.root / 'missing')['status'], 'unknown')
        self.assertEqual(m.redis_metadata(self.root)['reason'], 'not_regular_file')
        self.assertEqual(m.redis_metadata(Path('redis.conf'))['reason'], 'absolute_normalized_path_required')
        self.assertEqual(m.redis_metadata(self.root / '..' / 'redis.conf')['status'], 'unknown')

    def test_json_file_rotation_requires_a_positive_size(self):
        for options in ({}, {'max-file': '3'}, {'max-size': '-1', 'max-file': '3'}):
            self.assertEqual(m.log_policy({'Type': 'json-file', 'Config': options})['status'], 'unbounded')
        report = m.log_policy({'Type': 'json-file', 'Config': {'max-size': '10m', 'max-file': '3'}})
        self.assertEqual(report['nominalCapacityBytes'], 30 * 1024 * 1024)
        self.assertFalse(report['usesDriverDefaults'])
        self.assertEqual(m.log_policy({'Type': 'json-file', 'Config': {'max-size': '10m'}})['maxFiles'], 1)

    def test_local_defaults_and_external_logging_are_distinct(self):
        report = m.log_policy({'Type': 'local', 'Config': {}})
        self.assertEqual(report['status'], 'bounded')
        self.assertEqual(report['nominalCapacityBytes'], 100 * 1024 * 1024)
        self.assertTrue(report['usesDriverDefaults'])
        for driver in ('journald', 'none', 'splunk', 'PRIVATE_SENTINEL'):
            report = m.log_policy({'Type': driver, 'Config': {'token': 'PRIVATE_SENTINEL'}})
            self.assertEqual(report['status'], 'unknown')
            self.assertNotIn('PRIVATE_SENTINEL', json.dumps(report))

    def test_invalid_or_sensitive_log_options_are_not_echoed(self):
        for options in ({'max-size': 'PRIVATE_SENTINEL'}, {'max-size': '0'},
                        {'max-size': '1m', 'max-file': '0'}, {'max-size': 100},
                        {'max-size': '1m', 'max-file': 'PRIVATE_SENTINEL'}):
            report = m.log_policy({'Type': 'json-file', 'Config': options})
            self.assertEqual(report['status'], 'unknown')
            self.assertNotIn('PRIVATE_SENTINEL', json.dumps(report))

    def test_docker_uses_local_socket_and_metadata_projection_only(self):
        remote = {key: 'PRIVATE_SENTINEL' for key in
                  ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')}
        with patch.dict(os.environ, remote), patch.object(subprocess, 'run') as run:
            run.return_value = subprocess.CompletedProcess([], 0, '{"running":true}', '')
            self.assertEqual(m.inspect_container('staff-login'), {'running': True})
        args, kwargs = run.call_args
        self.assertEqual(args[0][:3], ['docker', '--host=unix:///var/run/docker.sock', 'container'])
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(kwargs['env']))
        self.assertNotIn('.Config.Env', args[0][-2])
        self.assertNotIn('{{json .}}', args[0][-2])
        self.assertEqual(kwargs['timeout'], 15)

    def test_docker_errors_and_bad_names_never_leak(self):
        for error in (subprocess.CalledProcessError(1, [], stderr='PRIVATE_SENTINEL'),
                      subprocess.TimeoutExpired([], 15, output='PRIVATE_SENTINEL'),
                      FileNotFoundError('PRIVATE_SENTINEL')):
            with patch.object(subprocess, 'run', side_effect=error), contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertIsNone(m.inspect_container('staff-login'))
                self.assertEqual(out.getvalue(), '')
        with patch.object(subprocess, 'run') as run:
            self.assertIsNone(m.inspect_container('--help'))
            with self.assertRaises(ValueError):
                m.audit(self.path, 'redis', ['staff\nPRIVATE_SENTINEL'])
            run.assert_not_called()

    def test_mount_requires_exact_readonly_bind(self):
        data = {'running': True, 'mounts': [{'Type': 'bind', 'Source': str(self.path),
                'Destination': '/usr/local/etc/redis/redis.conf', 'RW': False}]}
        self.assertEqual(m.redis_mount(data, self.path)['status'], 'read_only')
        data['mounts'][0]['RW'] = True
        self.assertEqual(m.redis_mount(data, self.path)['status'], 'review')
        data['mounts'][0]['Source'] = str(self.root)
        self.assertEqual(m.redis_mount(data, self.path)['status'], 'unknown')

    def test_aggregate_reports_missing_container_without_secret_fields(self):
        self.path.chmod(0o600)
        data = {'running': True, 'mounts': [{'Type': 'bind', 'Source': str(self.path),
                'Destination': '/usr/local/etc/redis/redis.conf', 'RW': False}],
                'logs': {'Type': 'json-file', 'Config': {'max-size': '10m', 'max-file': '3',
                                                       'private': 'PRIVATE_SENTINEL'}}}
        with patch.object(m, 'inspect_container', return_value=data):
            report = m.audit(self.path, 'redis', ['staff', 'staff'])
        self.assertFalse(report['needsAttention'])
        self.assertEqual(len(report['containerLogs']), 2)
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(report))
        self.assertNotIn(str(self.path), json.dumps(report))
        with patch.object(m, 'inspect_container', side_effect=[data, None]):
            report = m.audit(self.path, 'redis', ['staff'])
        self.assertTrue(report['needsAttention'])
        self.assertEqual(report['containerLogs'][1]['status'], 'unknown')

    def test_cli_exit_codes_and_sanitized_invalid_input(self):
        argv = ['audit', '--redis-conf', str(self.path), '--redis-container', 'redis',
                '--container', 'staff']
        for attention, expected in ((False, 0), (True, 2)):
            with patch.object(sys, 'argv', argv), patch.object(m, 'audit', return_value={
                    'needsAttention': attention}), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(m.main(), expected)
                self.assertEqual(json.loads(output.getvalue())['needsAttention'], attention)
        with patch.object(sys, 'argv', [*argv[:-1], 'bad/name']), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(m.main(), 1)
            self.assertEqual(json.loads(output.getvalue())['error'], 'invalid_container_name')


if __name__ == '__main__':
    unittest.main()
