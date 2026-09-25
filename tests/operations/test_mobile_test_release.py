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
 def test_recipe_grants_preserve_every_old_permission_and_reject_extras(self):
  old=[{'name':'test_orders','kind':'r','column':None,'privilege':'SELECT','grantable':False}]
  r.verify_runtime_acl(old,old+r.RECIPE_ACL)
  for bad in [old, r.RECIPE_ACL, old+r.RECIPE_ACL+[{'name':'bo_records','kind':'r','column':None,'privilege':'UPDATE','grantable':False}]]:
   with self.assertRaises(r.market.GuardFailure):r.verify_runtime_acl(old,bad)
 def test_relocates_only_two_read_only_public_mounts_without_mutating_input(self):
  old='/old/infra/public-staging';new='/new/infra/public-staging'
  config={'networks':{'keep':{'external':True}},'services':{'gateway':{'image':'pinned','volumes':[
   {'type':'bind','source':old+'/gateway.Caddyfile','target':'/etc/caddy/Caddyfile','read_only':True},
   {'type':'bind','source':old+'/public-web','target':'/srv/public','read_only':True}]}}}
  result=r.relocate_public_mounts(config,old,new)
  self.assertEqual(config['services']['gateway']['volumes'][0]['source'],old+'/gateway.Caddyfile')
  self.assertEqual(result['services']['gateway']['volumes'][0]['source'],new+'/gateway.Caddyfile')
  self.assertEqual(result['services']['gateway']['volumes'][1]['source'],new+'/public-web')
  for v in result['services']['gateway']['volumes']:v['source']=v['source'].replace(new,old)
  self.assertEqual(result,config)
  config['services']['gateway']['volumes'][0]['read_only']=False
  with self.assertRaises(r.market.GuardFailure):r.relocate_public_mounts(config,old,new)
  config['services']['gateway']['volumes'][0]['read_only']=True
  config['services']['gateway']['volumes'][0]['source']='/unrelated/Caddyfile'
  with self.assertRaises(r.market.GuardFailure):r.relocate_public_mounts(config,old,new)
 def test_baseline_normalization_only_has_inert_defaults(self):
  self.assertEqual(r.ADDITIONS,{'devices':{'pos_sync_lock_anchor':False},'device_credentials':{'pos_sync_lock_anchor':False},'test_orders':{'execution_mode':'simulated_payment'}})
if __name__=='__main__':unittest.main()
