import importlib.util
from pathlib import Path
import sys
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('daily_number_release',ROOT/'infra/staging/release-daily-numbers.py')
r=importlib.util.module_from_spec(spec);sys.modules[spec.name]=r;spec.loader.exec_module(r)
class DailyNumberReleaseGuards(unittest.TestCase):
 def test_runtime_only_gains_read_access_to_two_number_tables(self):
  old=[{'name':'test_orders','kind':'r','column':None,'privilege':'SELECT','grantable':False}]
  r.verify_number_acl(old,old+r.NUMBER_ACL)
  for bad in [old,r.NUMBER_ACL,old+r.NUMBER_ACL+[{'name':'test_order_day_counters','kind':'r','column':None,'privilege':'UPDATE','grantable':False}]]:
   with self.assertRaises(r.market.GuardFailure):r.verify_number_acl(old,bad)
 def test_scope_preserves_existing_gateway_and_uses_single_additive_migration(self):
  self.assertEqual(r.MIGRATION,'020_cloud_daily_test_numbers.sql')
  self.assertEqual(r.NUMBER_TABLES,{'test_order_numbers','test_order_day_counters'})
  self.assertEqual(r.Release.snapshot,r.market.Release.snapshot)
  self.assertEqual(r.Release.prepared_artifacts,r.market.Release.prepared_artifacts)
if __name__=='__main__':unittest.main()
