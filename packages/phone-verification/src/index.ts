import { MobizonCodeDelivery } from './mobizon.js';
import { TelegramCodeDelivery } from './telegram.js';
export { TelegramCodeDelivery } from './telegram.js';
export type PhoneDeliveryChannel = 'sms' | 'telegram';
export { WhatsAppCodeDelivery } from './whatsapp.js';
export type { WhatsAppCodeDeliveryConfiguration } from './whatsapp.js';

/** A transport input, not an OTP challenge or proof of phone ownership. */
export interface PhoneCodeDeliveryInput {
  phoneE164: string;
  code: string;
}
export type PhoneCodeDeliveryResult =
  | { kind: 'disabled' }
  | {
      kind: 'submitted';
      provider: 'mobizon';
      submission: 'pending_moderation' | 'accepted';
      messageId: string;
      campaignId: string;
    }
  | {
      kind: 'submitted';
      provider: 'whatsapp_cloud';
      submission: 'accepted';
      messageId: string;
    }
  | { kind: 'submitted'; provider: 'telegram_gateway'; submission: 'accepted'; messageId: string }
  | { kind: 'rejected'; reason: 'channel_unavailable' }
  | { kind: 'rejected'; reason: 'invalid_input' }
  | { kind: 'rejected'; reason: 'provider_rejected'; providerCode: number }
  | { kind: 'unknown'; reason: 'network' | 'timeout' | 'response' };
export interface PhoneCodeDelivery {
  readonly provider: 'disabled' | 'mobizon' | 'whatsapp_cloud' | 'telegram_gateway' | 'channels';
  readonly channels?: readonly PhoneDeliveryChannel[];
  /** Exactly one submission attempt. Unknown outcomes must never trigger blind retries. */
  sendCode(
    input: PhoneCodeDeliveryInput,
    channel?: PhoneDeliveryChannel,
  ): Promise<PhoneCodeDeliveryResult>;
}
export interface PhoneDeliveryDependencies {
  fetch?: typeof globalThis.fetch;
}
export type PhoneDeliveryEnvironment = Readonly<Record<string, string | undefined>>;

/** No public endpoint or OTP verification is enabled by constructing this transport. */
export function createPhoneCodeDelivery(
  env: PhoneDeliveryEnvironment = {},
  dependencies: PhoneDeliveryDependencies = {},
): PhoneCodeDelivery {
  const provider = env['PHONE_DELIVERY_PROVIDER'] ?? 'disabled';
  if (provider === 'disabled') {
    return {
      provider: 'disabled',
      async sendCode() {
        return { kind: 'disabled' };
      },
    };
  }
  if (provider === 'telegram_gateway') {
    const telegram = new TelegramCodeDelivery(
      env['TELEGRAM_GATEWAY_TOKEN'] ?? '',
      dependencies.fetch,
    );
    const fallback = env['PHONE_SMS_FALLBACK_ENABLED'] ?? 'false';
    if (!['true', 'false'].includes(fallback))
      throw new Error('PHONE_DELIVERY_CONFIGURATION_INVALID');
    if (fallback === 'false') return telegram;
    const sms = new MobizonCodeDelivery(
      {
        apiKey: env['MOBIZON_API_KEY'] ?? '',
        approvedSender: env['MOBIZON_APPROVED_SENDER'] ?? '',
      },
      dependencies.fetch,
    );
    return {
      provider: 'channels',
      channels: Object.freeze(['telegram', 'sms'] as const),
      // User-selected fallback only: timeouts must never dispatch another paid message.
      sendCode(input, channel = 'sms') {
        if (channel === 'telegram') return telegram.sendCode(input);
        if (channel === 'sms') return sms.sendCode(input);
        return Promise.resolve({ kind: 'rejected', reason: 'channel_unavailable' });
      },
    };
  }
  if (provider !== 'mobizon') throw new Error('PHONE_DELIVERY_CONFIGURATION_INVALID');
  return new MobizonCodeDelivery(
    {
      apiKey: env['MOBIZON_API_KEY'] ?? '',
      approvedSender: env['MOBIZON_APPROVED_SENDER'] ?? '',
    },
    dependencies.fetch,
  );
}

export function phoneDeliveryChannels(
  delivery: PhoneCodeDelivery,
): readonly PhoneDeliveryChannel[] {
  if (delivery.provider === 'mobizon') return ['sms'];
  if (delivery.provider === 'telegram_gateway') return ['telegram'];
  if (delivery.provider === 'channels') return delivery.channels ?? [];
  return [];
}
