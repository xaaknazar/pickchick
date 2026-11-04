#!/usr/bin/env python3
"""Build and inspect the PickChick Android App Bundle for Google Play (no upload).

Phases:
- doctor  - JDK, Android SDK (platform 36, build-tools, NDK and CMake that React Native asks
            for), the selected profile and the upload keystore inputs (never their values);
- build   - `expo prebuild --platform android --clean` with the profile's pinned public values,
            then `./gradlew bundleRelease` (optional `--apk`: also a universal release APK for a
            local install), signed with the upload key, copied out of the repository with a
            private release.json; inspect runs at the end;
- inspect - the merged manifest inside the AAB (package, versions, SDK levels, debuggable,
            cleartext traffic, backups, permissions against an allowlist, 2GIS query) and the
            app config Expo embedded in it (environment, API origin).

Profiles are the mobile profiles of ios_release.py (one model for both stores). The only Google
Play profile is `production` (https://api.pickchick.kz), also the default here; a staging profile
needs --allow-staging and is refused for a release label that says release or upload.

Signing: the upload keystore and its passwords come only from the environment
(PICKCHICK_ANDROID_UPLOAD_KEYSTORE, PICKCHICK_ANDROID_UPLOAD_KEYSTORE_PASSWORD,
PICKCHICK_ANDROID_UPLOAD_KEY_ALIAS, PICKCHICK_ANDROID_UPLOAD_KEY_PASSWORD) or a private 0600 file
with the same KEY=value lines (--signing-file). Nothing of it is printed, written to release.json
or passed on a command line: Gradle reads AGP's injected signing properties from its environment.
A bundle signed with the Android debug key is refused. Nothing is uploaded to Google.
"""

import argparse
from contextlib import contextmanager
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "apps/mobile"
NATIVE = APP / "android"
PACKAGE = "kz.pickchick.app"
DEFAULT_PROFILE = "production"
MIN_TARGET_SDK = 36
# Google Play / Expo SDK 57 / React Native 0.86 native toolchain.
PLATFORM = "android-36"
BUILD_TOOLS_MAJOR = "36"
CMAKE_VERSION = "3.22.1"
SIGNING_KEYS = ("PICKCHICK_ANDROID_UPLOAD_KEYSTORE", "PICKCHICK_ANDROID_UPLOAD_KEYSTORE_PASSWORD",
                "PICKCHICK_ANDROID_UPLOAD_KEY_ALIAS", "PICKCHICK_ANDROID_UPLOAD_KEY_PASSWORD")
# AGP reads these Gradle properties (Android Studio's «Generate Signed Bundle» uses them);
# ORG_GRADLE_PROJECT_* environment entries keep them off the command line.
INJECTED = {
    "store_file": "android.injected.signing.store.file",
    "store_password": "android.injected.signing.store.password",
    "key_alias": "android.injected.signing.key.alias",
    "key_password": "android.injected.signing.key.password",
}
ANDROID_NS = "http://schemas.android.com/apk/res/android"
# Permissions the release may request (lane android, 05.11.2026). Anything else fails inspect:
# a library that starts asking for more must be reviewed (Data safety form) before release.
PERMISSION_ALLOWLIST = {
    "android.permission.INTERNET": "API, menu photos, Kaspi status",
    "android.permission.ACCESS_NETWORK_STATE": "offline banner (NetInfo), image loading",
    "android.permission.ACCESS_WIFI_STATE": "NetInfo connection details",
    "android.permission.VIBRATE": "slide-to-pay haptics fallback (expo-haptics)",
    "android.permission.POST_NOTIFICATIONS": "order status notifications (Android 13+)",
    "android.permission.RECEIVE_BOOT_COMPLETED": "expo-notifications keeps scheduled items",
    "android.permission.WAKE_LOCK": "push delivery (Firebase Messaging)",
    "com.google.android.c2dm.permission.RECEIVE": "push delivery (Firebase Messaging)",
    "com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE":
        "expo-application install referrer (not called by the app)",
    f"{PACKAGE}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION": "AndroidX internal signature permission",
}
# Never in a Play build: these collect data the Data safety form says we do not collect, or
# grant powers the app does not use (they are blocked in app.json too).
FORBIDDEN_PERMISSIONS = {
    "android.permission.RECORD_AUDIO", "android.permission.CAMERA",
    "android.permission.SYSTEM_ALERT_WINDOW", "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_BACKGROUND_LOCATION",
    "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE",
    "android.permission.READ_PHONE_STATE", "com.google.android.gms.permission.AD_ID",
    "android.permission.REQUEST_INSTALL_PACKAGES",
}
DEBUG_CERT_OWNER = "CN=Android Debug"

