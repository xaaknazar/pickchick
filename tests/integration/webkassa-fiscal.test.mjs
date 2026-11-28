import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transaction } from '@pickchick/database';
import { applyMenu, hashToken, publishMenu } from '@pickchick/menu-sync';
import {
  WebkassaClient,
  WebkassaFiscalWorker,
  approvalSubjectHash,
  refundPosSale,
  closeCashShift,
  createPosSale,
  createQuote,
  listPendingFiscalReceipts,
  provisionStaff,
  recordFiscalReceipt,
  setOrdering,
  webkassaReceiptStatus,
  kioskReceipts,
  kioskReceiptPrint,
} from '@pickchick/local-orders';
import { localUnpaidExecution, provisionFulfillment } from '@pickchick/edge-fulfillment';
import { WebkassaLoop } from '../../services/edge/dist/webkassa-loop.js';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { staffAuth } from '../helpers/orders.mjs';

// Automatic Webkassa sale receipts (webkassa-fiscal.ts) on the real schema with a scripted
// Webkassa simulator that answers like devkkm.webkassa.kz did on 25.11.2026. Synthetic data only.

const ACCOUNT = {
  baseUrl: 'https://devkkm.webkassa.kz',
  apiKey: 'WKD-SYNTHETIC',
  login: 'synthetic@example.com',
  password: 'synthetic',
  cashboxUniqueNumber: 'SWK00000001',
};

