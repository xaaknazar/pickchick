import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

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
        before={'ledger':[],'data':{'tables':{},'sequences':[]},'acl':[]}
        release.verify_data(before)
        self.assertTrue(calls[0].endswith(';ROLLBACK;'))
        self.assertNotIn('COMMIT;',calls[0])
        release.acl=lambda:[{'name':'identity_sessions','kind':'r','column':None,'privilege':'DELETE','grantable':False}]
        with self.assertRaises(m.market.GuardFailure):release.verify_data(before)

if __name__=='__main__':unittest.main()
