"""Local Storybook only: a published (remote) photo is shown first and falls back offline.

The remote media origin is never contacted: Playwright either fulfils the media request with a
bundled kiosk photo or aborts it (offline). No server menu or order is changed.
"""
import os
import re
import unittest
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
REMOTE = re.compile(r'^https://[^/]+/v1/media/catalog/[a-f0-9]{64}\.card\.webp$')
STORY = 'kiosk-photoimage--remote-offline-falls-back'


class RemotePhotos(unittest.TestCase):
    def run_story(self, online):
        url = os.environ.get('KIOSK_STORYBOOK_URL', 'http://127.0.0.1:6009')
        self.assertEqual(urlparse(url).hostname, '127.0.0.1')
        body = (ROOT / 'apps/kiosk/assets/v3/photos/burger.webp').read_bytes()
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={'width': 820, 'height': 1180}, reduced_motion='reduce')
            errors, remote, external = [], [], []
            page.on('pageerror', lambda error: errors.append(str(error)))

            def route(request):
                target = request.request.url
                if urlparse(target).hostname == '127.0.0.1':
                    request.continue_()
                elif REMOTE.match(target):
                    remote.append(target)
                    if online:
                        request.fulfill(status=200, body=body, headers={'content-type': 'image/webp', 'access-control-allow-origin': '*'})
                    else:
                        request.abort()
                else:
                    external.append(target)
                    request.abort()

            page.route('**/*', route)
            page.goto(url + '/iframe.html?id=' + STORY + '&viewMode=story&globals=a11y.manual:!true')
            photo = page.get_by_test_id('kiosk-photo-card-media:story-offline-photo')
            expect(photo).to_be_visible()
            image = photo.locator('img')
            if online:
                expect(image).to_have_attribute('src', REMOTE)
            else:
                expect(image).to_have_attribute('src', re.compile(r'/pick-combo-[^/]+\.webp$'))
            page.wait_for_function('[...document.images].every(i => i.complete && i.naturalWidth > 0)')
            self.assertGreaterEqual(len(remote), 1)
            self.assertEqual(external, [])
            self.assertEqual(errors, [])
            browser.close()

    def test_remote_photo_is_shown_first(self):
        self.run_story(online=True)

    def test_offline_remote_photo_falls_back_to_bundled(self):
        self.run_story(online=False)


if __name__ == '__main__':
    unittest.main(verbosity=2)
