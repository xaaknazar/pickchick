"""iPad design acceptance, using the real app and synthetic local API only."""
import json
import os
import unittest
from pathlib import Path
from urllib.request import urlopen
import browser_ui as base
from playwright.sync_api import expect, sync_playwright

class Design(base.KioskUI):
    def test_kazakh_resize_dialogs_and_added_feedback(self):
        page, fixture = self.open(834, 1194)
        self.start(page)
        self.add(page)
        expect(base.element(page, 'kiosk-cart-feedback')).to_have_text('Добавлено')
        base.element(page, 'kiosk-language-kk').click()
        base.capture(page, 'menu-kk-834.png')
        base.assert_no_overflow(page, 834)
        for category in ['combo', 'duo', 'sets', 'extras']:
            base.assert_bounded(page, 'kiosk-category-' + category, 834, 1194)
        page.set_viewport_size({'width': 1180, 'height': 820})
        base.assert_bounded(page, 'kiosk-menu-checkout', 1180, 820)
        base.assert_no_overflow(page, 1180)
        base.capture(page, 'menu-landscape-1180.png')
        base.element(page, 'kiosk-cancel-open').click()
        base.assert_bounded(page, 'kiosk-cancel-dismiss', 1180, 820)
        base.capture(page, 'cancel-kk-1180.png')
        base.element(page, 'kiosk-cancel-dismiss').click()
        base.screen(page, 'menu')
        self.assertEqual(len(fixture.orders), 0)

    def test_motion_follows_system_preference(self):
        page, fixture = self.open()
        self.start(page)
        page.emulate_media(reduced_motion='no-preference')
        self.add(page)
        expect(base.element(page, 'kiosk-cart-feedback')).to_have_text('Добавлено')
        button = base.element(page, 'kiosk-menu-checkout')
        box = button.bounding_box()
        page.mouse.move(box['x'] + 20, box['y'] + 20)
        page.mouse.down()
        page.wait_for_function('''() => {
            const button = document.querySelector('[data-testid="kiosk-menu-checkout"]');
            return new DOMMatrix(getComputedStyle(button.parentElement).transform).a < .99;
        }''')
        # A preference change must stop an already held press, not just prevent
        # animation on the next interaction.
        page.emulate_media(reduced_motion='reduce')
        page.wait_for_function('''() => {
            const button = document.querySelector('[data-testid="kiosk-menu-checkout"]');
            return new DOMMatrix(getComputedStyle(button.parentElement).transform).a === 1;
        }''')
        transform = button.evaluate('(e) => getComputedStyle(e.parentElement).transform')
        self.assertIn(transform, ['none', 'matrix(1, 0, 0, 1, 0, 0)'])
        page.mouse.move(1, 1)
        page.mouse.up()
        page.emulate_media(reduced_motion='no-preference')
        button.click()
        base.screen(page, 'upsell')
        recommendation = page.locator('[data-testid^="kiosk-recommendation-"]').first
        # Recommendation motion must settle promptly and keep the action usable.
        expect(recommendation).to_have_css('opacity', '1', timeout=1500)
        page.wait_for_function('''() => [...document.querySelectorAll(
            '[data-testid^="kiosk-recommendation-"]')].every(e =>
                new DOMMatrix(getComputedStyle(e).transform).m42 === 0)''', timeout=1500)
        base.assert_bounded(page, 'kiosk-upsell-continue', 820, 1180)
        self.assertEqual(len(fixture.orders), 0)

class Stories(unittest.TestCase):
    def test_every_story_renders_without_runtime_errors(self):
        url = os.environ.get('KIOSK_STORYBOOK_URL', 'http://127.0.0.1:6007')
        self.assertTrue(url.startswith('http://127.0.0.1:'))
        with urlopen(url + '/index.json') as response:
            entries = json.load(response)['entries']
        stories = [e for e in entries.values() if e['type'] == 'story']
        report = []
        axe_source = next(Path('node_modules/.pnpm').glob('axe-core@*/node_modules/axe-core/axe.min.js')).read_text()
        accessibility = []
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 820, 'height': 1180}, reduced_motion='reduce')
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            for story in stories:
                with self.subTest(story=story['id']):
                    errors.clear()
                    page.goto(url + '/iframe.html?id=' + story['id'] + '&viewMode=story')
                    page.wait_for_function("document.body.classList.contains('sb-show-main')")
                    expect(page.locator('.sb-errordisplay')).not_to_be_visible()
                    # Fonts load asynchronously inside the real provider. A
                    # Storybook shell alone must not pass as a rendered story.
                    expect(page.get_by_test_id('kiosk-story-content')).to_be_visible()
                    page.evaluate('document.fonts.ready')
                    self.assertEqual(errors, [])
                    page.add_script_tag(content=axe_source)
                    violations = page.evaluate('''async () => (await axe.run(document.getElementById('storybook-root'), {
                        runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']}
                    })).violations.map(v => ({id:v.id, impact:v.impact, nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))''')
                    if violations:
                        accessibility.append({'story':story['id'],'violations':violations})
                    report.append(story['id'])
            page.goto(url + '/iframe.html?id=kiosk-productcard--default&viewMode=story')
            expect(page.get_by_role('button', name='+ Pick Combo')).to_be_visible()
            base.capture(page, 'storybook-product-card.png')
            browser.close()
        (base.OUTPUT / 'storybook-verified.json').write_text(json.dumps(report, indent=2) + '\n')
        (base.OUTPUT / 'storybook-accessibility.json').write_text(json.dumps(accessibility, indent=2) + '\n')
        self.assertEqual(accessibility, [], 'See storybook-accessibility.json for actionable violations')

if __name__ == '__main__':
    # Existing scenario suite runs separately; do not silently repeat inherited cases.
    suite = unittest.TestSuite([Design('test_kazakh_resize_dialogs_and_added_feedback'),
                               Design('test_motion_follows_system_preference'),
                               Stories('test_every_story_renders_without_runtime_errors')])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
