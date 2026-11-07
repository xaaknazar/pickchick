// Paid cashier screens (cutover 19.11, contracts section 5.1) in a real browser against a
// synthetic edge: the pos lane builds the edge side in parallel, so no PostgreSQL is needed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPosServer } from '../../apps/pos/server.mjs';

const METHODS = [
  'cash',
  'kaspi_terminal',
  'kaspi_manual',
  'aggregator_yandex_eda',
  'aggregator_glovo',
  'chocofood',
  'staff_meal',
  'marketing',
];
const MIXABLE = ['cash', 'kaspi_terminal', 'kaspi_manual'];

/** In-memory edge with the routes of today's cashier plus GET pos/config and POST pos/sales. */
function syntheticEdge() {
  const branch = randomUUID(),
    terminal = randomUUID(),
    category = randomUUID();
  const staff = (role, name) => ({
    session_id: randomUUID(),
    staff_id: randomUUID(),
    terminal_id: terminal,
    branch_id: branch,
    role,
    name,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    token: randomUUID().replaceAll('-', '').padEnd(64, '0'),
  });
  const cashier = staff('cashier', 'Тестовый кассир');
  const manager = staff('shift_manager', 'Тестовый начальник');
  const actors = [cashier, manager];
  const items = [
    ['Тестовое комбо', '349000'],
    ['Тестовый напиток', '50000'],
  ].map(([name, price]) => ({
    product_id: randomUUID(),
    variant_id: randomUUID(),
    category_id: category,
    name: { ru: name, kk: name },
    currency: 'KZT',
    price_minor: price,
  }));
  const menu = {
    schema_version: 1,
    release_id: randomUUID(),
    branch_id: branch,
    version: 1,
    published_at: new Date().toISOString(),
    items,
  };
  const shift = {
    shift_id: randomUUID(),
    branch_id: branch,
    terminal_id: terminal,
    staff_id: cashier.staff_id,
    version: 1,
    state: 'open',
    opened_at: new Date().toISOString(),
    closed_at: null,
    closed_by_staff_id: null,
    opening_cash_minor: '2000000',
    expected_cash_minor: '2000000',
    cash_movements: [],
    counted_cash_minor: null,
    discrepancy_minor: null,
    closing_reason: null,
    currency: 'KZT',
    order_count: 0,
    awaiting_payment_count: 0,
    cancelled_count: 0,
    order_total_minor: '0',
    unpaid_total_minor: '0',
    cash_received_minor: '0',
    cash_refunded_minor: '0',
    payment_processing_available: true,
    report_at: new Date().toISOString(),
  };
  const state = {
    config: {
      mode: 'pos_sale',
      methods: METHODS.map((code) => ({
        code,
        enabled: true,
        requires_approval: code === 'staff_meal' || code === 'marketing',
        allow_in_mix: MIXABLE.includes(code),
        fiscal_policy: MIXABLE.includes(code) ? 'manual_webkassa' : 'not_required',
      })),
      channels: ['hall', 'yandex_eda', 'glovo'].map((code) => ({ code, enabled: true })),
      fiscal_mode: 'manual_webkassa',
      approval_ttl_seconds: 120,
    },
    quotes: new Map(),
    orders: new Map(),
    sales: new Map(),
    commands: new Map(),
    posts: [],
    // Every POST orders with the pos/config mode of that moment (null: the edge answers 404).
    unpaid: [],
    // Review 07.11 R1: GET pos/config answers 503 while set; GET ordering still says pos_sale.
    configFails: false,
    configReads: 0,
    number: 26,
    // Part B: voids, refunds, receipts, approvals and the closed shift.
    ops: [],
    approvals: [],
    closed: null,
  };
  const quote = (body) => {
    const lines = body.items.map((line) => {
      const item = items.find((i) => i.variant_id === line.variant_id);
      // Aggregator channel prices differ from the hall: the screen must show the quote.
      const unit = body.sales_channel
        ? (BigInt(item.price_minor) + 10000n).toString()
        : item.price_minor;
      return {
        product_id: item.product_id,
        variant_id: item.variant_id,
        name: item.name,
        quantity: line.quantity,
        unit_price_minor: unit,
        total_minor: (BigInt(unit) * BigInt(line.quantity)).toString(),
      };
    });
    const total = lines.reduce((n, l) => n + BigInt(l.total_minor), 0n).toString();
    const q = {
      quote_id: randomUUID(),
      branch_id: branch,
      release_id: menu.release_id,
      menu_version: 1,
      service_mode: body.service_mode,
      ...(body.sales_channel ? { sales_channel: body.sales_channel } : {}),
      channel: 'pos',
      lines,
      currency: 'KZT',
      subtotal_minor: total,
      discount_minor: '0',
      total_minor: total,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 120000).toISOString(),
    };
    state.quotes.set(q.quote_id, q);
    return q;
  };
  const sell = (body) => {
    const q = state.quotes.get(body.quote_id);
    if (!q) return [409, { code: 'CONFLICT' }];
    const order_id = randomUUID(),
      number = ++state.number,
      created_at = new Date().toISOString();
    const cash = body.tenders.find((t) => t.method === 'cash');
    const first = body.tenders[0].method;
    const order = {
      cash_shift_id: shift.shift_id,
      order_id,
      branch_id: branch,
      quote_id: q.quote_id,
      version: 1,
      state: 'paid',
      payment_state: 'captured',
      fiscal_state: 'not_requested',
      fulfillment_state: 'accepted',
      execution_mode: 'pos_sale',
      fulfillment: { version: 1, display_number: String(number), state: 'accepted' },
      next_action: 'none',
      snapshot: q,
      created_at,
      cancellation_reason: null,
    };
    const sale = {
      order_id,
      display_number: number,
      pickup: q.sales_channel ? 'delivery_handover' : 'issue',
      sales_channel: q.sales_channel ?? 'hall',
      external_order_ref: body.external_order_ref ?? null,
      service_mode: q.service_mode,
      revenue_kind: first === 'staff_meal' || first === 'marketing' ? first : 'revenue',
      total_minor: q.total_minor,
      cash_tendered_minor: cash ? body.cash_tendered_minor : null,
      change_minor: cash
        ? (BigInt(body.cash_tendered_minor) - BigInt(cash.amount_minor)).toString()
        : null,
      tenders: body.tenders.map((t) => ({
        tender_id: randomUUID(),
        method: t.method,
        amount_minor: t.amount_minor,
        confirmation:
          t.method === 'cash'
            ? 'drawer'
            : t.method.startsWith('aggregator_') || t.method === 'chocofood'
              ? 'aggregator_attested'
              : t.method === 'staff_meal' || t.method === 'marketing'
                ? 'manager_approved'
                : 'cashier_attested',
        reference: t.reference ?? null,
      })),
      refunds: [],
      refundable_minor: q.total_minor,
      fiscal: [
        {
          receipt_id: randomUUID(),
          kind: 'sale',
          state: MIXABLE.includes(first) ? 'pending' : 'not_required',
          receipt_number: null,
          version: 1,
          amount_minor: q.total_minor,
        },
      ],
      shift_id: shift.shift_id,
      terminal_id: terminal,
      cashier_staff_id: cashier.staff_id,
      created_at,
    };
    state.orders.set(order_id, order);
    state.sales.set(order_id, sale);
    return [201, { order, sale }];
  };
  const left = (sale, tender) =>
    BigInt(tender.amount_minor) -
    sale.refunds
      .flatMap((r) => r.tenders)
      .filter((t) => t.tender_id === tender.tender_id)
      .reduce((n, t) => n + BigInt(t.amount_minor), 0n);
  const pending = (shiftId) =>
    [...state.sales.values()]
      .filter((sale) => !shiftId || sale.shift_id === shiftId)
      .flatMap((sale) =>
        sale.fiscal
          .filter((r) => r.state === 'pending')
          .map((r) => ({
            receipt_id: r.receipt_id,
            order_id: sale.order_id,
            display_number: sale.display_number,
            kind: r.kind,
            amount_minor: r.amount_minor,
            methods: sale.tenders.map((t) => t.method),
            created_at: sale.created_at,
            version: r.version,
          })),
      );
  const report = (kind) => {
    const methods = new Map(),
      channels = new Map(),
      fiscal = { pending: 0, recorded: 0, not_required: 0 };
    let voided = 0;
    for (const sale of state.sales.values()) {
      for (const t of sale.tenders) {
        const m = methods.get(t.method) ?? { sales: 0n, refunds: 0n, count: 0 };
        m.sales += BigInt(t.amount_minor);
        m.count++;
        methods.set(t.method, m);
      }
      for (const r of sale.refunds) {
        if (r.kind === 'void') voided++;
        for (const part of r.tenders)
          methods.get(sale.tenders.find((t) => t.tender_id === part.tender_id).method).refunds +=
            BigInt(part.amount_minor);
      }
      const c = channels.get(sale.sales_channel) ?? { total: 0n, count: 0 };
      c.total += BigInt(sale.total_minor);
      c.count++;
      channels.set(sale.sales_channel, c);
      for (const r of sale.fiscal) fiscal[r.state]++;
    }
    const cash = methods.get('cash') ?? { sales: 0n, refunds: 0n };
    const terminal = methods.get('kaspi_terminal') ?? { sales: 0n, refunds: 0n };
    const expected = BigInt(shift.opening_cash_minor) + cash.sales - cash.refunds;
    const closed = state.closed;
    return {
      kind,
      shift_id: shift.shift_id,
      terminal_id: terminal_id(),
      state: closed ? 'closed' : 'open',
      opened_at: shift.opened_at,
      closed_at: closed?.closed_at ?? null,
      opening_cash_minor: shift.opening_cash_minor,
      cash_in_minor: '0',
      cash_out_minor: '0',
      cash_sales_minor: cash.sales.toString(),
      cash_refunds_minor: cash.refunds.toString(),
      expected_cash_minor: expected.toString(),
      counted_cash_minor: closed?.counted_cash_minor ?? null,
      discrepancy_minor: closed ? (BigInt(closed.counted_cash_minor) - expected).toString() : null,
      methods: [...methods].map(([method, m]) => ({
        method,
        sales_minor: m.sales.toString(),
        refunds_minor: m.refunds.toString(),
        count: m.count,
      })),
      channels: [...channels].map(([sales_channel, c]) => ({
        sales_channel,
        total_minor: c.total.toString(),
        count: c.count,
      })),
      terminal_reported_minor: closed?.terminal ?? null,
      terminal_discrepancy_minor:
        closed?.terminal == null
          ? null
          : (BigInt(closed.terminal) - (terminal.sales - terminal.refunds)).toString(),
      fiscal,
      orders: { count: state.sales.size, voided_count: voided },
      report_at: new Date().toISOString(),
    };
  };
  const terminal_id = () => terminal;
  /** Idempotent part B commands: the same key returns the stored answer. */
  const command = (p, body, key, run) => {
    state.ops.push({ path: p, body, key });
    if (state.commands.has(key)) return state.commands.get(key);
    const result = run();
    state.commands.set(key, result);
    return result;
  };
  const operation = (p, body) => {
    const id = p.split('/')[2];
    const sale = state.sales.get(id),
      order = state.orders.get(id);
    if (p.endsWith('/void')) {
      const refund = {
        refund_id: randomUUID(),
        kind: 'void',
        amount_minor: sale.refundable_minor,
        reason_code: body.reason_code,
        approved_by_staff_id: manager.staff_id,
        created_at: new Date().toISOString(),
        tenders: sale.tenders
          .map((t) => ({ tender_id: t.tender_id, amount_minor: left(sale, t).toString() }))
          .filter((t) => t.amount_minor !== '0'),
      };
      sale.refunds.push(refund);
      sale.refundable_minor = '0';
      Object.assign(order, {
        state: 'cancelled',
        version: order.version + 1,
        fulfillment_state: 'cancelled',
        fulfillment: { ...order.fulfillment, version: 2, state: 'cancelled' },
        cancellation_reason: body.reason,
      });
      return [200, { order, sale }];
    }
    const sum = body.tenders.reduce((n, t) => n + BigInt(t.amount_minor), 0n);
    sale.refunds.push({
      refund_id: body.refund_id,
      kind: 'refund',
      amount_minor: sum.toString(),
      reason_code: body.reason_code,
      approved_by_staff_id: manager.staff_id,
      created_at: new Date().toISOString(),
      tenders: body.tenders,
    });
    sale.refundable_minor = (BigInt(sale.refundable_minor) - sum).toString();
    sale.fiscal.push({
      receipt_id: randomUUID(),
      kind: 'refund',
      state: 'pending',
      receipt_number: null,
      version: 1,
      amount_minor: sum.toString(),
    });
    return [200, sale];
  };
  /** An order of today's unpaid cashier, admitted to the kitchen without payment. */
  const unpaidOrder = (body) => {
    const q = state.quotes.get(body.quote_id);
    if (!q) return [409, { code: 'CONFLICT' }];
    const order = {
      cash_shift_id: shift.shift_id,
      order_id: randomUUID(),
      branch_id: branch,
      quote_id: q.quote_id,
      version: 1,
      state: 'awaiting_payment',
      payment_state: 'not_started',
      fiscal_state: 'not_requested',
      fulfillment_state: 'accepted',
      execution_mode: 'unpaid_service',
      fulfillment: { version: 1, display_number: String(++state.number), state: 'accepted' },
      next_action: 'none',
      snapshot: q,
      created_at: new Date().toISOString(),
      cancellation_reason: null,
    };
    state.orders.set(order.order_id, order);
    return [201, order];
  };
  const route = (method, path, body, headers) => {
    if (path === '/health/ready') return [200, { ready: true }];
    if (path === '/edge/v1/staff/pin') {
      const found = { 1357: cashier, 2468: manager }[body.pin];
      return found ? [200, found] : [401, { code: 'UNAUTHORIZED' }];
    }
    const actor = actors.find((a) => headers.authorization === `Bearer ${a.token}`);
    if (!actor) return [401, { code: 'UNAUTHORIZED' }];
    const p = path.replace('/edge/v1/', '');
    const now = new Date().toISOString();
    if (method === 'GET') {
      if (p === 'session') {
        const { token: _token, ...session } = actor;
        void _token;
        return [200, session];
      }
      if (p === 'menu') return [200, menu];
      if (p === 'menu/version') return [200, { release_id: menu.release_id, version: 1 }];
      if (p === 'ordering')
        return [
          200,
          {
            branch_id: branch,
            ordering_enabled: true,
            version: 1,
            pos_service_mode: state.config ? state.config.mode : 'unpaid_service',
          },
        ];
      if (p === 'availability/stops')
        return [
          200,
          { stops: items.map((i) => ({ variant_id: i.variant_id, stopped: false, version: 0 })) },
        ];
      if (p.startsWith('availability/stops/'))
        return [200, { variant_id: p.split('/')[2], stopped: false, version: 0 }];
      if (p === 'cash-shifts/current')
        return [200, { shift: state.closed ? null : shift, server_time: now }];
      if (p === 'cash-shifts') return [200, { shifts: [state.closed ?? shift], server_time: now }];
      if (p === `cash-shifts/${shift.shift_id}`) return [200, state.closed ?? shift];
      if (p === `cash-shifts/${shift.shift_id}/x-report`) return [200, report('x')];
      if (p === `cash-shifts/${shift.shift_id}/z-report`)
        return state.closed ? [200, report('z')] : [409, { code: 'CONFLICT' }];
      if (p.startsWith('pos/fiscal-receipts/pending')) {
        const query = new URL(p, 'http://edge.invalid/').searchParams.get('shift_id');
        return [200, { receipts: pending(query) }];
      }
      if (p === 'orders') return [200, { orders: [...state.orders.values()], server_time: now }];
      if (p.startsWith('orders/')) {
        const o = state.orders.get(p.split('/')[1]);
        return o ? [200, o] : [404, { code: 'NOT_FOUND' }];
      }
      if (p === 'pos/config') {
        state.configReads++;
        if (state.configFails) return [503, { code: 'EDGE_UNAVAILABLE' }];
        return state.config
          ? [200, { ...state.config, server_time: now }]
          : [404, { code: 'NOT_FOUND' }];
      }
      if (p.startsWith('pos/sales/')) {
        const s = state.sales.get(p.split('/')[2]);
        return s ? [200, s] : [404, { code: 'NOT_FOUND' }];
      }
      return [404, { code: 'NOT_FOUND' }];
    }
    if (p === 'staff/logout') return [204, null];
    if (p === 'checkout/quotes') return [200, quote(body)];
    if (p === 'orders') {
      state.unpaid.push({ mode: state.config?.mode ?? null, body });
      // Today's cashier on an edge without pos/config passes the order to the kitchen unpaid;
      // an edge that sells refuses POST orders.
      if (state.config || body.kitchen_admission !== 'unpaid')
        return [409, { code: 'SERVICE_MODE_DISABLED' }];
      return unpaidOrder(body);
    }
    if (p === 'pos/sales') {
      state.posts.push(body);
      const key = headers['idempotency-key'];
      if (state.commands.has(key)) return state.commands.get(key);
      const result = sell(body);
      state.commands.set(key, result);
      return result;
    }
    if (/^pos\/sales\/[0-9a-f-]+\/(void|refunds)$/.test(p))
      return command(p, body, headers['idempotency-key'], () => operation(p, body));
    if (p === `cash-shifts/${shift.shift_id}/close`)
      return command(p, body, headers['idempotency-key'], () => {
        const expected = report('x').expected_cash_minor;
        state.closed = {
          ...shift,
          version: 2,
          state: 'closed',
          closed_at: new Date().toISOString(),
          closed_by_staff_id: actor.staff_id,
          expected_cash_minor: expected,
          counted_cash_minor: body.counted_cash_minor,
          discrepancy_minor: (BigInt(body.counted_cash_minor) - BigInt(expected)).toString(),
          closing_reason: body.reason,
        };
        Object.defineProperty(state.closed, 'terminal', {
          value: body.terminal_reported_minor ?? null,
          enumerable: false,
        });
        return [200, state.closed];
      });
    if (p === 'staff/approvals') {
      // The session's own staff id with a shift manager PIN (CR client-1 section 1).
      if (body.pin !== '2468' || body.staff_id !== actor.staff_id)
        return [401, { code: 'UNAUTHORIZED' }];
      state.approvals.push({ action: body.action, subject: body.subject });
      return [
        200,
        {
          approval_id: randomUUID(),
          token: 'd'.repeat(64),
          expires_at: new Date(Date.now() + 120000).toISOString(),
          manager: { staff_id: randomUUID(), name: 'Тестовый начальник' },
        },
      ];
    }
    if (/^pos\/fiscal-receipts\/[0-9a-f-]+\/record$/.test(p)) {
      state.ops.push({ path: p, body, key: headers['idempotency-key'] });
      for (const sale of state.sales.values())
        for (const receipt of sale.fiscal)
          if (receipt.receipt_id === p.split('/')[2]) {
            Object.assign(receipt, {
              state: 'recorded',
              receipt_number: body.receipt_number,
              version: receipt.version + 1,
            });
            return [200, receipt];
          }
      return [404, { code: 'NOT_FOUND' }];
    }
    return [404, { code: 'NOT_FOUND' }];
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const [status, payload] = route(
      req.method,
      req.url,
      raw ? JSON.parse(raw) : undefined,
      req.headers,
    );
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload === null ? '' : JSON.stringify(payload));
  });
  return { server, state, terminal, category };
}

