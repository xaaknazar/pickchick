import { TextDecoder } from 'node:util';
import type {
  PhoneCodeDelivery,
  PhoneCodeDeliveryInput,
  PhoneCodeDeliveryResult,
} from './index.js';

// Official copy-code authentication contract, reviewed 2026-09-23:
// https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/copy-code-button-authentication-templates
// Transport foundation only: deliberately not selectable by the public identity factory.
const TIMEOUT_MS = 5_000;
const RESPONSE_LIMIT_BYTES = 16 * 1024;
const unknownResponse = (): PhoneCodeDeliveryResult => ({ kind: 'unknown', reason: 'response' });
export interface WhatsAppCodeDeliveryConfiguration {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
  approvedTemplate: string;
  language: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function matches(value: unknown, pattern: RegExp, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= max &&
    pattern.test(value)
  );
}
function parseInput(input: unknown): PhoneCodeDeliveryInput | undefined {
  try {
    if (!record(input) || Object.keys(input).some((key) => !['phoneE164', 'code'].includes(key)))
      return;
    if (
      !matches(input['phoneE164'], /^\+77[0-9]{9}$/, 12) ||
      !matches(input['code'], /^[0-9]{6}$/, 6)
    )
      return;
    return { phoneE164: input['phoneE164'], code: input['code'] };
  } catch {
    return;
  }
}
function parseSubmission(value: unknown, recipient: string): PhoneCodeDeliveryResult {
  if (!record(value) || value['error'] !== undefined || value['messaging_product'] !== 'whatsapp')
    return unknownResponse();
  const contacts = value['contacts'],
    messages = value['messages'];
  if (
    !Array.isArray(contacts) ||
    contacts.length !== 1 ||
    !record(contacts[0]) ||
    ![recipient, `+${recipient}`].includes(String(contacts[0]['input'])) ||
    !matches(contacts[0]['wa_id'], /^\+?[0-9]+$/, 16) ||
    !Array.isArray(messages) ||
    messages.length !== 1 ||
    !record(messages[0]) ||
    !matches(messages[0]['id'], /^wamid\.[A-Za-z0-9_+=/-]+$/, 512) ||
    (messages[0]['message_status'] !== undefined && messages[0]['message_status'] !== 'accepted')
  )
    return unknownResponse();
  // A provider message ID establishes submission, never delivery or phone ownership.
  return {
    kind: 'submitted',
    provider: 'whatsapp_cloud',
    submission: 'accepted',
    messageId: messages[0]['id'],
  };
}

/** One outbound authentication template; codes and account verification belong to identity. */
export class WhatsAppCodeDelivery implements PhoneCodeDelivery {
  readonly provider = 'whatsapp_cloud' as const;
  #accessToken: string;
  #endpoint: string;
  #template: string;
  #language: string;
  #fetch: typeof globalThis.fetch;
  constructor(
    config: WhatsAppCodeDeliveryConfiguration,
    fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  ) {
    if (
      !record(config) ||
      Object.keys(config).some(
        (key) =>
          !['accessToken', 'phoneNumberId', 'apiVersion', 'approvedTemplate', 'language'].includes(
            key,
          ),
      ) ||
      !matches(config.accessToken, /^[A-Za-z0-9_.|-]+$/, 4096) ||
      !matches(config.phoneNumberId, /^[1-9][0-9]*$/, 32) ||
      !matches(config.apiVersion, /^v[1-9][0-9]{0,2}\.0$/, 6) ||
      !matches(config.approvedTemplate, /^[a-z][a-z0-9_]*$/, 512) ||
      !matches(config.language, /^[a-z]{2,3}(?:_[A-Z]{2})?$/, 6) ||
      typeof fetchImplementation !== 'function'
    )
      throw new Error('PHONE_DELIVERY_CONFIGURATION_INVALID');
    this.#accessToken = config.accessToken;
    this.#endpoint = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;
    this.#template = config.approvedTemplate;
    this.#language = config.language;
    this.#fetch = fetchImplementation;
  }
  async sendCode(input: PhoneCodeDeliveryInput): Promise<PhoneCodeDeliveryResult> {
    const parsed = parseInput(input);
    if (!parsed) return { kind: 'rejected', reason: 'invalid_input' };
    // Format guard only, as for SMS; identity owns current Kazakhstan range validation.
    const body = JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: parsed.phoneE164.slice(1),
      type: 'template',
      template: {
        name: this.#template,
        language: { code: this.#language },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: parsed.code }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: parsed.code }],
          },
        ],
      },
    });
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelRead = () => {
      // Never await a broken provider stream's cancellation or expose its error.
      if (reader) void reader.cancel().catch(() => {});
    };
    const deadline = new Promise<PhoneCodeDeliveryResult>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        cancelRead();
        resolve({ kind: 'unknown', reason: 'timeout' });
      }, TIMEOUT_MS);
    });
    const submit = async (): Promise<PhoneCodeDeliveryResult> => {
      let response: Response;
      try {
        response = await this.#fetch(this.#endpoint, {
          method: 'POST',
          redirect: 'error',
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.#accessToken}`,
            Accept: 'application/json',
          },
          body,
          signal: controller.signal,
        });
      } catch {
        return { kind: 'unknown', reason: timedOut ? 'timeout' : 'network' };
      }
      try {
        reader = response.body?.getReader();
        if (timedOut) return { kind: 'unknown', reason: 'timeout' };
        if (
          !reader ||
          response.redirected ||
          response.status >= 500 ||
          (response.status >= 300 && response.status < 400)
        )
          return unknownResponse();
        const declaredLength = response.headers.get('content-length');
        if (
          declaredLength !== null &&
          (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > RESPONSE_LIMIT_BYTES)
        )
          return unknownResponse();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value.byteLength > RESPONSE_LIMIT_BYTES - bytes) return unknownResponse();
          chunks.push(chunk.value);
          bytes += chunk.value.byteLength;
        }
        const raw: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)),
        );
        const result = parseSubmission(raw, parsed.phoneE164.slice(1));
        // Even a success-looking JSON on an HTTP failure is not acceptance.
        return result.kind === 'submitted' && !response.ok ? unknownResponse() : result;
      } catch {
        return timedOut ? { kind: 'unknown', reason: 'timeout' } : unknownResponse();
      } finally {
        cancelRead();
      }
    };
    try {
      return await Promise.race([submit(), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }
}
