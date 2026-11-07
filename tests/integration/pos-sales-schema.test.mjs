import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool, transaction } from '@pickchick/database';
import { applyMenu, hashJson, provisionDevice, publishMenu } from '@pickchick/menu-sync';
import { provisionCloudPosSync } from '@pickchick/pos-order-sync';
import { createQuote, provisionStaff, setOrdering } from '@pickchick/local-orders';
import { provisionFulfillment } from '@pickchick/edge-fulfillment';
import { POS_PAYMENT_METHOD_POLICY, PosPaymentMethodSchema } from '@pickchick/contracts';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';
import {
  POS_SALES_RELATIONS,
  RUNTIME_PRIVILEGES,
  WORKER_PRIVILEGES,
  assertPosSalesPrivileges,
  posSalesGrantees,
  posSalesRuntimeGrants,
  posSalesWorkerGrants,
} from '../../infra/windows/pos-sales-grants.mjs';
import {
  MIGRATION as CLOUD_MIGRATION,
  RUNTIME_PRIVILEGES as CLOUD_RUNTIME_PRIVILEGES,
  WORKER_PRIVILEGES as CLOUD_WORKER_PRIVILEGES,
  assertCloudPosSalesPrivileges,
  cloudPosSalesGrantees,
  cloudPosSalesGrants,
  cloudPosSalesPrivileges,
} from '../../infra/staging/pos-sales-grants.mjs';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { staffAuth } from '../helpers/orders.mjs';

// Edge schema026 invariants (contracts 2.2, 3.3, section 00), exercised with plain SQL: the sale
// runtime is POS-2, so every row here is what that runtime must write in one transaction.
const rejected = (pattern) => (error) => error.code === '23514' && pattern.test(error.message);
const ALL = PosPaymentMethodSchema.options;

async function switchMode(pool, branch, from, to) {
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO pos_sales_setting_changes(change_id,branch_id,subject,before,after,actor,reason)
       VALUES($1,$2,'pos_service_mode',$3,$4,'operator','Синтетическое переключение')`,
      [randomUUID(), branch, { pos_service_mode: from }, { pos_service_mode: to }],
    );
    await client.query('UPDATE branch_config SET pos_service_mode=$2 WHERE id=$1', [branch, to]);
  });
}
async function setMethod(pool, branch, code, change) {
  await transaction(pool, async (client) => {
    const old = (
      await client.query(
        'SELECT enabled,fiscal_policy FROM pos_payment_methods WHERE branch_id=$1 AND code=$2 FOR UPDATE',
        [branch, code],
      )
    ).rows[0];
    const next = { ...old, ...change };
    await client.query(
      `INSERT INTO pos_sales_setting_changes(change_id,branch_id,subject,before,after,actor,reason)
       VALUES($1,$2,$3,$4,$5,'operator','Синтетическая настройка')`,
      [randomUUID(), branch, code, old, next],
    );
    await client.query(
      'UPDATE pos_payment_methods SET enabled=$3,fiscal_policy=$4 WHERE branch_id=$1 AND code=$2',
      [branch, code, next.enabled, next.fiscal_policy],
    );
  });
}

async function desk(run, { methods = ALL } = {}) {
  await withSyncDatabases(async (ctx) => {
    const { edge, branch } = ctx;
    const release = ctx.menu();
    await applyMenu(edge.pool, branch, await publishMenu(ctx.cloud.pool, release));
    const setup = (role, terminal = randomUUID()) => ({
      staff_id: randomUUID(),
      terminal_id: terminal,
      name: 'Synthetic staff',
      role,
    });
    const cashier = await provisionStaff(edge.pool, branch, setup('cashier'));
    const manager = await provisionStaff(
      edge.pool,
      branch,
      setup('shift_manager', cashier.terminal_id),
    );
    const prep = randomUUID(),
      assembly = randomUUID();
    await provisionFulfillment(edge.pool, {
      organizationId: ctx.org,
      branchId: branch,
      deviceId: ctx.device,
      producerId: randomUUID(),
      stations: [
        { id: prep, kind: 'prep', name: 'Synthetic prep' },
        { id: assembly, kind: 'assembly', name: 'Synthetic assembly' },
      ],
      routing: {
        version: 1,
        assemblyStationId: assembly,
        routes: [{ productId: release.items[0].product_id, stationId: prep, kind: 'prep' }],
      },
    });
    await setOrdering(edge.pool, branch, staffAuth(manager), randomUUID(), true, {
      expected_version: 1,
    });
    await switchMode(edge.pool, branch, 'payment_required', 'pos_sale');
    for (const code of methods) await setMethod(edge.pool, branch, code, { enabled: true });
    const shift = randomUUID();
    await edge.pool.query(
      'INSERT INTO local_cash_shifts(id,branch_id,staff_id,terminal_id,opening_cash_minor,sales_mode) VALUES($1,$2,$3,$4,$5,true)',
      [shift, branch, manager.staff_id, cashier.terminal_id, '100000'],
    );
    await run({
      ...ctx,
      release,
      cashier,
      manager,
      shift,
      assembly,
      terminal: cashier.terminal_id,
    });
  });
}

/** A hall quote from the real runtime, or an aggregator copy of it (pricing is POS-2). */
async function quote(ctx, { channel, serviceMode = 'takeaway', quantity = 1 } = {}) {
  const hall = await createQuote(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), {
    release_id: ctx.release.release_id,
    service_mode: serviceMode,
    items: [{ variant_id: ctx.release.items[0].variant_id, quantity }],
  });
  if (!channel) return hall;
  const copy = { ...hall, quote_id: randomUUID(), sales_channel: channel };
  await ctx.edge.pool.query(
    'INSERT INTO checkout_quotes(id,branch_id,staff_id,terminal_id,release_id,total_minor,snapshot,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      copy.quote_id,
      ctx.branch,
      ctx.cashier.staff_id,
      ctx.terminal,
      copy.release_id,
      copy.total_minor,
      copy,
      copy.created_at,
      copy.expires_at,
    ],
  );
  return copy;
}

async function approve(client, ctx, action, options = {}) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO local_manager_approvals(id,branch_id,terminal_id,manager_staff_id,requested_by_staff_id,
     action,subject,subject_hash,token_hash,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+$10::interval)`,
    [
      id,
      ctx.branch,
      options.terminal ?? ctx.terminal,
      (options.manager ?? ctx.manager).staff_id,
      ctx.cashier.staff_id,
      action,
      { amount_minor: '0' },
      hashJson({ action, id }),
      randomBytes(32).toString('hex'),
      options.ttl ?? '120 seconds',
    ],
  );
  if (options.consume !== false)
    await client.query(
      'UPDATE local_manager_approvals SET consumed_at=clock_timestamp(),consumed_command_key=$2 WHERE id=$1',
      [id, randomUUID()],
    );
  return id;
}

async function admit(client, ctx, orderId, q) {
  const number = (await client.query('SELECT fulfillment_display_allocate($1) AS n', [ctx.branch]))
    .rows[0].n;
  await client.query(
    `INSERT INTO fulfillment_reservations(order_id,branch_id,reservation_id,quote_id,quote_hash,owner_hash,
     commercial_owner,fulfillment_owner,device_id,snapshot,routing_version,task_plan,assembly_station_id,
     state,display_number,business_day,authorized_event_id,admission_kind,local_order_id,authorized_by_staff_id)
     VALUES($1,$2,$3,$4,$5,$6,'edge_pos','edge',$7,$8,1,'[]',$9,'accepted',$10,
     (clock_timestamp() AT TIME ZONE 'Asia/Almaty')::date,$11,'pos_sale',$1,$12)`,
    [
      orderId,
      ctx.branch,
      randomUUID(),
      q.quote_id,
      hashJson(q),
      hashJson({ orderId }),
      ctx.device,
      { channel: 'pos', branchId: ctx.branch },
      ctx.assembly,
      number,
      randomUUID(),
      ctx.cashier.staff_id,
    ],
  );
}

