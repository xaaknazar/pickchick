import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createBackofficeServer } from '../../apps/backoffice/server.mjs';
import { createStaffAccess, passwordHash } from '../../apps/backoffice/staff-auth.mjs';
const password = 'Synthetic-fixture-password-2026';
const hashed = await passwordHash(password);
const origin = 'https://pickchick.example';
const config = { version: 1, username: 'ceo', origin, token: 'a'.repeat(64), ...hashed };
function call(port, path, { method = 'GET', body, cookie, headers = {} } = {}) {
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
          ...(cookie ? { cookie } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json: () => JSON.parse(text),
          }),
        );
      },
    );
    r.on('error', reject);
    r.end(body && JSON.stringify(body));
  });
}
async function fixture(t) {
  let now = 1000000;
  const seen = [];
  const api = createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ actor: { id: 'synthetic-actor' }, branches: [] }));
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
  const login = (body = { username: 'ceo', password }, cookie) =>
    get('/backoffice/auth/login', { method: 'POST', body, cookie });
  return { get, login, seen, advance: (ms) => (now += ms) };
}
const cookie = (r) => r.headers['set-cookie'][0].split(';')[0];
test('staff login preserves actor token only on server; cookie flags, no browser bearer', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get('/backoffice/auth/session')).json().authenticated, false);
  assert.equal((await f.get('/backoffice/api/v1/admin/catalog/branches')).status, 401);
  const r = await f.login();
  assert.equal(r.status, 200);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=28800'])
    assert.ok(r.headers['set-cookie'][0].includes(flag));
  assert.ok(!r.text.includes(config.token));
  assert.ok(!r.text.includes(password));
  const c = cookie(r);
  assert.equal((await f.get('/backoffice/auth/session', { cookie: c })).json().authenticated, true);
  assert.equal(
    (
      await f.get('/backoffice/api/v1/admin/catalog/branches', {
        cookie: c,
        headers: { authorization: 'Bearer ' + 'b'.repeat(64) },
      })
    ).status,
    200,
  );
  assert.deepEqual(f.seen, [
    { path: '/v1/admin/catalog/branches', auth: 'Bearer ' + config.token },
  ]);
  assert.equal((await f.get('/backoffice/api/v1/customer-orders', { cookie: c })).status, 404);
  assert.equal(
    (
      await f.get('/v1/admin/catalog/branches', {
        headers: { authorization: 'Bearer ' + config.token },
      })
    ).status,
    404,
  );
});
test('unknown login and incorrect password give same generic error', async (t) => {
  const f = await fixture(t);
  const a = await f.login({ username: 'unknown', password }),
    b = await f.login({ username: 'ceo', password: 'wrong' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.json().code, b.json().code);
  assert.equal(a.headers['set-cookie'], undefined);
});
test('logout invalidates replay and re-login rotates session', async (t) => {
  const f = await fixture(t);
  const a = cookie(await f.login()),
    b = cookie(await f.login(undefined, a));
  assert.notEqual(a, b);
  assert.equal(
    (await f.get('/backoffice/auth/session', { cookie: a })).json().authenticated,
    false,
  );
  const r = await f.get('/backoffice/auth/logout', { method: 'POST', cookie: b });
  assert.equal(r.status, 200);
  assert.ok(r.headers['set-cookie'][0].includes('Max-Age=0'));
  assert.equal(
    (await f.get('/backoffice/api/v1/admin/catalog/branches', { cookie: b })).status,
    401,
  );
});
test('idle and absolute expiry are enforced by server', async (t) => {
  const f = await fixture(t);
  let c = cookie(await f.login());
  f.advance(3600001);
  assert.equal(
    (await f.get('/backoffice/api/v1/admin/catalog/branches', { cookie: c })).status,
    401,
  );
  c = cookie(await f.login());
  for (let i = 0; i < 16; i++) {
    f.advance(30 * 60 * 1000);
    const r = await f.get('/backoffice/api/v1/admin/catalog/branches', { cookie: c });
    assert.equal(r.status, i === 15 ? 401 : 200);
  }
});
test('CSRF, hostile hosts, duplicate cookies and bypass paths are rejected', async (t) => {
  const f = await fixture(t);
  const c = cookie(await f.login());
  for (const headers of [
    { origin: 'https://evil.example' },
    { origin: '' },
    { host: 'evil.example' },
    { 'sec-fetch-site': 'cross-site' },
  ]) {
    assert.equal(
      (await f.get('/backoffice/auth/logout', { method: 'POST', cookie: c, headers })).status,
      403,
    );
  }
  assert.equal(
    (await f.get('/backoffice/api/v1/admin/catalog/branches', { cookie: c + '; ' + c })).status,
    401,
  );
  assert.equal(
    (await f.get('/backoffice/api/v1/admin/catalog/branches?bypass=1', { cookie: c })).status,
    404,
  );
  assert.equal(
    (await f.get('/backoffice/auth/login?next=https://evil.example', { method: 'POST' })).status,
    404,
  );
});
test('bounded rate limit and body size; service restart revokes sessions', async (t) => {
  const f = await fixture(t);
  const c = cookie(await f.login());
  assert.equal((await f.login({ username: 'ceo', password: 'a'.repeat(3000) })).status, 413);
  for (let i = 0; i < 28; i++)
    assert.equal((await f.login({ username: [], password })).status, 400);
  assert.equal((await f.login()).status, 429);
  f.advance(15 * 60 * 1000 + 1);
  assert.equal((await f.login()).status, 200);
  const other = await fixture(t);
  assert.equal(
    (await other.get('/backoffice/auth/session', { cookie: c })).json().authenticated,
    false,
  );
});
test('configuration rejects missing or insecure account data', () => {
  assert.throws(() => createStaffAccess({ ...config, origin: 'http://pickchick.example' }));
  assert.throws(() => createStaffAccess({ ...config, username: 'accountant' }));
  assert.throws(() => createStaffAccess({ ...config, token: '' }));
});
