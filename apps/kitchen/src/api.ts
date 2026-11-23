import { UUID } from './types.js';
import type { Credential } from './types.js';
export const demoMode =
  typeof location !== 'undefined' && location.pathname.startsWith('/kitchen-demo/');
export const portalMode =
  typeof location === 'undefined'
    ? undefined
    : (
        {
          '/kitchen/prep': 'prep',
          '/kitchen/assembly': 'assembly',
          '/display': 'display',
        } as Record<string, string>
      )[location.pathname];
export const apiPrefix = portalMode ? '/kitchen-live/' + portalMode : '';
export const assetPrefix = demoMode ? '/kitchen-demo' : portalMode ? '/kitchen-live/assets' : '';
/** Pause before config.json is read again: 1, 2, 4, 8 and then 15 seconds. */
export const configRetryDelayMs = (failures: number) =>
  Math.min(15000, 1000 * 2 ** Math.min(Math.max(failures, 1) - 1, 4));
export interface ConfigIo {
  fetch?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  /** Called after every failed read, before the pause (the screen shows that it is waiting). */
  onFailure?: (failures: number) => void;
}
/**
 * The workplace settings (config.json), read until they are known. They decide the mode: the
 * cloud portal answers `cloudKitchen: true` with the terminal, a local gateway its own fields.
 * - 200 with a JSON object: the settings;
 * - 404: this install has no such file - the local default `{}`, as before;
 * - anything else (5xx, a slow or unreachable gateway, a body that is not a JSON object) says
 *   nothing about the mode, so it is never taken for the local default: the read is repeated
 *   with a growing pause until it answers.
 */
export async function loadConfig(io: ConfigIo = {}): Promise<Record<string, unknown>> {
  const wait =
    io.wait ?? ((milliseconds) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  for (let failures = 1; ; failures++) {
    try {
      const response = await (io.fetch ?? fetch)(apiPrefix + '/config.json', {
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 404) {
        await response.body?.cancel();
        return {};
      }
      if (response.ok) {
        const config: unknown = await response.json();
        if (config && typeof config === 'object' && !Array.isArray(config))
          return config as Record<string, unknown>;
      } else await response.body?.cancel();
    } catch {
      /* Repeated below. */
    }
    io.onFailure?.(failures);
    await wait(configRetryDelayMs(failures));
  }
}
export class ApiError extends Error {
  constructor(
    public code: string,
    public status = 0,
    public validated = false,
    public retryAfterSeconds = 0,
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
    response = await fetch(apiPrefix + path, {
      method: body === undefined && path !== '/edge/v1/staff/logout' ? 'GET' : 'POST',
      headers,
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError('CONNECTION_UNKNOWN');
  }
  if (path === '/edge/v1/staff/logout' && response.status === 204) return null;
  if (path === '/edge/v1/staff/login') {
    if (response.status === 401) {
      await response.body?.cancel();
      throw new ApiError('INVALID_LOGIN', 401);
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After'));
      await response.body?.cancel();
      throw new ApiError(
        'AUTH_RATE_LIMITED',
        429,
        false,
        Number.isInteger(seconds) && seconds > 0 && seconds <= 3600 ? seconds : 60,
      );
    }
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
    // HANDOVER_MARKS_REQUIRED: courier handover without the three marks (cutover KDS-4, CR kds-6).
    400: ['INVALID_REQUEST', 'HANDOVER_MARKS_REQUIRED'],
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
