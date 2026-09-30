import importlib.util
import json
from pathlib import Path
import secrets
import sys
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('server_pilot_release',ROOT/'infra/staging/release-server-pilot.py')
r=importlib.util.module_from_spec(spec);sys.modules[spec.name]=r;spec.loader.exec_module(r)

class ServerPilotGuards(unittest.TestCase):
 def test_exact_additive_migrations(self):
  names=[p.name for p in sorted((ROOT/'db/cloud/migrations').glob('*.sql'))]
  # The 020->025 pilot applies exactly 021-025; later migrations need their own release profile.
  self.assertEqual(names[20:20+len(r.MIGRATIONS)],list(r.MIGRATIONS))
  self.assertEqual(names[20+len(r.MIGRATIONS):],['026_cloud_kaspi_remote.sql', '027_cloud_deferred_fiscal_pilot.sql', '028_cloud_otp_code_length.sql'])
  self.assertEqual(set(r.ADDITIONS),{'test_order_numbers','identity_otp_challenges'})
 def test_gateway_preserves_every_existing_handler(self):
  old=(ROOT/'infra/public-staging/gateway.Caddyfile').read_text()
  new=r.extend_gateway(old,'172.18.0.4')
  self.assertIn('trusted_proxies static 172.18.0.4',new)
  self.assertIn('trusted_proxies_strict',new)
  self.assertIn('header_up X-Forwarded-For {client_ip}',new)
  self.assertIn('path /legal/terms /legal/privacy',new)
  for marker in ['\t@test_post {','\t@test_get {','\t# Bounded event wait:']:
   self.assertEqual(old[old.index(marker):],new[new.index(marker):])
  with self.assertRaises(r.market.GuardFailure):r.extend_gateway(new,'172.18.0.4')
  with self.assertRaises(ValueError):r.extend_gateway(old,'private_ranges')
 def test_secret_settings_fail_closed(self):
  env={'CUSTOMER_AUTH_ENABLED':'true','CUSTOMER_AUTH_DAILY_SMS_BUDGET':'1000',
   'CUSTOMER_AUTH_CONSENT_VERSION':r.VERSION,'PHONE_DELIVERY_PROVIDER':'telegram_gateway',
   'PHONE_SMS_FALLBACK_ENABLED':'false','TELEGRAM_GATEWAY_TOKEN':'synthetic-token-for-test'}
  for name in ['TERMS','PRIVACY']:env['CUSTOMER_AUTH_'+name+'_URL']='https://'+r.market.HOST+'/legal/'+name.lower()
  for key in ['LOOKUP','OTP','PII','RECEIPT']:env['CUSTOMER_AUTH_'+key+'_KEY']=secrets.token_hex(32)
  raw=lambda value:'\n'.join(k+'='+v for k,v in value.items())
  self.assertEqual(r.auth_environment(raw(env)),env)
  for changed in [{'CUSTOMER_AUTH_DAILY_SMS_BUDGET':'1001'},{'PHONE_SMS_FALLBACK_ENABLED':'true'}, {'CUSTOMER_AUTH_PII_KEY':env['CUSTOMER_AUTH_LOOKUP_KEY']},{'TEST_PHONE':'+77000000000'}]:
   with self.assertRaises(r.market.GuardFailure):r.auth_environment(raw({**env,**changed}))
 def test_runtime_rejects_extra_authority(self):
  def row(name,privilege,column=None):return {'name':name,'privilege':privilege,'column':column,'kind':'r','grantable':False}
  expected={'test_service_shifts':['SELECT'],'test_service_shifts_sequence_seq':['USAGE'],
    'identity_customers':['SELECT','INSERT','UPDATE'],'identity_sessions':['SELECT','INSERT','UPDATE','DELETE'],
    'identity_refresh_receipts':['SELECT','INSERT','UPDATE','DELETE'],'identity_otp_challenges':['SELECT','INSERT','UPDATE','DELETE'],
    'identity_sms_daily_budget':['SELECT','INSERT','UPDATE','DELETE'],'identity_consents':['SELECT','INSERT','DELETE'],
    'identity_otp_request_tombstones':['SELECT','INSERT'],'identity_deletions':['SELECT','INSERT'],
    'identity_customer_test_actors':['SELECT','INSERT'],'test_combo_stamps':['SELECT','INSERT'],'bo_records':['INSERT']}
  after=[row(n,p) for n,ps in expected.items() for p in ps]
  after += [row('test_service_shifts','INSERT','branch_id'),row('test_service_shifts','INSERT','state')]
  after += [row('test_service_shifts','UPDATE',c) for c in ['state','version','closed_at']]
  r.verify_acl([],after)
  for extra in [row('identity_customer_test_actors','UPDATE'),row('test_combo_stamps','UPDATE'),row('test_combo_stamps','DELETE'),row('commerce_orders','UPDATE'),row('test_service_shifts','UPDATE')]:
   with self.assertRaises(r.market.GuardFailure):r.verify_acl([],after+[extra])
  with self.assertRaises(r.market.GuardFailure):r.verify_acl([],after[1:])
  with self.assertRaises(r.market.GuardFailure):r.verify_acl([],after[:-1])
if __name__=='__main__':unittest.main()
