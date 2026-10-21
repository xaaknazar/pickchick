"""Runtime deployment failure boundaries; synthetic fixtures, no network."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('runtime1021_test', ROOT/'infra/staging/release-runtime-1021.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)


def receipt(**kw):
    return dict({'ok':True, 'checksum':'verified', 'migration':r.LEDGER_HEAD,
                 'restore':'passed', 'candidate_startup':'passed', 'sha256':'a'*64}, **kw)


class Guards(unittest.TestCase):
    def test_rehearsal_passes_real_staging_config_validator(self):
        env = r.rehearsal_environment({'APP_ENV':'staging'}, 'a'*64, 'b'*64, 'c'*40)
        program = "import {loadConfig} from './packages/platform/dist/config.js';const c=loadConfig('api');console.log(JSON.stringify({environment:c.environment,database:new URL(c.databaseUrl).hostname,redis:new URL(c.redisUrl).hostname}));"
        result = subprocess.run(['node','--input-type=module','-e',program], cwd=ROOT,
                                env={**os.environ,**env}, check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(result.stdout), {'environment':'staging','database':'cloud-db','redis':'redis-cache'})

    def test_rehearsal_does_not_accept_non_synthetic_passwords(self):
        for password in ('', 'short', 'a'*63, 'g'*64):
            with self.assertRaises(r.market.GuardFailure):
                r.rehearsal_environment({}, password, 'b'*64, 'c'*40)

    def test_only_reviewed_support_delta(self):
        r.check_delta(r.SUPPORT)
        for path in ['services/api/src/main.ts','db/cloud/migrations/069_cloud_customer_notifications.sql','infra/staging/release-market.py']:
            with self.assertRaises(r.market.GuardFailure): r.check_delta([path])

    def test_flags_off_for_all_optional_programs(self):
        r.check_flags({})
        r.check_flags({k:r.digest(b'false') for k in r.FLAGS})
        for key in r.FLAGS:
            for value in ('true','1','yes'):
                with self.assertRaises(r.market.GuardFailure): r.check_flags({key:r.digest(value.encode())})

    def test_schema068_excludes_unapplied_push(self):
        obj = r.Release.__new__(r.Release)
        ledger = obj.expected_ledger()
        self.assertEqual(len(ledger), 61)
        self.assertEqual(ledger[-1]['version'],r.LEDGER_HEAD)
        self.assertFalse(any(x['version'].startswith('069_') for x in ledger))

    def test_backup_and_candidate_startup_both_required(self):
        r.check_receipt(receipt())
        for field in ('ok','checksum','migration','restore','candidate_startup'):
            with self.assertRaises(r.market.GuardFailure): r.check_receipt(receipt(**{field:None}))

    def test_notice_may_change_but_frozen_gate_cannot(self):
        before = {'features':{'payments':False}, 'notice':{'ru':'old','kk':'old'}}
        r.check_capabilities(before, {**before, 'notice':{'ru':'new','kk':'new'}})
        for after in [{**before,'features':{'payments':True}},{**before,'notice':{}},{**before,'ordering_enabled':True}]:
            with self.assertRaises(r.market.GuardFailure): r.check_capabilities(before,after)

    def fixture(self, apply=True):
        obj = r.Release.__new__(r.Release)
        obj.sha = 'b'*40; obj.args = SimpleNamespace(apply=apply)
        proof = {'before':{'x':1}, 'artifacts':{'image':'sha256:'+'c'*64}}
        obj.prepared = Mock(return_value=proof); obj.baseline = Mock(return_value=proof['before'])
        obj.artifacts = Mock(return_value=proof['artifacts']); obj.backup_restore = Mock(return_value=receipt())
        obj.remote = Mock(); obj.ready = Mock(); obj.api_image = Mock(return_value=proof['artifacts']['image'])
        obj.switch = Mock(); obj.current = Mock(); obj.save = Mock()
        return obj

    def test_readonly_does_not_backup_or_switch(self):
        obj = self.fixture(False)
        with contextlib.redirect_stdout(io.StringIO()): obj.apply()
        obj.backup_restore.assert_not_called(); obj.remote.assert_not_called(); obj.switch.assert_not_called()

    def test_failed_rehearsal_never_switches_live_api(self):
        for bad in (receipt(candidate_startup='failed'), receipt(restore='failed')):
            obj = self.fixture(); obj.backup_restore.return_value = bad
            with self.assertRaises(r.market.GuardFailure): obj.apply()
            obj.remote.assert_not_called(); obj.switch.assert_not_called()

    def test_baseline_drift_during_backup_blocks_switch(self):
        obj = self.fixture(); obj.baseline.side_effect = [{'x':1},{'x':2}]
        with self.assertRaises(r.market.GuardFailure): obj.apply()
        obj.remote.assert_not_called()

    def test_only_api_switched_after_rehearsal(self):
        obj = self.fixture(); calls=[]
        obj.backup_restore.side_effect = lambda: calls.append('rehearsal') or receipt()
        obj.remote.side_effect = lambda command,**kw: calls.append(command)
        obj.apply()
        self.assertEqual(calls[0],'rehearsal')
        self.assertEqual(len(calls),2)
        self.assertTrue(calls[1].endswith('up -d --no-deps --wait --wait-timeout 120 api'))
        obj.current.assert_called_once()
        self.assertFalse(any('provision' in x or 'worker' in x for x in calls))

    def test_no_flag_activation_action(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit): r.parse(['enable'])


if __name__ == '__main__': unittest.main()
