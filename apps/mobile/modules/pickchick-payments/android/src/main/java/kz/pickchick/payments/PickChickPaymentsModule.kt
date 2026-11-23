package kz.pickchick.payments

import android.app.Activity
import android.util.Base64
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.wallet.AutoResolveHelper
import com.google.android.gms.wallet.IsReadyToPayRequest
import com.google.android.gms.wallet.PaymentData
import com.google.android.gms.wallet.PaymentDataRequest
import com.google.android.gms.wallet.PaymentsClient
import com.google.android.gms.wallet.Wallet
import com.google.android.gms.wallet.WalletConstants
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.security.KeyFactory
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import org.json.JSONArray
import org.json.JSONObject

/** Card details for the TipTopPay card cryptogram. Never stored or logged. */
class CardArgs : Record {
  @Field var number: String = ""
  @Field var expMonth: String = "" // "MM"
  @Field var expYear: String = "" // "YY"
  @Field var cvv: String = ""
  @Field var publicId: String = ""
  @Field var publicKeyPem: String = ""
  @Field var keyVersion: Int = 0
}

class GooglePayArgs : Record {
  @Field var gateway: String = ""
  @Field var gatewayMerchantId: String = ""
  @Field var merchantName: String = "PickChick"
  @Field var amount: String = "" // "1250.00"
  @Field var currency: String = "KZT"
  @Field var countryCode: String = "KZ"
  @Field var test: Boolean = true
}

class PaymentsException(code: String, message: String) : CodedException(code, message, null)

private const val GOOGLE_PAY_REQUEST = 7311

/**
 * TipTopPay checkout of PickChick (18.11.2026): card cryptogram (same packet as the official
 * TipTopPay SDK: RSA/ECB/PKCS1Padding of "PAN@YYMM@CVV@PublicId", wrapped in a CloudCard JSON)
 * and the native Google Pay sheet (PAYMENT_GATEWAY tokenization for TipTopPay). The server
 * charges the packet; this module never talks to the bank.
 */
class PickChickPaymentsModule : Module() {
  private var googlePay: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("PickChickPayments")

    AsyncFunction("cardCryptogram") { args: CardArgs -> cryptogram(args) }

    AsyncFunction("isGooglePayReady") { args: GooglePayArgs, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      val request = IsReadyToPayRequest.fromJson(readyJson(args).toString())
      client(activity, args.test).isReadyToPay(request).addOnCompleteListener { task ->
        promise.resolve(task.isSuccessful && task.result == true)
      }
    }

