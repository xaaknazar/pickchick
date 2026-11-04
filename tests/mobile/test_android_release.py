"""Android release tool: profiles, upload key handling, mocked Gradle and the manifest gate."""

import contextlib
import importlib.util
from argparse import Namespace
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


spec = importlib.util.spec_from_file_location(
    "android_release", Path(__file__).resolve().parents[2] / "scripts/mobile/android_release.py"
)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
ios = release.ios

NS = release.ANDROID_NS
# Shape of `aapt2 dump xmltree` on the proto manifest of an AAB base module (build-tools 36.0.0,
# taken from the container build of 05.11.2026 and shortened).
XMLTREE = f"""N: android={NS} (line=2)
  E: manifest (line=2)
    A: package="kz.pickchick.app" (Raw: "kz.pickchick.app")
    A: {NS}:versionCode(0x0101021b)=7 (Raw: "7")
    A: {NS}:versionName(0x0101021c)="0.2.0" (Raw: "0.2.0")
    A: {NS}:compileSdkVersion(0x01010572)=36 (Raw: "36")
    A: platformBuildVersionCode=36 (Raw: "36")
      T: '\\n\\n    '
      E: uses-sdk (line=7)
        A: {NS}:minSdkVersion(0x0101020c)=24 (Raw: "24")
        A: {NS}:targetSdkVersion(0x01010270)=36 (Raw: "36")
      T: '\\n\\n    '
      E: uses-permission (line=11)
        A: {NS}:name(0x01010003)="android.permission.INTERNET" (Raw: "android.permission.INTERNET")
      E: uses-permission (line=12)
        A: {NS}:name(0x01010003)="android.permission.VIBRATE" (Raw: "android.permission.VIBRATE")
      E: uses-permission (line=13)
        A: {NS}:name(0x01010003)="android.permission.POST_NOTIFICATIONS" (Raw: "android.permission.POST_NOTIFICATIONS")
      E: queries (line=20)
          E: intent (line=21)
              E: action (line=22)
                A: {NS}:name(0x01010003)="android.intent.action.VIEW" (Raw: "android.intent.action.VIEW")
              E: data (line=24)
                A: {NS}:scheme(0x01010027)="dgis" (Raw: "dgis")
      E: application (line=30)
        A: {NS}:allowBackup(0x01010280)=false (Raw: "false")
        A: {NS}:dataExtractionRules(0x0101063e)=@xml/pickchick_data_extraction_rules (Raw: "@xml/pickchick_data_extraction_rules")
        A: {NS}:enableOnBackInvokedCallback(0x0101066b)=false (Raw: "false")
          E: activity (line=40)
            A: {NS}:name(0x01010003)="kz.pickchick.app.MainActivity" (Raw: "kz.pickchick.app.MainActivity")
              E: intent-filter (line=44)
                  E: data (line=47)
                    A: {NS}:scheme(0x01010027)="pickchick" (Raw: "pickchick")
"""


def with_attribute(text, after, line):
    return text.replace(after, after + "\n" + line, 1)


