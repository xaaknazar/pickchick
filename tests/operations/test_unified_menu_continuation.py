import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import types
import unittest
from unittest.mock import Mock

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('continuation',ROOT/'infra/staging/continue-unified-menu.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
SHA='a'*40
BRANCH='10000000-0000-4000-8000-000000000003'
EDGE='10000000-0000-4000-8000-000000000004'
RELEASE='10000000-0000-4000-8000-000000000005'

class Continuation(unittest.TestCase):
    def snapshot(self):
        return {'devices':[EDGE],'state':{'device_id':EDGE,'active_release_id':RELEASE,'active_version':6,'age_seconds':1},
                'head':7,'unacked':0,'menu':{'release_id':RELEASE,'version':6,'checksum':'b'*64,'device_id':EDGE,
                    'catalog_version':7,'applied':True,'activated':True}}

    def test_head_is_real_applied_release_not_equal_catalog_version_assumption(self):
        head=r.check_head(self.snapshot(),BRANCH,SHA)
        self.assertEqual(head['menu_version'],6);self.assertEqual(head['catalog_version'],7)
        for key,value in [('release_id','other'),('version',9),('catalog_version',6),('applied',False),('activated',False),('checksum','bad')]:
            bad=self.snapshot();bad['menu'][key]=value
            with self.subTest(key=key),self.assertRaises(r.GuardFailure):r.check_head(bad,BRANCH,SHA)
        for key,value in [('unacked',1),('devices',[EDGE,'other'])]:
            with self.assertRaises(r.GuardFailure):r.check_head({**self.snapshot(),key:value},BRANCH,SHA)
        bad=self.snapshot();bad['state']['age_seconds']=121
        with self.assertRaises(r.GuardFailure):r.check_head(bad,BRANCH,SHA)

    def test_menu_head_method_executes_query_and_checks_heartbeat(self):
        obj=object.__new__(r.Release);obj.sha=SHA;obj.branch_id=BRANCH
        obj.edge_snapshot=Mock(side_effect=lambda:self.snapshot());obj.json_query=Mock(return_value=self.snapshot()['menu'])
        obj.heartbeat=Mock(return_value={'protocol4':True,'device_matches':True,'age_seconds':2})
        self.assertEqual(obj.menu_head()['menu_release_id'],RELEASE)
        self.assertIn(BRANCH,obj.json_query.call_args.args[0])
        for bad in [None,{'protocol4':False,'device_matches':True,'age_seconds':1},{'protocol4':True,'device_matches':False,'age_seconds':1},{'protocol4':True,'device_matches':True,'age_seconds':31}]:
            obj.heartbeat.return_value=bad
            with self.assertRaises(r.GuardFailure):obj.menu_head()

    def test_actual_compose_cas_preserves_inode_backup_and_refuses_foreign_bytes(self):
        import subprocess
        with tempfile.TemporaryDirectory() as d:
            obj=object.__new__(r.Release);obj.sha=SHA;path=Path(d)/'compose.yaml';backup=Path(d)/'previous'
            original='flag: false\nneighbor: preserved\n';candidate=original.replace('false','true');path.write_text(original)
            inode=path.stat().st_ino;obj.compose_path=lambda _:str(path)
            obj.remote=lambda command,input:subprocess.run(['bash','-c',command],input=input,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True)
            obj.compose_cas(original,candidate,str(backup))
            self.assertEqual(path.read_text(),candidate);self.assertEqual(path.stat().st_ino,inode)
            self.assertEqual(backup.read_text(),original);self.assertEqual(backup.stat().st_mode&0o777,0o600)
            with self.assertRaises(subprocess.CalledProcessError):obj.compose_cas(original,candidate,str(Path(d)/'foreign-backup'))
            self.assertFalse((Path(d)/'foreign-backup').exists());self.assertEqual(path.read_text(),candidate)

    def proof(self):
        return {'format':'pickchick-remote-stops-windows-ready-v1',**r.check_head(self.snapshot(),BRANCH,SHA),'schema':20,
                'protocol':4,'menu_sync_mode':'apply','remote_stops_enabled':True,'runtime_verified':True,'grants_verified':True,
                'env_before_sha256':'c'*64,'env_after_sha256':'d'*64,'completed_epoch':1000}

    def test_windows_rejects_foreign_schema_source_stale_or_unapplied_menu(self):
        head=r.check_head(self.snapshot(),BRANCH,SHA);proof=self.proof();r.check_windows(proof,head,1100)
        for key,value in [('schema',19),('source_sha','e'*40),('branch_id',EDGE),('protocol',3),('menu_sync_mode','report'),
                          ('remote_stops_enabled',False),('runtime_verified',False),('grants_verified',False),('menu_hash','f'*64),('menu_release_id',EDGE),
                          ('catalog_version',99),('env_after_sha256','bad'),('completed_epoch',-25000),('completed_epoch',1200)]:
            with self.subTest(key=key),self.assertRaises(r.GuardFailure):r.check_windows({**proof,key:value},head,1100)

    def env(self):
        out={r.u.FLAG_KEYS[k]:r.digest(('false' if k in r.PHASES else 'true').encode()) for k in r.u.FLAG_KEYS}
        out.update({k:r.digest(b'true') for k in ['BACKOFFICE_DEVICE_ACCESS_ENABLED','CUSTOMER_CHECKOUT_HEAD_GUARD','BACKOFFICE_ENABLED','CATALOG_ADMIN_ENABLED']})
        out[r.u.BRANCH_KEY]=r.digest(BRANCH.encode());return out

    def test_order_and_disable_without_windows_or_device_availability(self):
        env=self.env();r.check_flags(env,'remote-stops',True,BRANCH)
        with self.assertRaisesRegex(r.GuardFailure,'before media'):r.check_flags(env,'media-upload',True,BRANCH)
        env[r.u.FLAG_KEYS['remote-stops']]=r.digest(b'true');r.check_flags(env,'media-upload',True,BRANCH)
        env[r.u.FLAG_KEYS['media-upload']]=r.digest(b'true')
        with self.assertRaisesRegex(r.GuardFailure,'Disable media'):r.check_flags(env,'remote-stops',False,BRANCH)
        env['BACKOFFICE_DEVICE_ACCESS_ENABLED']=r.digest(b'false');r.check_flags(env,'media-upload',False,BRANCH)
        env[r.u.FLAG_KEYS['media-upload']]=r.digest(b'false');r.check_flags(env,'remote-stops',False,BRANCH)
        with self.assertRaisesRegex(r.GuardFailure,'Devices'):r.check_flags(env,'media-upload',True,BRANCH)

    def test_compose_round_trip_changes_only_target_flag_preserving_mobile_devices_bank(self):
        text='services:\n  api:\n    environment:\n      CUSTOMER_CHECKOUT_HEAD_GUARD: "true"\n      BACKOFFICE_DEVICE_ACCESS_ENABLED: "true"\n      BACKOFFICE_REMOTE_STOPS_ENABLED: "false"\n      CATALOG_MEDIA_UPLOAD_ENABLED: "false"\n  provision:\n    environment:\n      BACKOFFICE_REMOTE_STOPS_ENABLED: "false"\n      CATALOG_MEDIA_UPLOAD_ENABLED: "false"\n  bank:\n    image: frozen\n'
        for phase in r.PHASES:
            candidate=r.u.compose_flag(text,phase,True)
            self.assertEqual(r.u.compose_flag(candidate,phase,False),text)
            key=r.u.FLAG_KEYS[phase]
            self.assertEqual(candidate.replace(key+': "true"',key+': "false"'),text)
            with self.assertRaises(r.GuardFailure):r.u.compose_flag(candidate,phase,True)

    def fake(self,d,apply=False):
        obj=object.__new__(r.Release);obj.private=Path(d);obj.sha=SHA;obj.branch_id=BRANCH
        obj.args=types.SimpleNamespace(action='remote-stops',apply=apply,plan=None,plan_sha256=None,backup_identity=Path(d)/'key')
        obj.source_checks=Mock(return_value=[]);obj.ci=Mock();obj.source_ledger=[]
        state={'source_sha':SHA,'owner':{'state_digest':'x'},'environment':self.env()}
        obj.baseline=Mock(return_value=state);obj.plan=Mock();obj.remote=Mock();obj.backup_restore=Mock(return_value={'restore':'passed'})
        obj.switch=Mock(return_value={'compose_sha256':'f'*64});obj.events=[]
        def save(name,value):
            obj.events.append(name);p=Path(d)/name;p.write_text(json.dumps(value));p.chmod(0o600)
        obj.save=save
        return obj,state

    def reviewed(self,obj,state):
        p=obj.private/'review.json';p.write_text(json.dumps({'format':'pickchick-unified-menu-continuation-plan-v1','phase':'remote-stops','enabled':True,'completed_epoch':time.time(),'state':state}));p.chmod(0o600)
        obj.args.plan=p;obj.args.plan_sha256=r.digest(p.read_bytes());obj.args.backup_identity.write_text('synthetic');obj.args.backup_identity.chmod(0o600)

    def test_readonly_plan_does_not_backup_lock_or_dispatch(self):
        with tempfile.TemporaryDirectory() as d:
            obj,_=self.fake(d);obj.run();obj.remote.assert_not_called();obj.switch.assert_not_called();obj.backup_restore.assert_not_called()
            self.assertEqual(obj.events,['remote-stops-enable-plan.json'])

    def test_apply_backup_before_single_dispatch_unknown_retains_owned_lock_no_replay(self):
        with tempfile.TemporaryDirectory() as d:
            obj,state=self.fake(d,True);self.reviewed(obj,state)
            def backup():obj.events.append('backup');return {'restore':'passed'}
            obj.backup_restore=backup
            def switch(*_):obj.events.append('switch');raise r.market.CommandUncertain('Synthetic lost response')
            obj.switch=Mock(side_effect=switch)
            with self.assertRaises(r.market.CommandUncertain):obj.run()
            self.assertLess(obj.events.index('backup'),obj.events.index('remote-stops-enable-attempt.json'))
            self.assertLess(obj.events.index('remote-stops-enable-attempt.json'),obj.events.index('switch'))
            self.assertEqual(obj.remote.call_count,1);self.assertIn('os.mkdir',obj.remote.call_args.args[0])
            with self.assertRaisesRegex(r.GuardFailure,'no replay'):obj.run()
            self.assertEqual(obj.switch.call_count,1)

    def test_plan_cas_backup_failure_or_changed_pins_refuse_before_dispatch(self):
        with tempfile.TemporaryDirectory() as d:
            obj,state=self.fake(d,True);self.reviewed(obj,state)
            obj.args.plan_sha256='0'*64
            with self.assertRaisesRegex(r.GuardFailure,'hash differs'):obj.run()
            obj.remote.assert_not_called();obj.switch.assert_not_called()
            obj.args.plan_sha256=r.digest(obj.args.plan.read_bytes());obj.backup_restore.return_value={'restore':'failed'}
            with self.assertRaisesRegex(r.GuardFailure,'restore not confirmed'):obj.run()
            obj.switch.assert_not_called()
        plan={'format':'pickchick-unified-menu-continuation-plan-v1','phase':'remote-stops','enabled':True,'completed_epoch':1000,'state':{'pin':'before'}}
        with self.assertRaises(r.GuardFailure):r.check_plan(plan,{'pin':'after'},'remote-stops',True,1100)
        with self.assertRaises(r.GuardFailure):r.check_plan(plan,plan['state'],'remote-stops',True,2000)

    def test_api_restart_failure_never_revokes_or_retries_owner(self):
        with tempfile.TemporaryDirectory() as d:
            obj,_=self.fake(d);obj.args=types.SimpleNamespace(expected_api_image='image')
            text='      BACKOFFICE_REMOTE_STOPS_ENABLED: "false"\n'*2
            obj.read_text=Mock(return_value=text);obj.compose_cas=Mock();obj.owner=Mock(return_value={'existingDataPreserved':True});obj.remote=Mock(side_effect=r.market.CommandUncertain('Unknown compose'))
            state={'compose_sha256':r.digest(text.encode()),'owner':{'state_digest':'proof'}}
            with self.assertRaises(r.market.CommandUncertain):r.Release.switch(obj,'remote-stops',True,state)
            obj.owner.assert_called_once_with('apply','remote-stops',True,'proof');obj.compose_cas.assert_called_once()

if __name__=='__main__':unittest.main()
