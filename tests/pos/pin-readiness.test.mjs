import test from 'node:test';
import assert from 'node:assert/strict';
import { requestPinCredential } from '../../apps/pos/src/v2/pin-login.js';
const ready = () => Response.json({ ready: true });
const noPause = async () => {};
test('eventual readiness sends exactly one PIN request after local probes', async () => {
  const calls = [];
  const credential = await requestPinCredential('0000', 'synthetic-terminal', {
    pause: noPause,
    fetchImpl: async (path, options) => {
      calls.push([path, options]);
      if (calls.length === 1) throw new TypeError('network');
      if (calls.length === 2) return new Response('', { status: 503 });
      if (path === '/health/ready') return ready();
      return Response.json({ role: 'cashier' });
    },
  });
  assert.equal(credential.role, 'cashier');
  assert.equal(calls.filter(([path]) => path.includes('/staff/pin')).length, 1);
  assert.ok(calls.slice(0, 3).every(([, options]) => !options.body));
});
for (const failure of ['not-ready', '503', 'network', '401', '429']) {
  test(`PIN ${failure} has correct actionable message without replay`, async () => {
    let writes = 0;
    await assert.rejects(
      requestPinCredential('0000', 'synthetic-terminal', {
        pause: noPause,
        fetchImpl: async (path) => {
          if (path === '/health/ready')
            return failure === 'not-ready' ? Response.json({ ready: false }) : ready();
          writes++;
          if (failure === 'network') throw new TypeError('network');
          return new Response('', { status: Number(failure) });
        },
      }),
      failure === '401'
        ? /Неверный PIN/
        : failure === '429'
          ? /Подождите минуту/
          : /Локальный сервер кассы ещё не готов/,
    );
    assert.equal(writes, failure === 'not-ready' ? 0 : 1);
  });
}
test('native readiness proxy allows only fixed local GET', async () => {
  const { createProtocolHandler, APP_URL } = await import('../../apps/pos-desktop/protocol.mjs');
  const calls = [];
  const handler = createProtocolHandler({
    assetDir: new URL('../../apps/pos/src/', import.meta.url),
    fetchImpl: async (url) => {
      calls.push(String(url));
      return ready();
    },
  });
  assert.equal(
    (await handler(new globalThis.Request(new URL('/health/ready', APP_URL)))).status,
    200,
  );
  for (const [path, method] of [
    ['/health/live', 'GET'],
    ['/health/ready', 'POST'],
    ['/health/ready?port=22', 'GET'],
  ]) {
    assert.ok(
      (await handler(new globalThis.Request(new URL(path, APP_URL), { method }))).status >= 400,
    );
  }
  assert.deepEqual(calls, ['http://127.0.0.1:3101/health/ready']);
});
test('web readiness proxy uses configured loopback Edge and rejects POST', async () => {
  const { createServer } = await import('node:http');
  const { createPosServer } = await import('../../apps/pos/server.mjs');
  const calls = [];
  const edge = createServer((req, res) => {
    calls.push([req.method, req.url]);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ready: true }));
  });
  await new Promise((resolve) => edge.listen(0, '127.0.0.1', resolve));
  const pos = createPosServer({ edgePort: edge.address().port });
  await new Promise((resolve) => pos.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${pos.address().port}`;
  try {
    assert.equal((await fetch(`${origin}/health/ready`)).status, 200);
    assert.equal((await fetch(`${origin}/health/ready`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${origin}/health/ready?port=22`)).status, 404);
    assert.deepEqual(calls, [['GET', '/health/ready']]);
  } finally {
    await Promise.all([
      new Promise((resolve) => pos.close(resolve)),
      new Promise((resolve) => edge.close(resolve)),
    ]);
  }
});