test('paid cashier screens in the browser: hall cash, aggregator, staff meal; 404 keeps the unpaid UI', async () => {
  const edge = syntheticEdge();
  await new Promise((r) => edge.server.listen(0, '127.0.0.1', r));
  const pos = createPosServer({
    edgePort: edge.server.address().port,
    branchLabel: 'Тестовая точка',
    categories: { [edge.category]: 'Комбо' },
    terminalId: edge.terminal,
    // As pos-desktop 0.5.0 sends it: the lock screen of a desk that sells shows it (CR client-5).
    appVersion: '0.5.0',
  });
  await new Promise((r) => pos.listen(0, '127.0.0.1', r));
  const output = new URL('../../.local/pos-sale-browser/', import.meta.url);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(fileURLToPath(new URL('run-', output)));
  const paid = edge.state.config;
  const control = createServer((req, res) => {
    // The browser script switches the synthetic edge to an edge without pos/config and back.
    if (req.url === '/legacy') edge.state.config = null;
    if (req.url === '/paid') edge.state.config = paid;
    if (req.url === '/config-fail') edge.state.configFails = true;
    if (req.url === '/config-ok') edge.state.configFails = false;
    // Edge 028 (CR pos-7): pos/config names this desk's number; before, the key is absent (026).
    if (req.url === '/desk-2') paid.desk_number = 2;
    if (req.url === '/desk-null') paid.desk_number = null;
    res.end(JSON.stringify({ configReads: edge.state.configReads }));
  });
  await new Promise((r) => control.listen(0, '127.0.0.1', r));
  try {
    const file = temp + '/fixture.json';
    await writeFile(
      file,
      JSON.stringify({
        url: `http://127.0.0.1:${pos.address().port}`,
        control: `http://127.0.0.1:${control.address().port}`,
        output: fileURLToPath(output),
      }),
      { mode: 0o600 },
    );
    const exit = await new Promise((resolve, reject) => {
      const child = spawn(
        process.env.POS_TEST_PYTHON ?? 'python3',
        [fileURLToPath(new URL('sale_ui.py', import.meta.url)), file],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.stdout.on('data', (d) => process.stdout.write(d));
      child.stderr.on('data', (d) => process.stderr.write(d));
      child.on('error', reject);
      child.on('exit', resolve);
    });
    assert.equal(exit, 0, 'Browser scenarios must pass');
    const [cash, aggregator, meal] = edge.state.posts;
    assert.deepEqual(cash.tenders, [{ method: 'cash', amount_minor: '349000' }]);
    assert.equal(cash.cash_tendered_minor, '500000');
    assert.equal(cash.service_mode_confirmed, true);
    assert.equal(cash.order_repeated, true);
    assert.deepEqual(aggregator.tenders, [
      { method: 'aggregator_yandex_eda', amount_minor: '359000' },
    ]);
    assert.equal(aggregator.external_order_ref, 'YA-123');
    assert.equal(meal.beneficiary, 'Айгерим');
    assert.equal(meal.approval.token, 'd'.repeat(64));
    assert.equal(edge.state.sales.size, 3);
    const recorded = [...edge.state.sales.values()][0].fiscal[0];
    assert.equal(recorded.receipt_number, 'TEST-WK-1');
    // POST orders only from today's cashier on the edge without pos/config (the 404 phase), and
    // not while the first pos/config read of a desk on an edge that sells was failing (R1).
    assert.deepEqual(
      edge.state.unpaid.map((u) => [u.mode, u.body.kitchen_admission]),
      [[null, 'unpaid']],
      'POST orders is never sent in the paid mode',
    );
    // Part B: refund of the cash order, void of the aggregator order, the refund receipt, the
    // close with the Kaspi terminal total and no pending receipts (so no close approval).
    const [first, second] = [...edge.state.sales.values()];
    const byPath = (end) => edge.state.ops.filter((o) => o.path.endsWith(end));
    assert.deepEqual(
      byPath('/refunds').map((o) => o.body.tenders),
      [[{ tender_id: first.tenders[0].tender_id, amount_minor: '349000' }]],
    );
    assert.equal(byPath('/refunds')[0].body.reason_code, 'quality');
    assert.equal(byPath('/void')[0].path, `pos/sales/${second.order_id}/void`);
    assert.equal(byPath('/void')[0].body.reason_code, 'aggregator_cancelled');
    assert.equal(byPath('/void')[0].body.fiscal_sale_issued, false);
    assert.deepEqual(
      byPath('/record').map((o) => o.body.receipt_number),
      ['TEST-WK-1', 'TEST-WK-2'],
    );
    assert.deepEqual(
      edge.state.approvals.map((a) => a.action),
      ['staff_meal', 'refund', 'void'],
      'one approval per action; none for closing without pending receipts',
    );
    assert.deepEqual(edge.state.approvals[1].subject, {
      order_id: first.order_id,
      amount_minor: '349000',
    });
    const close = byPath('/close');
    assert.equal(close.length, 1);
    assert.deepEqual(close[0].body, {
      expected_version: 1,
      counted_cash_minor: '2000000',
      reason: 'Закрытие смены',
      terminal_reported_minor: '0',
    });
    assert.equal(edge.state.closed.state, 'closed');
  } finally {
    await new Promise((r) => control.close(r));
    await new Promise((r) => pos.close(r));
    await new Promise((r) => edge.server.close(r));
    await rm(temp, { recursive: true, force: true });
  }
});
