import test from 'node:test';
import assert from 'node:assert/strict';
import { startDevicePresence } from '../../apps/kiosk/src/device-presence.ts';
const raw = JSON.stringify({
  deviceId: '00000000-0000-4000-8000-000000000001',
  key: 'a'.repeat(64),
});
const tick = () => new Promise((r) => globalThis.setImmediate(r));
test('presence cannot overlap, follows current state, recovers from failure and stops', async () => {
  const sent = [];
  let resolve,
    state = 'active',
    fail = false;
  const worker = startDevicePresence({
    readDevice: async () => raw,
    origin: 'https://example.test',
    appVersion: 'test',
    snapshot: () => ({ state, issue: 'none', menuVersion: 1 }),
    fetcher: async (url, req) => {
      sent.push({ url, req });
      if (fail) throw new Error('Offline');
      await new Promise((r) => {
        resolve = r;
      });
      return new Response('{}');
    },
  });
  try {
    await tick();
    await worker.send();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://example.test/v1/kiosk-checkout/device-presence');
    assert.equal(sent[0].req.redirect, 'error');
    assert.equal(sent[0].req.headers['X-Kiosk-Key'], 'a'.repeat(64));
    resolve();
    await tick();
    state = 'background';
    fail = true;
    await worker.send();
    assert.equal(JSON.parse(sent[1].req.body).state, 'background');
    state = 'active';
    fail = false;
    const retry = worker.send();
    await tick();
    resolve();
    await retry;
    worker.stop();
    await worker.send();
    assert.equal(sent.length, 3);
    assert.ok(sent.every((s) => !s.url.includes('/sessions')));
  } finally {
    worker.stop();
    resolve?.();
  }
});
test('missing credentials produce no request; rejected origins cannot receive device key', async () => {
  for (const data of [null, '{}', 'not-json']) {
    let n = 0;
    const worker = startDevicePresence({
      readDevice: async () => data,
      origin: 'https://example.test',
      appVersion: 'test',
      snapshot: () => ({ state: 'active', issue: 'none', menuVersion: null }),
      fetcher: async () => {
        n++;
      },
    });
    await tick();
    worker.stop();
    assert.equal(n, 0);
  }
  const io = {
    readDevice: async () => raw,
    appVersion: 'test',
    snapshot: () => ({ state: 'active', issue: 'none', menuVersion: null }),
  };
  for (const origin of [
    'http://example.test',
    'https://example.test/path',
    'https://user:password@example.test',
  ])
    assert.throws(() => startDevicePresence({ ...io, origin }));
});
