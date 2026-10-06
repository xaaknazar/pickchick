import copy
import importlib.util
import inspect
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('finance_ledger_release',ROOT/'infra/staging/release-finance-ledger.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)

class FinanceRelease(unittest.TestCase):
    def test_reviewed_baseline_and_exact_41_migration_files(self):
        self.assertEqual(r.BASELINE,'850c6fa5a39296f78e29ff56e2a8b8c78a7137cc')
        self.assertEqual(r.PUBLIC_BASELINE,r.BASELINE)
        self.assertEqual(r.COMPOSE_BASELINE,'15f7d29229f5e119250f7893479a08e128778b16c905a523492223b08e3c2071')
        self.assertEqual(r.GATEWAY_BASELINE,'64366439f95f6bba265208f84c47ffcbc090920540dd2055f8bb88491c17f0bd')
        self.assertEqual(list(r.MIGRATION_HASHES),['039_cloud_tiptoppay_checkout.sql','040_cloud_tiptoppay_test_checkout.sql','042_cloud_finance.sql'])
        self.assertEqual(r.digest((ROOT/'db/cloud/migrations/042_cloud_finance.sql').read_bytes()),r.MIGRATION_HASHES['042_cloud_finance.sql'])
        self.assertEqual(r.digest((ROOT/'infra/staging/backoffice-grants.mjs').read_bytes()),r.FINANCE_HELPER_SHA256)
        args=SimpleNamespace(expected_api_sha=r.BASELINE,expected_public_sha=r.PUBLIC_BASELINE,expected_gateway_sha256=r.GATEWAY_BASELINE)
        with patch.object(r.sys,'version_info',(3,12)),patch.object(r.market.Release,'__init__') as init:r.Release(args)
        profile=init.call_args.args[2]
        self.assertEqual(profile.baseline_count+len(profile.migrations),41)
        self.assertEqual(profile.settings,())
        self.assertTrue(profile.exact_ci_jobs)
        self.assertEqual(len(profile.ci_jobs),11)
        for key in vars(args):
            bad=copy.copy(args);setattr(bad,key,'0'*len(getattr(bad,key)))
            with self.assertRaises(r.market.GuardFailure):r.Release(bad)
        with patch.object(r.sys,'version_info',(3,9)):
            with self.assertRaises(r.market.GuardFailure):r.Release(args)

    def test_compose_is_byte_preserved_and_drift_rejected(self):
        raw='services:\n  api:\n    environment:\n      CATALOG_MOBILE_STOREFRONT_ENABLED: "true"\n'
        with patch.object(r,'COMPOSE_BASELINE',r.digest(raw.encode())):
            self.assertEqual(r.compose_candidate(raw),raw)
            with self.assertRaises(r.market.GuardFailure):r.compose_candidate(raw+'#drift')
        for bad in [raw.replace('"true"','"false"'),raw+'TIPTOPPAY_MODE=test\n']:
            with patch.object(r,'COMPOSE_BASELINE',r.digest(bad.encode())):
                with self.assertRaises(r.market.GuardFailure):r.compose_candidate(bad)

    def test_gateway_changes_only_existing_exact_bo_finance_suffixes(self):
        raw=":8080 {\npath_regexp backoffice_get ^/v1/admin/backoffice/branches/[0-9a-fA-F]{12}(/orders/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})?$\npath_regexp backoffice_post ^/v1/admin/backoffice/branches/[0-9a-fA-F]{12}/commands$\n}"
        with patch.object(r,'GATEWAY_BASELINE',r.digest(raw.encode())):
            result=r.gateway_candidate(raw)
            self.assertIn('(/finance|/orders/',result)
            self.assertIn('(/finance)?/commands$',result)
            self.assertEqual(result.replace('/finance|','').replace('(/finance)?',''),raw)
            self.assertNotIn('tiptoppay',result)
            with self.assertRaises(r.market.GuardFailure):r.gateway_candidate(raw+'#drift')
        for bad in [raw+raw,raw+'/finance']:
            with patch.object(r,'GATEWAY_BASELINE',r.digest(bad.encode())):
                with self.assertRaises(r.market.GuardFailure):r.gateway_candidate(bad)

    def test_manifest_only_backoffice_assets_and_provenance_change(self):
        old={'source_sha':'old','base_source_sha':'original','files':{'legal/privacy.html':'legal','operations/app.js':'ops','backoffice/app.js':'old'},'component_sources':{'backoffice':'old','operations':'ops'}}
        new=copy.deepcopy(old);new['source_sha']='new';new['component_sources']['backoffice']='new'
        new['files'].update({'backoffice/'+n:'new' for n in ['app.js','operations.js','domain.js','index.html','finance.js']})
        r.verify_manifest(old,new,'new')
        for change in [lambda x:x['files'].update({'legal/privacy.html':'changed'}),lambda x:x['component_sources'].update({'operations':'changed'}),lambda x:x.update({'base_source_sha':'changed'}),lambda x:x['files'].pop('backoffice/finance.js')]:
            bad=copy.deepcopy(new);change(bad)
            with self.assertRaises(r.market.GuardFailure):r.verify_manifest(old,bad,'new')

    def test_environment_all_flags_credentials_and_fiscal_preserved(self):
        obj=object.__new__(r.Release)
        before={'WEBKASSA_ENABLED':'old','CUSTOMER_KASPI_PILOT_ENABLED':'old','FARM_ENABLED':'old','CATALOG_MOBILE_STOREFRONT_ENABLED':'old','BANK_SECRET':'old'}
        obj.runtime_environment=lambda:{**before,'RELEASE_SHA':'new'}
        obj.verify_environment(before)
        for key in before:
            obj.runtime_environment=lambda key=key:{**before,key:'changed'}
            with self.assertRaises(r.market.GuardFailure):obj.verify_environment(before)
        obj.runtime_environment=lambda:{**before,'TIPTOPPAY_MODE':'new'}
        with self.assertRaises(r.market.GuardFailure):obj.verify_environment(before)

    def good_acl(self):
        rows=[{'name':name,'kind':'r','column':None,'privilege':p,'grantable':False} for name in r.FINANCE_TABLES for p in ['SELECT','INSERT']]
        rows += [{'name':'bo_finance_periods','kind':'r','column':col,'privilege':'UPDATE','grantable':False} for col in ['closed','revision']]
        return rows

    def test_acl_delta_rejects_bank_mutation_payment_grants_and_table_update(self):
        obj=object.__new__(r.Release);before={'ledger':[],'acl':[],'worker_acl':['bank']}
        obj.ledger=lambda:[{'version':n,'scope':'cloud','checksum':h} for n,h in r.MIGRATION_HASHES.items()]
        obj.compare_runtime=lambda b:None;obj.worker_acl=lambda:['bank'];obj.psql=lambda *a:'0'
        good=self.good_acl();obj.acl=lambda:good;obj.verify_data(before)
        for table,privilege in [('commerce_captures','INSERT'),('commerce_tiptoppay_test_payments','INSERT'),('bo_finance_entries','UPDATE'),('bo_finance_entries','DELETE')]:
            obj.acl=lambda table=table,privilege=privilege:good+[{'name':table,'kind':'r','column':None,'privilege':privilege,'grantable':False}]
            with self.assertRaises(r.market.GuardFailure):obj.verify_data(before)
        obj.acl=lambda:good;obj.worker_acl=lambda:['changed']
        with self.assertRaises(r.market.GuardFailure):obj.verify_data(before)
        obj.worker_acl=lambda:['bank'];obj.psql=lambda *a:'1'
        with self.assertRaises(r.market.GuardFailure):obj.verify_data(before)

    def test_owner_only_exact_append_permissions_without_provision_seed_or_payments(self):
        program=r.owner_migration_program()
        self.assertIn("url.username!=='pickchick_owner'",program)
        self.assertIn(json.dumps(r.FINANCE_GRANTS),program)
        self.assertIn('migrationFiles:41,lastMigration:42',program)
        for forbidden in ['provision.mjs','tipTopPayTestGrants','farmGrants','DELETE','TRUNCATE','INSERT INTO','fetch(','https://']:
            self.assertNotIn(forbidden,program)
        self.assertNotIn('commerce_',r.FINANCE_GRANTS)
        self.assertNotIn('GRANT UPDATE ON',r.FINANCE_GRANTS)

    def test_source_guards_pin_old_38_and_new_migrations_helper(self):
        self.assertIs(r.Release.baseline_migrations,r.market.Release.baseline_migrations)
        source=inspect.getsource(r.Release.source_checks)
        self.assertIn('market.Release.source_checks(self)',source)
        self.assertIn('MIGRATION_HASHES',source)
        self.assertIn('FINANCE_HELPER_SHA256',source)
        self.assertIn('helper.startswith(',source)

    def test_apply_has_backup_restore_before_migrations_and_image_drill(self):
        source=inspect.getsource(r.Release.apply)
        self.assertLess(source.index('self.backup_restore('),source.index('owner_migration_program('))
        self.assertIn("proof['artifacts']['rollback_image_id']",source)
        self.assertIn('self.verify_environment(',source)
        self.assertIn('self.fingerprint()',source)
        self.assertIn('self.verify_data(before)',source)
        self.assertIn("self.switch(REMOTE+'/current'",source)
        self.assertIn("self.switch(REMOTE+'/public-https/current'",source)

    def test_rollback_keeps_migrations_and_journal_without_dump_restore(self):
        source=inspect.getsource(r.Release.rollback_closed)
        for forbidden in ['DROP TABLE','pg_restore','TRUNCATE','DELETE FROM','owner_migration_program(']:self.assertNotIn(forbidden,source)
        self.assertIn('self.retained_rollback_snapshot(before)',source)
        self.assertIn('acl_restore_sql',source)
        self.assertIn("proof['artifacts']['rollback_image_id']",source)
        self.assertIn('self.verify_environment(',source)
        self.assertIn("'finance_data_erased':False",source)
        obj=object.__new__(r.Release);obj.args=SimpleNamespace(owner_id=None)
        obj.remote=lambda *a,**kw:self.fail('Remote mutation without owner')
        with self.assertRaises(r.market.GuardFailure):obj.resume_owned_rollback()

    def test_retained_rollback_keeps_finance_rows_and_rejects_unreviewed_prefix(self):
        obj=object.__new__(r.Release)
        before={'ledger':[{'version':'038','scope':'cloud','checksum':'old'}],
                'availability':[], 'runtime_data':{'tables':{'schema_migrations':{'rows':38,'sha256':'old'},'commerce_captures':{'rows':1,'sha256':'money'}},'sequences':[]}}
        added=[{'version':n,'scope':'cloud','checksum':h} for n,h in r.MIGRATION_HASHES.items()]
        obj.availability_rows=lambda:[]
        for count in range(4):
            ledger=before['ledger']+added[:count];obj.ledger=lambda:ledger
            names=set()
            if count>=1:names|={'commerce_checkout_payment_methods','commerce_tiptoppay_sessions'}
            if count>=2:names.add('commerce_tiptoppay_test_payments')
            if count>=3:names|=r.FINANCE_TABLES
            current=copy.deepcopy(before['runtime_data']);current['tables']['schema_migrations']={'rows':38+count,'sha256':'new'}
            current['tables'].update({name:{'rows':2 if name in r.FINANCE_TABLES else 0,'sha256':'retained'} for name in names})
            obj.runtime_snapshot=lambda:current
            self.assertEqual(obj.retained_rollback_snapshot(before),(ledger,current))
        obj.ledger=lambda:before['ledger']+[added[-1]]
        with self.assertRaises(r.market.GuardFailure):obj.retained_rollback_snapshot(before)
        obj.ledger=lambda:before['ledger']+added
        current['tables']['commerce_captures']['sha256']='mutated'
        with self.assertRaises(r.market.GuardFailure):obj.retained_rollback_snapshot(before)
        current['tables']['commerce_captures']['sha256']='money'
        current['tables']['commerce_tiptoppay_test_payments']['rows']=1
        with self.assertRaises(r.market.GuardFailure):obj.retained_rollback_snapshot(before)

    def test_rollback_allows_only_receipted_finance_audit_append_and_preserves_old_rows(self):
        old=[{'id':'old','sha256':'known','finance_valid':False,'receipt_key':None}]
        added={'id':'new','sha256':'finance','finance_valid':True,'receipt_key':'actor:request'}
        r.verify_finance_audit_append(old,old+[added])
        for invalid in [old+[dict(added,finance_valid=False)],old+[dict(added,receipt_key=None)],
                        [dict(old[0],sha256='modified'),added],[added],
                        old+[added,dict(added,id='other')]]:
            with self.assertRaises(r.market.GuardFailure):r.verify_finance_audit_append(old,invalid)
        obj=object.__new__(r.Release)
        prior={'schema_migrations':{'rows':38,'sha256':'old'},'bo_audit':{'rows':1,'sha256':'known'},'commerce_captures':{'rows':1,'sha256':'money'}}
        before={'ledger':[],'availability':[],'audit_rows':old,'runtime_data':{'tables':prior,'sequences':[]}}
        ledger=[{'version':n,'scope':'cloud','checksum':h} for n,h in r.MIGRATION_HASHES.items()]
        current={'tables':copy.deepcopy(prior),'sequences':[]};current['tables']['bo_audit']={'rows':2,'sha256':'appended'}
        current['tables'].update({name:{'rows':1 if name in r.FINANCE_TABLES else 0,'sha256':'new'} for name in r.NEW_TABLES})
        obj.ledger=lambda:ledger;obj.runtime_snapshot=lambda:current;obj.availability_rows=lambda:[]
        obj.audit_rows=lambda installed:old+[added] if installed else old
        self.assertEqual(obj.retained_rollback_snapshot(before),(ledger,current))
        obj.audit_rows=lambda installed:old+[dict(added,finance_valid=False)]
        with self.assertRaises(r.market.GuardFailure):obj.retained_rollback_snapshot(before)
        del before['audit_rows']
        with self.assertRaises(r.market.GuardFailure):obj.retained_rollback_snapshot(before)
        source=inspect.getsource(r.Release.audit_rows)
        for required in ['LEFT JOIN bo_finance_commands','c.actor_id=a.actor_id','c.request_id=a.request_id','c.branch_id=a.branch_id',"a.action='finance.'"]:self.assertIn(required,source)

    def test_public_smoke_only_unauthenticated_probes_no_finance_or_payment_data(self):
        source=inspect.getsource(r.Release.verify_public)
        self.assertIn("self.http(branch)[0] == 401",source)
        self.assertIn("self.http(branch+'/commands',method='POST')[0] == 401",source)
        self.assertIn("'Payment feature route exposed'",source)
        self.assertNotIn('headers=',source)
        self.assertNotIn('body=',source)
        self.assertIn("proof['baseline_catalog']",source)

    def test_failure_retains_ownership_and_never_automatically_rolls_back(self):
        obj=object.__new__(r.Release);obj.phase='reopened';obj.sha='new';obj.maintenance='/owned'
        obj.cleanup=lambda action:None;obj.remote=lambda *a,**kw:None;obj.http=lambda *a,**kw:(503,b'')
        saved={};obj.save=lambda name,data:saved.update({name:data})
        self.assertEqual(obj.retain_failure(r.market.GuardFailure('failure')),'closed')
        proof=saved['failure-context.json'];self.assertTrue(proof['deployment_lock_retained']);self.assertFalse(proof['automatic_rollback_started'])
        self.assertEqual(obj.retain_failure(r.market.CommandUncertain('uncertain')),'unknown')

if __name__=='__main__':unittest.main()
