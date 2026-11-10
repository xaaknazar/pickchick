#!/usr/bin/env python3
"""Package the reviewed 024->025 operator and its pinned backup helpers, without secrets.

This produces a delivery archive, not permission to apply a migration. It never executes
PowerShell, connects to a database or includes a runtime/credential/release receipt.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import zipfile


PREFIX = 'infra/windows/'
OPERATOR = 'update-runtime-queue-recovery-025.ps1'
IMPORTS = {'install-native-foundation.ps1', 'update-native-service.ps1',
           'update-native-unified-menu.ps1'}
OPERATOR_PINS = {'native-edge-backup-ledger.json', 'install-edge-backup.ps1',
                 'queue-recovery-upgrade-db.mjs'}
BACKUP_PINS = {'edge-backup-lib.mjs', 'edge-backup-restore.mjs', 'edge-backup-setup.mjs',
               'edge-backup-task.mjs', 'native-edge-backup-ledger.json'}
FILES = tuple(sorted(PREFIX + name for name in {OPERATOR} | IMPORTS | OPERATOR_PINS | BACKUP_PINS))
DOCS = ('docs/operations/stage2-windows-1030/queue-recovery-025.md',
        'infra/windows/edge-backup.md', 'docs/operations/edge-restore.md')


def git(source, *args):
    result = subprocess.run(['git', *args], cwd=source, check=False, capture_output=True)
    if result.returncode:
        raise ValueError('Git source verification failed')
    return result.stdout


def assert_source(source, expected):
    if not re.fullmatch(r'[a-f0-9]{40}', expected):
        raise ValueError('A full reviewed source SHA is required')
    if git(source, 'rev-parse', 'HEAD').decode().strip() != expected:
        raise ValueError('Source HEAD differs from expected SHA')
    if git(source, 'status', '--porcelain', '--untracked-files=normal'):
        raise ValueError('Source must be clean, including untracked files')


def blob(source, sha, path):
    entry = git(source, 'ls-tree', sha, '--', path).decode().strip()
    if not re.fullmatch(r'100(?:644|755) blob [a-f0-9]{40}\t' + re.escape(path), entry):
        raise ValueError('Missing or non-regular committed delivery file: ' + path)
    # Git objects preserve reviewed LF bytes even on a Windows CRLF checkout.
    return git(source, 'show', sha + ':' + path)


def pins(text, expected):
    matches = re.findall(r"'([^']+\.(?:ps1|mjs|json))'\s*=\s*'([a-f0-9]{64})'", text)
    if len(matches) != len(expected) or {name for name, _ in matches} != expected:
        raise ValueError('Reviewed pin list changed; update and review the bundle specification')
    return matches


def verify_pins(files):
    script = files[PREFIX + OPERATOR].decode('utf-8')
    imports = re.findall(
        r"Import-RuntimeFunctions \(Join-Path \$PSScriptRoot '([^']+)'\) '([a-f0-9]{64})'",
        script)
    if len(imports) != len(IMPORTS) or {name for name, _ in imports} != IMPORTS:
        raise ValueError('Reviewed function imports changed')
    required = imports + pins(script, OPERATOR_PINS)
    required += pins(files[PREFIX + 'install-edge-backup.ps1'].decode('utf-8'), BACKUP_PINS)
    for name, digest in required:
        if hashlib.sha256(files[PREFIX + name]).hexdigest() != digest:
            raise ValueError('Pinned helper differs from reviewed bytes: ' + name)
    # The backup modules also load their JSON ledger relative to their own directory.
    for path in FILES:
        if not path.endswith('.mjs'):
            continue
        text = files[path].decode('utf-8')
        for relative in re.findall(r"(?:from\s+|import\s+|import\(|new URL\()['\"]([.][^'\"]+)['\"]", text):
            if not relative.startswith('./') or PREFIX + relative[2:] not in files:
                raise ValueError('Unshipped relative module or data dependency: ' + path)


def bundle(source, expected, output):
    source, output = Path(source).resolve(), Path(output).absolute()
    if output.is_symlink():
        raise ValueError('Output must be a new .zip file')
    output = output.resolve()
    if output.suffix != '.zip' or output.exists():
        raise ValueError('Output must be a new .zip file')
    if output.is_relative_to(source):
        raise ValueError('Delivery output must be outside the source checkout')
    assert_source(source, expected)
    files = {path: blob(source, expected, path) for path in sorted(FILES + DOCS)}
    verify_pins(files)
    manifest = {'format': 'pickchick-queue-recovery-operator-v1', 'sourceCommit': expected,
                'entrypoint': PREFIX + OPERATOR, 'runtimeIncluded': False,
                'credentialsIncluded': False, 'deploymentReady': False,
                'files': [{'path': path, 'bytes': len(data),
                           'sha256': hashlib.sha256(data).hexdigest()}
                          for path, data in sorted(files.items())]}
    files['operator-manifest.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path, data in sorted(files.items()):
            info = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    data = buffer.getvalue()
    # Verify the archive bytes that will actually be delivered, not just the input map.
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if sorted(archive.namelist()) != sorted(files):
            raise ValueError('Archive file set differs')
        for path, original in files.items():
            if archive.read(path) != original:
                raise ValueError('Archive bytes differ')
    assert_source(source, expected)
    with output.open('xb') as stream:
        stream.write(data)
    return {'sourceCommit': expected, 'archive': str(output), 'bytes': len(data),
            'sha256': hashlib.sha256(data).hexdigest(), 'files': len(files),
            'runtimeIncluded': False, 'deploymentReady': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--expected-sha', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(bundle(args.source, args.expected_sha, args.output), indent=2))
    except (ValueError, OSError) as error:
        parser.exit(1, 'Operator bundle refused: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
