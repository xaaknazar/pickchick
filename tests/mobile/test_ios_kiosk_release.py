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


if __name__ == "__main__":
    unittest.main()
