"""Legal documents use extensionless gateway URLs; their bytes must still match."""
import hashlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'roadmap_deploy', Path(__file__).with_name('remote-deploy.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class PublicAssets(unittest.TestCase):
    def verify(self, name, path, expected=None):
        body = b'published bytes'
        response = io.BytesIO(body)
        response.status = 200
        with patch.object(release.urllib.request, 'urlopen', return_value=response) as request:
            release.verify_public_asset((name, expected or hashlib.sha256(body).hexdigest()))
            self.assertEqual(request.call_args.args[0].full_url, release.ORIGIN + path)

    def test_legal_extensionless_routes(self):
        for page in ('terms', 'privacy'):
            with self.subTest(page=page):
                self.verify('legal/' + page + '.html', '/legal/' + page)

    def test_operations_routes_preserved(self):
        self.verify('operations/index.html', '/kiosk')
        self.verify('operations/assets/app.js', '/assets/app.js')

    def test_other_html_routes_unchanged(self):
        self.verify('other/page.html', '/other/page.html')

    def test_legal_hash_mismatch_still_blocks_release(self):
        with self.assertRaisesRegex(RuntimeError, 'public HTTP asset changed'):
            self.verify('legal/privacy.html', '/legal/privacy', '0' * 64)


if __name__ == '__main__':
    unittest.main()
