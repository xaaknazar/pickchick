import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { terminalCookies } from '../../apps/kitchen/terminal-cookie.mjs';
import { createKitchenServer } from '../../apps/kitchen/server.mjs';
const credential = () => ({
  terminalId: randomUUID(),
  branchId: randomUUID(),
  mode: 'display',
  generation: 1,
  terminalKey: randomBytes(32).toString('hex'),
});
const start = async (server) => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
};
const stop = async (server) => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
};
test('terminal cookie binds purpose/mode/path; tampering, duplicate cookie and plaintext keys are rejected', () => {
  const key = randomBytes(32).toString('hex'),
    identity = credential(),
    config = { key, mode: 'display', path: '/kitchen-live/display/' };
  const cookies = terminalCookies(config),
    sealed = cookies.seal(identity),
    cookie = sealed.split(';')[0];
  assert.match(sealed, /HttpOnly; SameSite=Strict; Secure/);
  assert.ok(!sealed.includes(identity.terminalKey));
  assert.deepEqual(cookies.read(cookie), identity);
  assert.deepEqual(terminalCookies(config).read(cookie), identity);
  assert.equal(terminalCookies({ ...config, mode: 'prep' }).read(cookie), null);
  assert.equal(terminalCookies({ ...config, path: '/' }).read(cookie), null);
  assert.equal(
    terminalCookies({ ...config, key: randomBytes(32).toString('hex') }).read(cookie),
    null,
  );
  assert.equal(cookies.read(cookie + '; ' + cookie), null);
  assert.equal(cookies.read(cookie.slice(0, -10) + 'AAAAAAAAAA'), null);
});
test('gateway strips pairing key from browser response and supplies it only from cookie; display has no command route', async () => {
  const identity = credential(),
    calls = [];
  const edge = createServer(async (req, res) => {
    const chunks = [];
    for await (const x of req) chunks.push(x);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    calls.push({ path: req.url, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        req.url.endsWith('/pair')
          ? identity
          : {
              terminalId: identity.terminalId,
              branchId: identity.branchId,
              mode: 'display',
              generation: 1,
              valid: true,
            },
      ),
    );
  });
  await start(edge);
  const gateway = createKitchenServer({
    edgePort: edge.address().port,
    terminalAccess: { key: randomBytes(32).toString('hex'), mode: 'display', secure: false },
  });
  const origin = await start(gateway);
  try {
    const response = await fetch(origin + '/edge/v1/terminals/pair', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'a'.repeat(32) }),
    });
    assert.equal(response.status, 200);
    const safe = await response.json();
    assert.ok(!('terminalKey' in safe));
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal(calls[0].body.mode, 'display');
    const session = await fetch(origin + '/edge/v1/terminals/session', {
      headers: { Cookie: cookie, 'X-Terminal-Key': 'attacker' },
    });
    assert.equal(session.status, 200);
    await session.json();
    assert.equal(calls[1].headers['x-terminal-key'], identity.terminalKey);
    assert.equal(calls[1].headers.cookie, undefined);
    const blocked = await fetch(
      origin + '/edge/v1/fulfillment/orders/' + randomUUID() + '/actions',
      {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    assert.equal(blocked.status, 403);
    assert.equal(calls.length, 2);
    await blocked.body.cancel();
    const missing = await fetch(origin + '/edge/v1/terminals/session');
    assert.equal(missing.status, 401);
    await missing.body.cancel();
    const cross = await fetch(origin + '/edge/v1/terminals/pair', {
      method: 'POST',
      headers: { Origin: 'https://other.invalid', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(cross.status, 403);
    await cross.body.cancel();
    const config = await (
      await fetch(origin + '/config.json', { headers: { Cookie: cookie } })
    ).json();
    assert.equal(config.paired, true);
    assert.ok(!JSON.stringify(config).includes(identity.terminalKey));
  } finally {
    await stop(gateway);
    await stop(edge);
  }
});
