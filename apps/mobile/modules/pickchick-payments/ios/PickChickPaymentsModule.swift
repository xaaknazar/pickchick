import ExpoModulesCore
import PassKit
import Security

/// Card details for the TipTopPay card cryptogram. Never stored or logged.
struct CardArgs: Record {
  @Field var number: String = ""
  @Field var expMonth: String = ""  // "MM"
  @Field var expYear: String = ""  // "YY"
  @Field var cvv: String = ""
  @Field var publicId: String = ""
  @Field var publicKeyPem: String = ""
  @Field var keyVersion: Int = 0
}

struct ApplePayArgs: Record {
  @Field var merchantId: String = ""
  @Field var label: String = "PickChick"
  @Field var amount: String = ""  // "1250.00"
  @Field var currency: String = "KZT"
  @Field var countryCode: String = "KZ"
}

enum PaymentsError: String, Error {
  case invalidCard = "INVALID_CARD"
  case invalidKey = "INVALID_KEY"
  case encryption = "ENCRYPTION"
  case unavailable = "APPLE_PAY_UNAVAILABLE"
  case cancelled = "CANCELLED"
  case busy = "BUSY"
}

/// TipTopPay checkout of PickChick (18.11.2026): card cryptogram (same packet as the official
/// TipTopPay SDK: RSA PKCS#1 v1.5 of "PAN@YYMM@CVV@PublicId", wrapped in a CloudCard JSON) and the
/// native Apple Pay sheet. The server charges the packet; this module never talks to the bank.
public class PickChickPaymentsModule: Module {
  private var applePay: ApplePaySession?

  public func definition() -> ModuleDefinition {
    Name("PickChickPayments")

    AsyncFunction("cardCryptogram") { (args: CardArgs) throws -> String in
      try Self.cryptogram(args)
    }

    Function("canMakeApplePay") { () -> Bool in
      PKPaymentAuthorizationController.canMakePayments(usingNetworks: Self.networks)
    }

    /// Shows the sheet; resolves with the payment packet once the customer authorizes. The sheet
    /// stays open (spinner) until completeApplePay reports the server's result.
    AsyncFunction("startApplePay") { (args: ApplePayArgs, promise: Promise) in
      if self.applePay != nil {
        promise.reject(PaymentsError.busy.rawValue, "Apple Pay is already open")
        return
      }
      guard !args.merchantId.isEmpty,
        PKPaymentAuthorizationController.canMakePayments(usingNetworks: Self.networks)
      else {
        promise.reject(PaymentsError.unavailable.rawValue, "Apple Pay is not available")
        return
      }
      let request = PKPaymentRequest()
      request.merchantIdentifier = args.merchantId
      request.supportedNetworks = Self.networks
      request.merchantCapabilities = .threeDSecure
      request.countryCode = args.countryCode
      request.currencyCode = args.currency
      request.paymentSummaryItems = [
        PKPaymentSummaryItem(
          label: args.label, amount: NSDecimalNumber(string: args.amount), type: .final)
      ]
      let session = ApplePaySession(promise: promise) { [weak self] in self?.applePay = nil }
      self.applePay = session
      session.present(request)
    }.runOnQueue(.main)

    AsyncFunction("completeApplePay") { (success: Bool) in
      self.applePay?.complete(success: success)
    }.runOnQueue(.main)
  }

  static var networks: [PKPaymentNetwork] {
    var list: [PKPaymentNetwork] = [.visa, .masterCard, .JCB, .maestro]
    if #available(iOS 14.5, *) { list.append(.mir) }
    return list
  }

  static func cryptogram(_ args: CardArgs) throws -> String {
    let number = args.number.filter(\.isNumber)
    let month = args.expMonth.filter(\.isNumber)
    let year = args.expYear.filter(\.isNumber)
    let cvv = args.cvv.filter(\.isNumber)
    guard (13...19).contains(number.count), month.count == 2, year.count == 2,
      (3...4).contains(cvv.count), !args.publicId.isEmpty
    else { throw PaymentsError.invalidCard }
    let key = try rsaKey(pem: args.publicKeyPem)
    let plain = "\(number)@\(year)\(month)@\(cvv)@\(args.publicId)"
    var error: Unmanaged<CFError>?
    guard
      let encrypted = SecKeyCreateEncryptedData(
        key, .rsaEncryptionPKCS1, Data(plain.utf8) as CFData, &error) as Data?
    else { throw PaymentsError.encryption }
    var version = String(args.keyVersion)
    if version.count % 2 == 1 { version = "0" + version }
    let packet: [String: Any] = [
      "Type": "CloudCard",
      "BrowserInfoBase64": "",
      "Format": 1,
      "CardInfo": [
        "FirstSixDigits": String(number.prefix(6)),
        "LastFourDigits": String(number.suffix(4)),
        "ExpDateYear": year,
        "ExpDateMonth": month,
      ],
      "KeyVersion": version,
      "Value": encrypted.base64EncodedString(),
    ]
    let json = try JSONSerialization.data(withJSONObject: packet, options: [.withoutEscapingSlashes])
    return json.base64EncodedString()
  }

