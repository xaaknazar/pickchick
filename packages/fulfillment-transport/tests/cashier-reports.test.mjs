import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './worker-fixture.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import { Backoffice, grantBackoffice } from '../../backoffice-core/dist/index.js';
import { syncFulfillmentOnce, pullFulfillment } from '../dist/index.js';
import { transaction } from '@pickchick/database';
import { digest, localUnpaidExecution } from '@pickchick/edge-fulfillment';
import {
  CashierReportsSchema,
  receiveCashierReports,
  acknowledgeCashierReports,
  pendingCashierReports,
} from '../dist/cashier-reports.js';
import { fulfillmentWorkerGrants } from '../../../infra/windows/fulfillment-worker-grants.mjs';
import { createPool } from '@pickchick/database';

async function seed(f) {
  const shift = randomUUID(),
    release = randomUUID(),
    variant = randomUUID(),
    orders = [];
  await transaction(f.pool, async (db) => {
    await db.query("UPDATE branch_config SET pos_service_mode='unpaid_service'");
    const menu = {
      release_id: release,
      branch_id: f.scope.branchId,
      schema_version: 1,
      version: 1,
      items: [],
    };
    await db.query(
      'INSERT INTO menu_snapshots(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,1,1,$3,$4,now())',
      [release, f.scope.branchId, menu, digest(menu)],
    );
    await db.query(
      "INSERT INTO local_cash_shifts(id,branch_id,terminal_id,staff_id,opening_cash_minor,opened_at) VALUES($1,$2,$3,$4,1000,'2026-09-28T18:30:00Z')",
      [shift, f.scope.branchId, f.cashier.terminal_id, f.cashier.staff_id],
    );
    for (const at of ['2026-09-28T18:40:00Z', '2026-09-28T19:10:00Z']) {
      const id = randomUUID(),
        quoteId = randomUUID();
      const quote = {
        quote_id: quoteId,
        branch_id: f.scope.branchId,
        release_id: release,
        currency: 'KZT',
        total_minor: '100',
        service_mode: 'dine_in',
        lines: [
          {
            product_id: 'burger',
            variant_id: variant,
            name: { ru: 'Synthetic POS', kk: '' },
            quantity: 1,
            unit_price_minor: '100',
            total_minor: '100',
          },
        ],
      };
      await db.query(
        "INSERT INTO checkout_quotes(id,branch_id,staff_id,terminal_id,release_id,total_minor,snapshot,created_at,expires_at) VALUES($1,$2,$3,$4,$5,100,$6,now(),now()+interval '5 minutes')",
        [quoteId, f.scope.branchId, f.cashier.staff_id, f.cashier.terminal_id, release, quote],
      );
      await db.query(
        "INSERT INTO local_orders(id,branch_id,quote_id,total_minor,execution_mode,cash_shift_id,created_at) VALUES($1,$2,$3,100,'unpaid_service',$4,$5)",
        [id, f.scope.branchId, quoteId, shift, at],
      );
      await localUnpaidExecution({ enabled: true, deviceId: f.scope.deviceId }).admit(
        db,
        { orderId: id, branchId: f.scope.branchId, quote },
        { staff_id: f.cashier.staff_id },
        randomUUID(),
      );
      orders.push(id);
    }
    const manager = (
      await db.query("SELECT id FROM local_staff WHERE role='shift_manager' LIMIT 1")
    ).rows[0];
    await db.query(
      "INSERT INTO local_cash_movements(id,branch_id,shift_id,staff_id,direction,amount_minor,reason) VALUES($1,$2,$3,$4,'in',500,'Synthetic movement')",
      [randomUUID(), f.scope.branchId, shift, manager.id],
    );
    await db.query(
      "UPDATE local_cash_shifts SET state='closed',version=2,closed_at='2026-09-28T20:00:00Z',closed_by_staff_id=$2,counted_cash_minor=1450,discrepancy_minor=-50,closing_reason='Synthetic close',closed_report='{" +
        '"expected_cash_minor":"1500"' +
        "}'::jsonb WHERE id=$1",
      [shift, manager.id],
    );
  });
  return { shift, orders };
}

