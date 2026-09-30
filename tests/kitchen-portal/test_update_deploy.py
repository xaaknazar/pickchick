import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('portal_update', Path(__file__).resolve().parents[2] / 'infra/kitchen-portal/update-deploy.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)

class UpdateTests(unittest.TestCase):
    def test_only_portal_can_restart(self):
        before = {u.b.SERVICE: ['old'], u.b.GATEWAY: ['gateway'], 'database': ['db']}
        with patch.object(u.b, 'containers', return_value={**before, u.b.SERVICE: ['new']}):
            u.unchanged(before)
        for name in [u.b.GATEWAY, 'database']:
            with patch.object(u.b, 'containers', return_value={**before, name: ['changed']}):
                with self.assertRaises(RuntimeError):
                    u.unchanged(before)

    def response(self, path):
        if path == '/kitchen-live/health':
            return 200, json.dumps({'sourceSha': 'a' * 40, 'edgeConnected': False}).encode(), {}
        if path.endswith('.js'):
            return 200, b'export {}', {'Content-Type': 'text/javascript'}
        if path in ['/kitchen/prep', '/kitchen/assembly', '/display']:
            return 200, b'<script src="/kitchen-live/assets/app.js"></script>', {}
        return 401, b'', {}

    def test_healthy_offline_portal_is_not_mistaken_for_order_acceptance(self):
        with patch.object(u.b, 'http', side_effect=self.response):
            u.verify('a' * 40)
            with self.assertRaises(RuntimeError):
                u.verify('b' * 40)

    def test_missing_module_and_anonymous_queue_abort_deploy(self):
        for target, response in [('/kitchen-live/assets/ticket-view.js', (404, b'', {})),
                                 ('/kitchen-live/prep/edge/v1/fulfillment/kitchen', (200, b'{}', {})),
                                 ('/kitchen-live/private/config.json', (200, b'{}', {}))]:
            with patch.object(u.b, 'http', side_effect=lambda path: response if path == target else self.response(path)):
                with self.assertRaises(RuntimeError):
                    u.verify('a' * 40)

if __name__ == '__main__':
    unittest.main()
