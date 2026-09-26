"""Release packaging boundaries with real temporary Git repositories and files."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / 'infra/public-staging/package-operations-overlay.py'


class OverlayTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / 'source'
        self.script = self.repo / 'infra/public-staging/package-operations-overlay.py'
        self.script.parent.mkdir(parents=True)
        shutil.copyfile(SCRIPT, self.script)
        (self.repo / '.gitignore').write_text('dist/\n')
        for args in [
            ['init', '-q'], ['add', '.'],
            ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
             'commit', '-qm', 'Named source'],
        ]:
            subprocess.run(['git', *args], cwd=self.repo, check=True, capture_output=True)
        self.sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=self.repo, text=True).strip()
        self.base = self.root / 'base'
        files = {
            'operations/index.html': 'old index', 'operations/assets/old.js': 'old asset',
            'backoffice/index.html': 'keep backoffice',
            'kitchen-demo/index.html': 'keep kitchen rehearsal',
            'design/prototype/assets/logo.png': 'keep public logo',
        }
        hashes = {}
        for name, content in files.items():
            p = self.base / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
            hashes[name] = hashlib.sha256(p.read_bytes()).hexdigest()
        self.manifest = self.base / '.release.json'
        self.manifest.write_text(json.dumps({'source_sha': 'a' * 40, 'files': hashes,
                                            'component_sources': {'kitchen-demo': 'b' * 40}}))
        self.manifest_hash = hashlib.sha256(self.manifest.read_bytes()).hexdigest()
        self.dist = self.repo / 'apps/operations/dist'
        (self.dist / 'assets').mkdir(parents=True)
        (self.dist / 'index.html').write_text('new index')
        (self.dist / 'assets/new.js').write_text('new asset')
        self.output = self.root / 'output'

    def run_package(self, **overrides):
        args = {
            'source-sha': self.sha, 'base-web': str(self.base), 'output': str(self.output),
            'expected-base-source-sha': 'a' * 40,
            'expected-base-manifest-sha256': self.manifest_hash,
            **overrides,
        }
        command = ['python3', str(self.script)]
        for name, value in args.items():
            command += ['--' + name, value]
        return subprocess.run(command, capture_output=True, text=True)

    def test_preserves_other_apps_old_assets_and_exact_manifest(self):
        result = self.run_package()
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.output / '.release.json').read_text())
        self.assertEqual((self.output / 'operations/index.html').read_text(), 'new index')
        for path in ['operations/assets/old.js', 'backoffice/index.html', 'design/prototype/assets/logo.png', 'kitchen-demo/index.html']:
            self.assertEqual((self.output / path).read_bytes(), (self.base / path).read_bytes())
        actual = {p.relative_to(self.output).as_posix() for p in self.output.rglob('*') if p.is_file()}
        self.assertEqual(actual, set(manifest['files']) | {'.release.json'})
        self.assertEqual(manifest['component_sources']['operations'], self.sha)
        self.assertEqual(manifest['component_sources']['backoffice'], 'a' * 40)
        self.assertEqual(manifest['component_sources']['kitchen-demo'], 'b' * 40)
        for path, expected in manifest['files'].items():
            self.assertEqual(hashlib.sha256((self.output / path).read_bytes()).hexdigest(), expected)
            self.assertEqual((self.output / path).stat().st_mode & 0o777, 0o644)
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o755 for p in self.output.rglob('*') if p.is_dir()))

    def test_rejects_same_asset_name_with_different_bytes(self):
        (self.dist / 'assets/old.js').write_text('replaced old client code')
        self.assertNotEqual(self.run_package().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_rejects_corrupt_base_file_and_unexpected_manifest(self):
        self.assertNotEqual(self.run_package(**{'expected-base-manifest-sha256': '0' * 64}).returncode, 0)
        self.assertNotEqual(self.run_package(**{'expected-base-source-sha': 'b' * 40}).returncode, 0)
        (self.base / 'backoffice/index.html').write_text('changed after baseline')
        self.assertNotEqual(self.run_package().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_rejects_private_dist_files_and_symlinks(self):
        p = self.dist / 'assets/.private.js'
        p.write_text('private')
        self.assertNotEqual(self.run_package().returncode, 0)
        p.unlink()
        p = self.dist / 'assets/leak.js'
        p.symlink_to(self.manifest)
        self.assertNotEqual(self.run_package().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_rejects_source_changes_after_verified_commit(self):
        (self.repo / 'uncommitted.ts').write_text('unverified')
        self.assertNotEqual(self.run_package().returncode, 0)
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
