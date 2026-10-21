import XCTest

// Run only against the owner's installed build after signature/CI checks.
// All browsing below is gated on the isolated demo badge; no live checkout.
final class InstalledUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor
    func testInstalledMotionAndBillboard() throws {
        let app = XCUIApplication(bundleIdentifier: "kz.pickchick.kiosk")
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20))
        for mode in ["dine-in", "takeaway"] {
            let start = element("kiosk-start", app)
            guard start.waitForExistence(timeout: 15) else {
                throw XCTSkip("The kiosk must be at the idle welcome screen; never clear an existing order")
            }
            let logo = element("kiosk-logo-hold", app)
            XCTAssertTrue(logo.waitForExistence(timeout: 5))
            logo.press(forDuration: 5.3)
            let confirm = element("kiosk-demo-confirm", app)
            XCTAssertTrue(confirm.waitForExistence(timeout: 5))
            confirm.tap()
            XCTAssertTrue(element("kiosk-demo-badge", app).waitForExistence(timeout: 10))
            element("kiosk-start", app).tap()
            capture("mode-\(mode)", app)
            element("kiosk-mode-\(mode)", app).tap()
            let menu = element("kiosk-screen-menu", app)
            XCTAssertTrue(menu.waitForExistence(timeout: 10))
            XCTAssertTrue(element("kiosk-demo-badge", app).exists)
            for _ in 0..<10 {
                element("kiosk-category-drinks", app).tap()
                element("kiosk-category-duo", app).tap()
            }
            let banner = element("kiosk-billboard", app)
            let price = element("kiosk-billboard-price", app)
            let choose = banner.descendants(matching: .button)
                .matching(NSPredicate(format: "identifier BEGINSWITH %@", "kiosk-product-plus-")).firstMatch
            XCTAssertTrue(choose.waitForExistence(timeout: 5))
            XCTAssertGreaterThanOrEqual(choose.frame.minY, price.frame.maxY + 5)
            XCTAssertLessThanOrEqual(choose.frame.maxY, banner.frame.maxY)
            XCTAssertTrue(choose.isHittable)
            capture("menu-duo-\(mode)", app)
            element("kiosk-category-combo", app).tap()
            element("kiosk-product-pick-combo", app).tap()
            XCTAssertTrue(element("kiosk-screen-product", app).waitForExistence(timeout: 10))
            capture("product-\(mode)", app)
            element("kiosk-product-close", app).tap()
            XCTAssertTrue(menu.waitForExistence(timeout: 10))
            if mode == "takeaway" {
                // All requests here still use the in-memory demo transport.
                XCTAssertTrue(element("kiosk-demo-badge", app).exists)
                element("kiosk-product-pick-combo", app).tap()
                element("kiosk-product-add", app).tap()
                element("kiosk-menu-checkout", app).tap()
                element("kiosk-upsell-continue", app).tap()
                element("kiosk-review-create", app).tap()
                XCTAssertTrue(element("kiosk-demo-qr-warning", app).waitForExistence(timeout: 10))
                capture("demo-qr", app)
                element("kiosk-payment-cancel", app).tap()
                element("kiosk-cancel-confirm", app).tap()
                XCTAssertTrue(element("kiosk-screen-cart", app).waitForExistence(timeout: 10))
                capture("demo-cart-after-cancel", app)
            }
            element("kiosk-demo-exit", app).tap()
            XCTAssertTrue(start.waitForExistence(timeout: 10))
        }
    }

    @MainActor
    private func element(_ id: String, _ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    @MainActor
    private func capture(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
