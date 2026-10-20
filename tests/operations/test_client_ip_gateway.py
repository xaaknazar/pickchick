"""Client-IP gateway release (audit 19.10: 5.0 kitchen client header, 5.6 trusted proxy drift).

Static checks always run. The two-hop checks run the real pinned Caddy (CADDY_BIN, or `caddy`
on PATH; skipped otherwise) on loopback: client 127.0.0.20 -> outer Caddy -> transformed
gateway -> echo upstream. No Docker, VPS or live data.
"""
import http.client
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('client_ip_gateway', ROOT/'infra/public-staging/client-ip-gateway.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
FIXTURE = (ROOT/'tests/operations/fixtures/unified-menu-gateway-baseline.Caddyfile').read_text()


def network(*subnets):
    return [{'Name': 'deploy_default', 'IPAM': {'Config': [{'Subnet': s} for s in subnets]}}]


class StaticTests(unittest.TestCase):
    def test_only_trust_line_and_kitchen_header_change(self):
        new = g.candidate(FIXTURE, '172.18.0.0/16')
        self.assertIn('\t\ttrusted_proxies static 172.18.0.0/16\n', new)
        self.assertIn('\t\ttrusted_proxies_strict\n', new)
        self.assertIn('header_up X-PickChick-Client-IP {client_ip}', new)
        self.assertNotIn('{remote_host}', new)
        restored = new.replace('trusted_proxies static 172.18.0.0/16', 'trusted_proxies static 172.18.0.4')
        restored = restored.replace(g.CLIENT_NEW, g.CLIENT_OLD)
        self.assertEqual(restored, FIXTURE)
        with self.assertRaises(g.GuardFailure):
            g.candidate(new, '172.18.0.0/16')
        # A later, already-trusted subnet still gets the kitchen header fixed.
        partial = FIXTURE.replace('static 172.18.0.4', 'static 172.18.0.0/16')
        self.assertEqual(g.candidate(partial, '172.18.0.0/16'), new)

    def test_refuses_unrecognised_or_broad_shapes(self):
        for bad in (FIXTURE.replace('\t\ttrusted_proxies_strict\n', ''),
                    FIXTURE.replace('trusted_proxies static 172.18.0.4',
                                    'trusted_proxies static 172.18.0.4\n\t\ttrusted_proxies static 10.0.0.1'),
                    FIXTURE.replace('static 172.18.0.4', 'static private_ranges')):
            with self.assertRaises(g.GuardFailure):
                g.candidate(bad, '172.18.0.0/16')
        for subnet in ('0.0.0.0/0', '172.0.0.0/8', '8.8.8.0/24'):
            with self.assertRaises(g.GuardFailure):
                g.candidate(FIXTURE, subnet)
        with self.assertRaises(g.GuardFailure):
            g.candidate(FIXTURE + '\n# reverse_proxy x { header_up X-Real-IP {remote_host} }\n',
                        '172.18.0.0/16')

    def test_ingress_subnet_fails_closed(self):
        self.assertEqual(g.ingress_subnet(network('172.18.0.0/16'), '172.18.0.9'), '172.18.0.0/16')
        self.assertEqual(g.ingress_subnet(network('172.18.0.0/16', 'fd00:1::/64'), '172.18.0.9'),
                         '172.18.0.0/16')
        for inspect, outer in ((network('172.18.0.0/16'), '172.19.0.2'),
                               (network('172.18.0.0/16'), ''),
                               (network('172.18.0.0/16', '172.19.0.0/16'), '172.18.0.2'),
                               (network('10.0.0.0/8'), '10.0.0.2'),
                               (network('203.0.113.0/24'), '203.0.113.2'),
                               (network('8.8.8.0/24'), '8.8.8.2'),
                               (network(), '172.18.0.2'),
                               (network('172.18.0.0/16') * 2, '172.18.0.2')):
            with self.assertRaises(g.GuardFailure):
                g.ingress_subnet(inspect, outer)

    def test_check_flags_drift_and_proxy_hop_header(self):
        self.assertEqual(g.check(FIXTURE, '172.18.0.4')['problems'], ['kitchen_route_forwards_proxy_hop'])
        fixed = g.candidate(FIXTURE, '172.18.0.0/16')
        self.assertTrue(g.check(fixed, '172.18.0.4')['ok'])
        self.assertTrue(g.check(fixed, '172.18.0.200')['ok'])
        # The original single-IP rule after Docker gives the outer Caddy another address.
        drift = g.check(FIXTURE.replace(g.CLIENT_OLD, g.CLIENT_NEW), '172.18.0.200')
        self.assertEqual(drift['problems'], ['outer_proxy_not_trusted'])
        self.assertEqual(g.check(fixed, '')['problems'], ['outer_proxy_address_unknown'])


CADDY = os.environ.get('CADDY_BIN') or shutil.which('caddy')


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Echo(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({'client': self.headers.get('X-PickChick-Client-IP'),
                           'forwarded': self.headers.get('X-Forwarded-For')}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@unittest.skipUnless(CADDY, 'caddy binary not available')
class TwoHopTests(unittest.TestCase):
    """client 127.0.0.20 -> outer :A (peer of inner is 127.0.0.1) -> inner gateway :B -> echo."""

    @classmethod
    def setUpClass(cls):
        cls.echo = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Echo)
        threading.Thread(target=cls.echo.serve_forever, daemon=True).start()
        cls.directory = tempfile.TemporaryDirectory(prefix='pickchick-client-ip-')
        cls.processes = []

    @classmethod
    def tearDownClass(cls):
        for process in cls.processes:
            process.terminate()
            process.wait(10)
        cls.echo.shutdown()
        cls.directory.cleanup()

    def start(self, name, text, port):
        path = Path(self.directory.name)/name
        path.write_text(text)
        env = {**os.environ, 'XDG_DATA_HOME': self.directory.name, 'XDG_CONFIG_HOME': self.directory.name}
        process = subprocess.Popen([CADDY, 'run', '--config', str(path), '--adapter', 'caddyfile'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        self.processes.append(process)
        deadline = time.monotonic() + 15
        while True:
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                    return process
            except OSError:
                if time.monotonic() > deadline:
                    raise RuntimeError('caddy did not start')
                time.sleep(0.1)

    def chain(self, gateway_text):
        inner, outer = free_port(), free_port()
        text = gateway_text.replace(':8080 {', ':%d {' % inner, 1)
        text = text.replace('pickchick-kitchen-portal:4193', '127.0.0.1:%d' % self.echo.server_port)
        self.start('inner-%d' % inner, text, inner)
        self.start('outer-%d' % outer, '{\n\tadmin off\n\tauto_https off\n\tpersist_config off\n}\n'
                   ':%d {\n\treverse_proxy 127.0.0.1:%d\n}\n' % (outer, inner), outer)
        return outer, inner

    def seen(self, port, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10,
                                                source_address=('127.0.0.20', 0))
        connection.request('GET', '/kitchen-live/health', headers=headers or {})
        response = connection.getresponse()
        body = response.read()
        connection.close()
        self.assertEqual(response.status, 200)
        return json.loads(body)

    def test_drifted_single_ip_collapses_clients_and_the_subnet_rule_does_not(self):
        # Before: trusted IP no longer matches the outer proxy; kitchen sees the proxy hop.
        stale = FIXTURE.replace('static 172.18.0.4', 'static 127.0.0.3')
        outer, _ = self.chain(stale)
        self.assertEqual(self.seen(outer)['client'], '127.0.0.1')
        # After: the release's candidate trusts the ingress subnet and forwards {client_ip}.
        outer, inner = self.chain(g.candidate(stale, '127.0.0.0/29'))
        self.assertEqual(self.seen(outer, {'X-Forwarded-For': '198.51.100.1'})['client'], '127.0.0.20')
        # A client outside the trusted subnet that reaches the gateway cannot name another client.
        self.assertEqual(self.seen(inner, {'X-Forwarded-For': '198.51.100.1'})['client'], '127.0.0.20')


if __name__ == '__main__':
    unittest.main()
