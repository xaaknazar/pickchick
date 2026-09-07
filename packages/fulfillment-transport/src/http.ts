import { TextDecoder } from 'node:util';
import { ErrorSchema } from '@pickchick/contracts';
import type { DeviceIdentity } from '@pickchick/contracts';

/** No URL, credentials, raw provider body or original exception escapes this boundary. */
export class TransportHttpError extends Error {
  constructor(
    readonly code: 'NETWORK_UNKNOWN' | 'HTTP_REJECTED' | 'INVALID_RESPONSE',
    readonly status?: number,
  ) {
    super(code);
  }
}
export function cloudTransportOrigin(value: string): string {
  try {
    const url = new URL(value);
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
    throw new TransportHttpError('INVALID_RESPONSE');
  }
}
export interface TransportIo {
  fetch?: typeof fetch;
  timeoutMs?: number;
}
export async function transportRequest(
  origin: string,
  path: 'pull' | 'ack' | 'events',
  identity: DeviceIdentity,
  body: unknown,
  io: TransportIo = {},
) {
  const base = cloudTransportOrigin(origin),
    input = JSON.stringify(body);
  if (Buffer.byteLength(input) > 64 * 1024) throw new TransportHttpError('INVALID_RESPONSE');
  const timeout = io.timeoutMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 5000)
    throw new TransportHttpError('INVALID_RESPONSE');
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new TransportHttpError('NETWORK_UNKNOWN'));
    }, timeout);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await (io.fetch ?? fetch)(`${base}/internal/v1/edge/fulfillment/${path}`, {
          method: 'POST',
          redirect: 'error',
          signal: abort.signal,
          headers: {
            Authorization: `Bearer ${identity.token}`,
            'X-Device-Id': identity.device_id,
            'Content-Type': 'application/json',
          },
          body: input,
        });
        if (
          !response.body ||
          !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')
        )
          throw new TransportHttpError('INVALID_RESPONSE');
        const declared = response.headers.get('content-length');
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > 1_300_000))
          throw new TransportHttpError('INVALID_RESPONSE');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 1_300_000) throw new TransportHttpError('INVALID_RESPONSE');
          chunks.push(part.value);
        }
        let result: unknown;
        try {
          result = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
          ) as unknown;
        } catch {
          throw new TransportHttpError('INVALID_RESPONSE');
        }
        if (!response.ok) {
          const error = ErrorSchema.safeParse(result);
          const expected: Record<number, string> = {
            400: 'INVALID_REQUEST',
            401: 'UNAUTHORIZED',
            403: 'FORBIDDEN',
            404: 'NOT_FOUND',
            409: 'CONFLICT',
            413: 'PAYLOAD_TOO_LARGE',
            429: 'RATE_LIMITED',
            503: 'SERVICE_UNAVAILABLE',
          };
          if (!error.success || expected[response.status] !== error.data.code)
            throw new TransportHttpError('NETWORK_UNKNOWN');
          throw new TransportHttpError('HTTP_REJECTED', response.status);
        }
        return result;
      })(),
    ]);
  } catch (error) {
    if (error instanceof TransportHttpError) throw error;
    throw new TransportHttpError('NETWORK_UNKNOWN');
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
    // A broken stream implementation must not prolong the whole-operation deadline.
    void reader?.cancel().catch(() => undefined);
  }
}
