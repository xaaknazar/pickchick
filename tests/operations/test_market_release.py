"""Offline release safety tests; no SSH, Docker, database or provider calls."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[2] / 'infra/staging/release-market.py'
spec = importlib.util.spec_from_file_location('market_release', MODULE)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
SHA = 'a' * 40


def proof():
    return {'run': {'head_sha': SHA, 'status': 'completed', 'conclusion': 'success',
                    'path': '.github/workflows/ci.yml',
                    'head_repository': {'full_name': 'xaaknazar/pickchick'}},
            'jobs': {'total_count': len(release.CI_JOBS), 'jobs': [
                {'name': name, 'head_sha': SHA, 'status': 'completed', 'conclusion': 'success'}
                for name in sorted(release.CI_JOBS)]}}


def database():
    return {'tables': {'test_orders': {'rows': 2, 'sha256': 'one'},
                       'schema_migrations': {'rows': 6, 'sha256': 'two'}},
            'sequences': [{'sequencename': 'test_orders_sequence_seq', 'last_value': 2}]}


class ReleaseGuards(unittest.TestCase):
    def test_unknown_exception_keeps_diagnostics_private_on_supported_python_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            instance = release.Release.__new__(release.Release)
            instance.private, instance.sha = Path(directory), SHA
            instance.args = SimpleNamespace(action='prepare')
            instance.record_error(ValueError('synthetic private detail'))
            logs = list(instance.private.glob('exception-*.log'))
            self.assertEqual(len(logs), 1)
            self.assertIn('synthetic private detail', logs[0].read_text())
            failure = json.loads(next(instance.private.glob('failure-*.json')).read_text())
            self.assertNotIn('synthetic private detail', failure['reason'])
            self.assertTrue(all(path.stat().st_mode & 0o077 == 0 for path in instance.private.iterdir()))

    def test_ci_requires_exact_source_canonical_workflow_and_all_successful_jobs(self):
        release.verify_ci(proof(), SHA)
        mutations = [lambda p: p['run'].update(head_sha='b' * 40),
                     lambda p: p['run'].update(path='unreviewed.yml'),
                     lambda p: p['run'].update(head_repository={'full_name': 'fork/pickchick'}),
                     lambda p: p['jobs']['jobs'].pop(),
                     lambda p: p['jobs']['jobs'][0].update(conclusion='skipped'),
                     lambda p: p['jobs']['jobs'][0].update(head_sha='b' * 40)]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                candidate = proof()
                mutate(candidate)
                with self.assertRaises(release.GuardFailure):
                    release.verify_ci(candidate, SHA)

    def test_restore_detects_row_and_sequence_changes_even_when_counts_match(self):
        before = database()
        release.compare_existing(before, copy.deepcopy(before))
        for mutation in ['hash', 'sequence', 'table', 'extra_sequence']:
            after = copy.deepcopy(before)
            if mutation == 'hash':
                after['tables']['test_orders']['sha256'] = 'changed'
            elif mutation == 'sequence':
                after['sequences'][0]['last_value'] = 3
            elif mutation == 'table':
                del after['tables']['test_orders']
            else:
                after['sequences'].append({'sequencename': 'unexpected', 'last_value': None})
            with self.subTest(mutation=mutation), self.assertRaises(release.GuardFailure):
                release.compare_existing(before, after)

    def test_additive_migrations_allow_only_named_empty_domains_and_unused_sequences(self):
        before = database()
        after = copy.deepcopy(before)
        after['tables']['schema_migrations'] = {'rows': 13, 'sha256': 'new'}
        after['tables']['identity_customers'] = {'rows': 0, 'sha256': 'empty'}
        after['sequences'].append({'sequencename': 'new_sequence', 'last_value': None})
        kwargs = {'additions': True, 'new_tables': ['identity_customers'],
                  'new_sequences': ['new_sequence']}
        release.compare_existing(before, after, **kwargs)
        for mutation in ['seed', 'extra_table', 'advanced_sequence', 'extra_sequence', 'old_row']:
            changed = copy.deepcopy(after)
            if mutation == 'seed':
                changed['tables']['identity_customers']['rows'] = 1
            elif mutation == 'extra_table':
                changed['tables']['surprise'] = {'rows': 0, 'sha256': 'empty'}
            elif mutation == 'advanced_sequence':
                changed['sequences'][1]['last_value'] = 1
            elif mutation == 'extra_sequence':
                changed['sequences'].append({'sequencename': 'surprise', 'last_value': None})
            else:
                changed['tables']['test_orders']['sha256'] = 'changed'
            with self.subTest(mutation=mutation), self.assertRaises(release.GuardFailure):
                release.compare_existing(before, changed, **kwargs)

    def test_acl_restore_quotes_identifiers_and_removes_column_grants_transactionally(self):
        old = [{'name': 'test_orders', 'kind': 'r', 'column': None,
                'privilege': 'SELECT', 'grantable': False}]
        current = old + [{'name': 'catalog_managers', 'kind': 'r', 'column': 'lock_anchor',
                          'privilege': 'UPDATE', 'grantable': False}]
        sql = release.acl_restore_sql(old, current)
        self.assertTrue(sql.startswith('BEGIN;\n'))
        self.assertTrue(sql.endswith('COMMIT;'))
        self.assertIn('REVOKE UPDATE ("lock_anchor") ON public."catalog_managers"', sql)
        self.assertIn('GRANT SELECT ON TABLE public."test_orders"', sql)
        self.assertNotIn('GRANT UPDATE', sql)
        current[1]['privilege'] = 'UPDATE; DROP TABLE test_orders'
        with self.assertRaises(release.GuardFailure):
            release.acl_restore_sql(old, current)
        self.assertEqual(release.identifier('a"b'), '"a""b"')

    def test_baseline_git_paths_are_normalized_to_six_filenames(self):
        instance = release.Release.__new__(release.Release)
        instance.git = lambda *args: '\n'.join(f'db/cloud/migrations/{i:03d}_cloud.sql' for i in range(1, 7))
        self.assertEqual(instance.baseline_migrations(), [f'{i:03d}_cloud.sql' for i in range(1, 7)])

    def test_release_env_program_writes_real_newlines_once_and_protects_file(self):
        with tempfile.TemporaryDirectory() as directory:
            old, new = Path(directory) / 'old.env', Path(directory) / 'new.env'
            old.write_text(f'RELEASE_SHA={release.OLD_API}\nAPI_BIND=127.0.0.1\n'
                           'TEST_ORDER_FLOW_ENABLED=true\nCUSTOMER_AUTH_ENABLED=true\n')
            command = [sys.executable, '-c', release.release_env_script(), str(old), str(new), SHA, release.OLD_API]
            subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            text = new.read_text()
            self.assertNotIn('\\n', text)
            self.assertEqual(text.splitlines(), ['API_BIND=127.0.0.1', 'RELEASE_SHA=' + SHA,
                'TEST_ORDER_FLOW_ENABLED=true', 'CATALOG_ADMIN_ENABLED=true', 'CUSTOMER_AUTH_ENABLED=false'])
            self.assertEqual(new.stat().st_mode & 0o777, 0o600)
            self.assertNotEqual(subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE).returncode, 0)

    def test_remote_transport_failures_are_distinct_and_logs_private(self):
        with tempfile.TemporaryDirectory() as directory:
            instance = release.Release.__new__(release.Release)
            instance.private, instance.ssh = Path(directory), ['ssh', 'unused.test']
            for code in [124, 125, 137, 255]:
                with self.subTest(code=code), patch.object(release.subprocess, 'run', return_value=SimpleNamespace(returncode=code)):
                    with self.assertRaises(release.CommandUncertain):
                        instance.execute('not executed', remote=True)
            with patch.object(release.subprocess, 'run', side_effect=subprocess.TimeoutExpired('synthetic', 1)):
                with self.assertRaises(release.CommandUncertain):
                    instance.execute('not executed', remote=True, timeout=1)
            with patch.object(release.subprocess, 'run', return_value=SimpleNamespace(returncode=1)):
                with self.assertRaises(release.GuardFailure) as caught:
                    instance.execute('not executed', remote=True)
                self.assertNotIsInstance(caught.exception, release.CommandUncertain)
            self.assertTrue(all(path.stat().st_mode & 0o077 == 0 for path in Path(directory).iterdir()))

    def test_owned_lock_released_only_after_success_and_never_after_unknown(self):
        for failure in [None, release.CommandUncertain('Synthetic unknown')]:
            instance = release.Release.__new__(release.Release)
            instance.sha, instance.args = SHA, SimpleNamespace(action='apply')
            calls = []
            instance.save = lambda *args: None
            instance.remote = lambda *args, **kwargs: calls.append((args, kwargs))
            try:
                with instance.deployment_lock():
                    if failure:
                        raise failure
            except release.CommandUncertain:
                pass
            self.assertEqual(len(calls), 1 if failure else 2)

    def test_apply_does_not_roll_back_uncertain_remote_operation(self):
        for error_type in [release.CommandUncertain, release.GuardFailure]:
            with tempfile.TemporaryDirectory() as directory:
                private = Path(directory)
                key = private / 'fake.agekey'
                key.write_text('synthetic fixture only')
                key.chmod(0o600)
                prepared = {'sha': SHA, 'old_api': release.OLD_API, 'old_web': release.OLD_WEB,
                    'ci_proof_sha256': release.digest(proof()), 'public_manifest': {}, 'remote_artifacts': {}}
                (private / 'prepared.json').write_text(json.dumps(prepared))
                (private / 'ci-proof.json').write_text(json.dumps(proof()))
                instance = release.Release.__new__(release.Release)
                instance.private, instance.sha = private, SHA
                instance.args = SimpleNamespace(backup_identity=key, action='apply')
                instance.source_checks = instance.runtime_old = lambda: None
                instance.prepared_artifacts = lambda *args: {}
                instance.snapshot = lambda: {'tables': {}, 'sequences': []}
                instance.ledger = instance.acl = instance.baseline_migrations = instance.catalogs = lambda: []
                instance.fingerprint = instance.health = lambda: {}
                instance.backup_restore = lambda *args: {'restore': 'passed'}
                saved, rollback_calls = {}, []
                instance.save = lambda name, value: saved.update({name: value})
                instance.record_error = lambda *args: None
                instance.rollback = lambda *args: rollback_calls.append(args)
                def fail_remote(*args, **kwargs):
                    raise error_type('Synthetic provision failure')
                instance.remote = fail_remote
                with self.subTest(error_type=error_type.__name__), self.assertRaises(error_type):
                    instance.apply()
                self.assertEqual(len(rollback_calls), 0 if error_type is release.CommandUncertain else 1)
                self.assertEqual('uncertain.json' in saved, error_type is release.CommandUncertain)


if __name__ == '__main__':
    unittest.main()
