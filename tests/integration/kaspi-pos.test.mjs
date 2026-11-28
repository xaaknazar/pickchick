import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool, transaction } from '@pickchick/database';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import {
  closeCashShift,
  createPosSale,
  createQuote,
  createTerminalPayment,
  listOpenTerminalPayments,
  pollTerminalPayments,
  provisionStaff,
  readPosConfig,
  readTerminalPayment,
  setOrdering,
} from '@pickchick/local-orders';
import { localUnpaidExecution, provisionFulfillment } from '@pickchick/edge-fulfillment';
import { PosTerminalPaymentSchema } from '@pickchick/contracts';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';
import { assertKaspiPosRuntimePrivileges } from '../../infra/windows/kaspi-pos-grants.mjs';
import {
  linkKaspiTerminal,
  parseKaspiTerminalSetupArgs,
  unlinkKaspiTerminal,
  KaspiTerminalSetupError,
} from '../../scripts/kaspi-terminal-setup.mjs';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { staffAuth } from '../helpers/orders.mjs';

// ADR-0017: the Kaspi Smart POS adapter on the real schema029 with a scripted terminal simulator.
// The simulator follows docs/integrations/kaspi-smart-pos-api.md; it is not the real device.
// Synthetic data only.
const code = (expected) => (error) => error.code === expected;
const CERT = 'a'.repeat(64);

/** A scripted terminal: payment answers and the queue of status answers per processId. */
function simulator() {
  const calls = [];
  const script = { payment: [], status: [], actualize: [], revoke: [] };
  let process = 0;
  return {
    calls,
    script,
    async call(link, method, params, options = {}) {
      calls.push({ method, params, token: options.token ?? null });
      const next = script[method]?.shift();
      if (next) return typeof next === 'function' ? next(params) : next;
      if (method === 'payment')
        return { kind: 'ok', data: { processId: `p${++process}`, status: 'wait' } };
      if (method === 'status' || method === 'actualize')
        return { kind: 'ok', data: { status: 'wait', subStatus: 'WaitUser' } };
      if (method === 'register')
        return {
          kind: 'ok',
          data: {
            accessToken: 'access-token-1',
            refreshToken: 'refresh-token-1',
            expirationDate: '2099-01-01 10:00:00',
          },
        };
      if (method === 'deviceinfo')
        return {
          kind: 'ok',
          data: { posNum: '1', serialNum: 'SYN-SERIAL', terminalId: 'SYN-TID' },
        };
      if (method === 'revoke')
        return {
          kind: 'ok',
          data: {
            accessToken: 'access-token-2',
            refreshToken: 'refresh-token-2',
            expirationDate: '2099-01-02 10:00:00',
          },
        };
      return { kind: 'unreachable', reason: 'CONNECT' };
    },
  };
}
const success = (transactionId = 'SYN-TXN-1', method = 'qr') => ({
  kind: 'ok',
  data: {
    status: 'success',
    subStatus: method === 'qr' ? 'QrTransactionSuccess' : 'CardTransactionSuccess',
    transactionId,
    chequeInfo: { method, amount: '2 990 ₸', orderNumber: 'SYN-ORDER', storeName: 'Synthetic' },
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
  const cashier = await provisionStaff(edge, ctx.branch, person('cashier'));
  const manager = await provisionStaff(
    edge,
    ctx.branch,
    person('shift_manager', cashier.terminal_id),
  );
  const other = await provisionStaff(edge, ctx.branch, person('cashier'));
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
  for (const method of ['cash', 'kaspi_terminal']) {
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
  }
  for (const desk of [cashier, other])
    await edge.query(
      'INSERT INTO local_cash_shifts(id,branch_id,staff_id,terminal_id,opening_cash_minor,sales_mode) VALUES($1,$2,$3,$4,0,true)',
      [randomUUID(), ctx.branch, manager.staff_id, desk.terminal_id],
    );
  return {
    ...ctx,
    release,
    cashier,
    manager,
    other,
    execution: localUnpaidExecution({ enabled: true, deviceId: ctx.device }),
  };
}
async function link(ctx, terminal = ctx.cashier.terminal_id, expires = '2099-01-01T00:00:00Z') {
  const id = randomUUID();
  await ctx.edge.pool.query(
    `INSERT INTO kaspi_pos_devices(id,branch_id,terminal_id,host,certificate_sha256,integration_name,
     access_token,refresh_token,token_expires_at) VALUES($1,$2,$3,'192.168.2.50',$4,'PickChick-1',
     'access-token-0','refresh-token-0',$5)`,
    [id, ctx.branch, terminal, CERT, expires],
  );
  return id;
}
const desk = (run) => withSyncDatabases(async (ctx) => run(await prepare(ctx)));
const quote = (ctx, actor = ctx.cashier) =>
  createQuote(ctx.edge.pool, ctx.branch, staffAuth(actor), {
    release_id: ctx.release.release_id,
    service_mode: 'takeaway',
    items: [{ variant_id: ctx.release.items[0].variant_id, quantity: 1 }],
  });
const pay = (ctx, port, body, { actor = ctx.cashier, key = randomUUID() } = {}) =>
  createTerminalPayment(ctx.edge.pool, ctx.branch, staffAuth(actor), key, body, port);
const poll = (ctx, port, id, actor = ctx.cashier) =>
  readTerminalPayment(ctx.edge.pool, ctx.branch, staffAuth(actor), id, port);
const sell = (ctx, q, tenders, actor = ctx.cashier, extra = {}) =>
  createPosSale(
    ctx.edge.pool,
    ctx.branch,
    staffAuth(actor),
    randomUUID(),
    { quote_id: q.quote_id, service_mode_confirmed: true, order_repeated: true, tenders, ...extra },
    ctx.execution,
  );

test('terminal payment: wait, success, then the sale names the attempt and goes to the kitchen', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const port = simulator();
    await link(ctx);
    const config = await readPosConfig(pool, ctx.branch, staffAuth(ctx.cashier));
    assert.equal(config.kaspi_terminal_link, true);
    assert.equal(
      (await readPosConfig(pool, ctx.branch, staffAuth(ctx.other))).kaspi_terminal_link,
      false,
    );
    const q = await quote(ctx);
    const key = randomUUID();
    const started = await pay(
      ctx,
      port,
      { quote_id: q.quote_id, amount_minor: q.total_minor },
      { key },
    );
    PosTerminalPaymentSchema.parse(started);
    assert.equal(started.state, 'wait');
    assert.deepEqual(
      port.calls.map((c) => c.method),
      ['payment'],
    );
    assert.deepEqual(port.calls[0].params, { amount: (BigInt(q.total_minor) / 100n).toString() });
    assert.equal(port.calls[0].token, 'access-token-0');
    // A replay of the same command returns the same attempt and never pays again.
    const replay = await pay(
      ctx,
      port,
      { quote_id: q.quote_id, amount_minor: q.total_minor },
      { key },
    );
    assert.equal(replay.attempt_id, started.attempt_id);
    assert.equal(port.calls.filter((c) => c.method === 'payment').length, 1);
    // The cash desk cannot sell with the attempt before the terminal confirms.
    await assert.rejects(
      sell(ctx, q, [
        { method: 'kaspi_terminal', amount_minor: q.total_minor, attempt_id: started.attempt_id },
      ]),
      code('TERMINAL_ATTEMPT_INVALID'),
    );
    assert.equal((await poll(ctx, port, started.attempt_id)).sub_status, 'WaitUser');
    port.script.status.push(success('SYN-TXN-42', 'card'));
    const paid = await poll(ctx, port, started.attempt_id);
    assert.equal(paid.state, 'success');
    assert.equal(paid.transaction_id, 'SYN-TXN-42');
    assert.equal(paid.payment_method, 'card');
    assert.deepEqual(
      (await listOpenTerminalPayments(pool, ctx.branch, staffAuth(ctx.cashier))).items.map(
        (i) => i.attempt_id,
      ),
      [started.attempt_id],
    );
    // Another desk does not see nor use it.
    await assert.rejects(poll(ctx, port, started.attempt_id, ctx.other), code('NOT_FOUND'));
    // A typed reference next to the attempt, another amount: refused.
    await assert.rejects(
      sell(ctx, q, [
        {
          method: 'kaspi_terminal',
          amount_minor: q.total_minor,
          attempt_id: started.attempt_id,
          reference: 'X',
        },
      ]),
      code('INVALID_REQUEST'),
    );
    const result = await sell(ctx, q, [
      { method: 'kaspi_terminal', amount_minor: q.total_minor, attempt_id: started.attempt_id },
    ]);
    assert.equal(result.order.state, 'paid');
    assert.equal(result.sale.tenders[0].reference, 'SYN-TXN-42');
    const tender = (
      await pool.query('SELECT attempt_id,confirmation FROM pos_sale_tenders WHERE order_id=$1', [
        result.order.order_id,
      ])
    ).rows[0];
    assert.equal(tender.attempt_id, started.attempt_id);
    assert.equal(tender.confirmation, 'cashier_attested');
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM fulfillment_reservations WHERE order_id=$1',
          [result.order.order_id],
        )
      ).rows[0].n,
      1,
    );
    const used = await poll(ctx, port, started.attempt_id);
    assert.equal(used.order_id, result.order.order_id);
    assert.equal(
      (await listOpenTerminalPayments(pool, ctx.branch, staffAuth(ctx.cashier))).items.length,
      0,
    );
    // A paid attempt pays one order: a second quote cannot take it.
    const q2 = await quote(ctx);
    await assert.rejects(
      sell(ctx, q2, [
        { method: 'kaspi_terminal', amount_minor: q2.total_minor, attempt_id: started.attempt_id },
      ]),
      code('TERMINAL_ATTEMPT_INVALID'),
    );
  });
});

