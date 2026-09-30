import importlib.util
from pathlib import Path
import sys
import tempfile
import subprocess
import shlex
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('kaspi_checkout_release',ROOT/'infra/staging/release-kaspi-checkout.py')
r=importlib.util.module_from_spec(spec);sys.modules[spec.name]=r;spec.loader.exec_module(r)

class CheckoutRelease(unittest.TestCase):
 def test_exact_migrations_and_preserved_fiscal_data(self):
  names=[p.name for p in sorted((ROOT/'db/cloud/migrations').glob('*.sql'))]
  self.assertEqual(names[20:],list(r.MIGRATIONS))
  self.assertEqual(r.Release.new_tables-r.pilot.NEW_TABLES,{'commerce_kaspi_invoices'})
  self.assertEqual(r.Release.additions['commerce_orders'],['fiscal_policy','fiscal_deferral_reference'])
  self.assertEqual(len(r.pilot.MIGRATIONS),5)
 def test_gateway_keeps_existing_routes_and_bounded_wait(self):
  old=(ROOT/'infra/public-staging/gateway.Caddyfile').read_text()
  auth=r.pilot.extend_gateway(old,'172.18.0.4')
  new=r.extend_checkout(auth)
  self.assertIn('response_header_timeout 25s',new)
  self.assertIn('header Cache-Control no-store',new)
  self.assertIn('not path /v1/customer-checkout/* /v1/auth/*',new)
  for marker in ['\t@health {','\t@test_post {']:
   self.assertEqual(auth[auth.index(marker):],new[new.index(marker):])
  with self.assertRaises(r.market.GuardFailure):r.extend_checkout(new)
 def test_preparation_cannot_activate_payments(self):
  # Execute the actual remote text transformer on a disposable compose; no SSH.
  from unittest.mock import patch
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp)/'infra/staging/compose.yaml';p.parent.mkdir(parents=True)
   p.write_text('      APP_ENV: staging\n      APP_ENV: staging\n')
   obj=object.__new__(r.Release)
   obj.remote=lambda command:subprocess.check_output(shlex.split(command),text=True)
   with patch.object(r.pilot.Release,'prepare_api',lambda *a:None):obj.prepare_api(tmp)
   self.assertEqual(p.read_text().count('CUSTOMER_KASPI_PILOT_ENABLED: "false"'),2)
   self.assertNotIn('true',p.read_text())
if __name__=='__main__':unittest.main()
