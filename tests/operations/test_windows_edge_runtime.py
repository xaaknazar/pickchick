import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest
import zipfile


SCRIPT = pathlib.Path(__file__).resolve().parents[2] / 'scripts/build-windows-edge-runtime.py'
spec = importlib.util.spec_from_file_location('windows_edge_package', SCRIPT)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class WindowsEdgePackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self.temp.name)
        self.source = self.base / 'source'
        self.root = self.source / 'services/edge'
        self.package(self.root, '@pickchick/edge', '0.1.0', {'foo': '1', 'bar': '1'})
        (self.root / 'dist').mkdir()
        (self.root / 'dist/index.js').write_text(
            "import foo from 'foo'; import bar from 'bar'; console.log(foo + ':' + bar);\n"
        )
        sync = self.source / 'packages/pos-order-sync'
        self.package(sync, '@pickchick/pos-order-sync', '0.1.0', {'bar': '1', 'sync-only': '1'})
        (sync / 'dist').mkdir()
        (sync / 'dist/index.js').write_text(
            "import only from 'sync-only'; import bar from 'bar'; console.log(only + ':' + bar);\n"
        )
        self.package(self.source / 'node_modules/sync-only', 'sync-only', '1', value='sync-only')
        self.package(self.source / 'node_modules/bar', 'bar', '1', value='root-v1')
        foo = self.source / 'node_modules/foo'
        self.package(foo, 'foo', '1', {'bar': '2'})
        (foo / 'index.js').write_text("import bar from 'bar'; export default bar;\n")
        self.package(foo / 'node_modules/bar', 'bar', '2', value='nested-v2')
        for relative in builder.ADMIN_FILES:
            file = self.source / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('// packaged admin fixture\n')
        migration = self.source / 'db/edge/migrations/001_edge.sql'
        migration.parent.mkdir(parents=True)
        migration.write_text('SELECT 1;\n')

    def tearDown(self):
        self.temp.cleanup()

    def package(self, path, name, version, dependencies=None, value=None):
        path.mkdir(parents=True)
        (path / 'package.json').write_text(json.dumps({
            'name': name, 'version': version, 'type': 'module', 'main': 'index.js',
            'dependencies': dependencies or {},
        }))
        if value:
            (path / 'index.js').write_text('export default ' + json.dumps(value) + ';\n')

    def build(self, name='output'):
        return builder.build_package(self.source, self.base / name, 'a' * 40)

    def test_version_resolution_reproducibility_and_private_file_exclusion(self):
        (self.root / '.local').mkdir()
        (self.root / '.local/private.json').write_text('DO_NOT_PACKAGE')
        first = self.build()
        second = self.build('second')
        self.assertEqual(first['sha256'], second['sha256'])
        result = subprocess.run(['node', 'dist/index.js'], cwd=self.base / 'output',
                                capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip(), 'nested-v2:root-v1')
        worker = subprocess.run(['node', 'node_modules/@pickchick/pos-order-sync/dist/index.js'],
                                cwd=self.base / 'output', capture_output=True, text=True, check=True)
        self.assertEqual(worker.stdout.strip(), 'sync-only:root-v1')
        with zipfile.ZipFile(first['archive']) as archive:
            self.assertIsNone(archive.testzip())
            self.assertFalse(any('.local' in name for name in archive.namelist()))
            self.assertTrue(all((entry.external_attr >> 16) & 0o170000 != 0o120000
                                for entry in archive.infolist()))

    def test_rejects_external_dependency_and_missing_dependency(self):
        external = self.base / 'outside'
        self.package(external, 'evil', '1', value='bad')
        (self.source / 'node_modules/evil').symlink_to(external, target_is_directory=True)
        package_file = self.root / 'package.json'
        data = json.loads(package_file.read_text())
        data['dependencies']['evil'] = '1'
        package_file.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'escapes source'):
            self.build()
        del data['dependencies']['evil']
        data['dependencies']['missing'] = '1'
        package_file.write_text(json.dumps(data))
        with self.assertRaisesRegex(SystemExit, 'Missing required'):
            self.build()

    def test_rejects_windows_reserved_names_and_native_modules(self):
        reserved = self.source / 'node_modules/bar/NUL.txt'
        reserved.write_text('bad')
        with self.assertRaisesRegex(SystemExit, 'reserved path'):
            self.build()
        reserved.unlink()
        (self.source / 'node_modules/bar/native.node').write_bytes(b'not portable')
        with self.assertRaisesRegex(SystemExit, 'Native executable'):
            self.build('other')

    def test_rejects_output_symlinks(self):
        dist = self.root / 'dist'
        (dist / 'secret.js').symlink_to(self.base / 'outside-secret')
        with self.assertRaisesRegex(SystemExit, 'output symlink'):
            self.build()


if __name__ == '__main__':
    unittest.main()
