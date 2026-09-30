import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  allowedKitchenRoute,
  privateIPv4,
  createKitchenLanGateway,
} from '../../infra/windows/kitchen-lan-gateway.mjs';

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
