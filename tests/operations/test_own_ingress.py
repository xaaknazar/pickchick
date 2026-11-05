import copy
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('plan', ROOT / 'infra/ingress/plan.py')
p = importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
sys.modules['plan'] = p
spec = importlib.util.spec_from_file_location('own_ingress_switch', ROOT / 'infra/ingress/switch.py')
s = importlib.util.module_from_spec(spec);spec.loader.exec_module(s)


class OwnIngress(unittest.TestCase):
    def test_sites_preserved_without_legacy(self):
        body = (ROOT / 'infra/ingress/Caddyfile').read_bytes()
        raw = b'legacy.test {\n respond 200\n}\n\n' + body
        self.assertEqual(p.sites(raw, p.digest(raw)), body)
        self.assertEqual(body, (ROOT / 'infra/pickchick-ingress/sites.Caddyfile').read_bytes())
        for changed in [raw + b' ', raw.replace(b'32s', b'31s'), body, body + body]:
            with self.assertRaises(ValueError):p.sites(changed, p.digest(changed))
        with self.assertRaises(ValueError):p.sites(raw, '0' * 64)

    def test_single_address_trust_only(self):
        raw = (b'{\n\tservers {\n\t\ttrusted_proxies static 172.18.0.0/16\n'
               b'\t\ttrusted_proxies_strict\n\t}\n}\n'
               b'header_up X-PickChick-Client-IP {client_ip}\n')
        result = p.gateway(raw, p.digest(raw))
        self.assertEqual(result.replace(p.ADDRESS.encode(), b'172.18.0.0/16'), raw)
        for bad in [raw.replace(b'172.18.0.0/16', b'private_ranges'),
                    raw.replace(b'{client_ip}', b'{remote_host}'),
                    raw.replace(b'\t\ttrusted_proxies_strict\n', b''), raw + raw]:
            with self.assertRaises(ValueError):p.gateway(bad, p.digest(bad))

    def test_network_collisions_and_repeat_refused(self):
        p.subnet_guard([{'Name': 'old', 'IPAM': {'Config': [{'Subnet': '172.18.0.0/16'}]}}])
        for subnet in ['10.240.0.0/16', '10.240.17.0/28', '10.240.17.0/29']:
            with self.assertRaises(ValueError):
                p.subnet_guard([{'Name': 'other', 'IPAM': {'Config': [{'Subnet': subnet}]}}])
        with self.assertRaises(ValueError):p.subnet_guard([{'Name': p.NETWORK}])

    def test_gateway_compose_preserves_every_other_value(self):
        before = {'name': 'pickchick-public', 'services': {'gateway': {
            'container_name': 'pickchick-public-gateway', 'image': 'pinned',
            'environment': {'EXAMPLE': 'unchanged'}, 'networks': {'old': None},
            'volumes': [{'source': '/old', 'target': '/etc/caddy/Caddyfile', 'read_only': True},
                        {'source': '/web', 'target': '/srv/public', 'read_only': True}]}},
            'networks': {'old': {'external': True}}}
        untouched = copy.deepcopy(before)
        after = p.gateway_compose(before, '/new')
        self.assertEqual(before, untouched)
        del after['networks'][p.NETWORK]
        del after['services']['gateway']['networks'][p.NETWORK]
        after['services']['gateway']['volumes'][0]['source'] = '/old'
        self.assertEqual(after, before)

    def test_certificates_only_owned_hosts_and_acme(self):
        good = [f'caddy/certificates/issuer/{h}/{h}.{ext}' for h in p.HOSTS for ext in ['crt', 'key']]
        good += ['caddy/acme/issuer/users/default/account.key']
        p.tls_guard(good)
        for bad in ['caddy/certificates/issuer/legacy.test/legacy.test.key',
                    '../secret', '/absolute', 'caddy/autosave.json',
                    'caddy/certificates/issuer/pickchick.kz/../other']:
            self.assertFalse(p.tls_allowed(bad))
            with self.assertRaises(ValueError):p.tls_guard(good + [bad])
        with self.assertRaises(ValueError):p.tls_guard(good[:-1])
        with self.assertRaises(ValueError):p.tls_guard(good[1:])

    def test_separate_window_and_launch_freeze(self):
        p.window(datetime(2026, 11, 7, 20, 10, tzinfo=timezone.utc), '2026-11-08')
        for day, hour, minute in [(5,20,10),(7,20,40),(7,21,0),(14,20,10),(17,20,10)]:
            now = datetime(2026,11,day,hour,minute,tzinfo=timezone.utc)
            from zoneinfo import ZoneInfo
            with self.assertRaises(ValueError):p.window(now, now.astimezone(ZoneInfo('Asia/Almaty')).date().isoformat())

    def test_rollback_attempts_all_actions_after_failure(self):
        for fail in [None, 'stop', 'gateway', 'start']:
            calls = []
            def action(name):
                def call():
                    calls.append(name)
                    if name == fail:raise RuntimeError('synthetic')
                return call
            if fail:
                with self.assertRaises(ValueError):s.rollback(action('start'), action('gateway'), action('stop'))
            else:s.rollback(action('start'), action('gateway'), action('stop'))
            self.assertEqual(calls, ['stop', 'gateway', 'start'])
        times = iter([0, 61])
        with self.assertRaises(ValueError):s.rollback(lambda: None, lambda: None, lambda: None, lambda: next(times))

    def test_container_profile(self):
        text = (ROOT / 'infra/ingress/compose.yaml').read_text()
        self.assertIn(p.IMAGE, text)
        for value in ['cap_drop: [ALL]', 'cap_add: [NET_BIND_SERVICE]', 'read_only: true',
                      'external: true', 'pull_policy: never', p.ADDRESS, p.NETWORK]:
            self.assertIn(value, text)
        self.assertNotIn('deploy_default', text)
        self.assertNotIn('privileged:', text)


if __name__ == '__main__':unittest.main()
