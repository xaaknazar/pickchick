#!/usr/bin/env python3
"""Build and deliver only kz.pickchick.app with the selected local Xcode account."""

import argparse
import datetime
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[2]
TEAM = "DAJTP6MC3Q"
BUNDLE = "kz.pickchick.app"


def event(message, **data):
    print(json.dumps({"message": message, **data}, ensure_ascii=False), flush=True)


def fail(message):
    raise RuntimeError(message)


def local_command(args):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
    if result.returncode:
        fail(f"Local check failed: {args[0]}. No authentication data printed.")
    return result.stdout


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
    if not (app / "main.jsbundle").is_file():
        fail("The Release archive has no embedded main.jsbundle; Metro is not a release dependency.")
    return app, app_info


def workspace_args(args):
    workspace = Path(args.workspace).expanduser().resolve()
    if not workspace.is_dir() or workspace.suffix != ".xcworkspace":
        fail("Generate apps/mobile/ios and install CocoaPods before running this phase.")
    if not workspace.is_relative_to((ROOT / "apps/mobile/ios").resolve()):
        fail("Only the PickChick native workspace under apps/mobile/ios is allowed.")
    return ["-workspace", str(workspace), "-scheme", args.scheme,
            "-configuration", "Release", "-destination", "generic/platform=iOS",
            f"DEVELOPMENT_TEAM={TEAM}", "CODE_SIGN_STYLE=Automatic"]


def validate_build_settings(args):
    raw = local_command(["xcodebuild", *workspace_args(args), "-showBuildSettings", "-json"])
    settings = json.loads(raw)
    apps = [row.get("buildSettings", {}) for row in settings
            if row.get("buildSettings", {}).get("WRAPPER_EXTENSION") == "app"]
    if len(apps) != 1 or apps[0].get("PRODUCT_BUNDLE_IDENTIFIER") != BUNDLE:
        fail("The selected scheme must resolve to exactly the PickChick iOS application.")
    if apps[0].get("DEVELOPMENT_TEAM") != TEAM:
        fail("Resolved DEVELOPMENT_TEAM differs from the explicitly selected Apple Team.")
    return apps[0]


def write_private_json(path, data):
    with path.open("w", encoding="utf-8") as handle:
        os.chmod(path, 0o600)
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def run_xcode(command, log):
    event("Xcode phase started", log=str(log))
    with log.open("w", encoding="utf-8") as handle:
        os.chmod(log, 0o600)
        result = subprocess.run(command, cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT)
    if result.returncode:
        fail(f"Xcode exited with {result.returncode}. Review the private local log: {log}")


def export_options(destination):
    return {
        "method": "app-store-connect",
        "destination": destination,
        "signingStyle": "automatic",
        "teamID": TEAM,
        "manageAppVersionAndBuildNumber": False,
        "uploadSymbols": True,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["doctor", "archive", "export", "upload"])
    parser.add_argument("--workspace", default=str(ROOT / "apps/mobile/ios/PickChick.xcworkspace"))
    parser.add_argument("--scheme", default="PickChick")
    parser.add_argument("--release", default="first-testflight")
    parser.add_argument("--asc-app-id", help="Verified numeric PickChick App Store Connect ID")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", args.release):
        fail("Use a short release label containing only letters, numbers, dot, dash or underscore.")

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
        return

    os.umask(0o077)
    output = ROOT / ".local/mobile-ios/releases" / args.release
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    archive = output / "PickChick.xcarchive"
    metadata_path = output / "release.json"

    if args.phase == "archive":
        config = json.loads((ROOT / "apps/mobile/app.json").read_text())["expo"]
        if (config.get("ios", {}).get("bundleIdentifier") != BUNDLE
                or config.get("ios", {}).get("appleTeamId") != TEAM):
            fail("Expo app config must explicitly select the PickChick Bundle ID and Apple Team.")
        extra = config.get("extra", {})
        if extra.get("environment") != "staging" or extra.get("customerOperationsEnabled") is not False:
            fail("This first TestFlight release requires staging and disabled customer operations.")
        api_url = checked_api_url(extra.get("apiUrl", ""))
        if archive.exists() or metadata_path.exists():
            fail("Release artifacts already exist. Use a new --release label; no archive is overwritten.")
        settings = validate_build_settings(args)
        version = settings.get("MARKETING_VERSION")
        build = settings.get("CURRENT_PROJECT_VERSION")
        if not build:
            fail("CURRENT_PROJECT_VERSION is missing. Assign the PickChick build number first.")
        metadata = {"createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "team": TEAM, "bundleIdentifier": BUNDLE, "apiUrl": api_url,
                    "version": version, "build": build,
                    "gitSha": local_command(["git", "rev-parse", "HEAD"]).strip(),
                    "dirty": bool(local_command(["git", "status", "--porcelain"]).strip()),
                    "archiveStatus": "started"}
        write_private_json(metadata_path, metadata)
        run_xcode(["xcodebuild", *workspace_args(args), "-allowProvisioningUpdates",
                   "-archivePath", str(archive), "archive"], output / "archive.log")
        _, app_info = archive_app(archive)
        metadata.update(archiveStatus="complete", version=app_info.get("CFBundleShortVersionString"),
                        build=app_info.get("CFBundleVersion"))
        write_private_json(metadata_path, metadata)
        event("PickChick archive verified", archive=str(archive), version=metadata["version"],
              build=metadata["build"], upload_performed=False)
        return

    archive_app(archive)
    if not metadata_path.is_file():
        fail("Release metadata is missing; only archives produced by this script can be delivered.")
    metadata = json.loads(metadata_path.read_text())
    if (metadata.get("archiveStatus") != "complete" or metadata.get("team") != TEAM
            or metadata.get("bundleIdentifier") != BUNDLE):
        fail("Release metadata does not match a completed PickChick archive.")
    if args.phase == "upload":
        if not args.asc_app_id or not re.fullmatch(r"[0-9]+", args.asc_app_id):
            fail("Upload requires --asc-app-id from the verified separate PickChick app record.")
        if metadata.get("deliveryStatus") == "submitted":
            fail("This release was already submitted. Verify processing in App Store Connect.")
    destination = "export" if args.phase == "export" else "upload"
    plist = output / f"ExportOptions-{destination}.plist"
    plist.write_bytes(plistlib.dumps(export_options(destination)))
    run_xcode(["xcodebuild", "-exportArchive", "-archivePath", str(archive),
               "-exportPath", str(output / destination), "-exportOptionsPlist", str(plist),
               "-allowProvisioningUpdates"], output / f"{destination}.log")
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
