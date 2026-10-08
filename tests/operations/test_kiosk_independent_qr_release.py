import copy
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('independent_qr_test', ROOT/'infra/staging/release-kiosk-independent-qr.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)


class IndependentQRRelease(unittest.TestCase):
    def test_exact_baseline_schema_ci_and_no_environment_delta(self):
        with tempfile.TemporaryDirectory() as folder:
            env = Path(folder).resolve()/'env.json'; env.write_text('{}'); env.chmod(0o600)
            args = SimpleNamespace(environment=env,expected_api_sha=r.BASELINE,expected_public_sha=r.BASELINE,expected_gateway_sha256=r.GATEWAY)
            with patch.object(r.sys,'version_info',(3,12)),patch.object(r.market.Release,'__init__') as init:
                r.Release(args)
                profile = init.call_args.args[2]
                self.assertEqual(len(profile.ci_jobs),11)
                self.assertTrue(profile.exact_ci_jobs)
                self.assertEqual(profile.baseline_count,43)
                self.assertEqual(profile.migrations,tuple(r.MIGRATIONS))
                env.write_text('{"KIOSK_CHECKOUT_MAX_MINOR":"1"}')
                with self.assertRaises(r.market.GuardFailure): r.Release(args)
        for name,hash in r.MIGRATIONS.items():
            self.assertEqual(r.digest((ROOT/'db/cloud/migrations'/name).read_bytes()),hash)

    def test_worker_only_image_changes_and_original_compose_required(self):
        original = {'name':'qr-fixture','services':{'worker':{'image':'pickchick-api:'+r.BASELINE,'network_mode':'container:pickchick-kaspi-bridge','volumes':['original-session:/run/session:ro'],'command':['node','qr-worker.js']}}}
        raw = json.dumps(original)
        with patch.dict(r.WORKER_HASHES,{r.BANK_DIR+'/worker-compose.json':r.digest(raw.encode())}):
            actual = json.loads(r.worker_candidate(raw,'a'*40))
            expected = copy.deepcopy(original); expected['services']['worker']['image']='pickchick-api:'+'a'*40
            self.assertEqual(actual,expected)
            with self.assertRaises(r.market.GuardFailure): r.worker_candidate(raw+' ', 'a'*40)

    def test_gateway_and_api_compose_preserved_byte_for_byte(self):
        with patch.object(r,'GATEWAY',r.digest(b'gateway')),patch.object(r,'COMPOSE_HASH',r.digest(b'compose')):
            self.assertEqual(r.unchanged_gateway('gateway',r.GATEWAY),'gateway')
            self.assertEqual(r.unchanged_compose('compose',{}),'compose')
            with self.assertRaises(r.market.GuardFailure): r.unchanged_gateway('changed',r.GATEWAY)
            with self.assertRaises(r.market.GuardFailure): r.unchanged_compose('compose',{'BANK':'on'})

    def test_neighbors_exclude_only_reviewed_qr_worker(self):
        original = {'containers':{r.WORKER:'old-qr','pickchick-kaspi-bridge':'bank','pickchick-kaspi-worker':'mobile','other':'unrelated'},'idrink_caddy_sha256':'unchanged'}
        obj = object.__new__(r.Release)
        with patch.object(r.market.Release,'fingerprint',return_value=copy.deepcopy(original)):
            expected=copy.deepcopy(original);expected['containers'].pop(r.WORKER)
            self.assertEqual(obj.fingerprint(),expected)
        with patch.object(r.market.Release,'fingerprint',return_value={'containers':{}}):
            with self.assertRaises(r.market.GuardFailure): obj.fingerprint()

    def test_data_verification_rejects_acl_or_ledger_drift(self):
        obj=object.__new__(r.Release)
        obj.ledger=lambda:[{'version':n,'scope':'cloud','checksum':h} for n,h in r.MIGRATIONS.items()]
        obj.compare_runtime=lambda before:None
        obj.acl=lambda:[];obj.worker_acl=lambda:[]
        before={'ledger':[],'acl':[],'worker_acl':[]}
        obj.verify_data(before)
        obj.worker_acl=lambda:['unexpected permission']
        with self.assertRaises(r.market.GuardFailure):obj.verify_data(before)

    def test_rollback_retains_migration_and_blocks_new_money(self):
        obj=object.__new__(r.Release)
        before={'ledger':[],'runtime_data':{'tables':{'commerce_captures':{'rows':1,'sha256':'old'}},'sequences':[]},'availability':[]}
        current=copy.deepcopy(before['runtime_data'])
        obj.ledger=lambda:[{'version':n,'scope':'cloud','checksum':h} for n,h in r.MIGRATIONS.items()]
        obj.runtime_snapshot=lambda:current;obj.availability_rows=lambda:[]
        self.assertEqual(len(obj.retained_rollback_snapshot(before)[0]),1)
        current['tables']['commerce_captures']['rows']=2
        with self.assertRaises(r.market.GuardFailure):obj.retained_rollback_snapshot(before)


if __name__ == '__main__': unittest.main()
