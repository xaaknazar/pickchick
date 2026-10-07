import copy
import importlib.util
import inspect
import json
from pathlib import Path
import sys
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('kiosk_qr_release',ROOT/'infra/staging/release-kiosk-qr.py')
r=importlib.util.module_from_spec(spec);sys.modules[spec.name]=r;spec.loader.exec_module(r)

def environment():
    return {'KIOSK_CHECKOUT_ENABLED':'true','KIOSK_CHECKOUT_PAYMENT_METHOD':'kaspi_qr',
        'KIOSK_CHECKOUT_ORGANIZATION_ID':'10000000-0000-4000-a000-000000000001',
        'KIOSK_CHECKOUT_BRANCH_ID':'10000000-0000-4000-a000-000000000002',
        'KIOSK_KASPI_QR_ACCOUNT_ID':'10000000-0000-4000-a000-000000000003',
        'KIOSK_CHECKOUT_FISCAL_POLICY':'deferred_pilot','KIOSK_CHECKOUT_APPROVAL_REFERENCE':'Owner approved pilot without Webkassa',
        'KIOSK_CHECKOUT_TAX_CODE':'PENDING_PILOT','KIOSK_CHECKOUT_MAX_MINOR':'10000',
        'KIOSK_CHECKOUT_PII_KEY':'a'*64,'KIOSK_KASPI_QR_ENABLED':'false'}

