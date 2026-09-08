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
    browser.close()
