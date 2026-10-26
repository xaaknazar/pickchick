"""Synthetic review configuration only; no signing, Apple or network access."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
release = load('review_release', 'scripts/mobile/ios_release.py')
prepare = load('review_code', 'scripts/mobile/kiosk-review-code.py')

class KioskReviewReleaseTests(unittest.TestCase):
    def setUp(self):
        release.select_app('kiosk')

    def flags(self):
        return release.kiosk_profile_flags('kiosk-production', 'https://photo.pickchick.kz', 'pk-' + 'a1' * 8, 'a' * 64)

    def test_private_input_is_not_saved_and_existing_file_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'verifier.json'
            code = 'Synthetic-Review-Only'
            prepare.prepare(path, code, code)
            self.assertNotIn(code, path.read_text())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(len(release.read_review_verifier(path)), 64)
            with self.assertRaises(FileExistsError):
                prepare.prepare(path, code, code)
            path.chmod(0o644)
            with self.assertRaises(RuntimeError):
                release.read_review_verifier(path)

    def test_bad_input_and_repository_output_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'verifier.json'
            for code, confirm in [('short', 'short'), ('Synthetic-Review-Only', 'different')]:
                with self.assertRaises(ValueError):
                    prepare.prepare(path, code, confirm)
            (Path(tmp) / '.git').touch()
            with self.assertRaises(ValueError):
                prepare.prepare(path, 'Synthetic-Review-Only', 'Synthetic-Review-Only')
            self.assertFalse(path.exists())

    def test_review_flags_are_verified_and_shell_cannot_enable_review(self):
        flags = self.flags()
        env = release.archive_environment('kiosk-production', {}, flags)
        self.assertEqual(env['EXPO_PUBLIC_KIOSK_REVIEW_CODE_SHA256'], 'a' * 64)
        normal = release.kiosk_profile_flags('kiosk-production', 'https://photo.pickchick.kz', 'pk-' + 'a1' * 8)
        env = release.archive_environment('kiosk-production', {'EXPO_PUBLIC_KIOSK_REVIEW_CODE_SHA256': 'a' * 64}, normal)
        self.assertNotIn('EXPO_PUBLIC_KIOSK_REVIEW_CODE_SHA256', env)
        metadata = {'featureProfile': 'kiosk-production', 'embeddedPublicEnv': flags, 'kioskBundleVerified': True}
        release.verify_feature_profile(metadata, 'kiosk-production')
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp)
            bundle = b'/v1/kiosk-checkout\0PICKCHICK-DEMO-NOT-PAYABLE\0' + '\0'.join(flags.values()).encode()
            (app / 'main.jsbundle').write_bytes(bundle)
            release.verify_kiosk_bundle(app, flags)
            (app / 'main.jsbundle').write_bytes(bundle.replace(b'a' * 64, b'b' * 64))
            with self.assertRaisesRegex(RuntimeError, 'review code verifier'):
                release.verify_kiosk_bundle(app, flags)

    def test_app_review_is_explicit_and_does_not_change_default_export(self):
        self.assertTrue(release.export_options('export')['testFlightInternalTestingOnly'])
        self.assertNotIn('testFlightInternalTestingOnly', release.export_options('export', kiosk_app_review=True))
        meta = {'kioskAppReview': True, 'testFlightInternalTestingOnly': False,
                'featureProfile': 'kiosk-production', 'embeddedPublicEnv': self.flags()}
        self.assertTrue(release.checked_review_distribution(meta))
        for patch_data in [{'embeddedPublicEnv': {}}, {'featureProfile': 'kiosk-staging'}, {'testFlightInternalTestingOnly': True}, {'kioskAppReview': False}]:
            with self.assertRaises(RuntimeError):
                release.checked_review_distribution(meta | patch_data)
        release.select_app('mobile')
        with self.assertRaises(RuntimeError):
            release.checked_review_distribution(meta)
        with self.assertRaises(RuntimeError):
            release.export_options('export', kiosk_app_review=True)

    def test_cli_rejects_review_without_private_input_before_signing(self):
        for argv in [['archive', '--app', 'kiosk', '--feature-profile', 'kiosk-production', '--kiosk-app-review'],
                     ['export', '--app', 'kiosk', '--kiosk-app-review'],
                     ['archive', '--app', 'mobile', '--kiosk-app-review']]:
            with patch.object(release.sys, 'argv', ['ios_release.py', *argv]), patch.object(release, 'manual_signing', side_effect=AssertionError('too late')):
                with self.assertRaises(RuntimeError):
                    release.main()

if __name__ == '__main__':
    unittest.main()
