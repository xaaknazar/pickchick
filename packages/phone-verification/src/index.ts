import { MobizonCodeDelivery } from './mobizon.js';
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
  | { kind: 'rejected'; reason: 'invalid_input' }
  | { kind: 'rejected'; reason: 'provider_rejected'; providerCode: number }
  | { kind: 'unknown'; reason: 'network' | 'timeout' | 'response' };
export interface PhoneCodeDelivery {
  readonly provider: 'disabled' | 'mobizon' | 'whatsapp_cloud';
  /** Exactly one submission attempt. Unknown outcomes must never trigger blind retries. */
  sendCode(input: PhoneCodeDeliveryInput): Promise<PhoneCodeDeliveryResult>;
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
  if (provider !== 'mobizon') throw new Error('PHONE_DELIVERY_CONFIGURATION_INVALID');
  return new MobizonCodeDelivery(
    {
      apiKey: env['MOBIZON_API_KEY'] ?? '',
      approvedSender: env['MOBIZON_APPROVED_SENDER'] ?? '',
    },
    dependencies.fetch,
  );
}
