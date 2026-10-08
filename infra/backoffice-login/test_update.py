"""Failure injection: portal-only replacement restores the original runtime."""
import importlib.util
from pathlib import Path
import unittest
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

if __name__ == '__main__': unittest.main()
