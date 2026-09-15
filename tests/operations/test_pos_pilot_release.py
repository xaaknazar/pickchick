import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('pos_pilot', ROOT/'infra/staging/release-pos-pilot.py')
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


class PilotProfile(unittest.TestCase):
    def fixture(self):
        ledger = pilot.local_sources()
        return {'api_sha': pilot.BASELINE_API, 'api_pointer': pilot.BASELINE_API,
                'web_sha': pilot.BASELINE_WEB, 'web_pointer': pilot.BASELINE_WEB,
                'api_ports': '3100/tcp -> 127.0.0.1:13100', 'ledger': ledger,
                'role': {'superuser': False, 'createdb': False, 'createrole': False,
                         'replication': False, 'bypassrls': False, 'memberships': 0}}, ledger

    def test_actual_014_baseline_has_exact_18_unseeded_new_tables_and_no_new_sequence(self):
        ledger = pilot.local_sources()
        self.assertEqual(len(ledger), 14)
        self.assertEqual(len(pilot.NEW_TABLES), 18)
        self.assertEqual(len(pilot.PROFILE.migrations), 4)
        self.assertEqual(pilot.PROFILE.new_sequences, frozenset())

    def test_rejects_old_historical_release_wrong_web_public_port_role_and_same_count_ledger_edit(self):
        data, ledger = self.fixture()
        self.assertEqual(pilot.validate_observed(data, ledger), data)
        for key, bad in [('api_sha', pilot.market.TRANSPORT_BASELINE),
                         ('web_pointer', pilot.BASELINE_API),
                         ('api_ports', '3100/tcp -> 0.0.0.0:13100')]:
            other = copy.deepcopy(data); other[key] = bad
            with self.subTest(key=key), self.assertRaises(pilot.market.GuardFailure):
                pilot.validate_observed(other, ledger)
        for mutate in [lambda d: d['role'].update(memberships=1),
                       lambda d: d['ledger'][3].update(checksum='f'*64)]:
            other = copy.deepcopy(data); mutate(other)
            with self.assertRaises(pilot.market.GuardFailure): pilot.validate_observed(other, ledger)

    def test_old_rows_preserved_only_inert_new_lock_columns_are_accepted(self):
        old = {'id': 'synthetic-id', 'status': 'active', 'token_hash': 'synthetic-hash'}
        for table in pilot.OLD_TABLE_ADDITIONS:
            pilot.preserve_row(table, old, {**old, 'pos_sync_lock_anchor': False})
            for value in [{**old, 'pos_sync_lock_anchor': True},
                          {**old, 'pos_sync_lock_anchor': False, 'status': 'revoked'},
                          {**old, 'pos_sync_lock_anchor': False, 'new_authority': True}, old]:
                with self.assertRaises(pilot.market.GuardFailure): pilot.preserve_row(table, old, value)
        pilot.preserve_row('branches', old, old)
        with self.assertRaises(pilot.market.GuardFailure):
            pilot.preserve_row('branches', old, {**old, 'ordering_enabled': True})
        self.assertEqual(pilot.snapshot_expression('branches'), 'to_jsonb(t)')
        self.assertIn('pos_sync_lock_anchor', pilot.snapshot_expression('devices'))
        with self.assertRaises(pilot.market.GuardFailure): pilot.snapshot_expression('devices; DROP TABLE devices')

    def test_plan_never_claims_deployment_or_restore_and_enforces_private_transport(self):
        data, ledger = self.fixture()
        value = pilot.plan('a'*40, data, ledger)
        self.assertFalse(value['deployable'])
        self.assertFalse(value['backup_restored'])
        self.assertFalse(value['migration_applied'])
        self.assertEqual(value['private_transport']['permit_open'], '127.0.0.1:13100')
        self.assertEqual(value['settings']['BACKOFFICE_ENABLED'], 'true')
        self.assertEqual(value['settings']['CLOUD_POS_ORDER_SYNC_ENABLED'], 'true')
        self.assertEqual(value['settings']['CUSTOMER_AUTH_ENABLED'], 'false')
        self.assertEqual(value['settings']['CLOUD_FULFILLMENT_TRANSPORT_ENABLED'], 'false')
        self.assertEqual(value['physical_branch_id'], pilot.BRANCH_ID)

    def test_cli_local_plan_private_permissions_and_reject_apply_or_overwrite(self):
        data, _ = self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            observed, output = Path(directory)/'observed.json', Path(directory)/'plan.json'
            observed.write_text(json.dumps(data))
            cmd = [sys.executable, str(ROOT/'infra/staging/release-pos-pilot.py'), 'plan',
                   '--observed', str(observed), '--sha', 'a'*40, '--output', str(output)]
            first = subprocess.run(cmd, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            saved = output.read_bytes()
            self.assertNotEqual(subprocess.run(cmd, capture_output=True).returncode, 0)
            self.assertEqual(output.read_bytes(), saved)
            cmd[2] = 'apply'
            self.assertNotEqual(subprocess.run(cmd, capture_output=True).returncode, 0)


if __name__ == '__main__': unittest.main()
