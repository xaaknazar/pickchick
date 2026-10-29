#!/usr/bin/env python3
"""Build an explicitly allowlisted PickChick app with the selected Xcode account."""

import argparse
from contextlib import contextmanager, ExitStack
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shlex
import subprocess
import sys
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[2]
TEAM = "DAJTP6MC3Q"
BUNDLE = "kz.pickchick.app"
APP_DIRECTORY = "mobile"
APP_TARGET = "PickChick"
INTERNAL_ONLY = False
DEFAULT_ARTIFACTS_ROOT = Path.home() / "Library/Caches/PickChick/releases"
# The JS bundle reads the back-office publication unless EXPO_PUBLIC_PUBLISHED_CATALOG is "0".
# Every pinned profile therefore names its catalog source explicitly.
CUSTOMER_PILOT_FLAGS = {
    "EXPO_PUBLIC_CUSTOMER_AUTH": "server",
    "EXPO_PUBLIC_KASPI_CHECKOUT": "1",
    "EXPO_PUBLIC_ORDER_SIMULATOR": "0",
    "EXPO_PUBLIC_UNPAID_TEST_ORDERS": "0",
    "EXPO_PUBLIC_PUBLISHED_CATALOG": "0",
}
FARM_PILOT_FLAGS = {**CUSTOMER_PILOT_FLAGS, "EXPO_PUBLIC_PICK_FARM": "1"}
# Default mobile release: everything of farm-pilot, reading the published catalog.
PUBLISHED_CATALOG_FLAGS = {**FARM_PILOT_FLAGS, "EXPO_PUBLIC_PUBLISHED_CATALOG": "1"}
CATALOG_PILOT_FLAGS = PUBLISHED_CATALOG_FLAGS
# Owner decision 2026-10-10: Pick Farm is removed from the app. The default release reads the
# published catalog without the farm; published-catalog stays for already recorded archives.
STOREFRONT_FLAGS = {**CUSTOMER_PILOT_FLAGS, "EXPO_PUBLIC_PUBLISHED_CATALOG": "1", "EXPO_PUBLIC_PICK_FARM": "0"}
DEFAULT_MOBILE_PROFILE = "storefront"
# Audit 2.2/7.3: the public App Store build uses the owned domain (apps/mobile/src/build-config.ts).
# Every other profile pins staging, whatever the invoking shell exports.
STAGING_API_URL = "https://pickchick.185.129.51.103.nip.io"
PRODUCTION_API_URL = "https://api.pickchick.kz"
PRODUCTION_FLAGS = {**STOREFRONT_FLAGS, "EXPO_PUBLIC_PICKCHICK_ENV": "production"}
# Older names of the same flag set; archives recorded under an alias stay deliverable.
PROFILE_ALIASES = {"catalog-pilot": "published-catalog"}
MOBILE_PROFILES = ("customer-pilot", "farm-pilot", "published-catalog", DEFAULT_MOBILE_PROFILE,
                   "production", *PROFILE_ALIASES)
# Archives made before the catalog source was pinned recorded these exact flag sets; their
# bundles were built when an unset flag still meant the legacy catalog.
HISTORICAL_PROFILE_FLAGS = {
    "customer-pilot": {key: value for key, value in CUSTOMER_PILOT_FLAGS.items()
                       if key != "EXPO_PUBLIC_PUBLISHED_CATALOG"},
    "farm-pilot": {key: value for key, value in FARM_PILOT_FLAGS.items()
                   if key != "EXPO_PUBLIC_PUBLISHED_CATALOG"},
}
# Kiosk releases (audit 19.10, findings 3.5 and 7.3). The kiosk JS bundle selects the commercial
# controller, the API origin and the photo printer origin from public build values; a forgotten
# value used to ship the TEST controller or lose printing. Every new kiosk archive pins them.
KIOSK_API_URLS = {
    "kiosk-production": "https://api.pickchick.kz",
    "kiosk-staging": "https://pickchick.185.129.51.103.nip.io",
}
KIOSK_PROFILES = tuple(KIOSK_API_URLS)
KIOSK_FLAG_KEYS = ("EXPO_PUBLIC_KIOSK_COMMERCIAL", "EXPO_PUBLIC_KIOSK_BUILD_PROFILE",
                   "EXPO_PUBLIC_KIOSK_API_URL", "EXPO_PUBLIC_KIOSK_PHOTO_URL",
                   "EXPO_PUBLIC_KIOSK_PHOTO_MAC_PREVIEW", "EXPO_PUBLIC_KIOSK_RELEASE_ID")
# Placeholder and loopback hosts never reach a restaurant iPad.
TEST_HOSTS = {"localhost", "127.0.0.1", "::1", "0.0.0.0", "example.com", "example.org",
              "example.net"}
TEST_SUFFIXES = (".example", ".test", ".invalid", ".localhost", ".example.com", ".example.org",
                 ".example.net")