// The guest paid on the terminal: the sale is made even when the item went to stop, the menu moved
// on, the branch closed or the method was switched off meanwhile (owner decision; a refund that
// cannot be cooked is a manual terminal refund). Everything else still holds.
async function paidAttempt(ctx, port, q, transactionId = 'SYN-TXN-PAID') {
  const started = await pay(ctx, port, { quote_id: q.quote_id, amount_minor: q.total_minor });
  port.script.status.push(success(transactionId));
  assert.equal((await poll(ctx, port, started.attempt_id)).state, 'success');
  return started.attempt_id;
}
const terminalTender = (q, attemptId) => [
  { method: 'kaspi_terminal', amount_minor: q.total_minor, attempt_id: attemptId },
];
const cashTender = (q) => [{ method: 'cash', amount_minor: q.total_minor }];
const cashSale = (ctx, q) =>
  sell(ctx, q, cashTender(q), ctx.cashier, { cash_tendered_minor: q.total_minor });
const happen = {
  stop: (ctx, q) =>
    ctx.edge.pool.query(
      "INSERT INTO local_stops(branch_id,variant_id,stopped,version,reason) VALUES($1,$2,true,1,'Закончилось')",
      [ctx.branch, q.lines[0].variant_id],
    ),
  menu: async (ctx) =>
    applyMenu(ctx.edge.pool, ctx.branch, await publishMenu(ctx.cloud.pool, ctx.menu(2))),
  closed: (ctx) =>
    setOrdering(ctx.edge.pool, ctx.branch, staffAuth(ctx.manager), randomUUID(), false, {
      expected_version: 2,
    }),
  method: (ctx, _q, method = 'kaspi_terminal') =>
    transaction(ctx.edge.pool, async (client) => {
      await setting(
        client,
        ctx.branch,
        method,
        { enabled: true, fiscal_policy: 'manual_webkassa' },
        { enabled: false, fiscal_policy: 'manual_webkassa' },
      );
      await client.query(
        'UPDATE pos_payment_methods SET enabled=false WHERE branch_id=$1 AND code=$2',
        [ctx.branch, method],
      );
    }),
};
// Since edge 030 a sales shift does not close over a paid, unsold terminal payment
// (TERMINAL_UNSOLD_PAYMENTS). A test that needs a closed desk WITH such a payment closes it as an
// edge whose schema_migrations lacks the 030 row (the server's gate for every 030 behaviour).
const as030Absent = (ctx) =>
  ctx.edge.pool.query(
    "DELETE FROM schema_migrations WHERE version='030_edge_kaspi_pos_release.sql'",
  );
