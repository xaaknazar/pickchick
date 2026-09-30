import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('tested_all_kaspi', ROOT/'infra/staging/release-all-kaspi.py')
m = importlib.util.module_from_spec(spec); sys.modules[spec.name] = m; spec.loader.exec_module(m)


class AllVerifiedCustomers(unittest.TestCase):
    def env(self):
        return {k:'10000000-0000-4000-8000-000000000001' for k in m.owner.base.FIELDS} | {
            'CUSTOMER_KASPI_PILOT_MAX_MINOR':m.owner.MAX_MINOR,
            'CUSTOMER_KASPI_PILOT_REPEAT_ORDERS':'true',
            'CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE':m.APPROVAL,
            m.AUDIENCE:'true'}
    def raw(self, env): return '\n'.join(k+'='+v for k,v in env.items())+'\n'
    def test_explicit_audience_and_unchanged_bounded_policy(self):
        self.assertEqual(m.checkout_environment(self.raw(self.env())), self.env())
        for change in [{m.AUDIENCE:'false'}, {m.AUDIENCE:''},
                       {'CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE':'old-owner-only'},
                       {'CUSTOMER_KASPI_PILOT_MAX_MINOR':'999999999'},
                       {'CUSTOMER_KASPI_PILOT_REPEAT_ORDERS':'false'}, {'UNEXPECTED':'true'}]:
            with self.subTest(change=change), self.assertRaises(m.market.GuardFailure):
                m.checkout_environment(self.raw(self.env() | change))
        with self.assertRaises(m.market.GuardFailure):
            m.checkout_environment(self.raw(self.env())+m.AUDIENCE+'=true\n')
    def test_separate_immutable_environment_preserves_owner_rollback(self):
        self.assertNotEqual(m.Release.checkout_file, m.owner.Release.checkout_file)
        self.assertNotEqual(m.Release.checkout_file, m.MobileRelease.checkout_file)
        self.assertEqual(m.Release.checkout_file, m.market.REMOTE+'/secrets/customer-kaspi-all.env')


if __name__ == '__main__': unittest.main()
