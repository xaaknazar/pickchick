import copy
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('director_release',ROOT/'infra/staging/release-director-console.py')
r=importlib.util.module_from_spec(spec);sys.modules[spec.name]=r;spec.loader.exec_module(r)
class DirectorRelease(unittest.TestCase):
 def test_profile_exact_baselines_and_eleven_jobs(self):
  args=SimpleNamespace(expected_api_sha=r.BASELINE,expected_public_sha=r.PUBLIC_BASELINE,expected_gateway_sha256=r.GATEWAY_BASELINE)
  with patch.object(r.market.Release,'__init__') as init:r.Release(args)
  profile=init.call_args.args[2]
  self.assertEqual(len(profile.ci_jobs),11);self.assertTrue(profile.exact_ci_jobs)
  self.assertEqual(profile.baseline_count,32);self.assertEqual(profile.migrations,(r.MIGRATION,))
  self.assertEqual(dict(profile.settings),{'BACKOFFICE_ENABLED':'true','CATALOG_MOBILE_STOREFRONT_ENABLED':'false'})
  for field in vars(args):
   bad=copy.copy(args);setattr(bad,field,'0'*len(getattr(args,field)))
   with self.assertRaises(r.market.GuardFailure):r.Release(bad)
 def test_compose_preserves_all_existing_settings(self):
  text='  api:\n      APP_ENV: staging\n  provision:\n      APP_ENV: staging\n'
  with patch.object(r,'COMPOSE_BASELINE',r.digest(text.encode())):
   candidate=r.compose_candidate(text)
  self.assertEqual(candidate.replace('      CATALOG_MOBILE_STOREFRONT_ENABLED: "false"\n',''),text)
  with self.assertRaises(r.market.GuardFailure):r.compose_candidate(text)
 def test_public_manifest_preserves_non_bo(self):
  old={'files':{'operations/app.js':'x','legal/privacy.html':'y','backoffice/obsolete.js':'old'}}
  new={'source_sha':'a'*40,'component_sources':{'backoffice':'a'*40},'files':{'operations/app.js':'x','legal/privacy.html':'y','backoffice/app.js':'a','backoffice/operations.js':'b'}}
  r.verify_manifest(old,new,'a'*40)
  for name in ['operations/app.js','legal/privacy.html']:
   bad=copy.deepcopy(new);bad['files'][name]='changed'
   with self.assertRaises(r.market.GuardFailure):r.verify_manifest(old,bad,'a'*40)
 def test_acl_interpreter_exact_columns_and_rejections(self):
  before=[{'name':'bo_records','kind':'r','column':None,'privilege':'SELECT','grantable':False}]
  rows=r.expected_acl(before,'REVOKE ALL ON bo_records FROM pickchick_app;GRANT SELECT,INSERT ON bo_records TO pickchick_app;GRANT UPDATE(status) ON devices TO pickchick_app;')
  self.assertEqual(len(rows),3)
  self.assertIn({'name':'devices','kind':'r','column':'status','privilege':'UPDATE','grantable':False},rows)
  with self.assertRaises(r.market.GuardFailure):r.expected_acl(before,'ALTER ROLE pickchick_app SUPERUSER;')
 def test_failed_ci_cannot_prepare_or_apply(self):
  obj=object.__new__(r.Release);calls=[]
  obj.source_checks=lambda:None
  obj.ci=lambda: r.require(False,'CI not green')
  obj.remote=lambda *a,**k:calls.append(a)
  for action in ['prepare','apply']:
   with self.assertRaises(r.market.GuardFailure):getattr(obj,action)()
  self.assertEqual(calls,[])
if __name__=='__main__':unittest.main()