/** Webkassa simulator: one request at a time is asserted; checks are kept by ExternalCheckNumber. */
function webkassa() {
  const calls = [];
  const checks = new Map();
  const script = [];
  let busy = false;
  let number = 1000;
  const sim = {
    calls,
    checks,
    script,
    /** true: PrintFormat answers with ФП, time and РНМ like the real form (refunds need them). */
    fullForm: false,
    async post(baseUrl, path, apiKey, body) {
      assert.equal(busy, false, 'Webkassa requests for one register must not overlap');
      busy = true;
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        calls.push({ path, body });
        assert.equal(apiKey, ACCOUNT.apiKey);
        const next = script.shift();
        if (next) return typeof next === 'function' ? next(path, body) : next;
        if (path === 'api/v4/Authorize') return { kind: 'ok', data: { Token: 'token-1' }, top: {} };
        if (path === 'api/v4/check') {
          const existing = checks.get(body.ExternalCheckNumber);
          if (existing)
            return {
              kind: 'refused',
              httpStatus: 200,
              errors: [{ code: 14, text: 'уже присутствует' }],
              top: { CheckNumber: existing.CheckNumber },
            };
          const data = {
            CheckNumber: String((number += 1)),
            DateTime: '25.11.2026 14:34:29',
            OfflineMode: false,
            ShiftNumber: 1,
            TicketUrl: 'https://ctest2.wofd.kz/consumer?i=1',
            Cashbox: { RegistrationNumber: '000000000001' },
            ExternalCheckNumber: body.ExternalCheckNumber,
          };
          checks.set(body.ExternalCheckNumber, { ...data, body });
          return { kind: 'ok', data, top: { Data: data } };
        }
        const issued =
          sim.fullForm &&
          path === 'api/v4/Ticket/PrintFormat' &&
          checks.get(body.ExternalCheckNumber);
        if (issued)
          // As on the 26.11 devkkm receipt: ФП, time, offline note, РНМ under its label, QR.
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
        if (path === 'api/v4/Ticket/PrintFormat')
          return {
            kind: 'ok',
            data: {
              Lines: [
                { Order: 2, Type: 2, Value: 'http://ctest2.wofd.kz/consumer?i=1', Style: 0 },
                { Order: 1, Type: 0, Value: 'ФИСКАЛЬНЫЙ ЧЕК', Style: 1 },
              ],
            },
            top: {},
          };
        if (path === 'api/v4/ZReport') return { kind: 'ok', data: { ShiftNumber: 1 }, top: {} };
        return { kind: 'unreachable', reason: 'CONNECT' };
      } finally {
        busy = false;
      }
    },
  };
  return sim;
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
  const setting = (client, subject, before, after) =>
    client.query(
      `INSERT INTO pos_sales_setting_changes(change_id,branch_id,subject,before,after,actor,reason)
       VALUES($1,$2,$3,$4,$5,'operator','Синтетика Webkassa')`,
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
  for (const method of ['cash', 'kaspi_terminal', 'kaspi_manual']) {
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
  const shifts = {};
  for (const desk of [cashier, other]) {
    const id = randomUUID();
    shifts[desk.terminal_id] = id;
    await edge.query(
      'INSERT INTO local_cash_shifts(id,branch_id,staff_id,terminal_id,opening_cash_minor,sales_mode) VALUES($1,$2,$3,$4,0,true)',
      [id, ctx.branch, manager.staff_id, desk.terminal_id],
    );
  }
  return {
    ...ctx,
    release,
    cashier,
    manager,
    other,
    shifts,
    execution: localUnpaidExecution({ enabled: true, deviceId: ctx.device }),
  };
}
const desk = (run) => withSyncDatabases(async (ctx) => run(await prepare(ctx)));
const sale = async (ctx, tenders, quantity = 2, actor = ctx.cashier) => {
  const q = await createQuote(ctx.edge.pool, ctx.branch, staffAuth(actor), {
    release_id: ctx.release.release_id,
    service_mode: 'takeaway',
    items: [{ variant_id: ctx.release.items[0].variant_id, quantity }],
  });
  const parts = tenders(q.total_minor);
  const cash = parts.find((t) => t.method === 'cash');
  const made = await createPosSale(
    ctx.edge.pool,
    ctx.branch,
    staffAuth(actor),
    randomUUID(),
    {
      quote_id: q.quote_id,
      service_mode_confirmed: true,
      order_repeated: true,
      tenders: parts,
      ...(cash ? { cash_tendered_minor: cash.amount_minor } : {}),
    },
    ctx.execution,
  );
  return { q, made };
};
const receiptOf = async (ctx, orderId) =>
  (
    await ctx.edge.pool.query(
      "SELECT id,state,receipt_number,recorded_by_staff_id FROM pos_fiscal_receipts WHERE order_id=$1 AND kind='sale'",
      [orderId],
    )
  ).rows[0];

test('a cash sale gets its Webkassa receipt: lines, payment, recorded number and fiscal event', async () => {
  await desk(async (ctx) => {
    const sim = webkassa();
    const events = [];
    const worker = new WebkassaFiscalWorker(
      ctx.edge.pool,
      ctx.branch,
      new WebkassaClient(ACCOUNT, { transport: sim }),
      (event) => events.push(event),
    );
    const { q, made } = await sale(ctx, (total) => [{ method: 'cash', amount_minor: total }]);
    const orderId = made.order_id ?? made.sale?.order_id ?? made.order?.id;
    assert.ok(orderId, 'sale result names its order');
    const before = await receiptOf(ctx, orderId);
    assert.equal(before.state, 'pending');
    assert.equal(await worker.tick(), 1);
    assert.deepEqual(
      sim.calls.map((c) => c.path),
      ['api/v4/Authorize', 'api/v4/check'],
    );
    const body = sim.calls[1].body;
    assert.equal(body.Token, 'token-1');
    assert.equal(body.CashboxUniqueNumber, ACCOUNT.cashboxUniqueNumber);
    assert.equal(body.OperationType, 2);
    assert.equal(body.ExternalCheckNumber, before.id);
    assert.equal(body.Positions.length, 1);
    assert.equal(body.Positions[0].Count, 2);
    assert.equal(body.Positions[0].TaxType, 0);
    assert.equal(body.Positions[0].UnitCode, 796);
    const positions = body.Positions.reduce((s, p) => s + p.Price * p.Count - p.Discount, 0);
    assert.equal(Math.round(positions * 100), Number(q.total_minor));
    assert.deepEqual(body.Payments, [{ Sum: Number(q.total_minor) / 100, PaymentType: 0 }]);
    const after = await receiptOf(ctx, orderId);
    assert.equal(after.state, 'recorded');
    assert.equal(after.receipt_number, sim.checks.get(before.id).CheckNumber);
    assert.equal(after.recorded_by_staff_id, ctx.cashier.staff_id);
    // The posSales stream carries the recorded receipt like a typed number.
    const fiscal = (
      await ctx.edge.pool.query(
        "SELECT payload FROM pos_sale_outbox WHERE branch_id=$1 AND kind='fiscal' AND entity_id=$2 ORDER BY 1",
        [ctx.branch, before.id],
      )
    ).rows.map((r) => r.payload);
    assert.ok(
      fiscal.some((p) => p.state === 'recorded' && p.receipt_number === after.receipt_number),
    );
    // Nothing is left for the cashier to punch by hand.
    const pending = await listPendingFiscalReceipts(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.cashier),
    );
    assert.equal(pending.receipts.length, 0);
    assert.ok(events.some((e) => e.event === 'webkassa_receipt_issued'));
    // A second tick finds nothing to send.
    assert.equal(await worker.tick(), 0);
    assert.equal(sim.calls.filter((c) => c.path === 'api/v4/check').length, 1);
  });
});

