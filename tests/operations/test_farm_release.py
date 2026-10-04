import builtins
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import symtable
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('farm_release', ROOT/'infra/staging/release-farm-pilot.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)

class FarmRelease(unittest.TestCase):
    def test_exact_installed_baselines_migrations_and_full_ci(self):
        args = SimpleNamespace(expected_api_sha=r.BASELINE,expected_public_sha=r.PUBLIC_BASELINE,expected_gateway_sha256=r.GATEWAY_BASELINE)
        with patch.object(r.market.Release,'__init__') as init: r.Release(args)
        profile = init.call_args.args[2]
        self.assertEqual(profile.baseline_count,33)
        self.assertEqual(profile.migrations,tuple(r.MIGRATION_HASHES))
        self.assertEqual(len(profile.ci_jobs),11)
        self.assertTrue(profile.exact_ci_jobs)
        self.assertEqual(profile.settings,())
        for field in vars(args):
            bad = copy.copy(args); setattr(bad,field,'0'*len(getattr(args,field)))
            with self.assertRaises(r.market.GuardFailure): r.Release(bad)

    def test_schema38_baseline_has_no_pending_migrations(self):
        args = SimpleNamespace(expected_api_sha=r.BASELINE,expected_public_sha=r.PUBLIC_BASELINE,expected_gateway_sha256=r.GATEWAY_BASELINE,baseline_schema=38)
        with patch.object(r.market.Release,'__init__') as init: r.Release(args)
        self.assertEqual(init.call_args.args[2].baseline_count,38)
        self.assertEqual(init.call_args.args[2].migrations,())

    def test_availability_only_accepts_paired_monotonic_heartbeat(self):
        old = [{'branch_id':'branch','device_id':'device','revision':10,'stopped_ids':['stop'],'observed_at':'2026-10-04T15:00:00+00:00'}]
        r.verify_availability(old,copy.deepcopy(old))
        good = copy.deepcopy(old); good[0].update(revision=11,observed_at='2026-10-04T15:00:01+00:00')
        r.verify_availability(old,good)
        cases = [[],good+[{**good[0],'branch_id':'other'}]]
        for field,value in [('device_id','foreign'),('stopped_ids',[]),('revision',9),('observed_at','2026-10-04T14:59:59+00:00'),('extra','mutation')]:
            bad = copy.deepcopy(good); bad[0][field] = value; cases.append(bad)
        unpaired = copy.deepcopy(old); unpaired[0]['revision']=11; cases.append(unpaired)
        for bad in cases:
            with self.assertRaises(r.market.GuardFailure): r.verify_availability(old,bad)

    def test_runtime_snapshot_preserves_backup_hash_and_other_mutation_guards(self):
        obj = object.__new__(r.Release)
        seen = []
        obj.snapshot = lambda *args: seen.append(copy.deepcopy(obj.additions)) or {'tables':{},'sequences':[]}
        obj.runtime_snapshot(); obj.snapshot()
        self.assertEqual(seen[0]['cloud_branch_availability'],['revision','observed_at'])
        self.assertNotIn('cloud_branch_availability',seen[1])
        obj.availability_rows = lambda:[]
        obj.runtime_snapshot = lambda:{'tables':{'orders':{'rows':1,'sha256':'changed'}},'sequences':[]}
        before = {'availability':[],'runtime_data':{'tables':{'orders':{'rows':1,'sha256':'old'}},'sequences':[]}}
        with self.assertRaises(r.market.GuardFailure):obj.compare_runtime(before)

    def test_schema38_runtime_existing_empty_tables_are_not_new_again(self):
        obj = object.__new__(r.Release)
        snapshot = {'tables':{name:{'rows':0,'sha256':'empty'} for name in r.NEW_TABLES},'sequences':[]}
        obj.runtime_snapshot=lambda:copy.deepcopy(snapshot)
        obj.availability_rows=lambda:[]
        obj.compare_runtime({'availability':[],'runtime_data':snapshot})

    def test_schema38_runs_parent_source_guards_against_only_original033(self):
        obj = object.__new__(r.Release); obj.sha='a'*40; obj.baseline_schema=38
        obj.args=SimpleNamespace(branch='codex/farm-testflight')
        obj.profile=r.market.ReleaseProfile('farm',r.BASELINE,r.PUBLIC_BASELINE,38,(),r.CI_JOBS,frozenset(),'farm-pilot-release',(),exact_ci_jobs=True)
        original_profile=obj.profile
        files=sorted(path.name for path in (ROOT/'db/cloud/migrations').glob('*.sql'))
        original=[name for name in files if int(name[:3])<=33]
        shows=[]
        def git(*args):
            if args[0]=='rev-parse':return obj.sha
            if args[0]=='status':return ''
            if args[0]=='ls-remote':return obj.sha+' refs/heads/codex/farm-testflight'
            if args[0]=='ls-tree':return '\n'.join('db/cloud/migrations/'+name for name in original)
            raise AssertionError(args)
        def execute(args):
            if args[0]=='node':return r.FARM_GRANTS.encode()
            self.assertEqual(args[:2],['git','show'])
            name=args[2].split('/')[-1]
            self.assertIn(name,original,'Migration missing in old API tree')
            shows.append(name)
            return (ROOT/'db/cloud/migrations'/name).read_bytes()
        obj.git=git; obj.execute=execute
        obj.source_checks()
        self.assertEqual(shows,original)
        self.assertIs(obj.profile,original_profile)
        self.assertEqual(obj.baseline_schema,38)
        self.assertEqual(obj.baseline_migrations(),files)

    def test_compose_changes_only_api_farm_flag_and_preserves_owner_service(self):
        text = 'name: staging\nservices:\n  api:\n    env_file: [/protected/auth, /protected/checkout]\n    environment:\n      CUSTOMER_AUTH_ENABLED: "true"\n      APP_ENV: staging\n      BACKOFFICE_ENABLED: "true"\n  provision:\n    environment:\n      APP_ENV: staging\n'
        with patch.object(r,'COMPOSE_BASELINE',r.digest(text.encode())):
            candidate = r.compose_candidate(text)
        self.assertEqual(candidate.replace('      FARM_ENABLED: "1"\n','',1),text)
        self.assertNotIn('FARM_ENABLED',candidate[candidate.index('  provision:\n'):])
        for bad in [text+'\n',text.replace('  api:\n','  other:\n'),text.replace('  provision:\n','  other:\n'),text.replace('      APP_ENV: staging','      FARM_ENABLED: "0"\n      APP_ENV: staging',1)]:
            with self.assertRaises(r.market.GuardFailure): r.compose_candidate(bad)

    def test_gateway_exact_routes_preserve_all_existing_bytes_cors_and_authorization(self):
        old = '\t@synthetic_surfaces {\n\t\tnot path /v1/auth/* /v1/customer-checkout/*\n\t}\n\t@catalog_admin_get {\n\t\tmethod GET\n\t}\nexisting CORS/proxy handler\n'
        block = r.farm_gateway_block()
        with patch.object(r,'GATEWAY_BASELINE',r.digest(old.encode())):
            candidate = r.gateway_candidate(old)
            self.assertEqual(candidate.replace(block,'',1).replace(r.FARM_PATHS,'',1),old)
            with self.assertRaises(r.market.GuardFailure): r.gateway_candidate(candidate)
        self.assertEqual(block.count('header_up -Cookie'),2)
        self.assertEqual(block.count('header_up -X-Device-Id'),2)
        self.assertNotIn('header_up -Authorization',block)
        self.assertNotIn('path_regexp',block)
        self.assertNotIn('/v1/customer-farm/*',block)
        self.assertIn('method OPTIONS',block)
        self.assertIn('Access-Control-Allow-Headers Authorization,Content-Type',block)
        self.assertIn('max_size 16KB',(ROOT/'infra/public-staging/gateway.Caddyfile').read_text())
        for bad in [old.replace('@catalog_admin_get','@unknown'),old.replace('@synthetic_surfaces','@unknown'),old+'@farm_get\n']:
            with patch.object(r,'GATEWAY_BASELINE',r.digest(bad.encode())):
                with self.assertRaises(r.market.GuardFailure): r.gateway_candidate(bad)

    def test_manifest_preserves_every_metadata_and_file(self):
        before = {'source_sha':r.BASELINE,'files':{'roadmap/index.html':'hash','legal/privacy.html':'hash','backoffice/app.js':'hash'},'component_sources':{'backoffice':r.BASELINE}}
        r.verify_manifest(before,copy.deepcopy(before))
        for key in ['source_sha','files','component_sources']:
            bad = copy.deepcopy(before); bad[key] = {}
            with self.assertRaises(r.market.GuardFailure): r.verify_manifest(before,bad)

    def test_grants_exact_helper_and_only_reviewed_tables_columns(self):
        output = subprocess.run(['node','--input-type=module','-e',"import {farmGrants} from './infra/staging/farm-grants.mjs';process.stdout.write(farmGrants('pickchick_app',true))"],cwd=ROOT,capture_output=True,text=True,check=True).stdout
        self.assertEqual(output,r.FARM_GRANTS)
        before = [{'name':'identity_customers','kind':'r','column':'id','privilege':'UPDATE','grantable':False},{'name':'commerce_orders','kind':'r','column':None,'privilege':'SELECT','grantable':False}]
        added = [{'name':name,'kind':'r','column':None,'privilege':p,'grantable':False} for name, privileges in [('customer_farms',['SELECT','INSERT','UPDATE']),('customer_farm_commands',['SELECT','INSERT'])] for p in privileges]
        added += [{'name':'identity_customers','kind':'r','column':col,'privilege':'SELECT','grantable':False} for col in ['id','deleted_at']]
        after = before+added
        r.verify_farm_acl(before,after)
        for bad in [after[:-1],after+[{'name':'kiosk_sessions','kind':'r','column':None,'privilege':'INSERT','grantable':False}],after+[{'name':'customer_farms','kind':'r','column':None,'privilege':'DELETE','grantable':False}],after[1:]]:
            with self.assertRaises(r.market.GuardFailure): r.verify_farm_acl(before,bad)

    def test_reviewed_prerequisite_hashes_and_owner_program_excludes_full_provision(self):
        for name,checksum in r.MIGRATION_HASHES.items(): self.assertEqual(r.digest((ROOT/'db/cloud/migrations'/name).read_bytes()),checksum)
        program = r.owner_migration_program()
        self.assertIn("url.username!=='pickchick_owner'",program)
        self.assertIn("await migrate(pool,'/app/db/cloud/migrations','cloud')",program)
        self.assertIn("farmGrants('pickchick_app',true)",program)
        self.assertNotIn('provision.mjs',program)
        self.assertNotIn('ALTER ROLE',program)
        self.assertEqual(r.Release.additions,{'branches':['menu_publication_lock_anchor']})

    def test_running_environment_ignores_only_farm_and_release_revision(self):
        obj = object.__new__(r.Release)
        before = {'CUSTOMER_AUTH_ENABLED':'a','KASPI_REMOTE_ENABLED':'b','SECRET':'secret-hash','RELEASE_SHA':'old'}
        after = {**before,'FARM_ENABLED':r.digest(b'1'),'RELEASE_SHA':'new'}
        obj.runtime_environment = lambda:after
        obj.verify_environment(before)
        after['SECRET'] = 'changed'
        with self.assertRaises(r.market.GuardFailure): obj.verify_environment(before)
        after['SECRET'] = before['SECRET']; after['FARM_ENABLED'] = r.digest(b'0')
        with self.assertRaises(r.market.GuardFailure): obj.verify_environment(before)

    def test_failed_ci_cannot_prepare_or_apply(self):
        obj = object.__new__(r.Release); calls = []
        obj.source_checks = lambda:None
        obj.ci = lambda:r.require(False,'CI not green')
        obj.remote = lambda *args,**kwargs:calls.append(args)
        for action in ['prepare','apply']:
            with self.assertRaises(r.market.GuardFailure): getattr(obj,action)()
        self.assertEqual(calls,[])

    def test_module_has_no_unresolved_python_globals(self):
        table = symtable.symtable((ROOT/'infra/staging/release-farm-pilot.py').read_text(),'farm','exec')
        def check(scope):
            for symbol in scope.get_symbols():
                if symbol.is_global() and symbol.is_referenced(): self.assertTrue(symbol.get_name() in vars(r) or hasattr(builtins,symbol.get_name()),symbol.get_name())
            for child in scope.get_children(): check(child)
        check(table)

    def test_release_env_writer_preserves_flags_and_real_newlines(self):
        with tempfile.TemporaryDirectory() as directory:
            old,new = Path(directory)/'old',Path(directory)/'new'
            old.write_text('RELEASE_SHA='+r.BASELINE+'\nBACKOFFICE_ENABLED=true\nFARM_ENABLED=0\n')
            subprocess.run([sys.executable,'-c',r.release_env_program(),str(old),str(new),'a'*40,r.BASELINE],check=True)
            self.assertEqual(new.read_text(),'BACKOFFICE_ENABLED=true\nFARM_ENABLED=0\nRELEASE_SHA='+'a'*40+'\n')
            self.assertEqual(new.stat().st_mode & 0o777,0o600)

    def test_known_post_reopen_failure_recloses_maintenance_without_rollback(self):
        obj = object.__new__(r.Release); obj.sha = 'a'*40; obj.phase = 'reopened'; obj.maintenance = '/owned/maintenance'
        calls = []; saved = {}
        obj.cleanup = lambda action:calls.append(action)
        obj.remote = lambda command,**kwargs:calls.append(command)
        obj.http = lambda *args,**kwargs:(503,b'')
        obj.save = lambda name,value:saved.update({name:value})
        self.assertEqual(obj.retain_failure(r.market.GuardFailure('probe failed')),'closed')
        self.assertTrue(saved['failure-context.json']['maintenance_reclosed'])
        self.assertFalse(saved['failure-context.json']['automatic_rollback_started'])
        self.assertTrue(any('-f /owned/maintenance/compose.json' in item for item in calls))
        calls.clear()
        self.assertEqual(obj.retain_failure(r.market.CommandUncertain('unknown completion')),'unknown')
        self.assertEqual(calls,[])

    def test_rollback_post_reopen_failure_recloses_old_gateway(self):
        obj = object.__new__(r.Release); obj.sha = 'a'*40; obj.maintenance = '/owned/maintenance'
        for phase in ['rollback_reopening','rollback_reopened']:
            obj.phase = phase; calls = []; saved = {}
            obj.cleanup = lambda action:calls.append(action)
            obj.remote = lambda command,**kwargs:calls.append(command)
            obj.http = lambda *args,**kwargs:(503,b'')
            obj.save = lambda name,value:saved.update({name:value})
            self.assertEqual(obj.retain_failure(r.market.GuardFailure('rollback probe failed')),'closed')
            self.assertTrue(saved['failure-context.json']['maintenance_reclosed'])
            self.assertTrue(any(r.market.web_compose(r.PUBLIC_BASELINE)+' -f /owned/maintenance/compose.json' in c for c in calls))
            self.assertFalse(any(r.market.web_compose(obj.sha) in c for c in calls))
            calls.clear()
            self.assertEqual(obj.retain_failure(r.market.CommandUncertain('unknown rollback completion')),'unknown')
            self.assertEqual(calls,[])

    def test_explicit_rollback_reuses_only_verified_original_owner(self):
        import uuid
        with tempfile.TemporaryDirectory() as directory:
            obj = object.__new__(r.Release); obj.private = Path(directory); obj.sha = 'a'*40
            owner_id = str(uuid.uuid4()); obj.args = SimpleNamespace(owner_id=owner_id)
            owner = {'id':owner_id,'sha':obj.sha,'action':'apply'}
            path = obj.private/('lock-owner-'+owner_id+'.json'); path.write_text(json.dumps(owner)); path.chmod(0o600)
            (obj.private/'prepared.json').write_text(json.dumps({'sha':obj.sha,'old_api':r.BASELINE,'old_web':r.PUBLIC_BASELINE,'rollback_files':{}}))
            calls = []
            obj.remote = lambda command,**kwargs:calls.append(command) or (json.dumps(owner) if command.startswith('cat ') else '')
            obj.cleanup = lambda action:calls.append('cleanup:'+action)
            obj.source_checks = lambda:None; obj.ci = lambda:None; obj.rollback_artifacts = lambda:{}
            obj.http = lambda *args,**kwargs:(503,b''); obj.rollback_closed = lambda:calls.append('rollback')
            obj.resume_owned_rollback()
            self.assertEqual(obj.lock_owner,owner)
            self.assertLess(next(i for i,c in enumerate(calls) if 'compose.json' in c),calls.index('rollback'))
            self.assertNotIn('mkdir',calls[-1])
            calls.clear()
            obj.remote = lambda command,**kwargs:calls.append(command) or json.dumps({**owner,'id':str(uuid.uuid4())})
            with self.assertRaises(r.market.GuardFailure):obj.resume_owned_rollback()
            self.assertEqual(len(calls),1)

    def test_apply_orders_backup_migrations_old_compatibility_and_switch(self):
        with tempfile.TemporaryDirectory() as directory:
            obj = object.__new__(r.Release); obj.private = Path(directory); obj.sha = 'a'*40
            key = obj.private/'key'; key.write_text('synthetic'); key.chmod(0o600)
            obj.baseline_schema=33; obj.args = SimpleNamespace(backup_identity=key); obj.lock_owner = {'id':'owner'}
            proof = {'sha':obj.sha,'old_api':r.BASELINE,'old_web':r.PUBLIC_BASELINE,'public_manifest':{'files':{}},'artifacts':{},'rollback_files':{},'baseline_environment':{},'image_id':'image','gateway_sha256':'gateway'}
            (obj.private/'prepared.json').write_text(json.dumps(proof))
            calls = []; checks = []; saved = {}
            new = f'{r.REMOTE}/public-https/releases/{obj.sha}/infra/public-staging'
            def remote(command,**kwargs):
                calls.append(command)
                if '{{json .Mounts}}' in command: return json.dumps([{'Destination':'/etc/caddy/Caddyfile','Source':new+'/gateway.Caddyfile'},{'Destination':'/srv/public','Source':new+'/public-web'}])
                if '{{.Image}}' in command:return 'image'
                if 'sha256sum /etc/caddy/Caddyfile' in command:return 'gateway file'
                return ''
            obj.remote = remote; obj.psql = lambda *args:'0'
            obj.http = lambda *args,**kwargs:(503,b''); obj.http_json = lambda *args,**kwargs:{'ready':True}
            for name in ['source_checks','ci','runtime_old','quiescent']: setattr(obj,name,lambda:None)
            obj.prepared_artifacts = lambda m:{}; obj.rollback_artifacts = lambda:{}; obj.runtime_environment = lambda:{}
            obj.verify_environment = lambda before:checks.append('environment'); obj.verify_capabilities = lambda caps:None
            obj.runtime_snapshot=lambda:{}; obj.availability_rows=lambda:[]
            obj.cleanup = lambda action:checks.append('cleanup:'+action); obj.snapshot = lambda:{}; obj.ledger = lambda:[]; obj.acl = lambda:[]
            obj.worker_acl = lambda:[]; obj.fingerprint = lambda:{'worker':'unchanged'}; obj.baseline_migrations = lambda:[]
            obj.backup_restore = lambda before:checks.append('backup') or {'restore':'passed'}
            obj.verify_data = lambda before:checks.append('data'); obj.verify_public = lambda:checks.append('public')
            obj.switch = lambda *args:checks.append('switch'); obj.save = lambda name,value:saved.update({name:value})
            obj.apply()
            owner_commands = [c for c in calls if '--entrypoint node provision' in c]
            self.assertEqual(len(owner_commands),2)
            self.assertTrue(all('--entrypoint node provision' in c for c in owner_commands))
            self.assertTrue(all("provision.mjs" not in c for c in owner_commands))
            self.assertLess(checks.index('backup'),checks.index('data'))
            self.assertEqual(checks.count('data'),4)
            self.assertEqual(checks.count('switch'),2)
            self.assertEqual(checks[-1],'cleanup:release')
            self.assertTrue(saved['result.json']['worker_preserved'])
            self.assertFalse(any('worker' in c or ' down' in c or 'pg_restore' in c for c in calls))

if __name__ == '__main__': unittest.main()
