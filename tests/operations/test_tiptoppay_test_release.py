import copy
import importlib.util
import inspect
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('tiptoppay_test_release',ROOT/'infra/staging/release-tiptoppay-test.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)


class TestRelease(unittest.TestCase):
    def test_profile_exact_schema_and_ci(self):
        args = SimpleNamespace(expected_api_sha=r.BASELINE,expected_public_sha=r.PUBLIC_BASELINE,expected_gateway_sha256=r.GATEWAY_BASELINE)
        with patch.object(r.sys,'version_info',(3,12)),patch.object(r.market.Release,'__init__') as init:
            r.Release(args)
        p = init.call_args.args[2]
        self.assertEqual(p.baseline_count,38)
        self.assertEqual(p.migrations,tuple(r.MIGRATION_HASHES))
        self.assertEqual(p.settings,())
        self.assertTrue(p.exact_ci_jobs)
        self.assertEqual(len(p.ci_jobs),11)
        with patch.object(r.sys,'version_info',(3,9)):
            with self.assertRaises(r.market.GuardFailure):r.Release(args)

    def test_local_credentials_cannot_enable_live_or_wallets(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder)/'test.env'
            p.write_text('TIPTOPPAY_PUBLIC_ID=test_api_example\nTIPTOPPAY_API_SECRET=example-secret-12345\nTIPTOPPAY_MODE=test\nTIPTOPPAY_WEBHOOKS_ENABLED=true\n')
            p.chmod(0o600)
            env = dict(x.split('=',1) for x in r.test_environment(p).splitlines())
            self.assertEqual(env['TIPTOPPAY_MODE'],'test')
            self.assertEqual(env['TIPTOPPAY_CHECKOUT_ENABLED'],'false')
            self.assertEqual(env['TIPTOPPAY_WEBHOOKS_ENABLED'],'false')
            self.assertEqual(env['TIPTOPPAY_TEST_CHECKOUT_METHODS'],'card')
            self.assertEqual(env['TIPTOPPAY_METHOD_ROUTING_VERIFIED'],'false')
            for bad in ['TIPTOPPAY_MODE=live\n','TIPTOPPAY_PUBLIC_ID=pk_other\n','DATABASE_URL=other\n']:
                p.write_text('TIPTOPPAY_PUBLIC_ID=test_api_example\nTIPTOPPAY_API_SECRET=example-secret-12345\nTIPTOPPAY_MODE=test\n'+bad)
                with self.assertRaises(r.market.GuardFailure):r.test_environment(p)
            p.chmod(0o644)
            with self.assertRaises(r.market.GuardFailure):r.test_environment(p)

    def test_compose_only_adds_api_private_env(self):
        raw='services:\n  api:\n    env_file: [/private/auth.env, /private/kaspi.env]\n    environment:\n      FARM_ENABLED: "1"\n  provision:\n    env_file: [/private/auth.env]\n'
        with patch.object(r,'COMPOSE_BASELINE',r.digest(raw.encode())):
            result=r.compose_candidate(raw,'a'*40)
            self.assertIn('/releases/'+'a'*40+'/tiptoppay-test.env',result)
            self.assertEqual(result.split('  provision:')[1],raw.split('  provision:')[1])
            with self.assertRaises(r.market.GuardFailure):r.compose_candidate(raw+'#drift','a'*40)

    def test_gateway_adds_only_bounded_test_routes(self):
        raw=':8080 {\n\t@farm_preflight {\n\t\tmethod OPTIONS\n\t}\n}\n'
        with patch.object(r,'GATEWAY_BASELINE',r.digest(raw.encode())):
            result=r.gateway_candidate(raw)
            self.assertEqual(result.replace(r.gateway_block(),''),raw)
            self.assertIn('/test-check /v1/integrations/tiptoppay/test-pay',result)
            self.assertIn('Access-Control-Allow-Headers Authorization,Content-Type',result)
            self.assertNotIn('path /v1/integrations/tiptoppay/pay',result)
            self.assertNotIn('path /v1/integrations/tiptoppay/checkout',result)
            with self.assertRaises(r.market.GuardFailure):r.gateway_candidate(raw+'#drift')

    def test_exact_test_only_acl_and_worker_guards(self):
        obj=object.__new__(r.Release)
        before={'ledger':[],'acl':[],'worker_acl':['bank']}
        obj.ledger=lambda:[{'version':n,'scope':'cloud','checksum':h} for n,h in r.MIGRATION_HASHES.items()]
        obj.compare_runtime=lambda b:None
        good=[{'name':r.TEST_TABLE,'kind':'r','column':None,'privilege':p,'grantable':False} for p in ['SELECT','INSERT','UPDATE']]
        obj.acl=lambda:good
        obj.worker_acl=lambda:['bank']
        obj.psql=lambda *a:'0'
        obj.verify_data(before)
        obj.acl=lambda:good+[{'name':'commerce_captures','kind':'r','column':None,'privilege':'INSERT','grantable':False}]
        with self.assertRaises(r.market.GuardFailure):obj.verify_data(before)
        obj.acl=lambda:good
        obj.worker_acl=lambda:['changed']
        with self.assertRaises(r.market.GuardFailure):obj.verify_data(before)

    def test_migrations_and_permissions_are_reviewed(self):
        for n,h in r.MIGRATION_HASHES.items():self.assertEqual(r.digest((ROOT/'db/cloud/migrations'/n).read_bytes()),h)
        script=r.owner_migration_program()
        self.assertIn('tipTopPayTestGrants',script)
        self.assertNotIn('provision.mjs',script)
        self.assertNotIn('tipTopPayObservationGrants',script)
        self.assertNotIn('farmGrants',script)

    def test_apply_backups_before_migration_and_rollbacks_never_restore_dump(self):
        source=inspect.getsource(r.Release.apply)
        self.assertLess(source.index('self.backup_restore('),source.index('owner_migration_program('))
        self.assertIn('self.verify_environment(',source)
        self.assertIn('self.fingerprint()',source)
        rollback=inspect.getsource(r.Release.rollback_closed)
        self.assertIn("proof['artifacts']['rollback_image_id']",rollback)
        self.assertNotIn('pg_restore',rollback)
        self.assertNotIn('DROP TABLE',rollback)
        self.assertIn('acl_restore_sql',rollback)


if __name__ == '__main__':unittest.main()
