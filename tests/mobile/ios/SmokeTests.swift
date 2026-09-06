import XCTest

final class SmokeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    // Run against the Release build: JavaScript and brand assets are bundled,
    // and a Metro development server is not a prerequisite for app launch.
    @MainActor
    func testReleaseLaunchAndAll35DesignScreens() throws {
        let app = launchApp()
        assertScreen("M06", in: app)
        attachScreenshot("Launch-M06", of: app)

        for number in 1...35 {
            let id = String(format: "M%02d", number)
            XCTContext.runActivity(named: "Open design screen \(id)") { _ in
                openDesignScreen(id, in: app)
                attachScreenshot(id, of: app)
            }
        }
    }

    @MainActor
    func testPreviewCartQuantityAndDisabledPayment() throws {
        let app = launchApp()
        openDesignScreen("M07", in: app)
        tap("product-add", in: app)
        assertScreen("M09", in: app)

        let quantity = element("cart-quantity-pick-combo", in: app)
        assertLabel("1", on: quantity)
        tap("cart-plus-pick-combo", in: app)
        assertLabel("2", on: quantity)
        tap("cart-minus-pick-combo", in: app)
        assertLabel("1", on: quantity)
        attachScreenshot("Cart-quantity-updated", of: app)

        tap("cart-checkout", in: app)
        assertScreen("M12", in: app)
        let payment = element("checkout-pay-disabled", in: app)
        XCTAssertTrue(payment.waitForExistence(timeout: 10))
        XCTAssertFalse(payment.isEnabled, "Staging must not enable an unconnected payment flow")
        attachScreenshot("Checkout-disabled", of: app)
    }

    @MainActor
    func testPhoneAuthenticationRemainsUnavailable() throws {
        let app = launchApp()
        openDesignScreen("M02", in: app)
        let requestCode = element("request-otp-disabled", in: app)
        reveal(requestCode, in: app)
        XCTAssertFalse(requestCode.isEnabled, "No SMS provider is connected")
        XCTAssertTrue(element("phone-input-disabled", in: app).exists)

        openDesignScreen("M03", in: app)
        XCTAssertTrue(element("otp-input-disabled", in: app).waitForExistence(timeout: 10))
        attachScreenshot("OTP-unavailable", of: app)
    }

    @MainActor
    private func launchApp() -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "kz.pickchick.app")
        app.launch()
        assertScreen("M06", in: app)
        return app
    }

    @MainActor
    private func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    @MainActor
    private func assertScreen(_ id: String, in app: XCUIApplication,
                              file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element("screen-\(id)", in: app).waitForExistence(timeout: 30),
                      "Expected native screen \(id)", file: file, line: line)
        XCTAssertTrue(element("open-design-review", in: app).exists,
                      "Design catalog must remain accessible on \(id)", file: file, line: line)
    }

    @MainActor
    private func openDesignScreen(_ id: String, in app: XCUIApplication) {
        tap("open-design-review", in: app)
        let firstScreen = element("review-M01", in: app)
        XCTAssertTrue(firstScreen.waitForExistence(timeout: 10), "Expected the native design catalog")
        let destination = element("review-\(id)", in: app)
        reveal(destination, in: app)
        destination.tap()
        assertScreen(id, in: app)
    }

    @MainActor
    private func tap(_ identifier: String, in app: XCUIApplication) {
        let target = element(identifier, in: app)
        reveal(target, in: app)
        XCTAssertTrue(target.isEnabled, "Expected enabled control \(identifier)")
        target.tap()
    }

    // Scroll the native container; no screen dimensions or pixel coordinates.
    @MainActor
    private func reveal(_ target: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(target.waitForExistence(timeout: 10), "Missing element \(target.identifier)")
        for _ in 0..<14 {
            if target.isHittable { return }
            let scrollView = app.scrollViews.firstMatch
            XCTAssertTrue(scrollView.exists, "Element is offscreen without a scroll container")
            scrollView.swipeUp()
        }
        XCTAssertTrue(target.isHittable, "Could not reveal \(target.identifier) using native scrolling")
    }

    @MainActor
    private func assertLabel(_ value: String, on element: XCUIElement) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", value),
                                                    object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 5), .completed,
                       "Expected quantity \(value), found \(element.label)")
    }

    @MainActor
    private func attachScreenshot(_ name: String, of app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
