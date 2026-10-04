import copy
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('auth_four_release', ROOT/'infra/staging/release-auth-four-digit.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)

class FourDigitReleaseGuards(unittest.TestCase):
    def test_only_reviewed_baseline(self):
        args = SimpleNamespace(expected_api_sha='0'*40, expected_public_sha=r.PUBLIC_BASELINE,
                               expected_gateway_sha256=r.GATEWAY_BASELINE)
        with self.assertRaises(r.market.GuardFailure): r.Release(args)

    def test_data_acl_and_legacy_length_are_preserved(self):
        release = object.__new__(r.Release)
        before = {'ledger': [], 'data': {'tables': {'schema_migrations': {'rows':27},
                  'identity_sessions': {'rows':1, 'sha256':'same'}}, 'sequences':[]}, 'acl':[]}
        release.ledger = lambda: [{'version':r.MIGRATION, 'scope':'cloud',
            'checksum':r.market.digest((ROOT/'db/cloud/migrations'/r.MIGRATION).read_bytes())}]
        after = copy.deepcopy(before['data'])
        after['tables']['schema_migrations'] = {'rows':28}
        release.snapshot = lambda: copy.deepcopy(after)
        release.acl = lambda: []
        release.psql = lambda *_: '0'
        release.verify_data(before)
        after['tables']['identity_sessions']['sha256'] = 'changed'
        with self.assertRaises(r.market.GuardFailure): release.verify_data(before)
        after = copy.deepcopy(before['data'])
        release.acl = lambda: ['extra']
        with self.assertRaises(r.market.GuardFailure): release.verify_data(before)
        release.acl = lambda: []
        release.psql = lambda *_: '1'
        with self.assertRaises(r.market.GuardFailure): release.verify_data(before)

    def test_gateway_is_unchanged_and_otp_metadata_is_only_snapshot_exclusion(self):
        release = object.__new__(r.Release)
        self.assertEqual(release.gateway_candidate('existing routes'), 'existing routes')
        self.assertEqual(release.additions, {'identity_otp_challenges':['code_length']})
        self.assertEqual(sorted(p.name for p in (ROOT/'db/cloud/migrations').glob('*.sql'))[27:], [r.MIGRATION, '029_cloud_kaspi_invoice_comment.sql', '030_cloud_branch_availability.sql', '031_cloud_otp_auto_channel.sql', '032_cloud_order_feedback.sql', '033_cloud_cashier_reports.sql', '034_cloud_catalog_menu_delivery.sql', '035_cloud_kiosk_sessions.sql', '036_cloud_kiosk_commerce.sql', '037_cloud_farm.sql'])

if __name__ == '__main__': unittest.main()
