import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { FaultProxy, seededRandom, FAULT_MODES } from './fault-proxy.mjs';

/** Upstream that records every request body in arrival order. */
async function upstream(handler = () => ({ status: 200, body: { ok: true } })) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, body, headers: req.headers });
      const reply = handler(body, seen.length);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
async function withProxy(run, handler) {
  const up = await upstream(handler);
  const proxy = new FaultProxy({ name: 'test', target: up.url, seed: 7 });
  await proxy.start();
  try {
    await run(proxy, up);
  } finally {
    await proxy.close();
    await up.close();
  }
}
const post = (url, body, timeout = 2000) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-id': 'synthetic' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

test('seeded random sequence is reproducible and in [0,1)', () => {
  const a = seededRandom(42),
    b = seededRandom(42),
    c = seededRandom(43);
  const first = Array.from({ length: 50 }, a);
  assert.deepEqual(Array.from({ length: 50 }, b), first);
  assert.notDeepEqual(Array.from({ length: 50 }, c), first);
  assert.ok(first.every((v) => v >= 0 && v < 1));
});

test('up mode forwards method, path, headers and body and returns the upstream reply', () =>
  withProxy(
    async (proxy, up) => {
      const response = await post(`${proxy.url}/internal/v1/edge/x?q=1`, { a: 1 });
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), { echoed: '{"a":1}' });
      assert.equal(up.seen.length, 1);
      assert.equal(up.seen[0].url, '/internal/v1/edge/x?q=1');
      assert.equal(up.seen[0].headers['x-device-id'], 'synthetic');
      assert.equal(proxy.stats().forwarded, 1);
    },
    (body) => ({ status: 201, body: { echoed: body } }),
  ));

test('down mode resets connections and never reaches upstream; up restores service', () =>
  withProxy(async (proxy, up) => {
    proxy.set('down');
    await assert.rejects(post(proxy.url + '/a', {}));
    assert.equal(up.seen.length, 0);
    assert.equal(proxy.stats().refused, 1);
    proxy.set('up');
    assert.equal((await post(proxy.url + '/a', {})).status, 200);
    assert.equal(up.seen.length, 1);
  }));

test('blackhole holds requests until the client gives up; nothing reaches upstream', () =>
  withProxy(async (proxy, up) => {
    proxy.set('blackhole');
    await assert.rejects(post(proxy.url + '/a', {}, 150));
    await delay(50);
    assert.equal(up.seen.length, 0);
    assert.equal(proxy.stats().blackholed, 1);
    proxy.set('up');
    assert.equal((await post(proxy.url + '/a', {})).status, 200);
  }));

test('chaos dropResponse commits upstream but loses the answer (lost ACK)', () =>
  withProxy(async (proxy, up) => {
    proxy.set('chaos', { dropResponse: 1 });
    await assert.rejects(post(proxy.url + '/a', { n: 1 }));
    assert.equal(up.seen.length, 1);
    assert.equal(proxy.stats().dropped_response, 1);
  }));

test('chaos duplicate delivers the same bytes twice and answers once', () =>
  withProxy(async (proxy, up) => {
    proxy.set('chaos', { duplicate: 1 });
    const response = await post(proxy.url + '/a', { n: 2 });
    assert.equal(response.status, 200);
    await delay(100);
    assert.equal(up.seen.length, 2);
    assert.equal(up.seen[0].body, up.seen[1].body);
    assert.equal(proxy.stats().duplicated, 1);
  }));

test('chaos late delivers after the client already timed out', () =>
  withProxy(async (proxy, up) => {
    proxy.set('chaos', { late: 1, lateMs: 250 });
    await assert.rejects(post(proxy.url + '/a', { n: 3 }, 100));
    assert.equal(up.seen.length, 0);
    await delay(400);
    assert.equal(up.seen.length, 1);
    assert.equal(proxy.stats().late, 1);
  }));

test('chaos reorder releases a window of requests in reverse arrival order', () =>
  withProxy(async (proxy, up) => {
    proxy.set('chaos', { reorder: 1, reorderMs: 150 });
    const first = post(proxy.url + '/first', {});
    await delay(30);
    const second = post(proxy.url + '/second', {});
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    assert.deepEqual(
      up.seen.map((r) => r.url),
      ['/second', '/first'],
    );
    assert.equal(proxy.stats().reordered, 2);
  }));

test('upstream unavailable looks like a network failure, not an HTTP answer', async () => {
  const up = await upstream();
  const target = up.url;
  await up.close();
  const proxy = new FaultProxy({ name: 'test', target, seed: 1 });
  await proxy.start();
  try {
    await assert.rejects(post(proxy.url + '/a', {}));
    assert.equal(proxy.stats().upstream_errors, 1);
  } finally {
    await proxy.close();
  }
});

test('invalid modes and probabilities are refused', async () => {
  const proxy = new FaultProxy({ name: 'test', target: 'http://127.0.0.1:9', seed: 1 });
  assert.deepEqual(FAULT_MODES, ['up', 'down', 'blackhole', 'chaos']);
  assert.throws(() => proxy.set('sideways'));
  assert.throws(() => proxy.set('chaos', { duplicate: 2 }));
  assert.throws(() => proxy.set('chaos', { unknown: 0.1 }));
  assert.throws(() => new FaultProxy({ name: 'x', target: 'http://203.0.113.5:80' }));
});
