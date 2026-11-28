import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { transaction } from '@pickchick/database';
import { applyMenu, hashToken, publishMenu } from '@pickchick/menu-sync';
import {
  KASPI_TERMINAL_UNCONFIRMED_PAYMENT_TYPE,
  WebkassaClient,
  WebkassaFiscalWorker,
  approvalSubjectHash,
  createPosSale,
  createQuote,
  createTerminalPayment,
  provisionStaff,
  readTerminalPayment,
  refundPosSale,
  setOrdering,
} from '@pickchick/local-orders';
import { localUnpaidExecution, provisionFulfillment } from '@pickchick/edge-fulfillment';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { staffAuth } from '../helpers/orders.mjs';

// Owner 28.11.2026: a Kaspi terminal part of a receipt carries the method the guest really paid
// with on the terminal (card -> bank card 1, qr -> mobile payment 4); alaqan and a terminal that
// did not say have no decision yet and keep the documented value. Real schema 026/029, a scripted
// terminal (docs/integrations/kaspi-smart-pos-api.md) and a scripted Webkassa. Synthetic data only.

const ACCOUNT = {
  baseUrl: 'https://devkkm.webkassa.kz',
  apiKey: 'WKD-SYNTHETIC',
  login: 'synthetic@example.com',
  password: 'synthetic',
  cashboxUniqueNumber: 'SWK00000001',
};
const CERT = 'a'.repeat(64);

/** Webkassa: checks are kept by ExternalCheckNumber; PrintFormat gives ФП, time and РНМ (refunds). */
function webkassa() {
  const calls = [];
  const checks = new Map();
  let number = 1000;
  return {
    calls,
    checks,
    async post(baseUrl, path, apiKey, body) {
      calls.push({ path, body });
      assert.equal(apiKey, ACCOUNT.apiKey);
      if (path === 'api/v4/Authorize') return { kind: 'ok', data: { Token: 'token-1' }, top: {} };
      if (path === 'api/v4/check') {
        const data = {
          CheckNumber: String((number += 1)),
          DateTime: '25.11.2026 14:34:29',
          OfflineMode: false,
          ShiftNumber: 1,
          TicketUrl: 'https://ctest2.wofd.kz/consumer?i=1',
          Cashbox: { RegistrationNumber: '000000000001' },
          ExternalCheckNumber: body.ExternalCheckNumber,
        };
        checks.set(body.ExternalCheckNumber, data);
        return { kind: 'ok', data, top: { Data: data } };
      }
      const issued = path === 'api/v4/Ticket/PrintFormat' && checks.get(body.ExternalCheckNumber);
      if (issued)
        return {
          kind: 'ok',
          data: {
            Lines: [
              { Order: 1, Type: 0, Value: `ФБ/ФП: ${issued.CheckNumber}`, Style: 0 },
              { Order: 2, Type: 0, Value: 'Уақыты/Время: 25.11.2026 14:34:29', Style: 0 },
              { Order: 3, Type: 0, Value: 'сформирован в автономном режиме', Style: 0 },
              { Order: 4, Type: 0, Value: 'МКК БКМ коды (КТН)/Код ККМ КГД (РНМ):', Style: 0 },
              { Order: 5, Type: 0, Value: '000000000001', Style: 0 },
              {
                Order: 6,
                Type: 2,
                Value: `http://ctest2.wofd.kz/consumer?i=${issued.CheckNumber}&f=000000000001`,
                Style: 0,
              },
            ],
          },
          top: {},
        };
      if (path === 'api/v4/ZReport') return { kind: 'ok', data: { ShiftNumber: 1 }, top: {} };
      return { kind: 'unreachable', reason: 'CONNECT' };
    },
  };
}

/** The Kaspi terminal: pays at once; `reported` is the method it names in its cheque. */
function terminal(reported) {
  let process = 0;
  return {
    async call(link, method) {
      if (method === 'payment')
        return { kind: 'ok', data: { processId: `p${++process}`, status: 'wait' } };
      if (method === 'status')
        return {
          kind: 'ok',
          data: {
            status: 'success',
            subStatus: 'Success',
            transactionId: 'SYN-TXN-' + randomUUID().slice(0, 8),
            chequeInfo:
              reported === null
                ? { amount: '2 990 ₸', orderNumber: 'SYN-ORDER', storeName: 'Synthetic' }
                : { method: reported, amount: '2 990 ₸', orderNumber: 'SYN-ORDER' },
          },
        };
      return { kind: 'unreachable', reason: 'CONNECT' };
    },
  };
}

