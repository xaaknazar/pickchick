import builtins
import symtable
import tempfile
import json
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
 def test_module_has_no_unresolved_python_globals(self):
  table=symtable.symtable((ROOT/'infra/staging/release-director-console.py').read_text(),'director','exec')
  def check(scope):
   for symbol in scope.get_symbols():
    if symbol.is_global() and symbol.is_referenced():
     self.assertTrue(symbol.get_name() in vars(r) or hasattr(builtins,symbol.get_name()),symbol.get_name())
   for child in scope.get_children():check(child)
  check(table)
 def test_prepare_executes_all_phases_with_checked_relocation(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory); dist=root/'apps/backoffice/dist';dist.mkdir(parents=True)
   for name in ['app.js','operations.js']:(dist/name).write_text('bundle')
   obj=object.__new__(r.Release);obj.sha='a'*40;obj.private=root/'private';obj.private.mkdir()
   obj.profile=SimpleNamespace(old_web=r.PUBLIC_BASELINE,old_api=r.BASELINE,settings=(('BACKOFFICE_ENABLED','true'),))
   gateway='reviewed gateway\n';obj.args=SimpleNamespace(expected_gateway_sha256=r.digest(gateway.encode()))
   old=f'{r.REMOTE}/public-https/releases/{r.PUBLIC_BASELINE}/infra/public-staging'
   new=f'{r.REMOTE}/public-https/releases/{obj.sha}/infra/public-staging'
   compose={'services':{'gateway':{'volumes':[{'type':'bind','source':old+'/gateway.Caddyfile','target':'/etc/caddy/Caddyfile','read_only':True},{'type':'bind','source':old+'/public-web','target':'/srv/public','read_only':True}]}}}
   previous={'files':{'operations/app.js':'old'}}
   manifest={'source_sha':obj.sha,'component_sources':{'backoffice':obj.sha},'files':{**previous['files'],'backoffice/app.js':'new','backoffice/operations.js':'new'}}
   calls=[];saved={}
   def remote(command,**kwargs):
    calls.append((command,kwargs))
    if command=='cat '+old+'/gateway.Caddyfile':return gateway.rstrip()
    if 'docker build -q' in command:return 'sha256:'+'b'*64
    if 'config --format json' in command:return json.dumps(compose)
    if command.startswith('cat ') and command.endswith('/public-web/.release.json'):return json.dumps(previous)
    if "hashlib" in command:return json.dumps(manifest)
    return ''
   obj.remote=remote;obj.execute=lambda *a,**k:b'archive'
   for name in ['source_checks','ci','runtime_old']:setattr(obj,name,lambda:None)
   obj.rollback_artifacts=lambda:{'old':'hash'};obj.prepare_api=lambda target:None
   obj.prepared_artifacts=lambda m:{'candidate':'hash'};obj.http_json=lambda *a,**k:{'baseline':True}
   obj.save=lambda name,data:saved.update({name:data})
   with patch.object(r.market,'REPO',root):obj.prepare()
   written=[json.loads(k['input']) for c,k in calls if c.endswith(new+'/compose.yaml')]
   self.assertEqual(written[0]['services']['gateway']['volumes'][1]['source'],new+'/public-web')
   self.assertEqual(saved['prepared.json']['public_manifest'],manifest)
   self.assertFalse(any(' up -d' in command or ' stop ' in command for command,_ in calls))
 def test_apply_executes_guarded_phases_and_preserves_neighbors(self):
  with tempfile.TemporaryDirectory() as directory:
   obj=object.__new__(r.Release);obj.private=Path(directory);obj.sha='a'*40
   obj.profile=SimpleNamespace(old_web=r.PUBLIC_BASELINE,old_api=r.BASELINE,baseline_count=32,migrations=(r.MIGRATION,))
   key=obj.private/'key';key.write_text('test fixture');key.chmod(0o600)
   obj.args=SimpleNamespace(backup_identity=key);obj.lock_owner={'id':'test-owner'}
   caps={'features':{'payments':False}};manifest={'files':{}}
   proof={'sha':obj.sha,'old_web':r.PUBLIC_BASELINE,'public_manifest':manifest,'artifacts':{},'rollback_files':{},'gateway_sha256':'gateway','baseline_capabilities':caps}
   (obj.private/'prepared.json').write_text(json.dumps(proof))
   calls=[];checks=[];saved={}
   new=f'{r.REMOTE}/public-https/releases/{obj.sha}/infra/public-staging'
   def remote(command,**kwargs):
    calls.append(command)
    if 'docker inspect --format' in command:return json.dumps([{'Destination':'/etc/caddy/Caddyfile','Source':new+'/gateway.Caddyfile'},{'Destination':'/srv/public','Source':new+'/public-web'}])
    if 'sha256sum /etc/caddy/Caddyfile' in command:return 'gateway file'
    return ''
   obj.remote=remote;obj.psql=lambda *a:'0';obj.http=lambda path,**kwargs:(503 if path=='/v1/test/orders' else 200,b'')
   obj.http_json=lambda path,**kwargs:{'ready':True} if path=='/health/ready' else caps
   for name in ['source_checks','ci','runtime_old']:setattr(obj,name,lambda:None)
   obj.prepared_artifacts=lambda m:{};obj.rollback_artifacts=lambda:{}
   obj.cleanup=lambda action:checks.append('cleanup:'+action);obj.snapshot=lambda:{};obj.ledger=lambda:[]
   obj.acl=lambda:[];obj.fingerprint=lambda:{'worker':'unchanged'};obj.baseline_migrations=lambda:[]
   obj.backup_restore=lambda data:checks.append('backup') or {'restored':True}
   obj.verify_data=lambda before:checks.append('data');obj.verify_public=lambda:checks.append('public')
   obj.switch=lambda *args:checks.append('switch');obj.save=lambda name,data:saved.update({name:data})
   obj.apply()
   self.assertEqual(checks.count('data'),3);self.assertLess(checks.index('backup'),checks.index('data'))
   self.assertEqual(checks.count('switch'),2);self.assertEqual(checks[-1],'cleanup:release')
   self.assertTrue(saved['result.json']['old_image_compatible'])
   self.assertFalse(any('worker' in c or 'down' in c for c in calls))
 def test_bank_work_blocks_quiescence_without_worker_mutation(self):
  obj=object.__new__(r.Release);obj.cleanup=lambda action:None;obj.http=lambda *a,**k:(503,b'')
  obj.psql=lambda *a:'1'
  with self.assertRaises(r.market.GuardFailure):obj.quiescent()
  obj.psql=lambda *a:'0';obj.quiescent()
 def test_failed_ci_cannot_prepare_or_apply(self):
  obj=object.__new__(r.Release);calls=[]
  obj.source_checks=lambda:None
  obj.ci=lambda: r.require(False,'CI not green')
  obj.remote=lambda *a,**k:calls.append(a)
  for action in ['prepare','apply']:
   with self.assertRaises(r.market.GuardFailure):getattr(obj,action)()
  self.assertEqual(calls,[])
if __name__=='__main__':unittest.main()
