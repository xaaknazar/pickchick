"""Catalog photo routes on the public gateway (cloud049, CATALOG_MEDIA_UPLOAD_ENABLED).

The static checks always run. The behavioural checks run the real Caddyfile with a local
`caddy` binary (CADDY_BIN, or `caddy` on PATH) against a loopback fake upstream, and are
skipped when no binary is available. Nothing here touches Docker or a live host.
"""
import http.server
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GATEWAY = ROOT / 'infra/public-staging/gateway.Caddyfile'
UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
BRANCH = '40000000-0000-4000-8000-000000000001'
SHA = 'ab' * 32
MISSING = 'cd' * 32


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Upstream(http.server.BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *args):
        pass

    def reply(self):
        try:
            self.answer()
        except (BrokenPipeError, ConnectionResetError):
            pass  # the gateway aborted an oversized upload

    def answer(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else b''
        Upstream.seen.append({
            'method': self.command, 'path': self.path, 'bytes': len(body),
            'authorization': self.headers.get('Authorization'),
            'cookie': self.headers.get('Cookie'), 'device': self.headers.get('X-Device-Id'),
        })
        if self.path.startswith('/v1/media/catalog/'):
            found = self.path.startswith('/v1/media/catalog/' + SHA)
            self.send_response(200 if found else 404)
            # Errors carry no cache header here: the gateway itself must add no-store.
            if found:
                self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
            self.send_header('Content-Type', 'image/webp' if found else 'application/json')
            payload = b'RIFF\x00\x00\x00\x00WEBPVP8 ' if found else b'{"code":"NOT_FOUND"}'
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(payload)
            return
        payload = json.dumps(Upstream.seen[-1]).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = do_POST = do_PUT = do_HEAD = reply


class CatalogMediaGatewayStatic(unittest.TestCase):
    def test_routes_are_scoped_and_keep_the_default_cap(self):
        text = GATEWAY.read_text()
        self.assertIn('path_regexp catalog_media ^/v1/media/catalog/[a-f0-9]{64}(\\.(card|hero|thumb))?\\.webp$', text)
        self.assertIn(f'path_regexp catalog_asset_upload ^/v1/admin/catalog/branches/{UUID}/assets$', text)
        self.assertIn('max_size 10MiB', text)
        self.assertIn('max_size 16KB', text)
        media = text[text.index('handle @catalog_media {'):]
        media = media[:media.index('\n\t}\n')]
        for header in ('-Authorization', '-Cookie', '-X-Device-Id'):
            self.assertIn('header_up ' + header, media)
        self.assertIn('>Cache-Control "public, max-age=31536000, immutable"', media)
        self.assertIn('match status 200 304', media)
        self.assertIn('match status 4xx 5xx', media)
        self.assertIn('header @no_store >Cache-Control no-store', text)
        matcher = text[text.index('@catalog_media {'):]
        self.assertIn('method GET HEAD', matcher[:matcher.index('}')])
        # Only the private API port serves the edge download; the gateway never routes it.
        self.assertNotIn('/internal/', text)
        self.assertTrue(text.rstrip().endswith('respond `{"code":"NOT_FOUND","environment":"staging"}` 404\n\t}\n}'.rstrip()))


CADDY = os.environ.get('CADDY_BIN') or shutil.which('caddy')


@unittest.skipUnless(CADDY, 'caddy binary not available')
class CatalogMediaGatewayLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        cls.port = free_port()
        cls.directory = tempfile.TemporaryDirectory(prefix='pickchick-media-gateway-')
        config = GATEWAY.read_text()
        config = config.replace('pickchick-staging-api-1:3100', '127.0.0.1:%d' % cls.upstream.server_port)
        config = config.replace(':8080 {', ':%d {' % cls.port, 1)
        path = Path(cls.directory.name) / 'Caddyfile'
        path.write_text(config)
        cls.caddy = subprocess.Popen(
            [CADDY, 'run', '--config', str(path), '--adapter', 'caddyfile'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 15
        while True:
            try:
                if cls.request('/health/live')[0] == 200:
                    break
            except OSError:
                pass
            if time.monotonic() > deadline:
                raise RuntimeError('caddy did not start')
            time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.caddy.terminate()
        cls.caddy.wait(10)
        cls.upstream.shutdown()
        cls.directory.cleanup()

    @classmethod
    def request(cls, path, method='GET', body=None, headers=None):
        req = urllib.request.Request('http://127.0.0.1:%d%s' % (cls.port, path), data=body,
                                     method=method, headers=headers or {})
        try:
            result = urllib.request.urlopen(req, timeout=20)
        except urllib.error.HTTPError as error:
            result = error
        return result.status, result.headers, result.read()

    def test_media_is_immutable_only_on_success_and_never_forwards_credentials(self):
        secrets = {'Authorization': 'Bearer ' + 'a' * 64, 'Cookie': 'session=1', 'X-Device-Id': BRANCH}
        for path in ('/v1/media/catalog/%s.card.webp' % SHA, '/v1/media/catalog/%s.webp' % SHA):
            status, headers, body = self.request(path, headers=secrets)
            self.assertEqual(status, 200)
            self.assertEqual(headers.get_all('Cache-Control'), ['public, max-age=31536000, immutable'])
            self.assertEqual(headers.get('Content-Type'), 'image/webp')
            self.assertTrue(body.startswith(b'RIFF'))
            seen = Upstream.seen[-1]
            self.assertEqual((seen['authorization'], seen['cookie'], seen['device']), (None, None, None))
        status, headers, _ = self.request('/v1/media/catalog/%s.card.webp' % SHA, 'HEAD')
        self.assertEqual(status, 200)
        self.assertEqual(headers.get_all('Cache-Control'), ['public, max-age=31536000, immutable'])
        status, headers, _ = self.request('/v1/media/catalog/%s.card.webp' % MISSING)
        self.assertEqual(status, 404)
        self.assertEqual(headers.get_all('Cache-Control'), ['no-store'])
        # Everything else stays no-store, proxied or answered by the gateway itself.
        for path in ('/v1/admin/catalog/branches', '/health/live', '/v1/unknown'):
            self.assertEqual(self.request(path)[1].get_all('Cache-Control'), ['no-store'], path)
        count = len(Upstream.seen)
        for method, path in [
            ('POST', '/v1/media/catalog/%s.card.webp' % SHA),
            ('PUT', '/v1/media/catalog/%s.card.webp' % SHA),
            ('GET', '/v1/media/catalog/%s.card.webp' % SHA.upper()),
            ('GET', '/v1/media/catalog/%s.original.webp' % SHA),
            ('GET', '/v1/media/catalog/%s.card.png' % SHA),
            ('GET', '/v1/media/catalog/%s.card.webp/x' % SHA),
            ('GET', '/internal/v1/edge/media/%s.card.webp' % SHA),
        ]:
            status, headers, body = self.request(path, method, b'' if method in ('POST', 'PUT') else None)
            self.assertEqual(status, 404, path)
            self.assertEqual(headers.get_all('Cache-Control'), ['no-store'], path)
            self.assertEqual(json.loads(body)['code'], 'NOT_FOUND')
        self.assertEqual(len(Upstream.seen), count, 'blocked requests must not reach the API')

    def test_upload_route_alone_accepts_ten_mebibytes(self):
        upload = '/v1/admin/catalog/branches/%s/assets' % BRANCH
        headers = {'Authorization': 'Bearer ' + 'b' * 64, 'Cookie': 'session=1',
                   'X-Device-Id': BRANCH, 'Content-Type': 'image/jpeg',
                   'Idempotency-Key': '50000000-0000-4000-8000-000000000001'}
        status, _, body = self.request(upload, 'POST', b'\xff\xd8\xff' + b'\x00' * (5 * 1024 * 1024), headers)
        self.assertEqual(status, 200)
        seen = json.loads(body)
        self.assertEqual(seen['bytes'], 5 * 1024 * 1024 + 3)
        self.assertEqual(seen['authorization'], headers['Authorization'])
        self.assertEqual((seen['cookie'], seen['device']), (None, None))
        status, _, _ = self.request(upload, 'POST', b'\x00' * (10 * 1024 * 1024 + 1), headers)
        self.assertEqual(status, 413)
        status, _, body = self.request(upload, headers={'Authorization': headers['Authorization']})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['method'], 'GET')
        # Every other route keeps the 16 KB cap, including the neighbouring catalog commands.
        publish = '/v1/admin/catalog/branches/%s/publish' % BRANCH
        self.assertEqual(self.request(publish, 'POST', b'x' * (17 * 1024), {'Content-Type': 'application/json'})[0], 413)
        self.assertEqual(self.request(upload + '/x', 'POST', b'x', headers)[0], 404)
        self.assertEqual(self.request(upload, 'PUT', b'x', headers)[0], 404)


if __name__ == '__main__':
    unittest.main()
