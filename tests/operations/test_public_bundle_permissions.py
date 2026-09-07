"""Real filesystem permission regressions; build and Git responses are isolated fixtures."""
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'infra/public-staging/prepare-web.py'
SHA = 'a' * 40
PUBLIC_NAMES = [
    'index.html', 'app.js', 'ui.js', 'views.js', 'screens.json', 'styles.css',
    'reference-fonts.css', 'reference-mobile.css', 'reference-mobile.js',
    'reference-kiosk.css', 'reference-kiosk.js', 'reference-operations.css',
    'reference-operations.js',
]


class PublicBundlePermissions(unittest.TestCase):
    def fixture(self, root):
        source = root / 'infra/public-staging/prepare-web.py'
        source.parent.mkdir(parents=True)
        shutil.copyfile(SOURCE, source)
        spec = importlib.util.spec_from_file_location('prepare_public_fixture', source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        inputs = ['apps/operations/dist/index.html', 'apps/operations/dist/assets/app.js',
                  'apps/backoffice/dist/index.html', 'apps/backoffice/dist/api.js',
                  'design/prototype/assets/mockup/shot.jpg', 'packages/design-tokens/tokens.css',
                  'packages/design-tokens/tokens.json']
        inputs += ['design/prototype/' + name for name in PUBLIC_NAMES]
        for name in inputs:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'public fixture')
        private = root / '.local/private-evidence'
        private.mkdir(parents=True, mode=0o700)
        env = private / 'fixture.env'
        env.write_text('FIXTURE=true\n')
        env.chmod(0o600)
        return module, private

    def test_umask_077_does_not_hide_public_bundle_or_widen_private_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            module, private = self.fixture(Path(directory))
            output = private / 'public-web'
            prior = os.umask(0o077)
            try:
                with patch('sys.argv', ['prepare-web', '--source-sha', SHA, '--output', str(output)]), \
                     patch.object(module.subprocess, 'check_output', side_effect=[SHA + '\n', '']), \
                     patch.object(module.subprocess, 'run') as build, redirect_stdout(io.StringIO()):
                    module.main()
                self.assertEqual(build.call_count, 2)
                files = [path for path in output.rglob('*') if path.is_file()]
                directories = [output, *[path for path in output.rglob('*') if path.is_dir()]]
                self.assertTrue(files)
                self.assertTrue(all(path.stat().st_mode & 0o777 == 0o644 for path in files))
                self.assertTrue(all(path.stat().st_mode & 0o777 == 0o755 for path in directories))
                self.assertEqual(private.stat().st_mode & 0o777, 0o700)
                self.assertEqual((private / 'fixture.env').stat().st_mode & 0o777, 0o600)
                manifest = json.loads((output / '.release.json').read_text())
                self.assertEqual(manifest['source_sha'], SHA)
                self.assertIn('backoffice/api.js', manifest['files'])
            finally:
                os.umask(prior)

    def test_dirty_packager_is_rejected_before_build_or_output_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            module, private = self.fixture(Path(directory))
            output = private / 'public-web'
            with patch('sys.argv', ['prepare-web', '--source-sha', SHA, '--output', str(output)]), \
                 patch.object(module.subprocess, 'check_output', side_effect=[
                     SHA + '\n', ' M infra/public-staging/prepare-web.py\n']) as git, \
                 patch.object(module.subprocess, 'run') as build, self.assertRaises(AssertionError):
                module.main()
            self.assertEqual(git.call_args.args[0], ['git', 'status', '--porcelain', '--untracked-files=all'])
            build.assert_not_called()
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
