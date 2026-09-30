import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('tested_owner_kaspi', ROOT/'infra/staging/release-owner-kaspi.py')
m = importlib.util.module_from_spec(spec); sys.modules[spec.name] = m; spec.loader.exec_module(m)

class OwnerRepeat(unittest.TestCase):
    def env(self):
        return {k:'10000000-0000-4000-8000-000000000001' for k in m.base.FIELDS} | {
            'CUSTOMER_KASPI_PILOT_MAX_MINOR':m.MAX_MINOR,
            'CUSTOMER_KASPI_PILOT_REPEAT_ORDERS':'true',
            'CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE':'owner-repeat-approved-2026-09-30'}
    def raw(self, env): return '\n'.join(k+'='+v for k,v in env.items())+'\n'
    def test_owner_only_explicit_bounded_repeat_policy(self):
        self.assertEqual(m.checkout_environment(self.raw(self.env())), self.env())
        for change in [
            {'CUSTOMER_KASPI_PILOT_MAX_MINOR':'999999999'},
            {'CUSTOMER_KASPI_PILOT_REPEAT_ORDERS':'false'},
            {'CUSTOMER_KASPI_PILOT_CUSTOMER_IDS':self.env()['CUSTOMER_KASPI_PILOT_CUSTOMER_IDS']+',10000000-0000-4000-8000-000000000002'},
            {'UNEXPECTED':'true'},
        ]:
            with self.subTest(change=change), self.assertRaises(m.market.GuardFailure):
                m.checkout_environment(self.raw(self.env() | change))
        with self.assertRaises(m.market.GuardFailure):
            m.checkout_environment(self.raw(self.env())+'CUSTOMER_KASPI_PILOT_REPEAT_ORDERS=true\n')
    def test_rollback_environment_is_distinct(self):
        self.assertNotEqual(m.Release.checkout_file, m.base.Release.checkout_file)
        self.assertEqual(m.Release.checkout_file, m.market.REMOTE+'/secrets/customer-kaspi-repeat.env')

if __name__ == '__main__': unittest.main()