def checked_photo_url(value):
    """The photo printer origin of the restaurant: https, a real host, no path or credentials."""
    try:
        parsed = urlsplit(value or "")
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except ValueError:
        fail("--kiosk-photo-url must be the HTTPS origin of the restaurant photo printer service.")
    if (parsed.scheme != "https" or not host or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in {"", "/"}):
        fail("--kiosk-photo-url must be the HTTPS origin of the restaurant photo printer service.")
    if host in TEST_HOSTS or host.endswith(TEST_SUFFIXES) or host.startswith("127."):
        fail("--kiosk-photo-url names a test or loopback host; use the restaurant printer host.")
    return f"https://{host}" + (f":{port}" if port else "")


def kiosk_profile_flags(feature_profile, photo_url, release_id):
    """Exact public values of a kiosk archive (commercial controller, API, photo, release id)."""
    if feature_profile not in KIOSK_API_URLS:
        fail("Kiosk archives require --feature-profile kiosk-production or kiosk-staging.")
    if not re.fullmatch(r"pk-[0-9a-f]{16}", release_id or ""):
        fail("Kiosk release id is invalid.")
    return {
        "EXPO_PUBLIC_KIOSK_COMMERCIAL": "1",
        "EXPO_PUBLIC_KIOSK_BUILD_PROFILE":
            "production" if feature_profile == "kiosk-production" else "staging",
        "EXPO_PUBLIC_KIOSK_API_URL": KIOSK_API_URLS[feature_profile],
        "EXPO_PUBLIC_KIOSK_PHOTO_URL": checked_photo_url(photo_url),
        "EXPO_PUBLIC_KIOSK_PHOTO_MAC_PREVIEW": "0",
        "EXPO_PUBLIC_KIOSK_RELEASE_ID": release_id,
    }


def verify_kiosk_bundle(app, flags):
    """The archived JS bundle must carry this release's pinned values, not the shell's."""
    bundle = (app / "main.jsbundle").read_bytes()
    required = {
        "commercial kiosk checkout API": b"/v1/kiosk-checkout",
        "release id (pinned values reached the bundle)": flags["EXPO_PUBLIC_KIOSK_RELEASE_ID"].encode(),
        "photo printer origin": flags["EXPO_PUBLIC_KIOSK_PHOTO_URL"].encode(),
        "API origin": flags["EXPO_PUBLIC_KIOSK_API_URL"].encode(),
    }
    missing = [label for label, value in required.items() if value not in bundle]
    if missing:
        fail("The kiosk bundle does not contain the pinned release values: " + ", ".join(missing)
             + ". Check EXPO_NO_CLIENT_ENV_VARS and the Metro cache; nothing was uploaded.")


def select_app(name):
    """Separate bundle/profile/workspace boundaries; never accept arbitrary apps."""
    global BUNDLE, APP_DIRECTORY, APP_TARGET, INTERNAL_ONLY
    targets = {
        "mobile": ("kz.pickchick.app", "mobile", "PickChick", False),
        "kiosk": ("kz.pickchick.kiosk", "kiosk", "PickChickKiosk", True),
    }
    if name not in targets:
        fail("Only the mobile and kiosk PickChick apps are allowed.")
    BUNDLE, APP_DIRECTORY, APP_TARGET, INTERNAL_ONLY = targets[name]

# Only generated app-target Release/iphoneos settings change. In particular a
# global PROVISIONING_PROFILE_SPECIFIER would also apply to CocoaPods targets.
MANUAL_PROJECT_RUBY = r'''
require 'pathname'
require 'shellwords'
begin
  require 'xcodeproj'
rescue LoadError
  pod = ENV.fetch('PATH', '').split(File::PATH_SEPARATOR)
    .map { |dir| File.join(dir, 'pod') }.find { |path| File.file?(path) && File.executable?(path) }
  wrapper = pod && File.size(pod) < 65_536 ? File.read(pod) : ''
  gem_home = ENV['PICKCHICK_POD_GEM_HOME'] || wrapper[/GEM_HOME="([^"]+)"/, 1]
  abort 'CocoaPods xcodeproj gem unavailable; no global gem installation attempted.' unless gem_home && File.directory?(gem_home)
  ENV['GEM_HOME'] = gem_home
  Gem.clear_paths
  require 'xcodeproj'
end
path, team, bundle, identity, profile, keychain = ARGV
target_name = ARGV[6] || 'PickChick'
project = Xcodeproj::Project.open(path)
apps = project.targets.select { |t| t.product_type == 'com.apple.product-type.application' }
abort 'Expected only the selected PickChick application target.' unless apps.length == 1 && apps[0].name == target_name
release = apps[0].build_configurations.find { |config| config.name == 'Release' }
abort 'PickChick Release configuration is missing.' unless release
abort 'Application Bundle ID differs.' unless release.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] == bundle
release.build_settings.merge!(
  'DEVELOPMENT_TEAM[sdk=iphoneos*]' => team,
  'CODE_SIGN_STYLE[sdk=iphoneos*]' => 'Manual',
  'CODE_SIGN_IDENTITY[sdk=iphoneos*]' => identity,
  'CODE_SIGNING_ALLOWED[sdk=iphoneos*]' => 'YES',
  'CODE_SIGNING_REQUIRED[sdk=iphoneos*]' => 'YES',
  'PROVISIONING_PROFILE[sdk=iphoneos*]' => '',
  'PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]' => profile,
  'OTHER_CODE_SIGN_FLAGS[sdk=iphoneos*]' => "$(inherited) --keychain #{Shellwords.escape(keychain)}"
)
project.save
'''


