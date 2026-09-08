import { readFile } from 'node:fs/promises';

export const APP_ORIGIN = 'pickchick-pos://app';
export const APP_URL = `${APP_ORIGIN}/`;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const readPath = new RegExp(
  `^/edge/v1/(session|menu|ordering|orders/${UUID}|availability/stops/${UUID})$`,
  'i',
);
const writePath = new RegExp(
  `^/edge/v1/(checkout/quotes|orders|orders/${UUID}/cancel|ordering/(open|close)|availability/stops)$`,
  'i',
);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/logo.png', ['logo.png', 'image/png']],
  ...['app', 'model', 'api', 'types'].map((name) => [
    `/${name}.js`,
    [`${name}.js`, 'text/javascript; charset=utf-8'],
  ]),
]);
export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'",
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
      url.search ||
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
      url.pathname === '/config.json' ||
      readPath.test(url.pathname) ||
      writePath.test(url.pathname)),
  );
}

export function validateConfig(value = {}) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['edgePort', 'branchLabel', 'categories'].includes(key))
  )
    throw new Error('INVALID_POS_CONFIG');
  const { edgePort = 3101, branchLabel = 'Локальная точка', categories = {} } = value;
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
    Object.keys(categories).length > 200
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
  return { edgePort, branchLabel, categories: { ...categories } };
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
  return async (request) => {
    const url = localURL(request.url);
    const origin = request.headers.get('origin');
    if (!url || (origin && origin !== APP_ORIGIN)) return json(403, { code: 'FORBIDDEN' });
    const path = url.pathname;
    if (path.startsWith('/edge/')) {
      if (
        !(request.method === 'GET' && readPath.test(path)) &&
        !(request.method === 'POST' && writePath.test(path))
      )
        return json(404, { code: 'NOT_FOUND' });
      const headers = {};
      for (const name of ['authorization', 'x-staff-session-id', 'idempotency-key']) {
        const value = request.headers.get(name);
        if (value && value.length < 200) headers[name] = value;
      }
      let body;
      if (request.method === 'POST') {
        if (request.headers.get('content-type') !== 'application/json')
          return json(415, { code: 'INVALID_REQUEST' });
        try {
          body = Buffer.from(await readBounded(request.body, 64000)).toString('utf8');
          JSON.parse(body);
        } catch (error) {
          return json(error instanceof RangeError ? 413 : 400, { code: 'INVALID_REQUEST' });
        }
        headers['Content-Type'] = 'application/json';
      }
      try {
        const response = await fetchImpl(`http://127.0.0.1:${settings.edgePort}${path}`, {
          method: request.method,
          headers,
          redirect: 'error',
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
          ...(body === undefined ? {} : { body }),
        });
        if (response.redirected || (response.status >= 300 && response.status < 400))
          return json(502, { code: 'INVALID_RESPONSE' });
        const payload = await readBounded(response.body, 4000000);
        return new Response([204, 205, 304].includes(response.status) ? null : payload, {
          status: response.status,
          headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
        });
      } catch (error) {
        return json(error instanceof RangeError ? 502 : 504, {
          code: error instanceof RangeError ? 'INVALID_RESPONSE' : 'EDGE_TIMEOUT',
        });
      }
    }
    if (request.method !== 'GET') return json(405, { code: 'INVALID_REQUEST' });
    if (path === '/config.json')
      return json(200, { branchLabel: settings.branchLabel, categories: settings.categories });
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