test('a lost answer is repeated with the same number and Webkassa resolves it without a second receipt', async () => {
  await desk(async (ctx) => {
    const sim = webkassa();
    const worker = new WebkassaFiscalWorker(
      ctx.edge.pool,
      ctx.branch,
      new WebkassaClient(ACCOUNT, { transport: sim }),
      () => {},
    );
    const { made } = await sale(ctx, (total) => [{ method: 'kaspi_manual', amount_minor: total }]);
    const orderId = made.order_id ?? made.sale?.order_id ?? made.order?.id;
    const receipt = await receiptOf(ctx, orderId);
    // Webkassa makes the receipt but the answer never arrives.
    sim.script.push({ kind: 'ok', data: { Token: 'token-1' }, top: {} });
    sim.script.push((path, body) => {
      // Webkassa keeps the receipt, the answer is lost on the way back.
      sim.checks.set(body.ExternalCheckNumber, { CheckNumber: '777000', body });
      return { kind: 'lost', reason: 'TIMEOUT' };
    });
    assert.equal(await worker.tick(), 0);
    assert.equal((await receiptOf(ctx, orderId)).state, 'pending');
    assert.equal(await worker.tick(), 1);
    const after = await receiptOf(ctx, orderId);
    assert.equal(after.state, 'recorded');
    assert.equal(after.receipt_number, '777000');
    const checkCalls = sim.calls.filter((c) => c.path === 'api/v4/check');
    assert.equal(checkCalls.length, 2);
    assert.ok(checkCalls.every((c) => c.body.ExternalCheckNumber === receipt.id));
    assert.deepEqual(
      checkCalls[1].body.Payments.map((p) => p.PaymentType),
      [4],
    );
  });
});

test('refusals keep the receipt pending with the reason; an expired session signs in again', async () => {
  await desk(async (ctx) => {
    const sim = webkassa();
    const worker = new WebkassaFiscalWorker(
      ctx.edge.pool,
      ctx.branch,
      new WebkassaClient(ACCOUNT, { transport: sim }),
      () => {},
    );
    const { made } = await sale(ctx, (total) => [
      { method: 'kaspi_terminal', amount_minor: total },
    ]);
    const orderId = made.order_id ?? made.sale?.order_id ?? made.order?.id;
    const receipt = await receiptOf(ctx, orderId);
    sim.script.push({ kind: 'ok', data: { Token: 'token-1' }, top: {} });
    sim.script.push({
      kind: 'refused',
      httpStatus: 200,
      errors: [{ code: 18, text: 'автономный режим превышает 72 часа' }],
      top: {},
    });
    const t0 = Date.now();
    assert.equal(await worker.tick(t0), 0);
    const status = await webkassaReceiptStatus(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.cashier),
      worker,
      receipt.id,
      true,
    );
    assert.equal(status.state, 'pending');
    assert.equal(status.error.code, 18);
    assert.equal(status.print, null);
    // Another desk's cashier does not see this desk's receipt.
    await assert.rejects(
      webkassaReceiptStatus(
        ctx.edge.pool,
        ctx.branch,
        staffAuth(ctx.other),
        worker,
        receipt.id,
        false,
      ),
      (error) => error.code === 'NOT_FOUND',
    );
    // Within the back-off nothing is sent; after it, an expired session is renewed and it passes.
    assert.equal(await worker.tick(t0 + 1000), 0);
    const sent = sim.calls.length;
    sim.script.push({
      kind: 'refused',
      httpStatus: 200,
      errors: [{ code: 2, text: 'Срок' }],
      top: {},
    });
    assert.equal(await worker.tick(t0 + 6 * 60 * 1000), 1);
    assert.deepEqual(
      sim.calls.slice(sent).map((c) => c.path),
      ['api/v4/check', 'api/v4/Authorize', 'api/v4/check'],
    );
    const issued = await webkassaReceiptStatus(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.cashier),
      worker,
      receipt.id,
      true,
    );
    assert.equal(issued.state, 'recorded');
    assert.equal(issued.error, null);
    assert.deepEqual(
      issued.print.map((l) => l.type),
      [0, 2],
    );
    assert.equal(sim.calls.at(-1).body.ExternalCheckNumber, receipt.id);
  });
});

