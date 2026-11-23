import ExpoModulesCore
import PassKit

/// The official Apple Pay artwork drawn by PassKit (owner 23.11.2026: «поставь прям хороший
/// логотип, чтобы все было ровно»). A logo-only PKPaymentButton (" Pay"); the system draws and
/// localizes it, so the mark is always Apple's own and pixel-aligned. It never takes touches:
/// the React Native pressable around it pays, so the guarded checkout flow stays the same.
public final class ApplePayMarkView: ExpoView {
  private var button: PKPaymentButton?
  private var style: PKPaymentButtonStyle = .black
  private var radius: CGFloat = 6

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    isUserInteractionEnabled = false
    rebuild()
  }

  func setMarkStyle(_ name: String) {
    let next: PKPaymentButtonStyle =
      name == "white" ? .white : name == "whiteOutline" ? .whiteOutline : .black
    guard next != style else { return }
    style = next
    rebuild()
  }

  func setRadius(_ value: Double) {
    radius = CGFloat(value)
    button?.cornerRadius = radius
    layer.cornerRadius = radius
  }

  private func rebuild() {
    button?.removeFromSuperview()
    let next = PKPaymentButton(paymentButtonType: .plain, paymentButtonStyle: style)
    next.cornerRadius = radius
    next.isUserInteractionEnabled = false
    next.isAccessibilityElement = false
    next.frame = bounds
    next.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(next)
    button = next
    layer.cornerRadius = radius
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    button?.frame = bounds
  }
}
