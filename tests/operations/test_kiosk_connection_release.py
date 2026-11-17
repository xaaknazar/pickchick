"""Fixture-only tests for the narrow kiosk ingress change and protected rollback."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('kiosk_connection', ROOT / 'infra/staging/kiosk-connection-release.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class KioskIngressGuards(unittest.TestCase):
    def original(self):
        raw = (ROOT / 'infra/public-staging/front-site.Caddyfile').read_bytes()
        self.assertEqual(raw.count(m.BLOCK), 1)
        return raw.replace(m.BLOCK, b'', 1)

    def test_only_exact_get_route_added_before_short_default(self):
        old = b'other.example { respond "unchanged" }\n' + self.original() + b'\nafter.example { respond "same" }\n'
        new = m.candidate(old)
        self.assertEqual(new.replace(m.BLOCK, b'', 1), old)
        self.assertIn(b'method GET\n\t\tpath /v1/kiosk-checkout/availability\n', m.BLOCK)
        self.assertIn(b'response_header_timeout 32s', m.BLOCK)
        self.assertGreaterEqual(32, 25 + 5)
        self.assertIn(b'response_header_timeout 8s', new)
        self.assertLess(new.index(m.BLOCK), new.index(b'\n\thandle {'))

    def test_front_template_and_separate_fragment_are_consistent(self):
        raw = (ROOT / 'infra/public-staging/front-site.Caddyfile').read_bytes()
        fragment = (ROOT / 'infra/pickchick-ingress/kiosk-availability.Caddyfile').read_bytes()
        self.assertEqual(fragment, m.BLOCK)
        self.assertEqual(raw.count(fragment), 1)
        self.assertEqual(m.candidate(raw.replace(fragment, b'', 1)), raw)
        historical = (ROOT / 'infra/pickchick-ingress/sites.Caddyfile').read_bytes()
        self.assertNotIn(fragment, historical)

    def test_auth_probe_trace_is_stable_without_ignoring_response_fields(self):
        from types import SimpleNamespace
        from uuid import uuid4
        seen = []
        error_code = ['INVALID_REQUEST']

        def response(request, timeout):
            seen.append(request)
            is_kiosk = request.full_url.endswith('/v1/kiosk-checkout/config')
            trace = request.get_header('X-request-id') or str(uuid4())
            body = (json.dumps({'code': error_code[0], 'trace_id': trace,
                                'message_key': 'errors.invalid_request', 'retryable': False}).encode()
                    if is_kiosk else b'unchanged')
            return SimpleNamespace(status=400 if is_kiosk else 200,
                                   read=lambda: body, geturl=lambda: request.full_url)

        with patch.object(m.urllib.request, 'urlopen', side_effect=response):
            original = m.probes()
            self.assertEqual(original, m.probes())
            error_code[0] = 'CHANGED_ERROR'
            self.assertNotEqual(original, m.probes())
        self.assertTrue(all(r.get_header('X-request-id') == m.PROBE_TRACE_ID for r in seen))

    def test_duplicate_site_or_existing_rule_stops(self):
        old = self.original()
        for raw in [old + old, m.candidate(old)]:
            with self.assertRaises(m.Stop):
                m.candidate(raw)

    def test_unknown_default_stops(self):
        with self.assertRaisesRegex(m.Stop, 'front.default_timeout'):
            m.candidate(self.original().replace(b'timeout 8s', b'timeout 9s'))

    def test_foreign_lock_cannot_be_removed(self):
        with tempfile.TemporaryDirectory() as d:
            lock = Path(d) / 'lock'
            lock.mkdir()
            m.save(lock / 'owner.json', {'id': 'foreign'})
            with patch.object(m, 'LOCK', lock), self.assertRaisesRegex(m.Stop, 'lock.foreign'):
                m.release_lock({'id': 'ours'})
            self.assertTrue(lock.exists())

    def test_container_drift_stops_before_front_write(self):
        with patch.object(m, 'inventory', return_value={'API': {'image': 'changed'}}):
            with self.assertRaisesRegex(m.Stop, 'containers.changed'):
                m.unchanged({'containers': {'API': {'image': 'original'}}}, b'old')

    def test_public_private_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / 'baseline'
            f.write_text('{}')
            f.chmod(0o644)
            with self.assertRaisesRegex(m.Stop, 'private.input'):
                m.private(f)

    def test_failed_reload_restores_only_our_config(self):
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d); front = folder / 'front'; lock = folder / 'lock'
            front.write_bytes(b'old')
            baseline = {'containers': {m.API: {'image': 'pinned'}}, 'metadata': {}, 'before_digest': m.digest(b'old')}
            state = {'live': b'old'}
            def write(raw, *_):
                front.write_bytes(raw)
            def reload(raw):
                if raw == b'new':
                    raise m.Stop('test.reload_failed')
                state['live'] = raw
            with patch.multiple(m, FRONT=front, LOCK=lock), \
                    patch.object(m, 'load', return_value=(baseline, b'old', b'new')), \
                    patch.object(m, 'unchanged'), patch.object(m, 'validate'), \
                    patch.object(m, 'inventory', return_value=baseline['containers']), \
                    patch.object(m, 'adapted', side_effect=lambda x: x), \
                    patch.object(m, 'live', side_effect=lambda: state['live']), \
                    patch.object(m, 'write_front', side_effect=write), \
                    patch.object(m, 'reload', side_effect=reload):
                with self.assertRaisesRegex(m.Stop, 'test.reload_failed'):
                    m.apply(folder, 'fixture')
            self.assertEqual(front.read_bytes(), b'old')
            self.assertEqual(json.loads((folder / 'state.json').read_text())['status'], 'rolled_back')
            self.assertFalse(lock.exists())

    def test_uncertain_command_retains_owned_lock(self):
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d); lock = folder / 'lock'
            b = {'containers': {m.API: {'image': 'pinned'}}, 'metadata': {}, 'before_digest': 'before'}
            with patch.object(m, 'LOCK', lock), patch.object(m, 'load', return_value=(b, b'old', b'new')), \
                    patch.object(m, 'unchanged'), patch.object(m, 'validate'), \
                    patch.object(m, 'write_front', side_effect=m.Uncertain('command.completion_unknown')):
                with self.assertRaises(m.Uncertain):
                    m.apply(folder, 'fixture')
            self.assertTrue((lock / 'owner.json').exists())
            self.assertTrue((folder / 'uncertain.json').exists())


if __name__ == '__main__':
    unittest.main()