test('a Webkassa shift past 24 h is closed with a Z-report and the receipt goes through at once', async () => {
  await desk(async (ctx) => {
    const sim = webkassa();
    const logs = [];
    const worker = new WebkassaFiscalWorker(
      ctx.edge.pool,
      ctx.branch,
      new WebkassaClient(ACCOUNT, { transport: sim }),
      (entry) => logs.push(entry),
    );
    const { made } = await sale(ctx, (total) => [
      { method: 'kaspi_terminal', amount_minor: total },
    ]);
    const orderId = made.order_id ?? made.sale?.order_id ?? made.order?.id;
    const receipt = await receiptOf(ctx, orderId);
    sim.script.push({ kind: 'ok', data: { Token: 'token-1' }, top: {} });
    sim.script.push({
      kind: 'refused',
      httpStatus: 200,
      errors: [{ code: 11, text: 'Продолжительность смены превышает 24 часа' }],
      top: {},
    });
    assert.equal(await worker.tick(Date.now()), 1);
    assert.deepEqual(
      sim.calls.map((c) => c.path),
      ['api/v4/Authorize', 'api/v4/check', 'api/v4/ZReport', 'api/v4/check'],
    );
    assert.equal(sim.calls.at(-1).body.ExternalCheckNumber, receipt.id);
    assert.ok(logs.some((l) => l.event === 'webkassa_shift_over_24h' && l.report === 'ok'));
    const issued = await webkassaReceiptStatus(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.cashier),
      worker,
      receipt.id,
      false,
    );
    assert.equal(issued.state, 'recorded');
  });
});

test('a number typed by hand first wins; the Z-report closes Webkassa once the last shift is closed', async () => {
  await desk(async (ctx) => {
    const sim = webkassa();
    const worker = new WebkassaFiscalWorker(
      ctx.edge.pool,
      ctx.branch,
      new WebkassaClient(ACCOUNT, { transport: sim }),
      () => {},
    );
    const { q, made } = await sale(ctx, (total) => [{ method: 'cash', amount_minor: total }]);
    const receiptTotal = BigInt(q.total_minor);
    const orderId = made.order_id ?? made.sale?.order_id ?? made.order?.id;
    const receipt = await receiptOf(ctx, orderId);
    await recordFiscalReceipt(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.cashier),
      randomUUID(),
      receipt.id,
      { receipt_number: 'HAND-1', expected_version: 1 },
    );
    assert.equal(await worker.tick(), 0);
    assert.equal(sim.calls.filter((c) => c.path === 'api/v4/check').length, 0);
    assert.equal(sim.calls.filter((c) => c.path === 'api/v4/ZReport').length, 0);
    // Close every PickChick shift of the branch: one Z-report follows, and only once.
    for (const [terminal, shiftId] of Object.entries(ctx.shifts)) {
      const cash = terminal === ctx.cashier.terminal_id ? receiptTotal : 0n;
      await closeCashShift(
        ctx.edge.pool,
        ctx.branch,
        staffAuth(ctx.manager),
        randomUUID(),
        shiftId,
        {
          expected_version: 1,
          reason: 'Синтетическое закрытие',
          counted_cash_minor: cash.toString(),
        },
      );
      if (terminal === ctx.cashier.terminal_id) {
        await worker.tick();
        assert.equal(sim.calls.filter((c) => c.path === 'api/v4/ZReport').length, 0);
      }
    }
    await worker.tick();
    await worker.tick();
    assert.equal(sim.calls.filter((c) => c.path === 'api/v4/ZReport').length, 1);
  });
});

