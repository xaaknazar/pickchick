import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('kiosk_incident_release', ROOT / 'infra/staging/release-kiosk-incident.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)
GuardFailure = r.GuardFailure


def files_and_ledger(upto):
    files = sorted(p.name for p in (ROOT / 'db/cloud/migrations').glob('*.sql') if p.name <= '050_z')
    sums = {n: r.digest((ROOT / 'db/cloud/migrations' / n).read_bytes()) for n in files}
    ledger = [{'version': n, 'scope': 'cloud', 'checksum': sums[n]} for n in files if n <= upto]
    return files, sums, ledger


class Plan(unittest.TestCase):
    def test_only_050_may_be_pending(self):
        files, sums, ledger = files_and_ledger('049_z')
        self.assertEqual(r.incident_plan(ledger, files, sums), [r.MIGRATION])
        _, _, applied = files_and_ledger('050_z')
        self.assertEqual(r.incident_plan(applied, files, sums), [])
        with self.assertRaisesRegex(GuardFailure, 'exactly 050'):
            r.incident_plan(ledger[:-1], files, sums)

    def test_changed_history_or_extra_migration_refused(self):
        files, sums, ledger = files_and_ledger('049_z')
        bad = [dict(row) for row in ledger]
        bad[-1]['checksum'] = '0' * 64
        with self.assertRaisesRegex(GuardFailure, 'ledger differs'):
            r.incident_plan(bad, files, sums)
        with self.assertRaisesRegex(GuardFailure, 'end with 050'):
            r.incident_plan(ledger, files + ['051_cloud_unreviewed.sql'], {**sums, '051_cloud_unreviewed.sql': '1' * 64})

    def test_base_schema_is_049_without_041(self):
        names = sorted(p.name for p in (ROOT / 'db/cloud/migrations').glob('*.sql') if p.name <= '049_z')
        r.check_base_schema(names)
        with self.assertRaises(GuardFailure):
            r.check_base_schema(names[:-1])
        with self.assertRaises(GuardFailure):
            r.check_base_schema(names + [r.MIGRATION])

    def test_migration_and_owner_files_exist(self):
        self.assertTrue((ROOT / 'db/cloud/migrations' / r.MIGRATION).is_file())
        owner = (ROOT / 'infra/staging/kiosk-incident-owner.mjs').read_text()
        self.assertIn("INCIDENT_MIGRATION = '" + r.MIGRATION + "'", owner)
        self.assertEqual(r.EXACT_ACL, {(r.NEW_TABLE, None, 'SELECT'), (r.NEW_TABLE, None, 'INSERT')})

    def test_arguments_require_ci_and_compose(self):
        base = ['a' * 40, '--branch', 'codex/x', '--branch-id', '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1']
        with self.assertRaises(SystemExit):
            r.parse(base + ['--ci-run', '1'])
        with self.assertRaises(SystemExit):
            r.parse(base + ['--expected-compose-sha256', 'b' * 64])
        args = r.parse(base + ['--expected-compose-sha256', 'b' * 64, '--ci-run', '1'])
        self.assertFalse(args.apply)


if __name__ == '__main__':
    unittest.main()