class ProfileTests(unittest.TestCase):
    def test_production_is_the_default_and_only_play_profile(self):
        self.assertEqual(release.DEFAULT_PROFILE, "production")
        self.assertEqual(release.select_profile(None, False, "play-internal"), "production")
        self.assertEqual(release.select_profile("production", False, "play-release-7"), "production")
        notice = release.backend_notice("production", True)
        self.assertEqual(notice["api_url"], "https://api.pickchick.kz")
        self.assertNotIn("warning", notice)

    def test_staging_needs_the_explicit_flag_and_never_a_release_or_upload_label(self):
        for profile in ["storefront", "published-catalog", "catalog-pilot", "customer-pilot"]:
            with self.subTest(profile=profile):
                with self.assertRaisesRegex(RuntimeError, "staging host.*--allow-staging"):
                    release.select_profile(profile, False, "local-test")
                self.assertEqual(release.select_profile(profile, True, "local-test"),
                                 ios.canonical_profile(profile))
                for label in ["play-release", "upload-7", "Release1", "pre-UPLOAD"]:
                    with self.assertRaisesRegex(RuntimeError, "release or upload label"):
                        release.select_profile(profile, True, label)
        notice = release.backend_notice("storefront", False)
        self.assertIn("--feature-profile production", notice["warning"])
        self.assertEqual(notice["api_url"], ios.STAGING_API_URL)
        for name in ["legacy", "kiosk-production", "unknown"]:
            with self.subTest(profile=name), self.assertRaises(RuntimeError):
                release.select_profile(name, True, "local-test")

    def test_artifact_names_carry_the_profile(self):
        self.assertEqual(release.artifact_name("0.2.0", 7, "production", "aab"),
                         "PickChick-0.2.0-7-production.aab")
        # A staging test build under any label never looks like the Play bundle.
        self.assertEqual(release.artifact_name("0.2.0", 7, "storefront", "aab"),
                         "PickChick-0.2.0-7-storefront-staging-not-for-play.aab")
        self.assertEqual(release.artifact_name("0.2.0", 7, "catalog-pilot", "apk"),
                         "PickChick-0.2.0-7-published-catalog-staging-not-for-play.apk")

    def test_bundle_environment_reuses_the_ios_pinning(self):
        shell = {"EXPO_PUBLIC_API_URL": "https://evil.example", "EXPO_PUBLIC_UPCOMING_PAYMENTS": "1",
                 "EXPO_PUBLIC_PICKCHICK_ENV": "staging", "PICKCHICK_APP_VARIANT": "development"}
        env = release.bundle_environment("production", shell)
        self.assertEqual(env["EXPO_PUBLIC_PICKCHICK_ENV"], "production")
        self.assertNotIn("EXPO_PUBLIC_API_URL", env)
        self.assertNotIn("EXPO_PUBLIC_UPCOMING_PAYMENTS", env)
        self.assertEqual(env["PICKCHICK_APP_VARIANT"], "release")
        self.assertEqual(env["EXPO_NO_DOTENV"], "1")
        for key, value in ios.PRODUCTION_FLAGS.items():
            self.assertEqual(env[key], value)
        with self.assertRaisesRegex(RuntimeError, "staging host"):
            release.bundle_environment("production", {
                "EXPO_PUBLIC_SUPPORT_URL": "https://pickchick.185.129.51.103.nip.io/support/"})
        with self.assertRaisesRegex(RuntimeError, "EXPO_NO_CLIENT_ENV_VARS"):
            release.bundle_environment("production", {"EXPO_NO_CLIENT_ENV_VARS": "1"})

    def test_bundle_environment_drops_upload_key_values_of_the_shell(self):
        shell = {key: f"{key}-secret" for key in release.SIGNING_KEYS}
        shell.update({f"ORG_GRADLE_PROJECT_{name}": "gradle-secret"
                      for name in release.GRADLE_SIGNING.values()}, PATH="/usr/bin")
        env = release.bundle_environment("production", shell)
        self.assertEqual(env["PATH"], "/usr/bin")
        self.assertFalse([key for key, value in env.items() if "secret" in value])


