import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PosController } from '../../apps/pos/dist/model.js';
import { ApiError, passwordTransport, transport } from '../../apps/pos/dist/api.js';
import { order as parseOrder } from '../../apps/pos/dist/types.js';

const memory = () => {
  const data = new Map();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
};
function fixture() {
  const time = () => new Date().toISOString();
  const actor = {
    session_id: randomUUID(),
    staff_id: randomUUID(),
    terminal_id: randomUUID(),
    branch_id: randomUUID(),
    role: 'cashier',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  };
  const credential = { ...actor, token: 'd'.repeat(64) };
  const item = {
    product_id: randomUUID(),
    variant_id: randomUUID(),
    category_id: randomUUID(),
    name: { ru: 'Synthetic item', kk: '-' },
    price_minor: '150000',
    currency: 'KZT',
  };
  const menu = {
    schema_version: 1,
    release_id: randomUUID(),
    branch_id: actor.branch_id,
    version: 1,
    published_at: time(),
    items: [item],
  };
  const quote = {
    quote_id: randomUUID(),
    branch_id: actor.branch_id,
    release_id: menu.release_id,
    menu_version: 1,
    service_mode: 'takeaway',
    channel: 'pos',
    lines: [
      {
        product_id: item.product_id,
        variant_id: item.variant_id,
        name: item.name,
        quantity: 1,
        unit_price_minor: item.price_minor,
        total_minor: item.price_minor,
      },
    ],
    currency: 'KZT',
    subtotal_minor: item.price_minor,
    discount_minor: '0',
    total_minor: item.price_minor,
    created_at: time(),
    expires_at: new Date(Date.now() + 120000).toISOString(),
  };
  const shift = {
    shift_id: randomUUID(),
    branch_id: actor.branch_id,
    terminal_id: actor.terminal_id,
    staff_id: actor.staff_id,
    version: 1,
    state: 'open',
    opened_at: time(),
    closed_at: null,
    closed_by_staff_id: null,
    opening_cash_minor: '0',
    expected_cash_minor: '0',
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
    payment_processing_available: false,
    report_at: time(),
  };
  const order = {
    order_id: randomUUID(),
    branch_id: actor.branch_id,
    quote_id: quote.quote_id,
    cash_shift_id: shift.shift_id,
    version: 1,
    state: 'awaiting_payment',
    payment_state: 'not_started',
    fiscal_state: 'not_requested',
    fulfillment_state: 'accepted',
    next_action: 'none',
    execution_mode: 'unpaid_service',
    fulfillment: { version: 1, display_number: '19', state: 'accepted' },
    snapshot: quote,
    created_at: time(),
    cancellation_reason: null,
  };
  let current = null;
  const requests = [];
  const api = async (path, auth, options = {}) => {
    assert.equal(auth.token, credential.token);
    requests.push({ path, ...globalThis.structuredClone(options) });
    if (path === 'session') return actor;
    if (path === 'menu') return menu;
    if (path === 'ordering')
      return {
        branch_id: actor.branch_id,
        ordering_enabled: true,
        version: 1,
        pos_service_mode: 'unpaid_service',
      };
    if (path.startsWith('availability/stops/'))
      return { variant_id: item.variant_id, stopped: false, version: 0 };
    if (path === 'cash-shifts/current') return { shift, server_time: time() };
    if (path === 'cash-shifts') return { shifts: [shift], server_time: time() };
    if (path === 'orders' && options.method !== 'POST')
      return { orders: current ? [current] : [], server_time: time() };
    if (path === `orders/${order.order_id}`) return current;
    if (path === 'checkout/quotes') return quote;
    if (path === 'staff/logout') throw new ApiError('EDGE_UNREACHABLE');
    throw new Error('Unexpected synthetic API path');
  };
  return {
    actor,
    credential,
    item,
    quote,
    shift,
    order,
    api,
    requests,
    setCurrent: (o) => {
      current = o;
    },
  };
}

