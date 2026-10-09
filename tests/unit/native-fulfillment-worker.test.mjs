import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  validateWorkerConfig,
  fulfillmentRetryDelay,
} from '../../infra/windows/native-fulfillment-worker.mjs';

test('prolonged transport failures retain bounded retries below stop-list freshness window', () => {
  for (let failures = 0; failures < 100; failures++) {
    const wait = fulfillmentRetryDelay(failures, () => 0.999);
    assert.ok(wait >= 1000);
    // Even a failed 5s reverse event followed by a 5s heartbeat attempt leaves
    // room before the 30s stale boundary; true WAN outages still fail closed.
    assert.ok(wait + 2 * 5000 < 30000);
  }
  assert.equal(
    fulfillmentRetryDelay(6, () => 0),
    15000,
  );
  assert.equal(
    fulfillmentRetryDelay(0, () => 0),
    1000,
  );
});

test('commercial Windows worker requires dedicated role, enabled flags and exact local endpoint', () => {
  const branchId = randomUUID(),
    deviceId = randomUUID();
  const config = {
    branchId,
    edgeDeviceId: deviceId,
    fulfillmentTransportEnabled: true,
    edgeFulfillmentEnabled: true,
    databaseUrl: `postgresql://pickchick_fulfillment_sync:${'a'.repeat(64)}@127.0.0.1:55433/pickchick_edge`,
  };
  const validate = (patch = {}, origin = 'http://127.0.0.1:43100') =>
    validateWorkerConfig({ ...config, ...patch }, origin, branchId, deviceId);
  validate();
  for (const patch of [
    { branchId: randomUUID() },
    { edgeDeviceId: randomUUID() },
    { fulfillmentTransportEnabled: false },
    { edgeFulfillmentEnabled: false },
    ...['pickchick_edge_owner', 'pickchick_edge_runtime', 'pickchick_pos_sync'].map((role) => ({
      databaseUrl: config.databaseUrl.replace('pickchick_fulfillment_sync', role),
    })),
    { databaseUrl: config.databaseUrl + '?host=elsewhere' },
    { databaseUrl: config.databaseUrl.replace('127.0.0.1', '192.168.2.157') },
  ])
    assert.throws(() => validate(patch));
  assert.throws(() => validate({}, 'https://example.invalid'));
});

test('remote stop protocol is opt-in and accepts only protocol 2 or 4', async () => {
  const { workerProtocolVersion } =
    await import('../../infra/windows/native-fulfillment-worker.mjs');
  assert.equal(workerProtocolVersion({}), 2);
  assert.equal(workerProtocolVersion({ FULFILLMENT_TRANSPORT_PROTOCOL: '2' }), 2);
  assert.equal(workerProtocolVersion({ FULFILLMENT_TRANSPORT_PROTOCOL: '4' }), 4);
  for (const value of ['3', '', ' 4', 'true', '04'])
    assert.throws(() => workerProtocolVersion({ FULFILLMENT_TRANSPORT_PROTOCOL: value }));
});
