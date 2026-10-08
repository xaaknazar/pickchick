import { V2_ASSETS } from '../pos-desktop/v2-assets.mjs';
import { createServer } from 'node:http';
import { MENU_ASSETS } from '../pos-desktop/menu-assets.mjs';
import {
  MENU_MEDIA_PATH,
  createMenuMediaCache,
  menuMediaResponse,
} from '../pos-desktop/protocol.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const allowed = (method, path) =>
  method === 'GET'
    ? new RegExp(
        `^/edge/v1/(session|menu|menu/version|ordering|orders(?:\\?shift_id=${UUID})?|orders/${UUID}|cash-shifts|cash-shifts/current|cash-shifts/${UUID}|availability/stops(?:/${UUID})?)$`,
        'i',
      ).test(path)
    : method === 'POST' &&
      new RegExp(
        `^/edge/v1/(staff/(login|pin|logout)|checkout/quotes|orders|orders/${UUID}/cancel|cash-shifts|cash-shifts/${UUID}/(?:close|movements)|ordering/(open|close)|availability/stops)$`,
        'i',
      ).test(path);
const assets = new Map([
  ...V2_ASSETS.map(([name, type]) => ['/' + name, [name, type]]),
  ...MENU_ASSETS.map((name) => [`/assets/menu/${name}`, [`assets/menu/${name}`, 'image/jpeg']]),
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/logo.png', ['logo.png', 'image/png']],
  ...['app', 'model', 'api', 'types', 'auth-view', 'order-view'].map((n) => [
    `/${n}.js`,
    [`${n}.js`, 'text/javascript; charset=utf-8'],
  ]),
]);
const security = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
/** Loopback-only staff client. The upstream is configured by the operator, never by a request. */
export function createPosServer({
  edgePort = 3101,
  assetDir = new URL('dist/', import.meta.url),
  branchLabel = 'Локальная точка',
  categories = {},
  terminalId,
  timeoutMs = 10000,
} = {}) {
  if (!Number.isInteger(edgePort) || edgePort < 1 || edgePort > 65535)
    throw new Error('Invalid local edge port');
  if (
    terminalId !== undefined &&
    (typeof terminalId !== 'string' || !new RegExp(`^${UUID}$`, 'i').test(terminalId))
  )
    throw new Error('Invalid terminal id');
  const config = {
    ...(terminalId === undefined ? {} : { terminalId }),
    branchLabel: String(branchLabel).slice(0, 120),
    categories: Object.fromEntries(
      Object.entries(categories).filter(
        ([id, label]) =>
          new RegExp(`^${UUID}$`, 'i').test(id) && typeof label === 'string' && label.length <= 100,
      ),
    ),
  };
  const mediaCache = createMenuMediaCache();
  return createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { ...security, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };
    const host = req.headers.host,
      expected = `127.0.0.1:${req.socket.localPort}`;
    if (
      host !== expected ||
      (req.headers.origin && req.headers.origin !== `http://${expected}`) ||
      req.headers['sec-fetch-site'] === 'cross-site'
    ) {
      send(403, { code: 'FORBIDDEN' });
      return;
    }
    const path = req.url ?? '';
    if (path.startsWith('/edge/') || path === '/health/ready') {
      if (!(req.method === 'GET' && path === '/health/ready') && !allowed(req.method, path)) {
        send(404, { code: 'NOT_FOUND' });
        return;
      }
      const headers = {};
      for (const name of ['authorization', 'x-staff-session-id', 'idempotency-key']) {
        const value = req.headers[name];
        if (typeof value === 'string' && value.length < 200) headers[name] = value;
      }
      let body;
      if (req.method === 'POST') {
        if (req.headers['content-type'] !== 'application/json') {
          send(415, { code: 'INVALID_REQUEST' });
          return;
        }
        const chunks = [];
        let size = 0;
        try {
          for await (const chunk of req) {
            size += chunk.length;
            if (
              size > (['/edge/v1/staff/login', '/edge/v1/staff/pin'].includes(path) ? 2048 : 64000)
            ) {
              send(413, { code: 'INVALID_REQUEST' });
              return;
            }
            chunks.push(chunk);
          }
        } catch {
          if (!res.destroyed) send(400, { code: 'INVALID_REQUEST' });
          return;
        }
        body = Buffer.concat(chunks).toString('utf8');
        try {
          JSON.parse(body);
        } catch {
          send(400, { code: 'INVALID_REQUEST' });
          return;
        }
        headers['Content-Type'] = 'application/json';
      }
      try {
        const response = await fetch(`http://127.0.0.1:${edgePort}${path}`, {
          method: req.method,
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          ...(body === undefined ? {} : { body }),
        });
        const payload = await response.text();
        if (payload.length > 4000000) {
          send(502, { code: 'INVALID_RESPONSE' });
          return;
        }
        // Only a bounded numeric retry hint crosses the response-header boundary.
        res.writeHead(response.status, {
          ...security,
          ...(response.status === 429 &&
          /^[1-9][0-9]{0,3}$/.test(response.headers.get('retry-after') ?? '')
            ? { 'Retry-After': response.headers.get('retry-after') }
            : {}),
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(payload);
      } catch {
        send(504, { code: 'EDGE_TIMEOUT' });
      }
      return;
    }
    if (req.method !== 'GET') {
      send(405, { code: 'INVALID_REQUEST' });
      return;
    }
    if (path === '/config.json') {
      send(200, config);
      return;
    }
    const media = MENU_MEDIA_PATH.exec(path);
    if (media) {
      // Published photos come only from the configured loopback edge and are hash-verified.
      const result = await menuMediaResponse(media[1], {
        edgePort,
        timeoutMs,
        cache: mediaCache,
        assetDir,
      });
      if (!result) {
        send(404, { code: 'NOT_FOUND' });
        return;
      }
      res.writeHead(200, { ...security, 'Content-Type': result.type });
      res.end(result.bytes);
      return;
    }
    const asset = assets.get(path);
    if (!asset) {
      send(404, { code: 'NOT_FOUND' });
      return;
    }
    try {
      const data = await readFile(new URL(asset[0], assetDir));
      res.writeHead(200, { ...security, 'Content-Type': asset[1] });
      res.end(data);
    } catch {
      send(503, { code: 'ASSETS_NOT_BUILT' });
    }
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.POS_PORT ?? 4176),
    edgePort = Number(process.env.POS_EDGE_PORT ?? process.env.EDGE_PORT ?? 3101);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid POS port');
  let config = {};
  if (process.env.POS_CONFIG_FILE)
    config = JSON.parse(await readFile(process.env.POS_CONFIG_FILE, 'utf8'));
  const server = createPosServer({ edgePort, ...config });
  server.listen(port, '127.0.0.1', () => console.log(`PickChick POS: http://127.0.0.1:${port}`));
}