test('password login binds the configured terminal and never saves password in state, session or journal', async () => {
  const f = fixture(),
    sessions = memory(),
    storage = memory(),
    password = ` Synthetic-${randomUUID()} `;
  let calls = 0;
  const auth = async (input) => {
    calls++;
    assert.deepEqual(input, { login: 'cashier', password, terminal_id: f.actor.terminal_id });
    return f.credential;
  };
  const model = new PosController(f.api, sessions, storage, randomUUID, undefined, auth);
  await model.signIn(' Cashier ', password, undefined);
  assert.equal(calls, 0);
  assert.equal(model.state.error.message, 'TERMINAL_NOT_CONFIGURED');
  await model.signIn(' Cashier ', password, f.actor.terminal_id);
  assert.equal(calls, 1);
  assert.equal(model.state.actor.staff_id, f.actor.staff_id);
  assert.equal(
    f.requests[0].path,
    'session',
    'credential goes through the same server-verified journal scope',
  );
  assert(
    !JSON.stringify([model.state, ...sessions.data.values(), ...storage.data.values()]).includes(
      password,
    ),
  );
  assert(!JSON.stringify([...storage.data.values()]).includes(f.credential.token));
  const saved = [...storage.data];
  model.logout();
  assert.equal(model.state.actor, null);
  assert.equal(
    sessions.data.size,
    0,
    'local logout completes when server revocation is unreachable',
  );
  assert.deepEqual([...storage.data], saved, 'logout preserves the recovery journal');
});

test('rate limited sign-in prevents repeated calls until retry time and rejects a credential for another terminal', async () => {
  const f = fixture();
  let calls = 0;
  const auth = async () => {
    calls++;
    if (calls === 1) throw new ApiError('AUTH_RATE_LIMITED', 429, 60);
    return { ...f.credential, terminal_id: randomUUID() };
  };
  const model = new PosController(f.api, memory(), memory(), randomUUID, undefined, auth);
  await model.signIn('cashier', 'Synthetic-password', f.actor.terminal_id);
  assert(model.retryLoginAt > Date.now());
  await model.signIn('other', 'Synthetic-password', f.actor.terminal_id);
  assert.equal(calls, 1);
  model.retryLoginAt = Date.now() - 1;
  await model.signIn('cashier', 'Synthetic-password', f.actor.terminal_id);
  assert.equal(calls, 2);
  assert.equal(model.state.actor, null);
  assert.equal(model.state.error.message, 'WRONG_BRANCH');
  assert.equal(f.requests.length, 0);
});

test('unpaid kitchen admission persists exact payload before POST; reload replays then reads current kitchen state', async () => {
  const f = fixture(),
    sessions = memory(),
    storage = memory(),
    requests = [];
  const api = async (path, actor, options = {}) => {
    if (path === 'orders' && options.method === 'POST') {
      const pending = JSON.parse([...storage.data.values()][0]).pending;
      assert.deepEqual(pending.body, { quote_id: f.quote.quote_id, kitchen_admission: 'unpaid' });
      assert.equal(pending.key, options.key);
      requests.push(globalThis.structuredClone(options));
      if (requests.length === 1) {
        f.setCurrent(f.order);
        throw new ApiError('EDGE_UNREACHABLE');
      }
      return f.order;
    }
    return f.api(path, actor, options);
  };
  const model = new PosController(api, sessions, storage, randomUUID);
  await model.login(JSON.stringify(f.credential));
  model.quantity(f.item.variant_id, 1);
  await model.calculate();
  await model.create(true);
  assert.equal(model.state.pending.kind, 'create');
  const ready = {
    ...f.order,
    fulfillment_state: 'ready',
    fulfillment: { ...f.order.fulfillment, version: 3, state: 'ready' },
  };
  f.setCurrent(ready);
  const restored = new PosController(api, sessions, storage, randomUUID);
  await restored.boot();
  assert.equal(requests.length, 1);
  await restored.recover();
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(restored.state.pending, null);
  assert.equal(restored.state.order.fulfillment.state, 'ready');
  assert.equal(restored.state.order.payment_state, 'not_started');
  assert.equal(restored.state.order.fiscal_state, 'not_requested');
  f.setCurrent({
    ...ready,
    fulfillment_state: 'handed_over',
    fulfillment: { ...ready.fulfillment, version: 4, state: 'handed_over' },
  });
  await restored.refreshOperations();
  assert.equal(
    restored.state.order.fulfillment.state,
    'handed_over',
    'selected order receives live kitchen progress',
  );
});

