import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { createHttpApplication, RESOURCE } from '@pickchick/platform';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { Backoffice, grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import { Workforce } from '../../packages/backoffice-core/dist/workforce-store.js';
import { WORKFORCE, WorkforceController } from '../../services/api/dist/workforce-controller.js';
const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
const { Module } = require('@nestjs/common');

test('workforce HTTP boundary: scoped read, strict month query, durable write and replay', () =>
  withSyncDatabases(async (c) => {
    const manager = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Synthetic workforce HTTP',
      branch_ids: [c.branch],
    });
    await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
    const employee_id = randomUUID();
    await new Backoffice(c.cloud.pool, true).command(manager.token, c.branch, {
      request_id: randomUUID(),
      reason: 'HTTP fixture',
      command: {
        type: 'save',
        kind: 'employee',
        id: employee_id,
        expected_revision: 0,
        payload: { name: 'Synthetic worker', role: 'cook', active: true, note: '' },
      },
    });
    class Fixture {}
    Module({
      controllers: [WorkforceController],
      providers: [
        { provide: WORKFORCE, useValue: new Workforce(c.cloud.pool, true) },
        {
          provide: RESOURCE,
          useValue: {
            config: c.cloud.config,
            admission: {
              intercept(_ctx, next) {
                return next.handle();
              },
            },
          },
        },
      ],
    })(Fixture);
    const app = await createHttpApplication(Fixture);
    await app.listen(0, '127.0.0.1');
    try {
      const base = (await app.getUrl()) + `/v1/admin/backoffice/branches/${c.branch}/workforce`;
      const headers = {
        Authorization: `Bearer ${manager.token}`,
        'Content-Type': 'application/json',
      };
      assert.equal((await fetch(base + '?month=2026-09-01')).status, 401);
      assert.equal((await fetch(base + '?month=2026-09-01&extra=1', { headers })).status, 400);
      assert.equal((await fetch(base + '?month=2026-09-02', { headers })).status, 400);
      const read = await fetch(base + '?month=2026-09-01', { headers });
      assert.equal(read.status, 200);
      assert.equal((await read.json()).employees.length, 1);
      const body = {
        request_id: randomUUID(),
        reason: 'Hourly rate setup',
        command: {
          type: 'save',
          kind: 'rate',
          id: randomUUID(),
          expected_revision: 0,
          payload: { employee_id, hourly_minor: '100000', effective_date: '2026-09-01' },
        },
      };
      const post = () =>
        fetch(base + '/commands', { method: 'POST', headers, body: JSON.stringify(body) });
      const first = await post();
      assert.equal(first.status, 200);
      const receipt = await first.json();
      assert.deepEqual(await (await post()).json(), receipt);
      body.command.payload.hourly_minor = '200000';
      assert.equal((await post()).status, 409);
      await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'analyst');
      assert.equal((await post()).status, 403);
    } finally {
      await app.close();
    }
  }));