test('durable cashier snapshots cross real HTTP, survive lost receipt and expose whole scoped shift across midnight', () =>
  fixture(async (f) => {
    const source = await seed(f);
    const manager = await provisionCatalogManager(f.cloud, {
      organization_id: f.scope.organizationId,
      name: 'Synthetic director',
      branch_ids: [f.scope.branchId],
    });
    await grantBackoffice(f.cloud, manager.actor_id, f.scope.branchId, 'manager');
    const bo = new Backoffice(f.cloud, true);
    const originalFetch = fetch;
    let lost = false;
    const result = await syncFulfillmentOnce(f.pool, f.options, {
      fetch: async (url, options) => {
        const response = await originalFetch(url, options);
        if (options?.body && JSON.parse(options.body).cashierReports && !lost) {
          lost = true;
          throw new Error('Synthetic lost receipt');
        }
        return response;
      },
    });
    assert.equal(lost, true);
    assert.ok(
      (
        await f.pool.query(
          'SELECT count(*)::int count FROM cashier_report_outbox WHERE acknowledged_at IS NULL',
        )
      ).rows[0].count > 0,
    );
    assert.equal(
      (await f.cloud.query('SELECT count(*)::int count FROM cloud_cashier_orders')).rows[0].count,
      2,
    );
    await syncFulfillmentOnce(f.pool, f.options);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int count FROM cashier_report_outbox WHERE acknowledged_at IS NULL',
        )
      ).rows[0].count,
      0,
    );
    const all = await bo.read(manager.token, f.scope.branchId, {
      period: 'custom',
      start_date: '2026-09-28',
      end_date: '2026-09-28',
    });
    assert.equal(all.cashier_orders.length, 1);
    assert.equal(all.cashier_metrics.orders, 1);
    const shift = await bo.read(manager.token, f.scope.branchId, {
      period: 'today',
      shift_id: source.shift,
    });
    assert.equal(shift.cashier_orders.length, 2);
    assert.equal(shift.cashier_metrics.orders, 2);
    assert.equal(shift.cashier_metrics.unpaid_total_minor, '200');
    assert.equal(shift.selected_shift.expected_cash_minor, '1500');
    assert.equal(shift.selected_shift.cash_in_minor, '500');
    assert.equal(shift.selected_shift.discrepancy_minor, '-50');
    assert.equal(shift.metrics.captured_minor, null);
    assert.equal(shift.operational_shift_filter.mode, 'cashier_shift');
    assert.equal(shift.cashier_orders[0].created_at.toISOString(), '2026-09-28T19:10:00.000Z');
    const detail = await bo.order(manager.token, f.scope.branchId, source.orders[0]);
    assert.equal(detail.owner, 'edge_pos');
    assert.equal(detail.capabilities.can_refund, false);
    assert.equal(detail.order.snapshot.lines[0].name.ru, 'Synthetic POS');
    await assert.rejects(
      bo.read(manager.token, f.scope.branchId, { shift_id: randomUUID() }),
      /NOT_FOUND/,
    );
    await assert.rejects(
      bo.read(manager.token, randomUUID(), { shift_id: source.shift }),
      /FORBIDDEN/,
    );
    await f.cloud.query("UPDATE devices SET status='revoked' WHERE id=$1", [f.scope.deviceId]);
    assert.equal(
      (await bo.read(manager.token, f.scope.branchId, { shift_id: source.shift })).cashier_orders
        .length,
      2,
    );
    await assert.rejects(
      pullFulfillment(
        f.cloud,
        { deviceId: f.scope.deviceId, token: f.options.identity.token },
        { workerId: randomUUID(), leaseSeconds: 30 },
      ),
      /UNAUTHORIZED|FORBIDDEN/,
    );
    assert.ok(['applied', 'idle', 'acknowledged'].includes(result.state));
  }));

test('receipt and stream identities reject changed bodies, wrong branch and forged sums; immutable outbox cannot erase source', () =>
  fixture(async (f) => {
    await seed(f);
    const row = (
      await f.pool.query('SELECT * FROM cashier_report_outbox ORDER BY sequence LIMIT 1')
    ).rows[0];
    const reports = CashierReportsSchema.parse([
      {
        eventId: row.event_id,
        sequence: row.sequence,
        kind: row.kind,
        entityId: row.entity_id,
        payload: row.payload,
      },
    ]);
    const receipt = await transaction(f.cloud, (db) =>
      receiveCashierReports(db, f.scope.branchId, f.scope.deviceId, reports),
    );
    assert.deepEqual(
      await transaction(f.cloud, (db) =>
        receiveCashierReports(db, f.scope.branchId, f.scope.deviceId, reports),
      ),
      receipt,
    );
    await assert.rejects(
      transaction(f.cloud, (db) =>
        receiveCashierReports(db, f.scope.branchId, f.scope.deviceId, [
          {
            ...reports[0],
            payload: {
              ...reports[0].payload,
              opening_cash_minor: '1001',
              expected_cash_minor: '1001',
            },
          },
        ]),
      ),
      /CONFLICT/,
    );
    await assert.rejects(
      transaction(f.cloud, (db) =>
        receiveCashierReports(db, f.scope.branchId, f.scope.deviceId, [
          {
            ...reports[0],
            eventId: randomUUID(),
            sequence: '1000',
            payload: { ...reports[0].payload, expected_cash_minor: '999' },
          },
        ]),
      ),
      /INVALID_REQUEST/,
    );
    await assert.rejects(
      acknowledgeCashierReports(f.pool, f.scope.branchId, reports, {
        ...receipt,
        requestHash: '0'.repeat(64),
      }),
      /CONFLICT/,
    );
    await assert.rejects(
      f.pool.query('DELETE FROM cashier_report_outbox WHERE event_id=$1', [row.event_id]),
      /immutable/,
    );
    await assert.rejects(
      f.pool.query("UPDATE cashier_report_outbox SET payload='{}' WHERE event_id=$1", [
        row.event_id,
      ]),
      /immutable/,
    );
    const role = 'cashier_worker_' + randomUUID().replaceAll('-', '');
    const schema = (await f.pool.query('SELECT current_schema() name')).rows[0].name;
    let restricted;
    await f.pool.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    try {
      await f.pool.query(fulfillmentWorkerGrants(role, schema));
      const url = new URL(f.url);
      url.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
      restricted = createPool(url.toString());
      await syncFulfillmentOnce(restricted, f.options);
      assert.equal(
        (
          await restricted.query(
            "SELECT has_table_privilege(current_user,'local_cash_movements','INSERT') allowed",
          )
        ).rows[0].allowed,
        false,
      );
      assert.equal(
        (
          await restricted.query(
            "SELECT has_table_privilege(current_user,'local_cash_shifts','UPDATE') allowed",
          )
        ).rows[0].allowed,
        false,
      );
    } finally {
      await restricted?.end();
      await f.pool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    }
  }));