async function prepare(ctx) {
  const edge = ctx.edge.pool;
  const release = ctx.menu();
  await applyMenu(edge, ctx.branch, await publishMenu(ctx.cloud.pool, release));
  const person = (role, terminalId = randomUUID()) => ({
    staff_id: randomUUID(),
    terminal_id: terminalId,
    name: 'Синтетический сотрудник',
    role,
  });
  const cashier = await provisionStaff(edge, ctx.branch, person('cashier'));
  const manager = await provisionStaff(
    edge,
    ctx.branch,
    person('shift_manager', cashier.terminal_id),
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
  const setting = (client, subject, before, after) =>
    client.query(
      `INSERT INTO pos_sales_setting_changes(change_id,branch_id,subject,before,after,actor,reason)
       VALUES($1,$2,$3,$4,$5,'operator','Синтетика Webkassa Kaspi')`,
      [randomUUID(), ctx.branch, subject, before, after],
    );
  await transaction(edge, async (client) => {
    await setting(
      client,
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
  await edge.query(
    'INSERT INTO local_cash_shifts(id,branch_id,staff_id,terminal_id,opening_cash_minor,sales_mode) VALUES($1,$2,$3,$4,0,true)',
    [randomUUID(), ctx.branch, manager.staff_id, cashier.terminal_id],
  );
  return {
    ...ctx,
    release,
    cashier,
    manager,
    execution: localUnpaidExecution({ enabled: true, deviceId: ctx.device }),
  };
}
const desk = (run) => withSyncDatabases(async (ctx) => run(await prepare(ctx)));
const linkTerminal = (ctx) =>
  ctx.edge.pool.query(
    `INSERT INTO kaspi_pos_devices(id,branch_id,terminal_id,host,certificate_sha256,integration_name,
     access_token,refresh_token,token_expires_at) VALUES($1,$2,$3,'192.168.2.50',$4,'PickChick-1',
     'access-token-0','refresh-token-0','2099-01-01T00:00:00Z')`,
    [randomUUID(), ctx.branch, ctx.cashier.terminal_id, CERT],
  );
const quote = (ctx, quantity = 1) =>
  createQuote(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), {
    release_id: ctx.release.release_id,
    service_mode: 'takeaway',
    items: [{ variant_id: ctx.release.items[0].variant_id, quantity }],
  });
const sell = (ctx, q, tenders, extra = {}) =>
  createPosSale(
    ctx.edge.pool,
    ctx.branch,
    staffAuth(ctx.cashier),
    randomUUID(),
    { quote_id: q.quote_id, service_mode_confirmed: true, order_repeated: true, tenders, ...extra },
    ctx.execution,
  );
/** The terminal takes `amount_minor` (whole tenge) and reports `reported`; returns the paid attempt. */
async function pay(ctx, q, reported, amountMinor = q.total_minor) {
  const port = terminal(reported);
  const started = await createTerminalPayment(
    ctx.edge.pool,
    ctx.branch,
    staffAuth(ctx.cashier),
    randomUUID(),
    { quote_id: q.quote_id, amount_minor: amountMinor },
    port,
  );
  const paid = await readTerminalPayment(
    ctx.edge.pool,
    ctx.branch,
    staffAuth(ctx.cashier),
    started.attempt_id,
    port,
  );
  assert.equal(paid.state, 'success');
  assert.equal(paid.payment_method, reported, 'the attempt keeps the reported method');
  return paid;
}
const orderIdOf = (made) => made.order_id ?? made.sale?.order_id ?? made.order?.id;
const worker = (ctx, sim) =>
  new WebkassaFiscalWorker(
    ctx.edge.pool,
    ctx.branch,
    new WebkassaClient(ACCOUNT, { transport: sim }),
    () => {},
  );
const sums = (check) =>
  check.Payments.map((p) => [p.PaymentType, p.Sum]).sort((a, b) => a[0] - b[0]);
const lastCheck = (sim) => sim.calls.filter((c) => c.path === 'api/v4/check').at(-1).body;

test('the documented fallback type for alaqan and an unreported method is the old value 1', () => {
  assert.equal(KASPI_TERMINAL_UNCONFIRMED_PAYMENT_TYPE, 1);
});

for (const [reported, expected] of [
  ['card', 1],
  ['qr', 4],
  ['alaqan', KASPI_TERMINAL_UNCONFIRMED_PAYMENT_TYPE],
  [null, KASPI_TERMINAL_UNCONFIRMED_PAYMENT_TYPE],
])
  test(`a sale paid on the terminal as ${reported} is punched with PaymentType ${expected}`, async () => {
    await desk(async (ctx) => {
      await linkTerminal(ctx);
      const sim = webkassa();
      const q = await quote(ctx);
      const attempt = await pay(ctx, q, reported);
      await sell(ctx, q, [
        { method: 'kaspi_terminal', amount_minor: q.total_minor, attempt_id: attempt.attempt_id },
      ]);
      assert.equal(await worker(ctx, sim).tick(), 1);
      assert.deepEqual(lastCheck(sim).Payments, [
        { Sum: Number(q.total_minor) / 100, PaymentType: expected },
      ]);
    });
  });

test('a terminal part next to cash: each part has its own type', async () => {
  await desk(async (ctx) => {
    await linkTerminal(ctx);
    const sim = webkassa();
    const q = await quote(ctx, 2);
    const cash = 100n;
    const onTerminal = (BigInt(q.total_minor) - cash).toString();
    const attempt = await pay(ctx, q, 'qr', onTerminal);
    await sell(
      ctx,
      q,
      [
        { method: 'cash', amount_minor: cash.toString() },
        { method: 'kaspi_terminal', amount_minor: onTerminal, attempt_id: attempt.attempt_id },
      ],
      { cash_tendered_minor: cash.toString() },
    );
    assert.equal(await worker(ctx, sim).tick(), 1);
    assert.deepEqual(sums(lastCheck(sim)), [
      [0, 1],
      [4, Number(onTerminal) / 100],
    ]);
  });
});

test('a terminal tender marked by hand, without an attempt, keeps the documented value', async () => {
  await desk(async (ctx) => {
    // No terminal is linked to this desk: the cashier confirms the payment manually and the
    // method is unknown, so the same documented value as for alaqan.
    const sim = webkassa();
    const q = await quote(ctx);
    await sell(ctx, q, [
      { method: 'kaspi_terminal', amount_minor: q.total_minor, reference: 'SYN-MANUAL-1' },
    ]);
    const tender = (
      await ctx.edge.pool.query(
        "SELECT attempt_id FROM pos_sale_tenders WHERE method='kaspi_terminal'",
      )
    ).rows[0];
    assert.equal(tender.attempt_id, null);
    assert.equal(await worker(ctx, sim).tick(), 1);
    assert.deepEqual(lastCheck(sim).Payments, [
      {
        Sum: Number(q.total_minor) / 100,
        PaymentType: KASPI_TERMINAL_UNCONFIRMED_PAYMENT_TYPE,
      },
    ]);
  });
});

async function approve(ctx, subject) {
  const approval = { approval_id: randomUUID(), token: randomBytes(32).toString('hex') };
  await ctx.edge.pool.query(
    `INSERT INTO local_manager_approvals(id,branch_id,terminal_id,manager_staff_id,requested_by_staff_id,
     action,subject,subject_hash,token_hash,expires_at)
     VALUES($1,$2,$3,$4,$5,'refund',$6,$7,$8,clock_timestamp()+interval '120 seconds')`,
    [
      approval.approval_id,
      ctx.branch,
      ctx.cashier.terminal_id,
      ctx.manager.staff_id,
      ctx.cashier.staff_id,
      subject,
      approvalSubjectHash('refund', subject),
      hashToken(approval.token),
    ],
  );
  return approval;
}

for (const [reported, expected] of [
  ['qr', 4],
  ['card', 1],
  ['alaqan', KASPI_TERMINAL_UNCONFIRMED_PAYMENT_TYPE],
])
  test(`the refund receipt of a terminal sale paid as ${reported} has the same type ${expected}`, async () => {
    await desk(async (ctx) => {
      await linkTerminal(ctx);
      const sim = webkassa();
      const q = await quote(ctx);
      const attempt = await pay(ctx, q, reported);
      const made = await sell(ctx, q, [
        { method: 'kaspi_terminal', amount_minor: q.total_minor, attempt_id: attempt.attempt_id },
      ]);
      const orderId = orderIdOf(made);
      const w = worker(ctx, sim);
      assert.equal(await w.tick(), 1);
      const tender = (
        await ctx.edge.pool.query('SELECT id FROM pos_sale_tenders WHERE order_id=$1', [orderId])
      ).rows[0].id;
      const approval = await approve(ctx, { order_id: orderId, amount_minor: q.total_minor });
      await refundPosSale(
        ctx.edge.pool,
        ctx.branch,
        staffAuth(ctx.cashier),
        randomUUID(),
        orderId,
        {
          refund_id: randomUUID(),
          tenders: [{ tender_id: tender, amount_minor: q.total_minor }],
          reason_code: 'quality',
          reason: 'Синтетический возврат',
          approval: { approval_id: approval.approval_id, token: approval.token },
        },
      );
      assert.equal(await w.tick(), 1);
      const back = lastCheck(sim);
      assert.equal(back.OperationType, 3, 'a refund');
      assert.deepEqual(back.Payments, [
        { Sum: Number(q.total_minor) / 100, PaymentType: expected },
      ]);
    });
  });

test('a point without schema029 still issues cash and hand-marked terminal receipts', async () => {
  await desk(async (ctx) => {
    // Sales are made on the full schema, then the attempts table disappears for the worker the way
    // it is absent on a point whose 029 is not applied yet (the database of this test is its own).
    const sim = webkassa();
    const cashQuote = await quote(ctx);
    await sell(ctx, cashQuote, [{ method: 'cash', amount_minor: cashQuote.total_minor }], {
      cash_tendered_minor: cashQuote.total_minor,
    });
    const manualQuote = await quote(ctx);
    await sell(ctx, manualQuote, [
      { method: 'kaspi_terminal', amount_minor: manualQuote.total_minor, reference: 'SYN-OLD-1' },
    ]);
    await ctx.edge.pool.query('ALTER TABLE kaspi_pos_attempts RENAME TO kaspi_pos_attempts_absent');
    assert.equal(await worker(ctx, sim).tick(), 2, 'no receipt of the point stops');
    const checks = sim.calls.filter((c) => c.path === 'api/v4/check').map((c) => c.body);
    assert.deepEqual(checks.map((b) => b.Payments.map((p) => p.PaymentType)).sort(), [
      [0],
      [KASPI_TERMINAL_UNCONFIRMED_PAYMENT_TYPE],
    ]);
  });
});
