"""Render the launch UI artwork with the original logo and bundled brand font."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 320, "height": 320}, device_scale_factor=3)
    page.goto((ROOT / "design/launch/artwork.html").as_uri())
    page.evaluate("document.fonts.ready")
    page.locator("img").evaluate("img => img.decode()")
    page.screenshot(path=str(ROOT / "apps/mobile/assets/launch/artwork.png"))
    # Separate UI layers start in exactly the same positions as the native artwork.
    # Render transparent overlays; the supplied logo itself remains unchanged.
    for name, selector in [('logo', 'img'), ('accents', 'svg'), ('tagline', 'p')]:
        page.evaluate('''selector => {
          document.body.style.background = 'transparent';
          for (const el of document.querySelector('.art').children) {
            el.style.visibility = el.matches(selector) ? 'visible' : 'hidden';
          }
        }''', selector)
        page.screenshot(path=str(ROOT / f"apps/mobile/assets/launch/{name}.png"), omit_background=True)
    browser.close()
