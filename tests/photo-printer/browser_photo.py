"""Real kiosk UI + synthetic camera, isolated ordering fixtures. No restaurant requests."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'kiosk'))
import browser_ui as ui
from playwright.sync_api import expect

ui.OUTPUT = Path('.local/photo-browser')

def capture(page, filename):
    # Capture once per fresh browser process: repeated video/modal captures can lose
    # static composited layers in headless Chromium on this Mac.
    # Wait for actual fonts, images and video; do not alter rendered UI or hide content.
    page.evaluate('() => document.fonts.ready')
    page.wait_for_function("""() => [...document.images].filter(i => {
        const r=i.getBoundingClientRect(); return r.width>0 && r.height>0 && r.top<innerHeight && r.bottom>0;
    }).every(i => i.complete && i.naturalWidth>0)""")
    # Expo's modal/video compositor needs a settled frame after the state change.
    # One bounded capture delay, after the real readiness checks above.
    page.wait_for_timeout(1000)
    page.screenshot(path=str(ui.OUTPUT / filename), full_page=True)

class PhotoUI(ui.KioskUI):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.browser.close()
        cls.browser = cls.playwright.chromium.launch(headless=True, args=['--disable-gpu', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'])

    def test_photo_roundtrip_preserves_cart_and_clears_camera(self):
        for width,height in [(1024,1366),(820,1180),(744,1133),(1180,820)]:
            with self.subTest(size=(width,height)):
                page,fixture=self.open(width,height)
                page.context.grant_permissions(['camera'])
                self.start(page); self.add(page)
                before=ui.stored(page,ui.FLOW_KEY)
                ui.assert_bounded(page,'photo-open',width,height)
                ui.element(page,'photo-open').click()
                ui.assert_bounded(page,'photo-close',width,height)
                ui.element(page,'photo-start').click()
                expect(ui.element(page,'photo-capture')).to_be_enabled(timeout=15000)
                ui.assert_bounded(page,'photo-capture',width,height)
                page.wait_for_function("() => { const v=document.querySelector('video'); return v && v.readyState>=2 && v.currentTime>0; }")
                ui.element(page,'photo-capture').click()
                expect(ui.element(page,'photo-preview')).to_be_visible(timeout=12000)
                expect(ui.element(page,'photo-print')).to_be_disabled()
                self.assertEqual(page.locator('video').count(),0)
                self.assertEqual(ui.stored(page,ui.FLOW_KEY),before)
                ui.element(page,'photo-retake').click()
                expect(ui.element(page,'photo-capture')).to_be_enabled(timeout=12000)
                ui.element(page,'photo-close').click()
                ui.screen(page,'menu')
                expect(page.locator('video')).to_have_count(0)
                self.assertEqual(ui.stored(page,ui.FLOW_KEY),before)
                ui.element(page,'photo-open').click()
                expect(ui.element(page,'photo-preview')).to_have_count(0)
                expect(ui.element(page,'photo-start')).to_be_visible()
                ui.element(page,'photo-close').click()
                self.assertEqual(len(fixture.orders),0)

    def test_visual_states_in_fresh_contexts(self):
        for width,height in [(1024,1366),(820,1180),(744,1133),(1180,820)]:
            for state in ['menu','intro','camera','preview']:
                with self.subTest(size=(width,height),state=state):
                    previous_browser=self.browser
                    self.browser=self.playwright.chromium.launch(headless=True,args=['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
                    self.addCleanup(self.browser.close)
                    page,fixture=self.open(width,height)
                    page.context.grant_permissions(['camera'])
                    self.start(page);self.add(page)
                    expect(ui.element(page,'kiosk-toast')).to_have_count(0,timeout=5000)
                    if state!='menu':
                        ui.element(page,'photo-open').click()
                        ui.assert_bounded(page,'photo-close',width,height)
                        if state in ['camera','preview']:
                            ui.element(page,'photo-start').click()
                            expect(ui.element(page,'photo-capture')).to_be_enabled(timeout=15000)
                            page.wait_for_function("() => {const v=document.querySelector('video');return v&&v.readyState>=2&&v.currentTime>0;}")
                            if state=='preview':
                                ui.element(page,'photo-capture').click()
                                expect(ui.element(page,'photo-preview')).to_be_visible(timeout=12000)
                        expect(ui.element(page,'photo-close')).to_be_visible()
                    capture(page,f'photo-{state}-{width}.png')
                    page.context.close()
                    self.browser.close()
                    self.browser=previous_browser

    def test_idle_clears_photo_and_returns_to_existing_order(self):
        page,fixture=self.open();page.context.grant_permissions(['camera']);self.start(page);self.add(page)
        ui.element(page,'photo-open').click()
        ui.element(page,'photo-start').click()
        expect(ui.element(page,'photo-capture')).to_be_enabled(timeout=15000)
        ui.element(page,'photo-capture').click()
        expect(ui.element(page,'photo-preview')).to_be_visible(timeout=12000)
        # Keep timer ordering realistic while advancing the clock.
        page.clock.install();page.clock.run_for(61000)
        expect(ui.element(page,'photo-preview')).to_have_count(0)
        ui.screen(page,'menu')
        expect(ui.element(page,'kiosk-menu-checkout')).to_be_enabled()
        self.assertEqual(len(fixture.orders),0)

if __name__=='__main__':
    unittest.main(defaultTest=['PhotoUI.test_photo_roundtrip_preserves_cart_and_clears_camera','PhotoUI.test_idle_clears_photo_and_returns_to_existing_order','PhotoUI.test_visual_states_in_fresh_contexts'],verbosity=2)
