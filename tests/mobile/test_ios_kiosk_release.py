"""Prevent a kiosk release from reusing the consumer app identity or public export."""
import importlib.util
from argparse import Namespace
import datetime
import hashlib
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "ios_kiosk_release", Path(__file__).resolve().parents[2] / "scripts/mobile/ios_release.py"
)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class KioskReleaseBoundaryTests(unittest.TestCase):
    def setUp(self):
        release.select_app("kiosk")

    def tearDown(self):
        release.select_app("mobile")

    def test_export_is_internal_only_and_does_not_change_mobile_distribution(self):
        for phase in ["export", "upload"]:
            self.assertTrue(release.export_options(phase)["testFlightInternalTestingOnly"])
        release.select_app("mobile")
        self.assertNotIn("testFlightInternalTestingOnly", release.export_options("upload"))
        self.assertEqual(release.BUNDLE, "kz.pickchick.app")
        with self.assertRaises(RuntimeError):
            release.select_app("other")

    def test_existing_mobile_profile_cannot_sign_kiosk(self):
        certificate = b"synthetic certificate"
        profile = {
            "UUID": "12345678-1234-1234-1234-123456789abc",
            "Name": "fixture", "TeamIdentifier": [release.TEAM],
            "ExpirationDate": datetime.datetime(2028, 1, 1), "Platform": ["iOS"],
            "DeveloperCertificates": [certificate],
            "Entitlements": {
                "com.apple.developer.team-identifier": release.TEAM,
                "application-identifier": f"{release.TEAM}.kz.pickchick.app",
                "get-task-allow": False,
            },
        }
        identity = hashlib.sha1(certificate).hexdigest().upper()
        with self.assertRaises(RuntimeError):
            release.profile_identity(profile, identity)
        profile["Entitlements"]["application-identifier"] = f"{release.TEAM}.kz.pickchick.kiosk"
        self.assertEqual(release.profile_identity(profile, identity)["profileName"], "fixture")

    def test_wrong_workspace_and_scheme_are_rejected_before_xcode(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(release, "ROOT", Path(tmp)):
            mobile = Path(tmp) / "apps/mobile/ios/PickChick.xcworkspace"
            kiosk = Path(tmp) / "apps/kiosk/ios/PickChickKiosk.xcworkspace"
            mobile.mkdir(parents=True)
            kiosk.mkdir(parents=True)
            with self.assertRaises(RuntimeError):
                release.workspace_args(Namespace(workspace=str(mobile), scheme="PickChickKiosk"))
            with self.assertRaises(RuntimeError):
                release.workspace_args(Namespace(workspace=str(kiosk), scheme="PickChick"))
            self.assertIn(str(kiosk.resolve()), release.workspace_args(Namespace(workspace=str(kiosk), scheme="PickChickKiosk")))

    def test_archive_must_be_kiosk_and_ipad_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "Kiosk.xcarchive"
            app = archive / "Products/Applications/PickChickKiosk.app"
            app.mkdir(parents=True)
            (app / "main.jsbundle").write_text("fixture")
            (archive / "Info.plist").write_bytes(plistlib.dumps({"ApplicationProperties": {
                "ApplicationPath": "Applications/PickChickKiosk.app", "Team": release.TEAM
            }}))
            for family in [[1], [1, 2], []]:
                (app / "Info.plist").write_bytes(plistlib.dumps({
                    "CFBundleIdentifier": release.BUNDLE, "UIDeviceFamily": family
                }))
                with self.assertRaisesRegex(RuntimeError, "only iPad"):
                    release.archive_app(archive)
            (app / "Info.plist").write_bytes(plistlib.dumps({
                "CFBundleIdentifier": release.BUNDLE, "UIDeviceFamily": [2]
            }))
            self.assertEqual(release.archive_app(archive)[0], app.resolve())


class KioskPinnedValuesTests(unittest.TestCase):
    """Audit 19.10, findings 3.5 and 7.3: a kiosk archive pins and proves its public values."""

    def setUp(self):
        release.select_app("kiosk")

    def tearDown(self):
        release.select_app("mobile")

    def flags(self, profile="kiosk-production", photo="https://photo.pickchick.kz:13440"):
        return release.kiosk_profile_flags(profile, photo, "pk-" + "a1" * 8)

    def test_profiles_pin_commercial_api_and_photo(self):
        production = self.flags()
        self.assertEqual(production["EXPO_PUBLIC_KIOSK_COMMERCIAL"], "1")
        self.assertEqual(production["EXPO_PUBLIC_KIOSK_BUILD_PROFILE"], "production")
        self.assertEqual(production["EXPO_PUBLIC_KIOSK_API_URL"], "https://api.pickchick.kz")
        self.assertEqual(production["EXPO_PUBLIC_KIOSK_PHOTO_URL"], "https://photo.pickchick.kz:13440")
        staging = self.flags("kiosk-staging", "https://192.168.1.20:13440/")
        self.assertEqual(staging["EXPO_PUBLIC_KIOSK_BUILD_PROFILE"], "staging")
        self.assertIn("nip.io", staging["EXPO_PUBLIC_KIOSK_API_URL"])
        self.assertEqual(staging["EXPO_PUBLIC_KIOSK_PHOTO_URL"], "https://192.168.1.20:13440")
        env = release.archive_environment("kiosk-production", {"PATH": "/bin",
                                          "EXPO_PUBLIC_KIOSK_COMMERCIAL": "0"}, production)
        for key, value in production.items():
            self.assertEqual(env[key], value)
        self.assertEqual(env["EXPO_NO_DOTENV"], "1")
        with self.assertRaises(RuntimeError):
            release.archive_environment("kiosk-production", {"EXPO_NO_CLIENT_ENV_VARS": "1"}, production)
        with self.assertRaises(RuntimeError):
            release.archive_environment("kiosk-production", {}, None)

    def test_missing_or_test_values_refuse_the_build(self):
        for photo in [None, "", "http://photo.pickchick.kz", "https://localhost:13440",
                      "https://127.0.0.1:13440", "https://photo.example.com", "https://printer.test",
                      "https://user:pw@photo.pickchick.kz", "https://photo.pickchick.kz/v1",
                      "https://photo.pickchick.kz?x=1"]:
            with self.assertRaises(RuntimeError, msg=photo):
                self.flags(photo=photo)
        for profile in ["legacy", "storefront", None]:
            with self.assertRaises(RuntimeError):
                release.kiosk_profile_flags(profile, "https://photo.pickchick.kz", "pk-" + "a1" * 8)

    def test_bundle_must_carry_the_pinned_values(self):
        flags = self.flags()
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp)
            good = (b"x/v1/kiosk-checkout\x00https://api.pickchick.kz\x00"
                    + flags["EXPO_PUBLIC_KIOSK_PHOTO_URL"].encode() + b"\x00"
                    + flags["EXPO_PUBLIC_KIOSK_RELEASE_ID"].encode())
            (app / "main.jsbundle").write_bytes(good)
            release.verify_kiosk_bundle(app, flags)
            # A bundle built from the shell environment (another or no release id) is refused.
            (app / "main.jsbundle").write_bytes(good.replace(b"pk-", b"xx-"))
            with self.assertRaisesRegex(RuntimeError, "release id"):
                release.verify_kiosk_bundle(app, flags)
            (app / "main.jsbundle").write_bytes(good.replace(b"photo.pickchick.kz", b"other.kz"))
            with self.assertRaisesRegex(RuntimeError, "photo"):
                release.verify_kiosk_bundle(app, flags)
            (app / "main.jsbundle").write_bytes(good.replace(b"kiosk-checkout", b"test"))
            with self.assertRaisesRegex(RuntimeError, "checkout"):
                release.verify_kiosk_bundle(app, flags)

    def test_export_requires_verified_kiosk_metadata(self):
        flags = self.flags()
        metadata = {"featureProfile": "kiosk-production", "embeddedPublicEnv": flags,
                    "kioskBundleVerified": True}
        release.verify_feature_profile(metadata, "kiosk-production")
        with self.assertRaises(RuntimeError):
            release.verify_feature_profile(metadata, "kiosk-staging")
        with self.assertRaises(RuntimeError):
            release.verify_feature_profile(metadata | {"kioskBundleVerified": False}, "kiosk-production")
        changed = flags | {"EXPO_PUBLIC_KIOSK_COMMERCIAL": "0"}
        with self.assertRaises(RuntimeError):
            release.verify_feature_profile(metadata | {"embeddedPublicEnv": changed}, "kiosk-production")
        # Archives made before 19.10 stay exportable under their recorded legacy profile.
        release.verify_feature_profile({}, "legacy")
        self.assertIsNone(release.feature_profile_flags("kiosk-production"))

    def test_command_line_refuses_a_kiosk_archive_without_pinned_values(self):
        for argv in (["archive", "--app", "kiosk"],
                     ["archive", "--app", "kiosk", "--feature-profile", "legacy"],
                     ["archive", "--app", "mobile", "--feature-profile", "kiosk-production"],
                     ["export", "--app", "kiosk", "--kiosk-photo-url", "https://photo.pickchick.kz"]):
            with patch.object(release.sys, "argv", ["ios_release.py", *argv]), \
                    patch.object(release, "manual_signing", side_effect=AssertionError("too late")):
                with self.assertRaises(RuntimeError, msg=argv):
                    release.main()


if __name__ == "__main__":
    unittest.main()
