import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@pickchick/platform';
import { PosSyncError, receivePosSales } from '../dist/index.js';

// Cloud receiver of the posSales stream (contracts 5.6, CC-4) without PostgreSQL; the database
// behaviour is in sales-cloud-integration.test.mjs.
const env = {
  APP_ENV: 'test',
  CLOUD_DATABASE_URL: 'postgresql://127.0.0.1/pickchick_cloud',
  EDGE_DATABASE_URL: 'postgresql://127.0.0.1/pickchick_edge',
  REDIS_URL: 'redis://127.0.0.1',
  EDGE_BRANCH_ID: randomUUID(),
};

test('CLOUD_POS_SALES_SYNC_ENABLED is off by default, cloud only and needs the POS order sync', () => {
  // Off = the configuration object is exactly what it was before CC-4.
  for (const service of ['api', 'edge']) {
    const before = loadConfig(service, env);
    assert.equal('posSalesSyncEnabled' in before, false);
    assert.deepEqual(
      loadConfig(service, { ...env, CLOUD_POS_SALES_SYNC_ENABLED: 'false' }),
      before,
    );
  }
  const posSync = { ...env, CLOUD_POS_ORDER_SYNC_ENABLED: 'true' };
  assert.deepEqual(loadConfig('api', { ...posSync, CLOUD_POS_SALES_SYNC_ENABLED: 'false' }), {
    ...loadConfig('api', posSync),
  });
  assert.equal(
    loadConfig('api', { ...posSync, CLOUD_POS_SALES_SYNC_ENABLED: 'true' }).posSalesSyncEnabled,
    true,
  );
  for (const invalid of [
    ['api', { ...env, CLOUD_POS_SALES_SYNC_ENABLED: 'true' }],
    ['api', { ...posSync, CLOUD_POS_SALES_SYNC_ENABLED: 'yes' }],
    ['api', { ...posSync, CLOUD_POS_SALES_SYNC_ENABLED: '' }],
    ['edge', { ...env, CLOUD_POS_SALES_SYNC_ENABLED: 'true' }],
  ])
    assert.throws(() => loadConfig(...invalid), /CLOUD_POS_SALES_SYNC_ENABLED/);
});

test('without schema073 the receiver answers NOT_FOUND before it reads the batch or the device', async () => {
  const seen = [];
  const client = {
    query: async (sql) => {
      seen.push(String(sql));
      return /AS ready/.test(String(sql))
        ? { rows: [{ ready: false }], rowCount: 1 }
        : { rows: [] };
    },
    release: () => undefined,
    on: () => undefined,
    removeListener: () => undefined,
  };
  const pool = { connect: async () => client };
  for (const body of [{ events: [] }, { malformed: true }, null])
    await assert.rejects(
      receivePosSales(pool, { deviceId: randomUUID(), token: 'a'.repeat(64) }, body),
      (error) => error instanceof PosSyncError && error.code === 'NOT_FOUND',
    );
  // Only the capability query ran: no device lookup, no binding lock, no inbox read.
  assert.ok(seen.every((sql) => /^(?:BEGIN|COMMIT|ROLLBACK)$/.test(sql) || /AS ready/.test(sql)));
  assert.ok(seen.some((sql) => /to_regclass\('cloud_pos_sale_inbox'\)/.test(sql)));
});
