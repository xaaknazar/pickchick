import importlib.util
from pathlib import Path
import unittest
p=Path(__file__).resolve().parents[2]/'infra/staging/activate-device-center.py'
s=importlib.util.spec_from_file_location('center_activation_test',p)
a=importlib.util.module_from_spec(s);s.loader.exec_module(a)
class ActivationTests(unittest.TestCase):
    def test_scoped_flag_preserves_other_service_and_rejects_replay(self):
        text='services:\n  api:\n    environment:\n      DEVICE_CENTER_ENABLED: "true"\n      APP_ENV: staging\n  provision:\n    environment:\n      APP_ENV: staging\n'
        result=a.candidate(text,a.digest(text.encode()))
        self.assertEqual(result.replace('      BACKOFFICE_DEVICE_ACCESS_ENABLED: "true"\n',''),text)
        self.assertNotIn(a.FLAG,result.split('  provision:')[1])
        with self.assertRaises(a.m.GuardFailure):a.candidate(result,a.digest(result.encode()))
        with self.assertRaises(a.m.GuardFailure):a.candidate(text,'a'*64)
    def test_acl_does_not_grant_secrets_or_payments(self):
        sql=a.grant_sql()
        self.assertTrue(sql.startswith('BEGIN;'))
        self.assertTrue(sql.endswith('COMMIT;'))
        self.assertNotIn('REVOKE',sql)
        self.assertNotIn('device_credentials',sql)
        self.assertNotIn('kiosk_devices',sql)
        self.assertNotIn('commerce_',sql)
        self.assertNotIn('DELETE',sql)
        self.assertEqual(len(a.ADDITIONS),14)
if __name__=='__main__':unittest.main()
