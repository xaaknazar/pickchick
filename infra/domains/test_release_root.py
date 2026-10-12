import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('root_release', Path(__file__).with_name('release-root.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class RootRoute(unittest.TestCase):
    def test_adapted_redirect_rejects_ambiguous_caddy_syntax(self):
        def config():
            response = {'handler': 'static_response', 'headers': {'Location': ['/backoffice/']}, 'status_code': 302}
            root = {'match': [{'method': ['GET', 'HEAD'], 'path': ['/']}],
                    'handle': [{'handler': 'subroute', 'routes': [{'handle': [response]}]}]}
            host = {'match': [{'host': ['pickchick.kz']}],
                    'handle': [{'handler': 'subroute', 'routes': [root]}]}
            return {'apps': {'http': {'servers': {'srv0': {'routes': [host]}}}}}
        r.validate_redirect(config())
        for change in ['path', 'location', 'method', 'status', 'host']:
            data = config()
            host = data['apps']['http']['servers']['srv0']['routes'][0]
            root = host['handle'][0]['routes'][0]
            redirect = root['handle'][0]['routes'][0]
            if change == 'path': redirect['match'] = [{'path': ['/backoffice/']}]
            if change == 'location': redirect['handle'][0]['headers']['Location'] = ['302']
            if change == 'method': root['match'][0]['method'].append('POST')
            if change == 'status': redirect['handle'][0]['status_code'] = 200
            if change == 'host': host['match'][0]['host'] = ['api.pickchick.kz']
            with self.assertRaises(RuntimeError, msg=change): r.validate_redirect(data)

    def test_auth_trace_changes_do_not_hide_semantic_changes(self):
        def body(trace, **fields):
            return json.dumps({'code': 'UNAUTHORIZED', 'trace_id': trace, 'retryable': False, **fields}).encode()
        original = r.signature(401, {}, body('first'))
        self.assertEqual(original, r.signature(401, {}, body('second')))
        self.assertNotEqual(original, r.signature(401, {}, body('second', retryable=True)))
        self.assertNotEqual(original, r.signature(200, {}, body('first')))
        with self.assertRaises(RuntimeError): r.signature(401, {}, body('first', code='unexpected'))

    def test_only_canonical_get_head_root_changes(self):
        old = b'neighbor {\n respond untouched\n}\n'+Path(__file__).with_name('pickchick.Caddyfile').read_bytes()
        new = r.candidate(old)
        self.assertEqual(new.replace(r.ROUTE, b'', 1), old)
        self.assertIn(b'pickchick.kz {\n'+r.ROUTE, new)
        self.assertIn(b'path /\n', r.ROUTE)
        self.assertIn(b'method GET HEAD', r.ROUTE)
        self.assertNotIn(b'path /*', r.ROUTE)
        with self.assertRaises(RuntimeError): r.candidate(new)
        with self.assertRaises(RuntimeError): r.candidate(old+old)
        with self.assertRaises(RuntimeError): r.candidate(b'unknown format')

    def test_portal_template_matches_targeted_patch(self):
        template = Path(__file__).parents[1]/'backoffice-login/pickchick.Caddyfile'
        data = template.read_bytes()
        self.assertEqual(r.candidate(data.replace(r.ROUTE,b'',1)), data)

    def exercise(self, mode):
        with tempfile.TemporaryDirectory() as tmp:
            front, record = Path(tmp)/'front', Path(tmp)/'result'
            old = b'neighbor\npickchick.kz {\n import pickchick_alias\n}\n'
            new = r.candidate(old)
            front.write_bytes(old)
            baseline = (404, None, 'old-body')
            calls = []
            def caddy(action, data):
                calls.append((action, data))
                if action == 'reload' and data == new:
                    if mode == 'failure': raise RuntimeError('known failure')
                    if mode == 'uncertain': raise r.d.Uncertain('lost response')
                    if mode == 'foreign':
                        front.write_bytes(b'foreign edit')
                        raise RuntimeError('changed concurrently')
            def root(): return baseline if front.read_bytes() == old else (302, '/backoffice/', 'new-body')
            with patch.object(r.d, 'FRONT', front), patch.object(r.d,'caddy', side_effect=caddy), \
                 patch.object(r.d,'write_front', side_effect=front.write_bytes), patch.object(r,'root_response',side_effect=root):
                if mode == 'success':
                    r.apply_front(old,new,lambda:None,baseline,record)
                    self.assertTrue(record.exists())
                    self.assertEqual(front.read_bytes(),new)
                else:
                    kind = RuntimeError if mode == 'failure' else r.d.Uncertain
                    with self.assertRaises(kind): r.apply_front(old,new,lambda:None,baseline,record)
                    self.assertFalse(record.exists())
                    self.assertEqual(front.read_bytes(), old if mode == 'failure' else b'foreign edit' if mode == 'foreign' else new)
            if mode == 'failure': self.assertEqual(calls[-1], ('reload',old))
            if mode in ['uncertain','foreign']: self.assertNotIn(('reload',old),calls)

    def test_success(self): self.exercise('success')
    def test_known_failure_restores_original(self): self.exercise('failure')
    def test_lost_response_preserves_state_for_inspection(self): self.exercise('uncertain')
    def test_foreign_change_is_never_overwritten(self): self.exercise('foreign')


if __name__ == '__main__': unittest.main()
