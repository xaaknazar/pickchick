import XCTest

// Runs against the installed kiosk. Never resets a live flow or submits a live order.
final class InstalledUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor
    func testInstalledOwnerPolishInDemo() throws {
        let app = XCUIApplication(bundleIdentifier: "kz.pickchick.kiosk")
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20))
        // Recover only our isolated demo after an interrupted verification.
        if element("kiosk-demo-badge", app).exists {
            tap("kiosk-demo-exit", app)
        }
        guard element("kiosk-start", app).waitForExistence(timeout: 10) else {
            throw XCTSkip("Existing guest flow must be left intact; start from idle welcome")
        }
        element("kiosk-logo-hold", app).press(forDuration: 5.6)
        tap("kiosk-demo-confirm", app)
        XCTAssertTrue(element("kiosk-demo-badge", app).waitForExistence(timeout: 10))
        for (locale, delay) in [("kk", 2.45), ("en", 0.12), ("ru", 1.0)] {
            Thread.sleep(forTimeInterval: delay)
            tap("kiosk-language-\(locale)", app)
            let label = element("kiosk-start", app).label
            Thread.sleep(forTimeInterval: 2.7)
            XCTAssertEqual(element("kiosk-start", app).label, label)
            capture("18-welcome-\(locale)", app)
        }
        tap("kiosk-start", app)
        let dine = element("kiosk-mode-dine-in", app)
        let take = element("kiosk-mode-takeaway", app)
        XCTAssertTrue(dine.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1.3) // entrance animation, before measuring
        let dineFrame = dine.frame, takeFrame = take.frame
        for card in [dine, take] {
            let top = card.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
            let bottom = card.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
            bottom.press(forDuration: 0.05, thenDragTo: top)
            XCTAssertTrue(element("kiosk-screen-mode", app).exists)
            top.press(forDuration: 0.05, thenDragTo: bottom)
            XCTAssertTrue(element("kiosk-screen-mode", app).exists)
        }
        XCTAssertEqual(dine.frame, dineFrame)
        XCTAssertEqual(take.frame, takeFrame)
        capture("18-fixed-mode", app)
        tap("kiosk-mode-takeaway", app)
        tap("kiosk-category-combo", app)
        tap("kiosk-product-pick-combo", app)
        XCTAssertTrue(element("kiosk-screen-product", app).waitForExistence(timeout: 10))
        let add = element("kiosk-product-add", app)
        XCTAssertTrue(add.isHittable)
        XCTAssertLessThanOrEqual(add.frame.maxY, app.frame.maxY)
        let more = element("kiosk-modifier-expand-drink", app)
        XCTAssertTrue(more.isHittable)
        capture("18-pick-combo", app)
        more.tap()
        XCTAssertTrue(element("kiosk-drinks-sheet", app).waitForExistence(timeout: 5))
        capture("18-more-drinks", app)
        tap("kiosk-drinks-close", app)
        tap("kiosk-product-add", app)
        XCTAssertTrue(element("kiosk-screen-menu", app).waitForExistence(timeout: 10))
        for (category, product) in [("extras", "toast"), ("extras", "sauce"), ("drinks", "lemonade")] {
            tap("kiosk-category-\(category)", app)
            tap("kiosk-product-\(product)", app)
            XCTAssertTrue(element("kiosk-product-sheet", app).waitForExistence(timeout: 5))
            capture("18-sheet-\(product)", app)
            tap("kiosk-sheet-close", app)
            XCTAssertTrue(element("kiosk-screen-menu", app).waitForExistence(timeout: 5))
        }
        capture("18-drinks-menu", app)
        tap("kiosk-menu-checkout", app)
        tap("kiosk-upsell-plus-sauce", app)
        tap("kiosk-sheet-size-size-1", app)
        tap("kiosk-sheet-add", app)
        for _ in 0..<4 { tap("kiosk-upsell-plus-sauce", app) }
        XCTAssertEqual(element("kiosk-upsell-quantity-sauce", app).label, "5")
        tap("kiosk-upsell-minus-sauce", app)
        XCTAssertEqual(element("kiosk-upsell-quantity-sauce", app).label, "4")
        capture("18-upsell-added", app)
        tap("kiosk-upsell-skip", app)
        XCTAssertTrue(element("kiosk-demo-badge", app).exists)
        XCTAssertFalse(element("kiosk-payment-method-kaspi_invoice", app).exists)
        XCTAssertFalse(element("kiosk-invoice-phone", app).exists)
        capture("18-payment-method-after-skip", app)
        tap("kiosk-payment-method-kaspi", app)
        // All checkout calls below are gated by the isolated in-memory demo badge.
        XCTAssertTrue(element("kiosk-demo-badge", app).exists)
        tap("kiosk-review-create", app)
        XCTAssertTrue(element("kiosk-demo-qr-warning", app).waitForExistence(timeout: 5))
        capture("18-demo-qr", app)
        tap("kiosk-payment-restart", app)
        tap("kiosk-restart-confirm", app)
        XCTAssertTrue(element("kiosk-start", app).waitForExistence(timeout: 5))
        capture("18-restarted", app)
        tap("kiosk-demo-exit", app)
        XCTAssertTrue(element("kiosk-start", app).waitForExistence(timeout: 5))
    }

    @MainActor
    private func element(_ id: String, _ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    @MainActor
    private func tap(_ id: String, _ app: XCUIApplication) {
        let target = element(id, app)
        XCTAssertTrue(target.waitForExistence(timeout: 8), id)
        XCTAssertTrue(target.isHittable, id)
        target.tap()
    }

    @MainActor
    private func capture(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
