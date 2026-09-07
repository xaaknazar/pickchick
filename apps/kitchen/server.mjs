import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const base = '/edge/v1/fulfillment';
export function allowed(method, raw) {
  if (!raw.startsWith(base) || raw.includes('%') || raw.includes('#')) return false;
  const u = new URL(raw, 'http://127.0.0.1');
  if (method === 'POST')
    return !u.search && new RegExp(`^${base}/orders/${UUID}/actions$`, 'i').test(u.pathname);
  if (method !== 'GET') return false;
  let keys;
  if ([base + '/config', base + '/stations'].includes(u.pathname)) keys = [];
  else if (u.pathname === base + '/kitchen') keys = ['stationId', 'afterOrderId', 'limit'];
  else if (u.pathname === base + '/display') keys = ['afterNumber', 'limit'];
  else if (new RegExp(`^${base}/orders/${UUID}$`, 'i').test(u.pathname)) keys = ['stationId'];
  else return false;
  for (const [k, v] of u.searchParams) {
    if (!keys.includes(k) || u.searchParams.getAll(k).length !== 1) return false;
    if (['stationId', 'afterOrderId'].includes(k) && !new RegExp('^' + UUID + '$', 'i').test(v))
      return false;
    if (k === 'limit' && (!/^[1-9]\d{0,2}$/.test(v) || Number(v) > 100)) return false;
    if (k === 'afterNumber' && (!/^[1-9]\d{0,18}$/.test(v) || BigInt(v) > 9223372036854775807n))
      return false;
  }
  return true;
}
const security = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ...['app', 'model', 'types', 'api'].map((n) => [
    '/' + n + '.js',
    [n + '.js', 'text/javascript; charset=utf-8'],
  ]),
  ...['logo.png', 'bg-blue.png'].map((n) => ['/' + n, [n, 'image/png']]),
  ...[
    'golos-text-2f175b8fc40e',
    'golos-text-f8d71091110f',
    'montserrat-6438d7b8ea9c',
    'montserrat-0b00fbd6edcc',
  ].map((n) => ['/fonts/' + n + '.woff2', ['fonts/' + n + '.woff2', 'font/woff2']]),
]);
export function createKitchenServer({
  edgePort = 3101,
  assetDir = new URL('dist/', import.meta.url),
  branchLabel = 'Локальная точка',
  timeoutMs = 10000,
} = {}) {
  if (!Number.isInteger(edgePort) || edgePort < 1 || edgePort > 65535)
    throw new Error('Invalid edge port');
  return createServer(async (req, res) => {
    const send = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, { ...security, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const host = `127.0.0.1:${req.socket.localPort}`;
    if (
      req.headers.host !== host ||
      (req.headers.origin && req.headers.origin !== `http://${host}`) ||
      req.headers['sec-fetch-site'] === 'cross-site'
    ) {
      send(403, { code: 'FORBIDDEN' });
      return;
    }
    const path = req.url ?? '';
    if (path.startsWith('/edge/')) {
      if (!allowed(req.method, path)) {
        send(404, { code: 'NOT_FOUND' });
        return;
      }
      const headers = { Accept: 'application/json' };
      for (const k of ['authorization', 'x-staff-session-id', 'x-terminal-id', 'idempotency-key']) {
        const v = req.headers[k];
        if (v !== undefined && (typeof v !== 'string' || v.length > 200)) {
          send(400, { code: 'INVALID_REQUEST' });
          return;
        }
        if (v) headers[k] = v;
      }
      let body;
      if (req.method === 'POST') {
        if (req.headers['content-type'] !== 'application/json') {
          send(415, { code: 'INVALID_REQUEST' });
          return;
        }
        if (Number(req.headers['content-length'] ?? 0) > 16384) {
          send(413, { code: 'INVALID_REQUEST' });
          req.resume();
          return;
        }
        let size = 0;
        const chunks = [];
        try {
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 16384) {
              send(413, { code: 'INVALID_REQUEST' });
              return;
            }
            chunks.push(chunk);
          }
          body = Buffer.concat(chunks).toString('utf8');
          JSON.parse(body);
        } catch {
          send(400, { code: 'INVALID_REQUEST' });
          return;
        }
        headers['Content-Type'] = 'application/json';
      } else if (
        req.headers['transfer-encoding'] ||
        Number(req.headers['content-length'] ?? 0) > 0
      ) {
        send(400, { code: 'INVALID_REQUEST' });
        req.resume();
        return;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${edgePort}${path}`, {
          method: req.method,
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          ...(body === undefined ? {} : { body }),
        });
        if (!response.headers.get('content-type')?.startsWith('application/json')) {
          await response.body?.cancel();
          send(502, { code: 'INVALID_RESPONSE' });
          return;
        }
        if (Number(response.headers.get('content-length') ?? 0) > 3 * 1024 * 1024) {
          await response.body?.cancel();
          send(502, { code: 'INVALID_RESPONSE' });
          return;
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error();
        let size = 0;
        const parts = [];
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          size += r.value.length;
          if (size > 3 * 1024 * 1024) {
            await reader.cancel();
            send(502, { code: 'INVALID_RESPONSE' });
            return;
          }
          parts.push(r.value);
        }
        const payload = Buffer.concat(parts);
        try {
          JSON.parse(payload.toString('utf8'));
        } catch {
          send(502, { code: 'INVALID_RESPONSE' });
          return;
        }
        res.writeHead(response.status, {
          ...security,
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
      send(200, { branchLabel: String(branchLabel).slice(0, 120) });
      return;
    }
    const asset = assets.get(path);
    if (!asset) {
      send(404, { code: 'NOT_FOUND' });
      return;
    }
    try {
      const bytes = await readFile(new URL(asset[0], assetDir));
      res.writeHead(200, { ...security, 'Content-Type': asset[1] });
      res.end(bytes);
    } catch {
      send(503, { code: 'ASSETS_NOT_BUILT' });
    }
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.KITCHEN_PORT ?? 4178),
    edgePort = Number(process.env.KITCHEN_EDGE_PORT ?? 3101);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid kitchen port');
  createKitchenServer({
    edgePort,
    branchLabel: process.env.KITCHEN_BRANCH_LABEL ?? 'Локальная точка',
  }).listen(port, '127.0.0.1', () => console.log(`PickChick kitchen: http://127.0.0.1:${port}`));
}
