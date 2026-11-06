import { V2_ASSETS } from './v2-assets.mjs';
import { readFile } from 'node:fs/promises';
import { createHash, X509Certificate } from 'node:crypto';
import { request as requestHttps } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { connect as connectTls } from 'node:tls';
import { MENU_ASSETS } from './menu-assets.mjs';
import { validatePrinter } from './printer.mjs';

export const APP_ORIGIN = 'pickchick-pos://app';
export const APP_URL = `${APP_ORIGIN}/`;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
/**
 * Paid-sale routes of the cashier (cutover 19.11, contracts section 5.5), one definition for
 * this adapter and apps/pos/server.mjs. The edge answers 404 until it runs pos_sale.
 */
export const SALE_ROUTES = Object.freeze({
  read: Object.freeze([
    'pos/config',
    `pos/sales/${UUID}`,
    'pos/fiscal-receipts/pending',
    `cash-shifts/${UUID}/x-report`,
    `cash-shifts/${UUID}/z-report`,
  ]),
  write: Object.freeze([
    'staff/approvals',
    'pos/sales',
    `pos/sales/${UUID}/void`,
    `pos/sales/${UUID}/refunds`,
    `pos/fiscal-receipts/${UUID}/record`,
  ]),
});
/** GET paths that may carry exactly one `?shift_id=<uuid>` filter (today's orders, receipts). */
export const SHIFT_FILTERED = Object.freeze(['orders', 'pos/fiscal-receipts/pending']);
const readPath = new RegExp(
  `^/edge/v1/(session|menu|menu/version|ordering|cloud-link|orders|orders/${UUID}|cash-shifts|cash-shifts/current|cash-shifts/${UUID}|availability/stops(?:/${UUID})?|${SALE_ROUTES.read.join('|')})$`,
  'i',
);
const writePath = new RegExp(
  `^/edge/v1/(staff/(login|pin|logout)|checkout/quotes|orders|orders/${UUID}/cancel|cash-shifts|cash-shifts/${UUID}/(?:close|movements)|ordering/(open|close)|availability/stops|${SALE_ROUTES.write.join('|')})$`,
  'i',
);
/** The edge routes of this desk; the CL-4 `pos` gateway profile mirrors them (section 5.5). */
export { readPath as EDGE_READ_PATH, writePath as EDGE_WRITE_PATH };
/**
 * POST paths forwarded without a body or Content-Type: the renderer ends a session with a bare
 * POST staff/logout, which the edge revokes by its headers alone. The `pos` gateway profile lists
 * the same paths as bodyless and refuses a body on them.
 */
export const BODYLESS_WRITES = Object.freeze(['/edge/v1/staff/logout']);
/**
 * `client_version` of GET pos/config (CR pos-2 section 1.1): the edge records which build each
 * desk runs for the pos-sales-setup status. This adapter adds its own build; the renderer cannot
 * choose it. A subset of the edge's format without '+', so no character needs encoding (the
 * gateway refuses '%' in a request target).
 */
export const CLIENT_VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
/**
 * Version of the installed build in /config.json (CR client-5): the lock screen of a desk that
 * sells names it. The same format as apps/pos/src/v2/mode-texts.js APP_VERSION.
 */
export const APP_VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.]{1,32})?$/;
/** app.getVersion() when it has that format, or undefined (then no version is shown). */
export const desktopAppVersion = (appVersion) =>
  typeof appVersion === 'string' && APP_VERSION.test(appVersion) ? appVersion : undefined;
/** The client_version of an installed build, or undefined when that version cannot be sent. */
export function desktopClientVersion(appVersion) {
  const value = `pos-desktop-${appVersion}`;
  return typeof appVersion === 'string' &&
    /^[0-9A-Za-z]/.test(appVersion) &&
    CLIENT_VERSION.test(value)
    ? value
    : undefined;
}
/** PIN checks typed on this desk: small bodies only (contracts section 5.1, staff/approvals). */
const PIN_PATHS = ['/edge/v1/staff/login', '/edge/v1/staff/pin', '/edge/v1/staff/approvals'];
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
/** Reads one cached photo from the configured edge: the loopback edge, or `transport` (the
 *  desktop's edge transport, pinned TLS for a remote edge). The bytes are returned only when they
 *  are a WebP whose SHA-256 is exactly the requested name; anything else yields null (fallback). */