    /** Opens the Google Pay sheet; resolves with the gateway token (CardCryptogramPacket). */
    AsyncFunction("startGooglePay") { args: GooglePayArgs, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject(PaymentsException("GOOGLE_PAY_UNAVAILABLE", "No activity"))
        return@AsyncFunction
      }
      if (googlePay != null) {
        promise.reject(PaymentsException("BUSY", "Google Pay is already open"))
        return@AsyncFunction
      }
      if (args.gateway.isEmpty() || args.gatewayMerchantId.isEmpty()) {
        promise.reject(PaymentsException("GOOGLE_PAY_UNAVAILABLE", "Gateway is not configured"))
        return@AsyncFunction
      }
      googlePay = promise
      val request = PaymentDataRequest.fromJson(paymentJson(args).toString())
      AutoResolveHelper.resolveTask(
        client(activity, args.test).loadPaymentData(request),
        activity,
        GOOGLE_PAY_REQUEST,
      )
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != GOOGLE_PAY_REQUEST) return@OnActivityResult
      val promise = googlePay ?: return@OnActivityResult
      googlePay = null
      when (payload.resultCode) {
        Activity.RESULT_OK -> {
          val data = payload.data?.let { PaymentData.getFromIntent(it) }
          val token =
            data?.let {
              runCatching {
                  JSONObject(it.toJson())
                    .getJSONObject("paymentMethodData")
                    .getJSONObject("tokenizationData")
                    .getString("token")
                }
                .getOrNull()
            }
          if (token.isNullOrEmpty())
            promise.reject(PaymentsException("GOOGLE_PAY_FAILED", "No payment token"))
          else promise.resolve(token)
        }
        Activity.RESULT_CANCELED ->
          promise.reject(PaymentsException("CANCELLED", "Google Pay was cancelled"))
        else -> {
          val status = payload.data?.let { AutoResolveHelper.getStatusFromIntent(it) }
          promise.reject(
            PaymentsException("GOOGLE_PAY_FAILED", "Google Pay error ${status?.statusCode ?: 0}")
          )
        }
      }
    }
  }

  private fun client(activity: Activity, test: Boolean): PaymentsClient =
    Wallet.getPaymentsClient(
      activity,
      Wallet.WalletOptions.Builder()
        .setEnvironment(
          if (test) WalletConstants.ENVIRONMENT_TEST else WalletConstants.ENVIRONMENT_PRODUCTION
        )
        .build(),
    )

  private fun cardMethod(args: GooglePayArgs?): JSONObject {
    val method =
      JSONObject()
        .put("type", "CARD")
        .put(
          "parameters",
          JSONObject()
            .put("allowedAuthMethods", JSONArray(listOf("PAN_ONLY", "CRYPTOGRAM_3DS")))
            .put("allowedCardNetworks", JSONArray(listOf("VISA", "MASTERCARD", "JCB")))
            .put("allowPrepaidCards", true)
            .put("billingAddressRequired", false),
        )
    if (args != null)
      method.put(
        "tokenizationSpecification",
        JSONObject()
          .put("type", "PAYMENT_GATEWAY")
          .put(
            "parameters",
            JSONObject()
              .put("gateway", args.gateway)
              .put("gatewayMerchantId", args.gatewayMerchantId),
          ),
      )
    return method
  }

  private fun readyJson(args: GooglePayArgs) =
    JSONObject()
      .put("apiVersion", 2)
      .put("apiVersionMinor", 0)
      .put("allowedPaymentMethods", JSONArray().put(cardMethod(null)))

  private fun paymentJson(args: GooglePayArgs) =
    JSONObject()
      .put("apiVersion", 2)
      .put("apiVersionMinor", 0)
      .put("allowedPaymentMethods", JSONArray().put(cardMethod(args)))
      .put(
        "transactionInfo",
        JSONObject()
          .put("totalPrice", args.amount)
          .put("totalPriceStatus", "FINAL")
          .put("currencyCode", args.currency)
          .put("countryCode", args.countryCode),
      )
      .put("merchantInfo", JSONObject().put("merchantName", args.merchantName))
      .put("emailRequired", false)

  private fun cryptogram(args: CardArgs): String {
    val number = args.number.filter { it.isDigit() }
    val month = args.expMonth.filter { it.isDigit() }
    val year = args.expYear.filter { it.isDigit() }
    val cvv = args.cvv.filter { it.isDigit() }
    if (
      number.length !in 13..19 ||
        month.length != 2 ||
        year.length != 2 ||
        cvv.length !in 3..4 ||
        args.publicId.isEmpty()
    )
      throw PaymentsException("INVALID_CARD", "Invalid card")
    val body =
      args.publicKeyPem
        .replace("-----BEGIN PUBLIC KEY-----", "")
        .replace("-----END PUBLIC KEY-----", "")
        .replace(Regex("\\s"), "")
    val key =
      runCatching {
          KeyFactory.getInstance("RSA")
            .generatePublic(X509EncodedKeySpec(Base64.decode(body, Base64.DEFAULT)))
        }
        .getOrElse { throw PaymentsException("INVALID_KEY", "Invalid public key") }
    val cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding")
    cipher.init(Cipher.ENCRYPT_MODE, key)
    val encrypted =
      cipher.doFinal("$number@$year$month@$cvv@${args.publicId}".toByteArray(Charsets.US_ASCII))
    var version = args.keyVersion.toString()
    if (version.length % 2 == 1) version = "0$version"
    val packet =
      JSONObject()
        .put("Type", "CloudCard")
        .put("BrowserInfoBase64", "")
        .put(
          "CardInfo",
          JSONObject()
            .put("FirstSixDigits", number.take(6))
            .put("LastFourDigits", number.takeLast(4))
            .put("ExpDateYear", year)
            .put("ExpDateMonth", month),
        )
        .put("KeyVersion", version)
        .put("Format", 1)
        .put("Value", Base64.encodeToString(encrypted, Base64.NO_WRAP))
    return Base64.encodeToString(packet.toString().toByteArray(), Base64.NO_WRAP)
  }
}
