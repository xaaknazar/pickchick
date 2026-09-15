import { createServer } from 'node:https';
import { isIP } from 'node:net';
import { TextDecoder } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const base = '/edge/v1/fulfillment';
export function privateIPv4(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export function allowedKitchenRoute(method, raw) {
  if (typeof raw !== 'string' || /[%#\\]/.test(raw)) return false;
  if (method === 'POST' && ['/edge/v1/staff/login', '/edge/v1/staff/logout'].includes(raw))
    return true;
  if (method === 'GET' && raw === '/edge/v1/session') return true;
  if (!raw.startsWith(base)) return false;
  const url = new URL(raw, 'https://127.0.0.1');
  if (raw !== url.pathname + url.search) return false;
  if (method === 'POST')
    return !url.search && new RegExp(`^${base}/orders/${UUID}/actions$`, 'i').test(url.pathname);
  if (method !== 'GET') return false;
  let keys;
  if ([base + '/config', base + '/stations'].includes(url.pathname)) keys = [];
  else if (url.pathname === base + '/kitchen') keys = ['stationId', 'afterOrderId', 'limit'];
  else if (url.pathname === base + '/display') keys = ['afterNumber', 'limit'];
  else if (new RegExp(`^${base}/orders/${UUID}$`, 'i').test(url.pathname)) keys = ['stationId'];
  else return false;
  for (const [key, value] of url.searchParams) {
    if (!keys.includes(key) || url.searchParams.getAll(key).length !== 1) return false;
    if (['stationId', 'afterOrderId'].includes(key) && !new RegExp(`^${UUID}$`, 'i').test(value))
      return false;
    if (key === 'limit' && (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > 100)) return false;
    if (
      key === 'afterNumber' &&
      (!/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n)
    )
      return false;
  }
  return true;
}

/** Dedicated LAN boundary. PostgreSQL, owner commands and cloud transport remain loopback-only. */
export function createKitchenLanGateway({
  bindAddress,
  port = 3443,
  clientAddresses,
  edgePort = 3101,
  pfx,
  passphrase,
  timeoutMs = 10000,
}) {
  if (
    !privateIPv4(bindAddress) ||
    !Array.isArray(clientAddresses) ||
    !clientAddresses.length ||
    clientAddresses.length > 20 ||
    clientAddresses.some((address) => !privateIPv4(address)) ||
    new Set(clientAddresses).size !== clientAddresses.length ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    port === edgePort ||
    !Number.isInteger(edgePort) ||
    edgePort < 1 ||
    edgePort > 65535 ||
    !Buffer.isBuffer(pfx) ||
    !pfx.length ||
    pfx.length > 65536 ||
    typeof passphrase !== 'string' ||
    passphrase.length < 32 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 15000
  )
    throw new Error('INVALID_LAN_GATEWAY_CONFIG');
  const clients = new Set([bindAddress, ...clientAddresses]);
  const server = createServer(
    {
      pfx,
      passphrase,
      minVersion: 'TLSv1.2',
      maxHeaderSize: 8192,
      requestTimeout: 20000,
      headersTimeout: 10000,
      keepAliveTimeout: 5000,
    },
    async (req, res) => {
      const respond = (status, body, retry) => {
        if (res.destroyed) return;
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ...(retry ? { 'Retry-After': retry } : {}),
        });
        res.end(status === 204 ? undefined : JSON.stringify(body));
      };
      if (
        !clients.has(req.socket.remoteAddress) ||
        req.headers.host !== `${bindAddress}:${port}` ||
        req.headers.origin ||
        req.headers['sec-fetch-site']
      ) {
        req.resume();
        respond(403, { code: 'FORBIDDEN' });
        return;
      }
      const path = req.url ?? '';
      if (req.method === 'GET' && path === '/healthz') {
        respond(200, { status: 'ok', service: 'pickchick-kitchen-lan' });
        return;
      }
      if (!allowedKitchenRoute(req.method, path)) {
        req.resume();
        respond(404, { code: 'NOT_FOUND' });
        return;
      }
      const headers = { Accept: 'application/json' };
      for (const name of [
        'authorization',
        'x-staff-session-id',
        'x-terminal-id',
        'idempotency-key',
      ]) {
        const value = req.headers[name];
        if (value !== undefined && (typeof value !== 'string' || value.length > 200)) {
          req.resume();
          respond(400, { code: 'INVALID_REQUEST' });
          return;
        }
        if (value) headers[name] = value;
      }
      let body;
      const limit = path === '/edge/v1/staff/login' ? 2048 : 16384;
      if (req.method === 'POST' && path !== '/edge/v1/staff/logout') {
        if (req.headers['content-type'] !== 'application/json') {
          req.resume();
          respond(415, { code: 'INVALID_REQUEST' });
          return;
        }
        if (Number(req.headers['content-length'] ?? 0) > limit) {
          req.resume();
          respond(413, { code: 'INVALID_REQUEST' });
          return;
        }
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > limit) {
              respond(413, { code: 'INVALID_REQUEST' });
              return;
            }
            chunks.push(chunk);
          }
          body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          JSON.parse(body);
        } catch {
          respond(400, { code: 'INVALID_REQUEST' });
          return;
        }
        headers['Content-Type'] = 'application/json';
      } else if (
        req.headers['transfer-encoding'] ||
        Number(req.headers['content-length'] ?? 0) > 0
      ) {
        req.resume();
        respond(400, { code: 'INVALID_REQUEST' });
        return;
      }
      try {
        const upstream = await fetch(`http://127.0.0.1:${edgePort}${path}`, {
          method: req.method,
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          ...(body === undefined ? {} : { body }),
        });
        if (upstream.status === 204) {
          await upstream.body?.cancel();
          respond(204);
          return;
        }
        if (
          !/^application\/json(?:;|$)/i.test(upstream.headers.get('content-type') ?? '') ||
          Number(upstream.headers.get('content-length') ?? 0) > 3 * 1024 * 1024
        ) {
          await upstream.body?.cancel();
          respond(502, { code: 'INVALID_RESPONSE' });
          return;
        }
        const reader = upstream.body?.getReader();
        if (!reader) throw new Error();
        const parts = [];
        let size = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 3 * 1024 * 1024) {
            await reader.cancel();
            respond(502, { code: 'INVALID_RESPONSE' });
            return;
          }
          parts.push(chunk.value);
        }
        let value;
        try {
          value = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)),
          );
        } catch {
          respond(502, { code: 'INVALID_RESPONSE' });
          return;
        }
        const retry =
          upstream.status === 429 &&
          /^[1-9][0-9]{0,3}$/.test(upstream.headers.get('retry-after') ?? '')
            ? upstream.headers.get('retry-after')
            : undefined;
        respond(upstream.status, value, retry);
      } catch {
        respond(504, { code: 'EDGE_TIMEOUT' });
      }
    },
  );
  server.maxConnections = 40;
  server.on('tlsClientError', () => {});
  return server;
}

async function main() {
  if (process.argv.length !== 3) throw new Error('INVALID_LAN_GATEWAY_CONFIG');
  const raw = await readFile(process.argv[2]);
  if (raw.length > 4096) throw new Error('INVALID_LAN_GATEWAY_CONFIG');
  const config = JSON.parse(raw.toString('utf8'));
  if (
    Object.keys(config).some(
      (key) =>
        !['bindAddress', 'port', 'clientAddresses', 'edgePort', 'pfxPath', 'passphrase'].includes(
          key,
        ),
    )
  )
    throw new Error('INVALID_LAN_GATEWAY_CONFIG');
  const { pfxPath, ...settings } = config;
  const server = createKitchenLanGateway({ ...settings, pfx: await readFile(pfxPath) });
  server.on('error', () => {
    console.error('LAN_GATEWAY_UNAVAILABLE');
    process.exitCode = 1;
    server.close();
  });
  server.listen(config.port, config.bindAddress, () => console.log('KITCHEN_LAN_READY'));
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => {
      server.close();
      server.closeAllConnections();
    });
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('LAN_GATEWAY_START_FAILED');
    process.exitCode = 1;
  });
