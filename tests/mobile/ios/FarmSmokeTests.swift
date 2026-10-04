import XCTest

// External UI runner only. No session injection, authentication messages,
// purchases, harvests, sales, food orders, or bank actions are performed.
final class FarmSmokeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testAuthenticatedFarmLandscapeAndReadOnlyPanels() throws {
        let app = XCUIApplication(bundleIdentifier: "kz.pickchick.app")
        app.launch()
        XCTAssertTrue(element("screen-M06", in: app).waitForExistence(timeout: 30))
        app.open(URL(string: "pickchick://games/pick-farm")!)
        let field = element("pick-farm-screen", in: app)
        guard field.waitForExistence(timeout: 30) else {
            screenshot("Farm-unavailable-or-auth-required", app: app)
            if element("account-required", in: app).exists || element("auth-welcome", in: app).exists {
                throw XCTSkip("Log in normally on this device before the authenticated smoke. No OTP is requested by this test.")
            }
            XCTFail("The compiled, enabled farm did not load. Check its feature flag, API availability and customer session.")
            return
        }
        let landscape = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in app.frame.width > app.frame.height }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [landscape], timeout: 10), .completed)
        for id in ["pick-farm-shop", "pick-farm-tool-harvest", "pick-farm-tool-plant",
                   "pick-farm-tool-move", "pick-farm-tool-remove"] {
            assertVisibleControl(element(id, in: app), inside: app)
        }
        assertVisibleControl(storageButton(in: app), inside: app)
        assertVisibleControl(button("Заказы", in: app), inside: app)
        screenshot("Farm-landscape-native-assets", app: app)

        // Only camera actions. Keep the inspect tool; never tap a field cell.
        button("Приблизить ферму", in: app).tap()
        screenshot("Farm-zoom-native", app: app)
        button("Отдалить ферму", in: app).tap()
        button("Вернуть ферму в центр", in: app).tap()

        element("pick-farm-shop", in: app).tap()
        XCTAssertTrue(element("pick-farm-panel-shop", in: app).waitForExistence(timeout: 10))
        screenshot("Farm-shop-first-crops-native", app: app)
        for crop in ["carrot", "tomato", "strawberry", "sunflower", "tulip", "apple"] {
            let seed = element("pick-farm-seed-\(crop)", in: app)
            XCTAssertTrue(seed.waitForExistence(timeout: 5))
            // Scroll from an already visible crop card; a drag cannot select a seed.
            for _ in 0..<6 where !seed.isHittable {
                let visible = ["carrot", "tomato", "strawberry", "sunflower", "tulip", "apple"]
                    .map { element("pick-farm-seed-\($0)", in: app) }
                    .last { $0.exists && $0.isHittable }
                guard let visible else { XCTFail("No visible seed rail to scroll"); return }
                visible.swipeLeft()
            }
            XCTAssertTrue(seed.isHittable, "Crop must be discoverable: \(crop)")
        }
        screenshot("Farm-shop-last-crops-native", app: app)
        button("Закрыть панель", in: app).tap()
        for (tool, panel) in [("storage", "storage"), ("orders", "orders")] {
            if tool == "storage" { storageButton(in: app).tap() }
            else { button("Заказы", in: app).tap() }
            XCTAssertTrue(element("pick-farm-panel-\(panel)", in: app).waitForExistence(timeout: 10))
            screenshot("Farm-\(panel)-native-assets", app: app)
            button("Закрыть панель", in: app).tap()
        }
        button("Выйти из фермы", in: app).tap()
        let portrait = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in app.frame.height > app.frame.width }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [portrait], timeout: 10), .completed)
        screenshot("Farm-exit-restores-portrait", app: app)
    }

    @MainActor
    func testGuestFarmRequiresAccountWithoutRequestingOtp() throws {
        guard ProcessInfo.processInfo.environment["PICKCHICK_FARM_GUEST_SMOKE"] == "1" else {
            throw XCTSkip("Optional guest scenario requires an already signed-out device and explicit runner opt-in.")
        }
        let app = XCUIApplication(bundleIdentifier: "kz.pickchick.app")
        app.launch()
        app.open(URL(string: "pickchick://games/pick-farm")!)
        let guest = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.element("account-required", in: app).exists || self.element("auth-welcome", in: app).exists
        }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [guest], timeout: 30), .completed)
        XCTAssertFalse(element("pick-farm-screen", in: app).exists)
        screenshot("Farm-guest-account-gate", app: app)
    }

    @MainActor
    private func element(_ id: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    @MainActor
    private func button(_ label: String, in app: XCUIApplication) -> XCUIElement {
        let target = app.buttons.matching(identifier: label).firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 10), "Missing control: \(label)")
        XCTAssertTrue(target.isHittable, "Hidden control: \(label)")
        return target
    }

    @MainActor
    private func storageButton(in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Склад ")).firstMatch
    }

    @MainActor
    private func assertVisibleControl(_ control: XCUIElement, inside app: XCUIApplication) {
        XCTAssertTrue(control.waitForExistence(timeout: 10))
        XCTAssertTrue(control.isHittable, "Control must be reachable: \(control.identifier)")
        XCTAssertTrue(app.frame.insetBy(dx: -1, dy: -1).contains(control.frame),
                      "Control is clipped by the viewport: \(control.identifier)")
    }

    @MainActor
    private func screenshot(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
