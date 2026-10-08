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

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('checkout_release_test', ROOT/'infra/staging/release-kiosk-checkout.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)
ENV = {'KIOSK_CHECKOUT_MAX_MINOR':'unlimited','KIOSK_CHECKOUT_FISCAL_POLICY':'deferred_pilot',
       'KIOSK_CHECKOUT_APPROVAL_REFERENCE':'owner-2026-10-08-no-receipt-unlimited-backoffice'}


class CheckoutRelease(unittest.TestCase):
    def test_gateway_preserves_all_previous_bytes_and_bounds_methods_and_paths(self):
        raw = 'site {\n\t@kiosk_menu_read {\n\t\tmethod GET\n\t}\n}\n'
        with patch.object(r,'GATEWAY_BASELINE',r.digest(raw.encode())):
            output = r.gateway_candidate(raw,r.digest(raw.encode()))
            block = output[output.index('\t@kiosk_checkout_create {'):output.index('\t@kiosk_menu_read {')]
            self.assertEqual(output.replace(block,'',1),raw)
            self.assertEqual(block.count('header_up -Cookie'),3)
            self.assertEqual(block.count('header_up -X-Device-Id'),3)
            self.assertEqual(block.count('response_header_timeout 5s'),3)
            self.assertIn('path /v1/kiosk-checkout/quotes /v1/kiosk-checkout/orders\n',block)
            self.assertIn('/payment$',block)
            self.assertNotIn('/api/qr',block); self.assertNotIn('-Authorization',block)
            self.assertNotIn('orders/*',block)
            with self.assertRaises(r.market.GuardFailure): r.gateway_candidate(output,r.digest(raw.encode()))
        with self.assertRaises(r.market.GuardFailure): r.gateway_candidate(raw,'0'*64)

    def test_environment_has_exact_owner_policy_and_cannot_enable_other_features(self):
        self.assertEqual(r.validate_environment(ENV),ENV)
        for value in [{**ENV,'KIOSK_KASPI_QR_ENABLED':'true'}, {**ENV,'KIOSK_CHECKOUT_MAX_MINOR':'0'},
                      {**ENV,'KIOSK_CHECKOUT_FISCAL_POLICY':'required'}, {**ENV,'KIOSK_CHECKOUT_APPROVAL_REFERENCE':'different'}]:
            with self.assertRaises(r.market.GuardFailure): r.validate_environment(value)
        raw = 'compose fixture'
        with patch.object(r,'COMPOSE_BASELINE',r.digest(raw.encode())):
            self.assertEqual(r.compose_candidate(raw,ENV),raw)
            with self.assertRaises(r.market.GuardFailure): r.compose_candidate(raw+'changed',ENV)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'release.env'
            original = 'RELEASE_SHA=fixture\nSECRET_EXISTING=synthetic-only\nKIOSK_KASPI_QR_ENABLED=false\n'
            path.write_text(original+'KIOSK_CHECKOUT_MAX_MINOR=10000\nKIOSK_CHECKOUT_FISCAL_POLICY=deferred_pilot\nKIOSK_CHECKOUT_APPROVAL_REFERENCE=old\n')
            subprocess.run([sys.executable,'-c',r.environment_program(),str(path)],input=json.dumps(ENV),text=True,check=True)
            self.assertTrue(path.read_text().startswith(original))
            self.assertIn('KIOSK_CHECKOUT_MAX_MINOR=unlimited\n',path.read_text())
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            path.write_text(path.read_text()+'KIOSK_CHECKOUT_MAX_MINOR=10000\n')
            result = subprocess.run([sys.executable,'-c',r.environment_program(),str(path)],input=json.dumps(ENV),text=True,capture_output=True)
            self.assertNotEqual(result.returncode,0)

    def test_grants_exact_delta_rejects_mutating_money_and_provider_accounts(self):
        before = [{'name':'existing','kind':'r','column':None,'privilege':'SELECT','grantable':False}]
        expected = r.director.expected_acl(before,r.grants_sql())
        r.verify_grants(before,expected)
        for name in ['commerce_captures','commerce_provider_accounts']:
            bad = expected+[dict(name=name,kind='r',column=None,privilege='UPDATE',grantable=False)]
            with self.assertRaises(r.market.GuardFailure): r.verify_grants(before,bad)
        qr = r.director.expected_acl([],r.grants_sql(True).replace('pickchick_kaspi_worker','pickchick_app'))
        rows = [dict(name=x['name'],column_name=x['column'],privilege=x['privilege'],grantable=False) for x in qr]
        r.verify_grants([],rows,True)
        with self.assertRaises(r.market.GuardFailure):
            r.verify_grants([],rows+[dict(name='commerce_kiosk_kaspi_qr',column_name='amount_minor',privilege='UPDATE',grantable=False)],True)
        self.assertNotIn('migrate(',r.owner_grants_program())
        self.assertNotIn('INSERT INTO',r.owner_grants_program())

    def test_profile_is_exact_schema044_and_full_ci(self):
        obj = object.__new__(r.Release)
        names = [f'{n:03d}_fixture.sql' for n in list(range(1,41))+[42,43,44]]
        obj.git = lambda *args:'\n'.join(names)
        self.assertEqual(len(obj.baseline_migrations()),43)
        names.append('045_unreviewed.sql')
        with self.assertRaises(r.market.GuardFailure): obj.baseline_migrations()
        with tempfile.TemporaryDirectory() as folder:
            env = Path(folder).resolve()/'environment.json'; env.write_text(json.dumps(ENV)); env.chmod(0o600)
            args = SimpleNamespace(environment=env,expected_api_sha=r.BASELINE,expected_public_sha=r.BASELINE,expected_gateway_sha256=r.GATEWAY_BASELINE)
            with patch.object(r.sys,'version_info',(3,12)),patch.object(r.market.Release,'__init__') as init:
                r.Release(args)
                profile = init.call_args.args[2]
                self.assertEqual(len(profile.ci_jobs),11)
                self.assertTrue(profile.exact_ci_jobs)
                self.assertEqual(profile.migrations,())
                self.assertEqual(profile.baseline_count,43)
        self.assertIs(r.Release.apply,r.qr.Release.apply)
        self.assertIs(r.Release.prepare,r.qr.Release.prepare)
        self.assertIs(r.Release.resume_owned_rollback,r.qr.Release.resume_owned_rollback)

    def test_new_money_blocks_rollback_and_no_live_database_restore(self):
        obj = object.__new__(r.Release)
        before = {'ledger':[], 'runtime_data':{'tables':{'commerce_orders':{'rows':1,'sha256':'money'}},'sequences':[]}, 'availability':[]}
        current = copy.deepcopy(before['runtime_data'])
        obj.ledger = lambda:[]; obj.runtime_snapshot = lambda:current; obj.availability_rows = lambda:[]
        self.assertEqual(obj.retained_rollback_snapshot(before)[0],[])
        current['tables']['commerce_orders']['sha256'] = 'new-money'
        with self.assertRaises(r.market.GuardFailure): obj.retained_rollback_snapshot(before)

    def test_unknown_restore_keeps_temporary_database_for_inspection(self):
        obj = object.__new__(r.Release)
        commands = []
        with tempfile.TemporaryDirectory() as folder:
            identity = Path(folder)/'identity'; identity.write_text('synthetic')
            obj.args = SimpleNamespace(backup_identity=identity)
            obj.save = lambda *args:None
            def remote(command,**kwargs):
                commands.append(command)
                if 'pg_restore' in command: raise r.market.CommandUncertain('Fixture lost connection')
                return ''
            obj.remote = remote
            with self.assertRaises(r.market.CommandUncertain): obj.backup_restore({})
            self.assertTrue(any('createdb' in c for c in commands))
            self.assertFalse(any('dropdb' in c for c in commands))


if __name__ == '__main__': unittest.main()
