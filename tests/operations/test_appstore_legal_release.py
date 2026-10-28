import importlib.util
from pathlib import Path
import json, sys, unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('legal_runtime_test',ROOT/'infra/staging/appstore-legal-release.py')
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
class LegalReleaseTests(unittest.TestCase):
    def test_only_api_image_and_consent_version_change(self):
        before={'services':{'api':{'image':'pickchick-api:'+m.BASELINE,'environment':{m.CONSENT:'pilot-2026-09-26','SYNTHETIC':'unchanged'}},'worker':{'image':'old'}}}
        after=json.loads(m.compose_candidate(json.dumps(before),'a'*40))
        self.assertEqual(after['services']['worker'],before['services']['worker'])
        after['services']['api']['image']=before['services']['api']['image']
        after['services']['api']['environment'][m.CONSENT]='pilot-2026-09-26'
        self.assertEqual(after,before)
        with self.assertRaises(m.market.GuardFailure):m.compose_candidate(json.dumps({'services':{}}),'a'*40)
    def test_no_unrelated_runtime_or_flags(self):
        m.check_delta(m.RUNTIME)
        for path in ['services/api/src/main.ts','packages/commerce-core/src/order.ts','pnpm-lock.yaml','db/cloud/migrations/069.sql']:
            with self.assertRaises(m.market.GuardFailure):m.check_delta([path])
        with self.assertRaises(m.market.GuardFailure):m.check_flags({'CUSTOMER_COMBO_REWARDS_ENABLED':m.digest(b'true')})
    def test_backup_and_rehearsal_required(self):
        with self.assertRaises(m.market.GuardFailure):m.check_receipt({'ok':True,'restore':'passed'})
        env=m.rehearsal_environment({},'a'*64,'b'*64,'c'*40)
        self.assertEqual(env[m.CONSENT],m.LEGAL_VERSION)
if __name__=='__main__':unittest.main()
