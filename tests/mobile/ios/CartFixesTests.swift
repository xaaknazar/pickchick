import XCTest

final class CartFixesTests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor
    func testGuestCartImmediateDragAndDiningLabels() throws {
        // Fresh dedicated simulator, guest only. Public GETs are allowed; this test never
        // signs in, requests OTP, creates a quote/order/invoice or confirms a payment.
        let app = XCUIApplication(bundleIdentifier: "kz.pickchick.app")
        app.launch()
        let menu = element("screen-M06", app)
        XCTAssertTrue(menu.waitForExistence(timeout: 40))
        let cards = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND NOT identifier BEGINSWITH %@", "product-", "product-photo-"))
        XCTAssertTrue(cards.firstMatch.waitForExistence(timeout: 30))
        guard let product = cards.allElementsBoundByIndex.first(where: { $0.isEnabled && $0.isHittable }) else {
            XCTFail("No available public catalog card"); return
        }
        product.tap()
        let add = element("product-add", app)
        XCTAssertTrue(add.waitForExistence(timeout: 10)); XCTAssertTrue(add.isEnabled); add.tap()
        let handle = element("cart-pay-handle", app)
        XCTAssertTrue(handle.waitForExistence(timeout: 30), "Public availability must permit the guest handle during open hours")
        let dock = element("cart-shortcut", app)
        XCTAssertLessThanOrEqual(dock.frame.width, 321)
        XCTAssertGreaterThanOrEqual(dock.frame.minX, 24)
        attach("Cart-compact-native", app)
        element("open-cart", app).tap()
        let dine = element("cart-dining-dine_in", app)
        let take = element("cart-dining-takeaway", app)
        XCTAssertTrue(dine.waitForExistence(timeout: 15)); XCTAssertTrue(take.exists)
        let before = dine.frame.height
        for _ in 0..<3 { dine.tap(); take.tap() }
        XCTAssertEqual(dine.frame.height, before, accuracy: 1)
        XCTAssertGreaterThanOrEqual(dine.frame.height, 48)
        attach("Cart-dining-native", app)
        element("cart-close", app).tap()
        XCTAssertTrue(handle.waitForExistence(timeout: 10))
        let start = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let end = start.withOffset(CGVector(dx: dock.frame.width - handle.frame.width - 12, dy: 0))
        // 10 ms hold deliberately reproduces the owner's ordinary immediate drag.
        start.press(forDuration: 0.01, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0)
        XCTAssertTrue(element("screen-M01", app).waitForExistence(timeout: 15), "A completed guest drag must reach sign-in, never submit payment")
        attach("Immediate-drag-guest-auth-native", app)
    }

    @MainActor private func element(_ id: String, _ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }
    @MainActor private func attach(_ name: String, _ app: XCUIApplication) {
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
