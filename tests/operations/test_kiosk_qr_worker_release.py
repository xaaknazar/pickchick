import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('kiosk_qr_worker_release', ROOT / 'infra/staging/release-kiosk-qr-worker.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)

INSTALLED = {
    'name': 'pickchick-kiosk-kaspi-qr-worker',
    'services': {'worker': {
        'cap_drop': ['ALL'], 'command': ['node', 'services/api/dist/kiosk-kaspi-qr-worker.js'],
        'container_name': r.WORKER, 'image': 'pickchick-api:' + r.BASE_SHA,
        'network_mode': 'container:' + r.BRIDGE, 'read_only': True,
    }},
}


class Candidate(unittest.TestCase):
    def setUp(self):
        self.raw = json.dumps(INSTALLED)
        self.original = r.BASE_COMPOSE_SHA256
        r.BASE_COMPOSE_SHA256 = r.digest(self.raw.encode())

    def tearDown(self):
        r.BASE_COMPOSE_SHA256 = self.original

    def test_only_the_image_tag_moves(self):
        out = json.loads(r.worker_candidate(self.raw, 'b' * 40))
        self.assertEqual(out['services']['worker']['image'], 'pickchick-api:' + 'b' * 40)
        out['services']['worker']['image'] = INSTALLED['services']['worker']['image']
        self.assertEqual(out, INSTALLED)

    def test_changed_installed_compose_is_refused(self):
        with self.assertRaisesRegex(r.GuardFailure, 'Installed worker compose changed'):
            r.worker_candidate(self.raw.replace('ALL', 'NONE'), 'b' * 40)

    def test_unexpected_service_or_binding_is_refused(self):
        for mutate in [lambda v: v['services'].update({'extra': {}}),
                       lambda v: v['services']['worker'].update({'network_mode': 'bridge'}),
                       lambda v: v['services']['worker'].update({'image': 'pickchick-api:' + 'c' * 40})]:
            value = json.loads(self.raw)
            mutate(value)
            raw = json.dumps(value)
            r.BASE_COMPOSE_SHA256 = r.digest(raw.encode())
            with self.assertRaises(r.GuardFailure):
                r.worker_candidate(raw, 'b' * 40)

    def test_arguments_require_ci_proof(self):
        with self.assertRaises(SystemExit):
            r.parse(['a' * 40, '--branch', 'codex/x'])
        self.assertFalse(r.parse(['a' * 40, '--branch', 'codex/x', '--ci-run', '1']).apply)


if __name__ == '__main__':
    unittest.main()