class SigningTests(unittest.TestCase):
    def keystore(self, directory, mode=0o600):
        path = Path(directory) / "upload.jks"
        path.write_bytes(b"synthetic keystore bytes")
        path.chmod(mode)
        return path

    def env(self, keystore):
        return {"PICKCHICK_ANDROID_UPLOAD_KEYSTORE": str(keystore),
                "PICKCHICK_ANDROID_UPLOAD_KEYSTORE_PASSWORD": "store-secret-value",
                "PICKCHICK_ANDROID_UPLOAD_KEY_ALIAS": "upload",
                "PICKCHICK_ANDROID_UPLOAD_KEY_PASSWORD": "key-secret-value"}

    def test_inputs_from_environment_or_private_file_never_both(self):
        self.assertIsNone(release.signing_inputs({}))
        with tempfile.TemporaryDirectory() as directory:
            keystore = self.keystore(directory)
            signing = release.signing_inputs(self.env(keystore))
            self.assertEqual(signing["store_file"], keystore.resolve())
            self.assertEqual(signing["key_alias"], "upload")
            partial = self.env(keystore)
            del partial["PICKCHICK_ANDROID_UPLOAD_KEY_PASSWORD"]
            with self.assertRaisesRegex(RuntimeError, "missing: PICKCHICK_ANDROID_UPLOAD_KEY_PASSWORD"):
                release.signing_inputs(partial)
            file = Path(directory) / "signing.properties"
            file.write_text("# test\n" + "".join(f"{k}={v}\n" for k, v in self.env(keystore).items()))
            file.chmod(0o600)
            self.assertEqual(release.signing_inputs({}, str(file)), signing)
            with self.assertRaisesRegex(RuntimeError, "not both"):
                release.signing_inputs(self.env(keystore), str(file))
            file.write_text(file.read_text() + "OTHER=1\n")
            with self.assertRaisesRegex(RuntimeError, "only the four"):
                release.signing_inputs({}, str(file))

    def test_keystore_must_be_private_and_never_tracked(self):
        with tempfile.TemporaryDirectory() as directory:
            loose = self.keystore(directory, 0o644)
            with self.assertRaisesRegex(RuntimeError, "mode 0600"):
                release.signing_inputs(self.env(loose))
            keystore = self.keystore(directory)
            with patch.object(release, "ROOT", Path(directory).resolve()), \
                    patch.object(release, "git_ignored", return_value=False):
                with self.assertRaisesRegex(RuntimeError, "not ignored by Git"):
                    release.signing_inputs(self.env(keystore))
            with patch.object(release, "ROOT", Path(directory).resolve()), \
                    patch.object(release, "git_ignored", return_value=True):
                self.assertIsNotNone(release.signing_inputs(self.env(keystore)))

    def test_passwords_reach_gradle_only_through_its_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            signing = release.signing_inputs(self.env(self.keystore(directory)))
        env = release.gradle_signing_env(signing)
        self.assertEqual(env["ORG_GRADLE_PROJECT_pickchickUploadStorePassword"], "store-secret-value")
        self.assertEqual(env["ORG_GRADLE_PROJECT_pickchickUploadKeyPassword"], "key-secret-value")
        self.assertEqual(env["ORG_GRADLE_PROJECT_pickchickUploadKeyAlias"], "upload")
        self.assertEqual(set(env), {f"ORG_GRADLE_PROJECT_{name}"
                                    for name in release.GRADLE_SIGNING.values()})
        # The same property names the generated app/build.gradle reads (android-release.js).
        plugin = (release.APP / "plugins/android-release.js").read_text()
        for name in release.GRADLE_SIGNING.values():
            self.assertIn(f"findProperty('{name}')", plugin)
        command = " ".join(release.gradle_command(True, "arm64-v8a"))
        self.assertNotIn("secret", command)
        self.assertIn("--no-daemon", command)
        self.assertIn("bundleRelease", command)
        self.assertIn("assembleRelease", command)
        self.assertIn("-PreactNativeArchitectures=arm64-v8a", command)
        self.assertNotIn("assembleRelease", release.gradle_command(False))
        with self.assertRaisesRegex(RuntimeError, "ABIs"):
            release.gradle_command(False, "arm64-v8a;rm -rf /")

    def test_debug_key_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "debug key"):
            release.refuse_debug_certificate({"owner": "C=US, O=Android, CN=Android Debug",
                                              "sha256": "AA"})
        with self.assertRaisesRegex(RuntimeError, "debug key"):
            release.refuse_debug_certificate({"owner": "CN=Someone", "sha256": "BB"}, "BB")
        release.refuse_debug_certificate({"owner": "CN=PickChick upload", "sha256": "CC"}, "BB")

    def test_keytool_output_parsing_reads_only_public_certificate_fields(self):
        sha = ":".join(["AB"] * 32)
        output = f"Alias name: upload\nOwner: CN=PickChick upload, O=PICK CHICK\n" \
                 f"Certificate fingerprints:\n\t SHA1: 00\n\t SHA256: {sha}\n"
        with patch.object(release.subprocess, "run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, output, "")
            certificate = release.keytool_certificate(["-list"])
            self.assertEqual(certificate, {"owner": "CN=PickChick upload, O=PICK CHICK", "sha256": sha})
            run.return_value = subprocess.CompletedProcess([], 1, "", "keytool error: password")
            with self.assertRaisesRegex(RuntimeError, "no password"):
                release.keytool_certificate(["-list"])


class BuildTests(unittest.TestCase):
    def test_build_pins_the_bundle_and_never_writes_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            native = root / "android"
            produced = native / "app/build/outputs/bundle/release/app-release.aab"
            produced.parent.mkdir(parents=True)
            output = root / "out"
            output.mkdir()
            keystore = root / "upload.jks"
            keystore.write_bytes(b"k")
            keystore.chmod(0o600)
            signing = {"store_file": keystore, "store_password": "store-secret-value",
                       "key_alias": "upload", "key_password": "key-secret-value"}
            calls = []

            def run_logged(command, log, cwd, env):
                calls.append((command, cwd, dict(env)))
                if "bundleRelease" in command:
                    produced.write_bytes(b"PK synthetic bundle")

            args = Namespace(apk=False, architectures="arm64-v8a", profile_from_default=True,
                             allow_staging=False)
            sha = ":".join(["CD"] * 32)
            # The invoking shell may export the upload key inputs (the documented way).
            shell = {**os.environ, "PICKCHICK_ANDROID_UPLOAD_KEYSTORE_PASSWORD": "store-secret-value",
                     "PICKCHICK_ANDROID_UPLOAD_KEY_PASSWORD": "key-secret-value"}
            with patch.object(release, "NATIVE", native), \
                    patch.object(release, "run_logged", run_logged), \
                    patch.dict(os.environ, shell, clear=True), \
                    patch.object(release, "inspect_bundle") as inspect, \
                    patch.object(release, "event"):
                release.build(args, "production", signing,
                              {"owner": "CN=PickChick upload", "sha256": sha}, output)
            self.assertEqual([call[0][2] if call[0][0] != "./gradlew" else "gradle" for call in calls],
                             ["prebuild", "gradle"])
            prebuild, gradle = calls
            self.assertIn("--clean", prebuild[0])
            self.assertEqual(gradle[1], native)
            for _, _, env in calls:
                self.assertEqual(env["EXPO_PUBLIC_PICKCHICK_ENV"], "production")
                self.assertEqual(env["PICKCHICK_APP_VARIANT"], "release")
                self.assertNotIn("EXPO_PUBLIC_API_URL", env)
                self.assertFalse(set(release.SIGNING_KEYS) & set(env))
            self.assertEqual(gradle[2]["ORG_GRADLE_PROJECT_pickchickUploadKeyPassword"],
                             "key-secret-value")
            self.assertEqual(gradle[2]["ORG_GRADLE_PROJECT_pickchickUploadStoreFile"], str(keystore))
            # expo prebuild runs every config plugin: no upload key value, path or alias there.
            self.assertFalse([key for key in prebuild[2] if "pickchickUpload" in key])
            self.assertFalse([key for key, value in prebuild[2].items()
                              if "secret" in value or value == str(keystore)])
            for command, _, _ in calls:
                self.assertFalse(any("secret" in part for part in command))
            metadata = json.loads((output / "release.json").read_text())
            text = (output / "release.json").read_text()
            self.assertNotIn("secret", text)
            self.assertNotIn(str(keystore), text)
            self.assertEqual(metadata["featureProfile"], "production")
            self.assertEqual(metadata["apiUrl"], "https://api.pickchick.kz")
            self.assertEqual(metadata["uploadCertificateSha256"], sha)
            self.assertEqual(metadata["buildStatus"], "complete")
            self.assertFalse(metadata["uploadPerformed"])
            self.assertEqual(oct(os.stat(output / "release.json").st_mode & 0o777), "0o600")
            bundle = output / metadata["bundle"]
            self.assertEqual(bundle.name, "PickChick-0.2.0-7-production.aab")
            self.assertTrue(bundle.is_file())
            inspect.assert_called_once()
            self.assertEqual(inspect.call_args.kwargs["allow_staging"], False)

    def signing(self):
        return {"store_file": Path("/x"), "store_password": "p", "key_alias": "a", "key_password": "p"}

    def test_refused_build_leaves_no_release_directory(self):
        args = Namespace(apk=False, architectures="arm64-v8a", profile_from_default=False,
                         allow_staging=False, release="play-internal-9")
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(release, "run_logged") as run, \
                patch.object(release, "upload_certificate",
                             return_value={"owner": "CN=Android Debug,O=Android,C=US", "sha256": "AA"}):
            artifacts = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "upload keystore holds the Android debug key"):
                release.start_build(args, "production", self.signing(), artifacts)
            run.assert_not_called()
            self.assertEqual(list(artifacts.iterdir()), [])
            with self.assertRaisesRegex(RuntimeError, "needs the upload key"):
                release.start_build(args, "production", None, artifacts)
            self.assertEqual(list(artifacts.iterdir()), [])

    def test_failed_gradle_keeps_its_log_and_says_failed(self):
        args = Namespace(apk=False, architectures="arm64-v8a", profile_from_default=False,
                         allow_staging=False, release="play-internal-9")

        def run_logged(command, log, cwd, env):
            log.write_text("log")
            if "bundleRelease" in command:
                release.fail("gradlew exited with 1. Review the private log")

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(release, "run_logged", run_logged), \
                patch.object(release, "release_lock", contextlib.nullcontext), \
                patch.object(release, "upload_certificate",
                             return_value={"owner": "CN=PickChick upload", "sha256": "CD"}):
            artifacts = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "gradlew exited"):
                release.start_build(args, "production", self.signing(), artifacts)
            output = artifacts / "play-internal-9"
            self.assertEqual(json.loads((output / "release.json").read_text())["buildStatus"], "failed")
            self.assertTrue((output / "build.log").is_file())
            with self.assertRaisesRegex(RuntimeError, "already exist"):
                release.start_build(args, "production", self.signing(), artifacts)

    def test_staging_test_build_is_named_and_inspected_as_staging(self):
        with tempfile.TemporaryDirectory() as directory:
            native = Path(directory) / "android"
            produced = native / "app/build/outputs/bundle/release/app-release.aab"
            produced.parent.mkdir(parents=True)
            output = Path(directory) / "out"
            output.mkdir()

            def run_logged(command, log, cwd, env):
                self.assertEqual(env["EXPO_PUBLIC_PICKCHICK_ENV"], "staging")
                if "bundleRelease" in command:
                    produced.write_bytes(b"PK synthetic bundle")

            args = Namespace(apk=False, architectures="arm64-v8a", profile_from_default=False,
                             allow_staging=True)
            with patch.object(release, "NATIVE", native), \
                    patch.object(release, "run_logged", run_logged), \
                    patch.object(release, "inspect_bundle") as inspect, \
                    patch.object(release, "event"):
                release.build(args, "storefront", self.signing(), {"owner": "CN=x", "sha256": "CD"},
                              output)
            metadata = json.loads((output / "release.json").read_text())
            self.assertEqual(metadata["bundle"], "PickChick-0.2.0-7-storefront-staging-not-for-play.aab")
            self.assertEqual(inspect.call_args.kwargs["allow_staging"], True)

    def test_build_without_upload_key_stops_and_says_the_backend(self):
        env = {key: value for key, value in os.environ.items()
               if not key.startswith("PICKCHICK_ANDROID_UPLOAD")}
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, release.__file__, "build", "--artifacts-root",
                                     directory, "--release", "unit-test"], capture_output=True,
                                    text=True, env=env)
            self.assertEqual(list(Path(directory).iterdir()), [])
        self.assertEqual(result.returncode, 1)
        lines = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(lines[0]["message"], "Mobile JS bundle backend")
        self.assertEqual(lines[0]["environment"], "production")
        self.assertEqual(lines[0]["api_url"], "https://api.pickchick.kz")
        self.assertIn("never used for Google Play", lines[-1]["reason"])
        self.assertNotIn("Command started", result.stdout)
        staging = subprocess.run([sys.executable, release.__file__, "doctor", "--feature-profile",
                                  "storefront"], capture_output=True, text=True, env=env)
        self.assertEqual(staging.returncode, 1)
        lines = [json.loads(line) for line in staging.stdout.splitlines()]
        # The refused profile is said first, with its staging warning.
        self.assertEqual(lines[0]["message"], "Mobile JS bundle backend")
        self.assertIn("staging host", lines[0]["warning"])
        self.assertIn("--allow-staging", lines[-1]["reason"])


