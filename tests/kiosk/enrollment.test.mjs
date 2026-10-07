import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { enrollDevice } from '../../apps/kiosk/src/enrollment.ts';
import {
  exchangeKioskEnrollment,
  commercialKioskRequest,
} from '../../apps/kiosk/src/commercial-api.ts';

function setup() {
  const device = { deviceId: randomUUID(), key: 'a'.repeat(64) };
  const state = { marker: null, saved: null, requests: [], checks: 0, occupied: false };
  const io = {
    occupied: async () => state.occupied,
    readRequest: async () => state.marker,
    writeRequest: async (v) => {
      state.marker = v;
    },
    removeRequest: async () => {
      state.marker = null;
    },
    uuid: randomUUID,
    exchange: async (input) => {
      state.requests.push(input);
      return device;
    },
    check: async (d) => {
      assert.deepEqual(d, device);
      state.checks++;
      return { valid: true };
    },
    save: async (d) => {
      state.saved = d;
    },
  };
  return { state, io, device };
}
const login = 'example-kiosk';
const password = 'Example-Only-2026';

test('lost exchange response retries the same durable activation and never persists the password', async () => {
  const { io, state, device } = setup();
  let first = true;
  io.exchange = async (input) => {
    state.requests.push(input);
    if (first) {
      first = false;
      throw new Error('Lost ACK');
    }
    return device;
  };
  await assert.rejects(enrollDevice(login, password, io));
  assert.equal(state.saved, null);
  assert.equal(state.marker.includes(password), false);
  await enrollDevice(login, password, io);
  assert.equal(state.requests[0].requestId, state.requests[1].requestId);
  assert.deepEqual(state.saved, device);
  assert.equal(state.marker, null);
});

test('failed final device validation never saves credentials or discards the retry marker', async () => {
  const { io, state } = setup();
  io.check = async () => ({ valid: false });
  await assert.rejects(enrollDevice(login, password, io));
  assert.equal(state.saved, null);
  assert.ok(state.marker);
});

test('occupied kiosk cannot be replaced by short credentials', async () => {
  const { io, state } = setup();
  state.occupied = true;
  await assert.rejects(enrollDevice(login, password, io));
  assert.equal(state.requests.length, 0);
  assert.equal(state.marker, null);
});

test('legacy UUID/key enrollment bypasses exchange and still validates before saving', async () => {
  const { io, state, device } = setup();
  await enrollDevice(device.deviceId, device.key, io);
  assert.equal(state.requests.length, 0);
  assert.equal(state.checks, 1);
  assert.deepEqual(state.saved, device);
});

test('malformed exchanged credentials cannot reach validation or storage', async () => {
  const { io, state } = setup();
  io.exchange = async () => ({ deviceId: login, key: password });
  await assert.rejects(enrollDevice(login, password, io));
  assert.equal(state.checks, 0);
  assert.equal(state.saved, null);
});

test('cleanup failure after durable save does not misreport enrollment failure', async () => {
  const { io, state, device } = setup();
  io.removeRequest = async () => {
    throw new Error('Temporary keychain failure');
  };
  await enrollDevice(login, password, io);
  assert.deepEqual(state.saved, device);
});

test('operator exchange uses only its fixed HTTPS API path and keeps guest API credential format strict', async () => {
  let calls = 0;
  const input = { login, password, requestId: randomUUID() };
  const fetcher = async (url, init) => {
    calls++;
    assert.ok(url.startsWith('https://'));
    assert.ok(url.endsWith('/v1/kiosk-checkout/enrollment/exchange'));
    assert.equal(url.includes(password), false);
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(JSON.parse(init.body), input);
    assert.equal(init.headers['X-Kiosk-Key'], undefined);
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  };
  await exchangeKioskEnrollment(input, fetcher);
  await assert.rejects(
    commercialKioskRequest('/enrollment/exchange', undefined, input, undefined, fetcher),
  );
  await assert.rejects(
    commercialKioskRequest('/sessions', undefined, {}, undefined, fetcher, {
      deviceId: login,
      key: password,
    }),
  );
  assert.equal(calls, 1);
});