const overrides = async (ctx, orderId) =>
  (
    await ctx.edge.pool.query(
      "SELECT action FROM local_audit WHERE resource_id=$1 AND action LIKE 'pos_sale.paid_override%' ORDER BY action",
      [orderId],
    )
  ).rows.map((row) => row.action);
async function assertSoldAndCooked(ctx, result, attemptId) {
  assert.equal(result.order.state, 'paid');
  assert.equal(result.order.payment_state, 'captured');
  const orderId = result.order.order_id;
  const pool = ctx.edge.pool;
  assert.equal(
    (await pool.query('SELECT state FROM fulfillment_reservations WHERE order_id=$1', [orderId]))
      .rows[0].state,
    'accepted',
  );
  assert.ok(
    (await pool.query('SELECT count(*)::int n FROM fulfillment_tasks WHERE order_id=$1', [orderId]))
      .rows[0].n > 0,
  );
  assert.equal(
    (await pool.query('SELECT order_id FROM kaspi_pos_attempts WHERE id=$1', [attemptId])).rows[0]
      .order_id,
    orderId,
  );
}

test('paid on the terminal: an item put on stop after the payment is still sold and cooked', async () => {
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    const attemptId = await paidAttempt(ctx, port, q);
    await happen.stop(ctx, q);
    const result = await sell(ctx, q, terminalTender(q, attemptId));
    await assertSoldAndCooked(ctx, result, attemptId);
    const events = await overrides(ctx, result.order.order_id);
    assert.ok(events.some((a) => a.startsWith('pos_sale.paid_override|')));
    const summary = events.find((a) => a.startsWith('pos_sale.paid_override|'));
    assert.match(summary, new RegExp(`attempt=${attemptId}`));
    assert.match(summary, new RegExp(`amount=${q.total_minor}`));
    assert.match(summary, /checks=item_stopped$/);
    const item = events.find((a) => a.startsWith('pos_sale.paid_override.item_stopped|'));
    assert.match(item, new RegExp(`variant=${q.lines[0].variant_id}`));
    assert.ok(item.includes(q.lines[0].name.ru));
  });
});

test('paid on the terminal: a new menu release does not refuse the sale; the quote snapshot is sold', async () => {
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    const attemptId = await paidAttempt(ctx, port, q);
    await happen.menu(ctx);
    const result = await sell(ctx, q, terminalTender(q, attemptId));
    await assertSoldAndCooked(ctx, result, attemptId);
    assert.equal(result.sale.total_minor, q.total_minor);
    const events = await overrides(ctx, result.order.order_id);
    assert.ok(events.some((a) => /checks=menu_changed$/.test(a)));
    const menu = events.find((a) => a.startsWith('pos_sale.paid_override.menu_changed|'));
    assert.match(menu, new RegExp(`quote_release=${q.release_id}`));
    assert.match(menu, /active_release=[0-9a-f-]{36}/);
    const reservation = (
      await ctx.edge.pool.query('SELECT snapshot FROM fulfillment_reservations WHERE order_id=$1', [
        result.order.order_id,
      ])
    ).rows[0];
    assert.equal(reservation.snapshot.totalMinor, q.total_minor);
  });
});

test('paid on the terminal: a closed branch still takes the sale and the kitchen admits it', async () => {
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    const attemptId = await paidAttempt(ctx, port, q);
    await happen.closed(ctx);
    const result = await sell(ctx, q, terminalTender(q, attemptId));
    await assertSoldAndCooked(ctx, result, attemptId);
    assert.ok(
      (await overrides(ctx, result.order.order_id)).some((a) => /checks=branch_closed$/.test(a)),
    );
  });
});

test('paid on the terminal: the kaspi_terminal method switched off meanwhile does not refuse it', async () => {
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    const attemptId = await paidAttempt(ctx, port, q);
    await happen.method(ctx);
    const result = await sell(ctx, q, terminalTender(q, attemptId));
    await assertSoldAndCooked(ctx, result, attemptId);
    assert.ok(
      (await overrides(ctx, result.order.order_id)).some((a) => /checks=method_disabled$/.test(a)),
    );
  });
});

test('paid on the terminal: stop and new menu at once; sold once, replay idempotent', async () => {
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    const attemptId = await paidAttempt(ctx, port, q);
    const q2 = await quote(ctx);
    for (const change of ['stop', 'menu']) await happen[change](ctx, q);
    const key = randomUUID();
    const body = {
      quote_id: q.quote_id,
      service_mode_confirmed: true,
      order_repeated: true,
      tenders: terminalTender(q, attemptId),
    };
    const run = () =>
      createPosSale(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), key, body, ctx.execution);
    const result = await run();
    await assertSoldAndCooked(ctx, result, attemptId);
    const events = await overrides(ctx, result.order.order_id);
    assert.ok(events.some((a) => a.endsWith('checks=menu_changed,item_stopped')));
    // The same request again returns the stored sale: no second order, no second audit.
    const again = await run();
    assert.equal(again.order.order_id, result.order.order_id);
    assert.deepEqual(await overrides(ctx, result.order.order_id), events);
    assert.equal(
      (await ctx.edge.pool.query('SELECT count(*)::int n FROM local_orders')).rows[0].n,
      1,
    );
    // The attempt pays one order: another quote cannot take it, a new key on this quote conflicts.
    await assert.rejects(
      sell(ctx, q2, terminalTender(q2, attemptId)),
      code('TERMINAL_ATTEMPT_INVALID'),
    );
    await assert.rejects(sell(ctx, q, terminalTender(q, attemptId)), code('CONFLICT'));
  });
});

test('paid on the terminal: no bypass event when nothing would have refused the sale', async () => {
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    const attemptId = await paidAttempt(ctx, port, q);
    const result = await sell(ctx, q, terminalTender(q, attemptId));
    await assertSoldAndCooked(ctx, result, attemptId);
    assert.deepEqual(await overrides(ctx, result.order.order_id), []);
  });
});