/** A refund approval of the shift manager, as pos-sales.test.mjs grants it. */
async function grantRefund(ctx, subject) {
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

test('a refund gets its Webkassa return receipt naming the sale from its print form (P0-1)', async () => {
  await desk(async (ctx) => {
    const sim = webkassa();
    sim.fullForm = true;
    const events = [];
    const worker = new WebkassaFiscalWorker(
      ctx.edge.pool,
      ctx.branch,
      new WebkassaClient(ACCOUNT, { transport: sim }),
      (event) => events.push(event),
    );
    const { q, made } = await sale(ctx, (total) => [{ method: 'cash', amount_minor: total }]);
    const orderId = made.order_id ?? made.sale?.order_id ?? made.order?.id;
    const saleReceipt = await receiptOf(ctx, orderId);
    // A refund made before the sale receipt is issued waits for it.
    const amount = String(Number(q.total_minor) / 2);
    const tender = (
      await ctx.edge.pool.query('SELECT id FROM pos_sale_tenders WHERE order_id=$1', [orderId])
    ).rows[0].id;
    const approval = await grantRefund(ctx, { order_id: orderId, amount_minor: amount });
    await refundPosSale(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), randomUUID(), orderId, {
      refund_id: randomUUID(),
      tenders: [{ tender_id: tender, amount_minor: amount }],
      reason_code: 'quality',
      reason: 'Синтетический возврат',
      approval: { approval_id: approval.approval_id, token: approval.token },
    });
    assert.equal(await worker.tick(), 1, 'the sale first; its refund waits for the sale receipt');
    assert.equal(await worker.tick(), 1, 'then the refund');
    const checks = sim.calls.filter((c) => c.path === 'api/v4/check').map((c) => c.body);
    assert.deepEqual(
      checks.map((b) => b.OperationType),
      [2, 3],
    );
    const back = checks[1];
    const refundReceipt = (
      await ctx.edge.pool.query(
        "SELECT id,state,receipt_number,recorded_by_staff_id FROM pos_fiscal_receipts WHERE order_id=$1 AND kind='refund'",
        [orderId],
      )
    ).rows[0];
    assert.equal(back.ExternalCheckNumber, refundReceipt.id);
    assert.deepEqual(back.Payments, [{ Sum: Number(amount) / 100, PaymentType: 0 }]);
    const positions = back.Positions.reduce((s, p) => s + p.Price * p.Count - p.Discount, 0);
    assert.equal(Math.round(positions * 100), Number(amount));
    const saleNumber = sim.checks.get(saleReceipt.id).CheckNumber;
    assert.deepEqual(back.ReturnBasisDetails, {
      CheckNumber: saleNumber,
      DateTime: '2026-11-25 14:34:29',
      Total: Number(q.total_minor) / 100,
      RegistrationNumber: '000000000001',
      IsOffline: true,
    });
    assert.equal(refundReceipt.state, 'recorded');
    assert.equal(refundReceipt.receipt_number, sim.checks.get(refundReceipt.id).CheckNumber);
    assert.ok(events.some((e) => e.event === 'webkassa_receipt_issued' && e.kind === 'refund'));
    assert.equal(await worker.tick(), 0);
  });
});

