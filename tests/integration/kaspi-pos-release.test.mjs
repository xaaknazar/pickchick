import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createPool, migrate, transaction } from '@pickchick/database';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';
import { assertKaspiPosReleaseRuntimePrivileges } from '../../infra/windows/kaspi-pos-release-grants.mjs';
import { createEdge } from '@pickchick/edge';
import { applyMenu, hashToken, publishMenu } from '@pickchick/menu-sync';
import {
  approvalSubjectHash,
  closeCashShift,
  createPosSale,
  createQuote,
  createTerminalPayment,
  listOpenTerminalPayments,
  provisionStaff,
  readShiftReport,
  readShiftTerminalReleases,
  readTerminalPayment,
  releaseTerminalPayment,
  requestManagerApproval,
  setOrdering,
  setStaffPin,
  useTerminalAttempt,
} from '@pickchick/local-orders';
import { localUnpaidExecution, provisionFulfillment } from '@pickchick/edge-fulfillment';
import {
  ManagerApprovalActionSchema,
  PosShiftReportSchema,
  PosTerminalPaymentSchema,
  PosTerminalReleaseListSchema,
  PosTerminalReleaseRequestSchema,
} from '@pickchick/contracts';
import { request, running, withSyncDatabases } from '../helpers/sync.mjs';
import { staffAuth, staffHeaders } from '../helpers/orders.mjs';

// Edge schema030 (owner decision 28.11.2026): the guest paid on the Kaspi terminal and the order
// cannot be made - the refund is made by hand on the terminal and the shift manager releases the
// payment with the PIN that cancels and refunds (approval action terminal_release). Real
// PostgreSQL, scripted terminal as in kaspi-pos.test.mjs. Synthetic data only.
const code = (expected) => (error) => error.code === expected;
const CERT = 'a'.repeat(64);
const MANAGER_PIN = '2468';
const CASHIER_PIN = '135790';
const REASON = 'Возврат сделан на терминале';

function simulator() {
  const script = { status: [] };
  let process = 0;
  return {
    script,
    async call(_link, method) {
      const next = script[method]?.shift();
      if (next) return next;
      if (method === 'payment')
        return { kind: 'ok', data: { processId: `p${++process}`, status: 'wait' } };
      if (method === 'status' || method === 'actualize')
        return { kind: 'ok', data: { status: 'wait', subStatus: 'WaitUser' } };
      return { kind: 'unreachable', reason: 'CONNECT' };
    },
  };
}
const success = (transactionId = 'SYN-TXN-1') => ({
  kind: 'ok',
  data: {
    status: 'success',
    subStatus: 'QrTransactionSuccess',
    transactionId,
    chequeInfo: { method: 'qr', amount: '2 990 ₸', orderNumber: 'SYN-ORDER' },
  },
});

async function setting(pool, branch, subject, before, after) {
  await pool.query(
    `INSERT INTO pos_sales_setting_changes(change_id,branch_id,subject,before,after,actor,reason)
     VALUES($1,$2,$3,$4,$5,'operator','Синтетика Kaspi')`,
    [randomUUID(), branch, subject, before, after],
  );
}
async function prepare(ctx) {
  const edge = ctx.edge.pool;
  const release = ctx.menu();
  await applyMenu(edge, ctx.branch, await publishMenu(ctx.cloud.pool, release));
  const person = (role, terminal = randomUUID()) => ({
    staff_id: randomUUID(),
    terminal_id: terminal,
    name: 'Синтетический сотрудник',
    role,
  });
  // A PIN revokes the bootstrap session; the desk then gets a fresh one.
  const withPin = async (setup, pin) => {
    await setStaffPin(
      edge,
      ctx.branch,
      staffAuth(await provisionStaff(edge, ctx.branch, setup)),
      pin,
    );
    return provisionStaff(edge, ctx.branch, setup);
  };
  const cashierSetup = person('cashier');
  const cashier = await provisionStaff(edge, ctx.branch, cashierSetup);
  const manager = await withPin(person('shift_manager', cashier.terminal_id), MANAGER_PIN);
  // Another cashier of the same desk (the first one went home) and a second desk.
  const colleague = await withPin(person('cashier', cashier.terminal_id), CASHIER_PIN);
  const other = await provisionStaff(edge, ctx.branch, person('cashier'));
  const otherManager = await provisionStaff(
    edge,
    ctx.branch,
    person('shift_manager', other.terminal_id),
  );
  const prep = randomUUID(),
    assembly = randomUUID();
  await provisionFulfillment(edge, {
    organizationId: ctx.org,
    branchId: ctx.branch,
    deviceId: ctx.device,
    producerId: randomUUID(),
    stations: [
      { id: prep, kind: 'prep', name: 'Synthetic prep' },
      { id: assembly, kind: 'assembly', name: 'Synthetic assembly' },
    ],
    routing: {
      version: 1,
      assemblyStationId: assembly,
      routes: release.items.map((item) => ({
        productId: item.product_id,
        stationId: prep,
        kind: 'prep',
      })),
    },
  });
  await setOrdering(edge, ctx.branch, staffAuth(manager), randomUUID(), true, {
    expected_version: 1,
  });
  await transaction(edge, async (client) => {
    await setting(
      client,
      ctx.branch,
      'pos_service_mode',
      { pos_service_mode: 'payment_required' },
      { pos_service_mode: 'pos_sale' },
    );
    await client.query("UPDATE branch_config SET pos_service_mode='pos_sale' WHERE id=$1", [
      ctx.branch,
    ]);
  });
  for (const method of ['cash', 'kaspi_terminal'])
    await transaction(edge, async (client) => {
      await setting(
        client,
        ctx.branch,
        method,
        { enabled: false, fiscal_policy: 'manual_webkassa' },
        { enabled: true, fiscal_policy: 'manual_webkassa' },
      );
      await client.query(
        'UPDATE pos_payment_methods SET enabled=true WHERE branch_id=$1 AND code=$2',
        [ctx.branch, method],
      );
    });
  const shifts = {};
  for (const desk of [cashier, other]) {
    shifts[desk.terminal_id] = randomUUID();
    await edge.query(
      'INSERT INTO local_cash_shifts(id,branch_id,staff_id,terminal_id,opening_cash_minor,sales_mode) VALUES($1,$2,$3,$4,0,true)',
      [shifts[desk.terminal_id], ctx.branch, manager.staff_id, desk.terminal_id],
    );
  }
  for (const terminal of [cashier.terminal_id, other.terminal_id])
    await edge.query(
      `INSERT INTO kaspi_pos_devices(id,branch_id,terminal_id,host,certificate_sha256,integration_name,
       access_token,refresh_token,token_expires_at) VALUES($1,$2,$3,'192.168.2.50',$4,'PickChick-1',
       'access-token-0','refresh-token-0','2099-01-01T00:00:00Z')`,
      [randomUUID(), ctx.branch, terminal, CERT],
    );
  return {
    ...ctx,
    release,
    cashier,
    manager,
    colleague,
    other,
    otherManager,
    shift: shifts[cashier.terminal_id],
    otherShift: shifts[other.terminal_id],
    port: simulator(),
    execution: localUnpaidExecution({ enabled: true, deviceId: ctx.device }),
  };
}
const desk = (run) => withSyncDatabases(async (ctx) => run(await prepare(ctx)));
const quote = (ctx, actor = ctx.cashier) =>
  createQuote(ctx.edge.pool, ctx.branch, staffAuth(actor), {
    release_id: ctx.release.release_id,
    service_mode: 'takeaway',
    items: [{ variant_id: ctx.release.items[0].variant_id, quantity: 1 }],
  });
