import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createHttpApplication, Resources, RESOURCE } from '@pickchick/platform';
import {
  CLOUD_KITCHEN,
  CLOUD_KITCHEN_OPTIONS,
  CLOUD_KITCHEN_SCREENS,
  cloudKitchenModule,
  cloudKitchenOptions,
} from '../../services/api/dist/cloud-kitchen-controller.js';

// ADR-0014 S2/S4: /v1/kitchen/* is off by default (404); callers are paired kitchen screens of
// cloud 056 (Bearer screen key). No test hook and no device registry.
const config = {
  service: 'api',
  environment: 'test',
  port: 0,
  databaseUrl: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
};
function fakeKitchen() {
  const calls = [];
  const record =
    (name, result) =>
    async (...args) => {
      calls.push([name, ...args]);
      if (result instanceof Error) throw result;
      return result;
    };
  const notReady = Object.assign(new Error('NOT_READY'), { code: 'NOT_READY' });
  return {
    calls,
    listStations: record('listStations', { items: [] }),
    listKitchen: record('listKitchen', { items: [], nextAfterOrderId: null }),
    readDisplay: record('readDisplay', { items: [], nextAfterNumber: null }),
    readOrder: record('readOrder', { orderId: 'x' }),
    act: record('act', notReady),
    admitPendingPaid: record('admitPendingPaid', { admitted: [] }),
  };
}
const branchId = randomUUID(),
  station = randomUUID();
const screenFor = (role) => ({
  screenId: randomUUID(),
  branchId,
  role,
  generation: 1,
  actor: {
    branchId,
    deviceId: randomUUID(),
    stationIds: role === 'display' ? [] : [station],
    manager: false,
  },
});
const KEYS = {
  ['pcks_' + 'a'.repeat(43)]: screenFor('prep'),
  ['pcks_' + 'd'.repeat(43)]: screenFor('display'),
};
function fakeScreens() {
  const calls = [];
  return {
    calls,
    async authenticate(key, options) {
      calls.push(['authenticate', key, options]);
      const screen = KEYS[key];
      if (!screen) throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' });
      return screen;
    },
    async exchange(input) {
      calls.push(['exchange', input]);
      if (input?.pairingCode !== 'ABCD-EFGHJK')
        throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' });
      return { screenKey: 'pcks_' + 'a'.repeat(43), screen: { screenId: 'x' } };
    },
  };
}
async function serve(options, kitchen = fakeKitchen(), screens = fakeScreens()) {
  const app = await createHttpApplication(
    cloudKitchenModule([
      { provide: RESOURCE, useFactory: () => new Resources(config) },
      { provide: CLOUD_KITCHEN, useValue: kitchen },
      { provide: CLOUD_KITCHEN_SCREENS, useValue: screens },
      { provide: CLOUD_KITCHEN_OPTIONS, useValue: options },
    ]),
  );
  await app.listen(0, '127.0.0.1');
  return { app, kitchen, screens, url: (await app.getUrl()) + '/v1/kitchen' };
}
const bearer = (key) => ({ Authorization: 'Bearer ' + key });
const prep = bearer('pcks_' + 'a'.repeat(43)),
  display = bearer('pcks_' + 'd'.repeat(43));
const routes = (url, headers = {}) => [
  fetch(url + '/stations', { headers }),
  fetch(url + '/kitchen?limit=5', { headers }),
  fetch(url + '/display', { headers }),
  fetch(url + '/orders/' + randomUUID(), { headers }),
  fetch(url + '/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-00000001', ...headers },
    body: '{}',
  }),
  fetch(url + '/pairing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ pairingCode: 'ABCD-EFGHJK' }),
  }),
];

test('flags: default off, exactly 1 turns the API on, internal-only unless explicitly public', () => {
  const off = { enabled: false, internalOnly: true };
  assert.deepEqual(cloudKitchenOptions({}), off);
  assert.deepEqual(cloudKitchenOptions({ CLOUD_KITCHEN_API_ENABLED: 'true' }), off);
  assert.deepEqual(cloudKitchenOptions({ CLOUD_KITCHEN_TEST_AUTH: '1' }), off);
  assert.deepEqual(cloudKitchenOptions({ CLOUD_KITCHEN_API_ENABLED: '1' }), {
    enabled: true,
    internalOnly: true,
  });
  assert.deepEqual(
    cloudKitchenOptions({ CLOUD_KITCHEN_API_ENABLED: '1', CLOUD_KITCHEN_PUBLIC: 'true' }),
    { enabled: true, internalOnly: true },
  );
  assert.deepEqual(
    cloudKitchenOptions({ CLOUD_KITCHEN_API_ENABLED: '1', CLOUD_KITCHEN_PUBLIC: '1' }),
    {
      enabled: true,
      internalOnly: false,
    },
  );
});