for (const code of ['SERVICE_MODE_DISABLED', 'KITCHEN_UNAVAILABLE']) {
  test(`definitive admission rejection ${code} resolves pending without pretending kitchen accepted`, async () => {
    const f = fixture();
    let posts = 0;
    const api = async (path, actor, options = {}) => {
      if (path === 'orders' && options.method === 'POST') {
        posts++;
        throw new ApiError(code, 409);
      }
      return f.api(path, actor, options);
    };
    const model = new PosController(api, memory(), memory(), randomUUID);
    await model.login(JSON.stringify(f.credential));
    model.quantity(f.item.variant_id, 1);
    await model.calculate();
    await model.create(true);
    assert.equal(posts, 1);
    assert.equal(model.state.pending, null);
    assert.equal(model.state.order, null);
    assert.equal(model.state.quote, null);
    assert.equal(model.state.error.code, code);
  });
}

test('production-start cancellation rejection clears only confirmed409 and refreshes live state', async () => {
  const f = fixture();
  f.setCurrent(f.order);
  let attempts = 0;
  const started = {
    ...f.order,
    fulfillment_state: 'in_production',
    fulfillment: { ...f.order.fulfillment, version: 2, state: 'in_production' },
  };
  const api = async (path, actor, options = {}) => {
    if (path.endsWith('/cancel')) {
      attempts++;
      f.setCurrent(started);
      throw new ApiError('ORDER_IN_PRODUCTION', attempts === 1 ? 500 : 409);
    }
    return f.api(path, actor, options);
  };
  const model = new PosController(api, memory(), memory(), randomUUID);
  await model.login(JSON.stringify(f.credential));
  await model.openOrder(f.order.order_id);
  await model.cancel('Synthetic cancellation');
  assert.equal(
    model.state.pending.kind,
    'cancel',
    '500 is uncertain even with a familiar error code',
  );
  const pending = globalThis.structuredClone(model.state.pending);
  await model.recover();
  assert.equal(attempts, 2);
  assert.equal(model.state.pending, null);
  assert.equal(model.state.order.fulfillment.state, 'in_production');
  assert.equal(model.state.error.code, 'ORDER_IN_PRODUCTION');
  assert.equal(pending.body.expected_version, f.order.version);
});

test('uncertain admission500 remains pending and replay keeps the exact key and body', async () => {
  const f = fixture(),
    attempts = [];
  const api = async (path, actor, options = {}) => {
    if (path === 'orders' && options.method === 'POST') {
      attempts.push(globalThis.structuredClone(options));
      throw new ApiError('KITCHEN_UNAVAILABLE', 500);
    }
    return f.api(path, actor, options);
  };
  const model = new PosController(api, memory(), memory(), randomUUID);
  await model.login(JSON.stringify(f.credential));
  model.quantity(f.item.variant_id, 1);
  await model.calculate();
  await model.create(true);
  assert.equal(model.state.pending.kind, 'create');
  await model.recover();
  assert.equal(model.state.pending.kind, 'create');
  assert.deepEqual(attempts[0], attempts[1]);
});

test('live kitchen parser rejects inconsistent state, number and fabricated payment', () => {
  const f = fixture();
  assert.equal(parseOrder(f.order).fulfillment.display_number, '19');
  for (const changed of [
    { fulfillment_state: 'ready' },
    { fulfillment: { ...f.order.fulfillment, display_number: '0' } },
    { payment_state: 'paid' },
    { execution_mode: undefined },
  ])
    assert.throws(() => parseOrder({ ...f.order, ...changed }));
});

test('password HTTP request is same-origin only, generic on 401, observes Retry-After and handles logout204', async () => {
  const previous = globalThis.fetch;
  const input = { login: 'cashier', password: 'Synthetic-password', terminal_id: randomUUID() };
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/edge/v1/staff/login');
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers.Authorization, undefined);
      assert.deepEqual(JSON.parse(options.body), input);
      return new Response(JSON.stringify({ private_reason: 'never displayed' }), { status: 401 });
    };
    await assert.rejects(
      passwordTransport(input),
      (error) => error.code === 'INVALID_LOGIN' && !error.message.includes('private_reason'),
    );
    globalThis.fetch = async () =>
      new Response('', { status: 429, headers: { 'Retry-After': '60' } });
    await assert.rejects(
      passwordTransport(input),
      (error) => error.code === 'AUTH_RATE_LIMITED' && error.retryAfterSeconds === 60,
    );
    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert.equal(await transport('staff/logout', fixture().credential, { method: 'POST' }), null);
  } finally {
    globalThis.fetch = previous;
  }
});
