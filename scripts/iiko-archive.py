#!/usr/bin/env python3
"""Record/verify bytes of local iiko exports. Never certify accounting completeness."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile


CATEGORIES = ('sales', 'receipts', 'shifts', 'z_reports', 'stock_documents')
MANIFEST = 'archive-manifest.json'
MAX_MANIFEST = 10 * 1024 * 1024


class ArchiveError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise ArchiveError(code)


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def inventory(root):
    """Traverse only opened directories; never follow export symlinks or read devices."""
    entries = []

    def visit(directory, parts):
        before = os.fstat(directory)
        for name in sorted(os.listdir(directory)):
            if not parts and name == MANIFEST:
                continue
            if not parts:
                require(name in CATEGORIES, 'UNEXPECTED_ROOT_ENTRY')
            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
            relative = '/'.join((*parts, name))
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=directory)
                try:
                    visit(child, (*parts, name))
                finally:
                    os.close(child)
            else:
                require(parts and stat.S_ISREG(info.st_mode), 'NON_REGULAR_EXPORT')
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=directory)
                with os.fdopen(fd, 'rb') as stream:
                    opened = os.fstat(stream.fileno())
                    require(stat.S_ISREG(opened.st_mode) and fingerprint(opened) == fingerprint(info),
                            'EXPORT_CHANGED')
                    digest, size = hashlib.sha256(), 0
                    while chunk := stream.read(1024 * 1024):
                        digest.update(chunk)
                        size += len(chunk)
                        require(size <= opened.st_size, 'EXPORT_CHANGED')
                    require(fingerprint(opened) == fingerprint(os.fstat(stream.fileno()))
                            and size == opened.st_size, 'EXPORT_CHANGED')
                require(size > 0, 'EMPTY_EXPORT')
                entries.append({'path': relative, 'bytes': size, 'sha256': digest.hexdigest()})
        require(fingerprint(before) == fingerprint(os.fstat(directory)), 'EXPORT_CHANGED')

    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        visit(root_fd, ())
    finally:
        os.close(root_fd)
    require(all(any(item['path'].split('/')[0] == category for item in entries)
                for category in CATEGORIES), 'MISSING_CATEGORY')
    return entries


def period(start, end):
    require(isinstance(start, str) and isinstance(end, str)
            and re.fullmatch(r'\d{4}-\d{2}-\d{2}', start)
            and re.fullmatch(r'\d{4}-\d{2}-\d{2}', end), 'INVALID_PERIOD')
    try:
        require(datetime.date.fromisoformat(start) <= datetime.date.fromisoformat(end),
                'INVALID_PERIOD')
    except ValueError:
        raise ArchiveError('INVALID_PERIOD') from None
    return {'from': start, 'through': end, 'coverage_verified': False}


def seal(root, start, end):
    declared = period(start, end)
    destination = root / MANIFEST
    require(not os.path.lexists(destination), 'MANIFEST_EXISTS')
    document = {'format': 'pickchick-iiko-archive-v1', 'declared_period': declared,
                'accounting_accepted': False, 'files': inventory(root)}
    content = (json.dumps(document, ensure_ascii=True, indent=2) + '\n').encode()
    require(len(content) <= MAX_MANIFEST, 'MANIFEST_TOO_LARGE')
    fd, name = tempfile.mkstemp(prefix='.archive-', suffix='.tmp', dir=root)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        # Atomic no-clobber publication. Never replace another operator's manifest.
        os.link(name, destination)
    finally:
        os.unlink(name)
    return {'status': 'inventory_recorded', 'files': len(document['files']),
            'manifest_sha256': hashlib.sha256(content).hexdigest(),
            'accounting_accepted': False}


def verify(root, expected_sha256):
    require(isinstance(expected_sha256, str)
            and re.fullmatch('[0-9a-f]{64}', expected_sha256), 'INVALID_MANIFEST_SHA256')
    require(not root.is_symlink(), 'NON_REGULAR_ARCHIVE')
    fd = os.open(root / MANIFEST, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), 'NON_REGULAR_MANIFEST')
        content = stream.read(MAX_MANIFEST + 1)
    require(len(content) <= MAX_MANIFEST, 'MANIFEST_TOO_LARGE')
    require(hashlib.sha256(content).hexdigest() == expected_sha256, 'MANIFEST_HASH_MISMATCH')
    try:
        document = json.loads(content)
    except (UnicodeError, ValueError):
        raise ArchiveError('INVALID_MANIFEST') from None
    require(isinstance(document, dict), 'INVALID_MANIFEST')
    declared = document.get('declared_period')
    require(isinstance(declared, dict), 'INVALID_MANIFEST')
    require(document.get('accounting_accepted') is False
            and declared.get('coverage_verified') is False, 'INVALID_MANIFEST')
    expected = {'format': 'pickchick-iiko-archive-v1',
                'declared_period': period(declared.get('from'), declared.get('through')),
                'accounting_accepted': False, 'files': inventory(root)}
    # Compare the complete inventory: missing, extra, renamed and changed files fail.
    # No manifest-supplied path is opened, so even a malformed manifest cannot escape root.
    require(document == expected, 'ARCHIVE_MISMATCH')
    return {'status': 'bytes_verified', 'files': len(expected['files']),
            'manifest_sha256': expected_sha256, 'accounting_accepted': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    record = commands.add_parser('seal')
    record.add_argument('directory', type=Path)
    record.add_argument('--period-from', required=True)
    record.add_argument('--period-through', required=True)
    check = commands.add_parser('verify')
    check.add_argument('directory', type=Path)
    check.add_argument('--manifest-sha256', required=True)
    args = parser.parse_args()
    try:
        result = seal(args.directory, args.period_from, args.period_through) \
            if args.command == 'seal' else verify(args.directory, args.manifest_sha256)
    except (ArchiveError, OSError) as error:
        # Paths and export content may contain personal or financial information.
        code = str(error) if isinstance(error, ArchiveError) else 'ARCHIVE_IO_ERROR'
        print(json.dumps({'status': 'failed', 'code': code}), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
