#!/usr/bin/env python3
"""Read-only TLS/hash check of an explicitly supplied public-web manifest."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--base-url', default='https://pickchick.185.129.51.103.nip.io')
    args = parser.parse_args()
    base = args.base_url.rstrip('/')
    url = urllib.parse.urlsplit(base)
    assert url.scheme == 'https' and url.hostname and not url.path
    assert not url.username and not url.password and not url.query and not url.fragment
    manifest = json.loads(args.manifest.read_text())
    files = manifest['files']

    def check(item):
        path, wanted = item
        assert not path.startswith('/') and '..' not in path.split('/')
        uri = '/kiosk' if path == 'operations/index.html' else '/' + path.removeprefix('operations/')
        with urllib.request.urlopen(base + uri, timeout=30) as response:
            digest = hashlib.sha256()
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
            assert response.status == 200 and digest.hexdigest() == wanted, uri
            content_type = response.headers.get_content_type()
            if uri.endswith('.html') or uri == '/kiosk':
                assert content_type == 'text/html', uri
            elif uri.endswith('.css'):
                assert content_type == 'text/css', uri
            elif uri.endswith('.js'):
                assert content_type in ('text/javascript', 'application/javascript'), uri
        return uri

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        checked = list(pool.map(check, files.items()))
    for uri in ['/kitchen/prep', '/kitchen/assembly', '/display', '/manager']:
        with urllib.request.urlopen(base + uri, timeout=20) as response:
            assert response.headers.get_content_type() == 'text/html', uri
            assert hashlib.sha256(response.read()).hexdigest() == files['operations/index.html'], uri
    denied = ['/', '/.local/test-flow-staff', '/.release.json',
              '/design/prototype/provenance.json', '/docs/project-status.md', '/package.json']
    for uri in denied:
        try:
            with urllib.request.urlopen(base + uri, timeout=20):
                raise AssertionError(uri + ' is public')
        except urllib.error.HTTPError as error:
            assert error.code == 404, uri
    print(json.dumps({'event': 'public_static_manifest_verified',
                      'source_sha': manifest['source_sha'], 'runtime_files': len(checked),
                      'spa_paths': 5, 'private_static_denials': len(denied)}))


if __name__ == '__main__':
    main()