/** A quote paid on the terminal by `actor`; returns the quote and the paid attempt. */
async function paid(ctx, actor = ctx.cashier, transactionId = `SYN-${randomUUID().slice(0, 8)}`) {
  const q = await quote(ctx, actor);
  const started = await createTerminalPayment(
    ctx.edge.pool,
    ctx.branch,
    staffAuth(actor),
    randomUUID(),
    { quote_id: q.quote_id, amount_minor: q.total_minor },
    ctx.port,
  );
  ctx.port.script.status.push(success(transactionId));
  const done = await readTerminalPayment(
    ctx.edge.pool,
    ctx.branch,
    staffAuth(actor),
    started.attempt_id,
    ctx.port,
  );
  assert.equal(done.state, 'success');
  return { q, attemptId: started.attempt_id, attempt: done };
}
const subjectOf = ({ q }) => ({ quote_id: q.quote_id, amount_minor: q.total_minor });
/** An approval issued by SQL (the PIN path has its own test): the manager of the desk, 120 s. */
async function grant(ctx, action, subject, { terminal = ctx.cashier.terminal_id } = {}) {
  const proof = { approval_id: randomUUID(), token: randomBytes(32).toString('hex') };
  await ctx.edge.pool.query(
    `INSERT INTO local_manager_approvals(id,branch_id,terminal_id,manager_staff_id,requested_by_staff_id,
     action,subject,subject_hash,token_hash,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+interval '120 seconds')`,
    [
      proof.approval_id,
      ctx.branch,
      terminal,
      terminal === ctx.cashier.terminal_id ? ctx.manager.staff_id : ctx.otherManager.staff_id,
      terminal === ctx.cashier.terminal_id ? ctx.cashier.staff_id : ctx.other.staff_id,
      action,
      subject,
      approvalSubjectHash(action, subject),
      hashToken(proof.token),
    ],
  );
  return proof;
}
const release = (
  ctx,
  attemptId,
  approval,
  { actor = ctx.manager, key = randomUUID(), body = {} } = {},
) =>
  releaseTerminalPayment(ctx.edge.pool, ctx.branch, staffAuth(actor), key, attemptId, {
    reason: REASON,
    refunded_on_terminal: true,
    ...(approval ? { approval } : {}),
    ...body,
  });
const releases = async (ctx) =>
  (await ctx.edge.pool.query('SELECT * FROM kaspi_pos_attempt_releases ORDER BY released_at')).rows;
const open = (ctx, actor = ctx.cashier) =>
  listOpenTerminalPayments(ctx.edge.pool, ctx.branch, staffAuth(actor));
const sellWith = (ctx, q, attemptId, actor = ctx.cashier, extra = {}) =>
  createPosSale(
    ctx.edge.pool,
    ctx.branch,
    staffAuth(actor),
    randomUUID(),
    {
      quote_id: q.quote_id,
      service_mode_confirmed: true,
      order_repeated: true,
      tenders: [{ method: 'kaspi_terminal', amount_minor: q.total_minor, attempt_id: attemptId }],
      ...extra,
    },
    ctx.execution,
  );
const closeShift = (ctx, shiftId, actor = ctx.manager) =>
  closeCashShift(ctx.edge.pool, ctx.branch, staffAuth(actor), randomUUID(), shiftId, {
    expected_version: 1,
    counted_cash_minor: '0',
    reason: 'Синтетическое закрытие',
  });

