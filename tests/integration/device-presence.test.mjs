import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import {
  DeviceRegistry,
  kioskPresence,
  exchangeDeviceAccess,
  hashDeviceCode,
} from '../../packages/backoffice-core/dist/device-registry.js';
import { backofficeGrants } from '../../infra/staging/backoffice-grants.mjs';
import { deviceCenterGrants } from '../../infra/staging/device-center-grants.mjs';

async function fixture(run) {
  return withSyncDatabases(async (c) => {
    const manager = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Synthetic device manager',
      branch_ids: [c.branch],
    });
    await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
    const kiosk = randomUUID(),
      key = randomBytes(32).toString('hex');
    await c.cloud.pool.query(
      'INSERT INTO kiosk_devices(id,branch_id,organization_id,token_hash) VALUES($1,$2,$3,$4)',
      [kiosk, c.branch, c.org, hashDeviceCode(key)],
    );
    await run({
      ...c,
      manager,
      kiosk,
      key,
      registry: new DeviceRegistry(c.cloud.pool, false, true),
    });
  });
}
const inventory = (id = randomUUID()) => ({
  id,
  request_id: randomUUID(),
  expected_revision: 0,
  kind: 'usb_tv',
  name: 'Synthetic USB screen',
  location: 'Hall',
  notes: 'USB only',
  archived: false,
  reason: 'Synthetic inventory',
});
const sample = { appVersion: '0.1.0 (15)', state: 'active', issue: 'none', menuVersion: 10 };

