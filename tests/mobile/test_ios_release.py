"""Release preflight checks that protect the other apps in the Apple Team."""

import importlib.util
from argparse import Namespace
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


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


class ManualDistributionTests(unittest.TestCase):
    certificate = b"synthetic certificate bytes for the pure profile guard"
    identity = hashlib.sha1(certificate).hexdigest().upper()
    uuid = "12345678-1234-1234-1234-123456789abc"

    def profile(self):
        return {"UUID": self.uuid, "Name": "PickChick fixture", "TeamIdentifier": [release.TEAM],
                "ExpirationDate": datetime.datetime(2028, 1, 1), "Platform": ["iOS"],
                "Entitlements": {"application-identifier": f"{release.TEAM}.{release.BUNDLE}",
                                 "com.apple.developer.team-identifier": release.TEAM,
                                 "get-task-allow": False},
                "DeveloperCertificates": [self.certificate]}

    def signing(self):
        return {"style": "manual", "identity": self.identity, "profileUuid": self.uuid,
                "keychain": Path("/private/synthetic/pickchick.keychain-db")}

    def test_only_matching_unexpired_app_store_profile_is_accepted(self):
        now = datetime.datetime(2026, 9, 6, tzinfo=datetime.timezone.utc)
        value = release.profile_identity(self.profile(), self.identity, now)
        self.assertEqual(value["profileUuid"], self.uuid)
        for field, replacement in [("TeamIdentifier", ["OTHERTEAM"]),
                                   ("DeveloperCertificates", [b"other certificate"]),
                                   ("ProvisionedDevices", []), ("ProvisionsAllDevices", True),
                                   ("Platform", ["macOS"]), ("UUID", "../escape"),
                                   ("ExpirationDate", datetime.datetime(2026, 9, 5))]:
            profile = self.profile()
            profile[field] = replacement
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                release.profile_identity(profile, self.identity, now)
        for key, value in [("application-identifier", f"{release.TEAM}.kz.divergents.app"),
                           ("com.apple.developer.team-identifier", "OTHERTEAM"),
                           ("get-task-allow", True), ("get-task-allow", None)]:
            profile = self.profile()
            profile["Entitlements"][key] = value
            with self.subTest(entitlement=key), self.assertRaises(RuntimeError):
                release.profile_identity(profile, self.identity, now)

    def test_manual_commands_never_request_apple_mutations_or_leak_profile_to_pods(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(release, "ROOT", Path(directory)):
            workspace = Path(directory) / "apps/mobile/ios/PickChick.xcworkspace"
            workspace.mkdir(parents=True)
            args = Namespace(workspace=str(workspace), scheme="PickChick")
            signing = self.signing()
            archive = release.archive_command(args, signing, Path("/artifact/app.xcarchive"), Path("/artifact/DerivedData"))
            exported = release.export_command(signing, Path("/artifact/app.xcarchive"), Path("/artifact/export"), Path("/artifact/options"))
            for command in [archive, exported]:
                self.assertNotIn("-allowProvisioningUpdates", command)
                self.assertFalse(any("PROVISIONING_PROFILE" in item for item in command))
                self.assertFalse(any("CODE_SIGN_IDENTITY" in item for item in command))
            self.assertIn("-derivedDataPath", archive)
            options = release.export_options("export", signing)
            self.assertEqual(options["signingStyle"], "manual")
            self.assertEqual(options["signingCertificate"], self.identity)
            self.assertEqual(options["provisioningProfiles"], {release.BUNDLE: self.uuid})
            self.assertFalse(options["manageAppVersionAndBuildNumber"])

    def test_private_material_paths_do_not_enter_release_metadata(self):
        signing = self.signing() | {"passwordPath": Path("/private/password"), "profilePath": Path("/private/profile")}
        self.assertNotIn("/private", json.dumps(release.public_signing(signing)))

    def test_private_file_rejects_readable_credentials_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "keychain"
            file.write_bytes(b"synthetic")
            file.chmod(0o644)
            with self.assertRaises(RuntimeError):
                release.private_file(file, "Keychain")
            file.chmod(0o600)
            self.assertEqual(release.private_file(file, "Keychain"), file.resolve())
            link = file.with_name("symlink")
            link.symlink_to(file)
            with self.assertRaises(RuntimeError):
                release.private_file(link, "Keychain")

    def test_artifacts_default_outside_icloud_and_explicit_icloud_rejected(self):
        self.assertEqual(release.artifact_root(release.DEFAULT_ARTIFACTS_ROOT), release.DEFAULT_ARTIFACTS_ROOT.resolve())
        for path in [release.ROOT / ".local/releases", Path.home() / "Documents/build",
                     Path.home() / "Library/Mobile Documents/build", Path.home() / "Desktop/build"]:
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                release.artifact_root(path)

    def search_list_mock(self):
        state = {"list": ["/private/login.keychain-db", "/private/existing-eas.keychain"],
                 "default": '"/private/login.keychain-db"\n'}
        def command(args):
            if args[:2] == ["security", "default-keychain"]:
                return state["default"]
            if "-s" in args:
                state["list"] = args[args.index("-s") + 1:]
                return ""
            return "\n".join(json.dumps(item) for item in state["list"]) + "\n"
        return state, command

    def test_search_list_restored_on_build_failure_with_existing_entries_and_default(self):
        state, command = self.search_list_mock()
        before = copy.deepcopy(state)
        with tempfile.TemporaryDirectory() as directory, patch.object(release, "local_command", command):
            with self.assertRaisesRegex(RuntimeError, "build failed"):
                with release.temporary_search_list(self.signing(), Path(directory)):
                    self.assertEqual(state["list"], before["list"] + [str(self.signing()["keychain"])])
                    raise RuntimeError("build failed")
        self.assertEqual(state, before)

    def test_concurrent_keychain_change_is_preserved_instead_of_overwritten(self):
        state, command = self.search_list_mock()
        with tempfile.TemporaryDirectory() as directory, patch.object(release, "local_command", command):
            with self.assertRaisesRegex(RuntimeError, "changed concurrently"):
                with release.temporary_search_list(self.signing(), Path(directory)):
                    state["list"].append("/private/new-external-keychain")
        self.assertEqual(state["list"][-1], "/private/new-external-keychain")

    def test_profile_install_is_reverted_on_failure_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, "home", return_value=Path(directory)):
            source = Path(directory) / "source.mobileprovision"
            source.write_bytes(b"synthetic profile")
            signing = self.signing() | {"profilePath": source}
            destination = Path(directory) / "Library/Developer/Xcode/UserData/Provisioning Profiles" / f"{self.uuid}.mobileprovision"
            with self.assertRaisesRegex(RuntimeError, "build failed"):
                with release.installed_profile(signing):
                    self.assertEqual(destination.read_bytes(), source.read_bytes())
                    raise RuntimeError("build failed")
            self.assertFalse(destination.exists())
            destination.write_bytes(b"different profile")
            with self.assertRaisesRegex(RuntimeError, "no profile overwritten"):
                with release.installed_profile(signing):
                    self.fail("unexpected context entry")
            self.assertEqual(destination.read_bytes(), b"different profile")

    def test_release_lock_rejects_concurrent_phase_and_releases_after_error(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(release, "ROOT", Path(directory)):
            with self.assertRaisesRegex(RuntimeError, "build failed"):
                with release.release_lock():
                    with self.assertRaisesRegex(RuntimeError, "Another release"):
                        with release.release_lock():
                            self.fail("second lock acquired")
                    raise RuntimeError("build failed")
            self.assertFalse((Path(directory) / ".local/mobile-ios/release.lock").exists())


@unittest.skipUnless(sys.platform == "darwin", "Native Xcode project fixture runs only on macOS")
class NativeManualProjectTests(unittest.TestCase):
    def test_only_device_app_release_changes_and_exact_original_returns_after_failure(self):
        bootstrap = release.MANUAL_PROJECT_RUBY.split("path, team, bundle, identity, profile, keychain = ARGV")[0]
        with tempfile.TemporaryDirectory() as directory, patch.object(release, "ROOT", Path(directory)):
            native = Path(directory) / "apps/mobile/ios"
            native.mkdir(parents=True)
            workspace = native / "PickChick.xcworkspace"
            workspace.mkdir()
            project = native / "PickChick.xcodeproj"
            create = bootstrap + '''
project = Xcodeproj::Project.new(ARGV[0])
app = project.new_target(:application, 'PickChick', :ios, '16.4')
project.new_target(:framework, 'PodsFixture', :ios, '16.4')
project.new_target(:ui_test_bundle, 'PickChickUITests', :ios, '16.4')
app.build_configurations.each do |config|
  config.build_settings.merge!(
    'PRODUCT_BUNDLE_IDENTIFIER' => 'kz.pickchick.app',
    'CODE_SIGN_STYLE' => 'Automatic',
    'CODE_SIGN_ENTITLEMENTS' => 'Physical.entitlements',
    'CODE_SIGN_IDENTITY[sdk=iphonesimulator*]' => '-',
    'CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]' => 'Simulator.entitlements')
end
project.save
'''
            subprocess.run(["ruby", "-e", create, str(project)], check=True, capture_output=True, text=True)
            inspect = bootstrap + '''
require 'json'
p = Xcodeproj::Project.open(ARGV[0])
puts JSON.generate({project: p.build_configurations.to_h { |c| [c.name, c.build_settings] },
 targets: p.targets.to_h { |t| [t.name, t.build_configurations.to_h { |c| [c.name, c.build_settings] }] }})
'''
            def settings():
                return json.loads(subprocess.run(["ruby", "-e", inspect, str(project)], check=True, capture_output=True, text=True).stdout)
            before = settings()
            file = project / "project.pbxproj"
            original = file.read_bytes()
            output = Path(directory) / "private-output"
            output.mkdir()
            args = Namespace(workspace=str(workspace), scheme="PickChick")
            signing = ManualDistributionTests().signing()
            with self.assertRaisesRegex(RuntimeError, "simulated archive failure"):
                with release.app_signing_override(args, signing, output):
                    actual = settings()
                    self.assertEqual(actual["project"], before["project"])
                    self.assertEqual(actual["targets"]["PodsFixture"], before["targets"]["PodsFixture"])
                    self.assertEqual(actual["targets"]["PickChickUITests"], before["targets"]["PickChickUITests"])
                    self.assertEqual(actual["targets"]["PickChick"]["Debug"], before["targets"]["PickChick"]["Debug"])
                    app = actual["targets"]["PickChick"]["Release"]
                    kept = {key: value for key, value in app.items() if not key.endswith("[sdk=iphoneos*]")}
                    self.assertEqual(kept, before["targets"]["PickChick"]["Release"])
                    self.assertEqual(app["PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]"], signing["profileUuid"])
                    self.assertIn("--keychain", app["OTHER_CODE_SIGN_FLAGS[sdk=iphoneos*]"])
                    raise RuntimeError("simulated archive failure")
            self.assertEqual(file.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