test('a refund whose sale print form lacks the return data stays for the cashier', async () => {
  await desk(async (ctx) => {
    const sim = webkassa();
    const events = [];
    const worker = new WebkassaFiscalWorker(
      ctx.edge.pool,
      ctx.branch,
      new WebkassaClient(ACCOUNT, { transport: sim }),
      (event) => events.push(event),
    );
    const { q, made } = await sale(ctx, (total) => [{ method: 'cash', amount_minor: total }]);
    const orderId = made.order_id ?? made.sale?.order_id ?? made.order?.id;
    assert.equal(await worker.tick(), 1);
    const tender = (
      await ctx.edge.pool.query('SELECT id FROM pos_sale_tenders WHERE order_id=$1', [orderId])
    ).rows[0].id;
    const approval = await grantRefund(ctx, { order_id: orderId, amount_minor: q.total_minor });
    await refundPosSale(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), randomUUID(), orderId, {
      refund_id: randomUUID(),
      tenders: [{ tender_id: tender, amount_minor: q.total_minor }],
      reason_code: 'quality',
      reason: 'Синтетический возврат',
      approval: { approval_id: approval.approval_id, token: approval.token },
    });
    // sim.fullForm stays false: Webkassa answers with a form without ФП, time or РНМ.
    assert.equal(await worker.tick(), 0);
    assert.equal(sim.calls.filter((c) => c.path === 'api/v4/check').length, 1, 'no guessed return');
    assert.ok(events.some((e) => e.event === 'webkassa_receipt_refused' && e.code === -1));
    const pending = await listPendingFiscalReceipts(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.cashier),
    );
    assert.equal(pending.receipts.length, 1, 'the refund receipt stays in «Чеки Webkassa»');
  });
});

test("the cashier desk lists today's paid kiosk orders and prints their Webkassa receipt", async () => {
  await desk(async (ctx) => {
    const sim = webkassa();
    const worker = new WebkassaFiscalWorker(
      ctx.edge.pool,
      ctx.branch,
      new WebkassaClient(ACCOUNT, { transport: sim }),
      () => {},
    );
    const { made } = await sale(ctx, (total) => [{ method: 'cash', amount_minor: total }]);
    const posOrder = made.order_id ?? made.sale?.order_id ?? made.order?.id;
    // A kiosk order the cloud admitted (receipt issued in the cloud first), next to the POS sale.
    const kiosk = randomUUID(),
      held = randomUUID();
    for (const [id, authorized] of [
      [kiosk, true],
      [held, false],
    ])
      await ctx.edge.pool.query(
        `INSERT INTO fulfillment_reservations(order_id,branch_id,reservation_id,quote_id,quote_hash,owner_hash,
           commercial_owner,fulfillment_owner,device_id,snapshot,routing_version,task_plan,assembly_station_id,
           state,display_number,business_day,authorized_event_id)
         SELECT $2,branch_id,$3,$4,quote_hash,owner_hash,'cloud','edge',device_id,
           snapshot||'{"channel":"kiosk"}'::jsonb,routing_version,task_plan,assembly_station_id,
           $5,CASE WHEN $6 THEN display_number+100 END,CASE WHEN $6 THEN business_day END,
           CASE WHEN $6 THEN $7::uuid END
         FROM fulfillment_reservations WHERE order_id=$1`,
        [
          posOrder,
          id,
          randomUUID(),
          randomUUID(),
          authorized ? 'accepted' : 'held',
          authorized,
          randomUUID(),
        ],
      );
    const list = await kioskReceipts(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier));
    assert.deepEqual(
      list.receipts.map((r) => r.order_id),
      [kiosk],
      'only the admitted kiosk order; not the POS sale nor a held one',
    );
    const form = await kioskReceiptPrint(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.cashier),
      worker,
      kiosk,
    );
    assert.equal(form.display_number, list.receipts[0].display_number);
    assert.deepEqual(form.print[0], { order: 1, type: 0, value: 'ФИСКАЛЬНЫЙ ЧЕК', style: 1 });
    assert.equal(form.print[1].type, 2);
    assert.ok(form.print[1].qr.length >= 21);
    const asked = sim.calls.find((c) => c.path === 'api/v4/Ticket/PrintFormat');
    assert.equal(asked.body.ExternalCheckNumber, kiosk, 'the cloud issued it under the order id');
    await assert.rejects(
      kioskReceiptPrint(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), worker, posOrder),
      { code: 'NOT_FOUND' },
    );
    await assert.rejects(
      kioskReceiptPrint(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), worker, held),
      { code: 'NOT_FOUND' },
    );
    assert.equal(asked.body.CashboxUniqueNumber, ACCOUNT.cashboxUniqueNumber);
    // Owner 27.11: the cloud issues kiosk receipts on their own cashbox; the point reads them there.
    const split = new WebkassaFiscalWorker(
      ctx.edge.pool,
      ctx.branch,
      new WebkassaClient(
        { ...ACCOUNT, kioskCashboxUniqueNumber: 'SWK00000002' },
        { transport: sim },
      ),
      () => {},
    );
    await kioskReceiptPrint(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), split, kiosk);
    const last = sim.calls.filter((c) => c.path === 'api/v4/Ticket/PrintFormat').at(-1);
    assert.equal(last.body.CashboxUniqueNumber, 'SWK00000002');
    assert.equal(last.body.ExternalCheckNumber, kiosk);
  });
});

