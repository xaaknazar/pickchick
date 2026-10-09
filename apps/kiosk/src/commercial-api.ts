import { KIOSK_API_URL, KioskError } from './api.ts';
import { operatorCredentialsValid } from './enrollment.ts';

export const commercialKioskEnabled = process.env.EXPO_PUBLIC_KIOSK_COMMERCIAL === '1';
/** A provisioned device/guest token, never a customer identity token. */
export async function commercialKioskRequest(
  path: string,
  token?: string,
  body?: unknown,
  key?: string,
  fetcher: typeof fetch = fetch,
  device?: { deviceId: string; key: string },
): Promise<unknown> {
  if (
    !/^\/(?:enrollment\/check|config|catalog|availability|sessions(?:\/end)?|quotes|orders(?:\/[a-f0-9-]{36}(?:\/payment)?)?)$/.test(
      path,
    )
  )
    throw new KioskError('INVALID_PATH');
  if (!device || !/^[a-f0-9-]{36}$/.test(device.deviceId) || !/^[a-f0-9]{64}$/.test(device.key))
    throw new KioskError('DEVICE_NOT_PROVISIONED');
  if (path !== '/sessions' && path !== '/enrollment/check' && !token)
    throw new KioskError('GUEST_IDENTITY_UNAVAILABLE');
  return sendKioskRequest(
    path,
    body,
    {
      'X-Kiosk-Device': device.deviceId,
      'X-Kiosk-Key': device.key,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    fetcher,
  );
}

/** Storefront signal headers of a kiosk GET read (WP-K); null when absent or malformed. */
export interface KioskReadResult {
  data: unknown;
  catalogVersion: number | null;
  signature: string | null;
}
/** Server long-poll holds at most 25 s; the client waits a little longer before giving up. */
export const KIOSK_LONG_POLL_TIMEOUT_MS = 32000;
/**
 * Header-aware GET for the catalog photo map and the availability long-poll. Only these two
 * reads (with their exact query shapes) are allowed; everything else uses commercialKioskRequest.
 */
export async function commercialKioskRead(
  path: string,
  token: string,
  fetcher: typeof fetch = fetch,
  device?: { deviceId: string; key: string },
  options: { timeoutMs?: number } = {},
): Promise<KioskReadResult> {
  if (
    !/^\/(?:catalog\/media\?version=[1-9][0-9]{0,8}|availability(?:\?after=[a-f0-9]{64})?)$/.test(
      path,
    )
  )
    throw new KioskError('INVALID_PATH');
  if (!device || !/^[a-f0-9-]{36}$/.test(device.deviceId) || !/^[a-f0-9]{64}$/.test(device.key))
    throw new KioskError('DEVICE_NOT_PROVISIONED');
  if (!token) throw new KioskError('GUEST_IDENTITY_UNAVAILABLE');
  const timeoutMs = Math.min(
    Math.max(options.timeoutMs ?? 15000, 1000),
    KIOSK_LONG_POLL_TIMEOUT_MS,
  );
  const { data, headers } = await sendKioskRequestWithHeaders(
    path,
    undefined,
    {
      'X-Kiosk-Device': device.deviceId,
      'X-Kiosk-Key': device.key,
      Authorization: `Bearer ${token}`,
    },
    fetcher,
    timeoutMs,
  );
  const version = headers.get('x-catalog-version');
  const signature = headers.get('x-availability-signature');
  return {
    data,
    catalogVersion: version && /^[1-9][0-9]{0,8}$/.test(version) ? Number(version) : null,
    signature: signature && /^[a-f0-9]{64}$/.test(signature) ? signature : null,
  };
}

export async function exchangeKioskEnrollment(
  input: { login: string; password: string; requestId: string },
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  if (
    !operatorCredentialsValid(input.login, input.password) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.requestId)
  )
    throw new KioskError('INVALID_ENROLLMENT');
  return sendKioskRequest('/enrollment/exchange', input, {}, fetcher);
}

async function sendKioskRequest(
  path: string,
  body: unknown,
  authentication: Record<string, string>,
  fetcher: typeof fetch,
): Promise<unknown> {
  return (await sendKioskRequestWithHeaders(path, body, authentication, fetcher, 15000)).data;
}

async function sendKioskRequestWithHeaders(
  path: string,
  body: unknown,
  authentication: Record<string, string>,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<{ data: unknown; headers: Headers }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${KIOSK_API_URL}/v1/kiosk-checkout${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...authentication,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (
      response.redirected ||
      !response.headers.get('content-type')?.includes('application/json') ||
      Number(response.headers.get('content-length') ?? 0) > 400000
    )
      throw new KioskError('INVALID_RESPONSE');
    const text = await response.text();
    if (text.length > 400000) throw new KioskError('INVALID_RESPONSE');
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new KioskError('INVALID_RESPONSE');
    }
    if (!response.ok) {
      const code =
        data &&
        typeof data === 'object' &&
        'code' in data &&
        typeof data.code === 'string' &&
        /^[A-Z_]{1,80}$/.test(data.code)
          ? data.code
          : 'API_UNAVAILABLE';
      throw new KioskError(code, response.status);
    }
    return { data, headers: response.headers };
  } catch (error) {
    throw error instanceof KioskError ? error : new KioskError('NETWORK_UNCERTAIN');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
