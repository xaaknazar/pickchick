import copy
import importlib.util
import inspect
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('catalog_storefront_release', ROOT/'infra/staging/release-catalog-storefront.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)

class CatalogStorefrontRelease(unittest.TestCase):
    def test_reviewed_testflight12_installed_baselines(self):
        self.assertEqual(r.BASELINE,'f39863718f074e923ae24ffecf37d8bf36987cdf')
        self.assertEqual(r.PUBLIC_BASELINE,'239148bf3329f6ec8e467b9425bcdff6189dd414')
        self.assertEqual(r.GATEWAY_BASELINE,'1df3d12b60e829081bc90b77256cfc5a84b30064cabe8039cae519a41465ed51')
        self.assertEqual(r.COMPOSE_BASELINE,'c62c24cb90418e791b9740352ffcafe4c664a1669887914d79dfea96dbbc5db2')
        self.assertEqual(object.__new__(r.Release).web_manifest_source(),'e236824b80ee315eae48c371d722f4f6459aac8c')

    def test_profile_is_exact_schema38_without_migrations_or_settings(self):
        args=SimpleNamespace(expected_api_sha=r.BASELINE,expected_public_sha=r.PUBLIC_BASELINE,expected_gateway_sha256=r.GATEWAY_BASELINE)
        with patch.object(r.market.Release,'__init__') as init:r.Release(args)
        profile=init.call_args.args[2]
        self.assertEqual(profile.baseline_count,38)
        self.assertEqual(profile.migrations,())
        self.assertEqual(profile.settings,())
        self.assertEqual(len(profile.ci_jobs),11)
        self.assertTrue(profile.exact_ci_jobs)
        for field in vars(args):
            bad=copy.copy(args);setattr(bad,field,'0'*len(getattr(args,field)))
            with self.assertRaises(r.market.GuardFailure):r.Release(bad)

    def test_baseline_and_source_guards_use_installed_api_tree(self):
        self.assertIs(r.Release.baseline_migrations,r.market.Release.baseline_migrations)
        self.assertEqual(r.Release.additions,{})
        obj=object.__new__(r.Release)
        with patch.object(r.market.Release,'source_checks') as check:obj.source_checks()
        check.assert_called_once_with(obj)

    def test_source_guards_check38_migrations_against_installed_api(self):
        obj=object.__new__(r.Release);obj.sha='a'*40
        obj.profile=r.market.ReleaseProfile('farm',r.BASELINE,r.PUBLIC_BASELINE,38,(),r.base.CI_JOBS,frozenset(),'farm-update-release',(),exact_ci_jobs=True)
        obj.args=SimpleNamespace(branch='codex/farm-testflight-11')
        # Model the schema38 release checkout, not today's migration directory.
        baseline={path.name:path.read_bytes() for path in sorted((ROOT/'db/cloud/migrations').glob('*.sql'))
                  if path.name[:3].isdigit() and int(path.name[:3])<=38}
        self.assertEqual(len(baseline),38)
        def git(*args):
            if args[0]=='rev-parse':return obj.sha
            if args[0]=='status':return ''
            if args[0]=='ls-remote':return obj.sha+' refs/heads/'+obj.args.branch
            self.assertEqual(args,('ls-tree','-r','--name-only',r.BASELINE,'--','db/cloud/migrations/'))
            return '\n'.join('db/cloud/migrations/'+name for name in baseline)
        obj.git=git
        seen=[]
        def execute(args):
            self.assertEqual(args[:2],['git','show'])
            self.assertTrue(args[2].startswith(r.BASELINE+':db/cloud/migrations/'))
            seen.append(args[2])
            return baseline[Path(args[2].split(':',1)[1]).name]
        obj.execute=execute
        self.assertEqual(len(obj.baseline_migrations()),38)
        with tempfile.TemporaryDirectory() as directory:
            fixture=Path(directory)
            migrations=fixture/'db/cloud/migrations'
            migrations.mkdir(parents=True)
            for name,data in baseline.items():(migrations/name).write_bytes(data)
            with patch.object(r.market,'REPO',fixture):
                obj.source_checks()
                self.assertEqual(len(seen),38)
                extra=migrations/'039_unreviewed.sql'
                extra.write_text('SELECT 1;')
                with self.assertRaisesRegex(r.market.GuardFailure,'Release migration set differs'):
                    obj.source_checks()
                extra.unlink()
                name=next(iter(baseline))
                (migrations/name).write_bytes(baseline[name]+b'\n-- changed migration\n')
                with self.assertRaisesRegex(r.market.GuardFailure,'An existing migration was edited'):
                    obj.source_checks()

    def test_runtime_snapshot_allows_only_paired_availability_heartbeat(self):
        obj=object.__new__(r.Release)
        before={'availability':[], 'runtime_data':{'tables':{'customer_farms':{'rows':1,'sha256':'old'}},'sequences':[]}}
        obj.availability_rows=lambda:[]
        obj.runtime_snapshot=lambda:copy.deepcopy(before['runtime_data'])
        obj.compare_runtime(before)
        obj.runtime_snapshot=lambda:{'tables':{'customer_farms':{'rows':1,'sha256':'changed'}},'sequences':[]}
        with self.assertRaises(r.market.GuardFailure):obj.compare_runtime(before)

    def test_compose_changes_only_api_storefront_flag(self):
        text='services:\n  api:\n    environment:\n      FARM_ENABLED: "1"\n      CATALOG_MOBILE_STOREFRONT_ENABLED: "false"\n  provision:\n    environment:\n      CATALOG_MOBILE_STOREFRONT_ENABLED: "false"\n'
        with patch.object(r,'COMPOSE_BASELINE',r.market.digest(text.encode())):
            candidate=r.api_compose_candidate(text)
            self.assertEqual(candidate,text.replace('CATALOG_MOBILE_STOREFRONT_ENABLED: "false"','CATALOG_MOBILE_STOREFRONT_ENABLED: "true"',1))
            with self.assertRaises(r.market.GuardFailure):r.api_compose_candidate(text+'#drift\n')
        disabled=text.replace('FARM_ENABLED: "1"','FARM_ENABLED: "0"')
        with patch.object(r,'COMPOSE_BASELINE',r.market.digest(disabled.encode())):
            with self.assertRaises(r.market.GuardFailure):r.api_compose_candidate(disabled)

    def test_gateway_adds_only_exact_get_route(self):
        marker="path('/v1/customer-checkout/config', '/v1/customer-checkout/orders', '/v1/customer-checkout/availability', '/v1/customer-checkout/feedback')"
        text="expression `(method('GET') && "+marker+") || method('POST')`\n"
        with patch.object(r,'GATEWAY_BASELINE',r.market.digest(text.encode())):
            candidate=r.gateway_candidate(text)
            self.assertEqual(candidate,text.replace(marker,marker[:-1]+", '/v1/customer-checkout/catalog')"))
            self.assertEqual(candidate.replace(", '/v1/customer-checkout/catalog'",''),text)
            with self.assertRaises(r.market.GuardFailure):r.gateway_candidate(text+'# drift')
        for invalid in [text+text,text.replace(marker,'unknown'),text+'/v1/customer-checkout/catalog']:
            with patch.object(r,'GATEWAY_BASELINE',r.market.digest(invalid.encode())):
                with self.assertRaises(r.market.GuardFailure):r.gateway_candidate(invalid)

    def test_catalog_acl_requires_existing_select_without_mutations(self):
        obj=object.__new__(r.Release);calls=[]
        obj.psql=lambda db,sql:(calls.append(sql) or 't')
        obj.catalog_read_acl()
        self.assertTrue(calls[0].startswith('SELECT '))
        for missing in ['f','',None]:
            obj.psql=lambda db,sql:missing
            with self.assertRaises(r.market.GuardFailure):obj.catalog_read_acl()

    def test_exact_ledger_acl_worker_and_runtime_data_guards(self):
        obj=object.__new__(r.Release)
        before={'ledger':['migration'],'acl':['app'],'worker_acl':['worker']}
        obj.ledger=lambda:before['ledger'];obj.acl=lambda:before['acl'];obj.worker_acl=lambda:before['worker_acl']
        obj.compare_runtime=lambda value:self.assertIs(value,before)
        obj.verify_data(before)
        for method in ['ledger','acl','worker_acl']:
            old=getattr(obj,method);setattr(obj,method,lambda:['changed'])
            with self.assertRaises(r.market.GuardFailure):obj.verify_data(before)
            setattr(obj,method,old)

    def test_environment_preserves_every_flag_except_revision(self):
        obj=object.__new__(r.Release)
        baseline={'FARM_ENABLED':r.market.digest(b'1'),'CATALOG_MOBILE_STOREFRONT_ENABLED':r.market.digest(b'false'),'BANK_FLAG':'old','RELEASE_SHA':'old'}
        obj.runtime_environment=lambda:{**baseline,'RELEASE_SHA':'new','CATALOG_MOBILE_STOREFRONT_ENABLED':r.market.digest(b'true')}
        obj.verify_environment(baseline)
        obj.runtime_environment=lambda:{**baseline,'BANK_FLAG':'new'}
        with self.assertRaises(r.market.GuardFailure):obj.verify_environment(baseline)
        obj.runtime_environment=lambda:{**baseline,'FARM_ENABLED':r.market.digest(b'0')}
        with self.assertRaises(r.market.GuardFailure):obj.verify_environment(baseline)

    def test_failure_recloses_installed_public_gateway_and_retains_locks(self):
        obj=object.__new__(r.Release);obj.phase='reopened';obj.maintenance='/owned/maintenance'
        commands=[];saved={}
        obj.cleanup=lambda action:self.assertEqual(action,'status')
        obj.remote=lambda cmd,**kw:commands.append(cmd)
        obj.http=lambda *a,**k:(503,b'')
        obj.save=lambda name,data:saved.update({name:data})
        self.assertEqual(obj.retain_failure(r.market.GuardFailure('failure')),'closed')
        self.assertIn(r.PUBLIC_BASELINE,commands[0]);self.assertNotIn('releases/'+r.BASELINE,commands[0])
        proof=saved['failure-context.json']
        self.assertTrue(proof['deployment_lock_retained']);self.assertFalse(proof['automatic_rollback_started'])
        commands.clear()
        self.assertEqual(obj.retain_failure(r.market.CommandUncertain('failure')),'unknown')
        self.assertEqual(commands,[])

    def test_api_artifacts_pin_both_candidate_and_rollback_image(self):
        obj=object.__new__(r.Release);obj.sha='a'*40
        obj.file_hashes=lambda paths:{path:'hash' for path in paths}
        obj.rollback_artifacts=lambda:{'baseline':'hash'}
        obj.protected_policy=lambda:{'policy':'hash'}
        images={obj.sha:{'Id':'sha256:new','Config':{'Labels':{'org.opencontainers.image.revision':obj.sha}}},
                r.BASELINE:{'Id':'sha256:old','Config':{'Labels':{'org.opencontainers.image.revision':r.BASELINE}}}}
        obj.remote=lambda command:json.dumps(images[command.rsplit(':',1)[1]])
        proof=obj.api_artifacts()
        self.assertEqual(proof['image_id'],'sha256:new')
        self.assertEqual(proof['rollback_image_id'],'sha256:old')
        images[r.BASELINE]['Id']='sha256:replaced'
        self.assertNotEqual(obj.api_artifacts(),proof)
        images[r.BASELINE]['Config']['Labels']['org.opencontainers.image.revision']='wrong'
        with self.assertRaises(r.market.GuardFailure):obj.api_artifacts()
        source=inspect.getsource(r.Release.rollback)
        self.assertIn("proof['artifacts']['rollback_image_id']",source)
        self.assertIn("quote('{{.Image}}')",source)

    def test_rollback_rejects_missing_owner_before_remote_mutations(self):
        obj=object.__new__(r.Release);obj.args=SimpleNamespace(owner_id=None)
        obj.remote=lambda *a,**k:self.fail('Remote mutation before ownership proof')
        with self.assertRaises(r.market.GuardFailure):obj.rollback()

    def test_apply_and_rollback_keep_backup_lock_data_acl_and_two_cas(self):
        for method in [r.Release.prepare,r.Release.apply,r.Release.rollback]:
            source=inspect.getsource(method)
            for forbidden in ['owner_migration_program',' run --rm','acl_restore_sql','provision --','runtime_grants(']:
                self.assertNotIn(forbidden,source)
        for method in [r.Release.apply,r.Release.rollback]:
            source=inspect.getsource(method)
            self.assertIn("self.switch(market.REMOTE+'/public-https/current'",source)
            self.assertIn('self.verify_data(before)',source)
            self.assertIn("--no-deps --wait",source)
        source=inspect.getsource(r.Release.apply)
        self.assertLess(source.index('self.backup_restore('),source.index("+' up -d --no-deps --wait --wait-timeout 120 api'"))
        self.assertIn("self.public_artifacts(self.sha,mounted=False)",source)
        self.assertIn("'/v1/customer-checkout/catalog',public=False",source)
        self.assertLess(source.index("'/v1/customer-checkout/catalog',public=False"),source.index("self.phase = 'reopening'"))
        self.assertIn('base.Release.verify_environment(',inspect.getsource(r.Release.rollback))

if __name__=='__main__':unittest.main()
