import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { connect as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';
import {
  allowedKitchenRoute,
  privateIPv4,
  createKitchenLanGateway,
  clientProfiles,
  MAX_CLIENTS,
} from '../../infra/windows/kitchen-lan-gateway.mjs';
import {
  PROFILES,
  PROFILE_NAMES,
  POS_READ_PATH,
  POS_WRITE_PATH,
  POS_SHIFT_FILTERED,
  allowedDisplayRoute,
  allowedPosRoute,
} from '../../infra/windows/lan-route-profiles.mjs';
import {
  APP_URL,
  EDGE_READ_PATH,
  EDGE_WRITE_PATH,
  SALE_ROUTES,
  SHIFT_FILTERED,
  createProtocolHandler,
} from '../../apps/pos-desktop/protocol.mjs';
import { allowed as kitchenAppAllowed } from '../../apps/kitchen/server.mjs';

const id = '10000000-0000-4000-8000-000000000001';
test('LAN gateway exposes only staff login and kitchen operations, never payment, owner, SQL or arbitrary proxy paths', () => {
  for (const address of ['10.0.1.2', '172.16.0.1', '192.168.2.184'])
    assert.equal(privateIPv4(address), true);
  for (const address of [
    '127.0.0.1',
    '0.0.0.0',
    '8.8.8.8',
    '172.32.0.1',
    '10.01.1.2',
    '::1',
    'localhost',
  ])
    assert.equal(privateIPv4(address), false);
  for (const [method, path] of [
    ['POST', '/edge/v1/staff/login'],
    ['POST', '/edge/v1/staff/logout'],
    ['GET', '/edge/v1/session'],
    ['GET', '/edge/v1/fulfillment/stations'],
    ['GET', `/edge/v1/fulfillment/kitchen?stationId=${id}&limit=50`],
    ['POST', `/edge/v1/fulfillment/orders/${id}/actions`],
  ])
    assert.equal(allowedKitchenRoute(method, path), true);
  for (const [method, path] of [
    ['POST', '/edge/v1/orders'],
    ['POST', '/edge/v1/staff/login?token=fixture'],
    ['GET', '/edge/v1/staff/login'],
    ['POST', '/internal/v1/edge/pos-orders/events'],
    ['GET', '/edge/v1/fulfillment/../session'],
    ['GET', '/edge/v1/fulfillment/kitchen?limit=101'],
    ['GET', '/edge/v1/fulfillment/kitchen?limit=1&limit=2'],
    ['GET', '/edge/v1/fulfillment/kitchen?host=evil.invalid'],
    ['GET', '/edge/v1/fulfillment/%2e%2e/session'],
  ])
    assert.equal(allowedKitchenRoute(method, path), false, `${method} ${path}`);
});

test('real pinned TLS preserves authorized command and enforces origin, response, body and timeout boundaries', async () => {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && !i.internal && privateIPv4(i.address))?.address;
  assert.ok(address, 'A private local interface is required for this integration test');
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-kds-tls-'));
  const passphrase = 'synthetic-fixture-password-only-123456789';
  const received = [];
  let readinessProbe = null;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      path: req.url,
      body: Buffer.concat(chunks).toString('utf8'),
      headers: req.headers,
    });
    if (req.url === '/edge/v1/session' && readinessProbe !== null) {
      readinessProbe++;
      res.writeHead(readinessProbe < 3 ? 503 : 401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ code: readinessProbe < 3 ? 'SERVICE_UNAVAILABLE' : 'UNAUTHORIZED' }),
      );
      return;
    }
    if (req.url === '/edge/v1/staff/logout') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === '/edge/v1/fulfillment/config') return;
    if (req.url === '/edge/v1/fulfillment/stations') {
      res.writeHead(302, { Location: 'https://outside.invalid/' });
      res.end();
      return;
    }
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': '60',
      'Set-Cookie': 'fixture=value',
    });
    res.end(JSON.stringify({ code: 'AUTH_RATE_LIMITED' }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let gateway;
  try {
    await writeFile(
      join(directory, 'openssl.cnf'),
      `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=Kitchen TLS fixture\n[ext]\nsubjectAltName=IP:${address}\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n`,
    );
    await writeFile(join(directory, 'pass.txt'), passphrase, { mode: 0o600 });
    for (const args of [
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-config',
        join(directory, 'openssl.cnf'),
        '-keyout',
        join(directory, 'key.pem'),
        '-out',
        join(directory, 'cert.pem'),
      ],
      [
        'pkcs12',
        '-export',
        '-keypbe',
        'AES-256-CBC',
        '-certpbe',
        'AES-256-CBC',
        '-macalg',
        'sha256',
        '-inkey',
        join(directory, 'key.pem'),
        '-in',
        join(directory, 'cert.pem'),
        '-out',
        join(directory, 'server.pfx'),
        '-passout',
        `file:${join(directory, 'pass.txt')}`,
      ],
    ])
      assert.equal(
        spawnSync('openssl', args, { stdio: 'pipe' }).status,
        0,
        'Synthetic TLS material generation failed',
      );
    const reserve = createServer();
    await new Promise((resolve) => reserve.listen(0, address, resolve));
    const port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    const ca = await readFile(join(directory, 'cert.pem'));
    gateway = createKitchenLanGateway({
      bindAddress: address,
      port,
      clientAddresses: [address],
      edgePort: upstream.address().port,
      pfx: await readFile(join(directory, 'server.pfx')),
      passphrase,
      timeoutMs: 50,
    });
    await new Promise((resolve) => gateway.listen(port, address, resolve));
    const call = (path, { method = 'GET', body, headers = {}, trust = true } = {}) =>
      new Promise((resolve, reject) => {
        const req = request(
          {
            hostname: address,
            port,
            path,
            method,
            ...(trust ? { ca } : {}),
            rejectUnauthorized: true,
            agent: false,
            headers,
          },
          (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () =>
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    assert.equal((await call('/healthz')).status, 200);
    await assert.rejects(call('/healthz', { trust: false }));
    for (const headers of [
      { Origin: `https://${address}:${port}` },
      { 'Sec-Fetch-Site': 'same-origin' },
    ])
      assert.equal((await call('/edge/v1/session', { headers })).status, 403);
    await assert.rejects(call('/edge/v1/session', { headers: { Host: 'outside.invalid' } }));
    assert.equal(received.length, 0);
    const body = JSON.stringify({
      login: 'fixture',
      password: 'synthetic-password-only',
      terminal_id: id,
    });
    const login = await call('/edge/v1/staff/login', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'do-not-forward',
        'X-Forwarded-Host': 'outside.invalid',
      },
    });
    assert.equal(login.status, 429);
    assert.equal(login.headers['retry-after'], '60');
    assert.equal(login.headers['set-cookie'], undefined);
    assert.equal(received.at(-1).body, body);
    assert.equal(received.at(-1).headers.cookie, undefined);
    assert.equal(received.at(-1).headers['x-forwarded-host'], undefined);
    const logout = await call('/edge/v1/staff/logout', {
      method: 'POST',
      headers: { Authorization: 'Bearer synthetic-fixture' },
    });
    assert.equal(logout.status, 204);
    assert.equal(logout.body, '');
    assert.equal(received.at(-1).headers.authorization, 'Bearer synthetic-fixture');
    assert.equal(received.at(-1).body, '');
    assert.equal(received.at(-1).headers['content-type'], undefined);
    const count = received.length;
    assert.equal((await call('/edge/v1/staff/logout', { method: 'POST', body: '{}' })).status, 400);
    assert.equal(received.length, count);
    assert.equal(
      (
        await call('/edge/v1/staff/login', {
          method: 'POST',
          body: JSON.stringify({ password: 'я'.repeat(1024) }),
          headers: { 'Content-Type': 'application/json' },
        })
      ).status,
      413,
    );
    assert.equal(
      (await call('/internal/v1/edge/pos-orders/events', { method: 'POST' })).status,
      404,
    );
    assert.equal(received.length, count);
    assert.equal((await call('/edge/v1/fulfillment/stations')).status, 504);
    assert.equal((await call('/edge/v1/fulfillment/config')).status, 504);
    readinessProbe = 0;
    const publicConfig = join(directory, 'public-config.json');
    await writeFile(
      publicConfig,
      JSON.stringify({
        edgeHost: address,
        edgePort: port,
        edgeCertificatePem: ca.toString('utf8'),
      }),
    );
    const check = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL('../../infra/windows/kitchen-lan-check.mjs', import.meta.url)),
        publicConfig,
      ],
      { timeout: 15000, maxBuffer: 4096 },
    );
    assert.equal(JSON.parse(check.stdout).passwordRequired, true);
    assert.equal(readinessProbe, 3, 'Installer waits through temporary Edge warmup only');
  } finally {
    gateway?.closeAllConnections();
    if (gateway) await new Promise((resolve) => gateway.close(resolve));
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

// ---- Cutover 19.11 (CL-4): route profiles per client IPv4 ----------------------------------

const ID = '10000000-0000-4000-8000-000000000002';
const SHA = 'a'.repeat(64);
const desktopRoutes = () => {
  const read = [
    'session',
    'menu',
    'menu/version',
    'ordering',
    'cloud-link',
    'orders',
    `orders/${ID}`,
    'cash-shifts',
    'cash-shifts/current',
    `cash-shifts/${ID}`,
    'availability/stops',
    `availability/stops/${ID}`,
    'pos/config',
    `pos/sales/${ID}`,
    'pos/fiscal-receipts/pending',
    `cash-shifts/${ID}/x-report`,
    `cash-shifts/${ID}/z-report`,
  ];
  const write = [
    'staff/login',
    'staff/pin',
    'staff/logout',
    'checkout/quotes',
    'orders',
    `orders/${ID}/cancel`,
    'cash-shifts',
    `cash-shifts/${ID}/close`,
    `cash-shifts/${ID}/movements`,
    'ordering/open',
    'ordering/close',
    'availability/stops',
    'staff/approvals',
    'pos/sales',
    `pos/sales/${ID}/void`,
    `pos/sales/${ID}/refunds`,
    `pos/fiscal-receipts/${ID}/record`,
  ];
  const other = [
    'staff/password-reset',
    'terminals/pair',
    'terminals/session',
    'fulfillment/config',
    'fulfillment/stations',
    `fulfillment/kitchen?stationId=${ID}`,
    'fulfillment/display?limit=10',
    'fulfillment/layout',
    'fulfillment/incidents?scope=open',
    `fulfillment/orders/${ID}/actions`,
    `media/${SHA}.webp`,
    'pos/sales/not-a-uuid',
    `orders?shift_id=${ID}`,
    `pos/fiscal-receipts/pending?shift_id=${ID}`,
    `cash-shifts?shift_id=${ID}`,
    `orders?shift_id=${ID}&shift_id=${ID}`,
    'orders?shift_id=1',
    'menu?release=1',
    `staff/approvals?shift_id=${ID}`,
  ];
  return [
    ...[...read, ...write, ...other].map((path) => `/edge/v1/${path}`),
    '/health/ready',
    '/health/live',
    '/health/metrics',
    '/internal/v1/edge/pos-orders/events',
  ];
};

test('pos profile is the pos-desktop allowlist exactly: same regular expressions, same forwarded requests', async () => {
  assert.equal(POS_READ_PATH.source, EDGE_READ_PATH.source);
  assert.equal(POS_READ_PATH.flags, EDGE_READ_PATH.flags);
  assert.equal(POS_WRITE_PATH.source, EDGE_WRITE_PATH.source);
  assert.equal(POS_WRITE_PATH.flags, EDGE_WRITE_PATH.flags);
  assert.deepEqual([...POS_SHIFT_FILTERED], [...SHIFT_FILTERED]);
  // RegExp#source escapes every slash.
  const escaped = (route) => route.replaceAll('/', '\\/');
  for (const route of SALE_ROUTES.read) assert.ok(POS_READ_PATH.source.includes(escaped(route)));
  for (const route of SALE_ROUTES.write) assert.ok(POS_WRITE_PATH.source.includes(escaped(route)));
  // Behaviour, not only source text: what the desk forwards is what the profile lets through.
  const forwarded = [];
  const handler = createProtocolHandler({
    assetDir: pathToFileURL(tmpdir() + '/'),
    config: { edgePort: 3101 },
    fetchImpl: async (url, init) => {
      forwarded.push(`${init.method} ${new URL(url).pathname}${new URL(url).search}`);
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    },
  });
  let checked = 0;
  for (const path of desktopRoutes())
    for (const method of ['GET', 'POST']) {
      const before = forwarded.length;
      await handler(
        new globalThis.Request(new URL(path, APP_URL), {
          method,
          ...(method === 'POST'
            ? { body: '{}', headers: { 'Content-Type': 'application/json' } }
            : {}),
        }),
      );
      const sent = forwarded.length > before;
      if (sent) assert.equal(forwarded.at(-1), `${method} ${path}`);
      // Menu photos reach the edge through /assets/menu on the desk (checked below).
      const expected = sent || (method === 'GET' && path === `/edge/v1/media/${SHA}.webp`);
      assert.equal(allowedPosRoute(method, path), expected, `${method} ${path}`);
      checked++;
    }
  assert.ok(checked > 100);
  // The desk's photo read is exactly the profile's media route.
  const photos = [];
  await createProtocolHandler({
    assetDir: pathToFileURL(tmpdir() + '/'),
    config: { edgePort: 3101 },
    fetchImpl: async (url) => {
      photos.push(new URL(url).pathname);
      return new Response(null, { status: 404 });
    },
  })(new globalThis.Request(new URL(`/assets/menu/${SHA}.webp`, APP_URL)));
  assert.deepEqual(photos, [`/edge/v1/media/${SHA}.webp`]);
  assert.equal(allowedPosRoute('GET', photos[0]), true);
  for (const [method, path] of [
    ['GET', `/edge/v1/media/${'A'.repeat(64)}.webp`],
    ['GET', `/edge/v1/media/${SHA}.png`],
    ['POST', `/edge/v1/media/${SHA}.webp`],
    ['GET', '/health/ready?x=1'],
    ['GET', '/edge/v1/orders/./'],
    ['GET', '/edge/v1/%73ession'],
    ['PUT', '/edge/v1/orders'],
  ])
    assert.equal(allowedPosRoute(method, path), false, `${method} ${path}`);
});

const KDS_ROUTES = new Set([
  'GET /edge/v1/fulfillment/layout',
  'GET /edge/v1/fulfillment/kds/breading',
  'GET /edge/v1/fulfillment/kds/breading?limit=50',
  'GET /edge/v1/fulfillment/incidents?scope=open',
  'GET /edge/v1/fulfillment/incidents?scope=today',
  'POST /edge/v1/fulfillment/incidents',
  `POST /edge/v1/fulfillment/orders/${ID}/restore-review`,
]);
const kitchenCorpus = [
  ...KDS_ROUTES,
  ...['POST', 'GET'].flatMap((method) =>
    [
      '/edge/v1/staff/login',
      '/edge/v1/staff/logout',
      '/edge/v1/staff/password-reset',
      '/edge/v1/terminals/pair',
      '/edge/v1/session',
      '/edge/v1/terminals/session',
      '/edge/v1/fulfillment/config',
      '/edge/v1/fulfillment/stations',
      `/edge/v1/fulfillment/kitchen?stationId=${ID}&afterOrderId=${ID}&limit=100`,
      '/edge/v1/fulfillment/kitchen?limit=101',
      '/edge/v1/fulfillment/display?afterNumber=12&limit=10',
      `/edge/v1/fulfillment/orders/${ID}?stationId=${ID}`,
      `/edge/v1/fulfillment/orders/${ID}/actions`,
      `/edge/v1/fulfillment/orders/${ID}/restore-review`,
      '/edge/v1/fulfillment/layout',
      '/edge/v1/fulfillment/layout?x=1',
      '/edge/v1/fulfillment/kds/breading?limit=101',
      '/edge/v1/fulfillment/kds/breading?limit=1&limit=2',
      '/edge/v1/fulfillment/incidents',
      '/edge/v1/fulfillment/incidents?scope=all',
      '/edge/v1/fulfillment/incidents?scope=open&scope=today',
      '/edge/v1/fulfillment/incidents?scope=open&limit=5',
      '/edge/v1/pos/config',
      '/edge/v1/pos/sales',
      '/edge/v1/staff/approvals',
      '/edge/v1/orders',
      `/edge/v1/media/${SHA}.webp`,
      '/health/ready',
    ].map((path) => `${method} ${path}`),
  ),
];

test('kitchen profile is the kitchen app allowlist plus exactly the KDS routes of CR kds-5', () => {
  for (const route of KDS_ROUTES) {
    const [method, path] = route.split(' ');
    assert.equal(allowedKitchenRoute(method, path), true, route);
    assert.equal(allowedDisplayRoute(method, path), false, route);
    assert.equal(allowedPosRoute(method, path), false, route);
  }
  // Before the KDS lane merges, the kitchen app lacks the CR routes; after it, it has them.
  for (const route of new Set(kitchenCorpus)) {
    const [method, path] = route.split(' ');
    assert.equal(
      allowedKitchenRoute(method, path),
      kitchenAppAllowed(method, path) || KDS_ROUTES.has(route),
      route,
    );
  }
  assert.equal(allowedKitchenRoute('POST', '/edge/v1/fulfillment/incidents?x=1'), false);
  assert.equal(allowedKitchenRoute('GET', '/edge/v1/fulfillment/incidents?scope=open'), true);
});

test('display profile: the board reaches pairing, its session and the board only, never /kitchen', () => {
  const allowed = [
    ['POST', '/edge/v1/terminals/pair'],
    ['GET', '/edge/v1/terminals/session'],
    ['GET', '/edge/v1/fulfillment/config'],
    ['GET', '/edge/v1/fulfillment/display'],
    ['GET', '/edge/v1/fulfillment/display?afterNumber=12&limit=10'],
  ];
  for (const [method, path] of allowed) {
    assert.equal(allowedDisplayRoute(method, path), true, path);
    assert.equal(kitchenAppAllowed(method, path), true, 'the board uses kitchen app routes only');
  }
  for (const route of kitchenCorpus) {
    const [method, path] = route.split(' ');
    if (!allowed.some(([m, p]) => m === method && p === path))
      assert.equal(allowedDisplayRoute(method, path), false, route);
  }
  for (const path of [
    `/edge/v1/fulfillment/kitchen?stationId=${ID}`,
    '/edge/v1/fulfillment/kitchen',
    '/edge/v1/fulfillment/display?limit=101',
    '/edge/v1/fulfillment/display?stationId=' + ID,
    '/edge/v1/session',
  ])
    assert.equal(allowedDisplayRoute('GET', path), false, path);
  for (const path of ['/edge/v1/staff/login', '/edge/v1/staff/logout', '/edge/v1/staff/pin'])
    assert.equal(allowedDisplayRoute('POST', path), false, path);
  assert.deepEqual(PROFILES.display.headers, ['x-terminal-id', 'x-terminal-key']);
  assert.deepEqual(PROFILES.pos.headers, [
    'authorization',
    'x-staff-session-id',
    'idempotency-key',
  ]);
});

test('gateway config: old clientAddresses stay the kitchen profile; clients[] up to 32 with one profile each', () => {
  const bindAddress = '10.20.0.1';
  const legacy = clientProfiles({ bindAddress, clientAddresses: ['10.20.0.11', '10.20.0.12'] });
  assert.equal(legacy.format, 'clientAddresses');
  assert.equal(legacy.maxConnections, 40, 'the old format keeps the old connection limit');
  assert.deepEqual(
    [...legacy.profiles],
    [
      [bindAddress, 'kitchen'],
      ['10.20.0.11', 'kitchen'],
      ['10.20.0.12', 'kitchen'],
    ],
  );
  const clients = Array.from({ length: MAX_CLIENTS }, (_, i) => ({
    address: `10.20.1.${i + 1}`,
    profile: PROFILE_NAMES[i % 3],
    ...(i === 0 ? { label: 'Касса 1' } : {}),
  }));
  const current = clientProfiles({ bindAddress, clients });
  assert.equal(current.format, 'clients');
  assert.equal(current.maxConnections, 64);
  assert.equal(current.profiles.get(bindAddress), 'kitchen', 'the server keeps its own check');
  assert.equal(current.profiles.get('10.20.1.3'), 'pos');
  assert.equal(clientProfiles({ bindAddress, clients, maxConnections: 128 }).maxConnections, 128);
  for (const bad of [
    {},
    { clientAddresses: [] },
    { clientAddresses: Array.from({ length: 21 }, (_, i) => `10.20.2.${i + 1}`) },
    { clientAddresses: ['10.20.0.11', '10.20.0.11'] },
    { clientAddresses: ['8.8.8.8'] },
    { clientAddresses: ['10.20.0.11'], maxConnections: 64 },
    { clientAddresses: ['10.20.0.11'], clients },
    { clients: [] },
    { clients: [...clients, { address: '10.20.3.1', profile: 'pos' }] },
    { clients: [{ address: '10.20.0.11', profile: 'owner' }] },
    { clients: [{ address: '10.20.0.11', profile: 'Kitchen' }] },
    { clients: [{ address: '127.0.0.1', profile: 'kitchen' }] },
    { clients: [{ address: '10.020.0.11', profile: 'kitchen' }] },
    { clients: [{ address: bindAddress, profile: 'pos' }] },
    {
      clients: [
        { address: '10.20.0.11', profile: 'kitchen' },
        { address: '10.20.0.11', profile: 'display' },
      ],
    },
    { clients: [{ address: '10.20.0.11', profile: 'kitchen', extra: true }] },
    { clients: [{ address: '10.20.0.11', profile: 'kitchen', label: '' }] },
    { clients: [{ address: '10.20.0.11', profile: 'kitchen', label: 'a\nb' }] },
    { clients: [{ address: '10.20.0.11', profile: 'kitchen', label: 'x'.repeat(61) }] },
    { clients: [{ address: '10.20.0.11', profile: 'kitchen' }], maxConnections: 8 },
    { clients: [{ address: '10.20.0.11', profile: 'kitchen' }], maxConnections: 64.5 },
  ])
    assert.throws(() => clientProfiles({ bindAddress, ...bad }), /INVALID_LAN_GATEWAY_CONFIG/);
  assert.throws(
    () => clientProfiles({ bindAddress: '127.0.0.1', clientAddresses: ['10.20.0.11'] }),
    /INVALID_LAN_GATEWAY_CONFIG/,
  );
});

/** Synthetic TLS material for a gateway at `ip`; the listener itself is on loopback. */
async function gatewayPki(directory, ip) {
  const passphrase = 'synthetic-profile-pfx-password-only-1234';
  await writeFile(
    join(directory, 'openssl.cnf'),
    `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=Synthetic LAN profiles\n[ext]\nsubjectAltName=IP:${ip}\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n`,
  );
  await writeFile(join(directory, 'pass.txt'), passphrase, { mode: 0o600 });
  for (const args of [
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-config']
      .concat([join(directory, 'openssl.cnf'), '-keyout', join(directory, 'key.pem')])
      .concat(['-out', join(directory, 'cert.pem')]),
    ['pkcs12', '-export', '-keypbe', 'AES-256-CBC', '-certpbe', 'AES-256-CBC', '-macalg']
      .concat(['sha256', '-inkey', join(directory, 'key.pem'), '-in'])
      .concat([join(directory, 'cert.pem'), '-out', join(directory, 'server.pfx'), '-passout'])
      .concat([`file:${join(directory, 'pass.txt')}`]),
  ])
    assert.equal(spawnSync('openssl', args, { stdio: 'pipe' }).status, 0, 'openssl fixture');
  return {
    passphrase,
    cert: await readFile(join(directory, 'cert.pem'), 'utf8'),
    pfx: await readFile(join(directory, 'server.pfx')),
  };
}
async function freePort() {
  const reserve = createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const { port } = reserve.address();
  await new Promise((resolve) => reserve.close(resolve));
  return port;
}
/**
 * The gateway on loopback, with the client IPv4 of each TLS connection set by the test: this
 * container has no private interface, and the profile depends on that address only.
 */
async function profiledGateway(settings) {
  const port = await freePort();
  const gateway = createKitchenLanGateway({ ...settings, port });
  const state = { from: null };
  gateway.on('secureConnection', (socket) =>
    Object.defineProperty(socket, 'remoteAddress', { value: state.from, configurable: true }),
  );
  await new Promise((resolve) => gateway.listen(port, '127.0.0.1', resolve));
  return { gateway, port, state };
}
function lanCall({ port, host, cert }, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host,
        port,
        path,
        method,
        headers: { Host: `${host}:${port}`, ...headers },
        createConnection: () =>
          connectTls({
            host,
            ca: cert,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
            socket: connectTcp(port, '127.0.0.1'),
          }),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('one gateway port, three profiles by client IPv4 over real pinned TLS: the board cannot reach /kitchen, the cash desk gets its routes and photos', async () => {
  const BIND = '10.20.0.1',
    KITCHEN = '10.20.0.11',
    BOARD = '10.20.0.12',
    DESK = '10.20.0.21';
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-lan-profiles-'));
  const webp = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([20, 0, 0, 0]),
    Buffer.from('WEBPVP8 synthetic-photo-only'),
  ]);
  const photo = createHash('sha256').update(webp).digest('hex');
  const big = JSON.stringify({ items: 'x'.repeat(3500000) });
  const received = [];
  const edge = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    const json = (status, text, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
      res.end(text);
    };
    if (req.url === `/edge/v1/media/${photo}.webp`) {
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': webp.length });
      res.end(webp);
    } else if (req.url === `/edge/v1/media/${SHA}.webp`) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>');
    } else if (req.url === '/edge/v1/pos/config')
      json(200, '{"mode":"pos_sale",  "server_time":"2026-11-19T03:00:00Z"}');
    else if (req.url === '/edge/v1/menu' || req.url === '/edge/v1/fulfillment/stations')
      json(200, big);
    else if (req.url === '/health/ready') json(200, '{"ready":true}');
    else if (req.url === '/edge/v1/staff/logout') {
      res.writeHead(204);
      res.end();
    } else if (req.method === 'POST') json(201, JSON.stringify({ path: req.url }));
    else json(200, JSON.stringify({ path: req.url }));
  });
  await new Promise((resolve) => edge.listen(0, '127.0.0.1', resolve));
  const servers = [];
  try {
    const pki = await gatewayPki(directory, BIND);
    const settings = {
      bindAddress: BIND,
      edgePort: edge.address().port,
      pfx: pki.pfx,
      passphrase: pki.passphrase,
      timeoutMs: 2000,
    };
    const lan = await profiledGateway({
      ...settings,
      clients: [
        { address: KITCHEN, profile: 'kitchen', label: 'Сборка зал' },
        { address: BOARD, profile: 'display', label: 'Табло' },
        { address: DESK, profile: 'pos', label: 'Касса 1' },
      ],
    });
    servers.push(lan.gateway);
    assert.equal(lan.gateway.maxConnections, 64);
    const target = { port: lan.port, host: BIND, cert: pki.cert };
    const call = async (from, path, options) => {
      lan.state.from = from;
      return lanCall(target, path, options);
    };
    const json = { 'Content-Type': 'application/json' };

    // Unknown address: refused before any route, even the health probe.
    assert.equal((await call('10.20.0.99', '/healthz')).status, 403);
    for (const from of [BIND, KITCHEN, BOARD, DESK])
      assert.equal((await call(from, '/healthz')).status, 200, from);
    assert.equal(received.length, 0);

    // The board: its own routes, terminal headers only; never kitchen queues, staff or POS.
    let count = received.length;
    for (const path of [
      `/edge/v1/fulfillment/kitchen?stationId=${ID}`,
      '/edge/v1/fulfillment/stations',
      `/edge/v1/fulfillment/orders/${ID}`,
      '/edge/v1/session',
      '/edge/v1/pos/config',
    ])
      assert.equal((await call(BOARD, path)).status, 404, path);
    assert.equal(
      (await call(BOARD, '/edge/v1/staff/login', { method: 'POST', headers: json, body: '{}' }))
        .status,
      404,
    );
    assert.equal(received.length, count, 'nothing of another profile reaches the edge');
    const board = await call(BOARD, '/edge/v1/fulfillment/display?limit=10', {
      headers: {
        'X-Terminal-Id': ID,
        'X-Terminal-Key': 'synthetic-terminal-key',
        Authorization: 'Bearer synthetic-fixture',
      },
    });
    assert.equal(board.status, 200);
    assert.equal(received.at(-1).headers['x-terminal-key'], 'synthetic-terminal-key');
    assert.equal(received.at(-1).headers.authorization, undefined);

    // Kitchen: today's routes plus KDS; a bodyless logout as before; no POS route.
    assert.equal((await call(KITCHEN, '/edge/v1/fulfillment/layout')).status, 200);
    assert.equal(
      (
        await call(KITCHEN, '/edge/v1/fulfillment/incidents', {
          method: 'POST',
          headers: { ...json, 'Idempotency-Key': ID },
          body: '{"provider":"glovo"}',
        })
      ).status,
      201,
    );
    assert.equal(received.at(-1).headers['idempotency-key'], ID);
    assert.equal(
      (await call(KITCHEN, '/edge/v1/staff/logout', { method: 'POST' })).status,
      204,
      'bodyless kitchen logout',
    );
    count = received.length;
    assert.equal((await call(KITCHEN, '/edge/v1/pos/config')).status, 404);
    assert.equal((await call(KITCHEN, `/edge/v1/media/${photo}.webp`)).status, 404);
    assert.equal(
      (
        await call(KITCHEN, '/edge/v1/fulfillment/incidents', {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ description: 'x'.repeat(20000) }),
        })
      ).status,
      413,
      'kitchen bodies stay within 16 KiB',
    );
    assert.equal(received.length, count);
    assert.equal(
      (await call(KITCHEN, '/edge/v1/fulfillment/stations')).status,
      502,
      'kitchen answers stay within 3 MiB',
    );
    // The server's own address keeps the kitchen profile (the installer's check).
    assert.equal((await call(BIND, '/edge/v1/session')).status, 200);

    // The cash desk: raw HTTPS first - no kitchen route, no terminal headers.
    count = received.length;
    for (const path of ['/edge/v1/fulfillment/stations', '/edge/v1/fulfillment/display'])
      assert.equal((await call(DESK, path)).status, 404, path);
    assert.equal(received.length, count);
    await call(DESK, '/edge/v1/session', {
      headers: { 'X-Terminal-Key': 'not-for-the-desk', 'X-Staff-Session-Id': ID },
    });
    assert.equal(received.at(-1).headers['x-terminal-key'], undefined);
    assert.equal(received.at(-1).headers['x-staff-session-id'], ID);

    // ... then the real pos-desktop transport over the same pinned TLS (contract CL-2).
    const assetDir = join(directory, 'renderer');
    await mkdir(join(assetDir, 'v2/assets'), { recursive: true });
    await writeFile(join(assetDir, 'v2/assets/logo.png'), Buffer.from('synthetic-logo'));
    const desk = createProtocolHandler({
      assetDir: pathToFileURL(assetDir + '/'),
      config: {
        edgeHost: BIND,
        edgePort: lan.port,
        edgeCertificatePem: pki.cert,
        terminalId: ID,
      },
      fetchImpl: async () => {
        throw new Error('a remote desk never uses plain HTTP');
      },
      dial: () => {
        lan.state.from = DESK;
        return connectTcp(lan.port, '127.0.0.1');
      },
      timeoutMs: 5000,
    });
    const deskCall = (path, init) => desk(new globalThis.Request(new URL(path, APP_URL), init));
    let response = await deskCall('/edge/v1/pos/config');
    assert.equal(response.status, 200);
    assert.equal(
      await response.text(),
      '{"mode":"pos_sale",  "server_time":"2026-11-19T03:00:00Z"}',
      'the desk gets the edge bytes unchanged',
    );
    const sale = JSON.stringify({ quote_id: ID, lines: 'x'.repeat(20000) });
    response = await deskCall('/edge/v1/pos/sales', {
      method: 'POST',
      body: sale,
      headers: {
        ...json,
        Authorization: 'Bearer synthetic-fixture',
        'X-Staff-Session-Id': ID,
        'Idempotency-Key': ID,
      },
    });
    assert.equal(response.status, 201, 'a 20 KB sale body fits the 64 000 byte desk limit');
    assert.equal(received.at(-1).body, sale);
    assert.equal(received.at(-1).headers['idempotency-key'], ID);
    assert.equal(received.at(-1).headers.authorization, 'Bearer synthetic-fixture');
    response = await deskCall(`/edge/v1/orders?shift_id=${ID}`);
    assert.deepEqual(await response.json(), { path: `/edge/v1/orders?shift_id=${ID}` });
    response = await deskCall('/health/ready');
    assert.deepEqual(await response.json(), { ready: true });
    response = await deskCall('/edge/v1/menu');
    assert.equal(response.status, 200, 'a 3.5 MB menu fits the 4 MB desk limit');
    assert.equal((await response.text()).length, big.length);
    response = await deskCall('/edge/v1/staff/logout', {
      method: 'POST',
      body: '{}',
      headers: json,
    });
    assert.equal(response.status, 204);
    response = await deskCall(`/assets/menu/${photo}.webp`);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), webp);
    response = await deskCall(`/assets/menu/${SHA}.webp`);
    assert.equal(response.headers.get('content-type'), 'image/png', 'not a WebP: the logo');

    // The old config on the new code: every address is a kitchen client, nothing else.
    const legacy = await profiledGateway({ ...settings, clientAddresses: [KITCHEN] });
    servers.push(legacy.gateway);
    assert.equal(legacy.gateway.maxConnections, 40);
    const old = { port: legacy.port, host: BIND, cert: pki.cert };
    legacy.state.from = DESK;
    assert.equal((await lanCall(old, '/edge/v1/pos/config')).status, 403);
    legacy.state.from = KITCHEN;
    assert.equal((await lanCall(old, '/edge/v1/fulfillment/layout')).status, 200);
    assert.equal((await lanCall(old, '/edge/v1/pos/config')).status, 404);
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    edge.closeAllConnections();
    await new Promise((resolve) => edge.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('the service validates a config and its PFX without listening (--check), and rejects unknown keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-lan-check-'));
  const gateway = fileURLToPath(
    new URL('../../infra/windows/kitchen-lan-gateway.mjs', import.meta.url),
  );
  try {
    const pki = await gatewayPki(directory, '10.20.0.1');
    await writeFile(join(directory, 'gateway.pfx'), pki.pfx);
    const base = {
      bindAddress: '10.20.0.1',
      port: 3443,
      edgePort: 3101,
      pfxPath: join(directory, 'gateway.pfx'),
      passphrase: pki.passphrase,
    };
    const run = async (config) => {
      await writeFile(join(directory, 'gateway.json'), JSON.stringify(config));
      return spawnSync(process.execPath, [gateway, '--check', join(directory, 'gateway.json')], {
        encoding: 'utf8',
        timeout: 15000,
      });
    };
    let result = await run({
      ...base,
      clients: [
        { address: '10.20.0.11', profile: 'kitchen' },
        { address: '10.20.0.12', profile: 'display' },
        { address: '10.20.0.21', profile: 'pos', label: 'Касса 1' },
        { address: '10.20.0.22', profile: 'pos', label: 'Касса 2' },
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      check: 'LAN_GATEWAY_CONFIG_OK',
      format: 'clients',
      clients: { kitchen: 1, display: 1, pos: 2 },
      maxConnections: 64,
    });
    assert.ok(!result.stdout.includes('10.20.0'), 'the summary names no address');
    result = await run({ ...base, clientAddresses: ['10.20.0.11'] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).format, 'clientAddresses');
    for (const bad of [
      { ...base, clientAddresses: ['10.20.0.11'], extra: 1 },
      { ...base, passphrase: 'wrong-synthetic-passphrase-0000000000' },
      { ...base, clients: [{ address: '10.20.0.11', profile: 'owner' }] },
    ]) {
      result = await run(bad);
      assert.equal(result.status, 1);
      assert.equal(result.stderr.trim(), 'LAN_GATEWAY_START_FAILED');
      assert.ok(!result.stderr.includes(pki.passphrase));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---- Cutover 19.11 (CL-4, CL-5): Windows scripts for the gateway clients and the desks ------

const windowsFile = (name) => new URL(`../../infra/windows/${name}`, import.meta.url);
const LAN_SCRIPTS = [
  'install-kitchen-lan.ps1',
  'update-kitchen-lan-clients.ps1',
  'install-kitchen-client.ps1',
  'install-pos-client.ps1',
];
/** A top-level PowerShell function of these scripts: `function Name...` up to its `}` line. */
const psFunction = (source, name) =>
  new RegExp(`^function ${name}\\b[\\s\\S]*?^\\}`, 'm').exec(source)?.[0];

test('Windows LAN scripts: ASCII, pinned helpers, shared helpers equal, autostart only on request and never before 19.11, iiko only read', async () => {
  const source = Object.fromEntries(
    await Promise.all(
      LAN_SCRIPTS.map(async (name) => [name, await readFile(windowsFile(name), 'utf8')]),
    ),
  );
  for (const [name, text] of Object.entries(source)) {
    // Windows PowerShell 5.1 reads a script without BOM in the ANSI code page.
    assert.doesNotMatch(text, /[^\t\n\r -~]/, `${name} is ASCII`);
    assert.match(text, /^#Requires -Version 5\.1/, name);
    assert.match(text, /Set-StrictMode -Version Latest/, name);
    assert.match(text, /\$ErrorActionPreference='Stop'/, name);
    assert.doesNotMatch(
      text,
      /Invoke-Expression|\biex\b|Invoke-WebRequest|Invoke-RestMethod|DownloadString|Start-BitsTransfer|https?:\/\//i,
      name,
    );
    for (const line of text.split('\n').filter((l) => /iiko/i.test(l)))
      assert.doesNotMatch(
        line,
        /Stop-|Remove-|Set-|New-|Disable-|Kill|taskkill|sc\.exe|reg\.exe|Rename-|Move-/i,
        `${name} never changes iiko: ${line.trim()}`,
      );
  }
  const foundation = createHash('sha256')
    .update(await readFile(windowsFile('install-native-foundation.ps1')))
    .digest('hex');
  for (const name of ['install-kitchen-lan.ps1', 'update-kitchen-lan-clients.ps1'])
    assert.ok(source[name].includes(foundation), `${name} pins the reviewed NTFS helpers`);
  for (const name of ['Test-LanIPv4', 'Assert-LanAcl'])
    assert.equal(
      psFunction(source['update-kitchen-lan-clients.ps1'], name),
      psFunction(source['install-kitchen-lan.ps1'], name),
      name,
    );
  const kitchen = source['install-kitchen-client.ps1'];
  const pos = source['install-pos-client.ps1'];
  const shared = (text) =>
    text.slice(
      text.indexOf('\nfunction Test-LanIPv4'),
      text.indexOf('# ---- End of shared LAN client helpers ----'),
    );
  assert.ok(shared(kitchen).length > 5000);
  assert.equal(shared(kitchen), shared(pos), 'the client installers share one helper block');
  for (const [text, app, minimum] of [
    [kitchen, 'kitchen-desktop', '0.4.0'],
    [pos, 'pos-desktop', '0.5.0'],
  ]) {
    // Registry writes only inside Set-LanAutostart, called only for -Autostart, guarded by date.
    const autostart = psFunction(text, 'Set-LanAutostart');
    assert.ok(autostart.includes('$Today.Date -lt $CutoverDate.Date'));
    for (const write of ['New-ItemProperty', 'Remove-ItemProperty', 'Set-ItemProperty'])
      assert.equal(
        text.split(write).length - 1,
        autostart.split(write).length - 1,
        `${write} only in Set-LanAutostart`,
      );
    assert.equal(text.split("Set-LanAutostart '").length - 1, 1);
    assert.match(text, /ParameterSetName -ceq 'Autostart'\) \{\n\s+Set-LanAutostart '/);
    assert.match(text, /\[datetime\]\$CutoverDate=\[datetime\]'2026-11-19'/);
    assert.ok(text.includes(`[version]'${minimum}'`));
    // The default app path is where the per-user NSIS installer of that app puts it.
    const builder = await readFile(
      new URL(`../../apps/${app}/electron-builder.yml`, import.meta.url),
      'utf8',
    );
    const product = /^productName: (.+)$/m.exec(builder)[1];
    const exe = /^\s+executableName: (.+)$/m.exec(builder)[1];
    assert.match(builder, /perMachine: false/);
    assert.ok(text.includes(`'Programs\\${product}\\${exe}.exe'`), `${app} path`);
  }
  const desk = JSON.parse(
    await readFile(new URL('../../apps/pos-desktop/package.json', import.meta.url), 'utf8'),
  );
  const [major, minor] = desk.version.split('.').map(Number);
  assert.ok(
    major > 0 || minor >= 5,
    'the POS installer requires a pos-desktop that knows edgeHost',
  );
});

function findPowerShell() {
  if (process.env.PICKCHICK_TEST_PWSH) return process.env.PICKCHICK_TEST_PWSH;
  for (const directory of (process.env.PATH ?? '').split(':'))
    for (const name of ['pwsh', 'powershell'])
      if (spawnSync('test', ['-x', join(directory, name)]).status === 0)
        return join(directory, name);
  return null;
}

test('PowerShell: the LAN script functions against synthetic gateways; their files pass the gateway and both app validators', async (t) => {
  const pwsh = findPowerShell();
  if (!pwsh) {
    if (process.env.CI) assert.fail('PowerShell is required for the LAN script checks in CI');
    t.skip('PowerShell unavailable; set PICKCHICK_TEST_PWSH to run the LAN script checks');
    return;
  }
  const BIND = '10.20.0.1';
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-lan-scripts-'));
  const out = join(directory, 'out');
  await mkdir(out);
  await mkdir(join(directory, 'other'));
  const edge = createServer((req, res) => {
    const status =
      { '/edge/v1/fulfillment/config': 200 }[req.url] ??
      ([
        '/edge/v1/session',
        '/edge/v1/cash-shifts/current',
        '/edge/v1/fulfillment/stations',
      ].includes(req.url)
        ? 401
        : 404);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        status === 200
          ? { enabled: true }
          : { code: status === 401 ? 'UNAUTHORIZED' : 'NOT_FOUND' },
      ),
    );
  });
  await new Promise((resolve) => edge.listen(0, '127.0.0.1', resolve));
  const servers = [];
  try {
    const pki = await gatewayPki(directory, BIND);
    const other = await gatewayPki(join(directory, 'other'), '10.20.9.9');
    const settings = {
      bindAddress: BIND,
      edgePort: edge.address().port,
      pfx: pki.pfx,
      passphrase: pki.passphrase,
      timeoutMs: 2000,
      clients: [
        { address: '10.20.0.11', profile: 'kitchen' },
        { address: '10.20.0.12', profile: 'display' },
        { address: '10.20.0.21', profile: 'pos' },
      ],
    };
    const ports = { closed: await freePort() };
    for (const [name, from] of [
      ['kitchen', '10.20.0.11'],
      ['display', '10.20.0.12'],
      ['pos', '10.20.0.21'],
      ['unlisted', '10.20.0.99'],
    ]) {
      const lan = await profiledGateway(settings);
      lan.state.from = from;
      servers.push(lan.gateway);
      ports[name] = lan.port;
    }
    await writeFile(join(directory, 'cert.pem'), pki.cert);
    await writeFile(join(directory, 'other.pem'), other.cert);
    await writeFile(join(directory, 'server.pfx'), pki.pfx);
    const { X509Certificate } = await import('node:crypto');
    const sha = createHash('sha256').update(new X509Certificate(pki.cert).raw).digest('hex');
    const run = await promisify(execFile)(
      pwsh,
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        fileURLToPath(new URL('kitchen-lan-clients.test.ps1', import.meta.url)),
      ],
      {
        timeout: 180000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          LAN_TEST_OUT: out,
          LAN_TEST_HOST: BIND,
          LAN_TEST_CERT: join(directory, 'cert.pem'),
          LAN_TEST_OTHER_CERT: join(directory, 'other.pem'),
          LAN_TEST_CERT_SHA: sha,
          LAN_TEST_PORTS: JSON.stringify(ports),
          LAN_TEST_PFX: join(directory, 'server.pfx'),
          LAN_TEST_PASSPHRASE: pki.passphrase,
        },
      },
    );
    const passed = /LAN client script checks passed: (\d+)/.exec(run.stdout);
    assert.ok(passed && Number(passed[1]) >= 120, run.stdout + run.stderr);

    // The gateway accepts exactly the configs the update script writes.
    const gateway = fileURLToPath(windowsFile('kitchen-lan-gateway.mjs'));
    for (const [file, expected] of [
      ['gateway-clients.json', { format: 'clients', clients: { kitchen: 1, display: 1, pos: 2 } }],
      [
        'gateway-legacy.json',
        { format: 'clientAddresses', clients: { kitchen: 1, display: 0, pos: 0 } },
      ],
    ]) {
      const check = spawnSync(process.execPath, [gateway, '--check', join(out, file)], {
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(check.status, 0, `${file}: ${check.stderr}`);
      const summary = JSON.parse(check.stdout);
      assert.equal(summary.format, expected.format);
      assert.deepEqual(summary.clients, expected.clients);
    }
    // pos-desktop starts with every config the POS installer writes.
    const { validateConfig: validatePos } = await import('../../apps/pos-desktop/protocol.mjs');
    const posConfigs = {};
    for (const file of ['pos-escpos.json', 'pos-kept.json', 'pos-fresh.json']) {
      posConfigs[file] = validatePos(JSON.parse(await readFile(join(out, file), 'utf8')));
      assert.equal(posConfigs[file].edgeHost, BIND, file);
      assert.equal(posConfigs[file].edgePort, 3443, file);
      assert.equal(posConfigs[file].terminalId, '10000000-0000-4000-8000-000000000011', file);
    }
    assert.deepEqual(posConfigs['pos-escpos.json'].printer, {
      mode: 'escpos-tcp',
      host: '10.20.0.50',
      port: 9100,
      drawerKick: true,
    });
    assert.equal(posConfigs['pos-escpos.json'].pinLength, 4);
    assert.deepEqual(posConfigs['pos-escpos.json'].categories, {
      '10000000-0000-4000-8000-000000000012': 'Combo',
    });
    assert.equal(posConfigs['pos-kept.json'].printer.deviceName, 'Old queue');
    assert.equal(posConfigs['pos-fresh.json'].printer.deviceName, 'Receipt 80');
    // kitchen-desktop as packaged: security.mjs next to the kitchen gateway it copies at build.
    const desktop = join(directory, 'kitchen-desktop');
    await mkdir(desktop);
    for (const [from, to] of [
      ['../../apps/kitchen-desktop/security.mjs', 'security.mjs'],
      ['../../apps/kitchen/server.mjs', 'gateway.mjs'],
      ['../../apps/kitchen/terminal-cookie.mjs', 'terminal-cookie.mjs'],
    ])
      await writeFile(join(desktop, to), await readFile(new URL(from, import.meta.url)));
    const { validateConfig: validateKitchen } = await import(
      pathToFileURL(join(desktop, 'security.mjs')).href
    );
    for (const [file, mode] of [
      ['kitchen-prep.json', 'prep'],
      ['kitchen-display.json', 'display'],
      ['kitchen-staff.json', undefined],
    ]) {
      const config = validateKitchen(JSON.parse(await readFile(join(out, file), 'utf8')));
      assert.equal(config.edgeHost, BIND, file);
      assert.equal(config.edgePort, 3443, file);
      assert.equal(config.terminalMode, mode, file);
    }
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    edge.closeAllConnections();
    await new Promise((resolve) => edge.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
