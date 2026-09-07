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
        let cancellationReason = "Native TEST cancellation after relaunch: complete reason"
        replaceText(in: element("test-cancel-reason", in: app), with: cancellationReason, app: app)
        let cancelButton = element("test-cancel-order", in: app)
        XCTAssertTrue(cancelButton.isHittable, "Cancellation action must remain reachable while editing")
        XCTAssertTrue(cancelButton.isEnabled)
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.exists, "Exercise the first tap while the keyboard is open")
        XCTAssertLessThanOrEqual(cancelButton.frame.maxY, keyboard.frame.minY + 1)
        attachScreenshot("Connected-cancel-ready-with-keyboard", of: app)
        cancelButton.tap()
        assertLabel("Отменён", on: element("connected-order-state", in: app))
        let savedReason = app.staticTexts.matching(NSPredicate(format: "label == %@", cancellationReason)).firstMatch
        XCTAssertTrue(savedReason.waitForExistence(timeout: 10), "Server must preserve the complete typed cancellation reason")
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
        beginDemoRegistration(in: app)
        XCTAssertFalse(app.staticTexts["@"].exists, "Nickname must not have a decorative @ prefix")
        replaceText(in: element("nickname-input", in: app), with: "Keyboard Profile", app: app)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let save = element("nickname-save", in: app)
        let later = element("profile-fill-later", in: app)
        XCTAssertTrue(save.isEnabled, "Optional birthday and gender must not prevent saving")
        XCTAssertTrue(save.isHittable, "Save must be reachable without dismissing the keyboard")
        XCTAssertTrue(later.isHittable, "Postpone must remain reachable with the keyboard open")
        XCTAssertLessThanOrEqual(save.frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
        XCTAssertLessThanOrEqual(later.frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
        attachScreenshot("Registration-actions-above-keyboard", of: app)
        save.tap()
        assertScreen("M06", in: app)
        tap("tab-profile", in: app)
        assertScreen("M30", in: app)
        XCTAssertTrue(app.staticTexts["Keyboard Profile"].exists)
        attachScreenshot("Keyboard-local-profile", of: app)
    }

    @MainActor
    func testLocalDemoPhoneInputAndAccountLifecycle() throws {
        XCTContext.runActivity(named: "native-registration-v4-uidate") { activity in
            let bundleURL = Bundle(for: SmokeTests.self).bundleURL
            print("native-registration-v4-uidate test bundle: \(bundleURL.absoluteString)")
            let attachment = XCTAttachment(string: bundleURL.absoluteString)
            attachment.name = "native-registration-v4-uidate-test-bundle"
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
        XCTAssertFalse(app.staticTexts["@"].exists)
        replaceText(in: element("nickname-input", in: app), with: "Native Demo", app: app)
        chooseBirthday(day: 29, month: 2, year: 2000, in: app)
        tap("profile-gender-female", in: app)
        attachScreenshot("Registration-birthday-complete", of: app)
        tap("nickname-save", in: app)
        assertScreen("M06", in: app)
        tap("tab-profile", in: app)
        assertScreen("M30", in: app)
        XCTAssertTrue(app.staticTexts["Native Demo"].exists)
        XCTAssertTrue(app.staticTexts["+7 700 000-00-00"].exists)
        XCTAssertTrue(element("profile-birthday", in: app).label.contains("29.02.2000"))
        attachScreenshot("Demo-profile-saved", of: app)

        app.terminate()
        app.launch()
        assertScreen("M06", in: app)
        tap("tab-profile", in: app)
        XCTAssertTrue(element("demo-sign-out", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Native Demo"].exists)
        XCTAssertTrue(app.staticTexts["+7 700 000-00-00"].exists)
        XCTAssertTrue(element("profile-birthday", in: app).label.contains("29.02.2000"))
        attachScreenshot("Demo-profile-restored", of: app)
        tap("profile-birthday", in: app)
        assertScreen("M04", in: app)
        assertLabel("День рождения: 29", on: element("birthday-day", in: app))
        assertLabel("Месяц рождения: Февраль", on: element("birthday-month", in: app))
        assertLabel("Год рождения: 2000", on: element("birthday-year", in: app))
        XCTAssertEqual(element("nickname-input", in: app).value as? String, "Native Demo")
        openBirthdayPicker(part: "month", in: app)
        adjustNativeBirthday(day: 17, month: 3, year: 2001, in: app)
        attachScreenshot("Registration-native-date-draft", of: app)
        tap("birthday-picker-cancel", in: app)
        waitForBirthdayPickerToClose(in: app)
        assertLabel("День рождения: 29", on: element("birthday-day", in: app))
        assertLabel("Месяц рождения: Февраль", on: element("birthday-month", in: app))
        assertLabel("Год рождения: 2000", on: element("birthday-year", in: app))
        tap("birthday-clear", in: app)
        XCTAssertFalse(element("birthday-error", in: app).exists)
        XCTAssertTrue(element("nickname-save", in: app).isEnabled)
        // Cancel rather than persist the edited form; the birthday must survive.
        tap("profile-fill-later", in: app)
        assertScreen("M30", in: app)
        XCTAssertTrue(element("profile-birthday", in: app).label.contains("29.02.2000"))
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
    private func beginDemoRegistration(in app: XCUIApplication) {
        tap("tab-profile", in: app)
        if element("demo-sign-out", in: app).exists {
            tap("demo-sign-out", in: app)
        }
        tap("profile-sign-in", in: app)
        assertScreen("M02", in: app)
        replaceText(in: element("phone-input", in: app), with: "7000000000", app: app)
        tap("request-otp", in: app)
        assertScreen("M03", in: app)
        replaceText(in: element("otp-input", in: app), with: "123456", app: app)
        tap("confirm-otp", in: app)
        assertScreen("M04", in: app)
    }

    @MainActor
    private func chooseBirthday(day: Int, month: Int, year: Int, in app: XCUIApplication) {
        openBirthdayPicker(part: "day", in: app)
        adjustNativeBirthday(day: day, month: month, year: year, in: app)
        attachScreenshot("Registration-native-date-selected", of: app)
        tap("birthday-picker-confirm", in: app)
        waitForBirthdayPickerToClose(in: app)
        XCTAssertTrue(element("nickname-save", in: app).isHittable,
                      "Closing the system date picker must restore the fixed form action")
    }

    @MainActor
    private func openBirthdayPicker(part: String, in app: XCUIApplication) {
        tap("birthday-\(part)", in: app)
        let keyboardHidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"),
                                                       object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [keyboardHidden], timeout: 5), .completed)
        XCTAssertTrue(element("birthday-picker", in: app).waitForExistence(timeout: 5))
        for identifier in ["birthday-picker-confirm", "birthday-picker-cancel"] {
            let action = element(identifier, in: app)
            XCTAssertTrue(action.isHittable, "Date sheet action must be reachable: \(identifier)")
            XCTAssertGreaterThanOrEqual(action.frame.minY, app.frame.minY)
            XCTAssertLessThanOrEqual(action.frame.maxY, app.frame.maxY)
        }
    }

    @MainActor
    private func adjustNativeBirthday(day: Int, month: Int, year: Int, in app: XCUIApplication) {
        XCTAssertTrue(app.pickerWheels.firstMatch.waitForExistence(timeout: 5),
                      "Expected the real UIDatePicker wheels")
        let wheels = app.pickerWheels.allElementsBoundByIndex
        XCTAssertEqual(wheels.count, 3, "Date mode must expose day, month and year wheels")
        let values = wheels.map { $0.value as? String ?? "" }
        let attachment = XCTAttachment(string: values.enumerated().map { "\($0.offset): \($0.element)" }.joined(separator: "\n"))
        attachment.name = "Native-birthday-wheel-values"
        attachment.lifetime = .keepAlways
        add(attachment)
        let nominative = ["январь", "февраль", "март", "апрель", "май", "июнь",
                          "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"]
        let genitive = ["января", "февраля", "марта", "апреля", "мая", "июня",
                        "июля", "августа", "сентября", "октября", "ноября", "декабря"]
        guard wheels.count == 3, (1...12).contains(month),
              let yearIndex = values.firstIndex(where: { (Int($0.filter(\.isNumber)) ?? 0) >= 1900 }),
              let monthIndex = values.firstIndex(where: { nominative.contains($0.lowercased()) || genitive.contains($0.lowercased()) }),
              let dayIndex = values.indices.first(where: { $0 != yearIndex && $0 != monthIndex }) else {
            XCTFail("Expected Russian date wheel values; observed \(values)")
            return
        }
        // Infer wheel order and Russian case from the actual native values.
        // Day 1 avoids transient invalid dates while changing month/year.
        adjustNumberWheel(wheels[dayIndex], to: 1)
        adjustNumberWheel(wheels[yearIndex], to: year)
        var monthValue = nominative.contains(values[monthIndex].lowercased())
            ? nominative[month - 1] : genitive[month - 1]
        if values[monthIndex].first?.isUppercase == true {
            monthValue = monthValue.prefix(1).uppercased() + String(monthValue.dropFirst())
        }
        adjustWheel(wheels[monthIndex], to: monthValue)
        adjustNumberWheel(wheels[dayIndex], to: day)
    }

    @MainActor
    private func adjustNumberWheel(_ wheel: XCUIElement, to value: Int) {
        let previous = wheel.value as? String ?? ""
        let next = previous.replacingOccurrences(of: "[0-9]+", with: String(value), options: .regularExpression)
        XCTAssertNotEqual(previous, "", "Native numeric wheel must expose its current value")
        adjustWheel(wheel, to: next)
    }

    @MainActor
    private func adjustWheel(_ wheel: XCUIElement, to value: String) {
        wheel.adjust(toPickerWheelValue: value)
        let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: wheel)
        XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 5), .completed,
                       "Native picker must select \(value); observed \(String(describing: wheel.value))")
    }

    @MainActor
    private func waitForBirthdayPickerToClose(in app: XCUIApplication) {
        let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"),
                                              object: element("birthday-picker", in: app))
        XCTAssertEqual(XCTWaiter.wait(for: [closed], timeout: 5), .completed)
    }

    @MainActor
    private func replaceText(in field: XCUIElement, with value: String, app: XCUIApplication) {
        reveal(field, in: app)
        field.tap()
        let previous = field.value as? String ?? ""
        if !previous.isEmpty && field.elementType == .textView {
            // A multiline tap may put the caret at the start or in the middle.
            // Select the complete native value before deleting, without relying
            // on localized edit-menu labels or using the system clipboard.
            field.typeKey("a", modifierFlags: .command)
            field.typeText(XCUIKeyboardKey.delete.rawValue)
            let cleared = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", ""),
                                                     object: field)
            XCTAssertEqual(XCTWaiter.wait(for: [cleared], timeout: 5), .completed,
                           "Replacement must clear the complete native field value")
        } else if !previous.isEmpty {
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
