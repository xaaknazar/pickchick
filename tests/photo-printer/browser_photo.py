"""Real kiosk UI + synthetic camera, isolated ordering fixtures. No restaurant requests."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'kiosk'))
import browser_ui as ui
from playwright.sync_api import expect

ui.OUTPUT = Path('.local/photo-browser')

def capture(page, filename):
    # One capture per fresh browser process isolates permission and camera state.
    # Wait for actual fonts, images and video; do not alter rendered UI or hide content.
    page.evaluate('() => document.fonts.ready')
    page.wait_for_function("""() => [...document.images].filter(i => {
        const r=i.getBoundingClientRect(); return r.width>0 && r.height>0 && r.top<innerHeight && r.bottom>0;
    }).every(i => i.complete && i.naturalWidth>0)""")
    # Allow the modal transition to settle after the real readiness checks above.
    page.wait_for_timeout(1000)
    page.screenshot(path=str(ui.OUTPUT / filename), full_page=True)

class PhotoUI(ui.KioskUI):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.browser.close()
        cls.browser = cls.playwright.chromium.launch(headless=True, args=['--disable-gpu', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'])

    def test_alex_motion_and_fixed_menu_space(self):
        page,fixture=self.open()
        self.start(page)
        alex=ui.element(page,'photo-alex')
        bounds=ui.element(page,'photo-open').bounding_box()
        checkout=ui.element(page,'kiosk-menu-checkout').bounding_box()
        self.assertLessEqual(bounds['y']+bounds['height'],checkout['y'])
        get_pose=lambda: alex.evaluate('(e) => getComputedStyle(e).transform')
        still=get_pose()
        page.wait_for_timeout(700)
        self.assertEqual(get_pose(),still)
        page.emulate_media(reduced_motion='no-preference')
        page.wait_for_timeout(2250)
        self.assertNotEqual(get_pose(),still)
        self.assertEqual(ui.element(page,'photo-open').bounding_box(),bounds)
        page.emulate_media(reduced_motion='reduce')
        page.wait_for_timeout(100)
        self.assertEqual(get_pose(),still)
        self.assertEqual(len(fixture.orders),0)

    def test_photo_starts_from_menu_and_preserves_cart(self):
        for width,height in [(1024,1366),(820,1180),(744,1133),(1180,820)]:
            with self.subTest(size=(width,height)):
                page,fixture=self.open(width,height)
                page.context.grant_permissions(['camera'])
                ui.screen(page,'welcome')
                expect(ui.element(page,'photo-open')).to_have_count(0)
                self.start(page)
                self.add(page)
                ui.assert_bounded(page,'photo-open',width,height)
                before=ui.stored(page,ui.FLOW_KEY)
                ui.element(page,'photo-open').click()
                ui.assert_bounded(page,'photo-close',width,height)
                expect(ui.element(page,'photo-start')).to_have_count(0)
                expect(ui.element(page,'photo-capture')).to_be_enabled(timeout=15000)
                ui.assert_bounded(page,'photo-capture',width,height)
                page.wait_for_function("() => { const v=document.querySelector('[data-testid=photo-camera-frame] video'); return v && v.readyState>=2 && v.currentTime>0; }")
                ui.element(page,'photo-capture').click()
                expect(ui.element(page,'photo-preview')).to_be_visible(timeout=12000)
                ui.assert_bounded(page,'photo-print',width,height)
                ui.assert_bounded(page,'photo-retake',width,height)
                expect(ui.element(page,'photo-print')).to_be_disabled()
                expect(ui.element(page,'photo-camera-frame')).to_have_count(0)
                self.assertEqual(ui.stored(page,ui.FLOW_KEY),before)
                ui.element(page,'photo-retake').click()
                expect(ui.element(page,'photo-capture')).to_be_enabled(timeout=12000)
                ui.element(page,'photo-close').click()
                ui.screen(page,'menu')
                expect(ui.element(page,'photo-camera-frame')).to_have_count(0)
                expect(ui.element(page,'photo-open')).to_be_visible()
                self.assertEqual(ui.stored(page,ui.FLOW_KEY),before)
                ui.element(page,'photo-open').click()
                expect(ui.element(page,'photo-preview')).to_have_count(0)
                expect(ui.element(page,'photo-capture')).to_be_enabled(timeout=15000)
                ui.element(page,'photo-close').click()
                ui.screen(page,'menu')
                expect(ui.element(page,'kiosk-menu-checkout')).to_be_enabled()
                self.assertEqual(ui.stored(page,ui.FLOW_KEY),before)
                self.assertEqual(len(fixture.orders),0)

    def test_visual_states_in_fresh_contexts(self):
        for width,height in [(1024,1366),(820,1180),(744,1133),(1180,820)]:
            for state in ['menu','camera','preview']:
                with self.subTest(size=(width,height),state=state):
                    previous_browser=self.browser
                    self.browser=self.playwright.chromium.launch(headless=True,args=['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
                    self.addCleanup(self.browser.close)
                    page,fixture=self.open(width,height)
                    page.context.grant_permissions(['camera'])
                    ui.screen(page,'welcome')
                    self.start(page)
                    if state!='menu':
                        ui.element(page,'photo-open').click()
                        ui.assert_bounded(page,'photo-close',width,height)
                        expect(ui.element(page,'photo-capture')).to_be_enabled(timeout=15000)
                        page.wait_for_function("() => {const v=document.querySelector('[data-testid=photo-camera-frame] video');return v&&v.readyState>=2&&v.currentTime>0;}")
                        if state=='preview':
                            ui.element(page,'photo-capture').click()
                            expect(ui.element(page,'photo-preview')).to_be_visible(timeout=12000)
                        expect(ui.element(page,'photo-close')).to_be_visible()
                    capture(page,f'photo-{state}-{width}.png')
                    page.context.close()
                    self.browser.close()
                    self.browser=previous_browser

    def test_idle_clears_photo_and_returns_to_menu(self):
        page,fixture=self.open();page.context.grant_permissions(['camera']);self.start(page)
        ui.element(page,'photo-open').click()
        expect(ui.element(page,'photo-capture')).to_be_enabled(timeout=15000)
        ui.element(page,'photo-capture').click()
        expect(ui.element(page,'photo-preview')).to_be_visible(timeout=12000)
        # Keep timer ordering realistic while advancing the clock.
        page.clock.install();page.clock.run_for(61000)
        expect(ui.element(page,'photo-preview')).to_have_count(0)
        ui.screen(page,'menu')
        expect(ui.element(page,'photo-open')).to_be_enabled()
        self.assertEqual(len(fixture.orders),0)

if __name__=='__main__':
    unittest.main(defaultTest=['PhotoUI.test_photo_starts_from_menu_and_preserves_cart','PhotoUI.test_idle_clears_photo_and_returns_to_menu','PhotoUI.test_visual_states_in_fresh_contexts','PhotoUI.test_alex_motion_and_fixed_menu_space'],verbosity=2)
