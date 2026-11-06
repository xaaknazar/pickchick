import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { PosPaymentMethodSchema } from '@pickchick/contracts';
import {
  RestoredShiftReportError,
  acceptRestoredShiftReport,
  posSalePayloadHash,
  receivePosSales,
} from '../dist/index.js';
import { authFor } from '../../../tests/helpers/sync.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import { grantBackoffice } from '../../backoffice-core/dist/index.js';
import { posSyncReceiverGrants } from '../../../infra/windows/pos-sync-worker-grants.mjs';
import { cloudPosSalesGrants } from '../../../infra/staging/pos-sales-grants.mjs';
import { backofficeGrants } from '../../../infra/staging/backoffice-grants.mjs';
import {
  cashSale,
  vectorEvent,
  withPosSalesDatabases,
  zReportFor,
} from './sales-cloud-fixture.mjs';

// CR cloud-5 item 2, option A (lead decision 06.11): acceptRestoredShiftReport, the cloud owner
// command that accepts as written the Z of a sales shift that was open across an edge database
// restore. The receiver keeps refusing that Z; only this command stores it, only for that case,
// once. Synthetic data only.

/** edge_restore_fence moves the posSales number of a restored edge by 10^9 (023, CR cloud-5). */
const GAP = 1_000_000_000n;
const after = (n) => String(GAP + BigInt(n));
const REASON = 'Z смены через восстановление кассы (синтетика)';

/** The Z the edge writes for `sales` of the shift (counted cash = expected), at `sequence`. */
function zOf(branch, sales, sequence, shiftId) {
  return vectorEvent('shift_report_z', branch, (p, event) => {
    event.event_id = randomUUID();
    event.sequence = sequence;
    if (shiftId) p.shift_id = p.report.shift_id = shiftId;
    const base = {
      cash_out_minor: '0',
      terminal_reported_minor: null,
      terminal_discrepancy_minor: null,
    };
    const expected = zReportFor(sales, p.report, base).expected_cash_minor;
    p.report = zReportFor(sales, p.report, { ...base, counted_cash_minor: expected });
  });
}
function inShift(event, shiftId) {
  event.payload.shift_id = shiftId;
  return event;
}
const refusal = (code, reason) => (error) =>
  error instanceof RestoredShiftReportError && error.code === code && error.reason === reason;
const rows = async (pool) =>
  Object.fromEntries(
    await Promise.all(
      [
        'cloud_pos_sale_inbox',
        'cloud_pos_sales',
        'cloud_pos_shift_reports',
        'bo_audit',
        'bo_commands',
      ].map(async (table) => [
        table,
        Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count),
      ]),
    ),
  );

/** A real LOGIN role holding exactly `grants` on the cloud test schema. */
async function restricted(ctx, grants, run) {
  const role = 'restored_z_' + randomUUID().replaceAll('-', ''),
    secret = randomBytes(32).toString('hex');
  let pool;
  try {
    await ctx.cloud.admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    await ctx.cloud.pool.query(grants(role, ctx.cloud.schema));
    const url = new URL(ctx.cloud.config.databaseUrl);
    url.username = role;
    url.password = secret;
    pool = createPool(url.toString());
    await run(pool);
  } finally {
    await pool?.end();
    await ctx.cloud.admin.query(`DROP OWNED BY ${role}`);
    await ctx.cloud.admin.query(`DROP ROLE ${role}`);
  }
}