test('without a paid attempt the same four conditions still refuse the sale', async () => {
  const expected = {
    stop: 'ITEM_STOPPED',
    menu: 'MENU_CHANGED',
    closed: 'BRANCH_UNAVAILABLE',
  };
  for (const [change, error] of Object.entries(expected))
    await desk(async (ctx) => {
      const q = await quote(ctx);
      await happen[change](ctx, q);
      await assert.rejects(cashSale(ctx, q), code(error));
      assert.equal((await ctx.edge.pool.query('SELECT 1 FROM local_orders')).rowCount, 0);
    });
  await desk(async (ctx) => {
    const q = await quote(ctx);
    await happen.method(ctx, q, 'cash');
    await assert.rejects(cashSale(ctx, q), code('METHOD_DISABLED'));
    assert.equal((await ctx.edge.pool.query('SELECT 1 FROM local_orders')).rowCount, 0);
  });
});

test('paid on the terminal: all four checks at once; sold once with every check named in the audit', async () => {
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    const attemptId = await paidAttempt(ctx, port, q);
    for (const change of ['stop', 'menu', 'closed', 'method']) await happen[change](ctx, q);
    const result = await sell(ctx, q, terminalTender(q, attemptId));
    await assertSoldAndCooked(ctx, result, attemptId);
    const events = await overrides(ctx, result.order.order_id);
    assert.ok(
      events.some((a) =>
        a.endsWith('checks=branch_closed,menu_changed,item_stopped,method_disabled'),
      ),
      events.join('\n'),
    );
    assert.equal(
      (
        await ctx.edge.pool.query(
          "SELECT enabled FROM pos_payment_methods WHERE branch_id=$1 AND code='kaspi_terminal'",
          [ctx.branch],
        )
      ).rows[0].enabled,
      false,
    );
  });
});

test('a paid unused attempt does not let a closed branch or a switched-off method take another payment', async () => {
  // Closed branch: the guest paid on the terminal, the cashier takes cash for the same quote.
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    await paidAttempt(ctx, port, q);
    await happen.closed(ctx);
    await assert.rejects(cashSale(ctx, q), code('BRANCH_UNAVAILABLE'));
    assert.equal((await ctx.edge.pool.query('SELECT 1 FROM local_orders')).rowCount, 0);
  });
  // Cash switched off: a terminal bypass is for the terminal part only.
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    await paidAttempt(ctx, port, q);
    await happen.method(ctx, q, 'cash');
    await assert.rejects(cashSale(ctx, q), code('METHOD_DISABLED'));
    assert.equal((await ctx.edge.pool.query('SELECT 1 FROM local_orders')).rowCount, 0);
  });
  // A part paid on the terminal plus cash is not "paid on the terminal": a closed branch refuses it.
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    assert.ok(BigInt(q.total_minor) > 100n && BigInt(q.total_minor) % 100n === 0n);
    const part = '100';
    const started = await pay(ctx, port, { quote_id: q.quote_id, amount_minor: '100' });
    port.script.status.push(success('SYN-TXN-PART'));
    assert.equal((await poll(ctx, port, started.attempt_id)).state, 'success');
    await happen.closed(ctx);
    const rest = (BigInt(q.total_minor) - BigInt(part)).toString();
    await assert.rejects(
      sell(
        ctx,
        q,
        [
          { method: 'kaspi_terminal', amount_minor: part, attempt_id: started.attempt_id },
          { method: 'cash', amount_minor: rest },
        ],
        ctx.cashier,
        { cash_tendered_minor: rest },
      ),
      code('BRANCH_UNAVAILABLE'),
    );
  });
});

