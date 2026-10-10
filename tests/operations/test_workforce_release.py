import importlib.util
from pathlib import Path
import unittest
import tempfile
from types import SimpleNamespace
from unittest.mock import Mock
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
 def test_backup_uses_this_macs_recipient_and_restores_only_isolated_database(self):
  with tempfile.TemporaryDirectory() as tmp:
   key=Path(tmp)/'identity';key.write_bytes(b'synthetic-key');key.chmod(0o600)
   obj=object.__new__(w.Release);obj.args=SimpleNamespace(backup_identity=key)
   obj.execute=Mock(return_value=('age1'+'q'*58).encode())
   obj.ledger=Mock(return_value=[{'version':'synthetic'}]);obj.table_names=Mock(return_value=['synthetic'])
   calls=[]
   obj.remote=Mock(side_effect=lambda command,**kw:calls.append((command,kw)) or 'a'*64+'  backup')
   result=obj.backup_restore()
   self.assertEqual(result['restore'],'passed')
   commands='\n'.join(c[0] for c in calls)
   self.assertNotIn('backup-recipient.txt',commands)
   self.assertIn('age1'+'q'*58,commands)
   self.assertNotIn('synthetic-key',commands)
   restore=next(c for c in calls if 'pg_restore' in c[0])
   self.assertIn('-d pickchick_restore_workforce_',restore[0]);self.assertEqual(restore[1]['input'],b'synthetic-key')
   self.assertIn('dropdb',calls[-2][0])
 def test_failed_restore_cleans_only_its_isolated_database_and_stops(self):
  with tempfile.TemporaryDirectory() as tmp:
   key=Path(tmp)/'identity';key.write_bytes(b'synthetic-key');key.chmod(0o600)
   obj=object.__new__(w.Release);obj.args=SimpleNamespace(backup_identity=key)
   obj.execute=Mock(return_value=('age1'+'q'*58).encode());obj.ledger=Mock(return_value=[]);obj.table_names=Mock(return_value=[])
   calls=[]
   def remote(command,**kw):
    calls.append(command)
    if 'pg_restore' in command:raise w.market.GuardFailure('Synthetic restore failed')
    return ''
   obj.remote=remote
   with self.assertRaises(w.market.GuardFailure):obj.backup_restore()
   self.assertIn('dropdb -U postgres pickchick_restore_workforce_',calls[-1])
   self.assertFalse(any('up -d' in c for c in calls))
if __name__=='__main__':unittest.main()
