import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('alias', Path(__file__).with_name('release-alias.py'))
alias = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alias)
SHA = 'a' * 40


def proof():
    return {'run': {'head_sha': SHA, 'status': 'completed', 'conclusion': 'success',
                    'path': '.github/workflows/ci.yml',
                    'head_repository': {'full_name': 'xaaknazar/pickchick'}},
            'jobs': {'total_count': len(alias.JOBS), 'jobs': [
                {'name': name, 'head_sha': SHA, 'status': 'completed', 'conclusion': 'success'}
                for name in alias.JOBS]}}


class Guards(unittest.TestCase):
    def test_exact_successful_ci(self):
        alias.verify_ci(proof(), SHA)
        for field, value in [('head_sha', 'b'*40), ('status', 'in_progress'),
                             ('conclusion', 'failure'), ('path', '.github/workflows/roadmap.yml'),
                             ('head_repository', {'full_name': 'other/repo'})]:
            p = proof(); p['run'][field] = value
            with self.assertRaises(RuntimeError): alias.verify_ci(p, SHA)

    def test_partial_skipped_failed_and_wrong_sha_jobs(self):
        for field, value in [('head_sha', 'b'*40), ('status', 'in_progress'),
                             ('conclusion', 'failure'), ('conclusion', 'skipped')]:
            p = proof(); p['jobs']['jobs'][0][field] = value
            with self.assertRaises(RuntimeError): alias.verify_ci(p, SHA)
        p = proof(); p['jobs']['jobs'].pop()
        with self.assertRaises(RuntimeError): alias.verify_ci(p, SHA)

    def test_candidate_preserves_original_bytes_and_refuses_second_apply(self):
        original = b'old.example {\n respond "unchanged"\n}\n'
        block = Path(__file__).with_name('pickchick.Caddyfile').read_bytes()
        new = alias.candidate(original, block)
        self.assertEqual(new[:len(original)], original)
        with self.assertRaises(RuntimeError): alias.candidate(new, block)
        with self.assertRaises(RuntimeError): alias.candidate(original, b'partial')

    def test_writer_is_isolated_to_existing_file_owner(self):
        class Stat:
            st_uid, st_gid = 1001, 50
        with patch.object(Path, 'stat', return_value=Stat()), patch.object(alias, 'run') as run:
            alias.write_front(b'private config')
        argv, data = run.call_args.args
        self.assertEqual(data, b'private config')
        self.assertIn('1001:50', argv)
        self.assertIn('type=bind,src=/opt/idrink/deploy/Caddyfile,dst=/target', argv)
        self.assertIn('none', argv)
        self.assertIn('--read-only', argv)
        self.assertNotIn('--privileged', argv)


if __name__ == '__main__':
    unittest.main()
