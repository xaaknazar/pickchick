import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('operator_bundle', ROOT / 'scripts/build-queue-recovery-operator.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class OperatorBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.source = self.base / 'source'
        self.source.mkdir()
        for relative in builder.FILES + builder.DOCS:
            target = self.source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        (self.source / '.gitignore').write_text('.local/\n')
        self.git('init', '-q')
        self.git('config', 'user.name', 'Synthetic bundle test')
        self.git('config', 'user.email', 'synthetic@example.invalid')
        self.git('config', 'core.autocrlf', 'false')
        self.sha = self.commit()

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.source, stderr=subprocess.DEVNULL).decode().strip()

    def commit(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'Synthetic source')
        return self.git('rev-parse', 'HEAD')

    def build(self, name='operator.zip', sha=None):
        return builder.bundle(self.source, sha or self.sha, self.base / name)

    def test_complete_deterministic_delivery_excludes_private_files(self):
        private = self.source / '.local'
        private.mkdir()
        (private / 'credentials.json').write_text('DO_NOT_SHIP_SYNTHETIC_SECRET')
        first, second = self.build(), self.build('second.zip')
        self.assertEqual(first['sha256'], second['sha256'])
        self.assertFalse(first['deploymentReady'])
        with zipfile.ZipFile(first['archive']) as archive:
            self.assertEqual(set(archive.namelist()), set(builder.FILES + builder.DOCS) | {'operator-manifest.json'})
            manifest = json.loads(archive.read('operator-manifest.json'))
            self.assertEqual(manifest['sourceCommit'], self.sha)
            for row in manifest['files']:
                data = archive.read(row['path'])
                self.assertEqual(len(data), row['bytes'])
                self.assertEqual(hashlib.sha256(data).hexdigest(), row['sha256'])
                self.assertNotIn(b'DO_NOT_SHIP_SYNTHETIC_SECRET', data)

    def test_refuses_wrong_sha_dirty_or_untracked_source(self):
        with self.assertRaisesRegex(ValueError, 'HEAD differs'):
            self.build(sha='0' * 40)
        file = self.source / builder.FILES[0]
        original = file.read_bytes()
        file.write_bytes(original + b'\n')
        with self.assertRaisesRegex(ValueError, 'clean'):
            self.build()
        file.write_bytes(original)
        extra = self.source / 'unexpected.env'
        extra.write_text('SYNTHETIC_ONLY=1')
        with self.assertRaisesRegex(ValueError, 'clean'):
            self.build()
        self.assertFalse((self.base / 'operator.zip').exists())

    def test_windows_checkout_newlines_do_not_change_reviewed_delivery_bytes(self):
        first = self.build()
        windows = self.base / 'windows-checkout'
        subprocess.check_call(['git', '-c', 'core.autocrlf=true', 'clone', '--quiet',
                               '--no-hardlinks', str(self.source), str(windows)])
        subprocess.check_call(['git', '-C', str(windows), 'config', 'core.autocrlf', 'true'])
        path = windows / (builder.PREFIX + builder.OPERATOR)
        self.assertTrue(b'\r\n' in path.read_bytes(), 'Fixture must exercise a CRLF checkout')
        result = builder.bundle(windows, self.sha, self.base / 'windows.zip')
        self.assertEqual(first['sha256'], result['sha256'])

    def test_refuses_changed_committed_helper_before_writing(self):
        helper = self.source / 'infra/windows/edge-backup-lib.mjs'
        helper.write_bytes(helper.read_bytes() + b'\n// changed\n')
        self.sha = self.commit()
        with self.assertRaisesRegex(ValueError, 'Pinned helper'):
            self.build()
        self.assertFalse((self.base / 'operator.zip').exists())

    def test_refuses_committed_symlink(self):
        helper = self.source / 'infra/windows/edge-backup-lib.mjs'
        helper.unlink()
        helper.symlink_to('edge-backup-task.mjs')
        self.sha = self.commit()
        with self.assertRaisesRegex(ValueError, 'non-regular'):
            self.build()

    def test_refuses_unknown_pin_and_missing_relative_dependency(self):
        files = {p: (self.source / p).read_bytes() for p in builder.FILES}
        files[builder.PREFIX + builder.OPERATOR] += b"\n'x.mjs'='" + b'a' * 64 + b"'\n"
        with self.assertRaisesRegex(ValueError, 'pin list'):
            builder.verify_pins(files)
        files = {p: (self.source / p).read_bytes() for p in builder.FILES}
        # The top-level helper is not self-pinned; a new relative dependency must be shipped.
        files[builder.PREFIX + builder.OPERATOR] += b'\n'
        files[builder.PREFIX + 'queue-recovery-upgrade-db.mjs'] += b"\nimport './missing.mjs';\n"
        old = hashlib.sha256((self.source / 'infra/windows/queue-recovery-upgrade-db.mjs').read_bytes()).hexdigest().encode()
        new = hashlib.sha256(files[builder.PREFIX + 'queue-recovery-upgrade-db.mjs']).hexdigest().encode()
        files[builder.PREFIX + builder.OPERATOR] = files[builder.PREFIX + builder.OPERATOR].replace(old, new)
        with self.assertRaisesRegex(ValueError, 'Unshipped'):
            builder.verify_pins(files)

    def test_does_not_overwrite_delivery_or_write_inside_checkout(self):
        self.build()
        with self.assertRaisesRegex(ValueError, 'new .zip'):
            self.build()
        with self.assertRaisesRegex(ValueError, 'outside'):
            builder.bundle(self.source, self.sha, self.source / 'operator.zip')


if __name__ == '__main__':
    unittest.main()
