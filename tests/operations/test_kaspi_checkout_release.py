import importlib.util
import hashlib
from pathlib import Path
import sys
import tempfile
import subprocess
import shlex
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('kaspi_checkout_release',ROOT/'infra/staging/release-kaspi-checkout.py')
r=importlib.util.module_from_spec(spec);sys.modules[spec.name]=r;spec.loader.exec_module(r)

def historical_content_gateway():
 # Pin the canonical content-enabled gateway at the schema020 API baseline,
 # rather than feeding later farm/director changes into a historical transformer.
 path=ROOT/'tests/operations/fixtures/kaspi-checkout-content-gateway.Caddyfile'
 raw=path.read_bytes()
 assert hashlib.sha256(raw).hexdigest() == '1b9913e18bb7730222b908cca461fb79d42e37122ef9bccc9fd7a5f748f18d5c'
 return raw.decode()

class CheckoutRelease(unittest.TestCase):
 def test_exact_migrations_and_preserved_fiscal_data(self):
  names=[p.name for p in sorted((ROOT/'db/cloud/migrations').glob('*.sql'))]
  self.assertEqual(names[20:20+len(r.MIGRATIONS)],list(r.MIGRATIONS))
  self.assertEqual(r.Release.new_tables-r.pilot.NEW_TABLES,{'commerce_kaspi_invoices'})
  self.assertEqual(r.Release.additions['commerce_orders'],['fiscal_policy','fiscal_deferral_reference'])
  self.assertEqual(len(r.pilot.MIGRATIONS),5)
 def test_overlay_provenance_is_pinned_not_ignored(self):
  from types import SimpleNamespace
  obj=object.__new__(r.Release)
  obj.profile=SimpleNamespace(old_web='bcf4fe624ba587208afb37e212bc8a49df6f6dea')
  self.assertEqual(obj.web_manifest_source(),r.pilot.BASELINE)
  obj.profile.old_web='0'*40
  with self.assertRaises(r.market.GuardFailure):obj.web_manifest_source()
 def test_gateway_keeps_existing_routes_and_bounded_wait(self):
  old=historical_content_gateway()
  auth=r.pilot.extend_gateway(old,'172.18.0.4')
  new=r.extend_checkout(auth)
  self.assertIn('response_header_timeout 25s',new)
  self.assertIn('header Cache-Control no-store',new)
  self.assertIn('not path /v1/customer-checkout/* /v1/auth/*',new)
  for marker in ['\t@health {','\t@test_post {']:
   self.assertEqual(auth[auth.index(marker):],new[new.index(marker):])
  with self.assertRaises(r.market.GuardFailure):r.extend_checkout(new)
 def test_disabled_auth_does_not_publish_legal_or_secret_files(self):
  from types import SimpleNamespace
  obj=object.__new__(r.Release);obj.args=SimpleNamespace(enable_customer_auth=False)
  manifest={'source_sha':'a'*40}
  self.assertIs(obj.prepare_public('/unused',manifest),manifest)
  old=historical_content_gateway()
  new=obj.gateway_candidate(old)
  self.assertNotIn('@pilot_auth',new)
  self.assertIn('@customer_checkout',new)
  self.assertIn('not path /v1/customer-checkout/* /v1/content/*',new)
 def test_schema020_catalog_gateway_preserves_existing_boundary(self):
  old="\t@synthetic_surfaces {\n\t\tnot path /v1/catalog/* /v1/admin/catalog/* /backoffice /backoffice/*\n\t}\n\t@health {\n\t}"
  new=r.extend_checkout(old)
  self.assertIn('not path /v1/customer-checkout/* /v1/catalog/* /v1/admin/catalog/* /backoffice /backoffice/*',new)
  with self.assertRaises(r.market.GuardFailure):r.extend_checkout(old.replace('/v1/catalog/*','/unknown/*'))
 def test_preparation_cannot_activate_payments(self):
  # Execute the actual remote text transformer on a disposable compose; no SSH.
  from unittest.mock import patch
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp)/'infra/staging/compose.yaml';p.parent.mkdir(parents=True)
   p.write_text('      APP_ENV: staging\n      APP_ENV: staging\n')
   obj=object.__new__(r.Release)
   from types import SimpleNamespace
   obj.args=SimpleNamespace(enable_customer_auth=True)
   obj.remote=lambda command:subprocess.check_output(shlex.split(command),text=True)
   with patch.object(r.pilot.Release,'prepare_api',lambda *a:None):obj.prepare_api(tmp)
   self.assertEqual(p.read_text().count('CUSTOMER_KASPI_PILOT_ENABLED: "false"'),2)
   self.assertNotIn('true',p.read_text())
if __name__=='__main__':unittest.main()