test('legacy protocol2 response stays exact and old API rejection of optional report pulses never blocks kitchen', () =>
  fixture(async (f) => {
    await seed(f);
    const legacy = await pullFulfillment(
      f.cloud,
      { deviceId: f.scope.deviceId, token: f.options.identity.token },
      {
        workerId: randomUUID(),
        leaseSeconds: 30,
        protocolVersion: 2,
        availabilityOnly: true,
        availability: { revision: '1', stoppedIds: [] },
      },
    );
    assert.deepEqual(Object.keys(legacy).sort(), ['event', 'scope']);
    let rejected = 0;
    const result = await syncFulfillmentOnce(f.pool, f.options, {
      fetch: async (url, options) => {
        const body = JSON.parse(options.body);
        if (body.protocolVersion === 3) {
          rejected++;
          return fetch(url, {
            ...options,
            body: JSON.stringify({ ...body, protocolVersion: 999 }),
          });
        }
        return fetch(url, options);
      },
    });
    assert.ok(rejected > 0);
    assert.equal(result.state, 'applied');
    assert.equal(
      (await f.cloud.query('SELECT count(*)::int count FROM cloud_cashier_orders')).rows[0].count,
      0,
    );
    assert.ok(
      (
        await f.pool.query(
          'SELECT count(*)::int count FROM cashier_report_outbox WHERE acknowledged_at IS NULL',
        )
      ).rows[0].count > 0,
    );
  }));

test('one oversized source snapshot is quarantined without blocking later valid reports', () =>
  fixture(async (f) => {
    await seed(f);
    const source = (
      await f.pool.query(
        "SELECT * FROM cashier_report_outbox WHERE kind='order' ORDER BY sequence LIMIT 1",
      )
    ).rows[0];
    const shift = (
      await f.pool.query(
        "SELECT * FROM cashier_report_outbox WHERE kind='shift' ORDER BY sequence DESC LIMIT 1",
      )
    ).rows[0];
    await f.pool.query('UPDATE cashier_report_outbox SET acknowledged_at=clock_timestamp()');
    const id = randomUUID();
    const payload = {
      ...source.payload,
      order_id: id,
      total_minor: '50',
      lines: Array.from({ length: 50 }, () => ({
        ...source.payload.lines[0],
        name: { ru: '界'.repeat(200), kk: '界'.repeat(200) },
        quantity: 1,
        unit_price_minor: '1',
        total_minor: '1',
      })),
    };
    const oversized = (
      await f.pool.query(
        "INSERT INTO cashier_report_outbox(branch_id,kind,entity_id,payload) VALUES($1,'order',$2,$3) RETURNING event_id",
        [f.scope.branchId, id, payload],
      )
    ).rows[0];
    await f.pool.query(
      "INSERT INTO cashier_report_outbox(branch_id,kind,entity_id,payload) VALUES($1,'shift',$2,$3)",
      [f.scope.branchId, shift.entity_id, shift.payload],
    );
    const pending = await pendingCashierReports(f.pool, f.scope.branchId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'shift');
    const saved = (
      await f.pool.query('SELECT * FROM cashier_report_outbox WHERE event_id=$1', [
        oversized.event_id,
      ])
    ).rows[0];
    assert.equal(saved.last_error, 'INVALID_REPORT_SOURCE');
    assert.equal(saved.acknowledged_at, null);
    assert.equal((await pendingCashierReports(f.pool, f.scope.branchId)).length, 1);
  }));