class KioskEnrollmentRelease(unittest.TestCase):
    def test_profile_exact_baseline_and_authorized_deferred_pilot(self):
        self.assertEqual(r.BASELINE,'d6cd144cc7cba9943b614e2a33552111f3f1f44d')
        self.assertEqual(r.PUBLIC_BASELINE,r.BASELINE)
        self.assertEqual(list(r.MIGRATION_HASHES),['043_cloud_kiosk_kaspi_qr.sql','044_cloud_kiosk_enrollment.sql'])
        for name,checksum in r.MIGRATION_HASHES.items():self.assertEqual(r.digest((ROOT/'db/cloud/migrations'/name).read_bytes()),checksum)
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder).resolve();env=folder/'env.json';env.write_text(json.dumps(environment()));env.chmod(0o600)
            proof=folder/'finance.json';proof.write_text(json.dumps({'sha':r.BASELINE,'gateway_sha256':'b'*64,'artifacts':{'revision':r.BASELINE}}));proof.chmod(0o600)
            args=SimpleNamespace(expected_api_sha=r.BASELINE,expected_public_sha=r.BASELINE,expected_gateway_sha256='b'*64,environment=env,finance_proof=proof)
            with patch.object(r.sys,'version_info',(3,12)),patch.object(r.market.Release,'__init__') as init:
                r.Release(args)
            profile=init.call_args.args[2]
            self.assertEqual(profile.baseline_count,41);self.assertEqual(profile.migrations,tuple(r.MIGRATION_HASHES))
            self.assertTrue(profile.exact_ci_jobs);self.assertEqual(len(profile.ci_jobs),11)
            with patch.object(r.sys,'version_info',(3,12)):
                with self.assertRaises(r.market.GuardFailure):r.Release(SimpleNamespace(**{**vars(args),'expected_gateway_sha256':'c'*64}))

    def test_environment_worker_off_and_both_explicit_fiscal_modes(self):
        self.assertEqual(r.validate_environment(environment()),environment())
        required={**environment(),'KIOSK_CHECKOUT_FISCAL_POLICY':'required','KIOSK_CHECKOUT_FISCAL_ACCOUNT_ID':'10000000-0000-4000-a000-000000000004'}
        self.assertEqual(r.validate_environment(required),required)
        for change in [{'KIOSK_KASPI_QR_ENABLED':'true'},{'KIOSK_CHECKOUT_PAYMENT_METHOD':'kaspi_invoice'},
            {'KIOSK_CHECKOUT_FISCAL_POLICY':'required'},{'KASPI_SESSION_TOKEN_SN':'secret'},
            {'KIOSK_CHECKOUT_PII_KEY':'bad'},{'KIOSK_CHECKOUT_MAX_MINOR':'0'},
            {'KIOSK_CHECKOUT_APPROVAL_REFERENCE':'line\nbreak'},{'KIOSK_CHECKOUT_APPROVAL_REFERENCE':'$(command)'}]:
            with self.subTest(change=change),self.assertRaises(r.market.GuardFailure):r.validate_environment({**environment(),**change})

    def test_gateway_changes_only_enrollment_endpoint(self):
        raw=(ROOT/'infra/public-staging/gateway.Caddyfile').read_text()
        candidate=r.gateway_candidate(raw,r.digest(raw.encode()))
        block=candidate[candidate.index('\t# Enrollment only:'):candidate.index('\t@backoffice_get {')]
        self.assertEqual(candidate.replace(block,'',1),raw)
        for path in ['/v1/kiosk-checkout/orders','/v1/kiosk-checkout/quotes','/api/qr/create']:
            self.assertNotIn(path,candidate)
        self.assertIn('path /v1/kiosk-checkout/enrollment/check',candidate)
        with self.assertRaises(r.market.GuardFailure):r.gateway_candidate(candidate,r.digest(candidate.encode()))
        with self.assertRaises(r.market.GuardFailure):r.gateway_candidate(raw,'0'*64)

    def test_compose_injects_only_api_private_interpolation(self):
        raw='services:\n  api:\n    environment:\n      APP_ENV: staging\n  provision:\n    environment:\n      APP_ENV: staging\n'
        with patch.object(r,'COMPOSE_BASELINE',r.digest(raw.encode())):
            candidate=r.compose_candidate(raw,environment())
            self.assertEqual(candidate.split('  provision:\n')[1],raw.split('  provision:\n')[1])
            self.assertIn('KIOSK_CHECKOUT_PII_KEY: ${KIOSK_CHECKOUT_PII_KEY:',candidate)
            self.assertNotIn(environment()['KIOSK_CHECKOUT_PII_KEY'],candidate)
            injected=''.join('      '+key+': ${'+key+':?Private kiosk setting required}\n' for key in sorted(environment()))
            self.assertEqual(candidate.replace(injected,'',1),raw)
            with self.assertRaises(r.market.GuardFailure):r.compose_candidate(raw+'#drift',environment())

    def test_no_041_fabricated_and_existing_migrations_read_from_exact_baseline(self):
        obj=object.__new__(r.Release)
        names=sorted(p.name for p in (ROOT/'db/cloud/migrations').glob('*.sql') if int(p.name[:3])<=42)
        obj.git=lambda *args:'\n'.join('db/cloud/migrations/'+n for n in names)
        self.assertEqual(len(obj.baseline_migrations()),41)
        names.append('041_fake.sql')
        with self.assertRaises(r.market.GuardFailure):obj.baseline_migrations()

    def test_private_input_requires_0600_and_no_symlink(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder).resolve()/'private.json';path.write_text('{}');path.chmod(0o600)
            self.assertEqual(r.private_read(path),b'{}')
            link=path.with_name('link');link.symlink_to(path)
            with self.assertRaises(r.market.GuardFailure):r.private_read(link)
            path.chmod(0o644)
            with self.assertRaises(r.market.GuardFailure):r.private_read(path)

    def test_entire_public_manifest_is_preserved(self):
        old={'source_sha':r.BASELINE,'files':{'backoffice/finance.js':'hash','legal/privacy.html':'legal'}}
        r.verify_manifest(old,copy.deepcopy(old),'new')
        for new in [{**old,'source_sha':'new'},{**old,'files':{}}]:
            with self.assertRaises(r.market.GuardFailure):r.verify_manifest(old,new,'new')

    def test_runtime_snapshot_normalizes_only_monotonic_heartbeat_not_backup(self):
        obj=object.__new__(r.Release);obj.additions={}
        with patch.object(r.base.Release,'snapshot',lambda self:{'excluded':copy.deepcopy(self.additions)}):
            self.assertEqual(obj.runtime_snapshot(),{'excluded':{'cloud_branch_availability':['revision','observed_at']}})
        self.assertEqual(obj.additions,{})
        self.assertIs(r.Release.snapshot,r.market.Release.snapshot)
        old=[{'branch_id':'b','device_id':'d','revision':1,'stopped_ids':[],'observed_at':'2026-10-07T00:00:00+00:00'}]
        new=[{**old[0],'revision':2,'observed_at':'2026-10-07T00:00:01+00:00'}]
        r.base.verify_availability(old,new)
        with self.assertRaises(r.market.GuardFailure):r.base.verify_availability(old,[{**new[0],'stopped_ids':['changed']}])

    def test_environment_uses_immutable_image_without_release_sha(self):
        with tempfile.TemporaryDirectory() as folder:
            obj=object.__new__(r.Release);obj.private=Path(folder);obj.enrollment_environment=environment();obj.sha='a'*40
            (obj.private/'prepared.json').write_text(json.dumps({'image_id':'candidate','artifacts':{'rollback_image_id':'baseline'}}))
            before={'BANK_SECRET':'unchanged','FARM_ENABLED':'unchanged','WEBKASSA_ENABLED':'unchanged'}
            state={'image':'baseline','env':before}
            obj.remote=lambda command:state['image']
            obj.runtime_environment=lambda:state['env']
            obj.verify_environment(before)
            expected={key:r.digest(value.encode()) for key,value in environment().items()}
            state.update(image='candidate',env={**before,**expected})
            obj.verify_environment(before)
            for change in [{'BANK_SECRET':'changed'},{'RELEASE_SHA':'unexpected'}]:
                state['env']={**before,**expected,**change}
                with self.assertRaises(r.market.GuardFailure):obj.verify_environment(before)
            state['env']=before
            with self.assertRaises(r.market.GuardFailure):obj.verify_environment(before)
            state.update(image='unknown',env={**before,**expected})
            with self.assertRaises(r.market.GuardFailure):obj.verify_environment(before)
            state.update(image='baseline',env={**before,**expected})
            with self.assertRaises(r.market.GuardFailure):obj.verify_environment(before)

    def test_retained_retry_requires_original_proofs_and_exact_restored_state(self):
        with tempfile.TemporaryDirectory() as folder:
            obj=object.__new__(r.Release);obj.private=Path(folder).resolve();obj.sha='a'*40
            old=[{'version':'042.sql','scope':'cloud','checksum':'old'}]
            retained=old+[{'version':n,'scope':'cloud','checksum':h} for n,h in r.MIGRATION_HASHES.items() if n.startswith('043_')]
            proofs={'prepared.json':{'sha':obj.sha,'old_api':r.BASELINE,'old_web':r.PUBLIC_BASELINE,'baseline_schema':41,'baseline_environment':{},'artifacts':{'rollback_image_id':'oldimage'}},
                'before.json':{'ledger':old,'acl':[],'worker_acl':[],'neighbors':{}},
                'rollback.json':{'migration_files_retained':42,'last_migration_retained':next(iter(r.MIGRATION_HASHES)),'acl_restored':True,'live_dump_restored':False,'finance_data_erased':False,'qr_worker_enabled':False},
                'backup.json':{'restore':'passed','path':'encrypted-backup','sha256':'b'*64}}
            def write():
                for name,value in proofs.items():
                    path=obj.private/name;path.write_text(json.dumps(value));path.chmod(0o600)
            write()
            obj.ledger=lambda:retained;obj.acl=lambda:[];obj.worker_acl=lambda:[];obj.fingerprint=lambda:{}
            obj.runtime_environment=lambda:{}
            image={'Id':'oldimage','Config':{'Labels':{'org.opencontainers.image.revision':r.BASELINE}}}
            obj.remote=lambda command:json.dumps(image) if 'docker image inspect' in command else 'oldimage'
            checked=[];obj.retained_rollback_snapshot=lambda before:checked.append(before)
            obj.verify_retained_retry(old);self.assertEqual(len(checked),1)
            image['Id']='different-image'
            with self.assertRaises(r.market.GuardFailure):obj.verify_retained_retry(old)
            image['Id']='oldimage';image['Config']['Labels']['org.opencontainers.image.revision']='other'
            with self.assertRaises(r.market.GuardFailure):obj.verify_retained_retry(old)
            image['Config']['Labels']['org.opencontainers.image.revision']=r.BASELINE
            originals={name:(obj.private/name).read_bytes() for name in proofs}
            obj.verify_retained_retry(old)
            self.assertEqual(originals,{name:(obj.private/name).read_bytes() for name in proofs})
            for name,field,value in [('rollback.json','acl_restored',False),('backup.json','restore','failed'),('prepared.json','old_api','other'),('before.json','ledger',[])]:
                saved=copy.deepcopy(proofs[name]);proofs[name][field]=value;write()
                with self.subTest(name=name),self.assertRaises(r.market.GuardFailure):obj.verify_retained_retry(old)
                proofs[name]=saved;write()
            obj.ledger=lambda:old
            with self.assertRaises(r.market.GuardFailure):obj.verify_retained_retry(old)

            obj.ledger=lambda:retained
            original_sha=obj.sha;obj.sha='c'*40
            proofs['prepared.json'].update(gateway_sha256='d'*64,image_id='original-candidate')
            proofs['prepared.json']['artifacts'].update(image_id='original-candidate',revision=original_sha)
            write()
            obj.verify_retained_retry(old,obj.private)
            self.assertEqual(obj.previous_attempt_evidence['sha'],original_sha)
            self.assertEqual(set(obj.previous_attempt_evidence['files']),set(proofs))
            proofs['prepared.json']['artifacts']['revision']=obj.sha;write()
            with self.assertRaises(r.market.GuardFailure):obj.verify_retained_retry(old,obj.private)

    def test_compare_runtime_allows_only_missing_migration_tables(self):
        obj=object.__new__(r.Release)
        before={'availability':[],'runtime_data':{'tables':{'commerce_kiosk_kaspi_qr':{'rows':0,'sha256':'empty'}},'sequences':[]}}
        current=copy.deepcopy(before['runtime_data'])
        current['tables']['kiosk_enrollment_aliases']={'rows':0,'sha256':'empty'}
        obj.availability_rows=lambda:[];obj.runtime_snapshot=lambda:current
        obj.compare_runtime(before)
        current['tables']['commerce_kiosk_kaspi_qr']['rows']=1
        with self.assertRaises(r.market.GuardFailure):obj.compare_runtime(before)

    def test_owner_migration_has_only043_and_select_acl_no_seed_or_worker(self):
        program=r.owner_migration_program()
        self.assertIn("await migrate(pool,'/app/db/cloud/migrations','cloud')",program)
        self.assertIn(r.API_GRANTS,program)
        self.assertNotIn('INSERT INTO',program);self.assertNotIn('provision.mjs',program)
        self.assertNotIn('REVOKE',r.API_GRANTS);self.assertNotIn('kaspi_worker',r.API_GRANTS)
        self.assertNotIn('commerce_captures',r.API_GRANTS)
        self.assertIn('GRANT UPDATE(lock_anchor) ON kiosk_devices TO pickchick_app;',r.API_GRANTS)
        self.assertEqual(r.API_UPDATE_COLUMNS['kiosk_devices'],{'lock_anchor'})
        self.assertNotIn('GRANT UPDATE ON',r.API_GRANTS)

    def test_prepare_does_not_rebuild_public_or_use_secret_cli_values(self):
        source=inspect.getsource(r.Release.prepare)
        self.assertNotIn('backoffice.tar',source);self.assertNotIn('shutil.rmtree',source)
        self.assertIn('manifest = previous',source)
        self.assertIn('input=json.dumps(self.enrollment_environment)',source)
        self.assertIn('chr(10)',r.enrollment_env_append_program())
        self.assertNotIn("+' up -d",source)

    def test_apply_keeps_full_guarded_lifecycle_order(self):
        source=inspect.getsource(r.Release.apply)
        self.assertLess(source.index('self.backup_restore('),source.index('owner_migration_program()'))
        self.assertLess(source.index('owner_migration_program()'),source.index("market.api_compose(BASELINE)+' up"))
        self.assertLess(source.index("market.api_compose(BASELINE)+' up"),source.index("market.api_compose(self.sha)+' up"))
        self.assertLess(source.index('self.verify_data(before)'),source.index('self.switch('))
        self.assertIn('self.cleanup(\'acquire\')',source);self.assertIn('self.cleanup(\'release\')',source)
        self.assertIn('self.prepared_artifacts(',source);self.assertIn('self.rollback_artifacts()',source)

    def test_private_env_writer_creates_actual_newlines_and_refuses_rewrite(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder).resolve()/'release.env';path.write_text('RELEASE_SHA=synthetic\n');path.chmod(0o600)
            run=lambda:subprocess.run([sys.executable,'-c',r.enrollment_env_append_program(),str(path)],input=json.dumps(environment()).encode(),capture_output=True)
            self.assertEqual(run().returncode,0)
            lines=path.read_text().splitlines()
            self.assertEqual(len(lines),len(environment())+1)
            self.assertIn('KIOSK_KASPI_QR_ENABLED=false',lines)
            self.assertEqual(path.stat().st_mode & 0o077,0)
            self.assertNotEqual(run().returncode,0)

    def test_offline_apply_simulation_runs_backup_then_migration_compatibility_and_cas(self):
        for retained43 in [False,True]:
            with tempfile.TemporaryDirectory() as folder:
                obj=object.__new__(r.Release);obj.private=Path(folder).resolve();obj.sha='a'*40
                obj.environment_bytes=b'synthetic';obj.baseline_schema=41;obj.lock_owner={'id':'synthetic'}
                identity=obj.private/'identity';identity.write_text('synthetic');identity.chmod(0o600)
                obj.args=SimpleNamespace(backup_identity=identity,previous_attempt_proof_dir=Path(folder)/"previous" if retained43 else None)
                artifact={'rollback_image_id':'oldimage'};manifest={'files':{}}
                proof={'sha':obj.sha,'old_api':r.BASELINE,'old_web':r.BASELINE,'baseline_schema':41,
                    'public_manifest':manifest,'artifacts':artifact,'rollback_files':{},'baseline_environment':{},
                    'enrollment_environment_sha256':r.digest(obj.environment_bytes),'image_id':'newimage','gateway_sha256':'b'*64}
                (obj.private/'prepared.json').write_text(json.dumps(proof))
                calls=[];state={'image':'oldimage'}
                for name in ['source_checks','ci','runtime_old','quiescent']:
                    setattr(obj,name,lambda name=name:calls.append(name))
                obj.prepared_artifacts=lambda manifest:artifact;obj.rollback_artifacts=lambda:{}
                obj.runtime_environment=lambda:{};obj.cleanup=lambda action:calls.append('cleanup:'+action)
                obj.http=lambda *args,**kwargs:(503,b'')
                obj.http_json=lambda *args,**kwargs:{'ready':True}
                obj.snapshot=lambda:{'tables':{},'sequences':[]};obj.runtime_snapshot=obj.snapshot
                obj.availability_rows=lambda:[];obj.acl=lambda:[];obj.worker_acl=lambda:[];obj.fingerprint=lambda:{};obj.audit_rows=lambda:[]
                names=['001_synthetic.sql'];obj.baseline_migrations=lambda:names
                with patch.object(r,'digest',r.digest):
                    # Immutable ledger checksum computed from a real existing source file.
                    names[0]=sorted((ROOT/'db/cloud/migrations').glob('*.sql'))[0].name
                obj.ledger=lambda:[{'version':names[0],'scope':'cloud','checksum':r.digest((ROOT/'db/cloud/migrations'/names[0]).read_bytes())}]+([{'version':n,'scope':'cloud','checksum':h} for n,h in r.MIGRATION_HASHES.items() if n.startswith('043_')] if retained43 else [])
                obj.psql=lambda *args:'0';obj.save=lambda name,value:calls.append('save:'+name)
                obj.backup_restore=lambda before:calls.append('backup_restore') or {'restore':'passed'}
                obj.verify_data=lambda before:calls.append('verify_data');obj.verify_environment=lambda before:calls.append('verify_environment')
                obj.verify_capabilities=lambda caps:calls.append('verify_capabilities');obj.verify_public=lambda:calls.append('verify_public')
                obj.switch=lambda *args:calls.append('pointer_cas')
                def remote(command,**kwargs):
                    if 'owner_migration_program' in command:raise AssertionError('Unexpanded program')
                    if "await migrate(pool" in command:calls.append('migrate')
                    if ' up -d ' in command and ' api' in command:
                        state['image']='newimage' if obj.sha in command else 'oldimage';calls.append('api:'+state['image'])
                    if "{{.Image}}" in command:return state['image']
                    if '{{json .Mounts}}' in command:
                        web=f'{r.REMOTE}/public-https/releases/{obj.sha}/infra/public-staging'
                        return json.dumps([{'Destination':'/etc/caddy/Caddyfile','Source':web+'/gateway.Caddyfile'},{'Destination':'/srv/public','Source':web+'/public-web'}])
                    if 'sha256sum /etc/caddy/Caddyfile' in command:return 'b'*64+' file'
                    return ''
                obj.remote=remote
                obj.apply()
                self.assertLess(calls.index('backup_restore'),calls.index('migrate'))
                self.assertLess(calls.index('migrate'),calls.index('api:oldimage'))
                self.assertLess(calls.index('api:oldimage'),calls.index('api:newimage'))
                self.assertLess(calls.index('api:newimage'),calls.index('pointer_cas'))
                self.assertIn('verify_public',calls);self.assertIn('cleanup:release',calls)
                self.assertEqual(obj.phase,'complete')


    def test_auth_probes_use_valid_finance_query_and_command_body(self):
        source=inspect.getsource(r.Release.verify_public)
        self.assertIn('?start_date=2026-10-01&end_date=2026-10-31',source)
        self.assertIn("self.probe_json(branch+'/commands'",source)
        obj=object.__new__(r.Release);calls=[]
        obj.execute=lambda args,**kwargs:calls.append(args) or b'{}\n401'
        body={'request_id':'00000000-0000-4000-a000-000000000001','reason':'Anonymous authorization probe','command':{'type':'void','id':'00000000-0000-4000-a000-000000000002'}}
        self.assertEqual(obj.probe_json('/test',body)[0],401)
        self.assertEqual(json.loads(calls[0][calls[0].index('--data-binary')+1]),body)

    def test_failure_retains_owned_lock_and_never_auto_restores_database(self):
        obj=object.__new__(r.Release);obj.phase='before_reopening';saved={};obj.save=lambda n,v:saved.update({n:v})
        obj.retain_failure(r.market.GuardFailure('synthetic'))
        self.assertTrue(saved['failure-context.json']['deployment_lock_retained'])
        self.assertFalse(saved['failure-context.json']['automatic_rollback_started'])
        rollback=inspect.getsource(r.Release.rollback_closed)
        self.assertIn('retained_rollback_snapshot',rollback);self.assertNotIn('pg_restore',rollback)
        self.assertNotIn('DROP TABLE',rollback)

    def test_preflight_is_read_only_and_reports_no_deployment(self):
        obj=object.__new__(r.Release);obj.sha='a'*40;obj.environment_bytes=b'private';calls=[];proofs={}
        obj.source_checks=lambda:calls.append('source');obj.ci=lambda:calls.append('ci');obj.runtime_old=lambda:calls.append('runtime')
        obj.save=lambda name,value:proofs.update({name:value})
        obj.remote=lambda *args,**kwargs:(_ for _ in ()).throw(AssertionError('No mutation allowed'))
        obj.preflight()
        self.assertEqual(calls,['source','ci','runtime'])
        self.assertFalse(proofs['preflight.json']['deployed'])
        self.assertFalse(proofs['preflight.json']['qr_worker_enabled'])

    def test_retained_rollback_never_erases_or_ignores_changed_money(self):
        obj=object.__new__(r.Release)
        old={'version':'042_cloud_finance.sql','scope':'cloud','checksum':'old'}
        ledger=[old]+[{'version':n,'scope':'cloud','checksum':h} for n,h in r.MIGRATION_HASHES.items()]
        before={'ledger':[old],'runtime_data':{'tables':{'bo_finance_entries':{'rows':1,'sha256':'old'},'bo_audit':{'rows':0,'sha256':'old'}},'sequences':[]},'audit_rows':[],'availability':[]}
        current=copy.deepcopy(before['runtime_data']);current['tables'].update({name:{'rows':0,'sha256':'empty'} for name in r.NEW_TABLES})
        obj.ledger=lambda:ledger;obj.runtime_snapshot=lambda:current;obj.availability_rows=lambda:[];obj.audit_rows=lambda installed:[]
        self.assertEqual(obj.retained_rollback_snapshot(before)[0],ledger)
        current['tables']['bo_finance_entries']={'rows':2,'sha256':'new'}
        with self.assertRaisesRegex(r.market.GuardFailure,'Pre-existing table changed'):
            obj.retained_rollback_snapshot(before)
        self.assertEqual(current['tables']['bo_finance_entries']['rows'],2)

    def test_rollback_after044_with043_already_in_original_before(self):
        obj=object.__new__(r.Release)
        baseline={'version':'042_cloud_finance.sql','scope':'cloud','checksum':'old'}
        rows=[{'version':n,'scope':'cloud','checksum':h} for n,h in r.MIGRATION_HASHES.items()]
        before={'ledger':[baseline,rows[0]],'runtime_data':{'tables':{
            'bo_finance_entries':{'rows':1,'sha256':'money'},
            'commerce_kiosk_kaspi_qr':{'rows':0,'sha256':'empty'}},'sequences':[]},'availability':[]}
        current=copy.deepcopy(before['runtime_data'])
        obj.ledger=lambda:before['ledger'];obj.runtime_snapshot=lambda:current;obj.availability_rows=lambda:[]
        self.assertEqual(obj.retained_rollback_snapshot(before)[0],before['ledger'])
        ledger=before['ledger']+[rows[1]]
        obj.ledger=lambda:ledger
        current['tables']['kiosk_enrollment_aliases']={'rows':0,'sha256':'empty'}
        self.assertEqual(obj.retained_rollback_snapshot(before)[0],ledger)
        current['tables']['kiosk_enrollment_aliases']['rows']=1
        with self.assertRaises(r.market.GuardFailure):obj.retained_rollback_snapshot(before)
        current['tables']['kiosk_enrollment_aliases']['rows']=0
        obj.ledger=lambda:before['ledger']+[rows[0]]
        with self.assertRaises(r.market.GuardFailure):obj.retained_rollback_snapshot(before)
        obj.ledger=lambda:ledger
        current['tables']['bo_finance_entries']['sha256']='changed'
        with self.assertRaises(r.market.GuardFailure):obj.retained_rollback_snapshot(before)

    def test_worker_acl_is_required_unchanged_and_qr_table_empty(self):
        source=inspect.getsource(r.Release.verify_data)
        self.assertIn("self.worker_acl()==before['worker_acl']",source)
        self.assertIn('for table in sorted(NEW_TABLES)',source)
        self.assertIn('Only enrollment SELECT and bounded UPDATE permission delta allowed',source)

    def test_retry_verification_does_not_duplicate_retained043(self):
        obj=object.__new__(r.Release)
        ledger=[{'version':'042.sql','scope':'cloud','checksum':'old'}]+[
            {'version':n,'scope':'cloud','checksum':h} for n,h in r.MIGRATION_HASHES.items()]
        before={'ledger':ledger,'acl':[],'worker_acl':[]}
        obj.ledger=lambda:ledger;obj.compare_runtime=lambda before:None
        obj.acl=lambda:[{'name':name,'kind':'r','column':None,'privilege':'SELECT','grantable':False} for name in r.API_SELECT_TABLES]+[{'name':name,'kind':'r','column':column,'privilege':'UPDATE','grantable':False} for name,columns in r.API_UPDATE_COLUMNS.items() for column in columns]
        obj.worker_acl=lambda:[];obj.psql=lambda *args:'0'
        obj.verify_data(before)
        expected_acl=obj.acl()
        obj.acl=lambda:[row for row in expected_acl if not (row['name']=='kiosk_devices' and row['column']=='lock_anchor')]
        with self.assertRaises(r.market.GuardFailure):obj.verify_data(before)
        obj.acl=lambda:expected_acl+[{'name':'kiosk_devices','kind':'r','column':'token_hash','privilege':'UPDATE','grantable':False}]
        with self.assertRaises(r.market.GuardFailure):obj.verify_data(before)
        obj.acl=lambda:expected_acl
        obj.psql=lambda *args:'1'
        with self.assertRaisesRegex(r.market.GuardFailure,'QR worker must remain inactive'):obj.verify_data(before)

if __name__=='__main__':unittest.main()