test('acceptRestoredShiftReport: only the cloud owner, for a manager, accepts the parked Z of a restored shift as written, once; the stream then flows', async () => {
  await withPosSalesDatabases(async (ctx) => {
    const auth = authFor(ctx.identity);
    const person = async (name, role) => {
      const p = await provisionCatalogManager(ctx.cloud.pool, {
        organization_id: ctx.org,
        name,
        branch_ids: [ctx.branch],
      });
      await grantBackoffice(ctx.cloud.pool, p.actor_id, ctx.branch, role);
      return p.actor_id;
    };
    const manager = await person('Синтетический управляющий', 'manager');
    const analyst = await person('Синтетический аналитик', 'analyst');
    // Sale 1 before the copy, sale 2 of the lost timeline (the cloud has it, the restored edge
    // does not), sale 3 after the fence; the Z of the restored edge lacks sale 2.
    const kept = cashSale(ctx.branch, 1, 1),
      lost = cashSale(ctx.branch, 2, 2),
      restored = cashSale(ctx.branch, after(10), 3);
    assert.equal(
      (await receivePosSales(ctx.cloud.pool, auth, { events: [kept, lost] })).receipts.length,
      2,
    );
    const z = zOf(ctx.branch, [kept, restored], after(20));
    const refused = [];
    const parked = await receivePosSales(
      ctx.cloud.pool,
      auth,
      { events: [restored, z] },
      { onRejected: (rejection) => refused.push(rejection.reason) },
    );
    assert.equal(parked.receipts.length, 1);
    assert.deepEqual(parked.rejected, { event_id: z.event_id, code: 'INVALID_EVENT' });
    assert.deepEqual(refused, ['shift_cash']);
    const before = await rows(ctx.cloud.pool);
    const request = (change = {}) => ({
      branchId: ctx.branch,
      deviceId: ctx.device,
      actorId: manager,
      requestId: randomUUID(),
      reason: REASON,
      payloadHash: posSalePayloadHash(z),
      event: z,
      ...change,
    });
    const accept = (change, pool = ctx.cloud.pool) =>
      acceptRestoredShiftReport(pool, request(change));

    // Request and wire model: nothing is looked up.
    for (const reason of ['ab', 'я'.repeat(301), '   ab   '])
      await assert.rejects(accept({ reason }), refusal('INVALID_REQUEST', 'request'));
    await assert.rejects(
      accept({ requestId: 'not-a-uuid' }),
      refusal('INVALID_REQUEST', 'request'),
    );
    await assert.rejects(
      accept({ payloadHash: posSalePayloadHash(restored) }),
      refusal('INVALID_REQUEST', 'model'),
    );
    await assert.rejects(
      accept({ event: { ...z, payload: { ...z.payload, extra: true } } }),
      refusal('INVALID_REQUEST', 'model'),
    );
    await assert.rejects(accept({ branchId: randomUUID() }), refusal('INVALID_REQUEST', 'model'));
    // Voids and refunds never go around their limits.
    const voided = vectorEvent('void_cash_sale', ctx.branch, (p, event) => {
      event.sequence = after(21);
    });
    await assert.rejects(
      accept({ event: voided, payloadHash: posSalePayloadHash(voided) }),
      refusal('CONFLICT', 'not_shift_report'),
    );

    // Not the owner: the API role with the receiver and the back-office grants (it may write
    // every table the command writes) is refused before anything is read.
    const api = (role, schema) =>
      posSyncReceiverGrants(role, schema) +
      '\n' +
      cloudPosSalesGrants(role, { receiver: true, backoffice: true }, schema) +
      '\n' +
      backofficeGrants(role, true);
    await restricted(ctx, api, async (pool) => {
      await assert.rejects(accept({}, pool), refusal('FORBIDDEN', 'not_owner'));
    });
    // Not a manager of the branch: an analyst, an unknown login, a revoked manager.
    await assert.rejects(accept({ actorId: analyst }), refusal('FORBIDDEN', 'actor'));
    await assert.rejects(accept({ actorId: randomUUID() }), refusal('FORBIDDEN', 'actor'));
    const revoked = await person('Синтетический бывший управляющий', 'manager');
    await ctx.cloud.pool.query('UPDATE catalog_managers SET revoked_at=now() WHERE id=$1', [
      revoked,
    ]);
    await assert.rejects(accept({ actorId: revoked }), refusal('FORBIDDEN', 'actor'));
    // An inactive POS sync binding, or a device that is not the edge of the branch.
    await ctx.cloud.pool.query(
      'UPDATE pos_order_sync_bindings SET active=false WHERE device_id=$1',
      [ctx.device],
    );
    await assert.rejects(accept({}), refusal('FORBIDDEN', 'binding'));
    await ctx.cloud.pool.query(
      'UPDATE pos_order_sync_bindings SET active=true WHERE device_id=$1',
      [ctx.device],
    );
    await assert.rejects(accept({ deviceId: randomUUID() }), refusal('FORBIDDEN', 'binding'));

    // A Z that is not parked for this reason. Agreeing with the cloud: the receiver takes it.
    const agreeing = zOf(ctx.branch, [kept, lost, restored], after(20));
    await assert.rejects(
      accept({ event: agreeing, payloadHash: posSalePayloadHash(agreeing) }),
      refusal('CONFLICT', 'not_parked'),
    );
    // More than the cloud holds (a Z never misses fewer events than the edge sent).
    const extra = cashSale(ctx.branch, after(19), 4);
    const more = zOf(ctx.branch, [kept, lost, restored, extra], after(20));
    await assert.rejects(
      accept({ event: more, payloadHash: posSalePayloadHash(more) }),
      refusal('CONFLICT', 'not_restore'),
    );
    // Nothing was written by any refusal.
    assert.deepEqual(await rows(ctx.cloud.pool), before);

    // The owner command for the manager: the Z exactly as the edge wrote it, and the difference.
    const first = request();
    const accepted = await acceptRestoredShiftReport(ctx.cloud.pool, first);
    const methods = PosPaymentMethodSchema.options.map((method) => ({
      method,
      z_sales_minor: method === 'cash' ? '700000' : '0',
      cloud_sales_minor: method === 'cash' ? '1050000' : '0',
      z_refunds_minor: '0',
      cloud_refunds_minor: '0',
      z_count: method === 'cash' ? 2 : 0,
      cloud_count: method === 'cash' ? 3 : 0,
    }));
    assert.deepEqual(accepted, {
      state: 'accepted',
      event_id: z.event_id,
      sequence: z.sequence,
      shift_id: z.payload.shift_id,
      rejected_as: 'shift_cash',
      cash: {
        z_sales_minor: '700000',
        cloud_sales_minor: '1050000',
        z_refunds_minor: '0',
        cloud_refunds_minor: '0',
      },
      methods,
    });
    const stored = (
      await ctx.cloud.pool.query(
        `SELECT device_id,terminal_id,report,expected_cash_minor::text AS expected,
         counted_cash_minor::text AS counted,discrepancy_minor::text AS discrepancy
         FROM cloud_pos_shift_reports WHERE shift_id=$1`,
        [z.payload.shift_id],
      )
    ).rows;
    assert.deepEqual(stored, [
      {
        device_id: ctx.device,
        terminal_id: z.payload.terminal_id,
        report: z.payload.report,
        expected: '1700000',
        counted: '1700000',
        discrepancy: '0',
      },
    ]);
    const inbox = (
      await ctx.cloud.pool.query(
        `SELECT device_id,sequence::text AS sequence,kind,payload_hash FROM cloud_pos_sale_inbox
         WHERE event_id=$1`,
        [z.event_id],
      )
    ).rows;
    assert.deepEqual(inbox, [
      {
        device_id: ctx.device,
        sequence: z.sequence,
        kind: 'shift_report',
        payload_hash: first.payloadHash,
      },
    ]);
    const audit = (
      await ctx.cloud.pool.query(
        `SELECT actor_id,request_id,action,entity_id,reason,before_value,after_value FROM bo_audit
         WHERE branch_id=$1`,
        [ctx.branch],
      )
    ).rows;
    assert.deepEqual(audit, [
      {
        actor_id: manager,
        request_id: first.requestId,
        action: 'pos_sales:accept_restored_z',
        entity_id: z.payload.shift_id,
        reason: REASON,
        before_value: { device_id: ctx.device, event_id: z.event_id, sequence: z.sequence },
        after_value: accepted,
      },
    ]);
    const after1 = await rows(ctx.cloud.pool);
    assert.deepEqual(after1, {
      ...before,
      cloud_pos_sale_inbox: before.cloud_pos_sale_inbox + 1,
      cloud_pos_shift_reports: before.cloud_pos_shift_reports + 1,
      bo_audit: before.bo_audit + 1,
      bo_commands: before.bo_commands + 1,
    });

    // A replay is a no-op: the same request returns the stored answer; another request id sees
    // the Z already accepted; the same request id with other arguments is refused.
    assert.deepEqual(await acceptRestoredShiftReport(ctx.cloud.pool, first), accepted);
    assert.deepEqual(await accept({}), {
      state: 'duplicate',
      event_id: z.event_id,
      sequence: z.sequence,
      shift_id: z.payload.shift_id,
    });
    await assert.rejects(
      acceptRestoredShiftReport(ctx.cloud.pool, { ...first, reason: REASON + ' (2)' }),
      refusal('CONFLICT', 'request_reused'),
    );
    assert.deepEqual(await rows(ctx.cloud.pool), after1);

    // The edge sends the Z again after the owner releases it: a duplicate, and the stream goes on.
    const next = inShift(cashSale(ctx.branch, after(30), 5), randomUUID());
    const flowing = await receivePosSales(ctx.cloud.pool, auth, { events: [z, next] });
    assert.equal(flowing.receipts.length, 2);
    assert.equal(flowing.rejected, undefined);

    // Another identity at the accepted number, a second Z of the shift, a Z behind accepted
    // events: each is another fault, refused.
    const twin = { ...z, event_id: randomUUID() };
    await assert.rejects(
      accept({ event: twin, payloadHash: posSalePayloadHash(twin) }),
      refusal('CONFLICT', 'identity'),
    );
    const second = zOf(ctx.branch, [kept, restored], after(40));
    await assert.rejects(
      accept({ event: second, payloadHash: posSalePayloadHash(second) }),
      refusal('CONFLICT', 'shift_identity'),
    );
    const behind = zOf(ctx.branch, [], after(25), randomUUID());
    await assert.rejects(
      accept({ event: behind, payloadHash: posSalePayloadHash(behind) }),
      refusal('CONFLICT', 'not_head'),
    );
    // A mismatching Z of a shift that never crossed a restore fence (an edge fault, not a
    // restore) is not accepted either.
    const shift = randomUUID();
    const one = inShift(cashSale(ctx.branch, after(50), 6), shift),
      missed = inShift(cashSale(ctx.branch, after(51), 7), shift);
    assert.equal(
      (await receivePosSales(ctx.cloud.pool, auth, { events: [one, missed] })).receipts.length,
      2,
    );
    const unfenced = zOf(ctx.branch, [one], after(52), shift);
    assert.equal(
      (await receivePosSales(ctx.cloud.pool, auth, { events: [unfenced] })).rejected?.code,
      'INVALID_EVENT',
    );
    await assert.rejects(
      accept({ event: unfenced, payloadHash: posSalePayloadHash(unfenced) }),
      refusal('CONFLICT', 'not_restore'),
    );
    assert.equal(
      Number(
        (await ctx.cloud.pool.query('SELECT count(*) FROM cloud_pos_shift_reports')).rows[0].count,
      ),
      1,
    );
  });
});
