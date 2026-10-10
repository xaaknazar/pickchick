import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createHttpApplication, RESOURCE } from '@pickchick/platform';
import {
  DeviceRegistryController,
  DeviceAccessTransportController,
} from '../../services/api/dist/device-registry-controller.js';
import { createBackofficeServer } from '../../apps/backoffice/server.mjs';
import { createPool } from '@pickchick/database';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { Backoffice, grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import {
  DeviceRegistry,
  exchangeDeviceAccess,
  hashDeviceCode,
} from '../../packages/backoffice-core/dist/device-registry.js';
import { backofficeGrants } from '../../infra/staging/backoffice-grants.mjs';
import { deviceRegistryGrants } from '../../infra/staging/device-registry-grants.mjs';

async function fixture(fn) {
  return withSyncDatabases(async (c) => {
    const manager = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Synthetic device manager',
      branch_ids: [c.branch],
    });
    await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
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
    await fn({
      ...c,
      manager,
      auth: { deviceId: c.device, token },
      registry: new DeviceRegistry(c.cloud.pool, true),
      body: () => ({
        request_id: randomUUID(),
        reason: 'Synthetic setup',
        mode: 'display',
        name: 'Synthetic board',
      }),
    });
  });
}
test('existing edge revoke is rejected atomically; confirmed non-edge revoke is audited once', () =>
  fixture(async (c) => {
    const bo = new Backoffice(c.cloud.pool, true),
      request = {
        request_id: randomUUID(),
        reason: 'Synthetic safety',
        command: { type: 'revoke_device', id: c.device, confirm_name: 'Synthetic' },
      };
    await assert.rejects(bo.command(c.manager.token, c.branch, request), {
      reason: 'EDGE_REVOKE_REQUIRES_REPLACEMENT_PROTOCOL',
    });
    assert.equal(
      (await c.cloud.pool.query('SELECT status FROM devices WHERE id=$1', [c.device])).rows[0]
        .status,
      'active',
    );
    assert.equal((await c.cloud.pool.query('SELECT count(*) FROM bo_audit')).rows[0].count, '0');
    const id = randomUUID();
    await c.cloud.pool.query(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name,status) VALUES($1,$2,$3,'display','Synthetic board','active')",
      [id, c.branch, c.org],
    );
    const ok = {
      ...request,
      command: { type: 'revoke_device', id, confirm_name: 'Synthetic board' },
    };
    await assert.rejects(
      bo.command(c.manager.token, c.branch, {
        ...ok,
        command: { ...ok.command, confirm_name: 'Other' },
      }),
      { reason: 'DEVICE_NAME_CONFIRMATION_REQUIRED' },
    );
    assert.equal((await bo.command(c.manager.token, c.branch, ok)).status, 'revoked');
    await bo.command(c.manager.token, c.branch, ok);
    assert.equal((await c.cloud.pool.query('SELECT count(*) FROM bo_audit')).rows[0].count, '1');
  }));
test('manager codes are hash-only, scoped, bounded and cannot be replayed or issued by analyst', () =>
  fixture(async (c) => {
    const body = c.body(),
      issued = await c.registry.issue(c.manager.token, c.branch, body);
    assert.match(issued.code, /^([a-f0-9]{4}-){7}[a-f0-9]{4}$/);
    const stored = (await c.cloud.pool.query('SELECT * FROM cloud_device_commands')).rows[0];
    assert.equal(stored.code_hash, hashDeviceCode(issued.code.replaceAll('-', '')));
    assert.ok(!JSON.stringify(stored).includes(issued.code));
    await assert.rejects(c.registry.issue(c.manager.token, c.branch, body), {
      code: 'CODE_ALREADY_ISSUED',
    });
    await assert.rejects(c.registry.issue(c.manager.token, c.branch, { ...body, name: 'Other' }), {
      code: 'CONFLICT',
    });
    await assert.rejects(c.registry.read(c.manager.token, randomUUID()), { code: 'FORBIDDEN' });
    await grantBackoffice(c.cloud.pool, c.manager.actor_id, c.branch, 'analyst');
    assert.equal((await c.registry.read(c.manager.token, c.branch)).devices.length, 2);
    await assert.rejects(c.registry.issue(c.manager.token, c.branch, c.body()), {
      code: 'FORBIDDEN',
    });
    await assert.rejects(c.cloud.pool.query('DELETE FROM device_events'), /immutable/);
    await assert.rejects(
      c.cloud.pool.query('UPDATE cloud_device_commands SET code_hash=$1', ['b'.repeat(64)]),
      /immutable/,
    );
  }));
