"""Local synthetic exports only; no iiko access or accounting acceptance."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/iiko-archive.py'
SPEC = importlib.util.spec_from_file_location('iiko_archive', SCRIPT)
archive = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(archive)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'source'
        self.root.mkdir(mode=0o700)
        for category in archive.CATEGORIES:
            folder = self.root / category / 'касса 1'
            folder.mkdir(parents=True)
            (folder / 'ноябрь.csv').write_bytes('артикул,сумма\r\nӘ,100\r\n'.encode())
        self.file = self.root / 'sales/касса 1/ноябрь.csv'

    def seal(self):
        return archive.seal(self.root, '2026-08-01', '2026-11-19')['manifest_sha256']

    def test_copied_archive_and_manifest_match_original_bytes(self):
        result = self.seal()
        manifest = self.root / archive.MANIFEST
        self.assertEqual(manifest.stat().st_mode & 0o777, 0o600)
        document = json.loads(manifest.read_bytes())
        entry = next(x for x in document['files'] if x['path'].startswith('sales/'))
        self.assertEqual(entry['sha256'], hashlib.sha256(self.file.read_bytes()).hexdigest())
        self.assertEqual(entry['bytes'], len(self.file.read_bytes()))
        self.assertIs(document['declared_period']['coverage_verified'], False)
        copy = Path(self.temp.name) / 'independent-copy'
        shutil.copytree(self.root, copy)
        verified = archive.verify(copy, result)
        self.assertEqual(verified['status'], 'bytes_verified')
        self.assertEqual(verified['files'], 5)
        self.assertIs(verified['accounting_accepted'], False)

    def test_same_size_corruption_is_detected(self):
        digest = self.seal()
        original = self.file.read_bytes()
        self.file.write_bytes(original.replace(b'100', b'900'))
        with self.assertRaisesRegex(archive.ArchiveError, 'ARCHIVE_MISMATCH'):
            archive.verify(self.root, digest)

    def test_missing_extra_and_renamed_exports_are_detected(self):
        digest = self.seal()
        original = self.file.read_bytes()
        self.file.unlink()
        with self.assertRaises(archive.ArchiveError):
            archive.verify(self.root, digest)
        self.file.write_bytes(original)
        extra = self.file.with_name('extra.csv')
        extra.write_bytes(original)
        with self.assertRaisesRegex(archive.ArchiveError, 'ARCHIVE_MISMATCH'):
            archive.verify(self.root, digest)
        self.file.unlink()
        with self.assertRaisesRegex(archive.ArchiveError, 'ARCHIVE_MISMATCH'):
            archive.verify(self.root, digest)

    def test_every_category_must_contain_nonempty_export(self):
        for category in archive.CATEGORIES:
            folder = self.root / category
            other = self.root.parent / category
            folder.rename(other)
            with self.assertRaisesRegex(archive.ArchiveError, 'MISSING_CATEGORY'):
                self.seal()
            other.rename(folder)
        self.file.write_bytes(b'')
        with self.assertRaisesRegex(archive.ArchiveError, 'EMPTY_EXPORT'):
            self.seal()
        self.assertFalse((self.root / archive.MANIFEST).exists())

    def test_symlinks_and_fifo_never_become_exports(self):
        self.file.unlink()
        self.file.symlink_to('/etc/passwd')
        with self.assertRaisesRegex(archive.ArchiveError, 'NON_REGULAR_EXPORT'):
            self.seal()
        self.file.unlink()
        os.mkfifo(self.file)
        with self.assertRaisesRegex(archive.ArchiveError, 'NON_REGULAR_EXPORT'):
            self.seal()
        self.file.unlink()
        self.file.parent.rmdir()
        self.file.parent.symlink_to(self.root / 'receipts', target_is_directory=True)
        with self.assertRaisesRegex(archive.ArchiveError, 'NON_REGULAR_EXPORT'):
            self.seal()

    def test_root_symlink_and_unknown_root_files_rejected(self):
        alias = self.root.parent / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            archive.seal(alias, '2026-08-01', '2026-11-19')
        (self.root / 'forgotten-export.csv').write_text('data')
        with self.assertRaisesRegex(archive.ArchiveError, 'UNEXPECTED_ROOT_ENTRY'):
            self.seal()

    def test_period_requires_real_dates_and_order(self):
        for start, end in [('2026-02-30', '2026-11-19'), ('2026-11-20', '2026-11-19'),
                           ('20260801', '2026-11-19'), (None, '2026-11-19')]:
            with self.assertRaisesRegex(archive.ArchiveError, 'INVALID_PERIOD'):
                archive.seal(self.root, start, end)

    def test_changes_during_hashing_prevent_manifest_publication(self):
        original_hash = hashlib.sha256
        target = self.root / 'receipts/касса 1/ноябрь.csv'

        class ChangingDigest:
            def __init__(self):
                self.digest = original_hash()
                self.changed = False

            def update(self, chunk):
                self.digest.update(chunk)
                if not self.changed:
                    with target.open('ab') as stream:
                        stream.write(b'changed')
                    self.changed = True

            def hexdigest(self):
                return self.digest.hexdigest()

        with patch.object(archive.hashlib, 'sha256', side_effect=ChangingDigest):
            with self.assertRaisesRegex(archive.ArchiveError, 'EXPORT_CHANGED'):
                self.seal()
        self.assertFalse((self.root / archive.MANIFEST).exists())

    def test_manifest_is_never_overwritten_including_publication_race(self):
        digest = self.seal()
        with self.assertRaisesRegex(archive.ArchiveError, 'MANIFEST_EXISTS'):
            self.seal()
        manifest = self.root / archive.MANIFEST
        self.assertEqual(hashlib.sha256(manifest.read_bytes()).hexdigest(), digest)
        manifest.unlink()
        original_link = os.link

        def competing_link(source, target):
            Path(target).write_bytes(b'other operator')
            original_link(source, target)

        with patch.object(archive.os, 'link', side_effect=competing_link):
            with self.assertRaises(FileExistsError):
                self.seal()
        self.assertEqual(manifest.read_bytes(), b'other operator')
        self.assertEqual(list(self.root.glob('.archive-*.tmp')), [])

    def test_modified_manifest_fails_independent_hash_and_structure(self):
        digest = self.seal()
        manifest = self.root / archive.MANIFEST
        document = json.loads(manifest.read_bytes())
        document['files'][0]['path'] = '../../outside'
        manifest.write_text(json.dumps(document))
        with self.assertRaisesRegex(archive.ArchiveError, 'MANIFEST_HASH_MISMATCH'):
            archive.verify(self.root, digest)
        new_digest = hashlib.sha256(manifest.read_bytes()).hexdigest()
        with self.assertRaisesRegex(archive.ArchiveError, 'ARCHIVE_MISMATCH'):
            archive.verify(self.root, new_digest)

    def test_cli_has_nonzero_exit_and_does_not_disclose_paths(self):
        result = subprocess.run([sys.executable, str(SCRIPT), 'verify',
                                 str(self.root / 'private-client-name'),
                                 '--manifest-sha256', 'a' * 64], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stderr), {'status': 'failed', 'code': 'ARCHIVE_IO_ERROR'})
        self.assertEqual(result.stdout, '')

    def test_cli_seal_and_verify(self):
        result = subprocess.run([sys.executable, str(SCRIPT), 'seal', str(self.root),
                                 '--period-from', '2026-08-01', '--period-through', '2026-11-19'],
                                capture_output=True, text=True, check=True)
        digest = json.loads(result.stdout)['manifest_sha256']
        result = subprocess.run([sys.executable, str(SCRIPT), 'verify', str(self.root),
                                 '--manifest-sha256', digest],
                                capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)['status'], 'bytes_verified')


if __name__ == '__main__':
    unittest.main()
