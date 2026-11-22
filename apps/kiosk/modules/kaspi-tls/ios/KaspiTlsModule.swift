import CryptoKit
import ExpoModulesCore
import Foundation
import Security

/// The kiosk's own Kaspi Smart POS over HTTPS on the restaurant LAN (ADR-0018, point 1).
///
/// With «Защита интеграции» on, the terminal speaks only TLS on 8080 with a self-signed
/// certificate, addressed by its IP. There is no CA trust and no name check: the server trust is
/// accepted only when the SHA-256 of the leaf certificate (DER, lowercase hex) equals the pin the
/// kiosk stored at the first link. Otherwise the challenge is cancelled, so no byte of the request
/// (path, token) leaves the iPad. Every call uses its own ephemeral URLSession (no cache, cookies,
/// credentials, proxy or TLS session reuse), so the trust challenge comes on every call.
///
/// Answers are plain dictionaries, never rejections (the JS side in src/kaspi-terminal.ts maps
/// them): request → { ok: true, status, body } | { ok: false, failure, sent };
/// probe → { transport: "https", sha256 } | { transport: "http" } | { transport: "none" }.
public class KaspiTlsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KaspiTls")

    /// TLS handshake only: reports the presented leaf and cancels (nothing is sent).
    AsyncFunction("probe") { (host: String, port: Int, timeoutMs: Int, promise: Promise) in
      KaspiTlsCall.start(
        host: host, port: port, path: "/v2/deviceinfo", token: "", pin: nil,
        timeoutMs: timeoutMs
      ) { promise.resolve($0) }
    }

    /// One GET, sent only after the presented leaf matched `sha256`.
    AsyncFunction("request") {
      (
        host: String, port: Int, path: String, token: String, sha256: String, timeoutMs: Int,
        promise: Promise
      ) in
      guard KaspiTlsCall.pinPattern(sha256) else {
        promise.resolve(["ok": false, "failure": "CONNECT", "sent": false])
        return
      }
      KaspiTlsCall.start(
        host: host, port: port, path: path, token: token, pin: sha256, timeoutMs: timeoutMs
      ) { promise.resolve($0) }
    }
  }
}

final class KaspiTlsCall: NSObject, URLSessionDataDelegate {
  private static let maxAnswer = 64 * 1024
  /// No TCP connection at all: the probe reports "none" (nothing listens at the address).
  private static let silent: Set<URLError.Code> = [
    .cannotConnectToHost, .timedOut, .notConnectedToInternet, .cannotFindHost, .dnsLookupFailed,
  ]

  /// nil: probe (capture the leaf, then cancel). Otherwise the pin the leaf must match.
  private let pin: String?
  private let done: ([String: Any]) -> Void
  private var presented: String?
  private var trusted = false
  private var rejected = false
  private var tooLong = false
  private var status = 0
  private var data = Data()
  private var finished = false

  private init(pin: String?, done: @escaping ([String: Any]) -> Void) {
    self.pin = pin
    self.done = done
  }

  static func pinPattern(_ value: String) -> Bool {
    value.count == 64 && value.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
  }

  private static func ipv4(_ value: String) -> Bool {
    let parts = value.split(separator: ".", omittingEmptySubsequences: false)
    return parts.count == 4
      && parts.allSatisfy { part in
        !part.isEmpty && part.count <= 3 && part.allSatisfy(\.isASCII) && part.allSatisfy(\.isNumber)
          && (Int(part) ?? 256) <= 255
      }
  }

  static func start(
    host: String, port: Int, path: String, token: String, pin: String?, timeoutMs: Int,
    done: @escaping ([String: Any]) -> Void
  ) {
    let probe = pin == nil
    guard ipv4(host), (1...65535).contains(port), path.hasPrefix("/v2/"),
      let url = URL(string: "https://\(host):\(port)\(path)")
    else {
      done(probe ? ["transport": "none"] : ["ok": false, "failure": "CONNECT", "sent": false])
      return
    }
    let timeout = Double(min(max(timeoutMs, 500), 180_000)) / 1000
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = timeout
    config.timeoutIntervalForResource = timeout
    config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    config.urlCache = nil
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.urlCredentialStorage = nil
    config.waitsForConnectivity = false
    config.connectionProxyDictionary = [:]
    config.httpMaximumConnectionsPerHost = 1
    config.tlsMinimumSupportedProtocolVersion = .TLSv12

    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
    request.httpMethod = "GET"
    request.httpShouldHandleCookies = false
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if !token.isEmpty { request.setValue(token, forHTTPHeaderField: "accesstoken") }

    let delegate = KaspiTlsCall(pin: pin, done: done)
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    let session = URLSession(configuration: config, delegate: delegate, delegateQueue: queue)
    session.dataTask(with: request).resume()
    // The session keeps the delegate until the task ends, then lets both go.
    session.finishTasksAndInvalidate()
  }

  private static func leafSha256(_ trust: SecTrust) -> String? {
    guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
      let leaf = chain.first
    else { return nil }
    let der = SecCertificateCopyData(leaf) as Data
    return SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
  }

  private func finish(_ value: [String: Any]) {
    if finished { return }
    finished = true
    done(value)
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let trust = challenge.protectionSpace.serverTrust
    else {
      // The terminal asks no client certificate or password: anything else is not it.
      rejected = pin != nil
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    let leaf = Self.leafSha256(trust)
    presented = leaf
    if let pin = pin, let leaf = leaf, leaf == pin {
      trusted = true
      completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
      // Probe, or another certificate: cancelled before the request is sent.
      rejected = pin != nil
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if response.expectedContentLength > Int64(Self.maxAnswer) {
      tooLong = true
      completionHandler(.cancel)
      return
    }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
    if data.count + chunk.count > Self.maxAnswer {
      tooLong = true
      dataTask.cancel()
      return
    }
    data.append(chunk)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?)
  {
    let code = (error as? URLError)?.code
    if pin == nil {
      if let presented = presented {
        finish(["transport": "https", "sha256": presented])
      } else if let code = code, Self.silent.contains(code) {
        finish(["transport": "none"])
      } else {
        // TCP answered but TLS did not: maybe the plain HTTP API (checked by the JS side).
        finish(["transport": "http"])
      }
      return
    }
    if rejected {
      finish(["ok": false, "failure": "CERTIFICATE", "sent": false])
    } else if tooLong {
      finish(["ok": false, "failure": "ANSWER", "sent": true])
    } else if error != nil {
      let timeout = code == .timedOut
      if trusted {
        finish(["ok": false, "failure": timeout ? "TIMEOUT" : "CONNECTION", "sent": true])
      } else {
        finish(["ok": false, "failure": timeout ? "TIMEOUT" : "CONNECT", "sent": false])
      }
    } else if !trusted {
      // An answer without our pin check would mean the system trusted it on its own: never use
      // it. The request may have left, so the JS side treats it as lost, not as «not sent».
      finish(["ok": false, "failure": "CONNECTION", "sent": true])
    } else if let body = String(data: data, encoding: .utf8) {
      finish(["ok": true, "status": status, "body": body])
    } else {
      finish(["ok": false, "failure": "ANSWER", "sent": true])
    }
  }
}