test('edge mailbox binds receipts and commands; stale generations do not reactivate a revoked screen', () =>
  fixture(async (c) => {
    const issued = await c.registry.issue(c.manager.token, c.branch, c.body());
    const exchange = (receipts) =>
      exchangeDeviceAccess(c.cloud.pool, c.auth, { protocolVersion: 1, receipts });
    const pull = await exchange([]);
    assert.equal(pull.commands.length, 1);
    const cmd = pull.commands[0],
      receipt = {
        commandId: cmd.commandId,
        terminalId: cmd.terminalId,
        generation: cmd.generation,
        state: 'applied',
      };
    await assert.rejects(exchange([{ ...receipt, terminalId: randomUUID() }]), {
      code: 'CONFLICT',
    });
    await exchange([receipt]);
    await exchange([{ ...receipt, state: 'paired' }]);
    assert.equal(
      (await c.registry.read(c.manager.token, c.branch)).devices.find(
        (d) => d.id === issued.device_id,
      ).status,
      'active',
    );
    const revoke = await c.registry.revoke(c.manager.token, c.branch, {
      request_id: randomUUID(),
      reason: 'Synthetic revoke',
      device_id: issued.device_id,
      confirm_name: 'Synthetic board',
    });
    await exchange([{ ...receipt, state: 'paired' }]);
    const rev = (await exchange([])).commands.find((c) => c.commandId === revoke.command_id);
    await exchange([
      {
        commandId: rev.commandId,
        terminalId: rev.terminalId,
        generation: rev.generation,
        state: 'applied',
      },
    ]);
    await exchange([{ ...receipt, state: 'paired' }]);
    assert.equal(
      (await c.registry.read(c.manager.token, c.branch)).devices.find(
        (d) => d.id === issued.device_id,
      ).status,
      'revoked',
    );
    assert.equal(
      (await c.cloud.pool.query('SELECT status FROM devices WHERE id=$1', [c.device])).rows[0]
        .status,
      'active',
    );
  }));
test('restricted API role can issue and acknowledge access without any key or staff verifier writes', () =>
  fixture(async (c) => {
    const role = 'device_test_' + randomUUID().replaceAll('-', '');
    let pool;
    await c.cloud.admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    try {
      await c.cloud.pool.query(`GRANT USAGE ON SCHEMA ${c.cloud.schema} TO ${role}`);
      await c.cloud.pool.query(
        `GRANT SELECT ON devices,device_credentials,branches TO ${role}; GRANT UPDATE(id) ON devices TO ${role}; GRANT UPDATE(device_id) ON device_credentials TO ${role}`,
      );
      await c.cloud.pool.query(backofficeGrants(role, true));
      await c.cloud.pool.query(deviceRegistryGrants(role, true));
      const url = new URL(c.cloud.config.databaseUrl);
      url.searchParams.set('options', `-c search_path=${c.cloud.schema} -c role=${role}`);
      pool = createPool(url.toString());
      const registry = new DeviceRegistry(pool, true);
      await registry.read(c.manager.token, c.branch);
      await registry.issue(c.manager.token, c.branch, c.body());
      await registry.issueKitchenReset(c.manager.token, c.branch, {
        request_id: randomUUID(),
        reason: 'Synthetic password recovery',
        confirm_login: 'kitchen',
      });
      await registry.resetEvents(c.manager.token, c.branch);
      const pull = await exchangeDeviceAccess(pool, c.auth, { protocolVersion: 1, receipts: [] });
      const cmd = pull.commands[0],
        reset = pull.resetCommands[0];
      await exchangeDeviceAccess(pool, c.auth, {
        protocolVersion: 1,
        receipts: [
          {
            commandId: cmd.commandId,
            terminalId: cmd.terminalId,
            generation: cmd.generation,
            state: 'paired',
          },
        ],
        resetReceipts: [{ commandId: reset.commandId, state: 'used' }],
      });
      await assert.rejects(
        pool.query('UPDATE device_credentials SET token_hash=$1', ['c'.repeat(64)]),
        { code: '42501' },
      );
      await assert.rejects(pool.query('DELETE FROM device_events'), { code: '42501' });
      await c.cloud.pool.query(deviceRegistryGrants(role, false));
      await assert.rejects(registry.issue(c.manager.token, c.branch, c.body()), { code: '42501' });
    } finally {
      await pool?.end();
      await c.cloud.pool.query(`DROP OWNED BY ${role}`);
      await c.cloud.admin.query(`DROP ROLE ${role}`);
    }
  }));

