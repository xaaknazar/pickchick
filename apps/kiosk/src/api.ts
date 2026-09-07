export const KIOSK_API_URL = 'https://pickchick.185.129.51.103.nip.io';
export class KioskError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 0) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** Only the existing synthetic API is reachable through this client. */
export async function kioskRequest(
  path: string,
  token?: string,
  body?: unknown,
  key?: string,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  if (
    !/^\/(?:capabilities|catalog|sessions(?:\/continue)?|quotes|orders(?:\/[a-f0-9-]{36}(?:\/(?:simulated-payment|cancel))?)?)$/.test(
      path,
    )
  )
    throw new KioskError('INVALID_PATH');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new KioskError('NETWORK_UNCERTAIN'));
    }, 10000);
  });
  const run = async () => {
    const url =
      path === '/capabilities'
        ? `${KIOSK_API_URL}/v1/capabilities`
        : `${KIOSK_API_URL}/v1/test${path}?catalog_version=mockup-v0.3`;
    const response = await fetcher(url, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (
      response.redirected ||
      !response.headers.get('content-type')?.includes('application/json') ||
      Number(response.headers.get('content-length') ?? 0) > 2000000
    )
      throw new KioskError('INVALID_RESPONSE');
    const raw = await response.text();
    if (raw.length > 2000000) throw new KioskError('INVALID_RESPONSE');
    let data: unknown;
    try {
      data = JSON.parse(raw);
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
  };
  try {
    return await Promise.race([run(), timeout]);
  } catch (error) {
    throw error instanceof KioskError ? error : new KioskError('NETWORK_UNCERTAIN');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