_spec = importlib.util.spec_from_file_location("ios_release", Path(__file__).with_name("ios_release.py"))
ios = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ios)

event = ios.event
fail = ios.fail


def default_artifacts_root():
    if sys.platform == "darwin":
        return Path.home() / "Library/Caches/PickChick/android-releases"
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "PickChick/android-releases"


# Profiles ------------------------------------------------------------------------------------

def select_profile(requested, allow_staging, release_label):
    """The bundle's profile: production by default; staging only when said twice, never for a release."""
    profile = ios.canonical_profile(requested or DEFAULT_PROFILE)
    if profile not in ios.MOBILE_PROFILES:
        fail("Android builds accept only the mobile feature profiles of ios_release.py.")
    if ios.feature_profile_flags(profile) is None:
        fail("Android builds need a pinned mobile profile; legacy and kiosk profiles are refused.")
    environment, _ = ios.profile_backend(profile)
    if environment != "production":
        if not allow_staging:
            fail(f"The {profile} profile talks to the staging host. Google Play builds use the "
                 "production profile; pass --allow-staging only for a local test build.")
        if re.search(r"release|upload", release_label or "", re.IGNORECASE):
            fail(f"A staging ({profile}) build cannot carry a release or upload label; "
                 "Google Play gets only --feature-profile production.")
    return profile


def backend_notice(profile, defaulted):
    """The «Mobile JS bundle backend» event, said in every phase."""
    environment, api_url = ios.profile_backend(profile)
    notice = {"feature_profile": ios.canonical_profile(profile), "environment": environment,
              "api_url": api_url, "profile_from_default": defaulted, "platform": "android"}
    if environment != "production":
        notice["warning"] = ("This bundle talks to the staging host. Google Play builds need "
                             "--feature-profile production (https://api.pickchick.kz).")
    return notice


def bundle_environment(profile, source=None):
    """ios_release's pinned bundle values (API override and leftover flags removed) + build env."""
    env = ios.archive_environment(profile, source)
    if env is None:
        fail("Android builds need a pinned mobile profile.")
    env.update(CI="1", EXPO_NO_TELEMETRY="1")
    return env


# Signing -------------------------------------------------------------------------------------

def git_ignored(path):
    """True when a path inside the repository is ignored and untracked (never reaches Git)."""
    tracked = subprocess.run(["git", "ls-files", "--error-unmatch", str(path)], cwd=ROOT,
                             capture_output=True, text=True)
    ignored = subprocess.run(["git", "check-ignore", "-q", str(path)], cwd=ROOT,
                             capture_output=True, text=True)
    return tracked.returncode != 0 and ignored.returncode == 0


def private_outside_git(value, label):
    path = ios.private_file(value, label)
    if path.is_relative_to(ROOT.resolve()) and not git_ignored(path):
        fail(f"{label} lies in the repository and is not ignored by Git; keep it outside the "
             "repository (or, for a throwaway test key only, under .local/).")
    return path


def read_signing_file(value):
    path = private_outside_git(value, "Signing file")
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, item = line.partition("=")
        if not separator or key.strip() not in SIGNING_KEYS:
            fail("The signing file may contain only the four PICKCHICK_ANDROID_UPLOAD_* lines.")
        values[key.strip()] = item.strip()
    return values