test('managed screen cannot use legacy cloud-only revoke; cloud reset is scoped, hash-only and audited', () =>
  fixture(async (c) => {
    const issued = await c.registry.issue(c.manager.token, c.branch, c.body());
    const bo = new Backoffice(c.cloud.pool, true);
    await assert.rejects(
      bo.command(c.manager.token, c.branch, {
        request_id: randomUUID(),
        reason: 'Synthetic bypass',
        command: { type: 'revoke_device', id: issued.device_id, confirm_name: 'Synthetic board' },
      }),
      { reason: 'DEVICE_REVOKE_REQUIRES_EDGE_ACK' },
    );
    const body = {
      request_id: randomUUID(),
      reason: 'Synthetic forgotten password',
      confirm_login: 'kitchen',
    };
    await assert.rejects(
      c.registry.issueKitchenReset(c.manager.token, c.branch, {
        ...body,
        confirm_login: 'manager',
      }),
      { code: 'INVALID_REQUEST' },
    );
    const reset = await c.registry.issueKitchenReset(c.manager.token, c.branch, body);
    assert.equal(reset.purpose, 'kitchen-password-reset');
    const stored = (await c.cloud.pool.query('SELECT * FROM cloud_kitchen_password_resets'))
      .rows[0];
    assert.equal(stored.code_hash, hashDeviceCode(reset.code.replaceAll('-', '')));
    assert.ok(!JSON.stringify(stored).includes(reset.code));
    await assert.rejects(c.registry.issueKitchenReset(c.manager.token, c.branch, body), {
      code: 'CODE_ALREADY_ISSUED',
    });
    await assert.rejects(
      c.registry.issueKitchenReset(c.manager.token, c.branch, {
        ...body,
        request_id: randomUUID(),
      }),
      { code: 'CODE_ALREADY_ISSUED' },
    );
    await assert.rejects(c.registry.issueKitchenReset(c.manager.token, randomUUID(), body), {
      code: 'FORBIDDEN',
    });
    const pull = await exchangeDeviceAccess(c.cloud.pool, c.auth, {
      protocolVersion: 1,
      receipts: [],
    });
    assert.equal(pull.resetCommands[0].login, 'kitchen');
    assert.equal(pull.resetCommands[0].commandId, reset.command_id);
    assert.ok(!JSON.stringify(pull).includes(reset.code));
    const ack = (state) =>
      exchangeDeviceAccess(c.cloud.pool, c.auth, {
        protocolVersion: 1,
        receipts: [],
        resetReceipts: [{ commandId: reset.command_id, state }],
      });
    await ack('applied');
    await ack('used');
    await ack('applied');
    await ack('used');
    assert.equal((await c.registry.read(c.manager.token, c.branch)).password_reset.state, 'used');
    assert.deepEqual(
      (await c.registry.resetEvents(c.manager.token, c.branch)).events.map((x) => x.action).sort(),
      ['applied', 'delivered', 'issued', 'used'],
    );
    await assert.rejects(
      c.cloud.pool.query('UPDATE cloud_kitchen_password_resets SET code_hash=$1', ['b'.repeat(64)]),
      /immutable/,
    );
    await assert.rejects(
      c.cloud.pool.query('DELETE FROM kitchen_password_reset_events'),
      /immutable/,
    );
    await grantBackoffice(c.cloud.pool, c.manager.actor_id, c.branch, 'analyst');
    await assert.rejects(
      c.registry.issueKitchenReset(c.manager.token, c.branch, {
        ...body,
        request_id: randomUUID(),
      }),
      { code: 'FORBIDDEN' },
    );
  }));
