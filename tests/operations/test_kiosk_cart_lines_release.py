import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('kiosk_cart_lines_release', Path(__file__).resolve().parents[2] / 'infra/staging/release-kiosk-cart-lines.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class KioskCartReleaseTests(unittest.TestCase):
    def test_reviewed_runtime_only(self):
        r.validate_source([*r.SOURCE_HASHES, *r.SUPPORT_PATHS], r.SOURCE_HASHES.copy())
        with self.assertRaises(r.market.GuardFailure):
            r.validate_source([*r.SOURCE_HASHES, 'services/api/src/main.ts'], r.SOURCE_HASHES)
        hashes = r.SOURCE_HASHES.copy()
        hashes[next(iter(hashes))] = '0' * 64
        with self.assertRaises(r.market.GuardFailure):
            r.validate_source(r.SOURCE_HASHES, hashes)

    def test_wrong_compose_refused(self):
        text = 'services:\n  api:\n    environment:\n      WORKFORCE_ENABLED: "true"\n'
        self.assertEqual(r.e.compose_candidate(text, r.digest(text.encode())), text)
        with self.assertRaises(r.market.GuardFailure):
            r.e.compose_candidate(text, '0' * 64)

    def test_apply_inspection_never_mutates(self):
        obj = object.__new__(r.Release)
        obj.args = SimpleNamespace(apply=False)
        obj.prepared = Mock(return_value={'before': 1, 'artifacts': 2})
        obj.baseline = Mock(return_value=1)
        obj.artifacts = Mock(return_value=2)
        obj.plan = Mock()
        obj.backup_restore = Mock(side_effect=AssertionError('No backup in inspection'))
        obj.remote = Mock(side_effect=AssertionError('No mutation in inspection'))
        obj.apply()
        obj.plan.assert_called_once()
        obj.remote.assert_not_called()
        obj.backup_restore.assert_not_called()

    def test_large_order_blocks_old_reader_rollback(self):
        obj = object.__new__(r.Release)
        obj.psql = Mock(return_value=json.dumps({'n': 1}))
        with self.assertRaises(r.market.GuardFailure):
            obj.compatible_rollback()
        query = obj.psql.call_args.args[1]
        self.assertIn('commerce_quotes', query)
        self.assertIn('commerce_orders', query)
        self.assertIn('> 200', query)
        obj.psql.return_value = json.dumps({'n': 0})
        obj.compatible_rollback()

    def test_exact_057_ledger_rejects_058(self):
        obj = object.__new__(r.Release)
        names = [f'db/cloud/migrations/{n:03d}_synthetic.sql' for n in [*range(1, 41), *range(42, 58)]]
        obj.git = Mock(return_value='\n'.join(names))
        self.assertEqual(len(obj.baseline_migrations()), 56)
        obj.git.return_value += '\ndb/cloud/migrations/058_unreviewed.sql'
        with self.assertRaises(r.market.GuardFailure):
            obj.baseline_migrations()


if __name__ == '__main__':
    unittest.main()
