import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock
spec=importlib.util.spec_from_file_location('workforce_edit_release',Path(__file__).resolve().parents[2]/'infra/staging/release-workforce-edit.py')
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
class WorkforceEditReleaseTests(unittest.TestCase):
 def test_compose_is_byte_preserved_and_wrong_baseline_rejected(self):
  text='services:\n  api:\n    environment:\n      WORKFORCE_ENABLED: "true"\n      BANK_SETTING: keep\n'
  self.assertEqual(w.compose_candidate(text,w.digest(text.encode())),text)
  with self.assertRaises(w.market.GuardFailure):w.compose_candidate(text,'0'*64)
  with self.assertRaises(w.market.GuardFailure):w.compose_candidate('empty',w.digest(b'empty'))
 def test_rollback_refuses_old_reader_after_deletion(self):
  release=object.__new__(w.Release)
  release.remote=Mock(return_value='{"n":1}')
  with self.assertRaises(w.market.GuardFailure):release.compatible_rollback()
  release.remote=Mock(return_value='{"n":0}')
  release.compatible_rollback()
 def test_no_mutation_without_apply(self):
  args=w.w.parse(['apply','--sha','a'*40,'--branch','codex/workforce-edit','--expected-api-sha',w.BASELINE,'--expected-public-sha','b'*40,'--expected-api-image','sha256:'+'c'*64,'--expected-compose-sha256','d'*64,'--expected-gateway-sha256','e'*64,'--ssh-key','/tmp/synthetic'])
  self.assertFalse(args.apply)
if __name__=='__main__':unittest.main()
