import { requireOptionalNativeModule } from 'expo';

/**
 * Native half of the TipTopPay checkout (owner 18.11.2026, «Полностью нативно»):
 * - cardCryptogram: the card is encrypted on the phone with the TipTopPay public key; only the
 *   opaque packet leaves the device (our server charges it, the PAN/CVV never reach us);
 * - Apple Pay (iOS) and Google Pay (Android) sheets return the wallet token as the packet.
 * The module is optional: web, Node tests and builds made before it existed get null.
 */
export type CardInput = {
  number: string;
  expMonth: string;
  expYear: string;
  cvv: string;
  publicId: string;
  publicKeyPem: string;
  keyVersion: number;
};
export type ApplePayInput = {
  merchantId: string;
  label: string;
  amount: string;
  currency: 'KZT';
  countryCode: 'KZ';
};
export type GooglePayInput = {
  gateway: string;
  gatewayMerchantId: string;
  merchantName: string;
  amount: string;
  currency: 'KZT';
  countryCode: 'KZ';
  test: boolean;
};
type NativePayments = {
  cardCryptogram(input: CardInput): Promise<string>;
  canMakeApplePay?(): boolean;
  startApplePay?(input: ApplePayInput): Promise<string>;
  completeApplePay?(success: boolean): Promise<void>;
  isGooglePayReady?(input: GooglePayInput): Promise<boolean>;
  startGooglePay?(input: GooglePayInput): Promise<string>;
};

export const NativePayments = requireOptionalNativeModule<NativePayments>('PickChickPayments');

/** Error codes the native side rejects with; CANCELLED means the customer closed the sheet. */
export const PAYMENT_CANCELLED = 'CANCELLED';
export function nativePaymentCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'NATIVE_ERROR';
}
