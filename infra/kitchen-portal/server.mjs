import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createKitchenServer } from '../../apps/kitchen/server.mjs';
import {
  EdgeLink,
  HEADER_NAMES,
  authenticated,
  boundedBody,
  validReply,
  MAX_REPLY,
} from './link.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const security = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
function send(res, status, body) {
  res.writeHead(status, { ...security, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}
async function stop(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
export async function createPortal({
  origin,
  key,
  terminals,
  branchLabel,
  assetDir,
  sourceSha = 'development',
  link = new EdgeLink(),
}) {
  const url = new URL(origin);
  if (
    url.protocol !== 'https:' ||
    url.origin !== origin ||
    !/^[a-f0-9]{64}$/.test(key) ||
    !['prep', 'assembly', 'display'].every((mode) => UUID.test(terminals?.[mode] ?? '')) ||
    new Set(Object.values(terminals)).size !== 3
  )
    throw new Error('INVALID_PORTAL_CONFIG');
  const upstream = createServer(async (req, res) => {
    try {
      const body = await boundedBody(req, 16384);
      const headers = Object.fromEntries(
        HEADER_NAMES.filter((k) => typeof req.headers[k] === 'string').map((k) => [
          k,
          req.headers[k],
        ]),
      );
      const reply = await link.forward({
        method: req.method,
        path: req.url,
        headers,
        ...(body.length ? { body: body.toString('utf8') } : {}),
      });
      res.writeHead(reply.status, {
        'Content-Type': 'application/json',
        ...(reply.retryAfter ? { 'Retry-After': reply.retryAfter } : {}),
      });
      res.end(Buffer.from(reply.body, 'base64'));
    } catch {
      send(res, 504, { code: 'EDGE_TIMEOUT' });
    }
  });
  const edgePort = await listen(upstream),
    gateways = {},
    servers = [upstream];
  for (const mode of ['prep', 'assembly', 'display']) {
    const gateway = createKitchenServer({
      edgePort,
      assetDir,
      branchLabel,
      terminalId: terminals[mode],
      timeoutMs: 11000,
    });
    servers.push(gateway);
    gateways[mode] = await listen(gateway);
  }
  // Limit unauthenticated traffic before it consumes the branch's relay capacity.
  const buckets = new Map();
  function rate(req, login) {
    const ip = req.headers['x-pickchick-client-ip'] ?? req.socket.remoteAddress;
    const now = Date.now(),
      id = String(ip) + (login ? ':login' : ':read');
    for (const [k, v] of buckets) if (v.until <= now) buckets.delete(k);
    if (!buckets.has(id)) {
      if (buckets.size >= 2048) return false;
      buckets.set(id, { until: now + 60000, count: 0 });
    }
    return ++buckets.get(id).count <= (login ? 12 : 360);
  }
  const server = createServer(async (req, res) => {
    try {
      const path = req.url ?? '';
      if (req.headers.host !== url.host) {
        send(res, 403, { code: 'FORBIDDEN' });
        return;
      }
      if (path === '/kitchen-live/health' && req.method === 'GET') {
        send(res, 200, { sourceSha, edgeConnected: link.online });
        return;
      }
      if (path.startsWith('/kitchen-link/')) {
        if (
          req.headers.origin ||
          req.headers['sec-fetch-site'] ||
          !authenticated(req.headers.authorization, key)
        ) {
          send(res, 401, { code: 'UNAUTHORIZED' });
          return;
        }
        if (
          path === '/kitchen-link/poll' &&
          req.method === 'GET' &&
          !req.headers['transfer-encoding'] &&
          !Number(req.headers['content-length'] ?? 0)
        ) {
          const controller = new AbortController();
          res.once('close', () => controller.abort());
          const job = await link.poll(controller.signal);
          if (!res.destroyed) send(res, job ? 200 : 204, job ?? undefined);
          return;
        }
        if (
          path === '/kitchen-link/reply' &&
          req.method === 'POST' &&
          req.headers['content-type'] === 'application/json'
        ) {
          const reply = JSON.parse(
            (await boundedBody(req, Math.ceil(MAX_REPLY / 3) * 4 + 1024)).toString('utf8'),
          );
          if (!validReply(reply)) {
            send(res, 400, { code: 'INVALID_REQUEST' });
            return;
          }
          send(res, link.reply(reply) ? 204 : 410);
          return;
        }
        send(res, 404, { code: 'NOT_FOUND' });
        return;
      }
      if (
        (req.headers.origin && req.headers.origin !== origin) ||
        req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.method === 'POST' && req.headers.origin !== origin)
      ) {
        send(res, 403, { code: 'FORBIDDEN' });
        return;
      }
      let mode, pathOnGateway;
      const pages = {
        '/kitchen/prep': 'prep',
        '/kitchen/assembly': 'assembly',
        '/display': 'display',
      };
      if (pages[path] && req.method === 'GET') {
        mode = pages[path];
        pathOnGateway = '/';
      } else if (path.startsWith('/kitchen-live/assets/') && req.method === 'GET') {
        mode = 'prep';
        pathOnGateway = path.slice('/kitchen-live/assets'.length);
        if (!/^\/(?:[a-z0-9-]+\.(?:js|css|png)|fonts\/[a-z0-9-]+\.woff2)$/.test(pathOnGateway)) {
          send(res, 404, { code: 'NOT_FOUND' });
          return;
        }
      } else {
        const match = /^\/kitchen-live\/(prep|assembly|display)(\/(?:edge\/.*|config\.json))$/.exec(
          path,
        );
        if (!match) {
          send(res, 404, { code: 'NOT_FOUND' });
          return;
        }
        [, mode, pathOnGateway] = match;
      }
      const login = pathOnGateway === '/edge/v1/staff/login';
      if (!rate(req, login)) {
        res.setHeader('Retry-After', '60');
        send(res, 429, { code: 'RATE_LIMITED' });
        return;
      }
      if (
        mode === 'display' &&
        req.method === 'POST' &&
        !['/edge/v1/staff/login', '/edge/v1/staff/logout'].includes(pathOnGateway)
      ) {
        send(res, 403, { code: 'FORBIDDEN' });
        return;
      }
      if (
        pathOnGateway.startsWith('/edge/') &&
        !login &&
        pathOnGateway !== '/edge/v1/fulfillment/config'
      ) {
        if (
          req.headers['x-terminal-id'] !== terminals[mode] ||
          !/^Bearer [^\s]{16,200}$/.test(req.headers.authorization ?? '')
        ) {
          send(res, 401, { code: 'UNAUTHORIZED' });
          return;
        }
      }
      const body = await boundedBody(req, login ? 2048 : 16384);
      const headers = Object.fromEntries(
        HEADER_NAMES.filter((k) => typeof req.headers[k] === 'string').map((k) => [
          k,
          req.headers[k],
        ]),
      );
      const localOrigin = `http://127.0.0.1:${gateways[mode]}`;
      headers.Origin = localOrigin;
      const response = await fetch(localOrigin + pathOnGateway, {
        method: req.method,
        headers,
        body: body.length ? body : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(11500),
      });
      const type = response.headers.get('content-type') ?? 'application/json';
      let payload = Buffer.from(await response.arrayBuffer()); // Gateway has its own bounded JSON/static allowlist.
      if (pathOnGateway === '/' || pathOnGateway === '/styles.css')
        payload = Buffer.from(
          payload
            .toString('utf8')
            .replaceAll('href="/', 'href="/kitchen-live/assets/')
            .replaceAll('src="/', 'src="/kitchen-live/assets/')
            .replaceAll("url('/", "url('/kitchen-live/assets/"),
        );
      res.writeHead(response.status, {
        ...security,
        'Content-Type': type,
        ...(response.headers.get('retry-after')
          ? { 'Retry-After': response.headers.get('retry-after') }
          : {}),
      });
      res.end(payload);
    } catch {
      if (!res.headersSent && !res.destroyed) send(res, 504, { code: 'EDGE_TIMEOUT' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return {
    server,
    link,
    async close() {
      link.close();
      await Promise.all([server, ...servers].map(stop));
    },
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const portal = await createPortal(config);
  portal.server.listen(4193, '0.0.0.0');
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => void portal.close());
}
