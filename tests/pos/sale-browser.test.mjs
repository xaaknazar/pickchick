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
    unpaid: [],
    number: 26,
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
  const route = (method, path, body, headers) => {
    if (path === '/health/ready') return [200, { ready: true }];
    if (path === '/edge/v1/staff/pin')
      return body.pin === '1357' ? [200, cashier] : [401, { code: 'UNAUTHORIZED' }];
    if (headers.authorization !== `Bearer ${cashier.token}`) return [401, { code: 'UNAUTHORIZED' }];
    const p = path.replace('/edge/v1/', '');
    const now = new Date().toISOString();
    if (method === 'GET') {
      if (p === 'session') {
        const { token: _token, ...actor } = cashier;
        void _token;
        return [200, actor];
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
      if (p === 'cash-shifts/current') return [200, { shift, server_time: now }];
      if (p === 'cash-shifts') return [200, { shifts: [shift], server_time: now }];
      if (p === 'orders') return [200, { orders: [...state.orders.values()], server_time: now }];
      if (p.startsWith('orders/')) {
        const o = state.orders.get(p.split('/')[1]);
        return o ? [200, o] : [404, { code: 'NOT_FOUND' }];
      }
      if (p === 'pos/config')
        return state.config
          ? [200, { ...state.config, server_time: now }]
          : [404, { code: 'NOT_FOUND' }];
      if (p.startsWith('pos/sales/')) {
        const s = state.sales.get(p.split('/')[2]);
        return s ? [200, s] : [404, { code: 'NOT_FOUND' }];
      }
      return [404, { code: 'NOT_FOUND' }];
    }
    if (p === 'staff/logout') return [204, null];
    if (p === 'checkout/quotes') return [200, quote(body)];
    if (p === 'orders') {
      state.unpaid.push(body);
      return [409, { code: 'SERVICE_MODE_DISABLED' }];
    }
    if (p === 'pos/sales') {
      state.posts.push(body);
      const key = headers['idempotency-key'];
      if (state.commands.has(key)) return state.commands.get(key);
      const result = sell(body);
      state.commands.set(key, result);
      return result;
    }
    if (p === 'staff/approvals') {
      if (body.pin !== '2468' || body.staff_id !== cashier.staff_id)
        return [401, { code: 'UNAUTHORIZED' }];
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
  });
  await new Promise((r) => pos.listen(0, '127.0.0.1', r));
  const output = new URL('../../.local/pos-sale-browser/', import.meta.url);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(fileURLToPath(new URL('run-', output)));
  const control = createServer((req, res) => {
    // The browser script switches the synthetic edge to an edge without pos/config.
    if (req.url === '/legacy') edge.state.config = null;
    res.end('{}');
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
    assert.equal(edge.state.unpaid.length, 0, 'POST orders is never sent in the paid mode');
  } finally {
    await new Promise((r) => control.close(r));
    await new Promise((r) => pos.close(r));
    await new Promise((r) => edge.server.close(r));
    await rm(temp, { recursive: true, force: true });
  }
});
