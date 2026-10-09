import { V2_ASSETS } from './v2-assets.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { MENU_ASSETS } from './menu-assets.mjs';

export const APP_ORIGIN = 'pickchick-pos://app';
export const APP_URL = `${APP_ORIGIN}/`;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const readPath = new RegExp(
  `^/edge/v1/(session|menu|menu/version|ordering|orders|orders/${UUID}|cash-shifts|cash-shifts/current|cash-shifts/${UUID}|availability/stops(?:/${UUID})?)$`,
  'i',
);
const writePath = new RegExp(
  `^/edge/v1/(staff/(login|pin|logout)|checkout/quotes|orders|orders/${UUID}/cancel|cash-shifts|cash-shifts/${UUID}/(?:close|movements)|ordering/(open|close)|availability/stops)$`,
  'i',
);
const assets = new Map([
  ...V2_ASSETS.map(([name, type]) => ['/' + name, [name, type]]),
  ...MENU_ASSETS.map((name) => [`/assets/menu/${name}`, [`assets/menu/${name}`, 'image/jpeg']]),
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/logo.png', ['logo.png', 'image/png']],
  ...['app', 'model', 'api', 'types', 'auth-view', 'order-view'].map((name) => [
    `/${name}.js`,
    [`${name}.js`, 'text/javascript; charset=utf-8'],
  ]),
]);
/** Published photos are content-addressed: /assets/menu/<sha256>.webp (lowercase hex only). */
export const MENU_MEDIA_PATH = /^\/assets\/menu\/([a-f0-9]{64})\.webp$/;
export const MENU_MEDIA_MAX_BYTES = 1_500_000;
const MENU_MEDIA_FALLBACK = ['v2/assets/logo.png', 'image/png'];
const isWebp = (bytes) =>
  bytes.length >= 12 &&
  bytes.toString('latin1', 0, 4) === 'RIFF' &&
  bytes.toString('latin1', 8, 12) === 'WEBP';
/** Reads one cached photo from the loopback edge. The bytes are returned only when they are a
 *  WebP whose SHA-256 is exactly the requested name; anything else yields null (fallback). */
