import copy
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('finance_history_test', ROOT/'infra/staging/release-finance-history.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)


class FinanceHistoryRelease(unittest.TestCase):
    def test_exact_independent_baselines_and_full_ci(self):
        args = SimpleNamespace(expected_api_sha=r.API, expected_public_sha=r.PUBLIC,
                               expected_gateway_sha256=r.GATEWAY)
        with patch.object(r.sys, 'version_info', (3, 12)), patch.object(r.market.Release, '__init__') as init:
            r.Release(args)
        profile = init.call_args.args[2]
        self.assertEqual(profile.baseline_count, 43)
        self.assertEqual(profile.migrations, ())
        self.assertEqual(len(profile.ci_jobs), 11)
        self.assertTrue(profile.exact_ci_jobs)
        self.assertEqual(r.finance.BASELINE, r.API)
        self.assertEqual(r.finance.PUBLIC_BASELINE, r.PUBLIC)
        self.assertEqual(object.__new__(r.Release).web_manifest_source(), r.PUBLIC)
        for name in vars(args):
            bad = copy.copy(args); setattr(bad, name, '0'*len(getattr(bad, name)))
            with self.assertRaises(r.market.GuardFailure): r.Release(bad)

    def test_scope_prevents_unrelated_release(self):
        r.verify_changed_paths(['packages/backoffice-core/src/finance.ts', 'apps/backoffice/src/finance.ts',
                                'docs/operations/finance-history.md', 'infra/staging/release-finance-history.py'])
        for path in ['apps/backoffice/src/app.ts', 'apps/kiosk/App.tsx', 'pnpm-lock.yaml',
                     'db/cloud/migrations/045_extra.sql', 'services/api/src/main.ts']:
            with self.assertRaises(r.market.GuardFailure): r.verify_changed_paths([path])

    def test_existing_guards_and_isolated_backup_are_inherited(self):
        for name in ['backup_restore', 'runtime_old', 'verify_data', 'retained_rollback_snapshot',
                     'verify_public', 'protected_policy', 'runtime_snapshot']:
            self.assertIs(getattr(r.Release, name), getattr(r.dashboard.Release, name))
        for name in ['prepare', 'apply', 'deployment_lock', 'resume_owned_rollback']:
            self.assertIs(getattr(r.Release, name), getattr(r.finance.Release, name))
        self.assertEqual(r.finance.MIGRATION_HASHES, {})
        self.assertEqual(r.finance.NEW_TABLES, set())

    def test_proof_records_actual_public_baseline(self):
        obj = object.__new__(r.Release)
        with patch.object(r.finance.Release, 'save') as save:
            obj.save('result.json', {'deployed': True})
        value = save.call_args.args[2]
        self.assertEqual(value['baseline_api'], r.API)
        self.assertEqual(value['baseline_public'], r.PUBLIC)
        self.assertEqual(value['migrations_applied'], 0)


if __name__ == '__main__': unittest.main()