// Owner 28.11.2026: without an explicit test/live mode equal to the account host the point sells,
// but its receipts stay manual (pending) and Webkassa is never called.
test('point mode not set or not equal to the account host: sale passes, receipt stays manual, one event', async () => {
  await desk(async (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), 'wk-loop-'));
    const file = (host) => {
      const path = join(dir, `${host}.json`);
      writeFileSync(path, JSON.stringify({ ...ACCOUNT, baseUrl: `https://${host}.webkassa.kz` }));
      return path;
    };
    const loop = (host, webkassaEnvironment, webkassaModeInvalid) =>
      new WebkassaLoop({
        pool: ctx.edge.pool,
        config: {
          branchId: ctx.branch,
          webkassaAccountFile: file(host),
          ...(webkassaEnvironment ? { webkassaEnvironment } : {}),
          ...(webkassaModeInvalid ? { webkassaModeInvalid } : {}),
        },
      });
    const captured = [];
    const original = console.error;
    console.error = (line) => captured.push(JSON.parse(line));
    let blocked;
    try {
      blocked = [
        loop('devkkm', undefined),
        loop('kkm', undefined),
        loop('devkkm', 'live'),
        loop('kkm', undefined, 'environment_invalid'),
        loop('devkkm', undefined, 'environment_conflict'),
      ];
      for (const l of blocked) l.onApplicationBootstrap();
    } finally {
      console.error = original;
    }
    for (const l of blocked) {
      assert.equal(l.worker, null);
      assert.equal(l.environment, null, 'GET pos/webkassa answers 404, the desk shows manual mode');
    }
    assert.deepEqual(
      captured.map((e) => [e.event, e.reason, e.declared, e.host, e.expected]),
      [
        ['webkassa_mode_blocked', 'environment_not_set', undefined, 'test', undefined],
        ['webkassa_mode_blocked', 'environment_not_set', undefined, 'live', undefined],
        ['webkassa_mode_blocked', 'environment_mismatch', 'live', 'test', undefined],
        ['webkassa_mode_blocked', 'environment_invalid', undefined, undefined, 'live|test'],
        ['webkassa_mode_blocked', 'environment_conflict', undefined, undefined, 'live|test'],
      ],
    );
    assert.ok(!JSON.stringify(captured).includes(ACCOUNT.apiKey));
    assert.ok(!JSON.stringify(captured).includes(dir));
    // The sale goes through and its receipt waits for the cashier: pending, nobody called Webkassa.
    const { made } = await sale(ctx, (total) => [{ method: 'cash', amount_minor: total }]);
    const orderId = made.order_id ?? made.sale?.order_id ?? made.order?.id;
    assert.equal((await receiptOf(ctx, orderId)).state, 'pending');
    const pending = await listPendingFiscalReceipts(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.cashier),
    );
    assert.equal(pending.receipts.length, 1);
    // The declared mode equal to the host turns the automatic worker on, as before.
    const live = loop('devkkm', 'test');
    assert.ok(live.worker);
    assert.equal(live.environment, 'test');
    assert.equal(loop('kkm', 'live').environment, 'live');
  });
});
