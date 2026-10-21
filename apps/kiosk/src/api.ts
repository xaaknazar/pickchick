/** Staging API (the VPS nip.io host). Development builds, Storybook and tests keep it. */
export const KIOSK_STAGING_API_URL = 'https://pickchick.185.129.51.103.nip.io';
/** Production API (PM decision 19.10, audit finding 7.3). */
export const KIOSK_PRODUCTION_API_URL = 'https://api.pickchick.kz';
export type KioskBuildProfile = 'production' | 'staging';
/** A bare origin: https, or http only on this machine (Storybook, local development). */
function apiOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !local) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['', '/'].includes(url.pathname)
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
/**
 * API origin from the build config (finding 7.3): the production profile always uses the
 * production domain; otherwise an explicit EXPO_PUBLIC_KIOSK_API_URL origin, then the staging host
 * (the behaviour of every build before 19.10). scripts/mobile/ios_release.py pins both values for
 * a release and checks them in the archived bundle.
 */
export function kioskApiUrl(env: { profile?: string; url?: string }): string {
  if (env.profile === 'production') return KIOSK_PRODUCTION_API_URL;
  return apiOrigin(env.url) ?? KIOSK_STAGING_API_URL;
}
export const KIOSK_BUILD_PROFILE: KioskBuildProfile =
  process.env.EXPO_PUBLIC_KIOSK_BUILD_PROFILE === 'production' ? 'production' : 'staging';
export const KIOSK_API_URL = kioskApiUrl({
  profile: process.env.EXPO_PUBLIC_KIOSK_BUILD_PROFILE,
  url: process.env.EXPO_PUBLIC_KIOSK_API_URL,
});
/**
 * Release id pinned by scripts/mobile/ios_release.py (finding 3.5). The release finds it in the
 * archived bundle as proof that the pinned public values reached this build; device presence
 * reports it so the cabinet shows which release an iPad runs. Null in development builds.
 */
export const KIOSK_RELEASE_ID = kioskReleaseId(process.env.EXPO_PUBLIC_KIOSK_RELEASE_ID);
export function kioskReleaseId(value: string | undefined): string | null {
  return value && /^pk-[0-9a-f]{16}$/.test(value) ? value : null;
}
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
        : `${KIOSK_API_URL}/v1/test${path}?catalog_version=mockup-v0.3&number_format=daily`;
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
