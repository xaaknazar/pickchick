import { TextDecoder } from 'node:util';
import type { DeviceIdentity } from '@pickchick/contracts';
import { ErrorSchema } from '@pickchick/contracts';
import { MAX_EVENT_BYTES } from './model.js';

export class PosHttpError extends Error {
  constructor(
    readonly code: 'NETWORK_UNKNOWN' | 'HTTP_REJECTED' | 'INVALID_RESPONSE',
    readonly status?: number,
  ) {
    super(code);
  }
}
export function posCloudOrigin(input: string) {
  try {
    const url = new URL(input);
    if (
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new PosHttpError('INVALID_RESPONSE');
  }
}
export interface PosSyncIo {
  fetch?: typeof fetch;
  timeoutMs?: number;
}
/** Same bounded, no-redirect, redacted-error convention as fulfillment transport. */
export async function sendPosEvent(
  origin: string,
  identity: DeviceIdentity,
  event: unknown,
  io: PosSyncIo = {},
) {
  const base = posCloudOrigin(origin),
    body = JSON.stringify(event),
    timeout = io.timeoutMs ?? 5000;
  if (
    Buffer.byteLength(body) > MAX_EVENT_BYTES ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 5000
  )
    throw new PosHttpError('INVALID_RESPONSE');
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new PosHttpError('NETWORK_UNKNOWN'));
    }, timeout);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await (io.fetch ?? fetch)(`${base}/internal/v1/edge/pos-orders/events`, {
          method: 'POST',
          redirect: 'error',
          signal: abort.signal,
          headers: {
            Authorization: `Bearer ${identity.token}`,
            'X-Device-Id': identity.device_id,
            'Content-Type': 'application/json',
          },
          body,
        });
        if (
          !response.body ||
          !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')
        )
          throw new PosHttpError('INVALID_RESPONSE');
        const length = response.headers.get('content-length');
        if (length && (!/^\d+$/.test(length) || Number(length) > 8192))
          throw new PosHttpError('INVALID_RESPONSE');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 8192) throw new PosHttpError('INVALID_RESPONSE');
          chunks.push(part.value);
        }
        let value: unknown;
        try {
          value = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
          );
        } catch {
          throw new PosHttpError('INVALID_RESPONSE');
        }
        if (!response.ok) {
          const parsed = ErrorSchema.safeParse(value),
            codes: Record<number, string> = {
              400: 'INVALID_REQUEST',
              401: 'UNAUTHORIZED',
              403: 'FORBIDDEN',
              404: 'NOT_FOUND',
              409: 'CONFLICT',
              413: 'PAYLOAD_TOO_LARGE',
              429: 'RATE_LIMITED',
              503: 'SERVICE_UNAVAILABLE',
            };
          if (!parsed.success || codes[response.status] !== parsed.data.code)
            throw new PosHttpError('NETWORK_UNKNOWN');
          throw new PosHttpError('HTTP_REJECTED', response.status);
        }
        if (response.status !== 200) throw new PosHttpError('INVALID_RESPONSE');
        return value;
      })(),
    ]);
  } catch (error) {
    if (error instanceof PosHttpError) throw error;
    throw new PosHttpError('NETWORK_UNKNOWN');
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
    void reader?.cancel().catch(() => undefined);
  }
}