def signing_inputs(source=None, signing_file=None):
    """Upload key inputs from the environment or a private file; None when nothing is given."""
    source = os.environ if source is None else source
    values = {key: source[key] for key in SIGNING_KEYS if source.get(key)}
    if signing_file:
        if values:
            fail("Give the upload key either in the environment or in --signing-file, not both.")
        values = read_signing_file(signing_file)
    if not values:
        return None
    missing = [key for key in SIGNING_KEYS if not values.get(key)]
    if missing:
        fail("Upload signing is incomplete; missing: " + ", ".join(missing) + ".")
    return {
        "store_file": private_outside_git(values["PICKCHICK_ANDROID_UPLOAD_KEYSTORE"],
                                          "Upload keystore"),
        "store_password": values["PICKCHICK_ANDROID_UPLOAD_KEYSTORE_PASSWORD"],
        "key_alias": values["PICKCHICK_ANDROID_UPLOAD_KEY_ALIAS"],
        "key_password": values["PICKCHICK_ANDROID_UPLOAD_KEY_PASSWORD"],
    }


def gradle_signing_env(signing):
    return {f"ORG_GRADLE_PROJECT_{INJECTED[key]}": str(value) for key, value in signing.items()}


def keytool_certificate(args, env=None):
    """SHA-256 fingerprint and owner from `keytool -v` output (public certificate data only)."""
    result = subprocess.run(["keytool", *args, "-v"], capture_output=True, text=True, env=env)
    if result.returncode:
        fail("keytool could not read the certificate; no password or key material printed.")
    owner = re.search(r"^\s*Owner:\s*(.+)$", result.stdout, re.MULTILINE)
    sha256 = re.search(r"SHA256:\s*([0-9A-F:]{95})", result.stdout)
    if not owner or not sha256:
        fail("keytool output did not contain a certificate owner and SHA-256 fingerprint.")
    return {"owner": owner.group(1).strip(), "sha256": sha256.group(1)}


def upload_certificate(signing):
    """The upload key's certificate, read with passwords passed through keytool's :env form."""
    env = {**os.environ, "PICKCHICK_KEYTOOL_STOREPASS": signing["store_password"]}
    return keytool_certificate(["-list", "-keystore", str(signing["store_file"]), "-alias",
                                signing["key_alias"], "-storepass:env",
                                "PICKCHICK_KEYTOOL_STOREPASS"], env)


def refuse_debug_certificate(certificate, debug_sha256=None):
    if DEBUG_CERT_OWNER in certificate["owner"] or (debug_sha256 and certificate["sha256"] == debug_sha256):
        fail("This bundle is signed with the Android debug key; Google Play needs the upload key.")


# Commands ------------------------------------------------------------------------------------

def prebuild_command():
    return [shutil.which("node") or "node", str(APP / "node_modules/expo/bin/cli"), "prebuild",
            "--platform", "android", "--clean", "--no-install"]


def gradle_command(apk=False, architectures="arm64-v8a,armeabi-v7a,x86_64"):
    if not re.fullmatch(r"(arm64-v8a|armeabi-v7a|x86|x86_64)(,(arm64-v8a|armeabi-v7a|x86|x86_64))*",
                        architectures):
        fail("--architectures lists Android ABIs separated by commas.")
    return ["./gradlew", "--no-daemon", "--console=plain", "bundleRelease",
            *(["assembleRelease"] if apk else []), f"-PreactNativeArchitectures={architectures}"]


def run_logged(command, log, cwd, env):
    event("Command started", command="expo prebuild" if "prebuild" in command else "gradlew",
          log=str(log))
    with log.open("a", encoding="utf-8") as handle:
        os.chmod(log, 0o600)
        result = subprocess.run(command, cwd=cwd, stdout=handle, stderr=subprocess.STDOUT, env=env)
    if result.returncode:
        fail(f"{Path(command[0]).name} exited with {result.returncode}. Review the private log: {log}")


