import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createHttpApplication, Resources, RESOURCE } from '@pickchick/platform';
import {
  CLOUD_KITCHEN,
  CLOUD_KITCHEN_OPTIONS,
  TEST_ACTOR_HEADER,
  cloudKitchenModule,
  cloudKitchenOptions,
} from '../../services/api/dist/cloud-kitchen-controller.js';

// ADR-0014 S2: /v1/kitchen/* is off by default (404) and has no production authentication yet.
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
  };
}
async function serve(options, kitchen = fakeKitchen()) {
  const app = await createHttpApplication(
    cloudKitchenModule([
      { provide: RESOURCE, useFactory: () => new Resources(config) },
      { provide: CLOUD_KITCHEN, useValue: kitchen },
      { provide: CLOUD_KITCHEN_OPTIONS, useValue: options },
    ]),
  );
  await app.listen(0, '127.0.0.1');
  return { app, kitchen, url: (await app.getUrl()) + '/v1/kitchen' };
}
const actor = {
  branchId: randomUUID(),
  deviceId: randomUUID(),
  stationIds: [randomUUID()],
  manager: false,
};
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
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
];

test('flags: default off, test auth only with both flags and never in staging', () => {
  assert.deepEqual(cloudKitchenOptions({}, 'test'), { enabled: false, testAuth: false });
  assert.deepEqual(cloudKitchenOptions({ CLOUD_KITCHEN_TEST_AUTH: '1' }, 'local'), {
    enabled: false,
    testAuth: false,
  });
  assert.deepEqual(cloudKitchenOptions({ CLOUD_KITCHEN_API_ENABLED: 'true' }, 'local'), {
    enabled: false,
    testAuth: false,
  });
  assert.deepEqual(cloudKitchenOptions({ CLOUD_KITCHEN_API_ENABLED: '1' }, 'local'), {
    enabled: true,
    testAuth: false,
  });
  const both = { CLOUD_KITCHEN_API_ENABLED: '1', CLOUD_KITCHEN_TEST_AUTH: '1' };
  assert.deepEqual(cloudKitchenOptions(both, 'test'), { enabled: true, testAuth: true });
  assert.deepEqual(cloudKitchenOptions(both, 'staging'), { enabled: true, testAuth: false });
});

test('no staging compose or env example enables the cloud kitchen API or its test hook', async () => {
  const dir = new URL('../../infra/staging/', import.meta.url);
  const files = (await readdir(dir)).filter((name) => /\.(ya?ml|env|example)$/.test(name));
  assert.ok(files.length > 0);
  for (const name of files)
    assert.doesNotMatch(await readFile(new URL(name, dir), 'utf8'), /CLOUD_KITCHEN_/, name);
});

test('flag off: every /v1/kitchen route is 404 and the service is never called', async () => {
  const { app, kitchen, url } = await serve({ enabled: false, testAuth: false });
  try {
    const responses = await Promise.all(routes(url, { [TEST_ACTOR_HEADER]: encode(actor) }));
    assert.deepEqual(
      responses.map((r) => r.status),
      [404, 404, 404, 404, 404],
    );
    assert.deepEqual(kitchen.calls, []);
  } finally {
    await app.close();
  }
});

test('flag on without the test hook: every caller is 401 (no device auth yet)', async () => {
  const { app, kitchen, url } = await serve({ enabled: true, testAuth: false });
  try {
    const responses = await Promise.all(routes(url, { [TEST_ACTOR_HEADER]: encode(actor) }));
    assert.deepEqual(
      responses.map((r) => r.status),
      [401, 401, 401, 401, 401],
    );
    assert.deepEqual(kitchen.calls, []);
  } finally {
    await app.close();
  }
});

test('test hook: actor header validated, queries and Idempotency-Key forwarded, codes mapped', async () => {
  const { app, kitchen, url } = await serve({ enabled: true, testAuth: true });
  try {
    for (const bad of [
      undefined,
      'not base64 !',
      encode({ ...actor, extra: 1 }),
      encode({ ...actor, branchId: 'x' }),
      encode({ ...actor, manager: 'yes' }),
      encode({ ...actor, stationIds: ['x'] }),
      encode(null),
    ]) {
      const headers = bad === undefined ? {} : { [TEST_ACTOR_HEADER]: bad };
      assert.equal((await fetch(url + '/stations', { headers })).status, 401, String(bad));
    }
    assert.deepEqual(kitchen.calls, []);
    const headers = { [TEST_ACTOR_HEADER]: encode(actor) };
    assert.equal((await fetch(url + '/stations', { headers })).status, 200);
    const station = actor.stationIds[0];
    assert.equal(
      (await fetch(`${url}/kitchen?stationId=${station}&limit=20`, { headers })).status,
      200,
    );
    assert.equal((await fetch(`${url}/display?afterNumber=300&limit=x`, { headers })).status, 200);
    const orderId = randomUUID();
    assert.equal((await fetch(`${url}/orders/${orderId}`, { headers })).status, 200);
    const command = { orderId, expectedVersion: 1, action: 'ready' };
    const response = await fetch(url + '/commands', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'key-00000001',
        ...headers,
      },
      body: JSON.stringify(command),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'NOT_READY');
    assert.deepEqual(kitchen.calls, [
      ['listStations', actor],
      ['listKitchen', actor, { stationId: station, limit: 20 }],
      ['readDisplay', actor, { afterNumber: 300, limit: 'x' }],
      ['readOrder', actor, orderId, {}],
      ['act', actor, 'key-00000001', command],
    ]);
  } finally {
    await app.close();
  }
});
