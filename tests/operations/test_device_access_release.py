import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('device_access_release',ROOT/'infra/staging/release-device-access.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)

class DevicesRelease(unittest.TestCase):
    def test_compose_changes_api_only_and_preserves_mobile_guard_and_banks(self):
        text='services:\n  api:\n    environment:\n      CUSTOMER_CHECKOUT_HEAD_GUARD: "true"\n      APP_ENV: staging\n  provision:\n    environment:\n      APP_ENV: staging\n  bank:\n    image: unchanged\n'
        out=r.compose_candidate(text,r.digest(text.encode()))
        line=f'      {r.FLAG}: "false"\n'
        self.assertEqual(out.replace(line,'',1),text)
        self.assertLess(out.index(line),out.index('  provision:'))
        self.assertEqual(r.compose_flag(r.compose_flag(out,True),False),out)
        for bad in [text.replace('  api:','  api_other:'),out]:
            with self.assertRaises(r.GuardFailure):r.compose_candidate(bad,r.digest(bad.encode()))
        with self.assertRaises(r.GuardFailure):r.compose_candidate(text,'0'*64)
        with self.assertRaises(r.GuardFailure):r.compose_flag(out,False)

    def test_gateway_updates_only_two_matchers_preserving_other_routes(self):
        import subprocess
        old=subprocess.check_output(['git','show',r.ANCHOR+':infra/public-staging/gateway.Caddyfile'],cwd=ROOT).decode()
        new=(ROOT/'infra/public-staging/gateway.Caddyfile').read_text()
        live=old+'\n# preserved custom operational boundary\n'
        out=r.gateway_candidate(live,r.digest(live.encode()),old,new)
        self.assertTrue(out.endswith('# preserved custom operational boundary\n'))
        changed=[(a,b) for a,b in zip(live.splitlines(),out.splitlines()) if a!=b]
        self.assertEqual(len(changed),2)
        self.assertTrue(all('path_regexp backoffice_' in a and '/devices' in b for a,b in changed))
        with self.assertRaises(r.GuardFailure):r.gateway_candidate(out,r.digest(out.encode()),old,new)

    def test_public_tree_rejects_unrelated_or_extra_bo_bytes(self):
        before={'mobile/app.js':'m','kitchen/app.js':'k','backoffice/app.js':'old','.release.json':'before'}
        after={**before,'backoffice/app.js':'new','.release.json':'after'}
        r.verify_tree(before,after,{'backoffice/app.js':'new'})
        for bad in [{**after,'kitchen/app.js':'foreign'},{**after,'backoffice/secret.txt':'extra'},dict(after,unknown='file')]:
            with self.assertRaises(r.GuardFailure):r.verify_tree(before,bad,{'backoffice/app.js':'new'})

    def proof(self):
        return {'format':'pickchick-device-access-prepared-v1','source_sha':'a'*40,'branch_id':'branch','edge_device_id':'edge',
                'schema':20,'migrationChecksum020':'b'*64,'runtime_verified':True,'grants_verified':True,
                'worker':{'installed':True,'script_sha256':'c'*64,'enabled':False,'running':False},
                'link':{'verified':True},'completed_epoch':1000}

    def test_windows_requires_real_same_source_branch_schema_and_installation(self):
        proof=self.proof();r.check_windows(proof,'a'*40,'branch','edge','b'*64,now=1100)
        for key,value in [('source_sha','d'*40),('branch_id','other'),('schema',19),('migrationChecksum020','e'*64),
                          ('runtime_verified',False),('grants_verified',False),('completed_epoch',-22000),('completed_epoch',1200),
                          ('worker',{'installed':False}),('link',{'verified':False})]:
            with self.subTest(key=key),self.assertRaises(r.GuardFailure):r.check_windows({**proof,key:value},'a'*40,'branch','edge','b'*64,now=1100)

    def fake(self,directory,apply=False):
        x=object.__new__(r.Release);x.sha='a'*40;x.private=Path(directory);x.args=types.SimpleNamespace(apply=apply,backup_identity=None)
        x.profile=types.SimpleNamespace(old_api='b'*40,old_web='c'*40);x.branch_id='branch'
        before={'neighbors':{'bank':'same'},'compose':'same','environment':{},'acl':[]}
        proof={'sha':x.sha,'api_baseline':x.profile.old_api,'public_baseline':x.profile.old_web,'before':before,'artifacts':{'image':'image'}}
        x.prepared=Mock(return_value=proof);x.baseline=Mock(return_value=before);x.artifacts=Mock(return_value=proof['artifacts'])
        x.plan=Mock();x.remote=Mock();x.owner=Mock();x.save=Mock();return x,proof

    def test_apply_readonly_does_not_backup_migrate_or_restart(self):
        with tempfile.TemporaryDirectory() as d:
            x,_=self.fake(d);x.backup_restore=Mock();x.apply()
            x.plan.assert_called_once();x.backup_restore.assert_not_called();x.owner.assert_not_called();x.remote.assert_not_called();x.save.assert_not_called()

    def test_apply_backup_before_dispatch_and_no_replay_after_unknown(self):
        with tempfile.TemporaryDirectory() as d:
            x,_=self.fake(d,True);key=Path(d)/'key';key.write_text('synthetic');key.chmod(0o600);x.args.backup_identity=key
            calls=[]
            x.backup_restore=lambda:calls.append('backup_restore') or {'restore':'passed'}
            def save(name,value):calls.append(name);(Path(d)/name).write_text(json.dumps(value))
            x.save=save
            def owner(action):calls.append('owner');raise r.market.CommandUncertain('Unknown remote completion')
            x.owner=owner
            with self.assertRaises(r.market.CommandUncertain):x.apply()
            self.assertLess(calls.index('backup_restore'),calls.index('apply-attempt.json'));self.assertLess(calls.index('apply-attempt.json'),calls.index('owner'))
            with self.assertRaisesRegex(r.GuardFailure,'no replay'):x.apply()
            self.assertEqual(calls.count('owner'),1);x.remote.assert_not_called()

    def test_backup_failure_prevents_migration(self):
        with tempfile.TemporaryDirectory() as d:
            x,_=self.fake(d,True);key=Path(d)/'key';key.write_text('synthetic');key.chmod(0o600);x.args.backup_identity=key
            x.backup_restore=Mock(return_value={'restore':'failed'})
            with self.assertRaisesRegex(r.GuardFailure,'restore not confirmed'):x.apply()
            x.owner.assert_not_called();x.remote.assert_not_called()

    def test_failed_action_retains_stock_owned_lock(self):
        with tempfile.TemporaryDirectory() as d:
            x,_=self.fake(d,True);x.args.action='apply';x.remote=Mock(return_value='');x.save=Mock()
            with self.assertRaises(RuntimeError):
                with x.deployment_lock():raise RuntimeError('Synthetic failure')
            self.assertEqual(x.remote.call_count,1)
            self.assertIn('os.mkdir',x.remote.call_args.args[0]);self.assertNotIn('os.rmdir',x.remote.call_args.args[0])

    def test_cli_requires_pins_ci_and_defaults_readonly(self):
        args=r.parse(['prepare','--sha','a'*40,'--branch','codex/test','--branch-id','a'*8+'-aaaa-4aaa-8aaa-'+'a'*12,
                      '--expected-api-sha',r.ANCHOR,'--expected-public-sha','b'*40,'--expected-api-image','sha256:'+'c'*64,
                      '--expected-compose-sha256','d'*64,'--expected-gateway-sha256','e'*64,'--ssh-key','/synthetic/key','--ci-run','1'])
        self.assertFalse(args.apply);r.check_pins(args)
        args.expected_api_image='latest'
        with self.assertRaises(r.GuardFailure):r.check_pins(args)

if __name__=='__main__':unittest.main()
