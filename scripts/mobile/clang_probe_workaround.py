#!/usr/bin/env python3
"""Prepare an opt-in local launcher for swiftlang/swift-build#1315."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


LAUNCHER = '''#!{python}
import os
import signal
import subprocess
import sys

real = {clangxx} if os.path.basename(sys.argv[0]) == 'clang++' else {clang}
args = sys.argv[1:]
if not all(arg in args for arg in ('-v', '-E', '-dM', '-c', '/dev/null')):
    os.execv(real, [real, *args])

# Run the real feature probe and preserve both complete byte streams and status.
child = subprocess.Popen([real, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
def forward(signum, frame):
    try:
        child.send_signal(signum)
    except ProcessLookupError:
        pass
for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(sig, forward)
stdout, stderr = child.communicate()
def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]
try:
    write_all(1, stdout)
    os.close(1)  # SwiftBuild's sequential reader must see stdout EOF first.
    write_all(2, stderr)
except BrokenPipeError:
    pass
if child.returncode < 0:
    sig = -child.returncode
    if sig not in (signal.SIGKILL, signal.SIGSTOP):
        signal.signal(sig, signal.SIG_DFL)
    os.kill(os.getpid(), sig)
sys.exit(child.returncode)
'''

# Expo's nested build clears the environment with env -i but deliberately keeps
# PATH. Keep this opt-in shim separate from the Clang toolchain facade so merely
# preparing ordinary Clang wrappers never intercepts xcodebuild.
XCODEBUILD_LAUNCHER = '''#!{python}
import os
import sys

real = {xcodebuild}
args = sys.argv[1:]
scheme = args.index('-scheme') if args.count('-scheme') == 1 else -1
# Match the observed Expo invocation conservatively. Other actions, schemes,
# metadata queries and option-first forms are deliberately passed through.
excluded = {{
    'archive', 'clean', 'test', 'test-without-building', 'build-for-testing',
    'analyze', 'install', 'installhdrs', 'installsrc', 'docbuild',
    '-list', '-showBuildSettings', '-showdestinations', '-showBuildTimingSummary',
    '-version', '-help', '-create-xcframework', '-exportArchive',
    '-resolvePackageDependencies',
}}
selected = (
    args[:1] == ['build']
    and scheme >= 0
    and scheme + 1 < len(args)
    and args[scheme + 1] == 'ExpoModulesJSI'
    and not any(arg in excluded for arg in args)
)
if selected:
    # Override only these two build settings. Preserve every other argument and
    # the inherited environment, stdio, working directory and exit semantics.
    args = [arg for arg in args if not arg.startswith(('CC=', 'CXX='))]
    args.extend([{cc}, {cxx}])
os.execv(real, [real, *args])
'''


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def prepare_launcher(destination, clang, clangxx, xcodebuild=None):
    destination = Path(destination).absolute()
    clang, clangxx = Path(clang).absolute(), Path(clangxx).absolute()
    if not all(path.is_file() and os.access(path, os.X_OK) for path in (clang, clangxx)):
        raise ValueError('Both selected Clang executables must exist and be executable')
    real_usr = clang.parent.parent
    if clangxx.parent.parent != real_usr:
        raise ValueError('Clang and Clang++ must belong to the same selected toolchain')
    features = real_usr / 'share/clang/features.json'
    if not features.is_file():
        raise ValueError('Selected toolchain has no share/clang/features.json')
    if xcodebuild is not None:
        xcodebuild = Path(xcodebuild).absolute()
        if not xcodebuild.is_file() or not os.access(xcodebuild, os.X_OK):
            raise ValueError('Selected xcodebuild must exist and be executable')
    # Never reuse a path which SwiftBuild may have cached with different metadata.
    destination.mkdir(parents=True, exist_ok=False)
    local_usr = destination / 'usr'
    local_bin = local_usr / 'bin'
    local_bin.mkdir(parents=True)
    for entry in real_usr.iterdir():
        if entry.name != 'bin':
            (local_usr / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())
    for entry in clang.parent.iterdir():
        if entry.name not in ('clang', 'clang++'):
            (local_bin / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())
    launcher = local_bin / 'clang'
    launcher.write_text(LAUNCHER.format(python=sys.executable, clang=repr(str(clang)),
                                      clangxx=repr(str(clangxx))))
    launcher.chmod(0o700)
    (local_bin / 'clang++').symlink_to('clang')
    metadata = {
        'upstream_issue': 'https://github.com/swiftlang/swift-build/pull/1315',
        'cc': str(launcher),
        'cxx': str(local_bin / 'clang++'),
        'launcher_sha256': sha256(launcher),
        'real_clang': str(clang),
        'real_clang_sha256': sha256(clang),
        'real_clangxx': str(clangxx),
        'real_clangxx_sha256': sha256(clangxx),
        'features': str(features),
        'features_sha256': sha256(features),
        'real_clang_version': subprocess.run([str(clang), '--version'], check=True,
                                             capture_output=True, text=True).stdout,
    }
    if xcodebuild is not None:
        path_prefix = destination / 'path-bin'
        path_prefix.mkdir()
        build_launcher = path_prefix / 'xcodebuild'
        build_launcher.write_text(XCODEBUILD_LAUNCHER.format(
            python=sys.executable, xcodebuild=repr(str(xcodebuild)),
            cc=repr('CC=' + metadata['cc']), cxx=repr('CXX=' + metadata['cxx'])))
        build_launcher.chmod(0o700)
        metadata.update({
            'path_prefix': str(path_prefix),
            'xcodebuild_launcher': str(build_launcher),
            'xcodebuild_launcher_sha256': sha256(build_launcher),
            'real_xcodebuild': str(xcodebuild),
            'real_xcodebuild_sha256': sha256(xcodebuild),
            'xcodebuild_scope': 'first action build; exactly one -scheme ExpoModulesJSI; '
                               'no other actions or metadata queries',
            'xcodebuild_overrides': {'CC': metadata['cc'], 'CXX': metadata['cxx']},
        })
    (destination / 'provenance.json').write_text(json.dumps(metadata, indent=2) + '\n')
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', required=True, type=Path,
                        help='A new local directory; existing paths are never replaced')
    parser.add_argument('--expo-jsi-xcodebuild', action='store_true',
                        help='Also prepare an opt-in PATH launcher for the nested '
                             'ExpoModulesJSI build that clears XCODE_XCCONFIG_FILE')
    args = parser.parse_args()
    # xcrun respects a one-shot DEVELOPER_DIR; no global Xcode preference is changed.
    def selected_tool(name):
        return subprocess.run(['/usr/bin/xcrun', '--find', name], check=True,
                              capture_output=True, text=True).stdout.strip()
    try:
        result = prepare_launcher(args.destination, selected_tool('clang'), selected_tool('clang++'),
                                  selected_tool('xcodebuild') if args.expo_jsi_xcodebuild else None)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Cannot prepare Clang probe workaround: {error}\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
