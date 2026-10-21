import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
import tempfile
import json
ROOT = Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('cloud1021_test', ROOT/'infra/staging/release-cloud-migrations-1021.py')
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)

class Guards(unittest.TestCase):
    def test_flags_fail_closed(self):
        m.check_flags({})
        m.check_flags({k:m.digest(b'false') for k in m.FLAGS})
        for k in m.FLAGS:
            with self.assertRaises(m.market.GuardFailure):m.check_flags({k:m.digest(b'true')})
    def test_source_only_tooling(self):
        m.check_source_delta(m.SUPPORT)
        for name in ['services/api/src/index.ts','db/cloud/migrations/060_cloud_combo_rewards.sql','infra/staging/compose.yaml','pnpm-lock.yaml']:
            with self.assertRaises(m.market.GuardFailure):m.check_source_delta([name])
    def test_backup_requires_all_proofs(self):
        proof=dict(ok=True, checksum='verified', migration='058_cloud_device_center.sql',rehearsal='passed',rollback='passed')
        m.verify_receipt(proof)
        for key in proof:
            with self.assertRaises(m.market.GuardFailure):m.verify_receipt({k:v for k,v in proof.items() if k!=key})
    def test_cli_mutations_opt_in(self):
        options=['apply']
        for name in ['sha','branch','expected-api-sha','expected-public-sha','expected-api-image','expected-compose-sha256','expected-gateway-sha256','ssh-key']:
            options += ['--'+name,'value']
        self.assertFalse(m.parse(options).apply)
        self.assertTrue(m.parse(options+['--apply']).apply)
    def test_failed_rehearsal_prevents_live_owner_call(self):
        with tempfile.TemporaryDirectory() as d:
            r=m.Release.__new__(m.Release);r.sha='a'*40;r.private=Path(d);r.args=SimpleNamespace(apply=True)
            proof={'sha':r.sha,'artifacts':'verified','before':{'runtime':'unchanged'},'acl':[]}
            (r.private/'prepared.json').write_text(json.dumps(proof))
            r.artifacts=lambda:'verified';r.runtime=lambda:proof['before'];r.acl=lambda:[]
            r.ledger=lambda:['058'];r.expected_ledger=lambda:['058']
            calls=[];r.owner=lambda action:calls.append(action)
            def failed(acl):raise m.market.GuardFailure('restore failed')
            r.backup_restore=failed
            with self.assertRaises(m.market.GuardFailure):r.apply()
            self.assertEqual(calls,[])
            self.assertFalse((r.private/'apply-attempt.json').exists())
    def test_ci_refuses_failed_or_incomplete_jobs(self):
        sha='a'*40
        proof={'run':{'head_sha':sha,'status':'completed','conclusion':'success','path':'.github/workflows/ci.yml','head_repository':{'full_name':'xaaknazar/pickchick'}},'jobs':{'total_count':1,'jobs':[{'name':'guard','head_sha':sha,'status':'completed','conclusion':'success'}]}}
        m.market.verify_ci(proof,sha,{'guard'},exact_jobs=True)
        proof['jobs']['jobs'][0]['conclusion']='failure'
        with self.assertRaises(m.market.GuardFailure):m.market.verify_ci(proof,sha,{'guard'},exact_jobs=True)
    def test_owner_command_pins_current_image_and_readonly_mounts(self):
        r=m.Release.__new__(m.Release);r.stage='/candidate';calls=[]
        r.remote=lambda command,**kw:calls.append((command,kw)) or '{}'
        r.owner('inspect-060')
        command=calls[0][0]
        self.assertIn(m.BASELINE,command)
        self.assertIn('CUSTOMER_COMBO_REWARDS_ENABLED=false',command)
        self.assertIn(':/app/db/cloud/migrations:ro',command)
        self.assertNotIn(' up ',command)
        with self.assertRaises(m.market.GuardFailure):r.owner('anything')

if __name__=='__main__':unittest.main()