test('a sale paid by two terminal parts is not "paid on the terminal": a closed branch refuses it', async () => {
  await desk(async (ctx) => {
    const port = simulator();
    const device = await link(ctx);
    const pool = ctx.edge.pool;
    const q = await quote(ctx);
    const first = await pay(ctx, port, { quote_id: q.quote_id, amount_minor: '100' });
    port.script.status.push(success('SYN-TXN-A'));
    assert.equal((await poll(ctx, port, first.attempt_id)).state, 'success');
    // The second part: an attempt written around the code (the code never pays a quote twice).
    const secondId = randomUUID();
    await pool.query(
      `INSERT INTO kaspi_pos_attempts(id,branch_id,device_id,terminal_id,staff_id,quote_id,amount_minor)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        secondId,
        ctx.branch,
        device,
        ctx.cashier.terminal_id,
        ctx.cashier.staff_id,
        q.quote_id,
        (BigInt(q.total_minor) - 100n).toString(),
      ],
    );
    await pool.query("UPDATE kaspi_pos_attempts SET state='sending' WHERE id=$1", [secondId]);
    await pool.query("UPDATE kaspi_pos_attempts SET state='wait',process_id='two' WHERE id=$1", [
      secondId,
    ]);
    await pool.query(
      "UPDATE kaspi_pos_attempts SET state='success',transaction_id='SYN-TXN-B',finished_at=clock_timestamp() WHERE id=$1",
      [secondId],
    );
    await happen.closed(ctx);
    await assert.rejects(
      sell(ctx, q, [
        { method: 'kaspi_terminal', amount_minor: '100', attempt_id: first.attempt_id },
        {
          method: 'kaspi_terminal',
          amount_minor: (BigInt(q.total_minor) - 100n).toString(),
          attempt_id: secondId,
        },
      ]),
      code('BRANCH_UNAVAILABLE'),
    );
    assert.equal((await pool.query('SELECT 1 FROM local_orders')).rowCount, 0);
  });
});

test('schema030 guards in SQL: a closed branch takes an order only with a whole-amount paid attempt of the quote', async () => {
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const pool = ctx.edge.pool;
    const shift = (
      await pool.query("SELECT id FROM local_cash_shifts WHERE terminal_id=$1 AND state='open'", [
        ctx.cashier.terminal_id,
      ])
    ).rows[0].id;
    const attemptOf = async (q, amount = q.total_minor) => {
      const started = await pay(ctx, port, { quote_id: q.quote_id, amount_minor: amount });
      port.script.status.push(success(`SYN-TXN-${randomUUID().slice(0, 8)}`));
      assert.equal((await poll(ctx, port, started.attempt_id)).state, 'success');
      return started.attempt_id;
    };
    // Inserts the order row of a quote and rolls back: only the BEFORE INSERT guard is exercised.
    const insertOrder = (q) =>
      transaction(pool, async (client) => {
        await client.query(
          `INSERT INTO local_orders(id,branch_id,quote_id,total_minor,cash_shift_id,execution_mode,state,payment_state)
           VALUES ($1,$2,$3,$4,$5,'pos_sale','paid','captured')`,
          [randomUUID(), ctx.branch, q.quote_id, q.total_minor, shift],
        );
        throw new Error('ROLLBACK');
      });
    const inserted = (error) => error.message === 'ROLLBACK';
    const refused = (error) =>
      error.code === '23514' && /POS sale mode is not enabled/.test(error.message);
    const free = await quote(ctx);
    const paid = await quote(ctx);
    const half = await quote(ctx);
    const released = await quote(ctx);
    const paidAttemptId = await attemptOf(paid);
    await attemptOf(half, '100');
    const releasedId = await attemptOf(released);
    await happen.closed(ctx);
    await assert.rejects(insertOrder(free), refused);
    await assert.rejects(insertOrder(half), refused);
    await assert.rejects(insertOrder(paid), inserted);
    // Released by hand (direct rows: the approval flow is tested in kaspi-pos-release.test.mjs).
    const approval = randomUUID();
    await pool.query(
      `INSERT INTO local_manager_approvals(id,branch_id,terminal_id,manager_staff_id,requested_by_staff_id,
       action,subject,subject_hash,token_hash,expires_at)
       VALUES($1,$2,$3,$4,$5,'terminal_release',$6,$7,$8,clock_timestamp()+interval '120 seconds')`,
      [
        approval,
        ctx.branch,
        ctx.cashier.terminal_id,
        ctx.manager.staff_id,
        ctx.cashier.staff_id,
        { quote_id: released.quote_id, amount_minor: released.total_minor },
        'a'.repeat(64),
        'b'.repeat(64),
      ],
    );
    await pool.query(
      'UPDATE local_manager_approvals SET consumed_at=clock_timestamp(),consumed_command_key=$2 WHERE id=$1',
      [approval, randomUUID()],
    );
    await pool.query(
      `INSERT INTO kaspi_pos_attempt_releases(attempt_id,branch_id,attempt_terminal_id,terminal_id,shift_id,
       amount_minor,transaction_id,attempt_staff_id,released_by_staff_id,manager_staff_id,approval_id,reason)
       SELECT id,branch_id,terminal_id,terminal_id,$2,amount_minor,transaction_id,staff_id,$3,$4,$5,'Синтетический возврат'
       FROM kaspi_pos_attempts WHERE id=$1`,
      [releasedId, shift, ctx.cashier.staff_id, ctx.manager.staff_id, approval],
    );
    await assert.rejects(insertOrder(released), refused);
    assert.ok(paidAttemptId);
    assert.equal((await pool.query('SELECT 1 FROM local_orders')).rowCount, 0);
  });
});

test("schema030 completeness at COMMIT: a closed branch or a switched-off method accepts only the order's own terminal payment", async () => {
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const pool = ctx.edge.pool;
    const terminalSale = await quote(ctx);
    const terminalAttempt = await paidAttempt(ctx, port, terminalSale);
    const sold = await sell(ctx, terminalSale, terminalTender(terminalSale, terminalAttempt));
    const cashQuote = await quote(ctx);
    const cashed = await cashSale(ctx, cashQuote);
    const assertComplete = (order) =>
      pool.query('SELECT pos_sale_assert_complete($1,$2)', [order.order.order_id, ctx.branch]);
    await assertComplete(sold);
    await assertComplete(cashed);
    await happen.closed(ctx);
    await assertComplete(sold);
    await assert.rejects(
      assertComplete(cashed),
      (error) => error.code === '23514' && /POS sale mode is not enabled/.test(error.message),
    );
    await happen.method(ctx, null, 'kaspi_terminal');
    await assertComplete(sold);
    await happen.method(ctx, null, 'cash');
    await assert.rejects(
      assertComplete(cashed),
      (error) => error.code === '23514' && /POS payment method is disabled/.test(error.message),
    );
  });
});

test('an edge without schema030 keeps the clean refusals of a closed branch and a switched-off method', async () => {
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    const attemptId = await paidAttempt(ctx, port, q);
    await as030Absent(ctx);
    await happen.closed(ctx);
    await assert.rejects(sell(ctx, q, terminalTender(q, attemptId)), code('BRANCH_UNAVAILABLE'));
    assert.equal((await ctx.edge.pool.query('SELECT 1 FROM local_orders')).rowCount, 0);
  });
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    const attemptId = await paidAttempt(ctx, port, q);
    await as030Absent(ctx);
    await happen.method(ctx);
    await assert.rejects(sell(ctx, q, terminalTender(q, attemptId)), code('METHOD_DISABLED'));
    assert.equal((await ctx.edge.pool.query('SELECT 1 FROM local_orders')).rowCount, 0);
  });
  // The first-release bypasses (stop, new menu) work without 030 as before.
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    const attemptId = await paidAttempt(ctx, port, q);
    await as030Absent(ctx);
    await happen.stop(ctx, q);
    const result = await sell(ctx, q, terminalTender(q, attemptId));
    await assertSoldAndCooked(ctx, result, attemptId);
    assert.ok(
      (await overrides(ctx, result.order.order_id)).some((a) => /checks=item_stopped$/.test(a)),
    );
    const open = await listOpenTerminalPayments(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier));
    assert.deepEqual(open.items, []);
  });
});

test('paid on the terminal: a desk without an open sales shift and a switched-off sales mode still refuse the sale', async () => {
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    const attemptId = await paidAttempt(ctx, port, q);
    await as030Absent(ctx);
    const shiftId = (
      await ctx.edge.pool.query(
        "SELECT id FROM local_cash_shifts WHERE terminal_id=$1 AND state='open'",
        [ctx.cashier.terminal_id],
      )
    ).rows[0].id;
    await closeCashShift(ctx.edge.pool, ctx.branch, staffAuth(ctx.manager), randomUUID(), shiftId, {
      expected_version: 1,
      counted_cash_minor: '0',
      reason: 'Синтетическое закрытие',
    });
    await assert.rejects(sell(ctx, q, terminalTender(q, attemptId)), code('CASH_SHIFT_REQUIRED'));
    // Nothing was spent: the failed sale rolled back, the attempt is still free.
    assert.equal(
      (
        await ctx.edge.pool.query('SELECT order_id FROM kaspi_pos_attempts WHERE id=$1', [
          attemptId,
        ])
      ).rows[0].order_id,
      null,
    );
  });
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    const attemptId = await paidAttempt(ctx, port, q);
    await as030Absent(ctx);
    // The mode cannot be switched while a sales shift is open: close them all first.
    for (const shift of (
      await ctx.edge.pool.query("SELECT id FROM local_cash_shifts WHERE state='open'")
    ).rows)
      await closeCashShift(
        ctx.edge.pool,
        ctx.branch,
        staffAuth(ctx.manager),
        randomUUID(),
        shift.id,
        { expected_version: 1, counted_cash_minor: '0', reason: 'Синтетическое закрытие' },
      );
    await transaction(ctx.edge.pool, async (client) => {
      await setting(
        client,
        ctx.branch,
        'pos_service_mode',
        { pos_service_mode: 'pos_sale' },
        { pos_service_mode: 'payment_required' },
      );
      await client.query(
        "UPDATE branch_config SET pos_service_mode='payment_required' WHERE id=$1",
        [ctx.branch],
      );
    });
    await assert.rejects(sell(ctx, q, terminalTender(q, attemptId)), code('SERVICE_MODE_DISABLED'));
  });
});

test('one operation per terminal; fail frees it; refused and unreachable never paid', async () => {
  await desk(async (ctx) => {
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    const body = { quote_id: q.quote_id, amount_minor: q.total_minor };
    const first = await pay(ctx, port, body);
    await assert.rejects(pay(ctx, port, body), code('TERMINAL_BUSY'));
    port.script.status.push({
      kind: 'ok',
      data: { status: 'fail', subStatus: 'ProcessCancelled', message: 'Отменено' },
    });
    const failed = await poll(ctx, port, first.attempt_id);
    assert.equal(failed.state, 'fail');
    assert.equal(failed.message, 'Отменено');
    // Finished attempts are never asked again.
    const asked = port.calls.length;
    await poll(ctx, port, first.attempt_id);
    assert.equal(port.calls.length, asked);
    port.script.payment.push({
      kind: 'refused',
      httpStatus: 400,
      statusCode: 107,
      message: 'busy',
    });
    const refused = await pay(ctx, port, body);
    assert.equal(refused.state, 'send_failed');
    assert.match(refused.message, /занят/);
    port.script.payment.push({ kind: 'unreachable', reason: 'CONNECT' });
    assert.equal((await pay(ctx, port, body)).state, 'send_failed');
    // Not whole tenge, more than the quote, no terminal: refused before the terminal is asked.
    const before = port.calls.length;
    await assert.rejects(
      pay(ctx, port, { ...body, amount_minor: '100050' }),
      code('TERMINAL_AMOUNT_NOT_WHOLE'),
    );
    await assert.rejects(
      pay(ctx, port, { ...body, amount_minor: (BigInt(q.total_minor) + 100n).toString() }),
      code('TENDER_SUM_MISMATCH'),
    );
    const otherQuote = await quote(ctx, ctx.other);
    await assert.rejects(
      pay(
        ctx,
        port,
        { quote_id: otherQuote.quote_id, amount_minor: otherQuote.total_minor },
        { actor: ctx.other },
      ),
      code('TERMINAL_NOT_LINKED'),
    );
    assert.equal(port.calls.length, before);
  });
});

test('a lost payment answer is never repeated; unknown is actualized at most every 10 s', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    const body = { quote_id: q.quote_id, amount_minor: q.total_minor };
    port.script.payment.push({ kind: 'lost', reason: 'TIMEOUT' });
    const lost = await pay(ctx, port, body);
    assert.equal(lost.state, 'lost');
    assert.equal(port.calls.filter((c) => c.method === 'payment').length, 1);
    await assert.rejects(
      sell(ctx, q, [
        { method: 'kaspi_terminal', amount_minor: q.total_minor, attempt_id: lost.attempt_id },
      ]),
      code('TERMINAL_ATTEMPT_INVALID'),
    );
    assert.deepEqual(
      (await listOpenTerminalPayments(pool, ctx.branch, staffAuth(ctx.cashier))).items.map(
        (i) => i.state,
      ),
      ['lost'],
    );
    // The terminal is free for a new attempt after a lost one.
    const next = await pay(ctx, port, body);
    assert.equal(next.state, 'wait');
    port.script.status.push({
      kind: 'ok',
      data: { status: 'unknown', message: 'Нет ответа банка' },
    });
    assert.equal((await poll(ctx, port, next.attempt_id)).state, 'unknown');
    const statusCalls = port.calls.length;
    port.script.actualize.push({ kind: 'ok', data: { status: 'unknown' } });
    await poll(ctx, port, next.attempt_id); // first actualize (never actualized before)
    assert.equal(port.calls.at(-1).method, 'actualize');
    await poll(ctx, port, next.attempt_id); // within 10 s: not asked
    assert.equal(port.calls.length, statusCalls + 1);
    await pool.query(
      "UPDATE kaspi_pos_attempts SET actualized_at=clock_timestamp()-interval '11 seconds' WHERE id=$1",
      [next.attempt_id],
    );
    port.script.actualize.push(success('SYN-TXN-7'));
    assert.equal((await poll(ctx, port, next.attempt_id)).state, 'success');
    assert.equal(port.calls.filter((c) => c.method === 'payment').length, 2);
  });
});

test('stale attempts of a stopped edge: created was never sent, sending becomes lost', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const port = simulator();
    const device = await link(ctx);
    const q = await quote(ctx);
    const id = randomUUID();
    await pool.query(
      `INSERT INTO kaspi_pos_attempts(id,branch_id,device_id,terminal_id,staff_id,quote_id,amount_minor)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        ctx.branch,
        device,
        ctx.cashier.terminal_id,
        ctx.cashier.staff_id,
        q.quote_id,
        q.total_minor,
      ],
    );
    await pool.query("UPDATE kaspi_pos_attempts SET state='sending' WHERE id=$1", [id]);
    await pool.query('ALTER TABLE kaspi_pos_attempts DISABLE TRIGGER kaspi_pos_attempt_guard');
    await pool.query(
      "UPDATE kaspi_pos_attempts SET updated_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",
      [id],
    );
    await pool.query('ALTER TABLE kaspi_pos_attempts ENABLE TRIGGER kaspi_pos_attempt_guard');
    assert.equal((await poll(ctx, port, id)).state, 'lost');
    assert.equal(port.calls.length, 0);
  });
});

