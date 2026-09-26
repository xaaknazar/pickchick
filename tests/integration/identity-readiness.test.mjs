import assert from 'node:assert/strict';
import test from 'node:test';
import { Resources } from '@pickchick/platform';
import { withSyncDatabases } from '../helpers/sync.mjs';

test('enabled identity refuses an incomplete receipt-limit migration while the disabled TEST API stays ready', async () => {
  await withSyncDatabases(async ({ cloud }) => {
    const enabled = new Resources({ ...cloud.config, customerAuthEnabled: true });
    const disabled = new Resources({ ...cloud.config, customerAuthEnabled: false });
    try {
      assert.equal((await enabled.readiness()).ready, true);
      // Only this disposable schema is damaged; no production migration is reversed.
      await cloud.pool.query(
        'ALTER TABLE identity_otp_challenges DROP COLUMN receipt_failed_attempts',
      );
      const missingColumn = await enabled.readiness();
      assert.equal(missingColumn.dependencies.database, 'up');
      assert.equal(missingColumn.dependencies.schema, 'down');
      assert.equal(missingColumn.ready, false);
      assert.equal((await disabled.readiness()).ready, true);
      await cloud.pool.query(
        'ALTER TABLE identity_otp_challenges ADD COLUMN receipt_failed_attempts integer NOT NULL DEFAULT 0',
      );
      await cloud.pool.query('DELETE FROM schema_migrations WHERE scope=$1 AND version=$2', [
        'cloud',
        '013_cloud_identity_receipt_limits.sql',
      ]);
      assert.equal((await enabled.readiness()).ready, false);
      assert.equal((await disabled.readiness()).ready, true);
    } finally {
      await enabled.onApplicationShutdown();
      await disabled.onApplicationShutdown();
    }
  });
});

test('enabled auth requires channel columns and migration 022; disabled staging remains compatible', async () => {
  await withSyncDatabases(async ({ cloud }) => {
    const enabled = new Resources({ ...cloud.config, customerAuthEnabled: true });
    const disabled = new Resources({ ...cloud.config, customerAuthEnabled: false });
    try {
      await cloud.pool.query('ALTER TABLE identity_otp_challenges DROP COLUMN delivery_channel');
      assert.equal((await enabled.readiness()).ready, false);
      assert.equal((await disabled.readiness()).ready, true);
    } finally {
      await enabled.onApplicationShutdown();
      await disabled.onApplicationShutdown();
    }
  });
});

test('enabled auth requires delivery consent column and migration 023 before accepting traffic', async () => {
  await withSyncDatabases(async ({ cloud }) => {
    const enabled = new Resources({ ...cloud.config, customerAuthEnabled: true });
    const disabled = new Resources({ ...cloud.config, customerAuthEnabled: false });
    try {
      assert.equal((await enabled.readiness()).ready, true);
      await cloud.pool.query(
        'ALTER TABLE identity_otp_challenges DROP COLUMN delivery_consent_version',
      );
      assert.equal((await enabled.readiness()).ready, false);
      assert.equal((await disabled.readiness()).ready, true);
      await cloud.pool.query(
        'ALTER TABLE identity_otp_challenges ADD COLUMN delivery_consent_version text',
      );
      await cloud.pool.query('DELETE FROM schema_migrations WHERE scope=$1 AND version=$2', [
        'cloud',
        '023_cloud_otp_delivery_consent.sql',
      ]);
      assert.equal((await enabled.readiness()).ready, false);
    } finally {
      await enabled.onApplicationShutdown();
      await disabled.onApplicationShutdown();
    }
  });
});
