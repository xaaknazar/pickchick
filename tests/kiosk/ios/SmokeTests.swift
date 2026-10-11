import XCTest

final class SmokeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testConnectedSyntheticOrderForKitchenInspection() throws {
        let process = ProcessInfo.processInfo
        guard process.environment["PICKCHICK_KIOSK_CONNECTED_TEST"] == "1" ||
                process.arguments.contains("-kiosk-test-order") else {
            throw XCTSkip("Opt in explicitly to create one synthetic order for KDS/LED inspection")
        }
        let app = XCUIApplication(bundleIdentifier: "kz.pickchick.kiosk")
        app.launchArguments = ["-kiosk-test-order"]
        app.launch()
        assertScreen("welcome", in: app)
        tap("kiosk-start", in: app)
        tap("kiosk-mode-takeaway", in: app)
        tap("kiosk-product-pick-combo", in: app)
        tap("kiosk-product-add", in: app)
        tap("kiosk-menu-checkout", in: app)
        tap("kiosk-upsell-continue", in: app)
        tap("kiosk-cart-checkout", in: app)
        assertScreen("loyalty", in: app)
        tap("kiosk-review-create", in: app)
        assertScreen("payment", in: app)
        tap("kiosk-payment-approve", in: app)
        assertScreen("order", in: app)
        let number = element("kiosk-order-number", in: app)
        XCTAssertTrue(number.waitForExistence(timeout: 15))
        let saved = number.label
        XCTAssertTrue(saved.range(of: "^T-[0-9]{6,}$", options: .regularExpression) != nil,
                      "Only an explicit synthetic order number is acceptable")
        let identity = XCTAttachment(string: saved)
        identity.name = "Kiosk-owned-synthetic-order-number"
        identity.lifetime = .keepAlways
        add(identity)
        // Terminate immediately, before the success screen's guest timeout.
        app.terminate()
        app.launch()
        assertScreen("order", in: app)
        assertLabel(saved, on: element("kiosk-order-number", in: app))
        screenshot("Kiosk-connected-order-restored", in: app)
        tap("kiosk-next-guest", in: app)
        assertScreen("welcome", in: app)
        // Leave this one paid TEST order for the coordinating agent to inspect
        // on both KDS stations and LED, then finish via its authorized staff API.
    }

    // Runs against a bundled Release iPad application. Browsing may establish a
    // synthetic kiosk guest, but these tests never create or pay for an order.
    @MainActor
    func testOriginalPortraitCompositionAndFixedCart() throws {
        let app = launchApp()
        XCTAssertGreaterThanOrEqual(app.frame.width, 768)
        XCTAssertGreaterThan(app.frame.height, app.frame.width, "The kiosk is configured for portrait")
        assertBounded("kiosk-start", in: app)
        XCTAssertFalse(element("hero-video-toggle", in: app).exists)
        screenshot("Kiosk-original-welcome", in: app)
        tap("kiosk-start", in: app)
        assertScreen("mode", in: app)
        let here = element("kiosk-mode-dine-in", in: app)
        let takeaway = element("kiosk-mode-takeaway", in: app)
        assertBounded("kiosk-mode-dine-in", in: app)
        assertBounded("kiosk-mode-takeaway", in: app)
        XCTAssertGreaterThanOrEqual(takeaway.frame.minY, here.frame.maxY - 1,
                                    "The source places blue/orange service choices vertically")
        screenshot("Kiosk-original-mode", in: app)
        tap("kiosk-mode-takeaway", in: app)
        assertScreen("menu", in: app)
        let footer = element("kiosk-cart-bar", in: app)
        XCTAssertTrue(footer.waitForExistence(timeout: 15))
        let frame = footer.frame
        let scroller = element("kiosk-menu-scroll", in: app)
        scroller.swipeUp()
        scroller.swipeUp()
        XCTAssertEqual(footer.frame.minY, frame.minY, accuracy: 1)
        XCTAssertEqual(footer.frame.maxY, frame.maxY, accuracy: 1)
        assertBounded("kiosk-menu-checkout", in: app)
        XCTAssertFalse(element("kiosk-menu-checkout", in: app).isEnabled)
        for category in ["duo", "sets", "extras", "drinks", "combo"] {
            tap("kiosk-category-\(category)", in: app)
            assertBounded("kiosk-category-\(category)", in: app)
            XCTAssertEqual(footer.frame.minY, frame.minY, accuracy: 1)
        }
        screenshot("Kiosk-original-menu", in: app)
        finishGuest(in: app)
    }

    @MainActor
    func testModifiersVariantsAndCartSurviveRelaunch() throws {
        let app = launchApp()
        tap("kiosk-start", in: app)
        tap("kiosk-mode-takeaway", in: app)
        assertScreen("menu", in: app)
        tap("kiosk-product-pick-combo", in: app)
        assertScreen("product", in: app)
        // Regression: after the circular reveal the to-cart bar must sit on screen.
        sleep(1)
        assertBounded("kiosk-product-add", in: app)
        let nutrition = element("kiosk-product-nutrition", in: app)
        XCTAssertTrue(nutrition.waitForExistence(timeout: 10))
        // The View with a testID is a container, not an aggregate text label.
        // Query the actual visible caption so native AX must expose its content.
        let calories = app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@ AND label CONTAINS %@", "1240", "ккал"
        )).firstMatch
        XCTAssertTrue(calories.waitForExistence(timeout: 10), "Source calorie caption must be present")
        XCTAssertTrue(calories.isHittable, "The 1240 ккал caption must be readable without scrolling")
        tap("kiosk-modifier-drink-lemonade", in: app)
        tap("kiosk-modifier-plus-extras-toast", in: app)
        let add = element("kiosk-product-add", in: app)
        XCTAssertTrue(add.label.replacingOccurrences(of: "\u{00a0}", with: " ").contains("4 780"))
        let frame = add.frame
        element("kiosk-product-scroll", in: app).swipeUp()
        assertBounded("kiosk-product-add", in: app)
        XCTAssertEqual(add.frame.minY, frame.minY, accuracy: 1)
        screenshot("Kiosk-native-configured-combo", in: app)
        tap("kiosk-product-add", in: app)
        assertScreen("menu", in: app)
        tap("kiosk-product-pick-combo", in: app)
        assertScreen("product", in: app)
        XCTAssertTrue(element("kiosk-product-add", in: app).label
            .replacingOccurrences(of: "\u{00a0}", with: " ").contains("4 190"),
                      "Opening another product variant must restore catalog defaults")
        tap("kiosk-product-add", in: app)
        assertScreen("menu", in: app)
        tap("kiosk-menu-checkout", in: app)
        assertScreen("upsell", in: app)
        tap("kiosk-upsell-continue", in: app)
        assertScreen("cart", in: app)

        let custom = "pick-combo|drink:lemonade:1,extras:toast:1,sauce:pick:1"
        let standard = "pick-combo|drink:cola-bottle:1,sauce:pick:1"
        assertLabel("1", on: element("kiosk-cart-line-\(custom)-quantity", in: app))
        assertLabel("1", on: element("kiosk-cart-line-\(standard)-quantity", in: app))
        tap("kiosk-cart-line-\(custom)-plus", in: app)
        assertLabel("2", on: element("kiosk-cart-line-\(custom)-quantity", in: app))
        assertLabel("1", on: element("kiosk-cart-line-\(standard)-quantity", in: app))
        app.terminate()
        app.launch()
        assertScreen("menu", in: app)
        tap("kiosk-menu-checkout", in: app)
        // Source rule: 2 × 4 780 + 4 190 = 13 750 exceeds the 10 000 upsell threshold.
        // The first 8 970 cart above must show upsell; this restored cart must skip it.
        assertScreen("cart", in: app)
        XCTAssertFalse(element("kiosk-screen-upsell", in: app).exists)
        let total = app.staticTexts.matching(NSPredicate(
            format: "label MATCHES %@", "13[\\s\u{00a0}\u{202f}]750[\\s\u{00a0}\u{202f}]*₸"
        )).firstMatch
        XCTAssertTrue(total.waitForExistence(timeout: 10), "Restored total must remain 13 750 ₸")
        assertLabel("2", on: element("kiosk-cart-line-\(custom)-quantity", in: app))
        assertLabel("1", on: element("kiosk-cart-line-\(standard)-quantity", in: app))
        assertBounded("kiosk-cart-checkout", in: app)
        screenshot("Kiosk-native-cart-restored", in: app)

        // Design 05: the cart header has no cancel; the menu keeps it.
        tap("kiosk-header-back", in: app)
        assertScreen("menu", in: app)
        tap("kiosk-cancel-open", in: app)
        tap("kiosk-cancel-dismiss", in: app)
        assertScreen("menu", in: app)
        tap("kiosk-menu-checkout", in: app)
        assertScreen("cart", in: app)
        assertLabel("2", on: element("kiosk-cart-line-\(custom)-quantity", in: app))
        tap("kiosk-header-back", in: app)
        assertScreen("menu", in: app)
        finishGuest(in: app)
        tap("kiosk-start", in: app)
        tap("kiosk-mode-takeaway", in: app)
        assertScreen("menu", in: app)
        XCTAssertFalse(element("kiosk-menu-checkout", in: app).isEnabled,
                       "The next guest must not inherit another guest's cart")
        finishGuest(in: app)
    }

    @MainActor
    private func launchApp() -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "kz.pickchick.kiosk")
        app.launch()
        assertScreen("welcome", in: app)
        return app
    }

    @MainActor
    private func finishGuest(in app: XCUIApplication) {
        tap("kiosk-cancel-open", in: app)
        tap("kiosk-cancel-confirm", in: app)
        assertScreen("welcome", in: app)
    }

    @MainActor
    private func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    @MainActor
    private func assertScreen(_ name: String, in app: XCUIApplication) {
        XCTAssertTrue(element("kiosk-screen-\(name)", in: app).waitForExistence(timeout: 20), name)
    }

    @MainActor
    private func tap(_ identifier: String, in app: XCUIApplication) {
        let target = element(identifier, in: app)
        XCTAssertTrue(target.waitForExistence(timeout: 15), identifier)
        if !target.isHittable {
            for _ in 0..<8 {
                if target.isHittable { break }
                app.scrollViews.firstMatch.swipeUp()
            }
        }
        XCTAssertTrue(target.isHittable, identifier)
        XCTAssertTrue(target.isEnabled, identifier)
        target.tap()
    }

    @MainActor
    private func assertLabel(_ label: String, on target: XCUIElement) {
        let expected = NSPredicate(format: "exists == true AND label == %@", label)
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: expected, object: target)],
                                     timeout: 10), .completed)
    }

    @MainActor
    private func assertBounded(_ identifier: String, in app: XCUIApplication) {
        let target = element(identifier, in: app)
        XCTAssertTrue(target.waitForExistence(timeout: 15), identifier)
        XCTAssertGreaterThanOrEqual(target.frame.width, 44, identifier)
        XCTAssertGreaterThanOrEqual(target.frame.height, 44, identifier)
        XCTAssertGreaterThanOrEqual(target.frame.minX, app.frame.minX - 1, identifier)
        XCTAssertGreaterThanOrEqual(target.frame.minY, app.frame.minY - 1, identifier)
        XCTAssertLessThanOrEqual(target.frame.maxX, app.frame.maxX + 1, identifier)
        XCTAssertLessThanOrEqual(target.frame.maxY, app.frame.maxY + 1, identifier)
    }

    @MainActor
    private func screenshot(_ name: String, in app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