@contextmanager
def release_lock():
    lock = ROOT / ".local/mobile-android/release.lock"
    lock.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        fail("Another Android release phase is active, or its lock remains after interruption.")
    try:
        os.write(descriptor, f"{os.getpid()}\n".encode())
        os.close(descriptor)
        yield
    finally:
        lock.unlink()


# Inspect -------------------------------------------------------------------------------------

def parse_xmltree(text):
    """Parse `aapt2 dump xmltree` output into nested {"name", "attrs", "children"} elements."""
    root = {"name": None, "attrs": {}, "children": []}
    stack = [(-1, root)]
    for line in text.splitlines():
        match = re.match(r"^(\s*)([NEA]): (.*)$", line)
        if not match:
            continue
        depth, kind, body = len(match.group(1)), match.group(2), match.group(3)
        if kind == "N":
            continue
        while stack[-1][0] >= depth:
            stack.pop()
        parent = stack[-1][1]
        if kind == "E":
            element = {"name": body.split(" (line=")[0].strip(), "attrs": {}, "children": []}
            parent["children"].append(element)
            stack.append((depth, element))
        else:
            name, _, value = body.partition("=")
            name = re.sub(r"\(0x[0-9a-fA-F]+\)$", "", name.strip())
            if name.startswith(ANDROID_NS + ":"):
                name = "android:" + name[len(ANDROID_NS) + 1:]
            value = re.sub(r'\s+\(Raw: ".*"\)$', "", value.strip())
            if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
                value = value[1:-1]
            parent["attrs"][name] = value
    manifests = [child for child in root["children"] if child["name"] == "manifest"]
    if len(manifests) != 1:
        fail("The bundle manifest could not be read (no single <manifest> element).")
    return manifests[0]


def children(element, name):
    return [child for child in element["children"] if child["name"] == name]


def integer(value):
    if value is None:
        return None
    value = str(value)
    try:
        return int(value, 16) if value.lower().startswith("0x") else int(value)
    except ValueError:
        return None


def truthy(value):
    return str(value).lower() in {"true", "0xffffffff", "-1", "1"}


def manifest_facts(manifest):
    sdk = (children(manifest, "uses-sdk") or [{"attrs": {}}])[0]["attrs"]
    application = (children(manifest, "application") or [{"attrs": {}, "children": []}])[0]
    app = application["attrs"]
    permissions = sorted({item["attrs"].get("android:name", "")
                          for tag in ("uses-permission", "uses-permission-sdk-23")
                          for item in children(manifest, tag)})
    schemes = sorted({data["attrs"].get("android:scheme", "")
                      for query in children(manifest, "queries")
                      for intent in children(query, "intent")
                      for data in children(intent, "data")} - {""})
    activities = children(application, "activity")
    launcher_schemes = sorted({data["attrs"].get("android:scheme", "")
                               for activity in activities
                               for intent in children(activity, "intent-filter")
                               for data in children(intent, "data")} - {""})
    return {
        "package": manifest["attrs"].get("package"),
        "versionCode": integer(manifest["attrs"].get("android:versionCode")),
        "versionName": manifest["attrs"].get("android:versionName"),
        "minSdk": integer(sdk.get("android:minSdkVersion")),
        "targetSdk": integer(sdk.get("android:targetSdkVersion")),
        "compileSdk": integer(manifest["attrs"].get("android:compileSdkVersion")),
        "debuggable": app.get("android:debuggable"),
        "testOnly": app.get("android:testOnly"),
        "usesCleartextTraffic": app.get("android:usesCleartextTraffic"),
        "allowBackup": app.get("android:allowBackup"),
        "dataExtractionRules": app.get("android:dataExtractionRules"),
        "enableOnBackInvokedCallback": app.get("android:enableOnBackInvokedCallback"),
        "permissions": permissions,
        "querySchemes": schemes,
        "deepLinkSchemes": launcher_schemes,
    }


