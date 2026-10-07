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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
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
    return data;
  } catch (error) {
    throw error instanceof KioskError ? error : new KioskError('NETWORK_UNCERTAIN');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