test('internal-only: a request relayed by the public gateway is 404 before authentication', async () => {
  const { app, kitchen, screens, url } = await serve({ enabled: true, internalOnly: true });
  try {
    for (const header of ['X-Forwarded-For', 'Forwarded', 'X-Real-IP', 'X-Forwarded-Host']) {
      const headers = {
        ...prep,
        [header]: header === 'Forwarded' ? 'for=203.0.113.9' : '203.0.113.9',
      };
      const statuses = (await Promise.all(routes(url, headers))).map((r) => r.status);
      assert.deepEqual(statuses, [404, 404, 404, 404, 404, 404], header);
    }
    assert.deepEqual(kitchen.calls, []);
    assert.deepEqual(screens.calls, []);
    // The portal server calls directly on the private network: no forwarding headers.
    assert.equal((await fetch(url + '/stations', { headers: prep })).status, 200);
  } finally {
    await app.close();
  }
});

test('no staging compose or env example enables the cloud kitchen API', async () => {
  const dir = new URL('../../infra/staging/', import.meta.url);
  const files = (await readdir(dir)).filter((name) => /\.(ya?ml|env|example)$/.test(name));
  assert.ok(files.length > 0);
  for (const name of files)
    assert.doesNotMatch(await readFile(new URL(name, dir), 'utf8'), /CLOUD_KITCHEN_/, name);
});

test('flag off: every /v1/kitchen route is 404 and no service is called', async () => {
  const { app, kitchen, screens, url } = await serve({ enabled: false });
  try {
    const responses = await Promise.all(routes(url, prep));
    assert.deepEqual(
      responses.map((r) => r.status),
      [404, 404, 404, 404, 404, 404],
    );
    assert.deepEqual(kitchen.calls, []);
    assert.deepEqual(screens.calls, []);
  } finally {
    await app.close();
  }
});

test('screen key required: missing, malformed, unknown keys are 401 before any service call', async () => {
  const { app, kitchen, url } = await serve({ enabled: true });
  try {
    for (const headers of [
      {},
      { Authorization: 'Basic abc' },
      bearer('pcks_unknown'),
      bearer('pcks_' + 'b'.repeat(43)),
      { 'X-PickChick-Test-Kitchen-Actor': 'e30' },
    ]) {
      const responses = await Promise.all(routes(url, headers).slice(0, 5));
      assert.deepEqual(
        responses.map((r) => r.status),
        [401, 401, 401, 401, 401],
        JSON.stringify(headers),
      );
    }
    assert.deepEqual(kitchen.calls, []);
  } finally {
    await app.close();
  }
});

test('prep screen: actor from the key, feed poll is a heartbeat and admits pending orders', async () => {
  const { app, kitchen, screens, url } = await serve({ enabled: true });
  try {
    const actor = KEYS['pcks_' + 'a'.repeat(43)].actor;
    assert.equal((await fetch(url + '/stations', { headers: prep })).status, 200);
    assert.equal(
      (await fetch(`${url}/kitchen?stationId=${station}&limit=20`, { headers: prep })).status,
      200,
    );
    assert.equal(
      (await fetch(`${url}/display?afterNumber=300&limit=x`, { headers: prep })).status,
      200,
    );
    const orderId = randomUUID();
    assert.equal((await fetch(`${url}/orders/${orderId}`, { headers: prep })).status, 200);
    const command = { orderId, expectedVersion: 1, action: 'ready' };
    const response = await fetch(url + '/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-00000001', ...prep },
      body: JSON.stringify(command),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'NOT_READY');
    const me = await (await fetch(url + '/me', { headers: prep })).json();
    assert.equal(me.role, 'prep');
    assert.deepEqual(me.stationIds, [station]);
    assert.deepEqual(kitchen.calls, [
      ['listStations', actor],
      ['admitPendingPaid', branchId],
      ['listKitchen', actor, { stationId: station, limit: 20 }],
      ['readDisplay', actor, { afterNumber: 300, limit: 'x' }],
      ['readOrder', actor, orderId, {}],
      ['act', actor, 'key-00000001', command],
    ]);
    // Only the feed poll writes the station heartbeat.
    assert.deepEqual(
      screens.calls.map(([, , options]) => options.heartbeat),
      [false, true, false, false, false, false],
    );
  } finally {
    await app.close();
  }
});

test('display screen reads the display only; pairing answers one 401 for every failure', async () => {
  const { app, kitchen, url } = await serve({ enabled: true });
  try {
    const statuses = (await Promise.all(routes(url, display).slice(0, 5))).map((r) => r.status);
    assert.deepEqual(statuses, [200, 403, 200, 403, 403]);
    assert.deepEqual(kitchen.calls.map(([name]) => name).sort(), ['listStations', 'readDisplay']);
    const pair = (body) =>
      fetch(url + '/pairing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const ok = await pair({ pairingCode: 'ABCD-EFGHJK' });
    assert.equal(ok.status, 200);
    assert.match((await ok.json()).screenKey, /^pcks_/);
    for (const body of [{ pairingCode: 'ABCD-XXXXXX' }, {}, { pairingCode: 1 }]) {
      const failed = await pair(body);
      assert.equal(failed.status, 401);
      assert.equal((await failed.json()).code, 'UNAUTHORIZED');
    }
  } finally {
    await app.close();
  }
});
