import { MobizonCodeDelivery } from './mobizon.js';
import { TelegramCodeDelivery } from './telegram.js';
import { WhatsAppCodeDelivery } from './whatsapp.js';
export { TelegramCodeDelivery } from './telegram.js';
export type PhoneDeliveryChannel = 'sms' | 'telegram' | 'whatsapp';
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
  | { kind: 'rejected'; reason: 'recipient_unavailable' }
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
    const waNames = [
      'WHATSAPP_CLOUD_ACCESS_TOKEN',
      'WHATSAPP_CLOUD_PHONE_NUMBER_ID',
      'WHATSAPP_CLOUD_API_VERSION',
      'WHATSAPP_CLOUD_APPROVED_AUTH_TEMPLATE',
      'WHATSAPP_CLOUD_TEMPLATE_LANGUAGE',
    ] as const;
    const configured = waNames.filter((name) => env[name] !== undefined);
    if (configured.length !== 0 && configured.length !== waNames.length)
      throw new Error('PHONE_DELIVERY_CONFIGURATION_INVALID');
    const whatsapp =
      configured.length === waNames.length
        ? new WhatsAppCodeDelivery(
            {
              accessToken: env[waNames[0]] ?? '',
              phoneNumberId: env[waNames[1]] ?? '',
              apiVersion: env[waNames[2]] ?? '',
              approvedTemplate: env[waNames[3]] ?? '',
              language: env[waNames[4]] ?? '',
            },
            dependencies.fetch,
          )
        : undefined;
    if (fallback === 'false' && !whatsapp) return telegram;
    const sms =
      fallback === 'true'
        ? new MobizonCodeDelivery(
            {
              apiKey: env['MOBIZON_API_KEY'] ?? '',
              approvedSender: env['MOBIZON_APPROVED_SENDER'] ?? '',
            },
            dependencies.fetch,
          )
        : undefined;
    return {
      provider: 'channels',
      channels: Object.freeze([
        'telegram' as const,
        ...(sms ? ['sms' as const] : []),
        ...(whatsapp ? ['whatsapp' as const] : []),
      ]),
      // Identity owns automatic fallback; transports only send on an explicit call.
      sendCode(input, channel = 'sms') {
        if (channel === 'telegram') return telegram.sendCode(input);
        if (channel === 'sms' && sms) return sms.sendCode(input);
        if (channel === 'whatsapp' && whatsapp) return whatsapp.sendCode(input);
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
