import importlib.util
from pathlib import Path
import sys
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('mobile_stops_release',ROOT/'infra/staging/release-mobile-stops.py')
r=importlib.util.module_from_spec(spec);sys.modules[spec.name]=r;spec.loader.exec_module(r)
class StopsRelease(unittest.TestCase):
 def test_gateway_only_adds_read_only_availability(self):
  old="path('/v1/customer-checkout/config', '/v1/customer-checkout/orders')"
  result=r.Release.gateway_candidate(None,old)
  self.assertEqual(result,"path('/v1/customer-checkout/config', '/v1/customer-checkout/orders', '/v1/customer-checkout/availability')")
  for text in ['',old+old,result]:
   with self.assertRaises(r.market.GuardFailure):r.Release.gateway_candidate(None,text)
 def test_schema_and_preservation(self):
  self.assertEqual(r.MIGRATION,'030_cloud_branch_availability.sql')
  self.assertEqual(r.Release.snapshot,r.market.Release.snapshot)
  self.assertEqual(r.Release.prepare_api,r.base.Release.prepare_api)
if __name__=='__main__':unittest.main()
