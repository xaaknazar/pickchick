import { UUID } from './types.js';
import type { Credential } from './types.js';
export class ApiError extends Error {
  constructor(
    public code: string,
    public status = 0,
    public validated = false,
  ) {
    super(code);
  }
}
export type Transport = (
  path: string,
  actor: Credential | null,
  body?: unknown,
  key?: string,
) => Promise<unknown>;
export const request: Transport = async (path, actor, body, key) => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (actor) {
    headers.Authorization = `Bearer ${actor.token}`;
    headers['X-Staff-Session-ID'] = actor.session_id;
    headers['X-Terminal-ID'] = actor.terminal_id;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError('CONNECTION_UNKNOWN');
  }
  const reader = response.body?.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (!reader) throw new Error();
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.length;
      if (bytes > 3 * 1024 * 1024) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(r.value);
    }
    const raw = new Uint8Array(bytes);
    let offset = 0;
    for (const c of chunks) {
      raw.set(c, offset);
      offset += c.length;
    }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!response.ok) {
      const code = validatedError(parsed, response.status);
      if (!code) throw new ApiError('INVALID_RESPONSE');
      throw new ApiError(code, response.status, true);
    }
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('INVALID_RESPONSE');
  }
};

/** Full shared ErrorSchema shape plus semantic HTTP/code pairing; HTML and arbitrary JSON are unknown outcomes. */
export function validatedError(value: unknown, status: number): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !== 'code,message_key,retryable,trace_id' ||
    typeof v.message_key !== 'string' ||
    typeof v.retryable !== 'boolean' ||
    typeof v.trace_id !== 'string' ||
    !UUID.test(v.trace_id) ||
    typeof v.code !== 'string'
  )
    return null;
  const codes: Record<number, readonly string[]> = {
    400: ['INVALID_REQUEST'],
    401: ['UNAUTHORIZED'],
    403: ['FORBIDDEN'],
    404: ['NOT_FOUND'],
    409: ['CONFLICT', 'QUOTE_EXPIRED', 'MENU_CHANGED', 'BRANCH_UNAVAILABLE', 'ITEM_STOPPED'],
    413: ['PAYLOAD_TOO_LARGE'],
    429: ['RATE_LIMITED'],
    500: ['INTERNAL_ERROR'],
    503: ['SERVICE_UNAVAILABLE'],
  };
  return codes[status]?.includes(v.code) ? v.code : null;
}
