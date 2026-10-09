import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { CatalogPublicationListener } from '../../services/api/dist/catalog-publication-listener.js';
import { withSyncDatabases } from '../helpers/sync.mjs';

test('one listener wakes all waiting readers after commit; rollback does not signal publication', () =>
  withSyncDatabases(async ({ cloud, branch }) => {
    const listener = new CatalogPublicationListener({ pool: cloud.pool });
    await listener.onModuleInit();
    const client = await cloud.pool.connect();
    try {
      const revision = listener.revision;
      let woke = 0;
      const readers = Array.from({ length: 20 }, () => listener.wait(2500).then(() => woke++));
      await client.query('BEGIN');
      await client.query("SELECT pg_notify('pickchick_catalog_published',$1)", [branch]);
      await delay(30);
      assert.equal(woke, 0);
      await client.query('ROLLBACK');
      await delay(30);
      assert.equal(listener.revision, revision);
      const started = Date.now();
      await client.query("SELECT pg_notify('pickchick_catalog_published',$1)", [branch]);
      await Promise.all(readers);
      assert.equal(woke, 20);
      assert.ok(Date.now() - started < 1000);
      assert.equal(listener.revision, revision + 1);
    } finally {
      client.release();
      await listener.onModuleDestroy();
    }
  }));
