import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createKitchenServer, allowed } from '../server.mjs';
const id = '00000000-0000-4000-8000-000000000001',
  base = '/edge/v1/fulfillment';
async function fixture(run) {
  let mode = 'ok';
  const seen = [];
  const edge = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (mode === 'redirect') {
      res.writeHead(302, { Location: 'http://example.invalid/' });
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Set-Cookie', 'secret=1');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (mode === 'large') {
      res.end(JSON.stringify({ text: 'x'.repeat(3 * 1024 * 1024) }));
      return;
    }
    res.end(JSON.stringify({ enabled: true }));
  });
  edge.listen(0, '127.0.0.1');
  await once(edge, 'listening');
  const gateway = createKitchenServer({ edgePort: edge.address().port });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  try {
    await run({
      url: `http://127.0.0.1:${gateway.address().port}`,
      seen,
      setMode: (v) => (mode = v),
    });
  } finally {
    gateway.closeAllConnections();
    edge.closeAllConnections();
    await Promise.all([new Promise((r) => gateway.close(r)), new Promise((r) => edge.close(r))]);
  }
}
test('allowlist rejects foreign routes, duplicate/unknown query, invalid cursor, admission and cancel', () => {
  for (const p of [
    '/edge/v1/orders',
    base + '/kitchen?limit=101',
    base + '/display?afterNumber=0',
    base + '/kitchen?stationId=' + id + '&stationId=' + id,
    base + '/config?x=1',
    base + '/kitchen?next=https://bad',
    base + '/../session',
  ])
    assert.equal(allowed('GET', p), false, p);
  assert.equal(allowed('POST', base + '/orders/' + id + '/cancel'), false);
  assert.equal(allowed('GET', base + '/kitchen?stationId=' + id + '&limit=100'), true);
});
test('gateway host/origin bounds, strips cookies/redirects and forwards only staff headers', () =>
  fixture(async (f) => {
    let r = await fetch(f.url + base + '/config', { headers: { Origin: 'https://bad.example' } });
    assert.equal(r.status, 403);
    const badHost = await new Promise((resolve, reject) => {
      const req = request(f.url + base + '/config', { headers: { Host: 'bad.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(badHost, 403);
    assert.equal(f.seen.length, 0);
    r = await fetch(f.url + base + '/stations', {
      headers: {
        Authorization: 'Bearer ' + 'a'.repeat(64),
        'X-Staff-Session-ID': id,
        'X-Terminal-ID': id,
        Cookie: 'private=1',
        'X-Untrusted': 'bad',
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('set-cookie'), null);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    assert.equal(f.seen[0].headers.cookie, undefined);
    assert.equal(f.seen[0].headers['x-untrusted'], undefined);
    assert.equal(f.seen[0].headers['x-terminal-id'], id);
    f.setMode('redirect');
    r = await fetch(f.url + base + '/config');
    assert.equal(r.status, 504);
    assert.equal(f.seen.length, 2);
  }));
test('gateway POST body and streamed response caps fail closed', () =>
  fixture(async (f) => {
    let r = await fetch(f.url + base + '/orders/' + id + '/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(16384) }),
    });
    assert.equal(r.status, 413);
    assert.equal(f.seen.length, 0);
    f.setMode('large');
    r = await fetch(f.url + base + '/config');
    assert.equal(r.status, 502);
    assert.equal((await r.json()).code, 'INVALID_RESPONSE');
  }));
