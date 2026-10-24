import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { createHttpApplication, RESOURCE } from '@pickchick/platform';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import {
  RECONCILIATION,
  Reconciliation,
} from '../../packages/backoffice-core/dist/reconciliation.js';
import { ReconciliationController } from '../../services/api/dist/reconciliation-controller.js';
import { createBackofficeServer, allowed } from '../../apps/backoffice/server.mjs';
const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
const { Module } = require('@nestjs/common');

const DAY = '2026-10-21';
const mapping = {
  version: 1,
  source: 'kaspi',
  delimiter: ';',
  has_header: true,
  columns: { occurred_at: 'Дата', amount: 'Сумма', operation_id: 'Номер' },
  date_format: 'dmy',
  decimal_separator: ',',
  amount_unit: 'major',
};

test('reconciliation HTTP and private proxy: scoped reads, large statements, reasons and replay', () =>
  withSyncDatabases(async (c) => {
    const manager = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Синтетический бухгалтер',
      branch_ids: [c.branch],
    });
    await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
    class Fixture {}
    Module({
      controllers: [ReconciliationController],
      providers: [
        {
          provide: RECONCILIATION,
          useValue: new Reconciliation(c.cloud.pool, true, {
            now: () => new Date('2026-10-22T06:00:00Z'),
          }),
        },
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
    const proxy = createBackofficeServer({ apiPort: Number(new URL(await app.getUrl()).port) });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${proxy.address().port}/v1/admin/backoffice/branches/${c.branch}/reconciliation`;
      const headers = {
        Authorization: `Bearer ${manager.token}`,
        'Content-Type': 'application/json',
      };
      assert.equal((await fetch(base + '?day=' + DAY)).status, 401);
      const read = await fetch(base + '?day=' + DAY, { headers });
      assert.equal(read.status, 200);
      const data = await read.json();
      assert.deepEqual(
        [data.branch_id, data.day, data.role, data.state],
        [c.branch, DAY, 'manager', 'open'],
      );
      // Strict query at the proxy and the API.
      for (const q of [
        '',
        '?day=21.10.2026',
        '?day=' + DAY + '&x=1',
        '?day=' + DAY + '&day=' + DAY,
      ])
        assert.equal((await fetch(base + q, { headers })).status, 404, q);
      assert.equal(
        allowed('GET', `/v1/admin/backoffice/branches/${c.branch}/reconciliation?day=2026-02-30`),
        true,
      );
      assert.equal((await fetch(base + '?day=2026-02-30', { headers })).status, 400);
      // A statement larger than the generic 100 KiB JSON limit.
      const rows = Array.from(
        { length: 1500 },
        (_, i) =>
          `21.10.2026 10:${String(i % 60).padStart(2, '0')}:00;${100000 + i};1 000,00;Синтетическая строка выписки`,
      );
      const content = ['Дата;Номер;Сумма;Описание', ...rows].join('\n');
      assert.ok(Buffer.byteLength(content) > 100 * 1024);
      const send = (path, body) =>
        fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
      const preview = await send('/preview', { mapping, content });
      assert.equal(preview.status, 200);
      assert.deepEqual(
        await preview.json().then((p) => [p.valid, p.lines, p.days.map((d) => d.day)]),
        [true, 1500, [DAY]],
      );
      const command = {
        request_id: randomUUID(),
        reason: 'Импорт выписки',
        command: {
          type: 'import',
          id: randomUUID(),
          profile_id: null,
          mapping,
          file_name: 'synthetic.csv',
          content,
        },
      };
      const first = await send('/commands', command);
      assert.equal(first.status, 200);
      const result = await first.json();
      assert.equal(result.lines, 1500);
      assert.deepEqual(await (await send('/commands', command)).json(), result);
      const again = await send('/commands', {
        ...command,
        request_id: randomUUID(),
        command: { ...command.command, id: randomUUID() },
      });
      assert.equal(again.status, 409);
      const envelope = await again.json();
      assert.equal(envelope.code, 'CONFLICT');
      assert.deepEqual(envelope.error, { code: 'DUPLICATE_IMPORT' });
      const bad = await send('/commands', { ...command, request_id: randomUUID(), reason: 'x' });
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).code, 'INVALID_REQUEST');
      assert.equal((await fetch(base + '/commands?x=1', { method: 'POST', headers })).status, 404);
      assert.equal((await fetch(base + '/commands', { method: 'DELETE', headers })).status, 404);
      const afterResponse = await fetch(base + '?day=' + DAY, { headers });
      const afterText = await afterResponse.text();
      // Every matched operation is listed for the export: above the proxy's generic 1 MiB.
      assert.ok(Buffer.byteLength(afterText) > 1024 * 1024);
      assert.equal(afterResponse.status, 200);
      const after = JSON.parse(afterText);
      assert.equal(
        after.report.rows.filter((r) => r.state === 'missing_in_pickchick').length,
        1500,
      );
      assert.equal(after.imports[0].line_count, 1500);
    } finally {
      await new Promise((resolve) => proxy.close(resolve));
      await app.close();
    }
  }));

test('reconciliation is unavailable while the flag is off', () =>
  withSyncDatabases(async (c) => {
    const manager = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Синтетический управляющий',
      branch_ids: [c.branch],
    });
    await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
    class Fixture {}
    Module({
      controllers: [ReconciliationController],
      providers: [
        { provide: RECONCILIATION, useValue: new Reconciliation(c.cloud.pool, false) },
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
      const response = await fetch(
        `${await app.getUrl()}/v1/admin/backoffice/branches/${c.branch}/reconciliation?day=${DAY}`,
        { headers: { Authorization: `Bearer ${manager.token}` } },
      );
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.deepEqual(
        [body.code, body.error],
        ['SERVICE_UNAVAILABLE', { code: 'RECONCILIATION_DISABLED' }],
      );
    } finally {
      await app.close();
    }
  }));
