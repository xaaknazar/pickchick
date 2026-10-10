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
import {
  CloudFailure,
  CloudUpstream,
  allowedCloud,
  errorBody,
  pairingCode,
  screenCookies,
  validateCloudConfig,
} from './cloud.mjs';
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
  terminalAccess = false,
  cloudKitchen,
  cloudFetch,
}) {
  const url = new URL(origin);
  // Default off: without `cloudKitchen.enabled` the portal is byte-for-byte the edge-only portal.
  const cloudConfig = validateCloudConfig(cloudKitchen);
  const cloud = cloudConfig
    ? new CloudUpstream(cloudConfig, cloudFetch ? { fetchImpl: cloudFetch } : {})
    : null;
  if (
    url.protocol !== 'https:' ||
    url.origin !== origin ||
    !/^[a-f0-9]{64}$/.test(key) ||
    (!terminalAccess &&
      (!['prep', 'assembly', 'display'].every((mode) => UUID.test(terminals?.[mode] ?? '')) ||
        new Set(Object.values(terminals)).size !== 3))
  )
    throw new Error('INVALID_PORTAL_CONFIG');
  // One encrypted cloud screen cookie per page role (owner decision 5: screen, not cook).
  const screens = cloud
    ? Object.fromEntries(
        ['prep', 'assembly', 'display'].map((mode) => [mode, screenCookies({ key, mode })]),
      )
    : null;
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
      terminalId: terminalAccess ? undefined : terminals[mode],
      ...(terminalAccess
        ? { terminalAccess: { key, mode, path: `/kitchen-live/${mode}/`, secure: true } }
        : {}),
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
  /**
   * Cloud screen routes of one page role. No cook session and no cashier are involved: the
   * cookie carries the (encrypted) screen key and the cloud authenticates it on every call, so
   * a revoked or rotated screen gets 401 and its cookie is cleared at once.
   */
  async function serveCloud(req, res, mode, rest) {
    const cookies = screens[mode];
    const reply = (status, body, clear = false) => {
      if (clear) res.setHeader('Set-Cookie', cookies.clear());
      send(res, status, body);
    };
    const pair = rest === '/pair';
    if (!rate(req, pair)) {
      res.setHeader('Retry-After', '60');
      reply(429, errorBody('RATE_LIMITED'));
      return;
    }
    const fulfillment = rest.startsWith('/v1/fulfillment/')
      ? rest.slice('/v1/fulfillment'.length)
      : null;
    if (
      !(pair && req.method === 'POST') &&
      !(rest === '/session' && req.method === 'GET') &&
      !(fulfillment && allowedCloud(req.method, fulfillment))
    ) {
      reply(404, errorBody('NOT_FOUND'));
      return;
    }
    try {
      let body;
      if (req.method === 'POST') {
        if (req.headers['content-type'] !== 'application/json')
          throw new CloudFailure('INVALID_REQUEST');
        body = (await boundedBody(req, pair ? 2048 : 16384)).toString('utf8');
      } else if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0))
        throw new CloudFailure('INVALID_REQUEST');
      if (pair) {
        const code = pairingCode(body);
        if (!code) throw new CloudFailure('INVALID_REQUEST');
        const paired = await cloud.pair(mode, code);
        const info = await cloud.me(paired);
        res.setHeader('Set-Cookie', cookies.seal(paired));
        // The key stays in the HttpOnly cookie; the page only learns which screen it is.
        reply(200, info);
        return;
      }
      const screen = cookies.read(req.headers.cookie);
      if (!screen || screen.branchId !== cloudConfig.branchId)
        throw new CloudFailure('UNAUTHORIZED');
      if (rest === '/session') {
        reply(200, await cloud.me(screen));
        return;
      }
      const idempotencyKey = req.headers['idempotency-key'];
      reply(
        200,
        await cloud.handle(screen, req.method, fulfillment, {
          body,
          idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
        }),
      );
    } catch (error) {
      const failure =
        error instanceof CloudFailure
          ? error
          : new CloudFailure(
              error?.message === 'BODY_LIMIT' ? 'INVALID_REQUEST' : 'SERVICE_UNAVAILABLE',
            );
      // A pairing that failed never touches an existing binding; a rejected key clears it.
      const clear = !pair && failure.code === 'UNAUTHORIZED' && req.headers.cookie !== undefined;
      reply(failure.status, errorBody(failure.code), clear);
    }
  }
  const server = createServer(async (req, res) => {
    try {
      const path = req.url ?? '';
      if (req.headers.host !== url.host) {
        send(res, 403, { code: 'FORBIDDEN' });
        return;
      }
      if (path === '/kitchen-live/health' && req.method === 'GET') {
        send(res, 200, {
          sourceSha,
          edgeConnected: link.online,
          ...(cloud ? { cloudConnected: cloud.online } : {}),
        });
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
      const cloudMatch = cloud
        ? /^\/kitchen-live\/(prep|assembly|display)\/cloud(\/[^#]*)$/.exec(path)
        : null;
      if (cloudMatch) {
        await serveCloud(req, res, cloudMatch[1], cloudMatch[2]);
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
        if (
          !/^\/(?:[a-z0-9-]+\.(?:js|css|png)|components\/(?:(?:TerminalPairing|DisplayAccess|PasswordReset|StreamStatus|CloudPairing)\.js|PasswordReset\.css)|fonts\/[a-z0-9-]+\.woff2)$/.test(
            pathOnGateway,
          )
        ) {
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
      const pairing = pathOnGateway === '/edge/v1/terminals/pair';
      const reset = pathOnGateway === '/edge/v1/staff/password-reset';
      if (!rate(req, login || pairing || reset)) {
        res.setHeader('Retry-After', '60');
        send(res, 429, { code: 'RATE_LIMITED' });
        return;
      }
      if (
        mode === 'display' &&
        req.method === 'POST' &&
        ![
          '/edge/v1/staff/login',
          '/edge/v1/staff/logout',
          ...(terminalAccess ? ['/edge/v1/terminals/pair'] : []),
        ].includes(pathOnGateway)
      ) {
        send(res, 403, { code: 'FORBIDDEN' });
        return;
      }
      if (
        !terminalAccess &&
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
      const edgeAction = /^\/edge\/v1\/fulfillment\/orders\/([0-9a-f-]{36})\/actions$/i.exec(
        pathOnGateway,
      );
      // A cloud-owned order is acted on only through the cloud; never also by the cashier.
      if (cloud && edgeAction && cloud.owners.has(edgeAction[1].toLowerCase())) {
        send(res, 400, errorBody('INVALID_REQUEST'));
        return;
      }
      const body = await boundedBody(req, login || pairing || reset ? 2048 : 16384);
      const headers = Object.fromEntries(
        HEADER_NAMES.filter((k) => typeof req.headers[k] === 'string').map((k) => [
          k,
          req.headers[k],
        ]),
      );
      if (
        terminalAccess &&
        typeof req.headers.cookie === 'string' &&
        req.headers.cookie.length <= 4096
      )
        headers.Cookie = req.headers.cookie;
      // A browser cannot inject a terminal key; only the local cookie gateway may add it.
      delete headers['x-terminal-key'];
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
      if (cloud && pathOnGateway === '/config.json' && response.ok) {
        // Only a flag: keys, API address and branch stay on the server.
        payload = Buffer.from(
          JSON.stringify({
            ...JSON.parse(payload.toString('utf8')),
            cloudKitchen: true,
            // Decryptable cookie only; the page then asks /cloud/session, which the cloud checks.
            cloudPaired: Boolean(screens[mode].read(req.headers.cookie)),
          }),
        );
      }
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
        ...(terminalAccess && response.headers.get('set-cookie')
          ? { 'Set-Cookie': response.headers.get('set-cookie') }
          : {}),
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
    cloud,
    async close() {
      link.close();
      await Promise.all([server, ...servers].map(stop));
    },
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const portal = await createPortal({
    ...config,
    sourceSha: process.env.PICKCHICK_KITCHEN_SOURCE_SHA || config.sourceSha,
  });
  portal.server.listen(4193, '0.0.0.0');
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => void portal.close());
}
