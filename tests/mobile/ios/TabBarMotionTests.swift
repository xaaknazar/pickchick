import XCTest

final class TabBarMotionTests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor
    func testTabsKeepRespondingAndGuestOrdersStayProtected() throws {
        // A dedicated simulator with no account. No OTP, order, quote, invoice or payment.
        let app = XCUIApplication(bundleIdentifier: "kz.pickchick.app")
        app.launch()
        XCTAssertTrue(element("screen-M06", app).waitForExistence(timeout: 45))
        let menu = element("tab-menu", app)
        let games = element("tab-events", app)
        let orders = element("tab-orders", app)
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        XCTAssertTrue(games.isHittable)
        attach("01-menu", app)

        games.tap()
        XCTAssertTrue(element("screen-M26", app).waitForExistence(timeout: 10))
        XCTAssertTrue(games.isSelected)
        attach("02-games", app)
        menu.tap()
        XCTAssertTrue(element("screen-M06", app).waitForExistence(timeout: 10))
        XCTAssertTrue(menu.isSelected)

        // Repeated reversals must leave the final destination present and tappable.
        // XCTest still waits for application idle: this is not a sub-frame stress test.
        let menuPoint = menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let gamesPoint = games.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        for _ in 0..<6 { gamesPoint.tap(); menuPoint.tap() }
        gamesPoint.tap()
        XCTAssertTrue(element("screen-M26", app).waitForExistence(timeout: 10))
        XCTAssertTrue(games.isSelected)
        XCTAssertTrue(menu.isHittable)
        attach("03-after-rapid-switches", app)

        orders.tap()
        XCTAssertTrue(element("account-required-login", app).waitForExistence(timeout: 15))
        XCTAssertFalse(element("screen-M19", app).isHittable)
        attach("04-guest-orders-auth", app)
    }

    @MainActor private func element(_ id: String, _ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    @MainActor
    func testNativeSelectionCanBeDragged() throws {
        let app = XCUIApplication(bundleIdentifier: "kz.pickchick.app")
        app.launch()
        XCTAssertTrue(element("screen-M06", app).waitForExistence(timeout: 45))
        let menu = element("tab-menu", app)
        let games = element("tab-events", app)
        let start = menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let end = games.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.2, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0)
        XCTAssertTrue(element("screen-M26", app).waitForExistence(timeout: 10))
        XCTAssertTrue(games.isSelected)
        XCTAssertTrue(menu.isHittable)
        attach("native-selector-drag", app)
    }

    @MainActor
    func testCartStaysAboveTabsAfterSwitching() throws {
        let app = XCUIApplication(bundleIdentifier: "kz.pickchick.app")
        app.launch()
        XCTAssertTrue(element("screen-M06", app).waitForExistence(timeout: 45))
        let cards = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH %@ AND NOT identifier BEGINSWITH %@",
            "product-", "product-photo-"
        ))
        XCTAssertTrue(cards.firstMatch.waitForExistence(timeout: 30))
        for _ in 0..<3 {
            if cards.allElementsBoundByIndex.contains(where: { $0.isEnabled && $0.isHittable }) { break }
            app.swipeUp()
        }
        guard let product = cards.allElementsBoundByIndex.first(where: { $0.isEnabled && $0.isHittable }) else {
            throw XCTSkip("No available product in the public catalog")
        }
        product.tap()
        let add = element("product-add", app)
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        guard add.isEnabled else { throw XCTSkip("Public availability prevents adding to the local cart") }
        add.tap() // Local guest basket only. No checkout, quote, order or payment.
        let cart = element("open-cart", app)
        XCTAssertTrue(cart.waitForExistence(timeout: 15))
        for tab in ["tab-menu", "tab-events", "tab-menu"] {
            element(tab, app).tap()
            XCTAssertTrue(cart.waitForExistence(timeout: 10))
            XCTAssertTrue(cart.isHittable)
            XCTAssertLessThanOrEqual(cart.frame.maxY, element(tab, app).frame.minY)
            attach("cart-above-\(tab)", app)
        }
        cart.tap()
        XCTAssertTrue(element("cart-close", app).waitForExistence(timeout: 10))
        attach("guest-cart-opened", app)
    }

    @MainActor private func attach(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
