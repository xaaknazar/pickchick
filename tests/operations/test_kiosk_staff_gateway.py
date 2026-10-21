import importlib.util
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('kiosk_staff_gateway', ROOT/'infra/public-staging/kiosk-staff-gateway.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
SOURCE = (ROOT/'infra/domains/kiosk-staff.Caddyfile').read_text()
BLOCK = g.START + SOURCE.split(g.START)[1].split(g.END)[0] + g.END


class KioskStaffGateway(unittest.TestCase):
    def test_only_the_staff_code_block_is_added_and_a_repeat_is_refused(self):
        old = (ROOT/'infra/public-staging/gateway.Caddyfile').read_text() + '\n# unrelated installed kiosk route\n'
        new = g.candidate(old, SOURCE)
        self.assertEqual(new.replace(BLOCK+'\n', '', 1), old)
        self.assertEqual(new.count(g.ROUTE), 1)
        with self.assertRaises(RuntimeError):
            g.candidate(new, SOURCE)
        with self.assertRaises(RuntimeError):
            g.candidate(old.replace('@backoffice_get {', '@different {'), SOURCE)
        with self.assertRaises(RuntimeError):
            g.candidate(old + '\t\tpath ' + g.ROUTE + '\n', SOURCE)

    def test_route_is_post_only_bounded_and_drops_browser_and_bearer_credentials(self):
        self.assertIn('\t\tmethod POST\n\t\tpath /v1/kiosk-checkout/staff/verify\n', BLOCK)
        self.assertEqual(re.findall(r'\t\tpath (.+)\n', BLOCK), ['/v1/kiosk-checkout/staff/verify'])
        for line in ('max_size 1KB', 'header X-PickChick-Data kiosk', 'header_up -Cookie',
                     'header_up -Authorization', 'header_up -X-Device-Id', 'dial_timeout 2s',
                     'response_header_timeout 5s', 'reverse_proxy pickchick-staging-api-1:3100'):
            self.assertIn(line, BLOCK)
        # The kiosk authenticates with its own device headers; they must reach the API.
        self.assertNotIn('header_up -X-Kiosk', BLOCK)
        for weaker in (SOURCE.replace('max_size 1KB', 'max_size 1MB'),
                       SOURCE.replace('\t\t\theader_up -Authorization\n', ''),
                       SOURCE.replace('method POST', 'method POST GET'),
                       SOURCE.replace('path /v1/kiosk-checkout/staff/verify',
                                      'path /v1/kiosk-checkout/staff/verify /v1/kiosk-checkout/*')):
            with self.assertRaises(RuntimeError):
                g.candidate((ROOT/'infra/public-staging/gateway.Caddyfile').read_text(), weaker)

    def test_verification_needs_the_new_route_and_the_api_device_guard(self):
        self.assertTrue(g.anonymous_answer(400, {'X-PickChick-Data': 'kiosk'}))
        self.assertTrue(g.anonymous_answer(401, {'X-PickChick-Data': 'kiosk'}))
        self.assertFalse(g.anonymous_answer(200, {'X-PickChick-Data': 'kiosk'}))
        self.assertFalse(g.anonymous_answer(404, {}))
        self.assertFalse(g.anonymous_answer(401, {}))

    def test_only_two_mount_sources_change(self):
        old = {'services': {'gateway': {'image': 'pinned', 'networks': ['roadmap', 'api'],
               'volumes': [{'target': '/etc/caddy/Caddyfile', 'source': '/old/config', 'read_only': True},
                           {'target': '/srv/public', 'source': '/old/public', 'read_only': True}]}}}
        snapshot = json.dumps(old)
        new = g.compose_candidate(old, '/new/config', '/new/public')
        self.assertEqual(json.dumps(old), snapshot)
        self.assertEqual({v['source'] for v in new['services']['gateway']['volumes']},
                         {'/new/config', '/new/public'})

    def test_the_api_route_exists_with_device_headers_only(self):
        controller = (ROOT/'services/api/src/kiosk-checkout-controller.ts').read_text()
        handler = controller[controller.index("@Post('staff/verify')"):]
        handler = handler[:handler.index('@Post(', 10)]
        self.assertIn("@Headers('x-kiosk-device')", handler)
        self.assertIn("@Headers('x-kiosk-key')", handler)
        self.assertNotIn("@Headers('authorization')", handler)


if __name__ == '__main__':
    unittest.main()
