"""Release preflight checks that protect the other apps in the Apple Team."""

import importlib.util
from pathlib import Path
import plistlib
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "ios_release", Path(__file__).resolve().parents[2] / "scripts/mobile/ios_release.py"
)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleasePreflightTests(unittest.TestCase):
    def test_public_staging_url_without_embedded_credentials(self):
        self.assertEqual(
            release.checked_api_url("https://pickchick.185.129.51.103.nip.io/"),
            "https://pickchick.185.129.51.103.nip.io",
        )
        for url in ["http://example.com", "https://localhost", "https://127.0.0.1",
                    "https://user:secret@example.com", "https://example.com?token=value",
                    "https://example.com#token", ""]:
            with self.subTest(url=url), self.assertRaises(RuntimeError):
                release.checked_api_url(url)

    def archive(self, directory, bundle=release.BUNDLE, team=release.TEAM, path=None):
        archive = Path(directory) / "PickChick.xcarchive"
        app = archive / "Products/Applications/PickChick.app"
        app.mkdir(parents=True)
        (app / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": bundle}))
        (app / "main.jsbundle").write_text("embedded release JS")
        (archive / "Info.plist").write_bytes(plistlib.dumps({"ApplicationProperties": {
            "ApplicationPath": path or "Applications/PickChick.app", "Team": team}}))
        return archive, app

    def test_valid_pickchick_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            archive, app = self.archive(directory)
            self.assertEqual(release.archive_app(archive)[0], app.resolve())

    def test_rejects_other_apps_on_same_team(self):
        for bundle in ["kz.divergents.app", "com.kexgroup.idrink"]:
            with tempfile.TemporaryDirectory() as directory, self.subTest(bundle=bundle):
                archive, _ = self.archive(directory, bundle=bundle)
                with self.assertRaisesRegex(RuntimeError, "different Bundle ID"):
                    release.archive_app(archive)

    def test_rejects_wrong_team(self):
        with tempfile.TemporaryDirectory() as directory:
            archive, _ = self.archive(directory, team="OTHERTEAM")
            with self.assertRaisesRegex(RuntimeError, "different Apple Team"):
                release.archive_app(archive)

    def test_rejects_path_outside_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            archive, _ = self.archive(directory, path="../../Other.app")
            with self.assertRaisesRegex(RuntimeError, "path is invalid"):
                release.archive_app(archive)

    def test_rejects_bundle_that_depends_on_metro(self):
        with tempfile.TemporaryDirectory() as directory:
            archive, app = self.archive(directory)
            (app / "main.jsbundle").unlink()
            with self.assertRaisesRegex(RuntimeError, "main.jsbundle"):
                release.archive_app(archive)

    def test_export_does_not_upload_or_reassign_build_numbers(self):
        options = release.export_options("export")
        self.assertEqual(options["destination"], "export")
        self.assertEqual(options["teamID"], release.TEAM)
        self.assertFalse(options["manageAppVersionAndBuildNumber"])
        self.assertEqual(release.export_options("upload")["destination"], "upload")


if __name__ == "__main__":
    unittest.main()
