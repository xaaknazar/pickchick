import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createBackofficeServer } from '../../apps/backoffice/server.mjs';
import {
  createStaffAccess,
  passwordHash,
  staffClientAddress,
} from '../../apps/backoffice/staff-auth.mjs';

// Synthetic fixtures only: no real people, passwords, tokens or client addresses.
const origin = 'https://pickchick.example';
const ceoPassword = 'Synthetic-ceo-password-2026';
const managerPassword = 'Synthetic-manager-password-2026';
const config = {
  version: 2,
  origin,
  accounts: [
    { username: 'ceo', token: 'c'.repeat(64), ...(await passwordHash(ceoPassword)) },
    {
      username: 'aigerim.manager',
      token: 'd'.repeat(64),
      ...(await passwordHash(managerPassword)),
    },
  ],
};

function call(port, path, { method = 'GET', body, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          host: 'pickchick.example',
          origin,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    r.on('error', reject);
    r.end(raw ?? (body && JSON.stringify(body)));
  });
}

async function portal(t) {
  let now = 5_000_000;
  const api = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"branches":[]}');
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const server = createBackofficeServer({
    apiPort: api.address().port,
    staffAccess: createStaffAccess(config, { now: () => now }),
    staticPrefix: '/backoffice',
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    api.closeAllConnections();
    api.close();
  });
  const get = (p, o) => call(server.address().port, p, o);
  // The outer Caddy is the only peer that may name the client (X-Forwarded-For).
  const login = (username, password, ip = '198.51.100.10') =>
    get('/backoffice/auth/login', {
      method: 'POST',
      body: { username, password },
      headers: { 'x-forwarded-for': ip },
    });
  return { get, login, advance: (ms) => (now += ms) };
}

test('anonymous cheap requests never reach the limiter: a manager still signs in', async (t) => {
  const p = await portal(t);
  const attacker = { 'x-forwarded-for': '203.0.113.66' };
  for (let i = 0; i < 40; i++) {
    const kind = i % 3;
    const r = await p.get('/backoffice/auth/login', {
      method: 'POST',
      headers: {
        ...attacker,
        ...(kind === 0 ? { 'content-type': 'text/plain' } : { 'content-type': 'application/json' }),
      },
      raw: kind === 2 ? '{"username":[]}' : kind === 1 ? '{' : 'x',
    });
    assert.equal(r.status, 400);
  }
  // Same outer proxy hop, same and different client address: both succeed.
  assert.equal((await p.login('ceo', ceoPassword, '203.0.113.66')).status, 200);
  assert.equal((await p.login('aigerim.manager', managerPassword)).status, 200);
});

test('two managers signing in at the same moment both succeed', async (t) => {
  const p = await portal(t);
  const results = await Promise.all([
    p.login('ceo', ceoPassword, '198.51.100.1'),
    p.login('aigerim.manager', managerPassword, '198.51.100.2'),
    p.login('ceo', ceoPassword, '198.51.100.3'),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200, 200],
  );
});

test('successful logins are not counted as attempts', async (t) => {
  const p = await portal(t);
  // The former global window refused the 31st request in 15 minutes.
  for (let i = 0; i < 31; i++) assert.equal((await p.login('ceo', ceoPassword)).status, 200);
});

test('wrong passwords back off only that client address; other managers keep signing in', async (t) => {
  const p = await portal(t);
  const attacker = '203.0.113.7';
  for (let i = 0; i < 5; i++)
    assert.equal((await p.login('ceo', 'Synthetic-wrong-password-' + i, attacker)).status, 401);
  const blocked = await p.login('ceo', ceoPassword, attacker);
  assert.equal(blocked.status, 429);
  assert.equal(JSON.parse(blocked.text).code, 'RATE_LIMITED');
  assert.equal(blocked.headers['retry-after'], '30');
  // A blocked address is refused before any password work, so it cannot extend its own lock.
  assert.equal((await p.login('ceo', 'Synthetic-wrong-password-x', attacker)).status, 429);
  assert.equal((await p.login('ceo', ceoPassword, '198.51.100.20')).status, 200);
  assert.equal((await p.login('aigerim.manager', managerPassword, '198.51.100.21')).status, 200);
  // Backoff doubles per further failure and ends on its own.
  p.advance(30_001);
  assert.equal((await p.login('ceo', 'Synthetic-wrong-password-y', attacker)).status, 401);
  assert.equal((await p.login('ceo', ceoPassword, attacker)).headers['retry-after'], '60');
  p.advance(60_001);
  assert.equal((await p.login('ceo', ceoPassword, attacker)).status, 200);
});

test('distributed guessing of one login backs off that login only, then recovers', async (t) => {
  const p = await portal(t);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await p.login('ceo', 'Synthetic-wrong-password-' + i, `203.0.113.${100 + i}`)).status,
      401,
    );
  const limited = await p.login('ceo', ceoPassword, '198.51.100.30');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) <= 30);
  // Another person's login is untouched.
  assert.equal((await p.login('aigerim.manager', managerPassword, '198.51.100.31')).status, 200);
  p.advance(30_001);
  assert.equal((await p.login(' CEO ', ceoPassword, '198.51.100.30')).status, 200);
});

test('failures older than the window are forgotten', async (t) => {
  const p = await portal(t);
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 4; i++)
      assert.equal(
        (await p.login('ceo', 'Synthetic-wrong-password-' + i, '203.0.113.9')).status,
        401,
      );
    p.advance(15 * 60 * 1000 + 1);
  }
  assert.equal((await p.login('ceo', ceoPassword, '203.0.113.9')).status, 200);
});

test('client address comes from the proxy header only behind a private proxy hop', () => {
  const req = (remoteAddress, xff) => ({
    socket: { remoteAddress },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  });
  assert.equal(staffClientAddress(req('172.18.0.4', '203.0.113.5')), '203.0.113.5');
  assert.equal(staffClientAddress(req('::ffff:172.18.0.4', '203.0.113.5')), '203.0.113.5');
  // The rightmost value is the one the trusted hop observed; earlier ones are client-supplied.
  assert.equal(staffClientAddress(req('172.18.0.4', '1.1.1.1, 203.0.113.5')), '203.0.113.5');
  assert.equal(staffClientAddress(req('172.18.0.4', 'garbage')), '172.18.0.4');
  assert.equal(staffClientAddress(req('172.18.0.4')), '172.18.0.4');
  // A public peer cannot name another client.
  assert.equal(staffClientAddress(req('203.0.113.8', '198.51.100.1')), '203.0.113.8');
  // IPv6 clients share one budget per /64, the smallest block a home or mobile user gets.
  assert.equal(
    staffClientAddress(req('172.18.0.4', '2001:db8:1:2:aaaa::1')),
    staffClientAddress(req('172.18.0.4', '2001:db8:1:2:bbbb::2')),
  );
  assert.notEqual(
    staffClientAddress(req('172.18.0.4', '2001:db8:1:2::1')),
    staffClientAddress(req('172.18.0.4', '2001:db8:1:3::1')),
  );
});
