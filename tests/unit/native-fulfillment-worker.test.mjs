import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validateWorkerConfig } from '../../infra/windows/native-fulfillment-worker.mjs';

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
