import copy
import importlib.util
import inspect
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('kiosk_menu_release',ROOT/'infra/staging/release-kiosk-menu.py')
r=importlib.util.module_from_spec(spec);sys.modules[spec.name]=r;spec.loader.exec_module(r)


class KioskMenuRelease(unittest.TestCase):
    def test_gateway_exact_routes_methods_auth_and_existing_bytes(self):
        raw='site {\n\t@kiosk_enrollment_check {\n\t\tmethod POST\n\t}\n}\n'
        with patch.object(r,'GATEWAY_BASELINE',r.digest(raw.encode())):
            result=r.gateway_candidate(raw,r.digest(raw.encode()))
            block=result[result.index('\t@kiosk_menu_read {'):result.index('\t@kiosk_enrollment_check {')]
            self.assertEqual(result.replace(block,'',1),raw)
            self.assertIn('method GET',block);self.assertIn('method POST',block)
            self.assertIn('/v1/kiosk-checkout/sessions/end',block)
            self.assertIn('/v1/kiosk-checkout/catalog',block)
            self.assertNotIn('-Authorization',block);self.assertIn('-Cookie',block)
            for forbidden in ['quotes','orders','payment','path_regexp','*']:
                self.assertNotIn(forbidden,block)
            with self.assertRaises(r.market.GuardFailure):r.gateway_candidate(result,r.digest(raw.encode()))
        with self.assertRaises(r.market.GuardFailure):r.gateway_candidate(raw,'0'*64)

    def test_no_migrations_seeds_bank_authority_or_new_environment(self):
        program=r.owner_grants_program()
        for forbidden in ['migrate(','INSERT INTO','DELETE','kaspi_worker','commerce_orders']:
            self.assertNotIn(forbidden,program)
        self.assertIn('UPDATE(ended_at)',r.GRANTS)
        self.assertNotIn('GRANT UPDATE ON',r.GRANTS)
        raw='exact installed compose'
        with patch.object(r,'COMPOSE_BASELINE',r.digest(raw.encode())):
            self.assertEqual(r.compose_candidate(raw,{}),raw)
            with self.assertRaises(r.market.GuardFailure):r.compose_candidate(raw,{'KEY':'new'})
        self.assertEqual(r.qr.MIGRATION_HASHES,{})
        self.assertIs(r.Release.prepare,r.qr.Release.prepare)
        self.assertIs(r.Release.backup_restore,r.qr.Release.backup_restore)
        self.assertIs(r.Release.rollback_closed,r.qr.Release.rollback_closed)

    def test_exact_baseline_gap041_and_original_manifest(self):
        obj=object.__new__(r.Release)
        names=[f'{n:03d}_synthetic.sql' for n in list(range(1,41))+[42,43,44]]
        obj.git=lambda *args:'\n'.join('db/cloud/migrations/'+n for n in names)
        self.assertEqual(len(obj.baseline_migrations()),43)
        self.assertEqual(obj.web_manifest_source(),r.PUBLIC_MANIFEST_SOURCE)
        names.append('045_unknown.sql')
        with self.assertRaises(r.market.GuardFailure):obj.baseline_migrations()

    def test_exact_session_acl_rejects_bank_and_phone_mutation(self):
        obj=object.__new__(r.Release)
        before={'ledger':[],'acl':[],'worker_acl':[]}
        obj.expected_ledger=lambda:[];obj.ledger=lambda:[];obj.compare_runtime=lambda before:None;obj.worker_acl=lambda:[]
        rows=[{'name':'kiosk_sessions','kind':'r','column':None,'privilege':'SELECT','grantable':False}]
        rows += [{'name':'kiosk_sessions','kind':'r','column':c,'privilege':'INSERT','grantable':False} for c in r.INSERT_COLUMNS]
        rows += [{'name':'kiosk_sessions','kind':'r','column':'ended_at','privilege':'UPDATE','grantable':False}]
        obj.acl=lambda:rows;obj.verify_data(before)
        for bad in [{'name':'kiosk_sessions','kind':'r','column':'phone_ciphertext','privilege':'UPDATE','grantable':False},
                    {'name':'commerce_orders','kind':'r','column':None,'privilege':'INSERT','grantable':False}]:
            obj.acl=lambda:rows+[bad]
            with self.assertRaises(r.market.GuardFailure):obj.verify_data(before)
        obj.acl=lambda:rows[:-1]
        with self.assertRaises(r.market.GuardFailure):obj.verify_data(before)

    def test_inherited_apply_retains_backup_maintenance_compatibility_cas_and_rollback(self):
        source=inspect.getsource(r.qr.Release.apply)
        self.assertLess(source.index('self.backup_restore('),source.index('owner_migration_program()'))
        self.assertLess(source.index('owner_migration_program()'),source.index("market.api_compose(BASELINE)+' up"))
        self.assertLess(source.index('self.verify_data(before)'),source.index('self.switch('))
        self.assertIn("self.cleanup('acquire')",source);self.assertIn("self.cleanup('release')",source)
        rollback=inspect.getsource(r.Release.rollback_closed)
        self.assertIn('acl_restore_sql',rollback);self.assertIn('retained_rollback_snapshot',rollback)
        self.assertNotIn('pg_restore',rollback)

    def test_rollback_preserves_schema_and_fails_closed_on_changed_money(self):
        obj=object.__new__(r.Release)
        before={'ledger':[],'runtime_data':{'tables':{'commerce_orders':{'rows':1,'sha256':'money'},'kiosk_sessions':{'rows':0,'sha256':'empty'}},'sequences':[]},'availability':[]}
        current=copy.deepcopy(before['runtime_data'])
        obj.ledger=lambda:[];obj.runtime_snapshot=lambda:current;obj.availability_rows=lambda:[]
        self.assertEqual(obj.retained_rollback_snapshot(before)[0],[])
        current['tables']['commerce_orders']['sha256']='changed'
        with self.assertRaises(r.market.GuardFailure):obj.retained_rollback_snapshot(before)

    def test_profile_requires_completed_immutable393_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory).resolve()
            proof={'sha':r.BASELINE,'image_id':'image','gateway_sha256':r.GATEWAY_BASELINE,'artifacts':{'revision':r.BASELINE,'image_id':'image'}}
            result={'source_sha':r.BASELINE,'migration_files':43,'last_migration':44,'qr_worker_enabled':False,'runtime_acl_verified':True}
            for name,data in [('prepared.json',proof),('result.json',result)]:
                path=folder/name;path.write_text(json.dumps(data));path.chmod(0o600)
            args=SimpleNamespace(expected_api_sha=r.BASELINE,expected_public_sha=r.BASELINE,expected_gateway_sha256=r.GATEWAY_BASELINE,enrollment_proof_dir=folder)
            with patch.object(r.sys,'version_info',(3,12)),patch.object(r.market.Release,'__init__') as init:
                obj=r.Release(args)
                profile=init.call_args.args[2]
                self.assertEqual(profile.old_api,r.BASELINE);self.assertEqual(profile.old_web,r.BASELINE)
                self.assertEqual(profile.baseline_count,43);self.assertEqual(profile.migrations,())
                self.assertEqual(obj.enrollment_environment,{})
            result['qr_worker_enabled']=True
            (folder/'result.json').write_text(json.dumps(result))
            with patch.object(r.sys,'version_info',(3,12)),self.assertRaises(r.market.GuardFailure):r.Release(args)

    def test_offline_apply_rehearses_backup_grants_compatibility_and_pointer_cas(self):
        with tempfile.TemporaryDirectory() as directory:
            obj=object.__new__(r.Release);obj.private=Path(directory).resolve();obj.sha='a'*40
            obj.installed_proof_hashes={};obj.baseline_schema=43;obj.environment_bytes=b'{}'
            obj.lock_owner={'id':'fixture'};identity=obj.private/'identity';identity.write_text('fixture');identity.chmod(0o600)
            obj.args=SimpleNamespace(backup_identity=identity)
            artifact={'rollback_image_id':'oldimage'}
            proof={'sha':obj.sha,'old_api':r.BASELINE,'old_web':r.BASELINE,'baseline_schema':43,
                'installed393_proof':{},'public_manifest':{},'artifacts':artifact,'rollback_files':{},
                'baseline_environment':{},'enrollment_environment_sha256':r.digest(b'{}'),
                'image_id':'newimage','gateway_sha256':'b'*64}
            path=obj.private/'prepared.json';path.write_text(json.dumps(proof));path.chmod(0o600)
            calls=[];state={'image':'oldimage'}
            for name in ['source_checks','ci','runtime_old','quiescent','verify_public']:
                setattr(obj,name,lambda name=name:calls.append(name))
            obj.prepared_artifacts=lambda manifest:artifact;obj.rollback_artifacts=lambda:{}
            obj.runtime_environment=lambda:{};obj.cleanup=lambda action:calls.append('cleanup:'+action)
            obj.http=lambda *args,**kwargs:(503,b'');obj.http_json=lambda *args,**kwargs:{'ready':True}
            obj.snapshot=lambda:{'tables':{},'sequences':[]};obj.runtime_snapshot=obj.snapshot
            for name in ['availability_rows','acl','worker_acl','audit_rows']:
                setattr(obj,name,lambda:[])
            obj.fingerprint=lambda:{}
            name=sorted((ROOT/'db/cloud/migrations').glob('*.sql'))[0].name
            obj.baseline_migrations=lambda:[name]
            obj.ledger=lambda:[{'version':name,'scope':'cloud','checksum':r.digest((ROOT/'db/cloud/migrations'/name).read_bytes())}]
            obj.psql=lambda *args:'0';obj.save=lambda name,value:calls.append('save:'+name)
            obj.backup_restore=lambda data:calls.append('backup_restore') or {'restore':'passed'}
            obj.verify_data=lambda before:calls.append('verify_data');obj.verify_environment=lambda before:None
            obj.verify_capabilities=lambda caps:None;obj.switch=lambda *args:calls.append('pointer_cas')
            def remote(command,**kwargs):
                if 'await transaction(pool' in command:
                    self.assertNotIn('migrate(',command);calls.append('grants')
                if ' up -d ' in command and ' api' in command:
                    state['image']='newimage' if obj.sha in command else 'oldimage';calls.append('api:'+state['image'])
                if '{{.Image}}' in command:return state['image']
                if '{{json .Mounts}}' in command:
                    public=f'{r.REMOTE}/public-https/releases/{obj.sha}/infra/public-staging'
                    return json.dumps([{'Destination':'/etc/caddy/Caddyfile','Source':public+'/gateway.Caddyfile'},{'Destination':'/srv/public','Source':public+'/public-web'}])
                if 'sha256sum /etc/caddy/Caddyfile' in command:return 'b'*64+' file'
                return ''
            obj.remote=remote;obj.apply()
            self.assertLess(calls.index('backup_restore'),calls.index('grants'))
            self.assertLess(calls.index('grants'),calls.index('api:oldimage'))
            self.assertLess(calls.index('api:oldimage'),calls.index('api:newimage'))
            self.assertLess(calls.index('api:newimage'),calls.index('pointer_cas'))
            self.assertIn('cleanup:release',calls);self.assertEqual(obj.phase,'complete')


if __name__=='__main__':unittest.main()
