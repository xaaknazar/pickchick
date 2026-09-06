import XCTest

final class SmokeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    // Run against the Release build: JavaScript and brand assets are bundled,
    // and a Metro development server is not a prerequisite for app launch.
    @MainActor
    func testConnectedOrderSurvivesRelaunch() async throws {
        // A separate, explicitly synthetic scenario. No staff credentials are
        // compiled into the app or tests and no real bank endpoint is called.
        let url = URL(string: "https://pickchick.185.129.51.103.nip.io/v1/capabilities")!
        let (data, _) = try await URLSession.shared.data(from: url)
        let flags = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let features = flags?["features"] as? [String: Any],
              features["test_order_flow"] as? Bool == true else {
            throw XCTSkip("Connected synthetic API is not enabled")
        }
        let app = launchApp()
        tap("product-pick-combo", in: app)
        tap("product-add", in: app)
        tap("cart-checkout", in: app)
        // Reuse the owned synthetic identity through the app's normal renewal
        // flow; repeated UI runs may outlive its short access token.
        let renewal = element("test-continue-session", in: app)
        if renewal.waitForExistence(timeout: 3) {
            reveal(renewal, in: app)
            renewal.tap()
            let completed = NSPredicate(format: "exists == false")
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: completed, object: renewal)], timeout: 15), .completed)
        }
        tap("test-checkout-create", in: app)
        let number = element("connected-order-number", in: app)
        guard number.waitForExistence(timeout: 20) else {
            attachScreenshot("Connected-create-failed", of: app)
            XCTFail("The connected order did not appear after checkout")
            return
        }
        let savedNumber = number.label
        XCTAssertTrue(savedNumber.hasPrefix("T-"), "Expected an isolated TEST number")
        tap("test-payment-approve", in: app)
        let state = element("connected-order-state", in: app)
        assertLabel("Готовится", on: state)
        attachScreenshot("Connected-preparing", of: app)
        app.terminate()
        app.launch()
        assertScreen("M06", in: app)
        tap("tab-orders", in: app)
        let saved = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", savedNumber)).firstMatch
        reveal(saved, in: app)
        saved.tap()
        assertLabel(savedNumber, on: element("connected-order-number", in: app))
        assertLabel("Готовится", on: element("connected-order-state", in: app))
        attachScreenshot("Connected-restored", of: app)
        tap("test-open-cancel", in: app)
        tap("test-cancel-order", in: app)
        assertLabel("Отменён", on: element("connected-order-state", in: app))
        attachScreenshot("Connected-cancelled", of: app)
    }

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
    func testOriginalMockupCompositionAndDecorativeVideo() throws {
        let app = launchApp()
        let hero = element("hero-promotion", in: app)
        XCTAssertTrue(hero.waitForExistence(timeout: 10))
        XCTAssertFalse(element("hero-video-toggle", in: app).exists)
        XCTAssertEqual(hero.frame.midX, app.frame.midX, accuracy: 2)
        attachScreenshot("Mockup-menu", of: app)
        tap("category-Комбо", in: app)
        let product = element("product-pick-combo", in: app)
        reveal(product, in: app)
        attachScreenshot("Mockup-catalog", of: app)
        product.tap()
        assertScreen("M07", in: app)
        XCTAssertFalse(element("hero-video-toggle", in: app).exists)
        attachScreenshot("Mockup-product", of: app)
        tap("product-add", in: app)
        assertScreen("M09", in: app)
        attachScreenshot("Mockup-cart", of: app)
        app.buttons["Назад"].firstMatch.tap()
        app.buttons["Закрыть блюдо"].firstMatch.tap()
        tap("tab-profile", in: app)
        assertScreen("M30", in: app)
        attachScreenshot("Mockup-profile", of: app)
        tap("tab-events", in: app)
        assertScreen("M26", in: app)
        attachScreenshot("Mockup-events", of: app)
    }

    @MainActor
    func testBottomControlsStayVisibleWhileScrolling() throws {
        let app = launchApp()
        let tab = element("tab-menu", in: app)
        XCTAssertTrue(tab.waitForExistence(timeout: 10))
        let initialTabY = tab.frame.minY
        app.scrollViews.firstMatch.swipeUp()
        XCTAssertEqual(tab.frame.minY, initialTabY, accuracy: 1)
        XCTAssertTrue(tab.isHittable)
        tap("product-pick-combo", in: app)
        let add = element("product-add", in: app)
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        let addY = add.frame.minY
        app.scrollViews.firstMatch.swipeUp()
        XCTAssertEqual(add.frame.minY, addY, accuracy: 1)
        XCTAssertTrue(add.isHittable)
        tap("product-add", in: app)
        let checkout = element("cart-checkout", in: app)
        XCTAssertTrue(checkout.waitForExistence(timeout: 10))
        let checkoutY = checkout.frame.minY
        app.scrollViews.firstMatch.swipeUp()
        XCTAssertEqual(checkout.frame.minY, checkoutY, accuracy: 1)
        XCTAssertTrue(checkout.isHittable)
        app.buttons["Назад"].firstMatch.tap()
        app.buttons["Закрыть блюдо"].firstMatch.tap()
        assertScreen("M06", in: app)
        let basket = element("open-cart", in: app)
        XCTAssertTrue(basket.waitForExistence(timeout: 10))
        XCTAssertTrue(basket.isHittable)
        XCTAssertGreaterThanOrEqual(tab.frame.minY - basket.frame.maxY, 0)
        XCTAssertLessThanOrEqual(tab.frame.minY - basket.frame.maxY, 20)
        XCTAssertLessThanOrEqual(app.frame.maxY - tab.frame.maxY, 60)
        let basketY = basket.frame.minY
        app.scrollViews.firstMatch.swipeDown()
        XCTAssertEqual(basket.frame.minY, basketY, accuracy: 1)
        XCTAssertEqual(tab.frame.minY, initialTabY, accuracy: 1)
        attachScreenshot("Fixed-cart-and-navigation", of: app)
    }

    @MainActor
    func testKeyboardLeavesLocalProfileActionReachable() throws {
        let app = launchApp()
        openDesignScreen("M04", in: app)
        tap("nickname-input", in: app)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        element("nickname-input", in: app).typeText("Layout")
        let save = element("nickname-save", in: app)
        reveal(save, in: app)
        XCTAssertTrue(save.isHittable)
        if app.keyboards.firstMatch.exists {
            XCTAssertLessThanOrEqual(save.frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
        }
        save.tap()
        assertScreen("M30", in: app)
        attachScreenshot("Keyboard-local-profile", of: app)
    }

    @MainActor
    func testLocalDemoPhoneInputAndAccountLifecycle() throws {
        XCTContext.runActivity(named: "native-input-v2") { activity in
            let bundleURL = Bundle(for: SmokeTests.self).bundleURL
            print("native-input-v2 test bundle: \(bundleURL.absoluteString)")
            let attachment = XCTAttachment(string: bundleURL.absoluteString)
            attachment.name = "native-input-v2-test-bundle"
            attachment.lifetime = .keepAlways
            activity.add(attachment)
        }
        // The fixed demonstration code never sends SMS or authenticates this
        // synthetic phone with the ordering API. Exercise the live profile UI.
        let app = launchApp()
        tap("tab-profile", in: app)
        if element("demo-sign-out", in: app).exists {
            tap("demo-sign-out", in: app)
        }
        tap("profile-sign-in", in: app)
        assertScreen("M02", in: app)
        let request = element("request-otp", in: app)
        XCTAssertFalse(request.isEnabled, "An empty phone must not request a challenge")
        replaceText(in: element("phone-input", in: app), with: "7000000000", app: app)
        tap("request-otp", in: app)
        assertScreen("M03", in: app)
        let resend = element("resend-otp", in: app)
        XCTAssertTrue(resend.exists)
        XCTAssertFalse(resend.isEnabled, "The resend delay must apply to the demo challenge")
        let code = element("otp-input", in: app)
        replaceText(in: code, with: "000000", app: app)
        tap("confirm-otp", in: app)
        let error = element("demo-auth-error", in: app)
        assertLabel("Код не подошёл. Для этого тестового входа используйте 123456.", on: error)
        assertScreen("M03", in: app)
        attachScreenshot("Demo-OTP-rejected", of: app)

        replaceText(in: code, with: "123456", app: app)
        tap("confirm-otp", in: app)
        assertScreen("M04", in: app)
        replaceText(in: element("nickname-input", in: app), with: "Native Demo", app: app)
        tap("nickname-save", in: app)
        assertScreen("M30", in: app)
        XCTAssertTrue(app.staticTexts["Native Demo"].exists)
        XCTAssertTrue(app.staticTexts["+7 700 000-00-00"].exists)
        attachScreenshot("Demo-profile-saved", of: app)

        app.terminate()
        app.launch()
        assertScreen("M06", in: app)
        tap("tab-profile", in: app)
        XCTAssertTrue(element("demo-sign-out", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Native Demo"].exists)
        XCTAssertTrue(app.staticTexts["+7 700 000-00-00"].exists)
        attachScreenshot("Demo-profile-restored", of: app)
        tap("demo-sign-out", in: app)
        XCTAssertTrue(element("profile-sign-in", in: app).waitForExistence(timeout: 10))
        XCTAssertFalse(element("demo-sign-out", in: app).exists)
        XCTAssertFalse(app.staticTexts["+7 700 000-00-00"].exists)
        attachScreenshot("Demo-profile-signed-out", of: app)
    }

    @MainActor
    func testPreviewProductConfigurationUpsellAndPaymentChoice() throws {
        // The v0.3 source catalog is bundled locally in preview. These actions
        // never create an order or call a bank, even when the VPS is reachable.
        let app = launchApp()
        openDesignScreen("M07", in: app)
        let nutrition = element("product-nutrition", in: app)
        reveal(nutrition, in: app)
        XCTAssertTrue(nutrition.exists, "The source product must show its nutrition panel")
        let add = element("product-add", in: app)
        let addY = add.frame.minY
        assertLabel("Добавить · 4 190 ₸", on: add)
        tap("modifier-drink-lemonade", in: app)
        assertLabel("Добавить · 4 390 ₸", on: add)
        tap("modifier-sauce-hot", in: app)
        tap("modifier-plus-extras-fingers", in: app)
        assertLabel("1", on: element("modifier-count-extras-fingers", in: app))
        assertLabel("Добавить · 5 080 ₸", on: add)
        tap("modifier-minus-extras-fingers", in: app)
        assertLabel("0", on: element("modifier-count-extras-fingers", in: app))
        XCTAssertFalse(element("modifier-minus-extras-fingers", in: app).isEnabled)
        assertLabel("Добавить · 4 390 ₸", on: add)
        tap("modifier-plus-extras-fingers", in: app)
        XCTAssertEqual(add.frame.minY, addY, accuracy: 1)
        XCTAssertTrue(add.isHittable, "Configuration scrolling must leave Add fixed")
        attachScreenshot("Configured-product-and-nutrition", of: app)
        tap("product-add", in: app)
        assertScreen("M09", in: app)
        assertLabel("1", on: element("cart-quantity-pick-combo", in: app))
        tap("upsell-sauce", in: app)
        assertLabel("1", on: element("cart-quantity-sauce", in: app))
        let checkout = element("cart-checkout", in: app)
        let checkoutY = checkout.frame.minY
        tap("payment-method", in: app)
        tap("payment-method-card", in: app)
        assertLabel("Способ оплаты: Банковская карта, изменить", on: element("payment-method", in: app))
        XCTAssertEqual(checkout.frame.minY, checkoutY, accuracy: 1)
        XCTAssertTrue(checkout.isHittable)
        attachScreenshot("Variant-cart-upsell-and-card", of: app)
        tap("payment-method", in: app)
        tap("payment-method-kaspi", in: app)
        assertLabel("Способ оплаты: Kaspi, изменить", on: element("payment-method", in: app))
        tap("cart-checkout", in: app)
        assertScreen("M12", in: app)
        XCTAssertFalse(element("checkout-pay-disabled", in: app).isEnabled,
                       "Preview choices must not activate a payment")
    }

    @MainActor
    func testCategoryAnchorsKeepCartAndNavigationFixed() throws {
        // Requires the deployed v0.3 catalog, but changes only the local basket.
        let app = launchApp()
        if !element("open-cart", in: app).exists {
            tap("product-pick-combo", in: app)
            tap("product-add", in: app)
            app.buttons["Назад"].firstMatch.tap()
            tap("product-close", in: app)
        }
        assertScreen("M06", in: app)
        let tab = element("tab-menu", in: app)
        let basket = element("open-cart", in: app)
        XCTAssertTrue(basket.waitForExistence(timeout: 10))
        let tabY = tab.frame.minY
        let basketY = basket.frame.minY
        reveal(element("category-Комбо", in: app), in: app)
        for category in ["Напитки", "На компанию", "Комбо"] {
            let chip = element("category-\(category)", in: app)
            let bar = app.scrollViews.containing(.any, identifier: "category-Комбо").firstMatch
            XCTAssertTrue(bar.exists, "Expected the horizontal category strip")
            for _ in 0..<8 {
                if chip.isHittable { break }
                if chip.frame.midX < bar.frame.midX { bar.swipeRight() }
                else { bar.swipeLeft() }
            }
            XCTAssertTrue(chip.isHittable, "Expected category \(category) to be reachable")
            chip.tap()
            let heading = element("category-heading-\(category)", in: app)
            let reached = NSPredicate { _, _ in
                heading.exists && heading.isHittable &&
                heading.frame.minY >= chip.frame.maxY - 1 && chip.isSelected
            }
            let reachedResult = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: reached, object: heading)], timeout: 8)
            if reachedResult != .completed {
                XCTContext.runActivity(named: "Category anchor diagnostic: \(category)") { activity in
                    let scroll = element("scroll-M06", in: app)
                    let header = element("storefront-header", in: app)
                    let details = [
                        "category=\(category)",
                        heading.exists ? "heading frame=\(heading.frame), hittable=\(heading.isHittable)" : "heading missing",
                        chip.exists ? "chip frame=\(chip.frame), hittable=\(chip.isHittable), selected=\(chip.isSelected)" : "chip missing",
                        bar.exists ? "strip frame=\(bar.frame)" : "strip missing",
                        scroll.exists ? "scroll frame=\(scroll.frame)" : "scroll missing",
                        header.exists ? "header frame=\(header.frame)" : "header missing",
                        "tab frame=\(tab.frame), basket frame=\(basket.frame)",
                    ].joined(separator: "\n")
                    print(details)
                    let attachment = XCTAttachment(string: details)
                    attachment.name = "Category-\(category)-geometry"
                    attachment.lifetime = .keepAlways
                    activity.add(attachment)
                    attachScreenshot("Category-\(category)-unsettled", of: app)
                }
            }
            XCTAssertEqual(reachedResult, .completed,
                           "Category \(category) did not settle below the fixed strip")
            XCTAssertEqual(tab.frame.minY, tabY, accuracy: 1)
            XCTAssertEqual(basket.frame.minY, basketY, accuracy: 1)
            XCTAssertTrue(tab.isHittable)
            XCTAssertTrue(basket.isHittable)
            attachScreenshot("Category-\(category)-fixed-controls", of: app)
        }
    }

    @MainActor
    private func replaceText(in field: XCUIElement, with value: String, app: XCUIApplication) {
        reveal(field, in: app)
        field.tap()
        let previous = field.value as? String ?? ""
        // Backspace uses the actual field value and does not depend on a
        // platform-specific Select All menu or clipboard permissions.
        if !previous.isEmpty {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: previous.count))
        }
        field.typeText(value)
        let typedValue = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value),
                                                  object: field)
        XCTAssertEqual(XCTWaiter.wait(for: [typedValue], timeout: 5), .completed,
                       "Native field must retain every typed character")
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
    }

    @MainActor
    private func openDesignScreen(_ id: String, in app: XCUIApplication) {
        if !element("open-design-review", in: app).exists {
            tap("tab-profile", in: app)
        }
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
