import { URLSearchParams } from 'node:url';
import { TextDecoder } from 'node:util';
import type {
  PhoneCodeDelivery,
  PhoneCodeDeliveryInput,
  PhoneCodeDeliveryResult,
} from './index.js';

// Official contracts, checked 2026-09-07:
// https://mobizon.kz/help/api-docs/sms-api
// https://mobizon.kz/help/api-docs/message
// https://mobizon.kz/help/api-docs/other
// Fixed endpoint: no environment-controlled origin, query secrets or redirects.
const ENDPOINT = 'https://api.mobizon.kz/service/message/sendSmsMessage';
const TIMEOUT_MS = 5_000;
const RESPONSE_LIMIT_BYTES = 16 * 1024;
const knownRejections = new Set([1, 2, 4, 5, 6, 8, 9, 11, 12, 13, 14, 30, 99]);
const unknownResponse = (): PhoneCodeDeliveryResult => ({ kind: 'unknown', reason: 'response' });

type MobizonConfiguration = { apiKey: string; approvedSender: string };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function validConfiguration(value: string, maxLength: number) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    [...value].every((character) => {
      const number = character.codePointAt(0) ?? 0;
      return number >= 32 && !(number >= 127 && number <= 159);
    })
  );
}
function parseInput(input: unknown): PhoneCodeDeliveryInput | undefined {
  try {
    if (!record(input) || !onlyKeys(input, ['phoneE164', 'code'])) return undefined;
    const phoneE164 = input['phoneE164'];
    const code = input['code'];
    if (
      typeof phoneE164 !== 'string' ||
      phoneE164.length !== 12 ||
      !/^\+77[0-9]{9}$/.test(phoneE164) ||
      typeof code !== 'string' ||
      code.length !== 6 ||
      !/^[0-9]{6}$/.test(code)
    )
      return undefined;
    return { phoneE164, code };
  } catch {
    return undefined;
  }
}
function providerId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 20 &&
    !/[^0-9]/.test(value) &&
    /[1-9]/.test(value)
  )
    return value;
  return undefined;
}
function parseSubmission(value: unknown): PhoneCodeDeliveryResult {
  if (
    !record(value) ||
    !onlyKeys(value, ['code', 'data', 'message']) ||
    !Object.hasOwn(value, 'data') ||
    typeof value['code'] !== 'number' ||
    !Number.isSafeInteger(value['code']) ||
    ('message' in value && typeof value['message'] !== 'string')
  )
    return unknownResponse();
  if (value['code'] !== 0) {
    // Background/partial/application errors do not establish that no SMS was
    // submitted. Raw error message/data are deliberately discarded.
    return knownRejections.has(value['code'])
      ? { kind: 'rejected', reason: 'provider_rejected', providerCode: value['code'] }
      : unknownResponse();
  }
  const data = value['data'];
  if (!record(data) || !onlyKeys(data, ['messageId', 'campaignId', 'status']))
    return unknownResponse();
  const messageId = providerId(data['messageId']);
  const campaignId = providerId(data['campaignId']);
  if (!messageId || !campaignId || (data['status'] !== 1 && data['status'] !== 2))
    return unknownResponse();
  return {
    kind: 'submitted',
    provider: 'mobizon',
    submission: data['status'] === 1 ? 'pending_moderation' : 'accepted',
    messageId,
    campaignId,
  };
}

/** Server-only SMS submission. It neither generates nor verifies OTP challenges. */
export class MobizonCodeDelivery implements PhoneCodeDelivery {
  readonly provider = 'mobizon' as const;
  // ECMAScript private fields keep credentials out of ordinary object inspection.
  #apiKey: string;
  #sender: string;
  #fetch: typeof globalThis.fetch;
  constructor(
    config: MobizonConfiguration,
    fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  ) {
    if (
      !record(config) ||
      !onlyKeys(config, ['apiKey', 'approvedSender']) ||
      !validConfiguration(config.apiKey, 512) ||
      !validConfiguration(config.approvedSender, 100) ||
      typeof fetchImplementation !== 'function'
    )
      throw new Error('PHONE_DELIVERY_CONFIGURATION_INVALID');
    // Sender registration/approval must be confirmed outside this adapter.
    this.#apiKey = config.apiKey;
    this.#sender = config.approvedSender;
    this.#fetch = fetchImplementation;
  }
  async sendCode(input: PhoneCodeDeliveryInput): Promise<PhoneCodeDeliveryResult> {
    const parsed = parseInput(input);
    if (!parsed) return { kind: 'rejected', reason: 'invalid_input' };
    // Format guard only. Carrier/range checks and possession verification belong
    // to the future OTP domain; a +77 prefix alone cannot prove either.
    const text = `PickChick: код ${parsed.code}. Никому не сообщайте.`;
    // Fixed BMP-only text stays within one 70-code-unit UCS-2 SMS segment.
    const body = new URLSearchParams({
      apiKey: this.#apiKey,
      output: 'json',
      api: 'v1',
      from: this.#sender,
      recipient: parsed.phoneE164.slice(1),
      text,
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
        response = await this.#fetch(ENDPOINT, {
          method: 'POST',
          redirect: 'error',
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
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
        const result = parseSubmission(raw);
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