test('the action list of the database equals the contract and the release request is strict', async () => {
  await desk(async (ctx) => {
    const definition = (
      await ctx.edge.pool.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid='local_manager_approvals'::regclass AND contype='c' AND conname='local_manager_approvals_action_check'`,
      )
    ).rows[0].def;
    const listed = [...definition.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    assert.deepEqual(listed, [...ManagerApprovalActionSchema.options].sort());
    assert.ok(ManagerApprovalActionSchema.options.includes('terminal_release'));
    const base = {
      reason: REASON,
      refunded_on_terminal: true,
      approval: { approval_id: randomUUID(), token: 'a'.repeat(64) },
    };
    PosTerminalReleaseRequestSchema.parse(base);
    for (const bad of [
      { ...base, refunded_on_terminal: false },
      { ...base, reason: 'да' },
      { ...base, extra: 1 },
    ])
      assert.equal(PosTerminalReleaseRequestSchema.safeParse(bad).success, false);
  });
});

test('a paid attempt without an order is released by the shift manager PIN of the desk', async () => {
  await desk(async (ctx) => {
    const { q, attemptId, attempt } = await paid(ctx);
    // The last two keys of the attempt are the new ones; nothing before them moved.
    assert.deepEqual(Object.keys(attempt).slice(-2), ['staff_id', 'released_at']);
    assert.equal(attempt.staff_id, ctx.cashier.staff_id);
    assert.equal(attempt.released_at, null);
    assert.deepEqual(
      (await open(ctx)).items.map((item) => item.attempt_id),
      [attemptId],
    );
    const done = await release(
      ctx,
      attemptId,
      await grant(ctx, 'terminal_release', subjectOf({ q, attemptId })),
    );
    PosTerminalPaymentSchema.parse(done);
    assert.equal(done.attempt_id, attemptId);
    assert.equal(done.state, 'success');
    assert.equal(done.order_id, null);
    assert.ok(done.released_at);
    const [row] = await releases(ctx);
    assert.equal(row.attempt_id, attemptId);
    assert.equal(row.shift_id, ctx.shift);
    assert.equal(row.amount_minor, q.total_minor);
    assert.equal(row.transaction_id, attempt.transaction_id);
    assert.equal(row.attempt_staff_id, ctx.cashier.staff_id);
    assert.equal(row.released_by_staff_id, ctx.manager.staff_id);
    assert.equal(row.manager_staff_id, ctx.manager.staff_id);
    assert.equal(row.reason, REASON);
    assert.equal(
      (
        await ctx.edge.pool.query(
          'SELECT consumed_at IS NOT NULL AS spent FROM local_manager_approvals WHERE id=$1',
          [row.approval_id],
        )
      ).rows[0].spent,
      true,
    );
    const audit = (
      await ctx.edge.pool.query(
        "SELECT action,resource_id FROM local_audit WHERE action LIKE 'kaspi_pos.payment_released|%'",
      )
    ).rows;
    assert.equal(audit.length, 1);
    assert.equal(
      audit[0].action,
      `kaspi_pos.payment_released|attempt=${attemptId}|amount=${q.total_minor}|manager=${ctx.manager.staff_id}|txn=${attempt.transaction_id}`,
    );
    assert.equal(audit[0].resource_id, attemptId);
    // Gone from the list; the desk reads it as released; it cannot be sold or released again.
    assert.deepEqual((await open(ctx)).items, []);
    const read = await readTerminalPayment(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.cashier),
      attemptId,
      ctx.port,
    );
    assert.equal(read.released_at, done.released_at);
    await assert.rejects(
      transaction(ctx.edge.pool, (client) =>
        useTerminalAttempt(
          client,
          ctx.branch,
          ctx.cashier.terminal_id,
          q.quote_id,
          attemptId,
          q.total_minor,
          null,
        ),
      ),
      code('TERMINAL_ATTEMPT_INVALID'),
    );
    await assert.rejects(sellWith(ctx, q, attemptId), code('TERMINAL_ATTEMPT_INVALID'));
    assert.equal((await ctx.edge.pool.query('SELECT 1 FROM local_orders')).rowCount, 0);
    // The same quote can be paid again by a new attempt, and that one is sold.
    const again = await createTerminalPayment(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.cashier),
      randomUUID(),
      { quote_id: q.quote_id, amount_minor: q.total_minor },
      ctx.port,
    );
    assert.notEqual(again.attempt_id, attemptId);
    assert.equal(again.released_at, null);
    ctx.port.script.status.push(success('SYN-TXN-AGAIN'));
    await readTerminalPayment(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.cashier),
      again.attempt_id,
      ctx.port,
    );
    const sold = await sellWith(ctx, q, again.attempt_id);
    assert.equal(sold.order.state, 'paid');
  });
});

test('refusals: no approval, wrong approval, other desk, bad input, wrong attempt - nothing is spent', async () => {
  await desk(async (ctx) => {
    const one = await paid(ctx);
    const subject = subjectOf(one);
    await assert.rejects(release(ctx, one.attemptId, undefined), code('APPROVAL_REQUIRED'));
    // Another action, another amount, another quote, another desk, a made-up token.
    for (const [action, wrong, terminal] of [
      ['refund', subject, undefined],
      ['void', subject, undefined],
      ['terminal_release', { ...subject, amount_minor: '100' }, undefined],
      ['terminal_release', { ...subject, quote_id: randomUUID() }, undefined],
      ['terminal_release', subject, ctx.other.terminal_id],
    ]) {
      const approval = await grant(ctx, action, wrong, terminal ? { terminal } : {});
      await assert.rejects(release(ctx, one.attemptId, approval), code('APPROVAL_INVALID'));
    }
    await assert.rejects(
      release(ctx, one.attemptId, {
        approval_id: randomUUID(),
        token: randomBytes(32).toString('hex'),
      }),
      code('APPROVAL_INVALID'),
    );
    // A token that is not the approval's own.
    const real = await grant(ctx, 'terminal_release', subject);
    await assert.rejects(
      release(ctx, one.attemptId, { ...real, token: randomBytes(32).toString('hex') }),
      code('APPROVAL_INVALID'),
    );
    // A cashier is not a manager: the PIN path refuses to issue the approval at all.
    await assert.rejects(
      requestManagerApproval(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), {
        staff_id: ctx.colleague.staff_id,
        pin: CASHIER_PIN,
        action: 'terminal_release',
        subject,
      }),
      code('FORBIDDEN'),
    );
    // And the table itself refuses an approval of a cashier.
    await assert.rejects(
      ctx.edge.pool.query(
        `INSERT INTO local_manager_approvals(id,branch_id,terminal_id,manager_staff_id,requested_by_staff_id,
         action,subject,subject_hash,token_hash,expires_at)
         VALUES($1,$2,$3,$4,$4,'terminal_release',$5,$6,$7,clock_timestamp()+interval '120 seconds')`,
        [
          randomUUID(),
          ctx.branch,
          ctx.cashier.terminal_id,
          ctx.cashier.staff_id,
          subject,
          'a'.repeat(64),
          'c'.repeat(64),
        ],
      ),
      code('23514'),
    );
    // Bad input and unknown attempts.
    await assert.rejects(release(ctx, 'not-a-uuid', real), code('INVALID_REQUEST'));
    await assert.rejects(
      release(ctx, one.attemptId, real, { body: { refunded_on_terminal: false } }),
      code('INVALID_REQUEST'),
    );
    await assert.rejects(
      release(ctx, one.attemptId, real, { body: { reason: 'да' } }),
      code('INVALID_REQUEST'),
    );
    await assert.rejects(
      release(ctx, one.attemptId, real, { key: 'nope' }),
      code('INVALID_REQUEST'),
    );
    await assert.rejects(release(ctx, randomUUID(), real), code('NOT_FOUND'));
    // A cashier of the other desk: without an approval nothing; with this desk's approval - it is
    // not spent on that desk.
    await assert.rejects(
      release(ctx, one.attemptId, undefined, { actor: ctx.other }),
      code('APPROVAL_REQUIRED'),
    );
    await assert.rejects(
      release(ctx, one.attemptId, real, { actor: ctx.other }),
      code('APPROVAL_INVALID'),
    );
    // The edge database holds one branch (branch_config is a singleton): "another branch" is an
    // attempt this database has never seen, and every query names the branch of the session.
    // Nothing was released and the real approval is still unspent.
    assert.deepEqual(await releases(ctx), []);
    assert.equal(
      (
        await ctx.edge.pool.query(
          'SELECT consumed_at IS NULL AS unspent FROM local_manager_approvals WHERE id=$1',
          [real.approval_id],
        )
      ).rows[0].unspent,
      true,
    );
    // An attempt that is not paid, and one that already pays an order.
    const q2 = await quote(ctx);
    const waiting = await createTerminalPayment(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.cashier),
      randomUUID(),
      { quote_id: q2.quote_id, amount_minor: q2.total_minor },
      ctx.port,
    );
    assert.equal(waiting.state, 'wait');
    await assert.rejects(
      release(ctx, waiting.attempt_id, await grant(ctx, 'terminal_release', subjectOf({ q: q2 }))),
      code('TERMINAL_ATTEMPT_INVALID'),
    );
    ctx.port.script.status.push({
      kind: 'ok',
      data: { status: 'fail', subStatus: 'ProcessCancelled', message: 'Отменено' },
    });
    await readTerminalPayment(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.cashier),
      waiting.attempt_id,
      ctx.port,
    );
    await assert.rejects(
      release(ctx, waiting.attempt_id, await grant(ctx, 'terminal_release', subjectOf({ q: q2 }))),
      code('TERMINAL_ATTEMPT_INVALID'),
    );
    const sold = await sellWith(ctx, one.q, one.attemptId);
    assert.ok(sold.order.order_id);
    await assert.rejects(
      release(ctx, one.attemptId, await grant(ctx, 'terminal_release', subject)),
      code('TERMINAL_ATTEMPT_INVALID'),
    );
    assert.deepEqual(await releases(ctx), []);
  });
});

test('an attempt of another cashier of this desk is released from the manager session and from the cashier session with the manager PIN', async () => {
  await desk(async (ctx) => {
    const first = await paid(ctx, ctx.cashier);
    const second = await paid(ctx, ctx.cashier);
    // The manager session of the desk.
    await release(ctx, first.attemptId, await grant(ctx, 'terminal_release', subjectOf(first)));
    // Another cashier of the desk types the manager's PIN (the real approval route).
    const approval = await requestManagerApproval(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.colleague),
      {
        staff_id: ctx.manager.staff_id,
        pin: MANAGER_PIN,
        action: 'terminal_release',
        subject: subjectOf(second),
      },
    );
    const done = await release(
      ctx,
      second.attemptId,
      { approval_id: approval.approval_id, token: approval.token },
      { actor: ctx.colleague },
    );
    assert.equal(done.staff_id, ctx.cashier.staff_id);
    const rows = await releases(ctx);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => [row.attempt_staff_id, row.released_by_staff_id, row.manager_staff_id]),
      [
        [ctx.cashier.staff_id, ctx.manager.staff_id, ctx.manager.staff_id],
        [ctx.cashier.staff_id, ctx.colleague.staff_id, ctx.manager.staff_id],
      ],
    );
    assert.deepEqual((await open(ctx, ctx.colleague)).items, []);
  });
});

test('a replay with the same key returns the same answer, a new key finds the attempt released', async () => {
  await desk(async (ctx) => {
    const one = await paid(ctx);
    const approval = await grant(ctx, 'terminal_release', subjectOf(one));
    const key = randomUUID();
    const first = await release(ctx, one.attemptId, approval, { key });
    assert.deepEqual(await release(ctx, one.attemptId, approval, { key }), first);
    assert.equal((await releases(ctx)).length, 1);
    // The same key with another body is a conflict, never a second release.
    await assert.rejects(
      release(ctx, one.attemptId, approval, { key, body: { reason: 'Другая причина' } }),
      code('CONFLICT'),
    );
    await assert.rejects(
      release(ctx, one.attemptId, await grant(ctx, 'terminal_release', subjectOf(one))),
      code('TERMINAL_ATTEMPT_INVALID'),
    );
    assert.equal((await releases(ctx)).length, 1);
  });
});

test('no open sales shift of the desk: CASH_SHIFT_REQUIRED, and an edge without 030 does not know the route', async () => {
  await desk(async (ctx) => {
    const one = await paid(ctx);
    // Closing over a paid, unsold payment is refused since 030; close as an edge without its row.
    const ledger = (
      await ctx.edge.pool.query(
        "DELETE FROM schema_migrations WHERE version='030_edge_kaspi_pos_release.sql' RETURNING *",
      )
    ).rows[0];
    await assert.rejects(
      release(ctx, one.attemptId, await grant(ctx, 'terminal_release', subjectOf(one))),
      code('NOT_FOUND'),
    );
    await closeShift(ctx, ctx.shift);
    await ctx.edge.pool.query(
      'INSERT INTO schema_migrations(version,checksum,scope) VALUES($1,$2,$3)',
      [ledger.version, ledger.checksum, ledger.scope],
    );
    await assert.rejects(
      release(ctx, one.attemptId, await grant(ctx, 'terminal_release', subjectOf(one))),
      code('CASH_SHIFT_REQUIRED'),
    );
    assert.deepEqual(await releases(ctx), []);
  });
});

test('SQL: a release is append-only, needs its consumed approval and an open shift; a released attempt takes no order', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const one = await paid(ctx);
    const two = await paid(ctx);
    const insert = (attemptId, approvalId, overrides = {}) => {
      const values = {
        shift_id: ctx.shift,
        amount_minor: null,
        transaction_id: null,
        manager: ctx.manager.staff_id,
        ...overrides,
      };
      return pool.query(
        `INSERT INTO kaspi_pos_attempt_releases(attempt_id,branch_id,attempt_terminal_id,terminal_id,shift_id,
         amount_minor,transaction_id,attempt_staff_id,released_by_staff_id,manager_staff_id,approval_id,reason)
         SELECT id,branch_id,terminal_id,coalesce($8::uuid,terminal_id),$2,coalesce($3::bigint,amount_minor),coalesce($4,transaction_id),
           staff_id,$5,$6,$7,'Синтетический возврат' FROM kaspi_pos_attempts WHERE id=$1`,
        [
          attemptId,
          values.shift_id,
          values.amount_minor,
          values.transaction_id,
          ctx.manager.staff_id,
          values.manager,
          approvalId,
          values.terminal ?? null,
        ],
      );
    };
    const unspent = await grant(ctx, 'terminal_release', subjectOf(one));
    // The approval was never consumed.
    await assert.rejects(insert(one.attemptId, unspent.approval_id), code('23514'));
    const spend = async (proof) => {
      await pool.query(
        'UPDATE local_manager_approvals SET consumed_at=clock_timestamp(),consumed_command_key=$2 WHERE id=$1',
        [proof.approval_id, randomUUID()],
      );
      return proof.approval_id;
    };
    const approvalId = await spend(unspent);
    // The approval is of another quote or amount than the attempt's (inserted around the code).
    const otherQuote = await spend(await grant(ctx, 'terminal_release', subjectOf(two)));
    await assert.rejects(insert(one.attemptId, otherQuote), code('23514'));
    const otherAmount = await spend(
      await grant(ctx, 'terminal_release', { ...subjectOf(one), amount_minor: '100' }),
    );
    await assert.rejects(insert(one.attemptId, otherAmount), code('23514'));
    // Another amount or operation number than the attempt's, another manager, an approval of another action.
    await assert.rejects(insert(one.attemptId, approvalId, { amount_minor: '100' }), code('23514'));
    await assert.rejects(
      insert(one.attemptId, approvalId, { transaction_id: 'OTHER' }),
      code('23514'),
    );
    await assert.rejects(
      insert(one.attemptId, approvalId, { manager: ctx.colleague.staff_id }),
      code('23514'),
    );
    const refund = await spend(await grant(ctx, 'refund', subjectOf(one)));
    await assert.rejects(insert(one.attemptId, refund), code('23514'));
    // Another shift (the other desk's) is not this desk's open sales shift.
    await assert.rejects(
      insert(one.attemptId, approvalId, { shift_id: ctx.otherShift }),
      code('23514'),
    );
    // From the other desk: its open shift and its own approval; the shift of the attempt's desk is not it.
    const four = await paid(ctx);
    const fromOther = await spend(
      await grant(ctx, 'terminal_release', subjectOf(four), { terminal: ctx.other.terminal_id }),
    );
    await assert.rejects(
      insert(four.attemptId, fromOther, { terminal: ctx.other.terminal_id }),
      code('23514'),
    );
    await insert(four.attemptId, fromOther, {
      manager: ctx.otherManager.staff_id,
      terminal: ctx.other.terminal_id,
      shift_id: ctx.otherShift,
    });
    assert.equal((await releases(ctx))[0].attempt_terminal_id, ctx.cashier.terminal_id);
    assert.equal((await releases(ctx))[0].terminal_id, ctx.other.terminal_id);
    await insert(one.attemptId, approvalId);
    // Once per attempt and once per approval.
    await assert.rejects(insert(one.attemptId, approvalId), code('23505'));
    await assert.rejects(
      insert(two.attemptId, approvalId),
      (error) => error.code === '23505' || error.code === '23514',
    );
    // Append-only.
    await assert.rejects(
      pool.query("UPDATE kaspi_pos_attempt_releases SET reason='Другая причина'"),
      code('23514'),
    );
    await assert.rejects(pool.query('DELETE FROM kaspi_pos_attempt_releases'), code('23514'));
    await assert.rejects(pool.query('TRUNCATE kaspi_pos_attempt_releases'), code('23514'));
    // A released attempt never gets an order; an unreleased paid one still does.
    await assert.rejects(
      pool.query('UPDATE kaspi_pos_attempts SET order_id=$2 WHERE id=$1', [
        one.attemptId,
        randomUUID(),
      ]),
      (error) => error.code === '23514' && /released/.test(error.message),
    );
    await pool.query('UPDATE kaspi_pos_attempts SET order_id=$2 WHERE id=$1', [
      two.attemptId,
      randomUUID(),
    ]);
    // A paid attempt that already has an order is not released.
    const third = await paid(ctx);
    await pool.query('UPDATE kaspi_pos_attempts SET order_id=$2 WHERE id=$1', [
      third.attemptId,
      randomUUID(),
    ]);
    const approvalThree = await spend(await grant(ctx, 'terminal_release', subjectOf(third)));
    await assert.rejects(insert(third.attemptId, approvalThree), code('23514'));
    assert.equal((await releases(ctx)).length, 2);
  });
});

test('the shift does not close over a paid unsold payment; after the release it closes and the Z report is unchanged', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const one = await paid(ctx, ctx.colleague);
    await assert.rejects(closeShift(ctx, ctx.shift), code('TERMINAL_UNSOLD_PAYMENTS'));
    assert.equal(
      (await pool.query('SELECT state FROM local_cash_shifts WHERE id=$1', [ctx.shift])).rows[0]
        .state,
      'open',
    );
    // The other desk has nothing unsold and closes freely.
    await closeShift(ctx, ctx.otherShift, ctx.otherManager);
    const released = await release(
      ctx,
      one.attemptId,
      await grant(ctx, 'terminal_release', subjectOf(one)),
    );
    assert.ok(released.released_at);
    const closed = await closeShift(ctx, ctx.shift);
    assert.equal(closed.state, 'closed');
    // The frozen Z report is exactly the contract of before: no new key, strict parse.
    const z = await readShiftReport(pool, ctx.branch, staffAuth(ctx.manager), ctx.shift, 'z');
    const keys = (value) => Object.keys(value).sort();
    assert.deepEqual(keys(PosShiftReportSchema.parse(z)), keys(z));
    assert.deepEqual(keys(z), keys(PosShiftReportSchema.shape));
    const stored = (
      await pool.query('SELECT report FROM pos_shift_reports WHERE shift_id=$1', [ctx.shift])
    ).rows[0].report;
    assert.deepEqual(keys(PosShiftReportSchema.parse(stored)), keys(PosShiftReportSchema.shape));
    assert.deepEqual(keys(stored), keys(PosShiftReportSchema.shape));
    const list = await readShiftTerminalReleases(
      pool,
      ctx.branch,
      staffAuth(ctx.manager),
      ctx.shift,
    );
    PosTerminalReleaseListSchema.parse(list);
    assert.equal(list.shift_id, ctx.shift);
    assert.equal(list.count, 1);
    assert.equal(list.amount_minor, one.q.total_minor);
    assert.deepEqual(list.items[0], {
      attempt_id: one.attemptId,
      attempt_terminal_id: ctx.cashier.terminal_id,
      quote_id: one.q.quote_id,
      amount_minor: one.q.total_minor,
      transaction_id: one.attempt.transaction_id,
      attempt_staff_id: ctx.colleague.staff_id,
      released_by_staff_id: ctx.manager.staff_id,
      manager_staff_id: ctx.manager.staff_id,
      reason: REASON,
      released_at: released.released_at,
    });
    // Same access as the reports: a cashier sees this desk only; a manager every desk.
    assert.equal(
      (await readShiftTerminalReleases(pool, ctx.branch, staffAuth(ctx.cashier), ctx.shift)).count,
      1,
    );
    await assert.rejects(
      readShiftTerminalReleases(pool, ctx.branch, staffAuth(ctx.other), ctx.shift),
      code('NOT_FOUND'),
    );
    assert.equal(
      (await readShiftTerminalReleases(pool, ctx.branch, staffAuth(ctx.manager), ctx.otherShift))
        .count,
      0,
    );
    await assert.rejects(
      readShiftTerminalReleases(pool, ctx.branch, staffAuth(ctx.manager), randomUUID()),
      code('NOT_FOUND'),
    );
  });
});

test('a paid attempt without an order older than 24 h stays in the open list until it is sold or released', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const device = (
      await pool.query('SELECT id FROM kaspi_pos_devices WHERE terminal_id=$1', [
        ctx.cashier.terminal_id,
      ])
    ).rows[0].id;
    const old = async (finalState) => {
      const id = randomUUID();
      const quoteId = randomUUID();
      await pool.query(
        `INSERT INTO kaspi_pos_attempts(id,branch_id,device_id,terminal_id,staff_id,quote_id,amount_minor,created_at)
         VALUES($1,$2,$3,$4,$5,$6,299000,clock_timestamp()-interval '3 days')`,
        [id, ctx.branch, device, ctx.cashier.terminal_id, ctx.cashier.staff_id, quoteId],
      );
      await pool.query("UPDATE kaspi_pos_attempts SET state='sending' WHERE id=$1", [id]);
      await pool.query("UPDATE kaspi_pos_attempts SET state='wait',process_id='old1' WHERE id=$1", [
        id,
      ]);
      if (finalState === 'success')
        await pool.query(
          "UPDATE kaspi_pos_attempts SET state='success',transaction_id='SYN-OLD',finished_at=clock_timestamp() WHERE id=$1",
          [id],
        );
      if (finalState === 'fail')
        await pool.query(
          "UPDATE kaspi_pos_attempts SET state='fail',finished_at=clock_timestamp() WHERE id=$1",
          [id],
        );
      return { id, quoteId };
    };
    const unsold = await old('success');
    const failed = await old('fail');
    assert.deepEqual(
      (await open(ctx)).items.map((item) => item.attempt_id),
      [unsold.id],
    );
    // A fresh paid one is listed with it. An old unfinished one (an open operation blocks the
    // terminal, so it is made last) is not: the 24 h window still holds for it.
    const fresh = await paid(ctx);
    const stuck = await old('wait');
    const items = (await open(ctx)).items.map((item) => item.attempt_id);
    assert.deepEqual(new Set(items), new Set([unsold.id, fresh.attemptId]));
    assert.ok(![failed.id, stuck.id].some((id) => items.includes(id)));
    await assert.rejects(closeShift(ctx, ctx.shift), code('TERMINAL_UNSOLD_PAYMENTS'));
    const done = await release(
      ctx,
      unsold.id,
      await grant(ctx, 'terminal_release', { quote_id: unsold.quoteId, amount_minor: '299000' }),
    );
    assert.ok(done.released_at);
    assert.deepEqual(
      (await open(ctx)).items.map((item) => item.attempt_id),
      [fresh.attemptId],
    );
  });
});

test('a release and a sale of the same attempt race: exactly one wins; two releases: exactly one', async () => {
  await desk(async (ctx) => {
    const one = await paid(ctx);
    const approval = await grant(ctx, 'terminal_release', subjectOf(one));
    const results = await Promise.allSettled([
      release(ctx, one.attemptId, approval),
      sellWith(ctx, one.q, one.attemptId),
    ]);
    assert.equal(
      results.filter((r) => r.status === 'fulfilled').length,
      1,
      JSON.stringify(results.map((r) => r.reason?.code)),
    );
    const rejected = results.find((r) => r.status === 'rejected');
    assert.ok(
      ['TERMINAL_ATTEMPT_INVALID', 'CONFLICT'].includes(rejected.reason.code),
      rejected.reason.code,
    );
    const released = (await releases(ctx)).length;
    const orders = (await ctx.edge.pool.query('SELECT 1 FROM local_orders')).rowCount;
    assert.equal(released + orders, 1);
    const state = (
      await ctx.edge.pool.query('SELECT order_id FROM kaspi_pos_attempts WHERE id=$1', [
        one.attemptId,
      ])
    ).rows[0];
    assert.equal(state.order_id !== null, orders === 1);
  });
  await desk(async (ctx) => {
    const one = await paid(ctx);
    const results = await Promise.allSettled([
      release(ctx, one.attemptId, await grant(ctx, 'terminal_release', subjectOf(one))),
      release(ctx, one.attemptId, await grant(ctx, 'terminal_release', subjectOf(one)), {
        actor: ctx.colleague,
      }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      results.find((r) => r.status === 'rejected').reason.code,
      'TERMINAL_ATTEMPT_INVALID',
    );
    assert.equal((await releases(ctx)).length, 1);
  });
});

test('HTTP: release, the open list and the releases of a shift; the unsold shift close answers its code', async () => {
  await desk(async (ctx) => {
    const server = await running(createEdge, {
      ...ctx.edge.config,
      edgeFulfillmentEnabled: true,
      edgeDeviceId: ctx.device,
    });
    try {
      const url = (path) => server.url + '/edge/v1/' + path;
      const one = await paid(ctx);
      const post = (path, body, actor = ctx.manager, key = randomUUID()) =>
        request(url(path), {
          method: 'POST',
          headers: staffHeaders(actor, key),
          body: JSON.stringify(body),
        });
      const closing = await post(`cash-shifts/${ctx.shift}/close`, {
        expected_version: 1,
        counted_cash_minor: '0',
        reason: 'Синтетическое закрытие',
      });
      assert.equal(closing.status, 409);
      assert.equal((await closing.json()).code, 'TERMINAL_UNSOLD_PAYMENTS');
      const approval = await grant(ctx, 'terminal_release', subjectOf(one));
      const body = { reason: REASON, refunded_on_terminal: true, approval };
      const key = randomUUID();
      const response = await post(
        `pos/terminal-payments/${one.attemptId}/release`,
        body,
        ctx.manager,
        key,
      );
      assert.equal(response.status, 200);
      const answer = PosTerminalPaymentSchema.parse(await response.json());
      assert.ok(answer.released_at);
      const replay = await post(
        `pos/terminal-payments/${one.attemptId}/release`,
        body,
        ctx.manager,
        key,
      );
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), answer);
      const again = await post(`pos/terminal-payments/${one.attemptId}/release`, {
        ...body,
        approval: await grant(ctx, 'terminal_release', subjectOf(one)),
      });
      assert.equal(again.status, 409);
      assert.equal((await again.json()).code, 'TERMINAL_ATTEMPT_INVALID');
      const missing = await post(`pos/terminal-payments/${randomUUID()}/release`, body);
      assert.equal(missing.status, 404);
      const listed = await request(url('pos/terminal-payments/open'), {
        headers: staffHeaders(ctx.cashier),
      });
      assert.deepEqual((await listed.json()).items, []);
      const closed = await post(`cash-shifts/${ctx.shift}/close`, {
        expected_version: 1,
        counted_cash_minor: '0',
        reason: 'Синтетическое закрытие',
      });
      assert.equal(closed.status, 200);
      const releasesOfShift = await request(url(`cash-shifts/${ctx.shift}/terminal-releases`), {
        headers: staffHeaders(ctx.manager),
      });
      assert.equal(releasesOfShift.status, 200);
      assert.equal(releasesOfShift.headers.get('cache-control'), 'no-store');
      const list = PosTerminalReleaseListSchema.parse(await releasesOfShift.json());
      assert.equal(list.count, 1);
      assert.equal(list.items[0].attempt_id, one.attemptId);
    } finally {
      await server.app.close();
    }
  });
});

test('a paid attempt of one desk is released from another desk by the manager PIN there; then its shift closes', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const one = await paid(ctx);
    await assert.rejects(closeShift(ctx, ctx.shift), code('TERMINAL_UNSOLD_PAYMENTS'));
    // The manager of the other desk finds it; a cashier cannot ask, a bad scope is a bad request.
    const found = await listOpenTerminalPayments(
      pool,
      ctx.branch,
      staffAuth(ctx.otherManager),
      'other_desks',
    );
    assert.deepEqual(
      found.items.map((item) => item.attempt_id),
      [one.attemptId],
    );
    assert.equal(found.items[0].terminal_id, ctx.cashier.terminal_id);
    await assert.rejects(
      listOpenTerminalPayments(pool, ctx.branch, staffAuth(ctx.other), 'other_desks'),
      code('FORBIDDEN'),
    );
    await assert.rejects(
      listOpenTerminalPayments(pool, ctx.branch, staffAuth(ctx.otherManager), 'all'),
      code('INVALID_REQUEST'),
    );
    assert.deepEqual((await open(ctx, ctx.other)).items, []);
    // A cashier of the other desk without the manager approval cannot release it.
    await assert.rejects(
      release(ctx, one.attemptId, undefined, { actor: ctx.other }),
      code('APPROVAL_REQUIRED'),
    );
    // The approval typed on the other desk releases it.
    const done = await release(
      ctx,
      one.attemptId,
      await grant(ctx, 'terminal_release', subjectOf(one), { terminal: ctx.other.terminal_id }),
      { actor: ctx.otherManager },
    );
    assert.ok(done.released_at);
    const [row] = await releases(ctx);
    assert.equal(row.attempt_terminal_id, ctx.cashier.terminal_id);
    assert.equal(row.terminal_id, ctx.other.terminal_id);
    assert.equal(row.shift_id, ctx.otherShift);
    assert.equal(row.released_by_staff_id, ctx.otherManager.staff_id);
    assert.deepEqual(
      (await listOpenTerminalPayments(pool, ctx.branch, staffAuth(ctx.otherManager), 'other_desks'))
        .items,
      [],
    );
    // It is in the report of the desk that made the release, with the attempt's desk named.
    const there = await readShiftTerminalReleases(
      pool,
      ctx.branch,
      staffAuth(ctx.otherManager),
      ctx.otherShift,
    );
    assert.equal(there.count, 1);
    assert.equal(there.items[0].attempt_terminal_id, ctx.cashier.terminal_id);
    assert.equal(
      (await readShiftTerminalReleases(pool, ctx.branch, staffAuth(ctx.manager), ctx.shift)).count,
      0,
    );
    // The desk of the attempt closes now.
    assert.equal((await closeShift(ctx, ctx.shift)).state, 'closed');
  });
});

test('the releasing desk needs its own open sales shift', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const one = await paid(ctx);
    // The other desk closes (nothing unsold of its own), then tries to release this desk's payment.
    await closeShift(ctx, ctx.otherShift, ctx.otherManager);
    await assert.rejects(
      release(
        ctx,
        one.attemptId,
        await grant(ctx, 'terminal_release', subjectOf(one), { terminal: ctx.other.terminal_id }),
        { actor: ctx.otherManager },
      ),
      code('CASH_SHIFT_REQUIRED'),
    );
    assert.equal((await pool.query('SELECT 1 FROM kaspi_pos_attempt_releases')).rowCount, 0);
  });
});

test('SQL race with two real transactions: release against binding an order, exactly one wins either way', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    for (const releaseFirst of [true, false]) {
      const one = await paid(ctx);
      const approval = await grant(ctx, 'terminal_release', subjectOf(one));
      await pool.query(
        'UPDATE local_manager_approvals SET consumed_at=clock_timestamp(),consumed_command_key=$2 WHERE id=$1',
        [approval.approval_id, randomUUID()],
      );
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query('BEGIN');
        await b.query('BEGIN');
        const insertRelease = (client) =>
          client.query(
            `INSERT INTO kaspi_pos_attempt_releases(attempt_id,branch_id,attempt_terminal_id,terminal_id,shift_id,
             amount_minor,transaction_id,attempt_staff_id,released_by_staff_id,manager_staff_id,approval_id,reason)
             SELECT id,branch_id,terminal_id,terminal_id,$2,amount_minor,transaction_id,staff_id,$3,$3,$4,'Синтетический возврат'
             FROM kaspi_pos_attempts WHERE id=$1`,
            [one.attemptId, ctx.shift, ctx.manager.staff_id, approval.approval_id],
          );
        const bindOrder = (client) =>
          client.query('UPDATE kaspi_pos_attempts SET order_id=$2 WHERE id=$1', [
            one.attemptId,
            randomUUID(),
          ]);
        const first = releaseFirst ? insertRelease : bindOrder;
        const second = releaseFirst ? bindOrder : insertRelease;
        await first(a);
        const blocked = second(b);
        blocked.catch(() => undefined);
        await sleep(300);
        await a.query('COMMIT');
        await assert.rejects(blocked, code('23514'));
        await b.query('ROLLBACK');
      } finally {
        a.release();
        b.release();
      }
      const state = (
        await pool.query(
          `SELECT a.order_id IS NOT NULL AS bound,
           EXISTS(SELECT 1 FROM kaspi_pos_attempt_releases r WHERE r.attempt_id=a.id) AS released
           FROM kaspi_pos_attempts a WHERE a.id=$1`,
          [one.attemptId],
        )
      ).rows[0];
      assert.deepEqual(
        state,
        releaseFirst ? { bound: false, released: true } : { bound: true, released: false },
      );
    }
  });
});

async function withRuntimeRole(ctx, run, { releaseGrants = false } = {}) {
  const role = 'edge_runtime_' + randomUUID().replaceAll('-', '');
  const password = randomBytes(32).toString('hex');
  await ctx.edge.admin.query(
    `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  let pool;
  try {
    await applyEdgeRuntimeGrants(ctx.edge.pool, role, {
      schema: ctx.edge.schema,
      fulfillment: true,
    });
    // The reset grants SELECT and INSERT on the releases table (kaspi-pos-release-grants.mjs).
    if (releaseGrants)
      await assertKaspiPosReleaseRuntimePrivileges(ctx.edge.pool, role, ctx.edge.schema);
    // A role without them is what an edge looks like before the 030 tool granted its rights.
    else
      await ctx.edge.pool.query(
        `REVOKE ALL ON ${ctx.edge.schema}.kaspi_pos_attempt_releases FROM ${role}`,
      );
    const url = new URL(ctx.edge.config.databaseUrl);
    url.username = role;
    url.password = password;
    pool = createPool(url.toString(), 2);
    await run({ ...ctx, edge: { ...ctx.edge, pool } }, pool);
  } finally {
    await pool?.end();
    await ctx.edge.admin.query(`DROP OWNED BY ${role}`);
    await ctx.edge.admin.query(`DROP ROLE ${role}`);
  }
}

test('030 applied, no grant on the releases table: terminal sales pass, the release is off, the list and the shift close as without 030', async () => {
  await desk(async (ctx) =>
    withRuntimeRole(ctx, async (rt, pool) => {
      const sold = await paid(rt);
      assert.equal(
        (
          await sellWith(rt, sold.q, sold.attemptId, ctx.cashier, {
            fiscal_receipt_number: '123456',
          })
        ).order.state,
        'paid',
      );
      const unsold = await paid(rt);
      assert.equal(unsold.attempt.released_at, null);
      assert.deepEqual(
        (await open(rt)).items.map((item) => item.attempt_id),
        [unsold.attemptId],
      );
      await assert.rejects(
        release(rt, unsold.attemptId, await grant(ctx, 'terminal_release', subjectOf(unsold))),
        code('NOT_FOUND'),
      );
      assert.equal(
        (
          await listOpenTerminalPayments(
            pool,
            ctx.branch,
            staffAuth(ctx.otherManager),
            'other_desks',
          )
        ).items.length,
        0,
      );
      assert.equal((await closeShift(rt, ctx.shift)).state, 'closed');
    }),
  );
});

test('030 applied with SELECT and INSERT granted: the runtime releases, and can neither change, delete nor truncate a release', async () => {
  await desk(async (ctx) =>
    withRuntimeRole(
      ctx,
      async (rt, pool) => {
        const one = await paid(rt);
        const done = await release(
          rt,
          one.attemptId,
          await grant(ctx, 'terminal_release', subjectOf(one)),
        );
        assert.ok(done.released_at);
        assert.equal(
          (await readShiftTerminalReleases(pool, ctx.branch, staffAuth(ctx.manager), ctx.shift))
            .count,
          1,
        );
        for (const sql of [
          "UPDATE kaspi_pos_attempt_releases SET reason='Другая причина'",
          'DELETE FROM kaspi_pos_attempt_releases',
          'TRUNCATE kaspi_pos_attempt_releases',
        ])
          await assert.rejects(pool.query(sql), code('42501'));
        assert.equal((await closeShift(rt, ctx.shift)).state, 'closed');
      },
      { releaseGrants: true },
    ),
  );
});

const edgeDirectory = fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url));
test('030 on a populated 029 edge: sales and tender parts made before it still complete', async () => {
  const before = await mkdtemp(join(tmpdir(), 'pickchick-edge-029-'));
  try {
    for (const name of await readdir(edgeDirectory))
      if (/^\d{3}_[a-z_]+\.sql$/.test(name) && name < '030')
        await copyFile(join(edgeDirectory, name), join(before, name));
    await withSyncDatabases(
      async (base) => {
        const ctx = await prepare(base);
        const pool = ctx.edge.pool;
        const q = await quote(ctx);
        const cash = await createPosSale(
          pool,
          ctx.branch,
          staffAuth(ctx.cashier),
          randomUUID(),
          {
            quote_id: q.quote_id,
            service_mode_confirmed: true,
            order_repeated: true,
            tenders: [{ method: 'cash', amount_minor: q.total_minor }],
            cash_tendered_minor: q.total_minor,
          },
          ctx.execution,
        );
        const one = await paid(ctx);
        const terminal = await sellWith(ctx, one.q, one.attemptId);
        const mixedQuote = await quote(ctx);
        const part = await createTerminalPayment(
          pool,
          ctx.branch,
          staffAuth(ctx.cashier),
          randomUUID(),
          { quote_id: mixedQuote.quote_id, amount_minor: '100' },
          ctx.port,
        );
        ctx.port.script.status.push(success('SYN-TXN-MIX'));
        await readTerminalPayment(
          pool,
          ctx.branch,
          staffAuth(ctx.cashier),
          part.attempt_id,
          ctx.port,
        );
        const rest = (BigInt(mixedQuote.total_minor) - 100n).toString();
        const mixed = await createPosSale(
          pool,
          ctx.branch,
          staffAuth(ctx.cashier),
          randomUUID(),
          {
            quote_id: mixedQuote.quote_id,
            service_mode_confirmed: true,
            order_repeated: true,
            tenders: [
              { method: 'kaspi_terminal', amount_minor: '100', attempt_id: part.attempt_id },
              { method: 'cash', amount_minor: rest },
            ],
            cash_tendered_minor: rest,
          },
          ctx.execution,
        );
        const counts = async () =>
          (
            await pool.query(
              `SELECT (SELECT count(*) FROM local_orders)::int AS orders,
               (SELECT count(*) FROM pos_sale_tenders)::int AS tenders,
               (SELECT count(*) FROM kaspi_pos_attempts)::int AS attempts`,
            )
          ).rows[0];
        const rows = await counts();
        assert.deepEqual(await migrate(pool, edgeDirectory, 'edge'), [
          '030_edge_kaspi_pos_release.sql',
        ]);
        assert.deepEqual(await counts(), rows);
        for (const sale of [cash, terminal, mixed])
          await pool.query('SELECT pos_sale_assert_complete($1,$2)', [
            sale.order.order_id,
            ctx.branch,
          ]);
      },
      { edgeMigrationDirectory: before },
    );
  } finally {
    await rm(before, { recursive: true, force: true });
  }
});
