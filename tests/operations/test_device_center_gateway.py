import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('gateway', ROOT/'infra/public-staging/device-center-gateway.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)


class GatewayTests(unittest.TestCase):
    def test_only_presence_block_added_and_repeat_rejected(self):
        source = (ROOT/'infra/domains/device-center.Caddyfile').read_text()
        block = g.START + source.split(g.START)[1].split(g.END)[0] + g.END
        old = (ROOT/'infra/public-staging/gateway.Caddyfile').read_text() + '\n# unrelated installed kiosk route\n'
        new = g.candidate(old, source)
        self.assertEqual(new.replace(block+'\n', ''), old)
        self.assertIn('header_up -Authorization', block)
        self.assertNotIn('header_up -X-Kiosk', block)
        with self.assertRaises(RuntimeError):
            g.candidate(new, source)
        with self.assertRaises(RuntimeError):
            g.candidate(old.replace('@backoffice_get {', '@different {'), source)

    def test_only_two_mount_sources_change(self):
        old = {'services': {'gateway': {'image': 'pinned', 'networks': ['roadmap', 'api'],
               'volumes': [{'target': '/etc/caddy/Caddyfile', 'source': '/old/config', 'read_only': True},
                           {'target': '/srv/public', 'source': '/old/public', 'read_only': True}]}},
               'networks': {'roadmap': {'external': True}}}
        snapshot = json.dumps(old)
        new = g.compose_candidate(old, '/new/config', '/new/public')
        self.assertEqual(json.dumps(old), snapshot)
        new['services']['gateway']['volumes'] = old['services']['gateway']['volumes']
        self.assertEqual(new, old)
        old['services']['other'] = {}
        with self.assertRaises(RuntimeError):
            g.compose_candidate(old, '/new/config', '/new/public')


if __name__ == '__main__':
    unittest.main()
