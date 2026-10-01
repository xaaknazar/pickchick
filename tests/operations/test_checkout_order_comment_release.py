import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('checkout_comment_release', ROOT / 'infra/staging/release-checkout-order-comment.py')
release_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = release_module
spec.loader.exec_module(release_module)


class CheckoutCommentRelease(unittest.TestCase):
    def test_reviewed_live_baseline_and_exact_ci(self):
        args = SimpleNamespace(expected_api_sha=release_module.BASELINE,
                               expected_public_sha=release_module.PUBLIC_BASELINE,
                               expected_gateway_sha256=release_module.GATEWAY_BASELINE)
        with patch.object(release_module.market.Release, '__init__', return_value=None) as init:
            release_module.Release(args)
            profile = init.call_args.args[2]
            self.assertEqual((profile.baseline_count, profile.migrations), (30, (release_module.MIGRATION,)))
            self.assertTrue(profile.exact_ci_jobs)
            self.assertEqual(profile.old_api, release_module.BASELINE)
            self.assertEqual(profile.old_web, release_module.PUBLIC_BASELINE)
            args.expected_gateway_sha256 = '0' * 64
            with self.assertRaises(release_module.market.GuardFailure):
                release_module.Release(args)

    def test_existing_payment_policy_is_required_before_prepare(self):
        release = object.__new__(release_module.Release)
        release.remote = lambda _: 'live'
        release.validate_checkout = lambda raw: {'policy': raw}
        release.args = SimpleNamespace(auth_env=SimpleNamespace(read_text=lambda: 'auth'),
                                       checkout_env=SimpleNamespace(read_text=lambda: 'changed'))
        with patch.object(release_module.pilot, 'auth_environment') as auth, \
             patch.object(release_module.base.base.rollout.MobileRelease, 'prepare_api') as prepare:
            with self.assertRaises(release_module.market.GuardFailure):
                release.prepare_api('target')
            prepare.assert_not_called()
            release.args.checkout_env.read_text = lambda: 'live'
            release.prepare_api('target')
            auth.assert_called()
            prepare.assert_called_once_with(release, 'target')

    def test_migration_preserves_existing_rows_acl_and_otp_channel(self):
        release = object.__new__(release_module.Release)
        before = {'ledger': [], 'data': {'tables': {'schema_migrations': {'rows': 30},
                  'identity_otp_challenges': {'rows': 1, 'sha256': 'same'},
                  'commerce_orders': {'rows': 1, 'sha256': 'same'}}, 'sequences': []}, 'acl': []}
        release.ledger = lambda: [{'version': release_module.MIGRATION, 'scope': 'cloud',
            'checksum': release_module.market.digest((ROOT / 'db/cloud/migrations' / release_module.MIGRATION).read_bytes())}]
        after = copy.deepcopy(before['data'])
        after['tables']['schema_migrations'] = {'rows': 31}
        release.snapshot = lambda: copy.deepcopy(after)
        release.acl = lambda: []
        release.psql = lambda *_: '0'
        release.verify_data(before)
        after['tables']['commerce_orders']['sha256'] = 'changed'
        with self.assertRaises(release_module.market.GuardFailure):
            release.verify_data(before)
        after['tables']['commerce_orders']['sha256'] = 'same'
        release.acl = lambda: ['extra']
        with self.assertRaises(release_module.market.GuardFailure):
            release.verify_data(before)
        release.acl = lambda: []
        release.psql = lambda *_: '1'
        with self.assertRaises(release_module.market.GuardFailure):
            release.verify_data(before)

    def test_public_gateway_is_unchanged(self):
        release = object.__new__(release_module.Release)
        self.assertEqual(release.web_manifest_source(), release_module.BASELINE)
        self.assertEqual(release.gateway_candidate('installed routes'), 'installed routes')
        self.assertEqual(release.additions, {'identity_otp_challenges': ['requested_channel']})


if __name__ == '__main__':
    unittest.main()