export async function fetchMenuMedia(
  sha256,
  { edgePort, fetchImpl = globalThis.fetch, timeoutMs, transport },
) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) return null;
  try {
    const path = `/edge/v1/media/${sha256}.webp`;
    const init = {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(timeoutMs, 5000)),
    };
    const response = await (transport
      ? transport(path, init)
      : fetchImpl(`http://127.0.0.1:${edgePort}${path}`, init));
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
  { edgePort, fetchImpl, timeoutMs, cache, assetDir, transport },
) {
  let bytes = cache.get(sha256);
  if (!bytes) {
    bytes = await fetchMenuMedia(sha256, { edgePort, fetchImpl, timeoutMs, transport });
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
        (!SHIFT_FILTERED.some((path) => url.pathname === `/edge/v1/${path}`) ||
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

/**
 * Operator-owned trust of a remote edge (contracts CL-2, section 6.1): the LAN gateway of the
 * branch server at a private IPv4 and its one pinned certificate, which must name that IP and be
 * valid now. Same rules as apps/kitchen/server.mjs validateUpstream. Both keys absent: loopback,
 * exactly as before. Never sent to the renderer.
 */
export function validateUpstream({ edgeHost, edgeCertificatePem } = {}) {
  if (edgeHost === undefined && edgeCertificatePem === undefined) return {};
  try {
    if (typeof edgeHost !== 'string' || isIP(edgeHost) !== 4) throw new Error();
    const [a, b] = edgeHost.split('.').map(Number);
    if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)))
      throw new Error();
    if (typeof edgeCertificatePem !== 'string' || edgeCertificatePem.length > 16384)
      throw new Error();
    const pem = edgeCertificatePem.trim();
    if (
      !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----$/.test(
        pem,
      )
    )
      throw new Error();
    const certificate = new X509Certificate(pem);
    if (
      certificate.checkIP(edgeHost) !== edgeHost ||
      Date.parse(certificate.validFrom) > Date.now() ||
      Date.parse(certificate.validTo) <= Date.now()
    )
      throw new Error();
    return { edgeHost, edgeCertificatePem: pem + '\n' };
  } catch {
    throw new Error('INVALID_POS_CONFIG');
  }
}

export function validateConfig(value = {}) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'edgePort',
          'branchLabel',
          'categories',
          'terminalId',
          'pinLength',
          'edgeHost',
          'edgeCertificatePem',
          'printer',
        ].includes(key),
    )
  )
    throw new Error('INVALID_POS_CONFIG');
  const upstream = validateUpstream(value);
  const printer = validatePrinter(value.printer);
  const {
    edgePort = 3101,
    branchLabel = 'Локальная точка',
    categories = {},
    terminalId,
    pinLength,
  } = value;
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
      (typeof terminalId !== 'string' || !new RegExp(`^${UUID}$`, 'i').test(terminalId))) ||
    // 6 only after every staff PIN of the branch was re-enrolled with 6 digits (6.5).
    (pinLength !== undefined && pinLength !== 4 && pinLength !== 6)
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
    ...(pinLength === undefined ? {} : { pinLength }),
    ...upstream,
    ...(printer === undefined ? {} : { printer }),
  };
}

/**
 * HTTPS to the remote edge, trusting only the pinned certificate (contracts CL-2). One TLS
 * connection per request and no agent, so no pooled socket is shared with another trust; Node
 * never follows a redirect and there is no code path to plain HTTP. `dial` (tests only) supplies
 * the TCP socket; certificate and IP checks are the same either way.
 */