test('the point server finishes a payment by itself while the POS window is closed (P0-4)', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    const started = await pay(ctx, port, { quote_id: q.quote_id, amount_minor: q.total_minor });
    assert.equal(started.state, 'wait');
    // The POS closes here: nobody polls. The background pass asks the terminal itself.
    assert.equal(await pollTerminalPayments(pool, ctx.branch, port), 1);
    assert.equal(port.calls.at(-1).method, 'status');
    port.script.status.push(success('SYN-TXN-BG', 'qr'));
    assert.equal(await pollTerminalPayments(pool, ctx.branch, port), 1);
    const row = (
      await pool.query('SELECT state,transaction_id FROM kaspi_pos_attempts WHERE id=$1', [
        started.attempt_id,
      ])
    ).rows[0];
    assert.deepEqual(row, { state: 'success', transaction_id: 'SYN-TXN-BG' });
    // A finished attempt is not asked again and never paid twice.
    const calls = port.calls.length;
    assert.equal(await pollTerminalPayments(pool, ctx.branch, port), 0);
    assert.equal(port.calls.length, calls);
    assert.equal(port.calls.filter((c) => c.method === 'payment').length, 1);
    // After the restart the desk sees the paid attempt and finishes the sale with it.
    const open = await listOpenTerminalPayments(pool, ctx.branch, staffAuth(ctx.cashier));
    assert.deepEqual(
      open.items.map((i) => [i.attempt_id, i.state]),
      [[started.attempt_id, 'success']],
    );
    const sold = await sell(ctx, q, [
      { method: 'kaspi_terminal', amount_minor: q.total_minor, attempt_id: started.attempt_id },
    ]);
    assert.equal(sold.order.state, 'paid');
    // An unreachable terminal leaves the attempt as it was for the next pass.
    const q2 = await quote(ctx);
    const second = await pay(ctx, port, { quote_id: q2.quote_id, amount_minor: q2.total_minor });
    port.script.status.push({ kind: 'unreachable', reason: 'CONNECT' });
    assert.equal(await pollTerminalPayments(pool, ctx.branch, port), 1);
    assert.equal(
      (await pool.query('SELECT state FROM kaspi_pos_attempts WHERE id=$1', [second.attempt_id]))
        .rows[0].state,
      'wait',
    );
  });
});

