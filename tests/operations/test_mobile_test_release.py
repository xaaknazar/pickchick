import importlib.util
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('mobile_release',ROOT/'infra/staging/release-mobile-test.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class ReleaseGuards(unittest.TestCase):
 def test_routes_preserve_every_existing_byte_except_explicit_path_append(self):
  text=(ROOT/'infra/public-staging/gateway.Caddyfile').read_text().replace(' '+r.TEST_PATHS,'')
  live='# kitchen and roadmap preserved\n'+text+'\n# private overlays\n'
  output=r.extend_gateway(live)
  self.assertEqual(output.replace(' '+r.TEST_PATHS,''),live)
  overlay=live.replace('path /kiosk /kitchen/prep /kitchen/assembly /display /manager','path /kiosk /manager')
  self.assertEqual(r.extend_gateway(overlay).replace(' '+r.TEST_PATHS,''),overlay)
  with self.assertRaises(r.market.GuardFailure):r.extend_gateway(output)
  with self.assertRaises(r.market.GuardFailure):r.extend_gateway(live+live)
 def test_only_test_and_catalog_are_enabled(self):
  p=r.profile('a'*40);settings=dict(p.settings)
  self.assertEqual([k for k,v in settings.items() if v=='true'],['TEST_ORDER_FLOW_ENABLED','CATALOG_ADMIN_ENABLED'])
  self.assertEqual(p.baseline_count,14)
  self.assertEqual(p.migrations[-1],'019_cloud_unpaid_test_orders.sql')
  self.assertEqual(p.ci_jobs,r.market.TRANSPORT_PROFILE.ci_jobs)
 def test_baseline_normalization_only_has_inert_defaults(self):
  self.assertEqual(r.ADDITIONS,{'devices':{'pos_sync_lock_anchor':False},'device_credentials':{'pos_sync_lock_anchor':False},'test_orders':{'execution_mode':'simulated_payment'}})
if __name__=='__main__':unittest.main()
