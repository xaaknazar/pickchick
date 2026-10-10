import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('workforce_release',Path(__file__).resolve().parents[2]/'infra/staging/release-workforce.py')
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
class WorkforceReleaseTests(unittest.TestCase):
 def test_compose_preserves_every_existing_value(self):
  text='services:\n  api:\n    environment:\n      APP_ENV: staging\n      CUSTOMER_CHECKOUT_HEAD_GUARD: "true"\n  worker:\n    environment:\n      APP_ENV: staging\n'
  result=w.compose_candidate(text,w.digest(text.encode()))
  self.assertEqual(result.replace('      WORKFORCE_ENABLED: "true"\n',''),text)
  with self.assertRaises(w.market.GuardFailure):w.compose_candidate(result,w.digest(result.encode()))
  with self.assertRaises(w.market.GuardFailure):w.compose_candidate(text,'0'*64)
 def test_no_device_privileges(self):
  self.assertTrue(all(t.startswith('bo_workforce_') for t,c,p in w.PRIVILEGES))
  self.assertFalse(any(p in ('DELETE','TRUNCATE') for t,c,p in w.PRIVILEGES))
  self.assertFalse(any(t=='bo_workforce_events' and p=='UPDATE' for t,c,p in w.PRIVILEGES))
 def test_mutations_need_explicit_apply(self):
  args=w.parse(['prepare','--sha','a'*40,'--branch','codex/workforce','--expected-api-sha',w.BASELINE,'--expected-public-sha','b'*40,'--expected-api-image','sha256:'+'c'*64,'--expected-compose-sha256','d'*64,'--expected-gateway-sha256','e'*64,'--ssh-key','/tmp/synthetic'])
  self.assertFalse(args.apply)
if __name__=='__main__':unittest.main()