def event(message, **data):
    print(json.dumps({"message": message, **data}, ensure_ascii=False), flush=True)


def fail(message):
    raise RuntimeError(message)


def local_command(args):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
    if result.returncode:
        fail(f"Local check failed: {args[0]}. No authentication data printed.")
    return result.stdout


def private_file(value, label):
    path = Path(value).expanduser()
    if path.is_symlink() or not path.is_file():
        fail(f"{label} must be an existing private regular file, not a symlink.")
    stat = path.stat()
    if stat.st_uid != os.getuid() or stat.st_mode & 0o077:
        fail(f"{label} must belong to the current user and have mode 0600.")
    return path.resolve()


def profile_identity(profile, identity, now=None):
    """Validate decoded App Store profile data without logging its contents."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    expires = profile.get("ExpirationDate")
    if isinstance(expires, datetime.datetime) and expires.tzinfo is None:
        expires = expires.replace(tzinfo=datetime.timezone.utc)
    entitlements = profile.get("Entitlements", {})
    if (profile.get("TeamIdentifier") != [TEAM]
            or entitlements.get("com.apple.developer.team-identifier") != TEAM
            or entitlements.get("application-identifier") != f"{TEAM}.{BUNDLE}"):
        fail("Provisioning profile must belong only to the selected PickChick Bundle ID and Team.")
    if (entitlements.get("get-task-allow") is not False
            or "ProvisionedDevices" in profile or profile.get("ProvisionsAllDevices")
            or "iOS" not in profile.get("Platform", [])):
        fail("An App Store iOS distribution profile without registered devices is required.")
    if not isinstance(expires, datetime.datetime) or expires <= now:
        fail("Provisioning profile is expired or has no valid expiry.")
    uuid = profile.get("UUID", "")
    if not re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", uuid):
        fail("Provisioning profile UUID is invalid.")
    certificates = profile.get("DeveloperCertificates", [])
    if not any(isinstance(cert, bytes) and hashlib.sha1(cert).hexdigest().upper() == identity
               for cert in certificates):
        fail("Provisioning profile does not include the requested distribution certificate.")
    return {"style": "manual", "identity": identity, "profileUuid": uuid,
            "profileName": profile.get("Name", ""), "profileExpiresAt": expires.isoformat()}


def manual_signing(args):
    values = [args.provisioning_profile, args.signing_identity, args.keychain]
    if not any(values):
        if args.keychain_password_file:
            fail("A keychain password file requires all manual signing arguments.")
        return None
    if not all(values) or not re.fullmatch(r"[0-9A-Fa-f]{40}", args.signing_identity or ""):
        fail("Manual signing requires --provisioning-profile, --signing-identity SHA1 and --keychain.")
    profile = private_file(args.provisioning_profile, "Provisioning profile")
    keychain = private_file(args.keychain, "Dedicated keychain")
    # Never import into, unlock or add access to the user's login/system keychain.
    if keychain.name in {"login.keychain", "login.keychain-db", "System.keychain"}:
        fail("Use a dedicated PickChick signing keychain, never the login or system keychain.")
    identity = args.signing_identity.upper()
    decoded = plistlib.loads(local_command(["security", "cms", "-D", "-i", str(profile)]).encode())
    signing = profile_identity(decoded, identity)
    signing.update(profileSha256=hashlib.sha256(profile.read_bytes()).hexdigest(),
                   profilePath=profile, keychain=keychain)
    if args.keychain_password_file:
        signing["passwordPath"] = private_file(args.keychain_password_file, "Dedicated keychain password")
    identities = local_command(["security", "find-identity", "-v", "-p", "codesigning", str(keychain)])
    if not re.search(rf"\b{identity}\b", identities):
        fail("The requested valid distribution identity is absent from the dedicated keychain.")
    return signing


def public_signing(signing):
    return {key: value for key, value in signing.items()
            if key not in {"profilePath", "keychain", "passwordPath"}} if signing else {"style": "automatic"}


def artifact_root(value):
    root = Path(value).expanduser().resolve()
    home = Path.home()
    forbidden = [ROOT.resolve(), home / "Documents", home / "Desktop",
                 home / "Library/Mobile Documents", home / "Library/CloudStorage"]
    if any(root.is_relative_to(path.resolve()) for path in forbidden):
        fail("Keep DerivedData and release artifacts outside the repository and iCloud folders; use ~/Library/Caches/PickChick/releases.")
    return root


@contextmanager
def temporary_search_list(signing, output):
    if not signing:
        yield
        return
    keychain = str(signing["keychain"])
    before_raw = local_command(["security", "list-keychains", "-d", "user"])
    default = local_command(["security", "default-keychain", "-d", "user"])
    before = shlex.split(before_raw)
    expected = before if keychain in before else [*before, keychain]
    write_private_json(output / "keychain-search-list.before.json", {"searchList": before, "default": default})
    if signing.get("passwordPath"):
        password = signing["passwordPath"].read_text().rstrip("\n")
        # This dedicated keychain is provisioned with a random 256-bit hex
        # password. Send it only through stdin; never command arguments or logs.
        if not re.fullmatch(r"[0-9a-fA-F]{64}", password):
            fail("Dedicated keychain password must be the private 256-bit hex value created during preparation.")
        result = subprocess.run(["security", "-i"],
                                input=f"unlock-keychain -p {password} {shlex.quote(keychain)}\n",
                                capture_output=True, text=True, timeout=20)
        if result.returncode:
            fail("Unable to unlock only the dedicated signing keychain; sensitive command output withheld.")
    try:
        if expected != before:
            local_command(["security", "list-keychains", "-d", "user", "-s", *expected])
        yield
    finally:
        current = shlex.split(local_command(["security", "list-keychains", "-d", "user"]))
        current_default = local_command(["security", "default-keychain", "-d", "user"])
        if current != expected or current_default != default:
            fail("Keychain settings changed concurrently; refusing to overwrite them. Review the private pre-run snapshot.")
        if expected != before:
            local_command(["security", "list-keychains", "-d", "user", "-s", *before])
        if (shlex.split(local_command(["security", "list-keychains", "-d", "user"])) != before
                or local_command(["security", "default-keychain", "-d", "user"]) != default):
            fail("Original keychain settings could not be verified after restoration.")


@contextmanager
def installed_profile(signing):
    if not signing:
        yield
        return
    directory = Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = directory / f"{signing['profileUuid']}.mobileprovision"
    contents = signing["profilePath"].read_bytes()
    existed = target.exists()
    if existed and target.read_bytes() != contents:
        fail("A different installed profile already uses this UUID; no profile overwritten.")
    if not existed:
        with target.open("xb") as handle:
            os.chmod(target, 0o600)
            handle.write(contents)
    try:
        yield
    finally:
        if not existed:
            if target.read_bytes() != contents:
                fail("Installed profile changed concurrently; refusing to remove it.")
            target.unlink()


@contextmanager
def app_signing_override(args, signing, output):
    if not signing:
        yield
        return
    # workspace_args enforces the generated PickChick native directory.
    workspace_args(args, signing)
    project = Path(args.workspace).expanduser().resolve().parent / f"{APP_TARGET}.xcodeproj"
    file = project / "project.pbxproj"
    before = file.read_bytes()
    backup = output / "native-project.before.pbxproj"
    with backup.open("xb") as handle:
        os.chmod(backup, 0o600)
        handle.write(before)
    changed = None
    try:
        local_command(["ruby", "-e", MANUAL_PROJECT_RUBY, str(project), TEAM, BUNDLE,
                       signing["identity"], signing["profileUuid"], str(signing["keychain"]), APP_TARGET])
        changed = file.read_bytes()
        yield
    finally:
        if changed is None:
            # A Ruby validation failure occurs before save. Do not overwrite an
            # unexpected partial write or another developer's concurrent edit.
            if file.read_bytes() != before:
                fail("Native signing setup changed unexpectedly; original project saved in the private release directory.")
        else:
            if file.read_bytes() != changed:
                fail("Native project changed concurrently; refusing to overwrite edits. Restore from the private backup after review.")
            file.write_bytes(before)


@contextmanager
def release_lock():
    lock = ROOT / ".local/mobile-ios/release.lock"
    lock.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        fail("Another release phase is active, or its lock remains after interruption. Review it before retrying.")
    try:
        os.write(descriptor, f"{os.getpid()}\n".encode())
        os.close(descriptor)
        yield
    finally:
        lock.unlink()


def checked_api_url(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment
            or parsed.hostname in {"localhost", "127.0.0.1", "::1"}):
        fail("Provide the public HTTPS staging URL without credentials, query or fragment.")
    return value.rstrip("/")


def archive_app(archive):
    info_path = archive / "Info.plist"
    if not info_path.is_file():
        fail("Archive Info.plist does not exist. Run the archive phase first.")
    info = plistlib.loads(info_path.read_bytes())
    properties = info.get("ApplicationProperties", {})
    app_path = properties.get("ApplicationPath", "")
    if not app_path:
        fail("Archive does not contain an iOS app.")
    product_root = (archive / "Products").resolve()
    app = (product_root / app_path).resolve()
    if not app.is_relative_to(product_root) or app.suffix != ".app":
        fail("Archive app path is invalid.")
    app_info = plistlib.loads((app / "Info.plist").read_bytes())
    if app_info.get("CFBundleIdentifier") != BUNDLE:
        fail("Refusing to export or upload an archive for a different Bundle ID.")
    if properties.get("Team") != TEAM:
        fail("Refusing to export or upload an archive for a different Apple Team.")
    if APP_DIRECTORY == "kiosk" and app_info.get("UIDeviceFamily") != [2]:
        fail("The kiosk archive must support only iPad.")
    if not (app / "main.jsbundle").is_file():
        fail("The Release archive has no embedded main.jsbundle; Metro is not a release dependency.")
    return app, app_info


def workspace_args(args, signing=None):
    workspace = Path(args.workspace).expanduser().resolve()
    if not workspace.is_dir() or workspace.suffix != ".xcworkspace":
        fail(f"Generate apps/{APP_DIRECTORY}/ios and install CocoaPods before running this phase.")
    if not workspace.is_relative_to((ROOT / f"apps/{APP_DIRECTORY}/ios").resolve()):
        fail(f"Only the selected native workspace under apps/{APP_DIRECTORY}/ios is allowed.")
    if args.scheme != APP_TARGET:
        fail("The scheme must match the selected PickChick application.")
    result = ["-workspace", str(workspace), "-scheme", args.scheme,
              "-configuration", "Release", "-destination", "generic/platform=iOS",
              f"DEVELOPMENT_TEAM={TEAM}"]
    # For manual signing the app target owns the profile and identity. Passing
    # signing overrides here would also change Pods and extension targets.
    return result if signing else [*result, "CODE_SIGN_STYLE=Automatic"]


def validate_build_settings(args, signing=None):
    raw = local_command(["xcodebuild", *workspace_args(args, signing), "-showBuildSettings", "-json"])
    settings = json.loads(raw)
    apps = [row.get("buildSettings", {}) for row in settings
            if row.get("buildSettings", {}).get("WRAPPER_EXTENSION") == "app"]
    if len(apps) != 1 or apps[0].get("PRODUCT_BUNDLE_IDENTIFIER") != BUNDLE:
        fail("The selected scheme must resolve to exactly the PickChick iOS application.")
    if apps[0].get("DEVELOPMENT_TEAM") != TEAM:
        fail("Resolved DEVELOPMENT_TEAM differs from the explicitly selected Apple Team.")
    if APP_DIRECTORY == "kiosk" and str(apps[0].get("TARGETED_DEVICE_FAMILY")) != "2":
        fail("The kiosk scheme must target iPad only.")
    if signing and (apps[0].get("CODE_SIGN_STYLE") != "Manual"
                    or apps[0].get("CODE_SIGN_IDENTITY") != signing["identity"]
                    or apps[0].get("PROVISIONING_PROFILE_SPECIFIER") != signing["profileUuid"]):
        fail("Resolved app signing settings do not match the explicit distribution identity and profile.")
    if signing and any(row.get("buildSettings", {}).get("PROVISIONING_PROFILE_SPECIFIER")
                       for row in settings if row.get("buildSettings", {}).get("WRAPPER_EXTENSION") != "app"):
        fail("A provisioning profile leaked to a non-application target; no archive started.")
    return apps[0]


def write_private_json(path, data):
    with path.open("w", encoding="utf-8") as handle:
        os.chmod(path, 0o600)
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def canonical_profile(feature_profile):
    return PROFILE_ALIASES.get(feature_profile, feature_profile)


def default_feature_profile(app):
    """Mobile archives read the published catalog by default; the kiosk keeps its own build."""
    return DEFAULT_MOBILE_PROFILE if app == "mobile" else "legacy"


def feature_profile_flags(feature_profile):
    """Return an independent allowlisted flag snapshot for release metadata."""
    profiles = {"customer-pilot": CUSTOMER_PILOT_FLAGS, "farm-pilot": FARM_PILOT_FLAGS,
                "published-catalog": PUBLISHED_CATALOG_FLAGS, DEFAULT_MOBILE_PROFILE: STOREFRONT_FLAGS,
                "production": PRODUCTION_FLAGS}
    feature_profile = canonical_profile(feature_profile)
    if feature_profile == "legacy" or feature_profile in KIOSK_PROFILES:
        return None
    if feature_profile not in profiles:
        fail("Unknown release feature profile.")
    return dict(profiles[feature_profile])


def profile_backend(feature_profile):
    """(environment, API origin) that a pinned mobile profile compiles into the JS bundle."""
    flags = feature_profile_flags(feature_profile) or {}
    environment = flags.get("EXPO_PUBLIC_PICKCHICK_ENV", "staging")
    return environment, PRODUCTION_API_URL if environment == "production" else STAGING_API_URL


def archive_environment(feature_profile, source=None, kiosk_flags=None):
    """Pin the JS bundle switches independently of the invoking shell and dotenv."""
    flags = kiosk_flags if feature_profile in KIOSK_PROFILES else feature_profile_flags(feature_profile)
    if feature_profile in KIOSK_PROFILES and (
            not kiosk_flags or tuple(sorted(kiosk_flags)) != tuple(sorted(KIOSK_FLAG_KEYS))):
        fail("Kiosk archives require their exact pinned public values.")
    if flags is None:
        return None
    source = os.environ if source is None else source
    if "EXPO_NO_CLIENT_ENV_VARS" in source:
        fail("EXPO_NO_CLIENT_ENV_VARS prevents the pilot flags from reaching the JS bundle.")
    env = dict(source)
    # The backend is part of the profile: no shell override of the API host reaches an archive.
    env.pop("EXPO_PUBLIC_API_URL", None)
    # Owner 29.10.2026 (App Review 2.1): the disabled Apple Pay / card list returns only when a
    # profile pins EXPO_PUBLIC_UPCOMING_PAYMENTS, never from a shell left over from local testing.
    env.pop("EXPO_PUBLIC_UPCOMING_PAYMENTS", None)
    if feature_profile not in KIOSK_PROFILES:
        # Mobile switch only; a kiosk bundle reads its pinned EXPO_PUBLIC_KIOSK_* values.
        env["EXPO_PUBLIC_PICKCHICK_ENV"] = profile_backend(feature_profile)[0]
    env.update(flags)
    env["PICKCHICK_APP_VARIANT"] = "release"
    env["EXPO_NO_DOTENV"] = "1"
    return env


def legacy_backend_guard(app, source=None):
    """A legacy mobile archive inherits the shell, and its metadata records the staging host.

    Refuse a shell that would compile another backend into that bundle (review of audit 2.2).
    """
    source = os.environ if source is None else source
    if app == "mobile" and (source.get("EXPO_PUBLIC_API_URL")
                            or source.get("EXPO_PUBLIC_PICKCHICK_ENV", "") not in ("", "staging")):
        fail("The legacy profile archives the staging backend only. Unset EXPO_PUBLIC_API_URL and "
             "EXPO_PUBLIC_PICKCHICK_ENV, or choose a pinned profile such as production.")


def verify_feature_profile(metadata, requested):
    archived = metadata.get("featureProfile", "legacy")
    if canonical_profile(archived) != canonical_profile(requested):
        fail("The requested feature profile differs from the archived release.")
    if archived in KIOSK_PROFILES:
        embedded = metadata.get("embeddedPublicEnv") or {}
        expected = kiosk_profile_flags(archived, embedded.get("EXPO_PUBLIC_KIOSK_PHOTO_URL"),
                                       embedded.get("EXPO_PUBLIC_KIOSK_RELEASE_ID"))
        if embedded != expected or metadata.get("kioskBundleVerified") is not True:
            fail(f"The archived {archived} kiosk values are missing, differ or were not verified.")
        return
    flags = feature_profile_flags(archived)
    historical = HISTORICAL_PROFILE_FLAGS.get(canonical_profile(archived))
    embedded = metadata.get("embeddedPublicEnv")
    if flags is not None and embedded != flags and embedded != historical:
        fail(f"The archived {archived} feature flags are missing or do not match.")


def run_xcode(command, log, env=None):
    event("Xcode phase started", log=str(log))
    with log.open("w", encoding="utf-8") as handle:
        os.chmod(log, 0o600)
        result = subprocess.run(command, cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT,
                                env=env)
    if result.returncode:
        fail(f"Xcode exited with {result.returncode}. Review the private local log: {log}")


def export_options(destination, signing=None):
    options = {
        "method": "app-store-connect",
        "destination": destination,
        "signingStyle": "automatic",
        "teamID": TEAM,
        "manageAppVersionAndBuildNumber": False,
        "uploadSymbols": True,
    }
    if signing:
        options.update(signingStyle="manual", signingCertificate=signing["identity"],
                       provisioningProfiles={BUNDLE: signing["profileUuid"]})
    if INTERNAL_ONLY:
        options["testFlightInternalTestingOnly"] = True
    return options


def archive_command(args, signing, archive, derived):
    return ["xcodebuild", *workspace_args(args, signing),
            *([] if signing else ["-allowProvisioningUpdates"]),
            "-derivedDataPath", str(derived), "-archivePath", str(archive), "archive"]


def export_command(signing, archive, output, plist):
    return ["xcodebuild", "-exportArchive", "-archivePath", str(archive),
            "-exportPath", str(output), "-exportOptionsPlist", str(plist),
            *([] if signing else ["-allowProvisioningUpdates"])]


def verify_archived_profile(app, signing):
    if signing:
        embedded = app / "embedded.mobileprovision"
        if not embedded.is_file():
            fail("The signed app has no embedded distribution profile.")
        decoded = plistlib.loads(local_command(["security", "cms", "-D", "-i", str(embedded)]).encode())
        verified = profile_identity(decoded, signing["identity"])
        if verified["profileUuid"] != signing["profileUuid"]:
            fail("The archive uses a different provisioning profile than this release.")
        local_command(["codesign", "--verify", "--deep", "--strict", str(app)])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["doctor", "archive", "export", "upload"])
    parser.add_argument("--app", choices=["mobile", "kiosk"], default="mobile")
    parser.add_argument("--feature-profile", choices=["legacy", *MOBILE_PROFILES, *KIOSK_PROFILES],
                        default=None,
                        help="JS feature set; mobile defaults to storefront (catalog-pilot is an "
                             "alias). A new kiosk archive needs kiosk-production or kiosk-staging; "
                             "kiosk export/upload default to the archived profile")
    parser.add_argument("--kiosk-photo-url",
                        help="HTTPS origin of the restaurant photo printer service (kiosk archive)")
    parser.add_argument("--workspace")
    parser.add_argument("--scheme")
    parser.add_argument("--release", default="first-testflight")
    parser.add_argument("--asc-app-id", help="Verified numeric PickChick App Store Connect ID")
    parser.add_argument("--artifacts-root", default=str(DEFAULT_ARTIFACTS_ROOT),
                        help="Private releases and DerivedData directory outside iCloud/repository")
    parser.add_argument("--provisioning-profile", help="Private App Store mobileprovision for only PickChick")
    parser.add_argument("--signing-identity", help="Existing Apple Distribution certificate SHA1")
    parser.add_argument("--keychain", help="Dedicated private signing keychain, never the login keychain")
    parser.add_argument("--keychain-password-file", help="Optional private hex password file to unlock only the dedicated keychain")
    args = parser.parse_args()
    select_app(args.app)
    if args.feature_profile is None and args.app == "kiosk" and args.phase == "archive":
        fail("Kiosk archives require --feature-profile kiosk-production or kiosk-staging "
             "and --kiosk-photo-url; the legacy shell environment is no longer accepted.")
    if args.feature_profile is None and args.app != "kiosk":
        args.feature_profile = default_feature_profile(args.app)
    if args.feature_profile in MOBILE_PROFILES and args.app != "mobile":
        fail("Pilot feature profiles are available only for the mobile app.")
    if args.feature_profile in KIOSK_PROFILES and args.app != "kiosk":
        fail("Kiosk feature profiles are available only for the kiosk app.")
    if args.app == "kiosk" and args.phase == "archive" and args.feature_profile not in KIOSK_PROFILES:
        fail("New kiosk archives require --feature-profile kiosk-production or kiosk-staging.")
    if args.kiosk_photo_url and not (args.app == "kiosk" and args.phase == "archive"):
        fail("--kiosk-photo-url applies only to a kiosk archive.")
    args.workspace = args.workspace or str(ROOT / f"apps/{APP_DIRECTORY}/ios/{APP_TARGET}.xcworkspace")
    args.scheme = args.scheme or APP_TARGET
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", args.release):
        fail("Use a short release label containing only letters, numbers, dot, dash or underscore.")
    signing = manual_signing(args)
    artifacts = artifact_root(args.artifacts_root)

    if args.phase == "doctor":
        event("Local Apple build environment", xcode=local_command(["xcodebuild", "-version"]).strip(),
              selected_team=TEAM, bundle_identifier=BUNDLE,
              native_workspace_exists=Path(args.workspace).is_dir(),
              archive_tool_available=True)
        local_command(["xcodebuild", "-checkFirstLaunchStatus"])
        if Path(args.workspace).is_dir():
            validate_build_settings(args)
            event("Resolved native scheme identity verified", scheme=args.scheme)
        event("Doctor does not authenticate to Apple or prove App Store Connect access")
        if signing:
            event("Existing manual distribution inputs verified", **public_signing(signing),
                  artifacts_root=str(artifacts), settings_changed=False)
        return

    os.umask(0o077)
    with release_lock():
        perform_phase(args, signing, artifacts)


def perform_phase(args, signing, artifacts):
    output = artifacts / args.release
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    archive = output / f"{APP_TARGET}.xcarchive"
    metadata_path = output / "release.json"

    if args.phase == "archive":
        kiosk_flags = (kiosk_profile_flags(args.feature_profile, args.kiosk_photo_url,
                                           "pk-" + secrets.token_hex(8))
                       if APP_DIRECTORY == "kiosk" else None)
        bundle_env = archive_environment(args.feature_profile, kiosk_flags=kiosk_flags)
        if bundle_env is None:
            legacy_backend_guard(APP_DIRECTORY)
        config = json.loads((ROOT / f"apps/{APP_DIRECTORY}/app.json").read_text())["expo"]
        if (config.get("ios", {}).get("bundleIdentifier") != BUNDLE
                or config.get("ios", {}).get("appleTeamId") != TEAM):
            fail("Expo app config must explicitly select the PickChick Bundle ID and Apple Team.")
        extra = config.get("extra", {})
        if APP_DIRECTORY == "kiosk" and (
                config.get("ios", {}).get("isTabletOnly") is not True
                or extra.get("distribution") != "internal-testflight"):
            fail("Kiosk releases require iPad-only and internal TestFlight configuration.")
        if extra.get("environment") != "staging" or extra.get("customerOperationsEnabled") is not False:
            fail("This first TestFlight release requires staging and disabled customer operations.")
        if kiosk_flags:
            # Kiosk archives pin their own API origin (EXPO_PUBLIC_KIOSK_API_URL, audit 3.5/7.3).
            environment = kiosk_flags["EXPO_PUBLIC_KIOSK_BUILD_PROFILE"]
            api_url = kiosk_flags["EXPO_PUBLIC_KIOSK_API_URL"]
        elif APP_DIRECTORY == "mobile" and bundle_env is not None:
            # app.json keeps the staging defaults; the pinned profile selects the bundle's backend.
            environment, api_url = profile_backend(args.feature_profile)
            api_url = checked_api_url(api_url)
        else:
            environment, api_url = "staging", checked_api_url(extra.get("apiUrl", ""))
        if archive.exists() or metadata_path.exists():
            fail("Release artifacts already exist. Use a new --release label; no archive is overwritten.")
        with ExitStack() as stack:
            stack.enter_context(temporary_search_list(signing, output))
            stack.enter_context(installed_profile(signing))
            stack.enter_context(app_signing_override(args, signing, output))
            settings = validate_build_settings(args, signing)
            version = settings.get("MARKETING_VERSION")
            build = settings.get("CURRENT_PROJECT_VERSION")
            if not build:
                fail("CURRENT_PROJECT_VERSION is missing. Assign the PickChick build number first.")
            metadata = {"createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        "team": TEAM, "bundleIdentifier": BUNDLE, "apiUrl": api_url,
                        "environment": environment,
                        "supportUrl": (bundle_env or {}).get("EXPO_PUBLIC_SUPPORT_URL") or None,
                        "app": APP_DIRECTORY, "testFlightInternalTestingOnly": INTERNAL_ONLY,
                        "version": version, "build": build,
                        "featureProfile": canonical_profile(args.feature_profile),
                        "embeddedPublicEnv": (kiosk_flags or feature_profile_flags(args.feature_profile)
                                              or {}),
                        "gitSha": local_command(["git", "rev-parse", "HEAD"]).strip(),
                        "dirty": bool(local_command(["git", "status", "--porcelain"]).strip()),
                        "archiveStatus": "started", "signing": public_signing(signing)}
            write_private_json(metadata_path, metadata)
            run_xcode(archive_command(args, signing, archive, output / "DerivedData"),
                      output / "archive.log", env=bundle_env)
            app, app_info = archive_app(archive)
            verify_archived_profile(app, signing)
            if kiosk_flags:
                verify_kiosk_bundle(app, kiosk_flags)
        metadata.update(archiveStatus="complete", version=app_info.get("CFBundleShortVersionString"),
                        build=app_info.get("CFBundleVersion"))
        if kiosk_flags:
            metadata["kioskBundleVerified"] = True
        if signing:
            metadata["temporarySigningSettingsRestored"] = True
        write_private_json(metadata_path, metadata)
        event("PickChick archive verified", archive=str(archive), version=metadata["version"],
              build=metadata["build"], upload_performed=False)
        return

    app, _ = archive_app(archive)
    if not metadata_path.is_file():
        fail("Release metadata is missing; only archives produced by this script can be delivered.")
    metadata = json.loads(metadata_path.read_text())
    if (metadata.get("archiveStatus") != "complete" or metadata.get("team") != TEAM
            or metadata.get("bundleIdentifier") != BUNDLE):
        fail("Release metadata does not match a completed PickChick archive.")
    if args.feature_profile is None:
        # Kiosk export/upload: the archived profile (verified below), legacy for older archives.
        args.feature_profile = metadata.get("featureProfile", "legacy")
    verify_feature_profile(metadata, args.feature_profile)
    if metadata.get("featureProfile") in KIOSK_PROFILES:
        verify_kiosk_bundle(app, metadata["embeddedPublicEnv"])
    if metadata.get("signing", {"style": "automatic"}) != public_signing(signing):
        fail("Use the same immutable signing profile and certificate that created this release.")
    verify_archived_profile(app, signing)
    if args.phase == "upload":
        if not args.asc_app_id or not re.fullmatch(r"[0-9]+", args.asc_app_id):
            fail("Upload requires --asc-app-id from the verified separate PickChick app record.")
        if metadata.get("deliveryStatus") == "submitted":
            fail("This release was already submitted. Verify processing in App Store Connect.")
    destination = "export" if args.phase == "export" else "upload"
    plist = output / f"ExportOptions-{destination}.plist"
    plist.write_bytes(plistlib.dumps(export_options(destination, signing)))
    with temporary_search_list(signing, output), installed_profile(signing):
        run_xcode(export_command(signing, archive, output / destination, plist), output / f"{destination}.log")
    if signing:
        metadata["temporarySigningSettingsRestored"] = True
    if args.phase == "export":
        metadata["exportStatus"] = "complete"
        event("PickChick export completed", output=str(output / destination), upload_performed=False)
    else:
        metadata.update(deliveryStatus="submitted", ascAppId=args.asc_app_id)
        event("Apple upload command completed", asc_app_id=args.asc_app_id,
              testflight_processing="must be verified in App Store Connect")
    write_private_json(metadata_path, metadata)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, OSError, plistlib.InvalidFileException) as error:
        event("Stopped", reason=str(error))
        sys.exit(1)
