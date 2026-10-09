import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { createHttpApplication, RESOURCE } from '@pickchick/platform';
import { grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import {
  DEVICE_REGISTRY,
  DeviceRegistry,
} from '../../packages/backoffice-core/dist/device-registry.js';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { DeviceRegistryController } from '../../services/api/dist/device-registry-controller.js';
import { withSyncDatabases } from '../helpers/sync.mjs';

const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
const { Module } = require('@nestjs/common');

/** Real Nest HTTP stack over synthetic PostgreSQL; no proxy allowlist (separate work package). */
async function withDevicesApi(run) {
  await withSyncDatabases(async ({ cloud, org, branch, device }) => {
    const people = {};
    for (const role of ['manager', 'analyst']) {
      const m = await provisionCatalogManager(cloud.pool, {
        organization_id: org,
        name: 'Синтетический ' + role,
        branch_ids: [branch],
      });
      await grantBackoffice(cloud.pool, m.actor_id, branch, role);
      people[role] = m.token;
    }
    const registry = new DeviceRegistry(cloud.pool, {
      enabled: true,
      pepper: randomBytes(32),
      kiosk: { encryptionKey: randomBytes(32), organizationId: org, branchId: branch },
    });
    class DevicesModule {}
    Module({
      controllers: [DeviceRegistryController],
      providers: [
        { provide: DEVICE_REGISTRY, useValue: registry },
        {
          provide: RESOURCE,
          useValue: {
            config: cloud.config,
            admission: { intercept: (_ctx, next) => next.handle() },
          },
        },
      ],
    })(DevicesModule);
    const app = await createHttpApplication(DevicesModule);
    await app.listen(0, '127.0.0.1');
    try {
      const base = (await app.getUrl()) + '/v1/admin/backoffice/branches/' + branch + '/devices';
      const call = (path, token, body) =>
        fetch(base + path, {
          method: body ? 'POST' : 'GET',
          headers: {
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
            'Content-Type': 'application/json',
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      await run({ call, people, device, branch });
    } finally {
      await app.close();
    }
  });
}

test('device registry HTTP: auth, one-time code, reason envelope and no caching', () =>
  withDevicesApi(async ({ call, people, device }) => {
    assert.equal((await call('', null)).status, 401);
    const list = await call('', people.analyst);
    assert.equal(list.status, 200);
    assert.equal(list.headers.get('cache-control'), 'no-store');
    const body = await list.json();
    assert.equal(body.kiosk_pairing, 'ready');
    assert.equal(body.devices.find((d) => d.id === device).revocable, false);
    const create = {
      request_id: randomUUID(),
      role: 'kiosk',
      name: 'Киоск HTTP',
      reason: 'Синтетическое подключение',
    };
    assert.equal((await call('', people.analyst, create)).status, 403);
    const created = await call('', people.manager, create);
    assert.equal(created.status, 200);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    const pairing = (await created.json()).pairing;
    assert.match(pairing.login, /^kiosk-/);
    assert.equal(pairing.password.length, 12);
    const replay = await call('', people.manager, create);
    assert.equal(replay.status, 409);
    const replayBody = await replay.json();
    assert.equal(replayBody.code, 'CONFLICT');
    assert.deepEqual(replayBody.error, { code: 'CODE_ALREADY_ISSUED' });
    assert.ok(!JSON.stringify(replayBody).includes(pairing.password));
    const edge = await call('/' + device + '/revoke', people.manager, {
      request_id: randomUUID(),
      reason: 'Синтетическая проверка',
      confirm_name: 'Synthetic',
    });
    assert.equal(edge.status, 409);
    assert.deepEqual((await edge.json()).error, {
      code: 'EDGE_REVOKE_REQUIRES_REPLACEMENT_PROTOCOL',
    });
    const events = await call('/' + device + '/events', people.analyst);
    assert.equal(events.status, 200);
    assert.deepEqual((await events.json()).events, []);
    assert.equal(
      (await call('/' + device + '/events?before=yesterday', people.analyst)).status,
      400,
    );
    assert.equal((await call('/not-a-uuid/rename', people.manager, {})).status, 400);
  }));
