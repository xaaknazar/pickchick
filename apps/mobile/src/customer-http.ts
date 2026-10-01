import { CustomerSessionError, type CustomerRequest } from './customer-session.ts';
import { ErrorSchema } from '@pickchick/contracts';

/** Dedicated auth transport. No bearer in URLs, redirects, analytics, or cached GET responses. */
export function createCustomerRequest(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
  boundary?: {
    allowed: RegExp;
    timeoutMs: number;
    maxBytes: number;
    signal?: AbortSignal;
    accept?: string;
  },
): CustomerRequest {
  const url = new URL(baseUrl);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new CustomerSessionError('INVALID_API_URL');
  const allowed =
    boundary?.allowed ??
    /^\/v1\/(auth\/(config|otp\/request|otp\/verify|refresh|logout)|customers\/me)$/;
  return async (path, method, body, accessToken) => {
    if (!allowed.test(path)) throw new CustomerSessionError('INVALID_API_PATH');
    const controller = new AbortController();
    const abort = () => controller.abort();
    boundary?.signal?.addEventListener('abort', abort, { once: true });
    if (boundary?.signal?.aborted) abort();
    const timeout = setTimeout(() => controller.abort(), boundary?.timeoutMs ?? 10000);
    try {
      const response = await fetcher(`${url.origin}${path}`, {
        method,
        headers: {
          Accept: boundary?.accept ?? 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (
        !response.headers.get('content-type')?.includes('application/json') ||
        Number(response.headers.get('content-length') ?? 0) > (boundary?.maxBytes ?? 16000)
      )
        throw new CustomerSessionError('INVALID_RESPONSE');
      if (!response.body?.getReader) throw new CustomerSessionError('INVALID_RESPONSE');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > (boundary?.maxBytes ?? 16000)) {
            controller.abort();
            void reader.cancel().catch(() => undefined);
            throw new CustomerSessionError('INVALID_RESPONSE');
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const value: unknown = JSON.parse(raw);
      if (!response.ok) {
        const parsed = ErrorSchema.safeParse(value);
        if (
          !parsed.success ||
          parsed.data.message_key !== `errors.${parsed.data.code.toLowerCase()}` ||
          (response.status === 401 &&
            (parsed.data.code !== 'UNAUTHORIZED' || parsed.data.retryable))
        )
          throw new CustomerSessionError('INVALID_RESPONSE');
        throw new CustomerSessionError(parsed.data.code, response.status, true);
      }
      return value;
    } catch (error) {
      if (error instanceof CustomerSessionError) throw error;
      throw new CustomerSessionError('NETWORK_UNAVAILABLE');
    } finally {
      clearTimeout(timeout);
      boundary?.signal?.removeEventListener('abort', abort);
    }
  };
}