test('inventory revisions, retry, audit and analyst scope do not grant device access', () =>
  fixture(async (c) => {
    const value = inventory();
    const saved = await c.registry.inventory(c.manager.token, c.branch, value);
    assert.equal(saved.revision, 1);
    assert.equal((await c.registry.inventory(c.manager.token, c.branch, value)).revision, 1);
    await assert.rejects(
      c.registry.inventory(c.manager.token, c.branch, { ...value, name: 'Other' }),
      { code: 'CONFLICT' },
    );
    await assert.rejects(c.registry.inventory(c.manager.token, randomUUID(), value), {
      code: 'FORBIDDEN',
    });
    const edit = { ...value, request_id: randomUUID(), expected_revision: 1, archived: true };
    const results = await Promise.allSettled([
      c.registry.inventory(c.manager.token, c.branch, edit),
      c.registry.inventory(c.manager.token, c.branch, {
        ...edit,
        request_id: randomUUID(),
        name: 'Race',
      }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const history = await c.registry.inventoryHistory(c.manager.token, c.branch, value.id);
    assert.equal(history.events.length, 2);
    assert.equal(history.events[0].before_state.revision, 1);
    await assert.rejects(c.cloud.pool.query('DELETE FROM device_inventory_commands'), /immutable/);
    assert.equal(
      (await c.cloud.pool.query('SELECT count(*) FROM devices WHERE id=$1', [value.id])).rows[0]
        .count,
      '0',
    );
    await assert.rejects(
      c.registry.issue(c.manager.token, c.branch, {
        request_id: randomUUID(),
        name: 'Screen',
        mode: 'prep',
        reason: 'Test code',
      }),
      { code: 'DEVICE_ACCESS_UNAVAILABLE' },
    );
    await grantBackoffice(c.cloud.pool, c.manager.actor_id, c.branch, 'analyst');
    assert.equal((await c.registry.read(c.manager.token, c.branch)).inventory_enabled, true);
    await assert.rejects(c.registry.inventory(c.manager.token, c.branch, inventory()), {
      code: 'FORBIDDEN',
    });
    await assert.rejects(
      new DeviceRegistry(c.cloud.pool, true, false).inventoryHistory(
        c.manager.token,
        c.branch,
        value.id,
      ),
      { code: 'DEVICE_ACCESS_UNAVAILABLE' },
    );
  }));

test('authenticated kiosk observation is branch-bound; revoked keys and arbitrary payload cannot mark it online', () =>
  fixture(async (c) => {
    await assert.rejects(kioskPresence(c.cloud.pool, c.kiosk, 'a'.repeat(64), sample), {
      code: 'UNAUTHORIZED',
    });
    await assert.rejects(
      kioskPresence(c.cloud.pool, c.kiosk, c.key, { ...sample, branchId: randomUUID() }),
      { code: 'INVALID_REQUEST' },
    );
    await kioskPresence(c.cloud.pool, c.kiosk, c.key, sample);
    const row = (await c.registry.read(c.manager.token, c.branch)).devices.find(
      (d) => d.id === c.kiosk,
    );
    assert.equal(row.presence.app_version, sample.appVersion);
    assert.equal(row.presence.menu_version, 10);
    assert.equal(row.presence.branch_id, c.branch);
    await c.registry.inventory(c.manager.token, c.branch, {
      ...inventory(c.kiosk),
      kind: 'registered',
      name: 'iPad front',
    });
    await assert.rejects(
      c.registry.inventory(c.manager.token, c.branch, {
        ...inventory(c.kiosk),
        kind: 'registered',
        expected_revision: 1,
        archived: true,
      }),
      { code: 'INVALID_REQUEST' },
    );
    await c.cloud.pool.query('UPDATE kiosk_devices SET active=false WHERE id=$1', [c.kiosk]);
    await assert.rejects(kioskPresence(c.cloud.pool, c.kiosk, c.key, sample), {
      code: 'UNAUTHORIZED',
    });
    assert.equal(
      (await c.registry.read(c.manager.token, c.branch)).devices.find((d) => d.id === c.kiosk)
        .status,
      'revoked',
    );
    assert.equal(
      (await c.cloud.pool.query('SELECT count(*) FROM kiosk_sessions')).rows[0].count,
      '0',
    );
  }));

test('restricted role can monitor and maintain inventory without creating orders or changing kiosk keys', () =>
  fixture(async (c) => {
    const role = 'presence_' + randomUUID().replaceAll('-', '');
    let pool;
    await c.cloud.admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    try {
      await c.cloud.pool.query(
        `GRANT USAGE ON SCHEMA ${c.cloud.schema} TO ${role}; GRANT SELECT ON devices,branches,cloud_branch_availability TO ${role}`,
      );
      await c.cloud.pool.query(backofficeGrants(role, true));
      await c.cloud.pool.query(deviceCenterGrants(role));
      const url = new URL(c.cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${c.cloud.schema} -c role=${role}`);
      pool = createPool(url.toString());
      const registry = new DeviceRegistry(pool, false, true);
      await kioskPresence(pool, c.kiosk, c.key, sample);
      await registry.inventory(c.manager.token, c.branch, inventory());
      await registry.read(c.manager.token, c.branch);
      await assert.rejects(
        pool.query('UPDATE kiosk_devices SET token_hash=$1', [hashDeviceCode('bad')]),
        { code: '42501' },
      );
      await assert.rejects(pool.query('DELETE FROM device_inventory_commands'), { code: '42501' });
      await assert.rejects(pool.query('UPDATE commerce_orders SET id=id'), { code: '42501' });
    } finally {
      await pool?.end();
      await c.cloud.pool.query(`DROP OWNED BY ${role}`);
      await c.cloud.admin.query(`DROP ROLE ${role}`);
    }
  }));

test('renamed and revoked screen can be paired again; old observations cannot refresh a new generation', () =>
  fixture(async (c) => {
    const token = randomBytes(32).toString('hex');
    await c.cloud.pool.query("UPDATE devices SET status='active' WHERE id=$1", [c.device]);
    await c.cloud.pool.query(
      "INSERT INTO device_credentials(device_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 day')",
      [c.device, hashDeviceCode(token)],
    );
    await c.cloud.pool.query(
      'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
      [c.branch, c.org, c.device, randomUUID()],
    );
    const registry = new DeviceRegistry(c.cloud.pool, true, true),
      auth = { deviceId: c.device, token };
    const issue = () => ({
      request_id: randomUUID(),
      reason: 'Synthetic setup',
      mode: 'display',
      name: 'Board',
    });
    const first = await registry.issue(c.manager.token, c.branch, issue());
    let pull = await exchangeDeviceAccess(c.cloud.pool, auth, { protocolVersion: 1, receipts: [] });
    let cmd = pull.commands[0];
    const receipt = {
      commandId: cmd.commandId,
      terminalId: cmd.terminalId,
      generation: cmd.generation,
      state: 'paired',
    };
    await exchangeDeviceAccess(c.cloud.pool, auth, { protocolVersion: 1, receipts: [receipt] });
    const observation = { terminalId: cmd.terminalId, generation: cmd.generation, ageMs: 180000 };
    await exchangeDeviceAccess(c.cloud.pool, auth, {
      protocolVersion: 1,
      receipts: [],
      observations: [observation],
    });
    const observed = (
      await c.cloud.pool.query('SELECT observed_at FROM device_presence WHERE device_id=$1', [
        first.device_id,
      ])
    ).rows[0].observed_at;
    assert.ok(Date.now() - observed.getTime() >= 188000);
    await registry.inventory(c.manager.token, c.branch, {
      ...inventory(first.device_id),
      kind: 'registered',
      name: 'Board renamed',
    });
    const rev = await registry.revoke(c.manager.token, c.branch, {
      device_id: first.device_id,
      request_id: randomUUID(),
      reason: 'Synthetic revoke',
      confirm_name: 'Board renamed',
    });
    pull = await exchangeDeviceAccess(c.cloud.pool, auth, { protocolVersion: 1, receipts: [] });
    cmd = pull.commands.find((x) => x.commandId === rev.command_id);
    await exchangeDeviceAccess(c.cloud.pool, auth, {
      protocolVersion: 1,
      receipts: [
        {
          commandId: cmd.commandId,
          terminalId: cmd.terminalId,
          generation: cmd.generation,
          state: 'applied',
        },
      ],
      observations: [{ ...observation, ageMs: 0 }],
    });
    assert.equal(
      (
        await c.cloud.pool.query('SELECT observed_at FROM device_presence WHERE device_id=$1', [
          first.device_id,
        ])
      ).rows[0].observed_at.getTime(),
      observed.getTime(),
    );
    const renewed = await registry.issue(c.manager.token, c.branch, {
      ...issue(),
      device_id: first.device_id,
      name: 'Board renamed',
      confirm_name: 'Board renamed',
    });
    assert.equal(renewed.device_id, first.device_id);
    assert.equal(
      (await registry.read(c.manager.token, c.branch)).devices.find((d) => d.id === first.device_id)
        .name,
      'Board renamed',
    );
  }));

test('owner migration preserves prior data and exact ACL, rejects a repeated apply', async () => {
  const { mkdtemp, readdir, copyFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { deployDeviceCenter } = await import('../../infra/staging/device-center-owner.mjs');
  const source = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'device-before058-'));
  try {
    for (const f of await readdir(source))
      if (f.endsWith('.sql') && +f.slice(0, 3) <= 57) await copyFile(join(source, f), join(dir, f));
    await withSyncDatabases(
      async (c) => {
        const role = 'device_owner_test_' + randomUUID().replaceAll('-', '');
        await c.cloud.admin.query(`CREATE ROLE ${role} NOLOGIN`);
        try {
          const client = await c.cloud.pool.connect();
          try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
            assert.equal(
              (await deployDeviceCenter(client, { directory: source, role, inspect: true }))
                .pending[0],
              '058_cloud_device_center.sql',
            );
            const result = await deployDeviceCenter(client, { directory: source, role });
            assert.equal(result.existingDataPreserved, true);
            assert.equal(result.pairingEnabled, false);
            await client.query('COMMIT');
            await client.query('BEGIN');
            await assert.rejects(
              deployDeviceCenter(client, { directory: source, role }),
              /Exact schema057 ledger required/,
            );
            await client.query('ROLLBACK');
          } finally {
            client.release();
          }
        } finally {
          await c.cloud.pool.query(`DROP OWNED BY ${role}`);
          await c.cloud.admin.query(`DROP ROLE ${role}`);
        }
      },
      { cloudMigrationDirectory: dir },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real HTTP and portal proxy enforce center flag, authorization and exact inventory routes', () =>
  fixture(async (c) => {
    const { createRequire } = await import('node:module');
    const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
    const { Module } = require('@nestjs/common');
    const { createHttpApplication, RESOURCE } = await import('@pickchick/platform');
    const { DeviceRegistryController, KioskPresenceController } =
      await import('../../services/api/dist/device-registry-controller.js');
    const { createBackofficeServer } = await import('../../apps/backoffice/server.mjs');
    const prior = process.env.DEVICE_CENTER_ENABLED;
    process.env.DEVICE_CENTER_ENABLED = 'true';
    class TestModule {}
    Module({
      controllers: [DeviceRegistryController, KioskPresenceController],
      providers: [
        {
          provide: RESOURCE,
          useValue: {
            pool: c.cloud.pool,
            config: { ...c.cloud.config, backofficeEnabled: true },
            admission: {
              intercept(_c, next) {
                return next.handle();
              },
            },
          },
        },
      ],
    })(TestModule);
    let app, proxy;
    try {
      app = await createHttpApplication(TestModule);
      await app.listen(0, '127.0.0.1');
      proxy = createBackofficeServer({ apiPort: Number(new URL(await app.getUrl()).port) });
      await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${proxy.address().port}/v1/admin/backoffice/branches/${c.branch}/devices`;
      const headers = {
        Authorization: 'Bearer ' + c.manager.token,
        'Content-Type': 'application/json',
      };
      let r = await fetch(base);
      assert.equal(r.status, 401);
      await r.body.cancel();
      const data = inventory();
      r = await fetch(base + '/inventory', { method: 'POST', headers, body: JSON.stringify(data) });
      assert.equal(r.status, 200);
      await r.body.cancel();
      r = await fetch(base + '/' + data.id + '/inventory-events', { headers });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).events.length, 1);
      const url = (await app.getUrl()) + '/v1/kiosk-checkout/device-presence';
      r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Kiosk-Device': c.kiosk,
          'X-Kiosk-Key': c.key,
        },
        body: JSON.stringify(sample),
      });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      await r.body.cancel();
      process.env.DEVICE_CENTER_ENABLED = 'false';
      r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(r.status, 404);
      await r.body.cancel();
    } finally {
      if (proxy) {
        proxy.closeAllConnections();
        await new Promise((r) => proxy.close(r));
      }
      await app?.close();
      if (prior === undefined) delete process.env.DEVICE_CENTER_ENABLED;
      else process.env.DEVICE_CENTER_ENABLED = prior;
    }
  }));