test('schema029 guards: forward transitions only, a tender needs its paid attempt', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const port = simulator();
    await link(ctx);
    const q = await quote(ctx);
    const attempt = await pay(ctx, port, { quote_id: q.quote_id, amount_minor: q.total_minor });
    await assert.rejects(
      pool.query("UPDATE kaspi_pos_attempts SET state='created' WHERE id=$1", [attempt.attempt_id]),
      code('23514'),
    );
    await assert.rejects(
      pool.query('UPDATE kaspi_pos_attempts SET amount_minor=amount_minor+100 WHERE id=$1', [
        attempt.attempt_id,
      ]),
      code('23514'),
    );
    await assert.rejects(
      pool.query('DELETE FROM kaspi_pos_attempts WHERE id=$1', [attempt.attempt_id]),
      code('23514'),
    );
    await assert.rejects(
      pool.query('UPDATE kaspi_pos_attempts SET order_id=$2 WHERE id=$1', [
        attempt.attempt_id,
        randomUUID(),
      ]),
      code('23514'),
    );
    await assert.rejects(
      pool.query('UPDATE kaspi_pos_devices SET terminal_id=$1', [ctx.other.terminal_id]),
      code('23514'),
    );
    port.script.status.push(success());
    await poll(ctx, port, attempt.attempt_id);
    await assert.rejects(
      pool.query("UPDATE kaspi_pos_attempts SET transaction_id='OTHER' WHERE id=$1", [
        attempt.attempt_id,
      ]),
      code('23514'),
    );
    // A cash sale cannot carry a terminal attempt (method), checked by the database too.
    const sold = await sell(ctx, q, [
      { method: 'kaspi_terminal', amount_minor: q.total_minor, attempt_id: attempt.attempt_id },
    ]);
    const q2 = await quote(ctx);
    const cash = await sell(
      ctx,
      q2,
      [{ method: 'cash', amount_minor: q2.total_minor }],
      ctx.cashier,
      {
        cash_tendered_minor: q2.total_minor,
      },
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO pos_sale_tenders(id,order_id,branch_id,method,amount_minor,confirmation,attempt_id)
         VALUES($1,$2,$3,'kaspi_terminal',$4,'cashier_attested',$5)`,
        [randomUUID(), cash.order.order_id, ctx.branch, q2.total_minor, attempt.attempt_id],
      ),
      (error) => error.code === '23514' || error.code === '23505',
    );
    assert.ok(sold.order.order_id);
  });
});

test('runtime role: exact schema029 privileges and the attempt flow without owner rights', async () => {
  await desk(async (ctx) => {
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
      await assertKaspiPosRuntimePrivileges(ctx.edge.pool, role, ctx.edge.schema);
      // Edge 030 adds a table the runtime must read (the guards of an attempt read it) and insert
      // into (the release). Its exact grants belong to the operator tools (infra/windows, next
      // stage); until then this test grants what they will.
      await ctx.edge.pool.query(
        `GRANT SELECT, INSERT ON ${ctx.edge.schema}.kaspi_pos_attempt_releases TO ${role}`,
      );
      const url = new URL(ctx.edge.config.databaseUrl);
      url.username = role;
      url.password = password;
      pool = createPool(url.toString(), 2);
      await link(ctx, ctx.cashier.terminal_id, new Date(Date.now() + 60 * 60 * 1000).toISOString());
      const port = simulator();
      const q = await quote(ctx);
      const runtime = { ...ctx, edge: { ...ctx.edge, pool } };
      const started = await pay(runtime, port, {
        quote_id: q.quote_id,
        amount_minor: q.total_minor,
      });
      // The token expired within 3 h, so the runtime renewed it before paying.
      assert.deepEqual(
        port.calls.map((c) => c.method),
        ['revoke', 'payment'],
      );
      assert.equal(port.calls[1].token, 'access-token-2');
      port.script.status.push(success());
      assert.equal((await poll(runtime, port, started.attempt_id)).state, 'success');
      const sold = await sell(runtime, q, [
        { method: 'kaspi_terminal', amount_minor: q.total_minor, attempt_id: started.attempt_id },
      ]);
      assert.equal(sold.order.state, 'paid');
      await assert.rejects(pool.query('UPDATE kaspi_pos_devices SET active=false'), code('42501'));
      await assert.rejects(pool.query('DELETE FROM kaspi_pos_attempts'), code('42501'));
    } finally {
      await pool?.end();
      await ctx.edge.admin.query(`DROP OWNED BY ${role}`);
      await ctx.edge.admin.query(`DROP ROLE ${role}`);
    }
  });
});

test('owner tool arguments: a pinned certificate or an explicit plain HTTP transport, never both', () => {
  const desk = '11111111-1111-4111-8111-111111111111';
  const base = ['register', '--terminal', desk, '--host', '192.168.2.236'];
  assert.equal(
    parseKaspiTerminalSetupArgs([...base, '--transport', 'http'])['certificate-sha256'],
    '0'.repeat(64),
  );
  const invalid = (argv) =>
    assert.throws(
      () => parseKaspiTerminalSetupArgs(argv),
      (e) => e instanceof KaspiTerminalSetupError && e.code === 'INVALID_ARGUMENTS',
    );
  invalid(base);
  invalid([...base, '--transport', 'https']);
  invalid([...base, '--transport', 'http', '--certificate-sha256', 'a'.repeat(64)]);
  invalid([...base, '--certificate-sha256', '0'.repeat(64)]);
});

test('owner tool: register stores the link and its token, unlink refuses an open attempt', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const port = simulator();
    const args = {
      command: 'register',
      terminal: ctx.cashier.terminal_id,
      host: '192.168.2.50',
      'certificate-sha256': CERT,
      name: 'PickChick-1',
    };
    const linked = await linkKaspiTerminal(pool, ctx.branch, args, port);
    assert.equal(linked.serial_number, 'SYN-SERIAL');
    assert.equal(JSON.stringify(linked).includes('token-1'), false);
    const row = (await pool.query('SELECT access_token,kaspi_terminal_id FROM kaspi_pos_devices'))
      .rows[0];
    assert.equal(row.access_token, 'access-token-1');
    assert.equal(row.kaspi_terminal_id, 'SYN-TID');
    await assert.rejects(
      linkKaspiTerminal(pool, ctx.branch, args, port),
      (e) => e instanceof KaspiTerminalSetupError && e.code === 'ALREADY_LINKED',
    );
    const q = await quote(ctx);
    await pay(ctx, port, { quote_id: q.quote_id, amount_minor: q.total_minor });
    await assert.rejects(
      unlinkKaspiTerminal(pool, ctx.branch, { terminal: ctx.cashier.terminal_id }),
      (e) => e.code === 'OPEN_ATTEMPTS',
    );
    await pool.query(
      "UPDATE kaspi_pos_attempts SET state='fail',finished_at=clock_timestamp() WHERE state='wait'",
    );
    assert.deepEqual(
      await unlinkKaspiTerminal(pool, ctx.branch, { terminal: ctx.cashier.terminal_id }),
      {
        unlinked: true,
        terminal_id: ctx.cashier.terminal_id,
      },
    );
    assert.equal(
      (await readPosConfig(pool, ctx.branch, staffAuth(ctx.cashier))).kaspi_terminal_link,
      false,
    );
  });
});

test('operator upgrade 028 -> 029: inspect changes nothing, apply adds 029 once and keeps every row', async () => {
  const { mkdtemp, readdir, copyFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { kaspiPosMigration } = await import('../../infra/windows/kaspi-pos-upgrade-db.mjs');
  const source = fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url));
  const appRoot = fileURLToPath(new URL('../../', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-edge-028-'));
  try {
    for (const name of (await readdir(source)).filter((n) => n.endsWith('.sql') && n < '029'))
      await copyFile(join(source, name), join(dir, name));
    await withSyncDatabases(
      async (ctx) => {
        const client = await ctx.edge.pool.connect();
        try {
          const options = {
            appRoot,
            branchId: ctx.branch,
            schema: ctx.edge.schema,
            runtimeRole: 'no_such_runtime_role',
          };
          const inspected = await kaspiPosMigration(client, { ...options, mode: 'inspect' });
          assert.equal(inspected.migrations, 28);
          assert.equal(
            (await client.query("SELECT to_regclass('kaspi_pos_devices') AS r")).rows[0].r,
            null,
          );
          const applied = await kaspiPosMigration(client, { ...options, mode: 'apply' });
          assert.equal(applied.applied, true);
          assert.equal(applied.linkedTerminals, 0);
          assert.equal(
            (await client.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,
            29,
          );
          await assert.rejects(
            kaspiPosMigration(client, { ...options, mode: 'apply' }),
            /already applied/,
          );
          assert.equal(
            (await kaspiPosMigration(client, { ...options, mode: 'inspect' })).alreadyInstalled,
            true,
          );
          await assert.rejects(
            kaspiPosMigration(client, { ...options, branchId: randomUUID(), mode: 'inspect' }),
            /Branch differs/,
          );
        } finally {
          client.release();
        }
      },
      { edgeMigrationDirectory: dir },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
