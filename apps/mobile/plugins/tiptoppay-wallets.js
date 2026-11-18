/* global require, module, process */
/* eslint @typescript-eslint/no-require-imports: "off" */
/**
 * Apple Pay entitlement for the native TipTopPay checkout (owner 18.11.2026).
 *
 * The entitlement is added only when EXPO_PUBLIC_APPLE_PAY_MERCHANT_ID is set at prebuild, for
 * example `merchant.kz.pickchick.app`: a provisioning profile without the Apple Pay capability
 * would otherwise fail release signing. The same variable is inlined into the JS bundle, so the
 * app offers Apple Pay only in builds that carry the entitlement.
 *
 * Google Pay needs no plugin: the payments module's own AndroidManifest declares
 * com.google.android.gms.wallet.api.enabled and is merged into the app.
 */
const { withEntitlementsPlist } = require('expo/config-plugins');

const MERCHANT = /^merchant\.[A-Za-z0-9.-]+$/;

module.exports = function withTipTopPayWallets(config) {
  const merchantId = process.env.EXPO_PUBLIC_APPLE_PAY_MERCHANT_ID;
  if (!merchantId) return config;
  if (!MERCHANT.test(merchantId))
    throw new Error('EXPO_PUBLIC_APPLE_PAY_MERCHANT_ID must look like merchant.kz.pickchick.app');
  return withEntitlementsPlist(config, (next) => {
    next.modResults['com.apple.developer.in-app-payments'] = [merchantId];
    return next;
  });
};
