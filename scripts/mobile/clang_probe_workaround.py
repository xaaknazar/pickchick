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


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def prepare_launcher(destination, clang, clangxx):
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
    (destination / 'provenance.json').write_text(json.dumps(metadata, indent=2) + '\n')
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', required=True, type=Path,
                        help='A new local directory; existing paths are never replaced')
    args = parser.parse_args()
    # xcrun respects a one-shot DEVELOPER_DIR; no global Xcode preference is changed.
    def selected_tool(name):
        return subprocess.run(['/usr/bin/xcrun', '--find', name], check=True,
                              capture_output=True, text=True).stdout.strip()
    try:
        result = prepare_launcher(args.destination, selected_tool('clang'), selected_tool('clang++'))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Cannot prepare Clang probe workaround: {error}\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