def manifest_problems(facts, expected_version_code=None):
    problems = []
    if facts["package"] != PACKAGE:
        problems.append(f"package is {facts['package']}, expected {PACKAGE}")
    if expected_version_code is not None and facts["versionCode"] != expected_version_code:
        problems.append(f"versionCode {facts['versionCode']} differs from app.json {expected_version_code}")
    if (facts["targetSdk"] or 0) < MIN_TARGET_SDK:
        problems.append(f"targetSdk {facts['targetSdk']} is below Google Play's {MIN_TARGET_SDK}")
    if facts["debuggable"] is not None and truthy(facts["debuggable"]):
        problems.append("android:debuggable is set")
    if facts["testOnly"] is not None and truthy(facts["testOnly"]):
        problems.append("android:testOnly is set")
    if facts["usesCleartextTraffic"] is not None and truthy(facts["usesCleartextTraffic"]):
        problems.append("usesCleartextTraffic is true")
    if facts["allowBackup"] is None or truthy(facts["allowBackup"]):
        problems.append("allowBackup is not false (session and payment state must not be backed up)")
    if not facts["dataExtractionRules"]:
        problems.append("dataExtractionRules missing (device-to-device transfer not excluded)")
    if "dgis" not in facts["querySchemes"]:
        problems.append("no <queries> entry for dgis: (2GIS app detection on Android 11+)")
    unexpected = [name for name in facts["permissions"] if name not in PERMISSION_ALLOWLIST]
    if unexpected:
        problems.append("permissions outside the allowlist: " + ", ".join(unexpected))
    forbidden = sorted(set(facts["permissions"]) & FORBIDDEN_PERMISSIONS)
    if forbidden:
        problems.append("forbidden permissions: " + ", ".join(forbidden))
    if any(scheme.startswith("exp+") for scheme in facts["deepLinkSchemes"]):
        problems.append("a development client scheme (exp+) reached the release")
    return problems


def embedded_app_config(bundle):
    """The app config Expo embeds (expo-constants) and whether the Hermes bundle is present."""
    with zipfile.ZipFile(bundle) as archive:
        names = set(archive.namelist())
        config = json.loads(archive.read("base/assets/app.config")) if "base/assets/app.config" in names else None
        js = "base/assets/index.android.bundle"
        bundle_bytes = archive.read(js) if js in names else b""
    extra = (config or {}).get("extra", {})
    return {
        "app_config_embedded": config is not None,
        "environment": extra.get("environment"),
        "api_url": extra.get("apiUrl"),
        "js_bundle_embedded": bool(bundle_bytes),
        "hermes_bytecode": bundle_bytes[:8] == bytes.fromhex("c61fbc03c103191f"),
        "bundle_mentions_production_api": ios.PRODUCTION_API_URL.encode() in bundle_bytes,
    }


def bundle_problems(app_config, profile):
    environment, api_url = ios.profile_backend(profile)
    problems = []
    if not app_config["js_bundle_embedded"]:
        problems.append("no embedded JS bundle (Metro must not be a release dependency)")
    if not app_config["app_config_embedded"]:
        problems.append("no embedded app config")
    elif (app_config["environment"], app_config["api_url"]) != (environment, api_url):
        problems.append(f"embedded app config is {app_config['environment']} / {app_config['api_url']}, "
                        f"expected {environment} / {api_url}")
    if environment == "production" and not app_config["bundle_mentions_production_api"]:
        problems.append("the JS bundle does not contain the production API origin")
    return problems


def find_aapt2(source=None):
    source = os.environ if source is None else source
    home = source.get("ANDROID_HOME") or source.get("ANDROID_SDK_ROOT")
    if home:
        tools = sorted((Path(home) / "build-tools").glob(f"{BUILD_TOOLS_MAJOR}*/aapt2"))
        if tools:
            return tools[-1]
    found = shutil.which("aapt2")
    if not found:
        fail("aapt2 not found: set ANDROID_HOME to the SDK with build-tools 36.")
    return Path(found)


