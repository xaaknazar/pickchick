import { createServer } from 'node:https';
import { isIP } from 'node:net';
import { TextDecoder } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  PROFILES,
  PROFILE_NAMES,
  POS_MEDIA_PATH,
  allowedKitchenRoute,
} from './lan-route-profiles.mjs';

export { allowedKitchenRoute };
export function privateIPv4(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** New format (cutover CL-4): up to 32 clients, each with one profile. */
export const MAX_CLIENTS = 32;
/** Old format `clientAddresses`: every address is a kitchen client, limits as before. */
export const MAX_LEGACY_CLIENTS = 20;
const LEGACY_MAX_CONNECTIONS = 40;
const DEFAULT_MAX_CONNECTIONS = 64;
const label = (value) =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= 60 &&
  [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);

/**
 * Client address -> profile name. `clientAddresses` (the format installed before the cutover)
 * makes every address a `kitchen` client and keeps 40 connections; `clients[]` names a profile
 * per address. The server's own address is always a kitchen client, as before, so the
 * installer's check keeps working from the server.
 */
export function clientProfiles({ bindAddress, clientAddresses, clients, maxConnections }) {
  if (!privateIPv4(bindAddress)) throw new Error('INVALID_LAN_GATEWAY_CONFIG');
  if (clientAddresses !== undefined) {
    if (
      clients !== undefined ||
      maxConnections !== undefined ||
      !Array.isArray(clientAddresses) ||
      !clientAddresses.length ||
      clientAddresses.length > MAX_LEGACY_CLIENTS ||
      clientAddresses.some((address) => !privateIPv4(address)) ||
      new Set(clientAddresses).size !== clientAddresses.length
    )
      throw new Error('INVALID_LAN_GATEWAY_CONFIG');
    return {
      format: 'clientAddresses',
      profiles: new Map([bindAddress, ...clientAddresses].map((address) => [address, 'kitchen'])),
      maxConnections: LEGACY_MAX_CONNECTIONS,
    };
  }
  if (
    !Array.isArray(clients) ||
    !clients.length ||
    clients.length > MAX_CLIENTS ||
    (maxConnections !== undefined &&
      (!Number.isInteger(maxConnections) || maxConnections < 16 || maxConnections > 256))
  )
    throw new Error('INVALID_LAN_GATEWAY_CONFIG');
  const profiles = new Map([[bindAddress, 'kitchen']]);
  for (const client of clients) {
    if (
      !client ||
      typeof client !== 'object' ||
      Array.isArray(client) ||
      Object.keys(client).some((key) => !['address', 'profile', 'label'].includes(key)) ||
      !privateIPv4(client.address) ||
      !PROFILE_NAMES.includes(client.profile) ||
      (client.label !== undefined && !label(client.label)) ||
      profiles.has(client.address)
    )
      throw new Error('INVALID_LAN_GATEWAY_CONFIG');
    profiles.set(client.address, client.profile);
  }
  return {
    format: 'clients',
    profiles,
    maxConnections: maxConnections ?? DEFAULT_MAX_CONNECTIONS,
  };
}

async function readLimited(reader, limit) {
  const parts = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return Buffer.concat(parts);
    size += chunk.value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    parts.push(chunk.value);
  }
}

/** Dedicated LAN boundary. PostgreSQL, owner commands and cloud transport remain loopback-only.
 *  The profile of each request comes from the client IPv4 only (lan-route-profiles.mjs). */
