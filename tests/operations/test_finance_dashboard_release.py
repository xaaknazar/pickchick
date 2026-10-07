import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('finance_dashboard_release_test', ROOT/'infra/staging/release-finance-dashboard.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)


class FinanceDashboardRelease(unittest.TestCase):
    def test_local_build_uses_pnpm_without_rewriting_other_commands(self):
        obj = object.__new__(r.Release)
        with patch.object(r.finance.Release, 'execute', return_value=b'ok') as execute:
            obj.execute(['corepack', 'pnpm', '--filter', '@pickchick/backoffice...', 'build'], timeout=180)
            execute.assert_called_with(['pnpm', '--filter', '@pickchick/backoffice...', 'build'], timeout=180)
            obj.execute('remote command', remote=True, input=b'private fixture')
            execute.assert_called_with('remote command', remote=True, input=b'private fixture')

    def test_baseline_no_migrations_and_exact_ci(self):
        args = SimpleNamespace(expected_api_sha=r.BASELINE, expected_public_sha=r.BASELINE,
                               expected_gateway_sha256=r.GATEWAY)
        with patch.object(r.sys, 'version_info', (3, 12)), patch.object(r.market.Release, '__init__') as init:
            r.Release(args)
        profile = init.call_args.args[2]
        self.assertEqual(profile.baseline_count, 43)
        self.assertEqual(profile.migrations, ())
        self.assertEqual(profile.settings, ())
        self.assertEqual(len(profile.ci_jobs), 11)
        self.assertTrue(profile.exact_ci_jobs)
        for name in vars(args):
            bad = copy.copy(args); setattr(bad, name, '0'*len(getattr(bad, name)))
            with self.assertRaises(r.market.GuardFailure): r.Release(bad)
        obj = object.__new__(r.Release)
        obj.git = lambda *args: '\n'.join('db/cloud/migrations/'+p.name for p in (ROOT/'db/cloud/migrations').glob('*.sql'))
        self.assertEqual(len(obj.baseline_migrations()), 43)
        self.assertEqual(obj.baseline_migrations()[-1], '044_cloud_kiosk_enrollment.sql')

    def test_only_finance_changes_can_ship(self):
        r.verify_changed_paths(['apps/backoffice/src/finance.ts', 'packages/backoffice-core/src/finance.ts',
                                'docs/operations/finance-dashboard.md', 'infra/staging/release-finance-dashboard.py'])
        for path in ['apps/kiosk/src/model.ts', 'services/api/src/main.ts', 'pnpm-lock.yaml',
                     'db/cloud/migrations/045_extra.sql', 'infra/staging/compose.yaml']:
            with self.assertRaises(r.market.GuardFailure): r.verify_changed_paths([path])

    def test_compose_gateway_are_unchanged_and_drift_rejected(self):
        raw = 'existing configuration\n'
        self.assertEqual(r.unchanged(raw, r.digest(raw.encode())), raw)
        with self.assertRaises(r.market.GuardFailure): r.unchanged(raw+'drift', r.digest(raw.encode()))
        self.assertEqual(r.finance.MIGRATION_HASHES, {})
        self.assertEqual(r.finance.NEW_TABLES, set())

    def test_runtime_heartbeat_normalized_but_backup_snapshot_stays_full(self):
        obj = object.__new__(r.Release); obj.additions = {}
        def normalizer(self):
            self.asserted = copy.deepcopy(self.additions)
            return {'normalized': True}
        with patch.object(r.base.Release, 'snapshot', normalizer):
            self.assertEqual(obj.runtime_snapshot(), {'normalized': True})
        self.assertEqual(obj.asserted, {'cloud_branch_availability': ['revision', 'observed_at']})
        self.assertEqual(obj.additions, {})
        self.assertIs(r.Release.snapshot, r.market.Release.snapshot)
        with patch.object(r.base.Release, 'snapshot', side_effect=RuntimeError('fixture failure')):
            with self.assertRaises(RuntimeError): obj.runtime_snapshot()
        self.assertEqual(obj.additions, {})

    def test_data_acl_and_post_release_financial_writes_block_rollback(self):
        obj = object.__new__(r.Release)
        data = {'tables': {'bo_finance_entries': {'rows': 1, 'sha256': 'old'},
                          'kiosk_sessions': {'rows': 1, 'sha256': 'session'},
                          'schema_migrations': {'rows': 43, 'sha256': 'ledger'}}, 'sequences': []}
        before = {'ledger': ['exact'], 'runtime_data': data, 'acl': ['bounded'],
                  'worker_acl': ['bank'], 'availability': ['proof']}
        obj.expected_ledger = obj.ledger = lambda: ['exact']
        obj.acl = lambda: ['bounded']; obj.worker_acl = lambda: ['bank']
        obj.availability_rows = lambda: ['current']
        obj.runtime_snapshot = lambda: copy.deepcopy(data)
        with patch.object(r.base, 'verify_availability') as availability:
            obj.verify_data(before)
            obj.retained_rollback_snapshot(before)
            availability.assert_called_with(['proof'], ['current'])
            for table in data['tables']:
                changed = copy.deepcopy(data); changed['tables'][table]['sha256'] = 'changed'
                obj.runtime_snapshot = lambda changed=changed: changed
                with self.assertRaises(r.market.GuardFailure): obj.retained_rollback_snapshot(before)
            obj.runtime_snapshot = lambda: copy.deepcopy(data)
            obj.acl = lambda: ['extra-write']
            with self.assertRaises(r.market.GuardFailure): obj.verify_data(before)
            obj.acl = lambda: ['bounded']; obj.worker_acl = lambda: ['extra-write']
            with self.assertRaises(r.market.GuardFailure): obj.verify_data(before)

    def test_public_manifest_preserves_every_other_component(self):
        old = {'source_sha': 'old', 'files': {'mobile/a': 'mobile', 'backoffice/finance.js': 'old'},
               'component_sources': {'mobile': 'mobile', 'backoffice': 'old'}}
        new = copy.deepcopy(old); new['source_sha'] = 'new'; new['component_sources']['backoffice'] = 'new'
        new['files'].update({'backoffice/'+name: 'new' for name in ['app.js', 'operations.js', 'domain.js', 'index.html', 'finance.js']})
        r.finance.verify_manifest(old, new, 'new')
        new['files']['mobile/a'] = 'changed'
        with self.assertRaises(r.market.GuardFailure): r.finance.verify_manifest(old, new, 'new')

    def backup_fixture(self, root, failure=None):
        obj = object.__new__(r.Release); obj.private = Path(root)
        obj.backup_recipient = 'age1'+'q'*58
        (obj.private/'prepared.json').write_text(json.dumps({'finance_backup_recipient': obj.backup_recipient}))
        key = obj.private/'fixture-key'; key.write_bytes(b'fixture identity - not a real key'); key.chmod(0o600)
        obj.args = SimpleNamespace(backup_identity=key)
        calls = []
        def remote(command, **kwargs):
            calls.append((command, kwargs))
            if 'age --decrypt' in command and failure: raise failure
            return 'a'*64+' backup'
        obj.remote = remote; obj.save = lambda *args: None
        data = {'tables': {'bo_finance_entries': {'rows': 2, 'sha256': 'exact'}}, 'sequences': []}
        obj.snapshot = lambda *args: copy.deepcopy(data); obj.quiescent = lambda: None
        return obj, calls, data

    def test_backup_keeps_both_recipients_streams_identity_and_restores_only_temporary_db(self):
        with tempfile.TemporaryDirectory() as root:
            obj, calls, data = self.backup_fixture(root)
            result = obj.backup_restore(data)
            self.assertTrue(result['original_recipient_retained'])
            self.assertTrue(result['temporary_database_removed'])
            encryption = next(c for c, _ in calls if 'pg_dump' in c)
            self.assertIn('age -r "$recipient" -r age1', encryption)
            self.assertIn(r.BACKUP_RECIPIENT, encryption)
            restore, options = next((c, k) for c, k in calls if 'age --decrypt' in c)
            self.assertIn('pg_restore -U postgres -d pickchick_restore_finance_', restore)
            self.assertIn('--exit-on-error --no-owner --no-acl', restore)
            self.assertEqual(options['input'], b'fixture identity - not a real key')
            self.assertNotIn('fixture identity', restore)
            drops = [c for c, _ in calls if 'dropdb' in c]
            self.assertEqual(len(drops), 1)
            self.assertIn('pickchick_restore_finance_', drops[0])

    def test_unknown_restore_never_drops_running_temporary_database(self):
        with tempfile.TemporaryDirectory() as root:
            obj, calls, data = self.backup_fixture(root, r.market.CommandUncertain('fixture timeout'))
            with self.assertRaises(r.market.CommandUncertain): obj.backup_restore(data)
            self.assertFalse(any('dropdb' in c for c, _ in calls))

    def test_failed_known_restore_removes_only_its_temporary_database(self):
        with tempfile.TemporaryDirectory() as root:
            obj, calls, data = self.backup_fixture(root, r.market.GuardFailure('fixture restore failure'))
            with self.assertRaises(r.market.GuardFailure): obj.backup_restore(data)
            self.assertEqual(sum('dropdb' in c for c, _ in calls), 1)

    def test_backup_drift_stops_before_any_remote_action(self):
        with tempfile.TemporaryDirectory() as root:
            obj, calls, data = self.backup_fixture(root)
            obj.backup_recipient = 'different'
            with self.assertRaises(r.market.GuardFailure): obj.backup_restore(data)
            self.assertEqual(calls, [])


if __name__ == '__main__': unittest.main()