function pinnedRequest({ edgeHost, edgePort, edgeCertificatePem }, path, init, dial) {
  return new Promise((resolve, reject) => {
    const tls = {
      host: edgeHost,
      port: edgePort,
      ca: edgeCertificatePem,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      ALPNProtocols: ['http/1.1'],
    };
    const upstream = requestHttps(
      {
        host: edgeHost,
        port: edgePort,
        path,
        method: init.method,
        // The gateway accepts exactly its own address as Host.
        headers: { ...init.headers, Host: `${edgeHost}:${edgePort}` },
        signal: init.signal,
        createConnection: () =>
          connectTls(dial ? { ...tls, socket: dial(edgeHost, edgePort) } : tls),
      },
      (response) => {
        const status = response.statusCode ?? 502;
        try {
          const headers = new globalThis.Headers();
          for (const key of ['content-type', 'content-length', 'retry-after']) {
            const value = response.headers[key];
            if (typeof value === 'string') headers.set(key, value);
          }
          // Redirects are answered as INVALID_RESPONSE by the caller and never followed.
          const empty = [204, 205, 304].includes(status) || (status >= 300 && status < 400);
          if (empty) response.resume();
          resolve(new Response(empty ? null : Readable.toWeb(response), { status, headers }));
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );
    upstream.on('error', reject);
    upstream.end(init.body);
  });
}

/**
 * The one way this desk reaches its edge: `(path, init) => Response`. Without edgeHost it is
 * plain HTTP to 127.0.0.1:edgePort through fetchImpl, byte for byte as before; with edgeHost it is
 * pinned HTTPS only, and fetchImpl is never used (no fallback to HTTP).
 */
export function createEdgeTransport(settings, { fetchImpl = globalThis.fetch, dial } = {}) {
  if (!settings.edgeHost)
    return (path, init) => fetchImpl(`http://127.0.0.1:${settings.edgePort}${path}`, init);
  return (path, init) => pinnedRequest(settings, path, init, dial);
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
 *  Routes match apps/pos/server.mjs; this adapter changes transport only.
 *  `clientVersion` (desktopClientVersion of the app) is added to GET pos/config only.
 *  `appVersion` (desktopAppVersion of the app) is published in /config.json.
 *  `dial` is for tests of the pinned remote edge only (see createEdgeTransport). */
export function createProtocolHandler({
  assetDir,
  config = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
  onSession = () => {},
  clientVersion,
  appVersion,
  dial,
}) {
  const settings = validateConfig(config);
  const edge = createEdgeTransport(settings, { fetchImpl, dial });
  if (
    clientVersion !== undefined &&
    (typeof clientVersion !== 'string' || !CLIENT_VERSION.test(clientVersion))
  )
    throw new Error('INVALID_CLIENT_VERSION');
  if (appVersion !== undefined && (typeof appVersion !== 'string' || !APP_VERSION.test(appVersion)))
    throw new Error('INVALID_APP_VERSION');
  if (
    !(assetDir instanceof URL) ||
    assetDir.protocol !== 'file:' ||
    !assetDir.pathname.endsWith('/')
  )
    throw new Error('INVALID_ASSET_DIRECTORY');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error('INVALID_TIMEOUT');
  const mediaCache = createMenuMediaCache();
  // Session id whose GET /session last granted the native journal its authority.
  let journalSession = null;
  const revoke = () => {
    journalSession = null;
    onSession(null);
  };
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
      for (const name of ['authorization', 'x-staff-session-id', 'idempotency-key']) {
        const value = request.headers.get(name);
        if (value && value.length < 200) headers[name] = value;
      }
      const authenticating = request.method === 'GET' && path === '/edge/v1/session';
      // Only the session that holds journal authority can lose it. An isolated PIN check (the
      // shift-close dialog) and another person's credential (logout of a non-manager PIN) never
      // revoke the logged-in cashier's journal; a request without a session id still does.
      // A shift manager approval refused with 401/403 is a wrong manager PIN, not this session
      // ending (contracts section 5.1, R13); the cashier's next ordinary request tells that.
      const pinCheck = path === '/edge/v1/staff/pin' || path === '/edge/v1/staff/approvals';
      const ownSession =
        !headers['x-staff-session-id'] || headers['x-staff-session-id'] === journalSession;
      if (
        authenticating ||
        path === '/edge/v1/staff/login' ||
        (path === '/edge/v1/staff/logout' && ownSession)
      )
        revoke();
      let body;
      // A bodyless path (logout) is forwarded without a body, whatever the renderer attached.
      if (request.method === 'POST' && !BODYLESS_WRITES.includes(path)) {
        if (request.headers.get('content-type') !== 'application/json')
          return json(415, { code: 'INVALID_REQUEST' });
        try {
          body = Buffer.from(
            await readBounded(request.body, PIN_PATHS.includes(path) ? 2048 : 64000),
          ).toString('utf8');
          JSON.parse(body);
        } catch (error) {
          return json(error instanceof RangeError ? 413 : 400, { code: 'INVALID_REQUEST' });
        }
        headers['Content-Type'] = 'application/json';
      }
      // GET pos/config never carries a renderer query (localURL); the build reported is ours.
      const search =
        clientVersion && request.method === 'GET' && path === '/edge/v1/pos/config'
          ? `?client_version=${clientVersion}`
          : url.search;
      try {
        const response = await edge(`${path}${search}`, {
          method: request.method,
          headers,
          redirect: 'error',
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
          ...(body === undefined ? {} : { body }),
        });
        if (response.redirected || (response.status >= 300 && response.status < 400))
          return json(502, { code: 'INVALID_RESPONSE' });
        const payload = await readBounded(response.body, 4000000);
        if ([401, 403].includes(response.status) && !pinCheck && ownSession) revoke();
        if (authenticating && response.status === 200) {
          try {
            onSession(
              JSON.parse(Buffer.from(payload).toString('utf8')),
              headers['x-staff-session-id'],
            );
            journalSession = headers['x-staff-session-id'] ?? null;
          } catch {
            revoke();
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
        ...(appVersion ? { appVersion } : {}),
      });
    const media = MENU_MEDIA_PATH.exec(path);
    if (media) {
      const result = await menuMediaResponse(media[1], {
        timeoutMs,
        cache: mediaCache,
        assetDir,
        transport: edge,
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
