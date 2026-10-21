import type { PhotoIO } from './controller';

const TOKEN = 'pickchick.photo-mac.token';
const PENDING = 'pickchick.photo-mac.pending';

/** Only the separate, explicitly enabled Mac test build can use this adapter. */
export function createMacPreviewIO(
  browser = typeof window === 'undefined' ? null : window,
): PhotoIO | null {
  if (
    !browser ||
    browser.location.protocol !== 'http:' ||
    browser.location.hostname !== '127.0.0.1' ||
    !browser.location.port
  )
    return null;
  const origin = browser.location.origin;
  const fragment = new URLSearchParams(browser.location.hash.slice(1));
  const supplied = fragment.get('photo-key');
  if (supplied && /^[a-f0-9]{64}$/.test(supplied)) {
    // Tab-local credential, never a photo. Keep pending state if this is the same operator session.
    if (browser.sessionStorage.getItem(TOKEN) !== supplied)
      browser.sessionStorage.removeItem(PENDING);
    browser.sessionStorage.setItem(TOKEN, supplied);
    browser.history.replaceState(null, '', browser.location.pathname + browser.location.search);
  }
  const token = browser.sessionStorage.getItem(TOKEN);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const config = { url: origin, token };
  return {
    readConfig: async () => config,
    writeConfig: async () => {
      throw Error('ADDRESS');
    },
    readPending: async () => browser.sessionStorage.getItem(PENDING),
    writePending: async (id) => {
      if (id) browser.sessionStorage.setItem(PENDING, id);
      else browser.sessionStorage.removeItem(PENDING);
    },
    uuid: () => browser.crypto.randomUUID(),
    now: Date.now,
    request: async <T>(
      c: { url: string; token: string },
      path: string,
      body?: unknown,
      method?: string,
    ): Promise<T> => {
      if (
        c.url !== origin ||
        c.token !== token ||
        !/^\/v1\/(status|previews|jobs)(\/[a-f0-9-]{36})?$/.test(path)
      )
        throw Error('ADDRESS');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await browser.fetch(origin + path, {
          method: method ?? (body ? 'POST' : 'GET'),
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          redirect: 'error',
          cache: 'no-store',
        });
        const result = await response.json();
        if (!response.ok)
          throw Error(
            response.status < 500 && typeof result.code === 'string' ? result.code : 'CONNECTION',
          );
        return result as T;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
