"""Local Storybook only: image loading and real Piko selection/cart presentation.

Uses a prepared, unpublished catalog fixture. No server menu or order is changed.
"""
import json
import os
import re
import unittest
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright


class DrinkPhotos(unittest.TestCase):
    def test_images_and_flavors_on_ipad(self):
        url = os.environ.get('KIOSK_STORYBOOK_URL', 'http://127.0.0.1:6009')
        self.assertEqual(urlparse(url).hostname, '127.0.0.1')
        output = Path(os.environ.get('KIOSK_PHOTO_OUTPUT', '.local/drink-photo-browser'))
        output.mkdir(parents=True, exist_ok=True)
        results = []
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for width, height in [(768, 1024), (820, 1180), (1024, 1366)]:
                page = browser.new_page(viewport={'width': width, 'height': height}, reduced_motion='reduce')
                errors, external = [], []
                page.on('pageerror', lambda error: errors.append(str(error)))

                def route(request):
                    if urlparse(request.request.url).hostname == '127.0.0.1':
                        request.continue_()
                    else:
                        external.append(request.request.url)
                        request.abort()

                page.route('**/*', route)

                def story(story_id):
                    page.goto(url + '/iframe.html?id=' + story_id + '&viewMode=story&globals=a11y.manual:!true')
                    expect(page.get_by_test_id('kiosk-story-content')).to_be_visible()
                    page.wait_for_function('document.images.length > 0 && [...document.images].every(i => i.complete && i.naturalWidth > 0)')
                    self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), width)

                story('kiosk-modifieroptions--piko-flavors')
                apple = page.get_by_test_id('kiosk-modifier-piko-flavor-piko-apple')
                orange = page.get_by_test_id('kiosk-modifier-piko-flavor-piko-orange')
                expect(apple).to_have_attribute('aria-checked', 'true')
                cart = page.locator('[data-testid^="kiosk-cart-line-"]').filter(has=page.get_by_role('button', name='Убрать', exact=True))
                expect(cart).to_have_count(1)
                before_id = cart.get_attribute('data-testid')
                expect(cart.get_by_text('Piko Яблоко 0.2 л', exact=False)).to_be_visible()
                expect(cart.get_by_text('590 ₸', exact=True)).to_be_visible()
                expect(cart.get_by_test_id('kiosk-photo-card-drink:piko-apple')).to_be_visible()
                orange.click()
                expect(orange).to_have_attribute('aria-checked', 'true')
                expect(apple).to_have_attribute('aria-checked', 'false')
                expect(cart.get_by_text('Piko Апельсин 0.2 л', exact=False)).to_be_visible()
                expect(cart.get_by_text('590 ₸', exact=True)).to_be_visible()
                expect(cart.get_by_test_id('kiosk-photo-card-drink:piko-orange')).to_be_visible()
                expect(cart.get_by_test_id('kiosk-photo-card-drink:piko-orange').locator('img')).to_have_attribute('src', re.compile(r'/piko-orange-[^/]+\.png$'))
                page.wait_for_function('[...document.images].every(i => i.complete && i.naturalWidth > 0)')
                self.assertNotEqual(before_id, cart.get_attribute('data-testid'))
                for option in [apple, orange]:
                    rect = option.bounding_box()
                    self.assertGreaterEqual(rect['height'], 48)
                    self.assertGreaterEqual(rect['x'], 0)
                    self.assertLessEqual(rect['x'] + rect['width'], width)
                page.screenshot(path=str(output / f'piko-{width}.png'), full_page=True)
                story('kiosk-modifieroptions--combo-with-piko-flavors')
                for drink in ['fuse-peach', 'fuse-mango', 'water', 'sprite', 'fanta', 'cola-bottle', 'cola-zero', 'piko-apple', 'piko-orange']:
                    option = page.get_by_test_id('kiosk-modifier-drink-' + drink)
                    expect(option).to_have_count(1)
                    expect(option.get_by_test_id('kiosk-photo-option-' + drink)).to_have_count(1)
                    rect = option.bounding_box()
                    self.assertGreaterEqual(rect['x'], 0)
                    self.assertLessEqual(rect['x'] + rect['width'], width)
                page.screenshot(path=str(output / f'combo-{width}.png'), full_page=True)
                if width == 820:
                    for name in ['peach', 'water', 'cola-bottle', 'cola-can', 'cola-zero', 'sprite', 'fanta', 'mango-chamomile', 'piko-apple', 'piko-orange', 'piko-both-flavors']:
                        story('kiosk-productartwork--' + name)
                    story('kiosk-productartwork--peach')
                    page.screenshot(path=str(output / 'peach-820.png'))
                self.assertEqual(errors, [])
                self.assertEqual(external, [])
                results.append({'width': width, 'height': height, 'flavor_selection': True, 'distinct_cart_identity': True, 'price_unchanged': True, 'images_loaded': True, 'errors': errors})
                page.close()
            browser.close()
        (output / 'result.json').write_text(json.dumps({'synthetic_catalog': True, 'checks': results}, indent=2) + '\n')


if __name__ == '__main__':
    unittest.main(verbosity=2)
