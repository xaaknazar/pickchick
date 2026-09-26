import { createPhoneCodeDelivery, phoneDeliveryChannels } from '@pickchick/phone-verification';

try {
  if (process.argv.length !== 2) throw new Error('Unexpected arguments');
  const delivery = createPhoneCodeDelivery(process.env, {
    fetch: async () => {
      throw new Error('Network calls are forbidden during configuration preflight');
    },
  });
  // This checks configuration syntax only, never the provider account or balance.
  // A successful preflight is not evidence of delivery or phone verification.
  console.log(
    JSON.stringify({
      event: 'phone_delivery_configuration',
      scope: 'transport_only',
      provider: delivery.provider,
      configured: delivery.provider !== 'disabled',
      provider_account_verified: false,
      sms_sent: 0,
      messages_sent: 0,
      channels: phoneDeliveryChannels(delivery),
    }),
  );
} catch {
  console.error(
    'Phone delivery configuration is invalid. Check PHONE_DELIVERY_PROVIDER, TELEGRAM_GATEWAY_TOKEN, PHONE_SMS_FALLBACK_ENABLED, MOBIZON_API_KEY and MOBIZON_APPROVED_SENDER in the private environment file. No SMS was sent.',
  );
  process.exitCode = 1;
}