/** One paid sale in one transaction, exactly the rows POST pos/sales has to write. */
async function sell(ctx, q, sale, pool = ctx.edge.pool) {
  const orderId = randomUUID();
  const tenders = sale.tenders.map((tender) => ({ id: randomUUID(), ...tender }));
  await transaction(pool, async (client) => {
    if (sale.isolation) await client.query(`SET TRANSACTION ISOLATION LEVEL ${sale.isolation}`);
    const approval = sale.approval ? await approve(client, ctx, sale.approval) : null;
    await client.query(
      `INSERT INTO local_orders(id,branch_id,quote_id,total_minor,cash_shift_id,execution_mode,state,payment_state)
       VALUES($1,$2,$3,$4,$5,'pos_sale','paid','captured')`,
      [orderId, ctx.branch, q.quote_id, q.total_minor, ctx.shift],
    );
    if (sale.kitchen !== false) await admit(client, ctx, orderId, q);
    await client.query(
      `INSERT INTO pos_sales(order_id,branch_id,quote_id,shift_id,terminal_id,cashier_staff_id,sales_channel,
       external_order_ref,revenue_kind,total_minor,cash_tendered_minor,change_minor,beneficiary,reason,approval_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        orderId,
        ctx.branch,
        q.quote_id,
        ctx.shift,
        ctx.terminal,
        ctx.cashier.staff_id,
        sale.channel ?? 'hall',
        sale.ref ?? null,
        sale.revenue ?? 'revenue',
        sale.total ?? q.total_minor,
        sale.tendered ?? null,
        sale.change ?? null,
        sale.beneficiary ?? null,
        sale.reason ?? null,
        approval,
      ],
    );
    for (const tender of tenders)
      await client.query(
        'INSERT INTO pos_sale_tenders(id,order_id,branch_id,method,amount_minor,confirmation,reference) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          tender.id,
          orderId,
          ctx.branch,
          tender.method,
          tender.amount,
          tender.confirmation ?? POS_PAYMENT_METHOD_POLICY[tender.method].confirmation,
          tender.reference ?? null,
        ],
      );
    if (sale.receipt !== false)
      await client.query(
        "INSERT INTO pos_fiscal_receipts(id,branch_id,order_id,kind,state,amount_minor) VALUES($1,$2,$3,'sale',$4,$5)",
        [randomUUID(), ctx.branch, orderId, sale.receiptState ?? 'pending', q.total_minor],
      );
    // Keeps the transaction (and every lock it took) open until the test lets it commit.
    if (sale.hold) await sale.hold(client);
  });
  return { orderId, tenders };
}

/** A void (kitchen not started) or a refund, with its approval and receipt. */
async function refund(ctx, sold, kind, parts, pool = ctx.edge.pool, hooks = {}) {
  const id = randomUUID();
  const amount = parts.reduce((sum, part) => sum + BigInt(part.amount), 0n).toString();
  await transaction(pool, async (client) => {
    if (hooks.before) await hooks.before(client);
    const approval = await approve(client, ctx, hooks.action ?? kind);
    if (kind === 'void' && hooks.cancel !== false) {
      await client.query(
        "UPDATE fulfillment_reservations SET state='cancelled',version=version+1,cancellation_reason='Синтетическая отмена',updated_at=clock_timestamp() WHERE order_id=$1",
        [sold.orderId],
      );
      await client.query(
        "UPDATE local_orders SET state='cancelled',version=version+1,cancellation_reason='Синтетическая отмена' WHERE id=$1",
        [sold.orderId],
      );
    }
    await client.query(
      `INSERT INTO pos_refunds(id,order_id,branch_id,kind,shift_id,terminal_id,staff_id,approved_by_staff_id,
       approval_id,amount_minor,reason_code,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'quality','Синтетический возврат')`,
      [
        id,
        sold.orderId,
        ctx.branch,
        kind,
        hooks.shift ?? ctx.shift,
        ctx.terminal,
        ctx.cashier.staff_id,
        ctx.manager.staff_id,
        approval,
        hooks.amount ?? amount,
      ],
    );
    for (const part of parts)
      await client.query(
        'INSERT INTO pos_refund_tenders(refund_id,tender_id,order_id,branch_id,method,amount_minor) VALUES($1,$2,$3,$4,$5,$6)',
        [id, part.tender.id, sold.orderId, ctx.branch, part.tender.method, part.amount],
      );
    if (hooks.receipt !== false)
      await client.query(
        "INSERT INTO pos_fiscal_receipts(id,branch_id,order_id,refund_id,kind,state,amount_minor) VALUES($1,$2,$3,$4,'refund',$5,$6)",
        [
          randomUUID(),
          ctx.branch,
          sold.orderId,
          id,
          hooks.receiptState ?? 'pending',
          hooks.amount ?? amount,
        ],
      );
    if (hooks.hold) await hooks.hold(client);
  });
  return id;
}
const cashReport = async (pool, shift) =>
  (
    await pool.query(
      "SELECT payload FROM cashier_report_outbox WHERE kind='shift' AND entity_id=$1 ORDER BY sequence DESC LIMIT 1",
      [shift],
    )
  ).rows[0]?.payload;

test('seed and operator settings: eight disabled methods, audited changes, mode switch rules', async () => {
  await withSyncDatabases(async (ctx) => {
    const pool = ctx.edge.pool,
      branch = ctx.branch;
    const rows = (
      await pool.query(
        'SELECT code,enabled,requires_approval,allow_in_mix,fiscal_policy FROM pos_payment_methods WHERE branch_id=$1',
        [branch],
      )
    ).rows;
    assert.deepEqual(
      Object.fromEntries(rows.map(({ code, ...row }) => [code, row])),
      Object.fromEntries(
        ALL.map((code) => [
          code,
          {
            enabled: false,
            requires_approval: POS_PAYMENT_METHOD_POLICY[code].requires_approval,
            allow_in_mix: POS_PAYMENT_METHOD_POLICY[code].allow_in_mix,
            fiscal_policy: POS_PAYMENT_METHOD_POLICY[code].fiscal_policy,
          },
        ]),
      ),
    );
    // Off by default and unchangeable without a matching audit record.
    assert.equal(
      (await pool.query('SELECT pos_service_mode FROM branch_config')).rows[0].pos_service_mode,
      'payment_required',
    );
    await assert.rejects(
      pool.query("UPDATE pos_payment_methods SET enabled=true WHERE code='cash'"),
      rejected(/matching audit record/),
    );
    await assert.rejects(
      pool.query("UPDATE pos_payment_methods SET allow_in_mix=true WHERE code='chocofood'"),
      rejected(/check constraint|immutable/),
    );
    await assert.rejects(
      pool.query("UPDATE branch_config SET pos_service_mode='pos_sale'"),
      rejected(/matching audit record/),
    );
    await assert.rejects(
      pool.query("DELETE FROM pos_payment_methods WHERE code='cash'"),
      rejected(/deleted/),
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO pos_payment_methods(branch_id,code,enabled,requires_approval,allow_in_mix,fiscal_policy) VALUES($1,'cash',true,false,true,'manual_webkassa') ON CONFLICT DO NOTHING",
        [branch],
      ),
      rejected(/starts disabled/),
    );
    await setMethod(pool, branch, 'kaspi_manual', { fiscal_policy: 'not_required' });
    await setMethod(pool, branch, 'cash', { enabled: true });
    assert.deepEqual(
      (
        await pool.query(
          "SELECT enabled,fiscal_policy FROM pos_payment_methods WHERE code IN ('cash','kaspi_manual') ORDER BY code",
        )
      ).rows,
      [
        { enabled: true, fiscal_policy: 'manual_webkassa' },
        { enabled: false, fiscal_policy: 'not_required' },
      ],
    );
    // The latest audit row authorises exactly one transition; a replay is refused.
    await assert.rejects(
      pool.query("UPDATE pos_payment_methods SET enabled=false WHERE code='cash'"),
      rejected(/matching audit record/),
    );
    for (const bad of [
      { before: { enabled: false }, after: { enabled: true, fiscal_policy: 'not_required' } },
      {
        before: { pos_service_mode: 'x' },
        after: { pos_service_mode: 'pos_sale' },
        subject: 'pos_service_mode',
      },
      {
        before: { enabled: true, fiscal_policy: 'manual_webkassa', extra: 1 },
        after: { enabled: true, fiscal_policy: 'manual_webkassa' },
      },
    ])
      await assert.rejects(
        pool.query(
          "INSERT INTO pos_sales_setting_changes(change_id,branch_id,subject,before,after,actor,reason) VALUES($1,$2,$3,$4,$5,'operator','Синтетика')",
          [randomUUID(), branch, bad.subject ?? 'cash', bad.before, bad.after],
        ),
        rejected(/check constraint/),
      );
    await assert.rejects(
      pool.query('UPDATE pos_sales_setting_changes SET reason=reason'),
      rejected(/append-only/),
    );
    await assert.rejects(
      pool.query('DELETE FROM pos_sales_setting_changes'),
      rejected(/append-only/),
    );
    // No shift may straddle pos_sale: switching needs every drawer closed; shifts follow the mode.
    const staff = await provisionStaff(pool, branch, {
      staff_id: randomUUID(),
      terminal_id: randomUUID(),
      name: 'Synthetic staff',
      role: 'shift_manager',
    });
    const open = randomUUID();
    await pool.query(
      'INSERT INTO local_cash_shifts(id,branch_id,staff_id,terminal_id,opening_cash_minor) VALUES($1,$2,$3,$4,0)',
      [open, branch, staff.staff_id, staff.terminal_id],
    );
    await assert.rejects(
      switchMode(pool, branch, 'payment_required', 'pos_sale'),
      rejected(/Close every cash shift/),
    );
    // payment_required <-> unpaid_service stays unaudited and allowed with open shifts.
    await pool.query("UPDATE branch_config SET pos_service_mode='unpaid_service'");
    await pool.query("UPDATE branch_config SET pos_service_mode='payment_required'");
    await assert.rejects(
      pool.query(
        'INSERT INTO local_cash_shifts(id,branch_id,staff_id,terminal_id,opening_cash_minor,sales_mode) VALUES($1,$2,$3,$4,0,true)',
        [randomUUID(), branch, staff.staff_id, staff.terminal_id],
      ),
      rejected(/sales mode must follow/),
    );
    await pool.query(
      "UPDATE local_cash_shifts SET state='closed',version=2,closed_at=clock_timestamp(),closed_by_staff_id=$2,counted_cash_minor=0,discrepancy_minor=0,closing_reason='Синтетика',closed_report='{}' WHERE id=$1",
      [open, staff.staff_id],
    );
    await switchMode(pool, branch, 'payment_required', 'pos_sale');
    await assert.rejects(
      pool.query(
        'INSERT INTO local_cash_shifts(id,branch_id,staff_id,terminal_id,opening_cash_minor) VALUES($1,$2,$3,$4,0)',
        [randomUUID(), branch, staff.staff_id, staff.terminal_id],
      ),
      rejected(/sales mode must follow/),
    );
    const sales = randomUUID();
    await pool.query(
      'INSERT INTO local_cash_shifts(id,branch_id,staff_id,terminal_id,opening_cash_minor,sales_mode) VALUES($1,$2,$3,$4,0,true)',
      [sales, branch, staff.staff_id, staff.terminal_id],
    );
    await assert.rejects(
      pool.query('UPDATE local_cash_shifts SET sales_mode=false WHERE id=$1', [sales]),
      rejected(/Invalid cash shift transition/),
    );
    await assert.rejects(
      switchMode(pool, branch, 'pos_sale', 'unpaid_service'),
      rejected(/Close every cash shift/),
    );
    // A sales shift closes only with its Z report.
    await assert.rejects(
      pool.query(
        "UPDATE local_cash_shifts SET state='closed',version=2,closed_at=clock_timestamp(),closed_by_staff_id=$2,counted_cash_minor=0,discrepancy_minor=0,closing_reason='Синтетика',closed_report='{}' WHERE id=$1",
        [sales, staff.staff_id],
      ),
      rejected(/closes with its Z report/),
    );
    await transaction(pool, async (client) => {
      await client.query(
        "UPDATE local_cash_shifts SET state='closed',version=2,closed_at=clock_timestamp(),closed_by_staff_id=$2,counted_cash_minor=0,discrepancy_minor=0,closing_reason='Синтетика',closed_report='{}' WHERE id=$1",
        [sales, staff.staff_id],
      );
      await client.query(
        'INSERT INTO pos_shift_reports(shift_id,branch_id,terminal_id,report,terminal_reported_minor,pending_fiscal_count) VALUES($1,$2,$3,$4,0,0)',
        [
          sales,
          branch,
          staff.terminal_id,
          { kind: 'z', shift_id: sales, terminal_id: staff.terminal_id },
        ],
      );
    });
    await switchMode(pool, branch, 'pos_sale', 'unpaid_service');
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM pos_sales_setting_changes WHERE subject='pos_service_mode'",
        )
      ).rows[0].n,
      2,
    );
  });
});

test('valid sales of every kind commit; cash counts in the drawer, the report and withdrawals', async () => {
  await desk(async (ctx) => {
    const q = () => quote(ctx);
    const one = await q();
    const total = BigInt(one.total_minor);
    const cash = await sell(ctx, one, {
      tenders: [{ method: 'cash', amount: one.total_minor }],
      tendered: (total + 50000n).toString(),
      change: '50000',
    });
    const mixed = await q();
    await sell(ctx, mixed, {
      tenders: [
        { method: 'cash', amount: '9000' },
        { method: 'kaspi_terminal', amount: (BigInt(mixed.total_minor) - 9000n).toString() },
      ],
      tendered: '10000',
      change: '1000',
    });
    const manual = await q();
    await sell(ctx, manual, {
      tenders: [
        { method: 'kaspi_terminal', amount: '100000' },
        {
          method: 'kaspi_manual',
          amount: (BigInt(manual.total_minor) - 100000n).toString(),
          reference: 'SYN-OP-1',
        },
      ],
    });
    for (const [channel, method, ref] of [
      ['yandex_eda', 'aggregator_yandex_eda', 'YA-SYN-1'],
      ['glovo', 'aggregator_glovo', 'GL-SYN-1'],
    ]) {
      const aggregator = await quote(ctx, { channel });
      await sell(ctx, aggregator, {
        channel,
        ref,
        tenders: [{ method, amount: aggregator.total_minor }],
      });
    }
    const choco = await quote(ctx, { serviceMode: 'dine_in' });
    await sell(ctx, choco, {
      ref: 'CF-SYN-1',
      tenders: [{ method: 'chocofood', amount: choco.total_minor }],
    });
    const meal = await q();
    await sell(ctx, meal, {
      revenue: 'staff_meal',
      approval: 'staff_meal',
      beneficiary: 'Синтетический сотрудник',
      tenders: [{ method: 'staff_meal', amount: meal.total_minor }],
    });
    const promo = await q();
    await sell(ctx, promo, {
      revenue: 'marketing',
      approval: 'marketing',
      reason: 'Синтетическая дегустация',
      tenders: [{ method: 'marketing', amount: promo.total_minor }],
    });
    const pool = ctx.edge.pool;
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM local_orders WHERE state='paid' AND payment_state='captured'",
        )
      ).rows[0].n,
      8,
    );
    assert.deepEqual((await pool.query('SELECT * FROM pos_shift_cash($1)', [ctx.shift])).rows[0], {
      cash_sales_minor: (total + 9000n).toString(),
      cash_refunds_minor: '0',
    });
    // A withdrawal may take cash sales; the sales shift report counts them in expected cash.
    await pool.query(
      "INSERT INTO local_cash_movements(id,branch_id,shift_id,staff_id,direction,amount_minor,reason) VALUES($1,$2,$3,$4,'out',$5,'Инкассация')",
      [randomUUID(), ctx.branch, ctx.shift, ctx.manager.staff_id, (100000n + total).toString()],
    );
    const report = await cashReport(pool, ctx.shift);
    assert.equal(report.cash_sales_minor, (total + 9000n).toString());
    assert.equal(report.cash_refunds_minor, '0');
    assert.equal(report.cash_out_minor, (100000n + total).toString());
    assert.equal(report.expected_cash_minor, '9000');
    await assert.rejects(
      pool.query(
        "INSERT INTO local_cash_movements(id,branch_id,shift_id,staff_id,direction,amount_minor,reason) VALUES($1,$2,$3,$4,'out','9001','Инкассация')",
        [randomUUID(), ctx.branch, ctx.shift, ctx.manager.staff_id],
      ),
      rejected(/Invalid drawer balance/),
    );
    // The order report is the 016 payload with the paid state (cloud widening is POS-6).
    const order = (
      await pool.query(
        "SELECT payload FROM cashier_report_outbox WHERE kind='order' AND entity_id=$1 ORDER BY sequence DESC LIMIT 1",
        [cash.orderId],
      )
    ).rows[0].payload;
    assert.equal(order.state, 'paid');
    assert.equal(order.execution_mode, 'pos_sale');
    assert.equal(order.kitchen_state, 'accepted');
    // Duplicate aggregator order number in the same channel.
    const again = await quote(ctx, { channel: 'glovo' });
    await assert.rejects(
      sell(ctx, again, {
        channel: 'glovo',
        ref: 'GL-SYN-1',
        tenders: [{ method: 'aggregator_glovo', amount: again.total_minor }],
      }),
      (error) => error.code === '23505',
    );
  });
});

test('broken sales are refused at commit with nothing left behind', async () => {
  await desk(
    async (ctx) => {
      const pool = ctx.edge.pool;
      const before = async () =>
        (
          await pool.query(
            'SELECT (SELECT count(*) FROM local_orders)::int AS orders, (SELECT count(*) FROM pos_sales)::int AS sales, (SELECT count(*) FROM pos_sale_tenders)::int AS tenders, (SELECT count(*) FROM fulfillment_reservations)::int AS kitchen',
          )
        ).rows[0];
      const empty = await before();
      const cases = [
        [
          { tenders: [{ method: 'cash', amount: '1' }], tendered: '1', change: '0' },
          /tenders must equal/,
        ],
        [
          (q) => ({
            tenders: [
              { method: 'cash', amount: '1000' },
              { method: 'cash', amount: (BigInt(q.total_minor) - 1000n).toString() },
            ],
            tendered: q.total_minor,
            change: '0',
          }),
          /Invalid mixed/,
        ],
        [
          (q) => ({
            ref: 'CF-SYN-2',
            tenders: [
              { method: 'cash', amount: '1000' },
              { method: 'chocofood', amount: (BigInt(q.total_minor) - 1000n).toString() },
            ],
            tendered: '1000',
            change: '0',
          }),
          /Invalid mixed/,
        ],
        [
          (q) => ({ tenders: [{ method: 'cash', amount: q.total_minor }] }),
          /cash tender or change/,
        ],
        [
          (q) => ({
            tenders: [{ method: 'cash', amount: q.total_minor }],
            tendered: q.total_minor,
            change: '1',
          }),
          /cash tender or change/,
        ],
        [
          (q) => ({
            ref: 'SYN-123',
            tenders: [{ method: 'kaspi_terminal', amount: q.total_minor }],
          }),
          /channel, method or order number/,
        ],
        [
          (q) => ({ tenders: [{ method: 'chocofood', amount: q.total_minor }] }),
          /channel, method or order number/,
        ],
        [
          (q) => ({ tenders: [{ method: 'aggregator_glovo', amount: q.total_minor }] }),
          /channel, method or order number/,
        ],
        [
          (q) => ({
            revenue: 'staff_meal',
            beneficiary: 'Синтетика',
            tenders: [{ method: 'staff_meal', amount: q.total_minor }],
          }),
          /approval and details/,
        ],
        [
          (q) => ({
            revenue: 'staff_meal',
            approval: 'marketing',
            beneficiary: 'Синтетика',
            tenders: [{ method: 'staff_meal', amount: q.total_minor }],
          }),
          /approval and details/,
        ],
        [
          (q) => ({
            revenue: 'marketing',
            approval: 'marketing',
            tenders: [{ method: 'marketing', amount: q.total_minor }],
          }),
          /approval and details/,
        ],
        [
          (q) => ({ tenders: [{ method: 'marketing', amount: q.total_minor }] }),
          /approval and details/,
        ],
        [(q) => ({ tenders: [{ method: 'kaspi_manual', amount: q.total_minor }] }), /disabled/],
        [
          (q) => ({
            receipt: false,
            tenders: [{ method: 'kaspi_terminal', amount: q.total_minor }],
          }),
          /fiscal record/,
        ],
        [
          (q) => ({
            kitchen: false,
            tenders: [{ method: 'kaspi_terminal', amount: q.total_minor }],
          }),
          /kitchen admission/,
        ],
      ];
      for (const [shape, pattern] of cases) {
        const q = await quote(ctx);
        await assert.rejects(
          sell(ctx, q, typeof shape === 'function' ? shape(q) : shape),
          rejected(pattern),
          String(pattern),
        );
      }
      const odd = await quote(ctx);
      await assert.rejects(
        sell(ctx, odd, {
          tenders: [
            { method: 'kaspi_terminal', amount: '150' },
            { method: 'kaspi_manual', amount: (BigInt(odd.total_minor) - 150n).toString() },
          ],
        }),
        rejected(/check constraint/),
      );
      const yandex = await quote(ctx, { channel: 'yandex_eda' });
      await assert.rejects(
        sell(ctx, yandex, {
          channel: 'yandex_eda',
          tenders: [{ method: 'aggregator_yandex_eda', amount: yandex.total_minor }],
        }),
        rejected(/check constraint/),
      );
      const dineIn = await quote(ctx, { channel: 'glovo', serviceMode: 'dine_in' });
      await assert.rejects(
        sell(ctx, dineIn, {
          channel: 'glovo',
          ref: 'GL-SYN-3',
          tenders: [{ method: 'aggregator_glovo', amount: dineIn.total_minor }],
        }),
        rejected(/channel, method or order number/),
      );
      const wrongChannel = await quote(ctx, { channel: 'glovo' });
      await assert.rejects(
        sell(ctx, wrongChannel, {
          ref: 'GL-SYN-4',
          tenders: [{ method: 'aggregator_glovo', amount: wrongChannel.total_minor }],
        }),
        rejected(/channel, method or order number/),
      );
      assert.deepEqual(await before(), empty);
      // A tender added after the sale committed breaks its total.
      const q = await quote(ctx);
      const sold = await sell(ctx, q, {
        tenders: [{ method: 'kaspi_terminal', amount: q.total_minor }],
      });
      await assert.rejects(
        pool.query(
          "INSERT INTO pos_sale_tenders(id,order_id,branch_id,method,amount_minor,confirmation) VALUES($1,$2,$3,'kaspi_terminal','100','cashier_attested')",
          [randomUUID(), sold.orderId, ctx.branch],
        ),
        rejected(/tenders must equal/),
      );
      for (const sql of [
        'UPDATE pos_sales SET reason=reason',
        'DELETE FROM pos_sales',
        'UPDATE pos_sale_tenders SET reference=reference',
        'DELETE FROM pos_sale_tenders',
        "UPDATE local_orders SET payment_state='not_started'",
      ])
        await assert.rejects(pool.query(sql), (error) => error.code === '23514', sql);
      // pos_sale mode accepts nothing else, and pos_sale needs that mode.
      await assert.rejects(
        pool.query(
          'INSERT INTO local_orders(id,branch_id,quote_id,total_minor,cash_shift_id) VALUES($1,$2,$3,$4,$5)',
          [randomUUID(), ctx.branch, (await quote(ctx)).quote_id, q.total_minor, ctx.shift],
        ),
        rejected(/Only paid POS sales/),
      );
      await assert.rejects(
        pool.query(
          "INSERT INTO local_orders(id,branch_id,quote_id,total_minor,cash_shift_id,execution_mode,state,payment_state) VALUES($1,$2,$3,$4,$5,'pos_sale','awaiting_payment','captured')",
          [randomUUID(), ctx.branch, (await quote(ctx)).quote_id, q.total_minor, ctx.shift],
        ),
        (error) => error.code === '23514',
      );
    },
    { methods: ALL.filter((code) => code !== 'kaspi_manual') },
  );
});

test('void before cooking, refunds by tender, drawer limit, approvals and receipts', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const q1 = await quote(ctx);
    const total = BigInt(q1.total_minor);
    const cash = await sell(ctx, q1, {
      tenders: [{ method: 'cash', amount: q1.total_minor }],
      tendered: q1.total_minor,
      change: '0',
    });
    // Void needs the order cancelled with its kitchen admission, the whole amount, an approval.
    await assert.rejects(
      refund(ctx, cash, 'void', [{ tender: cash.tenders[0], amount: q1.total_minor }], pool, {
        cancel: false,
      }),
      (error) => error.code === '23514',
    );
    await assert.rejects(
      refund(ctx, cash, 'void', [{ tender: cash.tenders[0], amount: '100' }]),
      rejected(/void returns the whole sale/),
    );
    await assert.rejects(
      refund(ctx, cash, 'void', [{ tender: cash.tenders[0], amount: q1.total_minor }], pool, {
        action: 'refund',
      }),
      rejected(/manager approval/),
    );
    await assert.rejects(
      refund(ctx, cash, 'void', [{ tender: cash.tenders[0], amount: q1.total_minor }], pool, {
        receipt: false,
      }),
      rejected(/fiscal record/),
    );
    await assert.rejects(
      pool.query(
        "UPDATE local_orders SET state='cancelled',version=version+1,cancellation_reason='Без возврата' WHERE id=$1",
        [cash.orderId],
      ),
      rejected(/cancelled only by its void/),
    );
    await refund(ctx, cash, 'void', [{ tender: cash.tenders[0], amount: q1.total_minor }]);
    assert.deepEqual((await pool.query('SELECT * FROM pos_shift_cash($1)', [ctx.shift])).rows[0], {
      cash_sales_minor: q1.total_minor,
      cash_refunds_minor: q1.total_minor,
    });
    // Partial refunds by tender, never above the tender; refunds keep the order paid.
    const q2 = await quote(ctx);
    const mixed = await sell(ctx, q2, {
      tenders: [
        { method: 'cash', amount: '50000' },
        { method: 'kaspi_terminal', amount: (BigInt(q2.total_minor) - 50000n).toString() },
      ],
      tendered: '50000',
      change: '0',
    });
    await refund(ctx, mixed, 'refund', [{ tender: mixed.tenders[1], amount: '100000' }]);
    await assert.rejects(
      refund(ctx, mixed, 'refund', [
        { tender: mixed.tenders[1], amount: (BigInt(q2.total_minor) - 50000n).toString() },
      ]),
      rejected(/exceeds its tender/),
    );
    await assert.rejects(
      refund(ctx, mixed, 'refund', [{ tender: mixed.tenders[0], amount: '1000' }], pool, {
        amount: '1001',
      }),
      rejected(/tenders must equal the refund/),
    );
    // Cash refund only while this drawer holds the cash (opening 100000 + 50000 sold).
    await assert.rejects(
      refund(ctx, mixed, 'refund', [{ tender: mixed.tenders[0], amount: '50000' }], pool, {
        before: async (client) =>
          client.query(
            "INSERT INTO local_cash_movements(id,branch_id,shift_id,staff_id,direction,amount_minor,reason) VALUES($1,$2,$3,$4,'out','140000','Инкассация')",
            [randomUUID(), ctx.branch, ctx.shift, ctx.manager.staff_id],
          ),
      }),
      (error) => error.code === '23514',
    );
    await pool.query(
      "INSERT INTO local_cash_movements(id,branch_id,shift_id,staff_id,direction,amount_minor,reason) VALUES($1,$2,$3,$4,'out','140000','Инкассация')",
      [randomUUID(), ctx.branch, ctx.shift, ctx.manager.staff_id],
    );
    await assert.rejects(
      refund(ctx, mixed, 'refund', [{ tender: mixed.tenders[0], amount: '10001' }]),
      rejected(/exceeds the drawer/),
    );
    await refund(ctx, mixed, 'refund', [{ tender: mixed.tenders[0], amount: '10000' }]);
    // Sales and refunds do not emit shift reports; the next movement carries them.
    await pool.query(
      "INSERT INTO local_cash_movements(id,branch_id,shift_id,staff_id,direction,amount_minor,reason) VALUES($1,$2,$3,$4,'in','5000','Размен')",
      [randomUUID(), ctx.branch, ctx.shift, ctx.manager.staff_id],
    );
    const report = await cashReport(pool, ctx.shift);
    assert.deepEqual(
      [
        report.cash_in_minor,
        report.cash_out_minor,
        report.cash_sales_minor,
        report.cash_refunds_minor,
      ],
      ['5000', '140000', (total + 50000n).toString(), (total + 10000n).toString()],
    );
    assert.equal(report.expected_cash_minor, '5000');
    assert.equal(
      (await pool.query('SELECT state FROM local_orders WHERE id=$1', [mixed.orderId])).rows[0]
        .state,
      'paid',
    );
    for (const sql of ['UPDATE pos_refunds SET reason=reason', 'DELETE FROM pos_refund_tenders'])
      await assert.rejects(pool.query(sql), (error) => error.code === '23514', sql);
    // Approvals: TTL at most 120 s, an active shift manager, consumed once before expiry.
    await assert.rejects(
      transaction(pool, (client) => approve(client, ctx, 'refund', { ttl: '121 seconds' })),
      rejected(/check constraint/),
    );
    await assert.rejects(
      transaction(pool, (client) => approve(client, ctx, 'refund', { manager: ctx.cashier })),
      rejected(/active shift manager/),
    );
    const once = await transaction(pool, (client) => approve(client, ctx, 'fiscal_correct'));
    await assert.rejects(
      pool.query(
        'UPDATE local_manager_approvals SET consumed_at=clock_timestamp(),consumed_command_key=$2 WHERE id=$1',
        [once, randomUUID()],
      ),
      rejected(/consumed once/),
    );
    const late = await transaction(pool, (client) =>
      approve(client, ctx, 'refund', { ttl: '50 milliseconds', consume: false }),
    );
    await pool.query('SELECT pg_sleep(0.1)');
    await assert.rejects(
      pool.query(
        'UPDATE local_manager_approvals SET consumed_at=clock_timestamp(),consumed_command_key=$2 WHERE id=$1',
        [late, randomUUID()],
      ),
      rejected(/check constraint/),
    );
    // Receipts: pending -> recorded; correction only with a consumed fiscal_correct approval;
    // not_required only for a voided sale.
    const receipt = (
      await pool.query("SELECT id FROM pos_fiscal_receipts WHERE order_id=$1 AND kind='sale'", [
        mixed.orderId,
      ])
    ).rows[0].id;
    const record = (number, version, approval = null) =>
      pool.query(
        "UPDATE pos_fiscal_receipts SET state='recorded',receipt_number=$2,version=$3,recorded_by_staff_id=$4,recorded_at=clock_timestamp(),approval_id=$5 WHERE id=$1",
        [receipt, number, version, ctx.cashier.staff_id, approval],
      );
    await assert.rejects(record('SYN-1', 3), rejected(/receipt transition/));
    await record('SYN-1', 2);
    await assert.rejects(record('SYN-2', 3), rejected(/receipt transition/));
    const wrong = await transaction(pool, (client) => approve(client, ctx, 'refund'));
    await assert.rejects(record('SYN-2', 3, wrong), rejected(/fiscal_correct approval/));
    await record('SYN-2', 3, once);
    await assert.rejects(
      pool.query(
        "UPDATE pos_fiscal_receipts SET state='not_required',version=version+1 WHERE order_id=$1 AND kind='refund'",
        [mixed.orderId],
      ),
      rejected(/receipt transition/),
    );
    await pool.query(
      "UPDATE pos_fiscal_receipts SET state='not_required',version=version+1 WHERE order_id=$1 AND kind='sale'",
      [cash.orderId],
    );
    await assert.rejects(
      pool.query('DELETE FROM pos_fiscal_receipts'),
      rejected(/cannot be deleted/),
    );
    // Closing with pending receipts needs the shift_close_pending_fiscal approval.
    assert.equal(
      (await pool.query('SELECT pos_shift_pending_fiscal($1) AS n', [ctx.shift])).rows[0].n,
      3,
    );
    const close = (approval, pending) =>
      transaction(pool, async (client) => {
        const id = approval ? await approve(client, ctx, approval) : null;
        await client.query(
          "UPDATE local_cash_shifts SET state='closed',version=2,closed_at=clock_timestamp(),closed_by_staff_id=$2,counted_cash_minor=0,discrepancy_minor=0,closing_reason='Синтетика',closed_report=$3 WHERE id=$1",
          [ctx.shift, ctx.manager.staff_id, { expected_cash_minor: '0' }],
        );
        await client.query(
          'INSERT INTO pos_shift_reports(shift_id,branch_id,terminal_id,report,terminal_reported_minor,pending_fiscal_count,approval_id) VALUES($1,$2,$3,$4,NULL,$5,$6)',
          [
            ctx.shift,
            ctx.branch,
            ctx.terminal,
            { kind: 'z', shift_id: ctx.shift, terminal_id: ctx.terminal },
            pending,
            id,
          ],
        );
      });
    await assert.rejects(close(null, 0), rejected(/pending receipts/));
    await assert.rejects(close(null, 3), rejected(/check constraint/));
    await assert.rejects(close('refund', 3), rejected(/pending receipts/));
    await close('shift_close_pending_fiscal', 3);
    await assert.rejects(
      pool.query('UPDATE pos_shift_reports SET pending_fiscal_count=0'),
      rejected(/immutable/),
    );
  });
});

/** Resolves once `ready()` is true, polling the database; fails after `ms`. */
async function until(ready, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error('Condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
/** A transaction hook that signals it is inside and waits for the test to let it commit. */
function gate() {
  let enter, leave;
  const inside = new Promise((resolve) => (enter = resolve));
  const open = new Promise((resolve) => (leave = resolve));
  return {
    inside,
    leave,
    hold: async () => {
      enter();
      await open;
    },
  };
}

test('an order number belongs to one sale that is not voided; no Webkassa return without a sale receipt', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const duplicate = (error) => error.code === '23505' && /not voided/.test(error.message);
    // A second cash desk with its own open sales shift.
    const other = await provisionStaff(pool, ctx.branch, {
      staff_id: randomUUID(),
      terminal_id: randomUUID(),
      name: 'Synthetic staff',
      role: 'cashier',
    });
    const deskB = { ...ctx, cashier: other, terminal: other.terminal_id, shift: randomUUID() };
    await pool.query(
      'INSERT INTO local_cash_shifts(id,branch_id,staff_id,terminal_id,opening_cash_minor,sales_mode) VALUES($1,$2,$3,$4,0,true)',
      [deskB.shift, ctx.branch, ctx.manager.staff_id, other.terminal_id],
    );
    // Aggregator and ChocoFood receipts are not required by default (contracts section 00).
    const glovo = async (ref, extra = {}, q, at = ctx) => {
      const quoted = q ?? (await quote(at, { channel: 'glovo' }));
      return sell(at, quoted, {
        channel: 'glovo',
        ref,
        tenders: [{ method: 'aggregator_glovo', amount: quoted.total_minor }],
        receiptState: 'not_required',
        ...extra,
      });
    };
    const voidOf = (sold, hooks = {}) =>
      refund(
        ctx,
        sold,
        'void',
        [{ tender: sold.tenders[0], amount: sold.tenders[0].amount }],
        pool,
        {
          receiptState: 'not_required',
          ...hooks,
        },
      );
    const state = async (orderId) =>
      (await pool.query('SELECT state FROM local_orders WHERE id=$1', [orderId])).rows[0].state;

    const first = await glovo('GL-FIX-1');
    await assert.rejects(glovo('GL-FIX-1'), duplicate);
    // R1 backstop: a sale never fiscalized has no Webkassa return, for a void or a refund.
    await assert.rejects(
      voidOf(first, { receiptState: 'pending' }),
      rejected(/no Webkassa return/),
    );
    assert.equal(await state(first.orderId), 'paid');
    // The void releases the number: the corrected re-entry under the same number is sold.
    await voidOf(first);
    assert.equal(await state(first.orderId), 'cancelled');
    const reentry = await glovo('GL-FIX-1');
    assert.equal(await state(reentry.orderId), 'paid');
    // A second live sale of that number is refused again; the other channel is another order.
    await assert.rejects(glovo('GL-FIX-1'), duplicate);
    const yandex = await quote(ctx, { channel: 'yandex_eda' });
    await sell(ctx, yandex, {
      channel: 'yandex_eda',
      ref: 'GL-FIX-1',
      tenders: [{ method: 'aggregator_yandex_eda', amount: yandex.total_minor }],
      receiptState: 'not_required',
    });
    // ChocoFood (hall) the same way.
    const choco = async () => {
      const q = await quote(ctx);
      return sell(ctx, q, {
        ref: 'CF-FIX-1',
        tenders: [{ method: 'chocofood', amount: q.total_minor }],
        receiptState: 'not_required',
      });
    };
    const cf = await choco();
    await assert.rejects(choco(), duplicate);
    await voidOf(cf);
    await choco();
    await assert.rejects(choco(), duplicate);
    // A refund of a sale whose receipt was not required has no Webkassa return either.
    const manualQuote = await quote(ctx);
    const manual = await sell(ctx, manualQuote, {
      tenders: [{ method: 'kaspi_manual', amount: manualQuote.total_minor }],
      receiptState: 'not_required',
    });
    await assert.rejects(
      refund(ctx, manual, 'refund', [{ tender: manual.tenders[0], amount: '100' }]),
      rejected(/no Webkassa return/),
    );
    await refund(ctx, manual, 'refund', [{ tender: manual.tenders[0], amount: '100' }], pool, {
      receiptState: 'not_required',
    });

    // A void still in flight on desk A keeps the number taken for desk B (an order on desk A's
    // shift would wait for the void anyway); after its COMMIT the number is free.
    const quotes = await Promise.all([
      quote(deskB, { channel: 'glovo' }),
      quote(deskB, { channel: 'glovo' }),
      quote(ctx, { channel: 'glovo' }),
      quote(deskB, { channel: 'glovo' }),
    ]);
    const voiding = gate();
    const timer = setTimeout(voiding.leave, 10_000);
    const inFlight = voidOf(reentry, { hold: voiding.hold });
    await voiding.inside;
    try {
      await assert.rejects(glovo('GL-FIX-1', {}, quotes[0], deskB), duplicate);
    } finally {
      clearTimeout(timer);
      voiding.leave();
    }
    await inFlight;
    await glovo('GL-FIX-1', {}, quotes[1], deskB);

    // Two inserts of one number at once on two desks: the second waits for the first's lock,
    // then sees the committed sale and is refused at its number. It carries no kitchen admission
    // (COMMIT would refuse that anyway), so it does not wait on the display counter the first
    // one holds and reaches the number lock.
    const selling = gate();
    const held = glovo('GL-FIX-2', { hold: selling.hold }, quotes[2]);
    await selling.inside;
    const second = glovo('GL-FIX-2', { kitchen: false }, quotes[3], deskB).then(
      () => null,
      (error) => error,
    );
    try {
      await until(
        async () =>
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
            )
          ).rows[0].n === 1,
      );
    } finally {
      selling.leave();
    }
    await held;
    assert.ok(duplicate(await second), String(await second));
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM pos_sales WHERE external_order_ref='GL-FIX-2'",
        )
      ).rows[0].n,
      1,
    );

    // The check needs a fresh snapshot after the lock: numbered sales only under read committed.
    for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE'])
      await assert.rejects(
        glovo('GL-FIX-3', { isolation }),
        (error) => error.code === '0A000' && /read committed/.test(error.message),
      );
    const hallQuote = await quote(ctx);
    await sell(ctx, hallQuote, {
      isolation: 'REPEATABLE READ',
      tenders: [{ method: 'kaspi_manual', amount: hallQuote.total_minor }],
    });
    await glovo('GL-FIX-3');
  });
});

test('outbox identity is immutable; restricted runtime and worker roles hold exactly the 5.9 grants', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const event = (
      await pool.query(
        "INSERT INTO pos_sale_outbox(branch_id,kind,entity_id,payload,payload_hash) VALUES($1,'sale',$2,$3,$4) RETURNING event_id,sequence",
        [ctx.branch, randomUUID(), { synthetic: true }, hashJson({ synthetic: true })],
      )
    ).rows[0];
    for (const sql of [
      "UPDATE pos_sale_outbox SET payload='{}'",
      "UPDATE pos_sale_outbox SET kind='refund'",
      'DELETE FROM pos_sale_outbox',
    ])
      await assert.rejects(pool.query(sql), rejected(/identity is immutable/), sql);
    await pool.query("UPDATE pos_sale_outbox SET attempts=attempts+1,last_error='Синтетика'");
    await pool.query(
      'UPDATE pos_sale_outbox SET acknowledged_at=clock_timestamp(),last_error=NULL',
    );
    await assert.rejects(
      pool.query('UPDATE pos_sale_outbox SET acknowledged_at=NULL'),
      rejected(/identity is immutable/),
    );
    assert.match(event.sequence, /^[1-9]/);
    const roles = [];
    const login = async (grants) => {
      const role = 'pos_sales_' + randomUUID().replaceAll('-', ''),
        password = randomBytes(32).toString('hex');
      await ctx.edge.admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      roles.push(role);
      await grants(role);
      const url = new URL(ctx.edge.config.databaseUrl);
      url.username = role;
      url.password = password;
      return { role, pool: createPool(url.toString()) };
    };
    const pools = [];
    try {
      const runtime = await login(async (role) => {
        await applyEdgeRuntimeGrants(pool, role, { schema: ctx.edge.schema, fulfillment: true });
        await pool.query(posSalesRuntimeGrants(role, ctx.edge.schema));
      });
      const worker = await login(async (role) => {
        await pool.query(`GRANT USAGE ON SCHEMA ${ctx.edge.schema} TO ${role}`);
        await pool.query(posSalesWorkerGrants(role, ctx.edge.schema));
      });
      pools.push(runtime.pool, worker.pool);
      const options = { schema: ctx.edge.schema };
      assert.deepEqual(
        await assertPosSalesPrivileges(pool, runtime.role, RUNTIME_PRIVILEGES, options),
        {
          verified: true,
          relations: Object.keys(POS_SALES_RELATIONS).length,
        },
      );
      await assertPosSalesPrivileges(pool, worker.role, WORKER_PRIVILEGES, options);
      await assert.rejects(
        assertPosSalesPrivileges(pool, worker.role, RUNTIME_PRIVILEGES, options),
        /differ/,
      );
      await pool.query(`GRANT DELETE ON ${ctx.edge.schema}.pos_sales TO ${runtime.role}`);
      await assert.rejects(
        assertPosSalesPrivileges(pool, runtime.role, RUNTIME_PRIVILEGES, options),
        /pos_sales/,
      );
      await pool.query(`REVOKE DELETE ON ${ctx.edge.schema}.pos_sales FROM ${runtime.role}`);
      await pool.query(`GRANT UPDATE(reason) ON ${ctx.edge.schema}.pos_sales TO ${runtime.role}`);
      await assert.rejects(
        assertPosSalesPrivileges(pool, runtime.role, RUNTIME_PRIVILEGES, options),
        /pos_sales/,
      );
      await pool.query(
        `REVOKE UPDATE(reason) ON ${ctx.edge.schema}.pos_sales FROM ${runtime.role}`,
      );
      await assertPosSalesPrivileges(pool, runtime.role, RUNTIME_PRIVILEGES, options);
      assert.deepEqual(await posSalesGrantees(pool, options), [runtime.role, worker.role].sort());
      // The restricted runtime can sell, void and refund with these grants (every trigger it
      // fires is reachable), and cannot touch operator settings or the sync state.
      const restricted = { ...ctx, edge: { ...ctx.edge, pool: runtime.pool } };
      const q = await quote(ctx);
      const sold = await sell(
        restricted,
        q,
        {
          tenders: [{ method: 'cash', amount: q.total_minor }],
          tendered: q.total_minor,
          change: '0',
        },
        runtime.pool,
      );
      await refund(
        restricted,
        sold,
        'void',
        [{ tender: sold.tenders[0], amount: q.total_minor }],
        runtime.pool,
      );
      const meal = await quote(ctx);
      const fed = await sell(
        restricted,
        meal,
        {
          revenue: 'staff_meal',
          approval: 'staff_meal',
          beneficiary: 'Синтетика',
          tenders: [{ method: 'staff_meal', amount: meal.total_minor }],
        },
        runtime.pool,
      );
      await refund(
        restricted,
        fed,
        'refund',
        [{ tender: fed.tenders[0], amount: '1000' }],
        runtime.pool,
      );
      await runtime.pool.query(
        "INSERT INTO pos_sale_outbox(branch_id,kind,entity_id,payload,payload_hash) VALUES($1,'void',$2,'{}',$3)",
        [ctx.branch, sold.orderId, hashJson({})],
      );
      await runtime.pool.query(
        `INSERT INTO pos_config_fetches(terminal_id,branch_id,staff_id,client_version) VALUES($1,$2,$3,'pos-2.0.0')
         ON CONFLICT(terminal_id) DO UPDATE SET last_fetched_at=clock_timestamp(),client_version=EXCLUDED.client_version,staff_id=EXCLUDED.staff_id`,
        [ctx.terminal, ctx.branch, ctx.cashier.staff_id],
      );
      for (const sql of [
        "UPDATE pos_payment_methods SET fiscal_policy='not_required'",
        'SELECT * FROM pos_sales_setting_changes',
        'SELECT * FROM pos_sale_sync_state',
        "UPDATE branch_config SET pos_service_mode='unpaid_service'",
        'UPDATE pos_sale_outbox SET attempts=1',
        'DELETE FROM pos_fiscal_receipts',
      ])
        await assert.rejects(runtime.pool.query(sql), (error) => error.code === '42501', sql);
      await worker.pool.query(
        'UPDATE pos_sale_outbox SET attempts=attempts+1 WHERE acknowledged_at IS NULL',
      );
      await worker.pool.query(
        'INSERT INTO pos_sale_sync_state(branch_id,last_supported_at) VALUES($1,clock_timestamp()) ON CONFLICT(branch_id) DO UPDATE SET last_supported_at=EXCLUDED.last_supported_at,updated_at=clock_timestamp()',
        [ctx.branch],
      );
      for (const sql of ["UPDATE pos_sale_outbox SET payload='{}'", 'SELECT * FROM pos_sales'])
        await assert.rejects(worker.pool.query(sql), (error) => error.code === '42501', sql);
    } finally {
      for (const item of pools) await item.end();
      for (const role of roles) {
        await ctx.edge.admin.query(`DROP OWNED BY ${role}`);
        await ctx.edge.admin.query(`DROP ROLE ${role}`);
      }
    }
  });
});

test('cloud073: pos_sale in the old projections, append-only cloud_pos_* and exact API grants', async () => {
  await withSyncDatabases(async (ctx) => {
    const pool = ctx.cloud.pool;
    await provisionDevice(pool, ctx.device);
    const scope = {
      organizationId: ctx.org,
      branchId: ctx.branch,
      deviceId: ctx.device,
      producerId: randomUUID(),
    };
    await provisionCloudPosSync(pool, scope);
    let sequence = 0;
    // Inbox row and projection change together, as the receiver writes them.
    const commercial = (orderId, quoteId, columns) =>
      transaction(pool, async (client) => {
        const event = randomUUID();
        await client.query(
          'INSERT INTO pos_order_sync_inbox(event_id,branch_id,device_id,producer_id,producer_sequence,order_id,aggregate_version,payload_hash,envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            event,
            ctx.branch,
            ctx.device,
            scope.producerId,
            ++sequence,
            orderId,
            columns.version ?? 1,
            hashJson({ event }),
            {},
          ],
        );
        if (columns.version === 2)
          return client.query(
            "UPDATE pos_order_sync_projection SET version=2,state='cancelled',last_event_id=$2,updated_at=clock_timestamp() WHERE order_id=$1",
            [orderId, event],
          );
        return client.query(
          'INSERT INTO pos_order_sync_projection(order_id,branch_id,device_id,producer_id,quote_id,snapshot,snapshot_hash,total_minor,version,state,last_event_id,payment_state,execution_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12)',
          [
            orderId,
            ctx.branch,
            ctx.device,
            scope.producerId,
            quoteId,
            {},
            hashJson({ quoteId }),
            '349000',
            columns.state,
            event,
            columns.payment,
            columns.mode,
          ],
        );
      });
    const kitchen = (orderId, quoteId, mode) =>
      transaction(pool, async (client) => {
        const event = randomUUID();
        await client.query(
          "INSERT INTO pos_kitchen_sync_inbox(event_id,branch_id,device_id,producer_id,producer_sequence,order_id,aggregate_version,event_type,payload_hash,envelope) VALUES($1,$2,$3,$4,$5,$6,1,'edge.fulfillment_accepted',$7,'{}')",
          [
            event,
            ctx.branch,
            ctx.device,
            scope.producerId,
            ++sequence,
            orderId,
            hashJson({ event }),
          ],
        );
        return client.query(
          "INSERT INTO pos_kitchen_sync_projection(order_id,branch_id,device_id,producer_id,reservation_id,quote_id,quote_digest,owner_hash,execution_mode,display_number,routing_version,assembly_station_id,version,state,created_at,updated_at,last_event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,12,1,$10,1,'accepted',clock_timestamp(),clock_timestamp(),$11)",
          [
            orderId,
            ctx.branch,
            ctx.device,
            scope.producerId,
            randomUUID(),
            quoteId,
            hashJson({ quoteId }),
            hashJson({ orderId }),
            mode,
            randomUUID(),
            event,
          ],
        );
      });
    const sold = randomUUID(),
      soldQuote = randomUUID();
    await commercial(sold, soldQuote, { state: 'paid', payment: 'captured', mode: 'pos_sale' });
    await assert.rejects(
      kitchen(sold, soldQuote, 'unpaid_service'),
      rejected(/must precede kitchen admission/),
    );
    await kitchen(sold, soldQuote, 'pos_sale');
    await commercial(sold, soldQuote, { version: 2 });
    assert.deepEqual(
      (
        await pool.query(
          'SELECT state,payment_state,execution_mode FROM pos_order_sync_projection WHERE order_id=$1',
          [sold],
        )
      ).rows[0],
      { state: 'cancelled', payment_state: 'captured', execution_mode: 'pos_sale' },
    );
    for (const columns of [
      { state: 'paid', payment: 'not_started', mode: 'unpaid_service' },
      { state: 'paid', payment: 'captured', mode: null },
      { state: 'awaiting_payment', payment: 'captured', mode: 'pos_sale' },
      { state: 'awaiting_payment', payment: 'not_started', mode: 'pos_sale' },
    ])
      await assert.rejects(
        commercial(randomUUID(), randomUUID(), columns),
        rejected(/check constraint/),
        JSON.stringify(columns),
      );
    const unpaid = randomUUID(),
      unpaidQuote = randomUUID();
    await commercial(unpaid, unpaidQuote, {
      state: 'awaiting_payment',
      payment: 'not_started',
      mode: null,
    });
    await assert.rejects(
      kitchen(unpaid, unpaidQuote, 'pos_sale'),
      rejected(/must precede kitchen admission/),
    );

    // cloud_pos_*: projections of the posSales stream; only a newer event moves them.
    const order = randomUUID(),
      tender = randomUUID(),
      refund = randomUUID(),
      receipt = randomUUID(),
      shift = randomUUID();
    await pool.query(
      `INSERT INTO cloud_pos_sale_inbox(event_id,branch_id,device_id,sequence,kind,payload_hash) VALUES($1,$2,$3,1,'sale',$4)`,
      [randomUUID(), ctx.branch, ctx.device, hashJson({ order })],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO cloud_pos_sale_inbox(event_id,branch_id,device_id,sequence,kind,payload_hash) VALUES($1,$2,$3,1,'void',$4)`,
        [randomUUID(), ctx.branch, ctx.device, hashJson({ order })],
      ),
      (error) => error.code === '23505',
    );
    await assert.rejects(
      pool.query('UPDATE cloud_pos_sale_inbox SET kind=kind'),
      rejected(/immutable/),
    );
    const sale = (columns = {}) =>
      pool.query(
        `INSERT INTO cloud_pos_sales(order_id,branch_id,device_id,shift_id,terminal_id,cashier_staff_id,display_number,sold_at,business_date,
         sales_channel,service_mode,revenue_kind,external_order_ref,subtotal_minor,total_minor,cash_tendered_minor,change_minor,release_id,menu_version,lines,last_sequence)
         VALUES($1,$2,$3,$4,$5,$6,12,'2026-11-19T06:00:00Z','2026-11-19',$7,$8,'revenue',$9,'349000',$10,$11,$12,$13,7,'[]',1)`,
        [
          columns.order ?? order,
          ctx.branch,
          ctx.device,
          shift,
          randomUUID(),
          randomUUID(),
          columns.channel ?? 'hall',
          columns.service ?? 'takeaway',
          columns.ref ?? null,
          columns.total ?? '349000',
          'tendered' in columns ? columns.tendered : '400000',
          columns.change ?? '51000',
          randomUUID(),
        ],
      );
    await sale();
    for (const columns of [
      { order: randomUUID(), total: '349001' },
      { order: randomUUID(), channel: 'glovo' },
      { order: randomUUID(), channel: 'glovo', ref: 'GL-SYN-1', service: 'dine_in' },
      { order: randomUUID(), tendered: null },
    ])
      await assert.rejects(sale(columns), rejected(/check constraint/), JSON.stringify(columns));
    await pool.query(
      "INSERT INTO cloud_pos_tenders(tender_id,order_id,branch_id,method,amount_minor,confirmation,created_at) VALUES($1,$2,$3,'cash','349000','drawer',clock_timestamp())",
      [tender, order, ctx.branch],
    );
    await pool.query(
      "INSERT INTO cloud_pos_refunds(refund_id,order_id,branch_id,kind,amount_minor,reason_code,reason,staff_id,approved_by_staff_id,shift_id,created_at) VALUES($1,$2,$3,'void','349000','guest_changed_mind','Гость передумал',$4,$5,$6,clock_timestamp())",
      [refund, order, ctx.branch, randomUUID(), randomUUID(), shift],
    );
    await pool.query(
      "INSERT INTO cloud_pos_refund_tenders(refund_id,tender_id,order_id,branch_id,method,amount_minor) VALUES($1,$2,$3,$4,'cash','349000')",
      [refund, tender, order, ctx.branch],
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO cloud_pos_refund_tenders(refund_id,tender_id,order_id,branch_id,method,amount_minor) VALUES($1,$2,$3,$4,'kaspi_terminal','1')",
        [randomUUID(), tender, order, ctx.branch],
      ),
      (error) => error.code === '23503',
    );
    await assert.rejects(
      pool.query("UPDATE cloud_pos_sales SET reason='x' WHERE order_id=$1", [order]),
      rejected(/projection change/),
    );
    await assert.rejects(
      pool.query(
        "UPDATE cloud_pos_sales SET state='voided',voided_at=clock_timestamp() WHERE order_id=$1",
        [order],
      ),
      rejected(/projection change/),
    );
    await pool.query(
      "UPDATE cloud_pos_sales SET state='voided',voided_at=clock_timestamp(),last_sequence=3 WHERE order_id=$1",
      [order],
    );
    await assert.rejects(
      pool.query(
        "UPDATE cloud_pos_sales SET state='paid',voided_at=NULL,last_sequence=4 WHERE order_id=$1",
        [order],
      ),
      rejected(/projection change/),
    );
    for (const sql of [
      'UPDATE cloud_pos_tenders SET reference=reference',
      'DELETE FROM cloud_pos_refunds',
      'UPDATE cloud_pos_refund_tenders SET amount_minor=amount_minor',
      'DELETE FROM cloud_pos_sales',
    ])
      await assert.rejects(pool.query(sql), (error) => error.code === '23514', sql);
    await pool.query(
      "INSERT INTO cloud_pos_fiscal_receipts(receipt_id,order_id,branch_id,kind,mode,state,version,amount_minor) VALUES($1,$2,$3,'sale','manual_webkassa','pending',1,'349000')",
      [receipt, order, ctx.branch],
    );
    const record = (version, state = 'recorded') =>
      pool.query(
        "UPDATE cloud_pos_fiscal_receipts SET state=$3,receipt_number=CASE WHEN $3='recorded' THEN 'SYN-1' END,version=$2,recorded_by_staff_id=CASE WHEN $3='recorded' THEN $4::uuid END,recorded_at=CASE WHEN $3='recorded' THEN clock_timestamp() END WHERE receipt_id=$1",
        [receipt, version, state, randomUUID()],
      );
    await record(2);
    await assert.rejects(record(2), rejected(/projection change/));
    await assert.rejects(record(3, 'pending'), rejected(/projection change/));
    await record(3);
    const report = (counted, discrepancy) =>
      pool.query(
        'INSERT INTO cloud_pos_shift_reports(shift_id,branch_id,device_id,terminal_id,opened_at,closed_at,report,expected_cash_minor,counted_cash_minor,discrepancy_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          shift,
          ctx.branch,
          ctx.device,
          order,
          '2026-11-19T01:00:00Z',
          '2026-11-19T15:00:00Z',
          { kind: 'z', shift_id: shift, terminal_id: order },
          '100000',
          counted,
          discrepancy,
        ],
      );
    await assert.rejects(report('99000', '1000'), rejected(/check constraint/));
    await report('99000', '-1000');
    await assert.rejects(
      pool.query('UPDATE cloud_pos_shift_reports SET counted_cash_minor=counted_cash_minor'),
      rejected(/immutable/),
    );

    // One API role is receiver and back-office reader: exact union, reset on every apply.
    const role = 'pos_cloud_' + randomUUID().replaceAll('-', '');
    await ctx.cloud.admin.query(`CREATE ROLE ${role} NOLOGIN`);
    try {
      await pool.query(`GRANT USAGE ON SCHEMA ${ctx.cloud.schema} TO ${role}`);
      for (const options of [
        { receiver: true, backoffice: true },
        { receiver: false, backoffice: true },
        { receiver: false, backoffice: false },
        { receiver: true, backoffice: false },
      ]) {
        await pool.query(cloudPosSalesGrants(role, options, ctx.cloud.schema));
        await assertCloudPosSalesPrivileges(pool, role, options, ctx.cloud.schema);
      }
      assert.deepEqual(
        cloudPosSalesPrivileges({ receiver: true, backoffice: false }),
        CLOUD_RUNTIME_PRIVILEGES,
      );
      assert.equal(Object.keys(CLOUD_WORKER_PRIVILEGES).length, 0);
      assert.equal(CLOUD_MIGRATION, '073_cloud_pos_sales_sync.sql');
      assert.deepEqual(await cloudPosSalesGrantees(pool, ctx.cloud.schema), [role]);
      await pool.query(
        cloudPosSalesGrants(role, { receiver: false, backoffice: true }, ctx.cloud.schema),
      );
      await assert.rejects(
        assertCloudPosSalesPrivileges(
          pool,
          role,
          { receiver: true, backoffice: true },
          ctx.cloud.schema,
        ),
        /differ/,
      );
      assert.throws(() => cloudPosSalesGrants(role, { receiver: 'yes', backoffice: false }));
    } finally {
      await ctx.cloud.admin.query(`DROP OWNED BY ${role}`);
      await ctx.cloud.admin.query(`DROP ROLE ${role}`);
    }
  });
});