  /// X.509 SubjectPublicKeyInfo PEM -> SecKey (PKCS#1 RSAPublicKey inside the BIT STRING).
  static func rsaKey(pem: String) throws -> SecKey {
    let body = pem
      .replacingOccurrences(of: "-----BEGIN PUBLIC KEY-----", with: "")
      .replacingOccurrences(of: "-----END PUBLIC KEY-----", with: "")
      .components(separatedBy: .whitespacesAndNewlines).joined()
    guard let der = Data(base64Encoded: body) else { throw PaymentsError.invalidKey }
    let pkcs1 = try spkiToPkcs1([UInt8](der))
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
      kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
    ]
    guard let key = SecKeyCreateWithData(Data(pkcs1) as CFData, attributes as CFDictionary, nil)
    else { throw PaymentsError.invalidKey }
    return key
  }

  /// Minimal DER walk: SEQUENCE { SEQUENCE { algorithm }, BIT STRING { 0x00, RSAPublicKey } }.
  static func spkiToPkcs1(_ der: [UInt8]) throws -> [UInt8] {
    var index = 0
    func length() throws -> Int {
      guard index < der.count else { throw PaymentsError.invalidKey }
      let first = Int(der[index]); index += 1
      if first < 0x80 { return first }
      let count = first & 0x7f
      guard count > 0, count <= 4, index + count <= der.count else { throw PaymentsError.invalidKey }
      var value = 0
      for _ in 0..<count { value = (value << 8) | Int(der[index]); index += 1 }
      return value
    }
    func expect(_ tag: UInt8) throws -> Int {
      guard index < der.count, der[index] == tag else { throw PaymentsError.invalidKey }
      index += 1
      return try length()
    }
    _ = try expect(0x30)
    let algorithm = try expect(0x30)
    index += algorithm
    let bits = try expect(0x03)
    guard index < der.count, der[index] == 0x00, index + bits <= der.count else {
      throw PaymentsError.invalidKey
    }
    return Array(der[(index + 1)..<(index + bits)])
  }
}

/// One Apple Pay sheet: authorization hands the packet to JS and waits for the server's result.
final class ApplePaySession: NSObject, PKPaymentAuthorizationControllerDelegate {
  private var promise: Promise?
  private var completion: ((PKPaymentAuthorizationResult) -> Void)?
  private let finished: () -> Void
  private var controller: PKPaymentAuthorizationController?

  init(promise: Promise, finished: @escaping () -> Void) {
    self.promise = promise
    self.finished = finished
  }

  func present(_ request: PKPaymentRequest) {
    let controller = PKPaymentAuthorizationController(paymentRequest: request)
    controller.delegate = self
    self.controller = controller
    controller.present { presented in
      if !presented { self.fail(PaymentsError.unavailable) }
    }
  }

  func complete(success: Bool) {
    completion?(PKPaymentAuthorizationResult(status: success ? .success : .failure, errors: nil))
    completion = nil
  }

  func paymentAuthorizationController(
    _ controller: PKPaymentAuthorizationController, didAuthorizePayment payment: PKPayment,
    handler completion: @escaping (PKPaymentAuthorizationResult) -> Void
  ) {
    guard let packet = Self.packet(payment), let promise = promise else {
      completion(PKPaymentAuthorizationResult(status: .failure, errors: nil))
      return
    }
    self.completion = completion
    self.promise = nil
    promise.resolve(packet)
  }

  func paymentAuthorizationControllerDidFinish(_ controller: PKPaymentAuthorizationController) {
    controller.dismiss {
      // Closed before authorizing: the customer cancelled.
      self.fail(PaymentsError.cancelled)
      // Closed while JS still waits for the server: the sheet can no longer show the result.
      self.completion = nil
      self.controller = nil
      self.finished()
    }
  }

  private func fail(_ error: PaymentsError) {
    promise?.reject(error.rawValue, "Apple Pay was not completed")
    promise = nil
  }

  /// The envelope the TipTopPay SDK sends as CardCryptogramPacket (PKPayment+Convert.swift).
  static func packet(_ payment: PKPayment) -> String? {
    guard
      let data = try? JSONSerialization.jsonObject(
        with: payment.token.paymentData, options: .mutableContainers)
    else { return nil }
    let type: String
    switch payment.token.paymentMethod.type {
    case .debit: type = "debit"
    case .credit: type = "credit"
    case .store: type = "store"
    case .prepaid: type = "prepaid"
    default: type = "unknown"
    }
    let envelope: [String: Any] = [
      "paymentData": data,
      "transactionIdentifier": payment.token.transactionIdentifier,
      "paymentMethod": [
        "network": payment.token.paymentMethod.network?.rawValue ?? "",
        "type": type,
        "displayName": payment.token.paymentMethod.displayName ?? "",
      ],
    ]
    guard let json = try? JSONSerialization.data(withJSONObject: envelope) else { return nil }
    return String(data: json, encoding: .utf8)
  }
}
