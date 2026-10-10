import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { Backoffice, grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import { createApi } from '../../services/api/dist/index.js';
import { createBackofficeServer, allowed } from '../../apps/backoffice/server.mjs';
import { allowedPath } from '../../apps/backoffice/dist/api.js';

test('workforce through full API and real proxy: feature gate, scoped command, replay and assets', () =>
  withSyncDatabases(async ({ cloud, org, branch }) => {
    const manager = await provisionCatalogManager(cloud.pool, {
      organization_id: org,
      name: 'Synthetic proxy manager',
      branch_ids: [branch],
    });
    await grantBackoffice(cloud.pool, manager.actor_id, branch, 'manager');
    const employee = randomUUID();
    await new Backoffice(cloud.pool, true).command(manager.token, branch, {
      request_id: randomUUID(),
      reason: 'Synthetic proxy employee',
      command: {
        type: 'save',
        kind: 'employee',
        id: employee,
        expected_revision: 0,
        payload: { name: 'Synthetic employee', role: 'cook', active: true, note: '' },
      },
    });
    for (const enabled of [false, true]) {
      const app = await createApi({
        ...cloud.config,
        catalogAdminEnabled: true,
        backofficeEnabled: true,
        workforceEnabled: enabled,
      });
      await app.listen(0, '127.0.0.1');
      const server = createBackofficeServer({ apiPort: Number(new URL(await app.getUrl()).port) });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${server.address().port}`,
        path = `/v1/admin/backoffice/branches/${branch}/workforce`;
      const headers = {
        Authorization: `Bearer ${manager.token}`,
        'Content-Type': 'application/json',
      };
      try {
        assert.equal((await fetch(url + path + '?month=2026-09-01')).status, 401);
        const res = await fetch(url + path + '?month=2026-09-01', { headers });
        assert.equal(res.status, enabled ? 200 : 503);
        if (!enabled) continue;
        assert.equal((await res.json()).employees[0].id, employee);
        const body = {
          request_id: randomUUID(),
          reason: 'Set hourly rate',
          command: {
            type: 'save',
            kind: 'rate',
            id: randomUUID(),
            expected_revision: 0,
            payload: {
              employee_id: employee,
              effective_date: '2026-09-01',
              hourly_minor: '100000',
            },
          },
        };
        const send = () =>
          fetch(url + path + '/commands', { method: 'POST', headers, body: JSON.stringify(body) });
        const first = await send();
        assert.equal(first.status, 200);
        assert.deepEqual(await (await send()).json(), await first.json());
        for (const asset of ['workforce.js', 'workforce-model.js', 'workforce.css'])
          assert.equal((await fetch(url + '/' + asset)).status, 200);
        for (const suffix of [
          '?month=2026-09-01&month=2026-09-01',
          '?month=2026-09-01&extra=1',
          '?month=2026-09-02',
          '/commands?extra=1',
        ]) {
          assert.equal(allowed('GET', path + suffix), false);
          assert.equal(allowedPath(`operations/branches/${branch}/workforce` + suffix), false);
        }
        await grantBackoffice(cloud.pool, manager.actor_id, branch, 'analyst');
        assert.equal((await send()).status, 403);
      } finally {
        await new Promise((r) => server.close(r));
        await app.close();
      }
    }
  }));
