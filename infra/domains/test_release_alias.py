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

    def test_profile_matches_all_current_foundation_jobs(self):
        import re
        workflow = Path(__file__).resolve().parents[2]/'.github/workflows/ci.yml'
        names = set(re.findall(r'^    name: (.+)$', workflow.read_text(), re.MULTILINE))
        self.assertEqual(alias.JOBS, names)
        self.assertEqual(len(names), 11)
        p = proof(); p['jobs']['jobs'].append(dict(p['jobs']['jobs'][0]))
        p['jobs']['total_count'] += 1
        with self.assertRaises(RuntimeError): alias.verify_ci(p, SHA)

    def test_test_forwarding_requires_exact_reviewed_block_and_explicit_gate(self):
        original = b'old.example { respond "unchanged" }'
        block = Path(__file__).with_name('pickchick-test.Caddyfile').read_bytes()
        with self.assertRaises(RuntimeError): alias.candidate(original, block)
        new = alias.candidate(original, block, True)
        self.assertTrue(new.startswith(original))
        for changed in [block.replace(b'method POST', b'method GET'),
                        block.replace(b'test-pay ', b'pay '), block+b'other.example {}']:
            with self.assertRaises(RuntimeError): alias.candidate(original, changed, True)
        self.assertIn(b'@payment_callback path /v1/integrations/tiptoppay/*', block)
        self.assertIn(b'PAYMENT_INTEGRATION_PENDING" 503', block)
        self.assertNotIn(b'.well-known', block)
        route = block.split(b'\troute {\n', 1)[1].split(b'\n}\npickchick.kz', 1)[0]
        self.assertLess(route.index(b'handle @tiptop_test_get'), route.index(b'handle @payment_callback'))
        self.assertLess(route.index(b'handle @tiptop_test_post'), route.index(b'handle @payment_callback'))
        self.assertLess(route.index(b'handle @payment_callback'), route.index(b'handle @staff'))
        self.assertTrue(route.rstrip().endswith(b'}'))

    def test_http_probes_require_signed_test_boundary_and_live_unavailable(self):
        for allow in [False, True]:
            def http(url, **kwargs):
                path = url.split('https://synthetic')[1]
                if allow and path.endswith('/test-checkout'): return 200, {}, b''
                if allow and '/test-' in path and kwargs.get('method') == 'POST':
                    self.assertEqual(kwargs['data'], b'TestMode=1')
                    return 401, {}, b''
                return 503, {}, b''
            with patch.object(alias, 'http', side_effect=http):
                alias.verify_payment_routes('https://synthetic', allow)
        with patch.object(alias, 'http', return_value=(200, {}, b'')):
            with self.assertRaises(RuntimeError): alias.verify_payment_routes('https://synthetic', True)

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
