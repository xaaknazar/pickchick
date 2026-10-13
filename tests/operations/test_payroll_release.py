import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
spec=importlib.util.spec_from_file_location('payroll_release',Path(__file__).resolve().parents[2]/'infra/staging/release-payroll.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class PayrollReleaseTests(unittest.TestCase):
 def test_rollback_requires_compatible_empty_new_features(self):
  obj=object.__new__(p.Release);obj.psql=Mock(return_value=json.dumps({'n':1}))
  with self.assertRaises(p.market.GuardFailure):obj.compatible_rollback()
  query=obj.psql.call_args.args[1]
  for value in ['payroll','paid_duration_ms','valid_until','employment_status','position','staff']:self.assertIn(value,query)
  obj.psql.return_value=json.dumps({'n':0});obj.compatible_rollback()
 def test_apply_does_not_mutate_without_explicit_flag(self):
  obj=object.__new__(p.Release);obj.args=SimpleNamespace(apply=False)
  obj.prepared=Mock(return_value={'before':1,'artifacts':2});obj.baseline=Mock(return_value=1);obj.artifacts=Mock(return_value=2)
  obj.plan=Mock();obj.backup_restore=Mock(side_effect=AssertionError('Must not run'))
  obj.apply();obj.plan.assert_called_once();obj.backup_restore.assert_not_called()
 def test_prerequisites_are_ordered_and_compose_unchanged(self):
  self.assertEqual([int(n[:3]) for n in p.MIGRATIONS],[53,54,55,56,57])
  value='services:\n  api:\n    environment:\n      WORKFORCE_ENABLED: "true"\n      APP_ENV: staging\n'
  self.assertEqual(p.e.compose_candidate(value,p.digest(value.encode())),value)
if __name__=='__main__':unittest.main()
