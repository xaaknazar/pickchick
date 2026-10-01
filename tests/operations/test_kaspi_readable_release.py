import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('tested_kaspi_readable', ROOT/'infra/staging/release-kaspi-readable.py')
m = importlib.util.module_from_spec(spec); sys.modules[spec.name] = m; spec.loader.exec_module(m)


class KaspiReadableRelease(unittest.TestCase):
    def test_policy_must_match_live_before_preparing(self):
        release = object.__new__(m.Release)
        release.remote = lambda command: 'live'
        release.validate_checkout = lambda raw: {'policy': raw}
        release.args = SimpleNamespace(checkout_env=SimpleNamespace(read_text=lambda: 'changed'))
        with patch.object(m.rollout.MobileRelease, 'prepare_api') as prepare:
            with self.assertRaises(m.market.GuardFailure): release.prepare_api('target')
            prepare.assert_not_called()
            release.args.checkout_env.read_text = lambda: 'live'
            release.prepare_api('target')
            prepare.assert_called_once_with(release, 'target')

    def test_profile_requires_reviewed_baseline_and_all_existing_guards(self):
        args = SimpleNamespace(expected_api_sha=m.BASELINE, expected_public_sha=m.PUBLIC_BASELINE,
                               expected_gateway_sha256=m.rollout.owner.base.GATEWAY_BASELINE)
        with patch.object(m.market.Release, '__init__', return_value=None) as initialize:
            m.Release(args)
            profile = initialize.call_args.args[2]
            self.assertTrue(profile.exact_ci_jobs)
            args.expected_api_sha = '0'*40
            with self.assertRaises(m.market.GuardFailure): m.Release(args)
        self.assertEqual(m.MIGRATION, '029_cloud_kaspi_invoice_comment.sql')
        self.assertEqual(m.Release.additions, {'commerce_kaspi_invoices': ['invoice_comment']})
        self.assertEqual(m.Release.checkout_file, m.rollout.Release.checkout_file)


if __name__ == '__main__': unittest.main()
