"""Failure injection: portal-only replacement restores the original runtime."""
import importlib.util
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('update', Path(__file__).with_name('update.py'))
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)

class ReplacementTests(unittest.TestCase):
    def exercise(self, stage):
        calls=[]
        def run(argv):
            calls.append(argv)
            if stage == 'network' and argv[1:3] == ['network','connect']:
                raise RuntimeError('fixture network failure')
            return b''
        def create():
            if stage == 'create': raise RuntimeError('fixture create failure')
        def verify():
            if stage == 'verify': raise RuntimeError('fixture HTTP mismatch')
            if stage == 'uncertain': raise u.d.Uncertain('fixture timeout')
        with patch.object(u.d, 'run', run), patch.object(u, 'healthy'), patch.object(u, 'portal_http') as rollback:
            if stage:
                with self.assertRaises(RuntimeError): u.replace_container('backup',create,verify,rollback)
            else: u.replace_container('backup',create,verify,rollback)
            if stage and stage != 'uncertain':
                rollback.assert_called_once()
                self.assertIn(['docker','rename','backup',u.NAME],calls)
                self.assertEqual(calls[-1], ['docker','start',u.NAME])
            else: rollback.assert_not_called()
            if stage in ('network','verify'): self.assertIn(['docker','rm','-f',u.NAME],calls)
            if stage == 'uncertain': self.assertNotIn(['docker','rm','-f',u.NAME],calls)
    def test_success(self): self.exercise(None)
    def test_create_failure(self): self.exercise('create')
    def test_network_failure(self): self.exercise('network')
    def test_verification_failure(self): self.exercise('verify')
    def test_unknown_result_requires_inspection(self): self.exercise('uncertain')

class CanonicalDevicesTests(unittest.TestCase):
    def test_backup_restores_private_bytes_without_touching_live_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, backup = root/'live.json', root/'backup.json'
            data = b'{"synthetic":"account fixture"}\r\n'
            source.write_bytes(data)
            source.chmod(0o600)
            inode = source.stat().st_ino
            self.assertEqual(u.backup_and_restore_private(source, backup), u.d.digest(data))
            self.assertEqual(source.read_bytes(), data)
            self.assertEqual(source.stat().st_ino, inode)
            self.assertEqual(backup.read_bytes(), data)
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                u.backup_and_restore_private(source, backup)

    def test_qr_worker_is_a_protected_neighbor(self):
        names = [*u.d.NAMES, 'pickchick-kiosk-kaspi-qr-worker', u.NAME]
        def inspect(name):
            return {'Id': name+'-id', 'Image': 'immutable',
                    'State': {'Running': True, 'StartedAt': 'before'}}
        with patch.object(u.d, 'run', return_value='\n'.join(names).encode()), patch.object(u, 'inspect', inspect):
            before = u.neighbors()
        self.assertIn('pickchick-kiosk-kaspi-qr-worker', before)
        self.assertNotIn(u.NAME, before)
        def changed(name):
            result = inspect(name)
            if name == 'pickchick-kiosk-kaspi-qr-worker': result['Id'] = 'unexpected-replacement'
            return result
        with patch.object(u.d, 'run', return_value='\n'.join(names).encode()), patch.object(u, 'inspect', changed):
            self.assertNotEqual(u.neighbors(), before)

    def test_stale_canonical_device_bundle_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            assets = root/'apps/backoffice/dist'
            paths = ['index.html', 'app.js', 'api.js', 'devices-model.js',
                     'components/DeviceAccessView.js', 'workspace.css', 'assets/logo.png']
            for path in paths:
                p = assets/path
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(path.encode())
            def http(url):
                path = url.removeprefix('https://pickchick.kz/backoffice/') or 'index.html'
                return 200, {}, path.encode()
            with patch.object(u.d, 'http', http): u.published_assets(root)
            def stale(url):
                if url.endswith('devices-model.js'): return 200, {}, b'old module'
                return http(url)
            with patch.object(u.d, 'http', stale), self.assertRaisesRegex(RuntimeError, 'Canonical'):
                u.published_assets(root)

if __name__ == '__main__': unittest.main()