def dump_manifest(bundle, aapt2):
    """aapt2 reads the proto manifest of the AAB base module as a proto APK."""
    with zipfile.ZipFile(bundle) as archive, tempfile.TemporaryDirectory() as directory:
        names = set(archive.namelist())
        if "base/manifest/AndroidManifest.xml" not in names or "base/resources.pb" not in names:
            fail("This is not an Android App Bundle with a base module.")
        apk = Path(directory) / "base-proto.apk"
        with zipfile.ZipFile(apk, "w") as out:
            out.writestr("AndroidManifest.xml", archive.read("base/manifest/AndroidManifest.xml"))
            out.writestr("resources.pb", archive.read("base/resources.pb"))
        result = subprocess.run([str(aapt2), "dump", "xmltree", "--file", "AndroidManifest.xml",
                                 str(apk)], capture_output=True, text=True)
    if result.returncode:
        fail("aapt2 could not dump the bundle manifest: " + result.stderr.strip()[:300])
    return result.stdout


def signed_certificate(bundle):
    return keytool_certificate(["-printcert", "-jarfile", str(bundle)])


def inspect_bundle(bundle, metadata, aapt2=None, expected_version_code=None):
    profile = metadata.get("featureProfile")
    if not profile:
        fail("release.json beside the bundle names no profile; inspect only bundles built by this script.")
    event("Mobile JS bundle backend", **backend_notice(profile, metadata.get("profileFromDefault", False)))
    facts = manifest_facts(parse_xmltree(dump_manifest(bundle, aapt2 or find_aapt2())))
    app_config = embedded_app_config(bundle)
    certificate = signed_certificate(bundle)
    problems = manifest_problems(facts, expected_version_code) + bundle_problems(app_config, profile)
    if DEBUG_CERT_OWNER in certificate["owner"]:
        problems.append("signed with the Android debug key")
    if metadata.get("uploadCertificateSha256") and certificate["sha256"] != metadata["uploadCertificateSha256"]:
        problems.append("signed with a different key than the recorded upload key")
    event("Android bundle manifest", **facts,
          allowlisted_permissions={name: PERMISSION_ALLOWLIST.get(name, "NOT ALLOWED")
                                   for name in facts["permissions"]})
    event("Android bundle contents", **app_config, signer_sha256=certificate["sha256"],
          signer_is_debug_key=DEBUG_CERT_OWNER in certificate["owner"])
    if problems:
        fail("Inspect FAIL: " + "; ".join(problems))
    event("Inspect PASS", bundle=str(bundle), google_play_profile=profile == DEFAULT_PROFILE,
          upload_performed=False)
    return facts


# Doctor --------------------------------------------------------------------------------------

def required_native_versions():
    """NDK and build-tools React Native asks for (its version catalog), read from node_modules."""
    catalog = (APP / "node_modules/react-native/gradle/libs.versions.toml")
    text = catalog.read_text() if catalog.is_file() else ""
    def version(name):
        match = re.search(rf'^{name}\s*=\s*"([^"]+)"', text, re.MULTILINE)
        return match.group(1) if match else None
    return {"ndk": version("ndkVersion"), "build_tools": version("buildTools"),
            "compile_sdk": version("compileSdk"), "target_sdk": version("targetSdk"),
            "min_sdk": version("minSdk")}


