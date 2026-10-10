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

test('a silent LISTEN session is detected by the heartbeat, reconnected and waiters re-read', () =>
  withSyncDatabases(async ({ cloud, branch }) => {
    const listener = new CatalogPublicationListener({ pool: cloud.pool });
    listener.heartbeatMs = 50;
    listener.heartbeatTimeoutMs = 100;
    listener.retryMs = 50;
    await listener.onModuleInit();
    try {
      const silent = listener.client;
      assert.ok(silent);
      const revision = listener.revision;
      // Simulate a half-open TCP session: the server never answers the heartbeat.
      silent.query = () => new Promise(() => {});
      const woken = listener.wait(5000).then(() => Date.now());
      const started = Date.now();
      assert.ok((await woken) - started < 2000, 'reconnect wakes waiters');
      assert.equal(listener.revision, revision + 1);
      assert.notEqual(listener.client, silent);
      // The new session receives publications again.
      const next = listener.wait(5000).then(() => Date.now());
      const sent = Date.now();
      await cloud.pool.query("SELECT pg_notify('pickchick_catalog_published',$1)", [branch]);
      assert.ok((await next) - sent < 1000);
      assert.equal(listener.revision, revision + 2);
    } finally {
      await listener.onModuleDestroy();
    }
  }));

test('a terminated LISTEN backend reconnects and bumps the revision', () =>
  withSyncDatabases(async ({ cloud }) => {
    const listener = new CatalogPublicationListener({ pool: cloud.pool });
    listener.retryMs = 50;
    await listener.onModuleInit();
    try {
      const pid = (await listener.client.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const revision = listener.revision;
      const woken = listener.wait(5000);
      await cloud.pool.query('SELECT pg_terminate_backend($1)', [pid]);
      await woken;
      for (let i = 0; i < 40 && listener.revision === revision; i++) await delay(50);
      assert.equal(listener.revision, revision + 1);
      assert.ok(listener.client);
    } finally {
      await listener.onModuleDestroy();
    }
  }));