test('concurrent reset requests yield one outstanding code; foreign or revoked edge cannot read it', () =>
  fixture(async (c) => {
    const result = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        c.registry.issueKitchenReset(c.manager.token, c.branch, {
          request_id: randomUUID(),
          reason: 'Synthetic parallel request',
          confirm_login: 'kitchen',
        }),
      ),
    );
    assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      (await c.cloud.pool.query('SELECT count(*) FROM cloud_kitchen_password_resets')).rows[0]
        .count,
      '1',
    );
    await assert.rejects(
      exchangeDeviceAccess(
        c.cloud.pool,
        { ...c.auth, deviceId: randomUUID() },
        { protocolVersion: 1, receipts: [] },
      ),
      { code: 'UNAUTHORIZED' },
    );
    await c.cloud.pool.query("UPDATE devices SET status='revoked' WHERE id=$1", [c.device]);
    await assert.rejects(
      exchangeDeviceAccess(c.cloud.pool, c.auth, { protocolVersion: 1, receipts: [] }),
      { code: 'UNAUTHORIZED' },
    );
  }));

test('actual HTTP controller + BO proxy preserves auth, exact routes and secret-free responses', () =>
  fixture(async (c) => {
    const previous = process.env.BACKOFFICE_DEVICE_ACCESS_ENABLED;
    process.env.BACKOFFICE_DEVICE_ACCESS_ENABLED = 'true';
    const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
    const { Module } = require('@nestjs/common');
    class TestModule {}
    Module({
      controllers: [DeviceRegistryController, DeviceAccessTransportController],
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
      const request = (path, body, token = c.manager.token) =>
        fetch(base + path, {
          method: body ? 'POST' : 'GET',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      const list = await request('');
      assert.equal(list.status, 200);
      assert.equal((await list.json()).devices.length, 1);
      const issued = await request('/kitchen-password-reset', {
        request_id: randomUUID(),
        reason: 'Synthetic HTTP reset',
        confirm_login: 'kitchen',
      });
      assert.equal(issued.status, 201);
      const response = await issued.json();
      assert.match(response.code, /^([a-f0-9]{4}-){7}[a-f0-9]{4}$/);
      const history = await request('/kitchen-password-reset/events');
      assert.equal(history.status, 200);
      assert.ok(!JSON.stringify(await history.json()).includes(response.code));
      const anonymous = await request('', undefined, 'a'.repeat(64));
      assert.equal(anonymous.status, 401);
      await anonymous.body.cancel();
      const invalid = await request('/other', {});
      assert.equal(invalid.status, 404);
      await invalid.body.cancel();
      await grantBackoffice(c.cloud.pool, c.manager.actor_id, c.branch, 'analyst');
      const denied = await request('/pairing-codes', c.body());
      assert.equal(denied.status, 403);
      await denied.body.cancel();
    } finally {
      if (proxy) {
        proxy.closeAllConnections();
        await new Promise((r) => proxy.close(r));
      }
      await app?.close();
      if (previous === undefined) delete process.env.BACKOFFICE_DEVICE_ACCESS_ENABLED;
      else process.env.BACKOFFICE_DEVICE_ACCESS_ENABLED = previous;
    }
  }));

test('enrolled iPad inventory reads only identity/state and never rotates its credentials', () =>
  fixture(async (c) => {
    const id = randomUUID(),
      hash = randomBytes(32).toString('hex');
    await c.cloud.pool.query(
      'INSERT INTO kiosk_devices(id,organization_id,branch_id,token_hash) VALUES($1,$2,$3,$4)',
      [id, c.org, c.branch, hash],
    );
    const list = await c.registry.read(c.manager.token, c.branch),
      row = list.devices.find((d) => d.id === id);
    assert.equal(row.kind, 'kiosk');
    assert.equal(row.status, 'active');
    assert.ok(!JSON.stringify(list).includes(hash));
    await assert.rejects(
      c.registry.revoke(c.manager.token, c.branch, {
        request_id: randomUUID(),
        reason: 'Synthetic refusal',
        device_id: id,
        confirm_name: row.name,
      }),
      { code: 'NOT_FOUND' },
    );
    assert.equal(
      (await c.cloud.pool.query('SELECT token_hash FROM kiosk_devices WHERE id=$1', [id])).rows[0]
        .token_hash,
      hash,
    );
  }));
