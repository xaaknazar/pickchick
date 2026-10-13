import importlib.util
from pathlib import Path
import unittest

path=Path(__file__).resolve().parents[2]/'infra/staging/release-device-center.py'
spec=importlib.util.spec_from_file_location('device_center_release_test',path)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class DeviceCenterReleaseTests(unittest.TestCase):
    def test_only_adds_one_api_flag_and_preserves_neighbor(self):
        text='services:\n  api:\n    environment:\n      APP_ENV: staging\n      WORKFORCE_ENABLED: "true"\n  provision:\n    environment:\n      APP_ENV: staging\n'
        out=m.compose_candidate(text,m.digest(text.encode()))
        self.assertEqual(out.replace('      DEVICE_CENTER_ENABLED: "true"\n',''),text)
        self.assertEqual(out.count('DEVICE_CENTER_ENABLED'),1)
        self.assertNotIn('DEVICE_CENTER_ENABLED',out.split('  provision:')[1])
        with self.assertRaises(m.market.GuardFailure):m.compose_candidate(out,m.digest(out.encode()))
        with self.assertRaises(m.market.GuardFailure):m.compose_candidate(text,'a'*64)
    def test_guarded_baseline(self):
        self.assertEqual(m.BASELINE,'ad7132fa5f4ae93bfa0693c8dd5e790c885d0201')
        self.assertEqual(m.MIGRATION,'058_cloud_device_center.sql')
        self.assertEqual(m.FLAG,'DEVICE_CENTER_ENABLED')

if __name__=='__main__':unittest.main()
