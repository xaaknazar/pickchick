import { TextDecoder } from 'node:util';
import type {
  PhoneCodeDelivery,
  PhoneCodeDeliveryInput,
  PhoneCodeDeliveryResult,
} from './index.js';

// https://core.telegram.org/gateway/api - checked 2026-09-26.
// One send only. checkSendAbility can charge: never use it as a free preflight.
const TIMEOUT_MS = 5_000;
const RESPONSE_LIMIT_BYTES = 16 * 1024;
const unknownResponse = (): PhoneCodeDeliveryResult => ({ kind: 'unknown', reason: 'response' });
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseSubmission(value: unknown, recipient: string): PhoneCodeDeliveryResult {
  if (!record(value) || typeof value['ok'] !== 'boolean') return unknownResponse();
  if (!value['ok']) {
    // A recipient-specific terminal refusal permits a second transport. This exact
    // Gateway error needs confirmation on a live negative-path test before WA rollout.
    if (value['error'] === 'PHONE_NUMBER_NOT_SUPPORTED')
      return { kind: 'rejected', reason: 'recipient_unavailable' };
    // Configuration/input failures are terminal for this attempt, never WA fallback.
    if (
      ['ACCESS_TOKEN_INVALID', 'BALANCE_TOO_LOW', 'PHONE_NUMBER_INVALID'].includes(
        String(value['error']),
      )
    )
      return { kind: 'rejected', reason: 'channel_unavailable' };
    return unknownResponse();
  }
  const result = value['result'];
  if (
    !record(result) ||
    // Gateway returns the canonical digits without '+' in live responses.
    typeof result['phone_number'] !== 'string' ||
    ![recipient, recipient.slice(1)].includes(result['phone_number']) ||
    typeof result['request_id'] !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(result['request_id']) ||
    typeof result['request_cost'] !== 'number' ||
    !Number.isFinite(result['request_cost']) ||
    result['request_cost'] < 0
  )
    return unknownResponse();
  return {
    kind: 'submitted',
    provider: 'telegram_gateway',
    submission: 'accepted',
    messageId: result['request_id'],
  };
}
export class TelegramCodeDelivery implements PhoneCodeDelivery {
  readonly provider = 'telegram_gateway' as const;
  #accessToken: string;
  #fetch: typeof globalThis.fetch;
  constructor(
    accessToken: string,
    fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  ) {
    if (
      typeof accessToken !== 'string' ||
      !/^[A-Za-z0-9_.:-]{16,4096}$/.test(accessToken) ||
      typeof fetchImplementation !== 'function'
    )
      throw new Error('PHONE_DELIVERY_CONFIGURATION_INVALID');
    this.#accessToken = accessToken;
    this.#fetch = fetchImplementation;
  }
  async sendCode(input: PhoneCodeDeliveryInput): Promise<PhoneCodeDeliveryResult> {
    if (
      !record(input) ||
      Object.keys(input).some((key) => !['phoneE164', 'code'].includes(key)) ||
      typeof input.phoneE164 !== 'string' ||
      !/^\+77[0-9]{9}$/.test(input.phoneE164) ||
      typeof input.code !== 'string' ||
      !/^(?:[0-9]{4}|[0-9]{6})$/.test(input.code)
    )
      return { kind: 'rejected', reason: 'invalid_input' };
    const parsed = input;
    // Identity verifies its own code; Telegram delivery status never grants a session.
    const body = JSON.stringify({ phone_number: parsed.phoneE164, code: parsed.code, ttl: 180 });
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
        response = await this.#fetch('https://gatewayapi.telegram.org/sendVerificationMessage', {
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
        const result = parseSubmission(raw, parsed.phoneE164);
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