export function createKitchenLanGateway({
  bindAddress,
  port = 3443,
  clientAddresses,
  clients,
  maxConnections,
  edgePort = 3101,
  pfx,
  passphrase,
  timeoutMs = 10000,
}) {
  const access = clientProfiles({ bindAddress, clientAddresses, clients, maxConnections });
  if (
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
      const respondBytes = (status, type, bytes, retry) => {
        if (res.destroyed) return;
        res.writeHead(status, {
          'Content-Type': type,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Length': String(bytes.length),
          ...(retry ? { 'Retry-After': retry } : {}),
        });
        res.end(bytes);
      };
      const profile = PROFILES[access.profiles.get(req.socket.remoteAddress)];
      if (
        !profile ||
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
      if (!profile.allows(req.method, path)) {
        req.resume();
        respond(404, { code: 'NOT_FOUND' });
        return;
      }
      const headers = { Accept: 'application/json' };
      for (const name of profile.headers) {
        const value = req.headers[name];
        if (value !== undefined && (typeof value !== 'string' || value.length > 200)) {
          req.resume();
          respond(400, { code: 'INVALID_REQUEST' });
          return;
        }
        if (value) headers[name] = value;
      }
      let body;
      const limit = profile.bodyLimit(path);
      if (req.method === 'POST' && !profile.bodyless.includes(path)) {
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
        const type = upstream.headers.get('content-type') ?? '';
        // A menu photo of a cash desk: WebP bytes only; the desk checks their SHA-256 itself.
        if (profile.mediaLimit && upstream.status === 200 && POS_MEDIA_PATH.test(path)) {
          const reader = upstream.body?.getReader();
          const bytes =
            reader &&
            /^image\/webp$/i.test(type) &&
            Number(upstream.headers.get('content-length') ?? 0) <= profile.mediaLimit
              ? await readLimited(reader, profile.mediaLimit)
              : null;
          if (!bytes) {
            await reader?.cancel().catch(() => {});
            respond(502, { code: 'INVALID_RESPONSE' });
            return;
          }
          respondBytes(200, 'image/webp', bytes);
          return;
        }
        if (
          !/^application\/json(?:;|$)/i.test(type) ||
          Number(upstream.headers.get('content-length') ?? 0) > profile.responseLimit
        ) {
          await upstream.body?.cancel();
          respond(502, { code: 'INVALID_RESPONSE' });
          return;
        }
        const reader = upstream.body?.getReader();
        if (!reader) throw new Error();
        const bytes = await readLimited(reader, profile.responseLimit);
        if (!bytes) {
          respond(502, { code: 'INVALID_RESPONSE' });
          return;
        }
        let value;
        try {
          value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch {
          respond(502, { code: 'INVALID_RESPONSE' });
          return;
        }
        const retry =
          upstream.status === 429 &&
          /^[1-9][0-9]{0,3}$/.test(upstream.headers.get('retry-after') ?? '')
            ? upstream.headers.get('retry-after')
            : undefined;
        // A cash desk gets the edge's bytes as they are (validated JSON), like over loopback.
        if (profile.rawJson)
          respondBytes(upstream.status, 'application/json; charset=utf-8', bytes, retry);
        else respond(upstream.status, value, retry);
      } catch {
        respond(504, { code: 'EDGE_TIMEOUT' });
      }
    },
  );
  server.maxConnections = access.maxConnections;
  server.on('tlsClientError', () => {});
  return server;
}

const CONFIG_KEYS = [
  'bindAddress',
  'port',
  'clientAddresses',
  'clients',
  'maxConnections',
  'edgePort',
  'pfxPath',
  'passphrase',
];
/**
 * Reads the private service config (written by install-kitchen-lan.ps1 in the old format or by
 * update-kitchen-lan-clients.ps1) and builds the gateway without listening. The summary holds
 * no address or secret: format, client count per profile and the connection limit.
 */
export async function loadKitchenLanGateway(configPath) {
  const raw = await readFile(configPath);
  if (raw.length > 16384) throw new Error('INVALID_LAN_GATEWAY_CONFIG');
  const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).some((key) => !CONFIG_KEYS.includes(key)) ||
    typeof config.pfxPath !== 'string'
  )
    throw new Error('INVALID_LAN_GATEWAY_CONFIG');
  const { pfxPath, ...settings } = config;
  const server = createKitchenLanGateway({ ...settings, pfx: await readFile(pfxPath) });
  const { format, profiles, maxConnections } = clientProfiles(settings);
  const clients = Object.fromEntries(PROFILE_NAMES.map((name) => [name, 0]));
  for (const [address, name] of profiles) if (address !== settings.bindAddress) clients[name]++;
  return { server, settings, summary: { format, clients, maxConnections } };
}

async function main() {
  // `--check <config>`: the config and the PFX passphrase are valid; nothing listens. Used by
  // update-kitchen-lan-clients.ps1 before it stops the running service.
  const check = process.argv.length === 4 && process.argv[2] === '--check';
  if (process.argv.length !== 3 && !check) throw new Error('INVALID_LAN_GATEWAY_CONFIG');
  const { server, settings, summary } = await loadKitchenLanGateway(process.argv.at(-1));
  if (check) {
    console.log(JSON.stringify({ check: 'LAN_GATEWAY_CONFIG_OK', ...summary }));
    return;
  }
  server.on('error', () => {
    console.error('LAN_GATEWAY_UNAVAILABLE');
    process.exitCode = 1;
    server.close();
  });
  server.listen(settings.port ?? 3443, settings.bindAddress, () =>
    console.log('KITCHEN_LAN_READY'),
  );
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
