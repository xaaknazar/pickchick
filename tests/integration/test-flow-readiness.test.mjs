import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '@pickchick/api';
import { ReadinessSchema } from '@pickchick/contracts';
import { withSyncDatabases, running, request } from '../helpers/sync.mjs';

const realFeatures = ['phone_auth', 'checkout', 'payments', 'fiscal', 'loyalty'];

test('actual API registers TEST routes only behind its config gate and keeps real operations closed', async () => {
  await withSyncDatabases(async ({ cloud }) => {
    for (const enabled of [false, true]) {
      const api = await running(createApi, { ...cloud.config, testOrderFlowEnabled: enabled });
      try {
        const caps = await (await request(`${api.url}/v1/capabilities`)).json();
        assert.equal(caps.features.test_order_flow, enabled);
        assert.equal(caps.ordering_enabled, false);
        assert.equal(caps.data_mode, 'synthetic');
        assert.ok(realFeatures.every((name) => caps.features[name] === false));
        const catalog = await request(`${api.url}/v1/test/catalog`);
        assert.equal(catalog.status, enabled ? 200 : 404);
        if (enabled) assert.equal((await catalog.json()).synthetic, true);
        assert.equal((await request(`${api.url}/v1/orders`, { method: 'POST' })).status, 404);
      } finally {
        await api.app.close();
      }
    }
  });
});

for (const migration of [
  '004_cloud_test_order_flow.sql',
  '005_cloud_test_modifier_task_titles.sql',
  '006_cloud_test_permanent_access.sql',
  '019_cloud_unpaid_test_orders.sql',
]) {
  test(`enabled TEST readiness fails when ${migration} is missing; disabled API keeps serving its earlier schema`, async () => {
    await withSyncDatabases(async ({ cloud }) => {
      await cloud.pool.query('DELETE FROM schema_migrations WHERE scope=$1 AND version=$2', [
        'cloud',
        migration,
      ]);
      for (const enabled of [true, false]) {
        const api = await running(createApi, { ...cloud.config, testOrderFlowEnabled: enabled });
        try {
          const response = await request(`${api.url}/health/ready`);
          const readiness = ReadinessSchema.parse(await response.json());
          assert.equal(response.status, enabled ? 503 : 200);
          assert.equal(readiness.ready, !enabled);
          assert.equal(readiness.dependencies.database, 'up');
          assert.equal(readiness.dependencies.schema, enabled ? 'down' : 'up');
        } finally {
          await api.app.close();
        }
      }
    });
  });
}

test('TEST readiness verifies actual serving tables as well as migration ledger', async () => {
  await withSyncDatabases(async ({ cloud }) => {
    const api = await running(createApi, { ...cloud.config, testOrderFlowEnabled: true });
    try {
      assert.equal((await request(`${api.url}/health/ready`)).status, 200);
      await cloud.pool.query('DROP TABLE test_kitchen_tasks');
      const response = await request(`${api.url}/health/ready`);
      const readiness = ReadinessSchema.parse(await response.json());
      assert.equal(response.status, 503);
      assert.equal(readiness.dependencies.database, 'up');
      assert.equal(readiness.dependencies.schema, 'down');
    } finally {
      await api.app.close();
    }
  });
});
