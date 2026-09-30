import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import subprocess
import shlex

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('tested_mobile_kaspi',ROOT/'infra/staging/release-mobile-kaspi.py')
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)

class OwnerPilot(unittest.TestCase):
    def env(self):
        return {k: '10000000-0000-4000-8000-000000000001' for k in m.FIELDS} | {
            'CUSTOMER_KASPI_PILOT_MAX_MINOR':'10000',
            'CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE':'owner-approved-2026-09-30'}
    def raw(self, env):
        return '\n'.join(k+'='+v for k,v in env.items())+'\n'
    def test_owner_scope_and_amount(self):
        self.assertEqual(m.checkout_environment(self.raw(self.env())),self.env())
        for changes in [
            {'CUSTOMER_KASPI_PILOT_MAX_MINOR':'10001'},
            {'CUSTOMER_KASPI_PILOT_CUSTOMER_IDS':'10000000-0000-4000-8000-000000000001,10000000-0000-4000-8000-000000000002'},
            {'CUSTOMER_KASPI_BRANCH_ID':'unknown'},
            {'CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE':''},
            {'KASPI_SESSION_TOKEN_SN':'secret'},
        ]:
            with self.subTest(changes=list(changes)),self.assertRaises(m.market.GuardFailure):
                m.checkout_environment(self.raw(self.env()|changes))
    def test_duplicate_and_unknown_fields_refused(self):
        for extra in ['CUSTOMER_KASPI_PILOT_MAX_MINOR=10000\n','CLOUD_DATABASE_URL=anything\n','broken-line\n']:
            with self.assertRaises(m.market.GuardFailure):m.checkout_environment(self.raw(self.env())+extra)
    def test_compose_passes_scope_to_both_api_and_provision(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);target=root/'infra/staging';target.mkdir(parents=True)
            env=root/'checkout.env';env.write_text(self.raw(self.env()));env.chmod(0o600)
            release=object.__new__(m.Release);release.args=SimpleNamespace(checkout_env=env)
            commands=[]
            def prepare_parent(obj, location):
                source=(ROOT/'infra/staging/compose.yaml').read_text()
                source=source.replace('  api:\n','  api:\n    env_file: ['+m.base.pilot.AUTH_FILE+']\n',1)
                (target/'compose.yaml').write_text(source)
            def remote(command,**kw):
                commands.append(command)
                if len(commands)==2:subprocess.run(shlex.split(command),check=True,capture_output=True)
            release.remote=remote
            with patch.object(m.base.pilot.Release,'prepare_api',prepare_parent):release.prepare_api(str(root))
            result=(target/'compose.yaml').read_text()
            self.assertEqual(result.count('env_file: ['+m.base.pilot.AUTH_FILE+', '+m.CHECKOUT_FILE+']'),2)
            self.assertEqual(result.count('CUSTOMER_KASPI_PILOT_ENABLED: "true"'),2)
            self.assertEqual(result.count('CLOUD_FULFILLMENT_TRANSPORT_ENABLED: "true"'),2)
            self.assertIn('CLOUD_POS_ORDER_SYNC_ENABLED: ${CLOUD_POS_ORDER_SYNC_ENABLED:-false}',result)

    def test_acl_verification_rolls_back_and_rejects_extra_privilege(self):
        release=object.__new__(m.Release)
        release.ledger=lambda: []
        release.snapshot=lambda: {'tables':{},'sequences':[]}
        release.acl=lambda: []
        release.execute=lambda *a,**kw: b'GRANT SELECT ON branches TO pickchick_app;'
        calls=[]
        def psql(db,sql):
            calls.append(sql)
            return '[]' if 'json_agg' in sql else 'f'
        release.psql=psql
        before={'ledger':[],'data':{'tables':{},'sequences':[]},'acl':[
            {'name':'bo_records','kind':'r','column':None,'privilege':'INSERT','grantable':False}]}
        release.verify_data(before)
        self.assertTrue(calls[0].endswith(';ROLLBACK;'))
        self.assertNotIn('COMMIT;',calls[0])
        with self.assertRaises(m.market.GuardFailure):release.verify_data({**before,'acl':[]})
        release.acl=lambda:[{'name':'identity_sessions','kind':'r','column':None,'privilege':'DELETE','grantable':False}]
        with self.assertRaises(m.market.GuardFailure):release.verify_data(before)

if __name__=='__main__':unittest.main()