def sdk_report(source=None):
    source = os.environ if source is None else source
    home = source.get("ANDROID_HOME") or source.get("ANDROID_SDK_ROOT")
    versions = required_native_versions()
    sdk = Path(home) if home else None
    present = lambda relative: bool(sdk and (sdk / relative).exists())
    report = {
        "android_home": str(sdk) if sdk else None,
        "platform_36": present(f"platforms/{PLATFORM}/android.jar"),
        "build_tools": sorted(path.name for path in (sdk / "build-tools").glob("*")) if present("build-tools") else [],
        "ndk_required": versions["ndk"],
        "ndk_present": bool(versions["ndk"]) and present(f"ndk/{versions['ndk']}/source.properties"),
        "cmake_present": present(f"cmake/{CMAKE_VERSION}/bin/cmake"),
        "react_native_target_sdk": versions["target_sdk"],
        "react_native_compile_sdk": versions["compile_sdk"],
        "react_native_min_sdk": versions["min_sdk"],
    }
    report["build_tools_ok"] = (versions["build_tools"] or "") in report["build_tools"]
    return report


def doctor_problems(report, java_major):
    problems = []
    if not report["android_home"]:
        problems.append("ANDROID_HOME is not set")
    if not report["platform_36"]:
        problems.append("SDK platform android-36 is missing")
    if not report["build_tools_ok"]:
        problems.append("the build-tools version React Native asks for is missing")
    if not report["ndk_present"]:
        problems.append(f"NDK {report['ndk_required']} is missing")
    if not report["cmake_present"]:
        problems.append(f"CMake {CMAKE_VERSION} is missing")
    if (integer(report["react_native_target_sdk"]) or 0) < MIN_TARGET_SDK:
        problems.append("React Native's targetSdk is below 36 (add expo-build-properties)")
    if java_major is None or java_major < 17:
        problems.append("JDK 17 or newer is required")
    return problems


def java_major():
    try:
        result = subprocess.run(["java", "-version"], capture_output=True, text=True)
    except OSError:
        return None
    match = re.search(r'version "(\d+)', result.stderr + result.stdout)
    return int(match.group(1)) if match else None


# Main ----------------------------------------------------------------------------------------

def app_json():
    return json.loads((APP / "app.json").read_text())["expo"]


def write_private_json(path, data):
    ios.write_private_json(path, data)