class InspectTests(unittest.TestCase):
    def test_parses_the_manifest_tree_and_passes_a_clean_release(self):
        facts = release.manifest_facts(release.parse_xmltree(XMLTREE))
        self.assertEqual(facts["package"], "kz.pickchick.app")
        self.assertEqual(facts["versionCode"], 7)
        self.assertEqual(facts["versionName"], "0.2.0")
        self.assertEqual((facts["minSdk"], facts["targetSdk"], facts["compileSdk"]), (24, 36, 36))
        self.assertEqual(facts["permissions"], ["android.permission.INTERNET",
                                                "android.permission.POST_NOTIFICATIONS",
                                                "android.permission.VIBRATE"])
        self.assertEqual(facts["querySchemes"], ["dgis"])
        self.assertEqual(facts["deepLinkSchemes"], ["pickchick"])
        self.assertEqual(facts["allowBackup"], "false")
        self.assertEqual(facts["dataExtractionRules"], "@xml/pickchick_data_extraction_rules")
        self.assertIsNone(facts["debuggable"])
        self.assertEqual(release.manifest_problems(facts, 7), [])

    def test_each_play_blocker_is_reported(self):
        application = f"    A: {NS}:allowBackup(0x01010280)=false (Raw: \"false\")"
        cases = {
            "targetSdk 35": XMLTREE.replace("targetSdkVersion(0x01010270)=36",
                                            "targetSdkVersion(0x01010270)=35"),
            "debuggable": with_attribute(XMLTREE, application,
                                         f"        A: {NS}:debuggable(0x0101000f)=true"),
            "usesCleartextTraffic": with_attribute(
                XMLTREE, application, f"        A: {NS}:usesCleartextTraffic(0x010104ec)=true"),
            "allowBackup is not false": XMLTREE.replace("allowBackup(0x01010280)=false (Raw: \"false\")",
                                                        "allowBackup(0x01010280)=true"),
            "forbidden permissions: android.permission.RECORD_AUDIO": XMLTREE.replace(
                "android.permission.VIBRATE", "android.permission.RECORD_AUDIO"),
            "outside the allowlist: android.permission.READ_CONTACTS": XMLTREE.replace(
                "android.permission.VIBRATE", "android.permission.READ_CONTACTS"),
            "dgis": XMLTREE.replace('"dgis"', '"geo"'),
            "exp+": XMLTREE.replace('"pickchick"', '"exp+pickchick"'),
            "versionCode 8": XMLTREE.replace("versionCode(0x0101021b)=7 ", "versionCode(0x0101021b)=8 "),
        }
        for expected, text in cases.items():
            with self.subTest(case=expected):
                problems = "; ".join(release.manifest_problems(
                    release.manifest_facts(release.parse_xmltree(text)), 7))
                self.assertIn(expected, problems)
        self.assertTrue(release.FORBIDDEN_PERMISSIONS.isdisjoint(release.PERMISSION_ALLOWLIST))
        # Trimmed after the tech-lead review: blocked in app.json and no longer allowlisted.
        blocked = set(json.loads((release.APP / "app.json").read_text())["expo"]["android"]
                      ["blockedPermissions"])
        self.assertTrue(release.TRIMMED_PERMISSIONS <= blocked)
        self.assertTrue(release.TRIMMED_PERMISSIONS.isdisjoint(release.PERMISSION_ALLOWLIST))
        self.assertTrue(release.FORBIDDEN_PERMISSIONS <= blocked)
        for permission in sorted(release.TRIMMED_PERMISSIONS):
            with self.subTest(trimmed=permission):
                text = XMLTREE.replace("android.permission.VIBRATE", permission)
                problems = "; ".join(release.manifest_problems(
                    release.manifest_facts(release.parse_xmltree(text)), 7))
                self.assertIn(f"outside the allowlist: {permission}", problems)
        with self.assertRaisesRegex(RuntimeError, "single <manifest>"):
            release.parse_xmltree("N: android=x\n")

    def bundle(self, directory, environment="production", api=ios.PRODUCTION_API_URL, js=True,
               extra=b""):
        path = Path(directory) / f"PickChick-0.2.0-7-{environment}.aab"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("base/assets/app.config", json.dumps(
                {"extra": {"environment": environment, "apiUrl": api}}))
            if js:
                archive.writestr("base/assets/index.android.bundle",
                                 bytes.fromhex("c61fbc03c103191f") + api.encode() + extra)
            archive.writestr("base/manifest/AndroidManifest.xml", b"proto")
            archive.writestr("base/resources.pb", b"proto")
        return path

    def test_embedded_app_config_must_match_the_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            facts = release.embedded_app_config(self.bundle(directory))
            self.assertTrue(facts["hermes_bytecode"])
            self.assertEqual(release.bundle_problems(facts, "production"), [])
            self.assertIn("expected production",
                          release.bundle_problems(facts | {"environment": "staging"}, "production")[0])
            staging = release.embedded_app_config(
                self.bundle(directory, "staging", ios.STAGING_API_URL))
            self.assertEqual(release.bundle_problems(staging, "storefront"), [])
            self.assertTrue(release.bundle_problems(staging, "production"))
            nojs = release.embedded_app_config(self.bundle(directory, js=False))
            self.assertIn("no embedded JS bundle", release.bundle_problems(nojs, "production")[0])
            # Reported, not failed: build-config.ts keeps the staging constant (iOS too).
            self.assertFalse(facts["bundle_mentions_staging_host"])
            known = release.embedded_app_config(
                self.bundle(directory, extra=ios.STAGING_API_URL.encode()))
            self.assertTrue(known["bundle_mentions_staging_host"])
            self.assertEqual(release.bundle_problems(known, "production"), [])

    def test_inspect_says_the_backend_and_refuses_debug_or_foreign_signers(self):
        sha = ":".join(["EF"] * 32)
        metadata = {"featureProfile": "production", "profileFromDefault": True,
                    "uploadCertificateSha256": sha}
        with tempfile.TemporaryDirectory() as directory:
            bundle = self.bundle(directory)
            for owner, signer, expected in [("CN=PickChick upload", sha, None),
                                            ("CN=Android Debug,O=Android", sha, "debug key"),
                                            ("CN=PickChick upload", "00", "different key")]:
                seen = []
                with self.subTest(owner=owner, signer=signer), \
                        patch.object(release, "dump_manifest", return_value=XMLTREE), \
                        patch.object(release, "signed_certificate",
                                     return_value={"owner": owner, "sha256": signer}), \
                        patch.object(release, "event",
                                     lambda message, **data: seen.append((message, data))):
                    if expected:
                        with self.assertRaisesRegex(RuntimeError, expected):
                            release.inspect_bundle(bundle, metadata, aapt2=Path("aapt2"),
                                                   expected_version_code=7)
                    else:
                        release.inspect_bundle(bundle, metadata, aapt2=Path("aapt2"),
                                               expected_version_code=7)
                        self.assertEqual(seen[-1][0], "Inspect PASS")
                    self.assertEqual(seen[0][0], "Mobile JS bundle backend")
                    self.assertEqual(seen[0][1]["environment"], "production")

    def test_inspect_fails_a_staging_bundle_unless_it_is_a_named_local_test(self):
        metadata = {"featureProfile": "storefront", "profileFromDefault": False,
                    "uploadCertificateSha256": "EF"}
        with tempfile.TemporaryDirectory() as directory:
            bundle = self.bundle(directory, "staging", ios.STAGING_API_URL)
            seen = []
            with patch.object(release, "dump_manifest", return_value=XMLTREE), \
                    patch.object(release, "signed_certificate",
                                 return_value={"owner": "CN=PickChick upload", "sha256": "EF"}), \
                    patch.object(release, "event",
                                 lambda message, **data: seen.append((message, data))):
                with self.assertRaisesRegex(RuntimeError, "Inspect FAIL: .*storefront profile talks "
                                                          "to the staging host.*--allow-staging"):
                    release.inspect_bundle(bundle, metadata, aapt2=Path("aapt2"),
                                           expected_version_code=7)
                self.assertNotIn("Inspect PASS", [message for message, _ in seen])
                self.assertIn("warning", seen[0][1])
                seen.clear()
                release.inspect_bundle(bundle, metadata, aapt2=Path("aapt2"),
                                       expected_version_code=7, allow_staging=True)
            message, data = seen[-1]
            self.assertEqual(message, "Inspect PASS for a local test only - NOT for Google Play")
            self.assertFalse(data["google_play_profile"])
            # A production bundle mislabelled as staging (or the reverse) still fails.
            with patch.object(release, "dump_manifest", return_value=XMLTREE), \
                    patch.object(release, "signed_certificate",
                                 return_value={"owner": "CN=PickChick upload", "sha256": "EF"}), \
                    patch.object(release, "event"):
                with self.assertRaisesRegex(RuntimeError, "embedded app config is staging"):
                    release.inspect_bundle(bundle, {**metadata, "featureProfile": "production"},
                                           aapt2=Path("aapt2"), expected_version_code=7,
                                           allow_staging=True)

    def test_doctor_lists_missing_toolchain_parts(self):
        report = {"android_home": None, "platform_36": False, "build_tools_ok": False,
                  "ndk_present": False, "ndk_required": "27.1.12297006", "cmake_present": False,
                  "react_native_target_sdk": "35", "build_tools_required": ["35.0.0", "36.0.0"]}
        problems = "; ".join(release.doctor_problems(report, 11))
        for text in ["ANDROID_HOME", "android-36", "build-tools 35.0.0, 36.0.0", "NDK 27.1.12297006",
                     "CMake", "targetSdk is below 36", "JDK 17"]:
            self.assertIn(text, problems)
        ready = {**report, "android_home": "/sdk", "platform_36": True, "build_tools_ok": True,
                 "ndk_present": True, "cmake_present": True, "react_native_target_sdk": "36"}
        self.assertEqual(release.doctor_problems(ready, 21), [])

    def test_sdk_report_requires_react_native_and_agp_build_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            sdk = Path(directory)
            (sdk / "build-tools/36.0.0").mkdir(parents=True)
            report = release.sdk_report({"ANDROID_HOME": str(sdk)})
            self.assertEqual(report["build_tools_required"], ["35.0.0", "36.0.0"])
            self.assertFalse(report["build_tools_ok"])
            (sdk / "build-tools/35.0.0").mkdir()
            self.assertTrue(release.sdk_report({"ANDROID_HOME": str(sdk)})["build_tools_ok"])

    def test_react_native_asks_for_api_36(self):
        versions = release.required_native_versions()
        self.assertGreaterEqual(int(versions["target_sdk"]), 36)
        self.assertGreaterEqual(int(versions["compile_sdk"]), 36)


if __name__ == "__main__":
    unittest.main()
