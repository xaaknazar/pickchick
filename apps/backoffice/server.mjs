import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URLSearchParams } from 'node:url';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
function reportQuery(search) {
  if (search.length > 400) return false;
  const query = new URLSearchParams(search);
  const seen = new Set();
  for (const [key] of query) {
    if (!['period', 'start_date', 'end_date', 'shift_id'].includes(key) || seen.has(key))
      return false;
    seen.add(key);
  }
  const period = query.get('period') ?? 'day';
  if (!['day', 'today', 'yesterday', 'week', 'month', 'quarter', 'year', 'custom'].includes(period))
    return false;
  const shift = query.get('shift_id');
  if (shift !== null && !new RegExp(`^${UUID}$`, 'i').test(shift)) return false;
  const start = query.get('start_date'),
    end = query.get('end_date');
  if (period !== 'custom') return start === null && end === null;
  const validDate = (value) => {
    if (
      value === null ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      value < '2000-01-01' ||
      value > '2099-12-31'
    )
      return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  return (
    validDate(start) &&
    validDate(end) &&
    start <= end &&
    Date.parse(end) - Date.parse(start) <= 365 * 86400000
  );
}
const allowed = (method, path) => {
  const [pathname, search, extra] = path.split('?');
  if (extra !== undefined || path.includes('#')) return false;
  if (
    method === 'GET' &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/finance$`, 'i').test(pathname)
  ) {
    const q = new URLSearchParams(search ?? '');
    return (
      (search?.length ?? 0) <= 1600 &&
      [...q.keys()].every(
        (k) =>
          ['start_date', 'end_date', 'center', 'page', 'category', 'basis', 'search'].includes(k) &&
          q.getAll(k).length === 1,
      ) &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('start_date') ?? '') &&
      /^\d{4}-\d{2}-\d{2}$/.test(q.get('end_date') ?? '') &&
      /^(all|restaurant|workshop|office|shared)$/.test(q.get('center') ?? 'all') &&
      /^\d{1,6}$/.test(q.get('page') ?? '0') &&
      /^(both|cash|pnl)$/.test(q.get('basis') ?? 'both') &&
      /^[a-z-]{0,60}$/.test(q.get('category') ?? '') &&
      (q.get('search')?.length ?? 0) <= 80
    );
  }
  if (
    method === 'POST' &&
    search === undefined &&
    new RegExp(`^/v1/admin/backoffice/branches/${UUID}/finance/commands$`, 'i').test(pathname)
  )
    return true;
  if (method === 'GET' && new RegExp(`^/v1/admin/backoffice/branches/${UUID}$`, 'i').test(pathname))
    return reportQuery(search ?? '');
  if (search !== undefined) return false;
  return (
    (method === 'GET' &&
      new RegExp(`^/v1/admin/backoffice/branches/${UUID}/orders/${UUID}$`, 'i').test(pathname)) ||
    (method === 'POST' &&
      new RegExp(`^/v1/admin/backoffice/branches/${UUID}/commands$`, 'i').test(pathname)) ||
    (method === 'GET'
      ? new RegExp(`^/v1/admin/catalog/branches(?:/${UUID})?$`, 'i').test(pathname)
      : method === 'PUT'
        ? new RegExp(`^/v1/admin/catalog/branches/${UUID}/draft$`, 'i').test(pathname)
        : method === 'POST' &&
          new RegExp(`^/v1/admin/catalog/branches/${UUID}/(?:draft/seed|publish)$`, 'i').test(
            pathname,
          ))
  );
};
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ...['styles', 'fonts'].map((n) => [`/${n}.css`, [`${n}.css`, 'text/css; charset=utf-8']]),
  ...[
    'app',
    'api',
    'model',
    'domain',
    'dom',
    'editor',
    'operations',
    'operations-model',
    'finance',
    'finance-model',
    'finance-report',
    'finance-charts',
  ].map((n) => [`/${n}.js`, [`${n}.js`, 'text/javascript; charset=utf-8']]),
  ...['logo.png', 'shot.jpg', ...Array.from({ length: 24 }, (_, i) => `i${i}.jpg`)].map((n) => [
    `/assets/${n}`,
    [`assets/${n}`, n.endsWith('.png') ? 'image/png' : 'image/jpeg'],
  ]),
  ...[
    'fccca918fea4',
    'aebf2ab4a4ce',
    'a2e2c783ca6f',
    '46dd4cdca58c',
    '8db00ff46c67',
    'a28eb6d3ccb5',
    'c940764593d0',
  ].map((n) => [`/assets/fonts/inter-${n}.woff2`, [`assets/fonts/inter-${n}.woff2`, 'font/woff2']]),
]);
const security = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
/** Local operator UI. Only the configured loopback API and catalog routes are reachable. */
export function createBackofficeServer({
  apiPort = 3100,
  assetDir = new URL('dist/', import.meta.url),
  timeoutMs = 12000,
  staticPrefix = '',
} = {}) {
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535)
    throw new Error('Invalid API port');
  if (!['', '/backoffice'].includes(staticPrefix)) throw new Error('Invalid static prefix');
  return createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { ...security, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };
    const expected = `127.0.0.1:${req.socket.localPort}`;
    if (
      req.headers.host !== expected ||
      (req.headers.origin && req.headers.origin !== `http://${expected}`) ||
      req.headers['sec-fetch-site'] === 'cross-site'
    ) {
      send(403, { code: 'FORBIDDEN' });
      return;
    }
    const path = req.url ?? '';
    if (path.startsWith('/v1/')) {
      if (!allowed(req.method, path)) {
        send(404, { code: 'NOT_FOUND' });
        return;
      }
      const auth = req.headers.authorization;
      if (typeof auth !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(auth)) {
        send(401, { code: 'UNAUTHORIZED' });
        return;
      }
      let body;
      const headers = { Authorization: auth };
      if (req.method !== 'GET') {
        if (req.headers['content-type'] !== 'application/json') {
          send(415, { code: 'INVALID_REQUEST' });
          return;
        }
        const chunks = [];
        let size = 0;
        try {
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 300 * 1024) {
              send(413, { code: 'INVALID_REQUEST' });
              return;
            }
            chunks.push(chunk);
          }
          body = Buffer.concat(chunks).toString('utf8');
          JSON.parse(body);
        } catch {
          if (!res.destroyed) send(400, { code: 'INVALID_REQUEST' });
          return;
        }
        headers['Content-Type'] = 'application/json';
      }
      try {
        const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
          method: req.method,
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          ...(body === undefined ? {} : { body }),
        });
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body ?? []) {
          size += chunk.length;
          if (size > 1024 * 1024) {
            send(502, { code: 'INVALID_RESPONSE' });
            return;
          }
          chunks.push(chunk);
        }
        res.writeHead(response.status, {
          ...security,
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(Buffer.concat(chunks));
      } catch {
        send(504, { code: 'NETWORK' });
      }
      return;
    }
    if (req.method !== 'GET') {
      send(405, { code: 'INVALID_REQUEST' });
      return;
    }
    if (staticPrefix && path === staticPrefix) {
      res.writeHead(308, { ...security, Location: staticPrefix + '/' });
      res.end();
      return;
    }
    const assetPath = staticPrefix
      ? path.startsWith(staticPrefix + '/')
        ? path.slice(staticPrefix.length)
        : ''
      : path;
    const asset = assets.get(assetPath);
    if (!asset) {
      send(404, { code: 'NOT_FOUND' });
      return;
    }
    try {
      const data = await readFile(new URL(asset[0], assetDir));
      res.writeHead(200, { ...security, 'Content-Type': asset[1] });
      res.end(data);
    } catch {
      if (!res.headersSent) send(503, { code: 'ASSETS_NOT_BUILT' });
      else res.destroy();
    }
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.BACKOFFICE_PORT ?? 4177),
    apiPort = Number(process.env.BACKOFFICE_API_PORT ?? process.env.API_PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid backoffice port');
  createBackofficeServer({ apiPort }).listen(port, '127.0.0.1', () =>
    console.log(`PickChick Backoffice: http://127.0.0.1:${port}`),
  );
}