def build(args, profile, signing, output):
    config = app_json()
    android = config.get("android", {})
    if android.get("package") != PACKAGE:
        fail("app.json must select the kz.pickchick.app Android package.")
    certificate = upload_certificate(signing)
    refuse_debug_certificate(certificate)
    env = {**bundle_environment(profile), **gradle_signing_env(signing)}
    log = output / "build.log"
    metadata = {
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "package": PACKAGE, "versionName": config.get("version"),
        "versionCode": android.get("versionCode"), "featureProfile": profile,
        "profileFromDefault": args.profile_from_default,
        "environment": ios.profile_backend(profile)[0], "apiUrl": ios.profile_backend(profile)[1],
        "embeddedPublicEnv": ios.feature_profile_flags(profile),
        "architectures": args.architectures, "apk": args.apk,
        "uploadCertificateSha256": certificate["sha256"],
        "gitSha": ios.local_command(["git", "rev-parse", "HEAD"]).strip(),
        "dirty": bool(ios.local_command(["git", "status", "--porcelain"]).strip()),
        "buildStatus": "started", "uploadPerformed": False,
    }
    write_private_json(output / "release.json", metadata)
    run_logged(prebuild_command(), log, APP, env)
    run_logged(gradle_command(args.apk, args.architectures), log, NATIVE, env)
    produced = NATIVE / "app/build/outputs/bundle/release/app-release.aab"
    if not produced.is_file():
        fail("Gradle finished without app-release.aab.")
    bundle = output / f"PickChick-{metadata['versionName']}-{metadata['versionCode']}.aab"
    shutil.copy2(produced, bundle)
    os.chmod(bundle, 0o600)
    if args.apk:
        apk = NATIVE / "app/build/outputs/apk/release/app-release.apk"
        if apk.is_file():
            shutil.copy2(apk, output / f"PickChick-{metadata['versionName']}-{metadata['versionCode']}.apk")
    metadata.update(buildStatus="complete", bundle=bundle.name,
                    bundleSha256=hashlib.sha256(bundle.read_bytes()).hexdigest())
    write_private_json(output / "release.json", metadata)
    event("PickChick Android bundle built", bundle=str(bundle), upload_performed=False)
    inspect_bundle(bundle, metadata, expected_version_code=metadata["versionCode"])


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("phase", choices=["doctor", "build", "inspect"])
    parser.add_argument("--feature-profile", choices=list(ios.MOBILE_PROFILES), default=None,
                        help="JS feature set; production (default) is the only Google Play profile")
    parser.add_argument("--allow-staging", action="store_true",
                        help="Permit a staging profile for a local test build (never a release)")
    parser.add_argument("--release", default="play-internal",
                        help="Release label: the artifacts directory name")
    parser.add_argument("--artifacts-root", default=str(default_artifacts_root()),
                        help="Private output directory outside the repository and iCloud")
    parser.add_argument("--signing-file", help="Private 0600 file with the PICKCHICK_ANDROID_UPLOAD_* lines")
    parser.add_argument("--apk", action="store_true", help="Also build a universal release APK")
    parser.add_argument("--architectures", default="arm64-v8a,armeabi-v7a,x86_64",
                        help="ABIs to compile (Play: the default; a local test: arm64-v8a)")
    parser.add_argument("--bundle", help="inspect: an .aab with release.json beside it")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", args.release):
        fail("Use a short release label containing only letters, numbers, dot, dash or underscore.")
    args.profile_from_default = args.feature_profile is None

    if args.phase == "inspect":
        output = ios.artifact_root(args.artifacts_root) / args.release
        bundle = Path(args.bundle).expanduser().resolve() if args.bundle else None
        if bundle is None:
            candidates = sorted(output.glob("*.aab"))
            if len(candidates) != 1:
                fail(f"Expected one .aab in {output}; pass --bundle.")
            bundle = candidates[0]
        metadata_path = bundle.with_name("release.json")
        if not metadata_path.is_file():
            fail("release.json is missing beside the bundle; inspect only bundles built by this script.")
        metadata = json.loads(metadata_path.read_text())
        inspect_bundle(bundle, metadata, expected_version_code=app_json()["android"].get("versionCode"))
        return

    profile = select_profile(args.feature_profile, args.allow_staging, args.release)
    signing = signing_inputs(signing_file=args.signing_file)
    artifacts = ios.artifact_root(args.artifacts_root)

    if args.phase == "doctor":
        event("Mobile JS bundle backend", **backend_notice(profile, args.profile_from_default))
        report = sdk_report()
        major = java_major()
        event("Local Android build environment", java_major=major, **report,
              package=PACKAGE, artifacts_root=str(artifacts))
        if signing:
            certificate = upload_certificate(signing)
            refuse_debug_certificate(certificate)
            event("Upload key inputs verified", alias_present=True,
                  certificate_sha256=certificate["sha256"], values_printed=False)
        else:
            event("No upload key configured", required_for="build",
                  variables=list(SIGNING_KEYS))
        problems = doctor_problems(report, major)
        if problems:
            fail("Doctor FAIL: " + "; ".join(problems))
        event("Doctor does not contact Google Play or prove Play Console access")
        return

    if not signing:
        fail("A release bundle needs the upload key (PICKCHICK_ANDROID_UPLOAD_* or --signing-file); "
             "the Android debug key is never used for Google Play.")
    event("Mobile JS bundle backend", **backend_notice(profile, args.profile_from_default))
    os.umask(0o077)
    output = artifacts / args.release
    if output.exists() and any(output.iterdir()):
        fail("Release artifacts already exist. Use a new --release label; nothing is overwritten.")
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    with release_lock():
        build(args, profile, signing, output)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, OSError, zipfile.BadZipFile, json.JSONDecodeError) as error:
        event("Stopped", reason=str(error))
        sys.exit(1)