export async function fetchMenuMedia(
  sha256,
  { edgePort, fetchImpl = globalThis.fetch, timeoutMs },
) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) return null;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${edgePort}/edge/v1/media/${sha256}.webp`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(timeoutMs, 5000)),
    });
    if (response.status !== 200 || response.redirected) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const bytes = Buffer.from(await readBounded(response.body, MENU_MEDIA_MAX_BYTES));
    if (!isWebp(bytes) || createHash('sha256').update(bytes).digest('hex') !== sha256) return null;
    return bytes;
  } catch {
    return null;
  }
}
/** Verified photos are immutable by name, so a small in-memory cache spares the edge database.
 *  Failures are never cached: the photo appears as soon as the edge has downloaded it. */
export function createMenuMediaCache({ maxBytes = 24 * 1024 * 1024 } = {}) {
  const entries = new Map();
  let size = 0;
  return {
    get(sha256) {
      const bytes = entries.get(sha256);
      if (bytes) {
        entries.delete(sha256);
        entries.set(sha256, bytes);
      }
      return bytes;
    },
    set(sha256, bytes) {
      if (entries.has(sha256) || bytes.length > maxBytes) return;
      entries.set(sha256, bytes);
      size += bytes.length;
      for (const [key, value] of entries) {
        if (size <= maxBytes) break;
        entries.delete(key);
        size -= value.length;
      }
    },
  };
}
/** Resolves a hash photo to verified WebP bytes or the bundled logo. */
export async function menuMediaResponse(
  sha256,
  { edgePort, fetchImpl, timeoutMs, cache, assetDir },
) {
  let bytes = cache.get(sha256);
  if (!bytes) {
    bytes = await fetchMenuMedia(sha256, { edgePort, fetchImpl, timeoutMs });
    if (bytes) cache.set(sha256, bytes);
  }
  if (bytes) return { status: 200, type: 'image/webp', bytes };
  try {
    return {
      status: 200,
      type: MENU_MEDIA_FALLBACK[1],
      bytes: await readFile(new URL(MENU_MEDIA_FALLBACK[0], assetDir)),
      fallback: true,
    };
  } catch {
    return null;
  }
}
export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'",
};

function localURL(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'pickchick-pos:' ||
      url.hostname !== 'app' ||
      url.port ||
      url.username ||
      url.password ||
      (url.search &&
        (url.pathname !== '/edge/v1/orders' ||
          !new RegExp(`^\\?shift_id=${UUID}$`, 'i').test(url.search))) ||
      url.hash
    )
      return null;
    return url;
  } catch {
    return null;
  }
}
export function isAllowedRendererURL(value) {
  const url = localURL(value);
  return Boolean(
    url &&
    (assets.has(url.pathname) ||
      MENU_MEDIA_PATH.test(url.pathname) ||
      url.pathname === '/config.json' ||
      url.pathname === '/health/ready' ||
      readPath.test(url.pathname) ||
      writePath.test(url.pathname)),
  );
}

export function validateConfig(value = {}) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !['edgePort', 'branchLabel', 'categories', 'terminalId'].includes(key),
    )
  )
    throw new Error('INVALID_POS_CONFIG');
  const { edgePort = 3101, branchLabel = 'Локальная точка', categories = {}, terminalId } = value;
  if (
    !Number.isInteger(edgePort) ||
    edgePort < 1 ||
    edgePort > 65535 ||
    typeof branchLabel !== 'string' ||
    !branchLabel.trim() ||
    branchLabel.length > 120 ||
    !categories ||
    typeof categories !== 'object' ||
    Array.isArray(categories) ||
    Object.keys(categories).length > 200 ||
    (terminalId !== undefined &&
      (typeof terminalId !== 'string' || !new RegExp(`^${UUID}$`, 'i').test(terminalId)))
  )
    throw new Error('INVALID_POS_CONFIG');
  for (const [id, label] of Object.entries(categories)) {
    if (
      !new RegExp(`^${UUID}$`, 'i').test(id) ||
      typeof label !== 'string' ||
      !label.length ||
      label.length > 100
    )
      throw new Error('INVALID_POS_CONFIG');
  }
  return {
    edgePort,
    branchLabel,
    categories: { ...categories },
    ...(terminalId === undefined ? {} : { terminalId }),
  };
}

async function readBounded(stream, limit) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RangeError('BODY_LIMIT');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** The renderer can select neither a file path nor an upstream host.
 *  Routes match apps/pos/server.mjs; this adapter changes transport only. */
export function createProtocolHandler({
  assetDir,
  config = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
  onSession = () => {},
}) {
  const settings = validateConfig(config);
  if (
    !(assetDir instanceof URL) ||
    assetDir.protocol !== 'file:' ||
    !assetDir.pathname.endsWith('/')
  )
    throw new Error('INVALID_ASSET_DIRECTORY');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error('INVALID_TIMEOUT');
  const mediaCache = createMenuMediaCache();
  return async (request) => {
    const url = localURL(request.url);
    const origin = request.headers.get('origin');
    if (!url || (origin && origin !== APP_ORIGIN)) return json(403, { code: 'FORBIDDEN' });
    const path = url.pathname;
    if (path.startsWith('/edge/') || path === '/health/ready') {
      if (
        (request.method !== 'GET' && url.search) ||
        (!(request.method === 'GET' && (readPath.test(path) || path === '/health/ready')) &&
          !(request.method === 'POST' && writePath.test(path)))
      )
        return json(404, { code: 'NOT_FOUND' });
      const headers = {};
      const authenticating = request.method === 'GET' && path === '/edge/v1/session';
      if (
        authenticating ||
        ['/edge/v1/staff/login', '/edge/v1/staff/pin'].includes(path) ||
        path === '/edge/v1/staff/logout'
      )
        onSession(null);
      for (const name of ['authorization', 'x-staff-session-id', 'idempotency-key']) {
        const value = request.headers.get(name);
        if (value && value.length < 200) headers[name] = value;
      }
      let body;
      if (request.method === 'POST') {
        if (request.headers.get('content-type') !== 'application/json')
          return json(415, { code: 'INVALID_REQUEST' });
        try {
          body = Buffer.from(
            await readBounded(
              request.body,
              ['/edge/v1/staff/login', '/edge/v1/staff/pin'].includes(path) ? 2048 : 64000,
            ),
          ).toString('utf8');
          JSON.parse(body);
        } catch (error) {
          return json(error instanceof RangeError ? 413 : 400, { code: 'INVALID_REQUEST' });
        }
        headers['Content-Type'] = 'application/json';
      }
      try {
        const response = await fetchImpl(
          `http://127.0.0.1:${settings.edgePort}${path}${url.search}`,
          {
            method: request.method,
            headers,
            redirect: 'error',
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
            ...(body === undefined ? {} : { body }),
          },
        );
        if (response.redirected || (response.status >= 300 && response.status < 400))
          return json(502, { code: 'INVALID_RESPONSE' });
        const payload = await readBounded(response.body, 4000000);
        if ([401, 403].includes(response.status)) onSession(null);
        if (authenticating && response.status === 200) {
          try {
            onSession(
              JSON.parse(Buffer.from(payload).toString('utf8')),
              headers['x-staff-session-id'],
            );
          } catch {
            onSession(null);
          }
        }
        return new Response([204, 205, 304].includes(response.status) ? null : payload, {
          status: response.status,
          headers: {
            ...SECURITY_HEADERS,
            'Content-Type': 'application/json; charset=utf-8',
            ...(response.status === 429 &&
            /^[1-9][0-9]{0,3}$/.test(response.headers.get('retry-after') ?? '')
              ? { 'Retry-After': response.headers.get('retry-after') }
              : {}),
          },
        });
      } catch (error) {
        return json(error instanceof RangeError ? 502 : 504, {
          code: error instanceof RangeError ? 'INVALID_RESPONSE' : 'EDGE_TIMEOUT',
        });
      }
    }
    if (request.method !== 'GET') return json(405, { code: 'INVALID_REQUEST' });
    if (path === '/config.json')
      return json(200, {
        branchLabel: settings.branchLabel,
        categories: settings.categories,
        ...(settings.terminalId ? { terminalId: settings.terminalId } : {}),
      });
    const media = MENU_MEDIA_PATH.exec(path);
    if (media) {
      const result = await menuMediaResponse(media[1], {
        edgePort: settings.edgePort,
        fetchImpl,
        timeoutMs,
        cache: mediaCache,
        assetDir,
      });
      if (!result) return json(404, { code: 'NOT_FOUND' });
      return new Response(result.bytes, {
        headers: { ...SECURITY_HEADERS, 'Content-Type': result.type },
      });
    }
    const asset = assets.get(path);
    if (!asset) return json(404, { code: 'NOT_FOUND' });
    try {
      return new Response(await readFile(new URL(asset[0], assetDir)), {
        headers: { ...SECURITY_HEADERS, 'Content-Type': asset[1] },
      });
    } catch {
      return json(503, { code: 'ASSETS_NOT_BUILT' });
    }
  };
}
