import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  POS_CONFIG_MISSING_MS,
  POS_CONFIG_POLL_MS,
  PosController,
  mixableMethods,
} from '../../apps/pos/dist/model.js';
import { ApiError, errorMessage, saleErrorMessage } from '../../apps/pos/dist/api.js';
import { SaleView } from '../../apps/pos/dist/v2/sale-view.js';
import {
  cashShift as parseShift,
  inputMoney,
  lineKey,
  linePrice,
  menu as parseMenu,
  order as parseOrder,
  pickupText,
  posConfig as parsePosConfig,
  posSale as parseSale,
} from '../../apps/pos/dist/types.js';

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
  const actor = {
    session_id: randomUUID(),
    staff_id: randomUUID(),
    terminal_id: randomUUID(),
    branch_id: randomUUID(),
    role: 'cashier',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  };
  const credential = { ...actor, token: 'b'.repeat(64) };
  const group = randomUUID(),
    option = randomUUID(),
    extra = randomUUID();
  const item = {
    product_id: randomUUID(),
    variant_id: randomUUID(),
    category_id: randomUUID(),
    name: { ru: 'Комбо на двоих', kk: '-' },
    price_minor: '699000',
    currency: 'KZT',
    image_url: '/assets/menu/i7.jpg',
    modifier_groups: [
      {
        id: group,
        name: { ru: 'Напитки', kk: '-' },
        min_selected: 2,
        max_selected: 2,
        options: [
          {
            id: option,
            name: { ru: 'Кола', kk: '-' },
            price_minor: '10000',
            max_quantity: 2,
            default_quantity: 2,
            available: true,
          },
          {
            id: extra,
            name: { ru: 'Чай', kk: '-' },
            price_minor: '0',
            max_quantity: 2,
            default_quantity: 0,
            available: true,
          },
        ],
      },
    ],
  };
  const menu = {
    schema_version: 1,
    release_id: randomUUID(),
    branch_id: actor.branch_id,
    version: 2,
    published_at: new Date().toISOString(),
    items: [item],
  };
  const shift = {
    shift_id: randomUUID(),
    branch_id: actor.branch_id,
    terminal_id: actor.terminal_id,
    staff_id: actor.staff_id,
    version: 1,
    state: 'open',
    opened_at: new Date().toISOString(),
    closed_at: null,
    closed_by_staff_id: null,
    opening_cash_minor: '500000',
    expected_cash_minor: '500000',
    counted_cash_minor: null,
    discrepancy_minor: null,
    closing_reason: null,
    currency: 'KZT',
    order_count: 137,
    awaiting_payment_count: 130,
    cancelled_count: 7,
    order_total_minor: '98000000',
    unpaid_total_minor: '97000000',
    cash_received_minor: '0',
    cash_refunded_minor: '0',
    payment_processing_available: false,
    report_at: new Date().toISOString(),
  };
  let current = shift;
  const calls = [];
  const api = async (path, auth, options = {}) => {
    assert.equal(auth.token, credential.token);
    calls.push({ path, ...globalThis.structuredClone(options) });
    if (path === 'session') return actor;
    if (path === 'menu') return menu;
    if (path === 'ordering')
      return { branch_id: actor.branch_id, ordering_enabled: true, version: 1 };
    if (path.startsWith('availability/stops/'))
      return { variant_id: item.variant_id, stopped: false, version: 0 };
    if (path === 'checkout/quotes')
      return {
        quote_id: randomUUID(),
        branch_id: actor.branch_id,
        release_id: menu.release_id,
        menu_version: menu.version,
        service_mode: options.body.service_mode,
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
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 120000).toISOString(),
      };
    if (path === 'cash-shifts/current')
      return { shift: current, server_time: new Date().toISOString() };
    if (path === 'cash-shifts' && options.method !== 'POST')
      return { shifts: current ? [current] : [], server_time: new Date().toISOString() };
    if (path === 'orders') return { orders: [], server_time: new Date().toISOString() };
    if (path === `cash-shifts/${shift.shift_id}`) return current;
    throw new Error('Unexpected synthetic transport path');
  };
  return {
    actor,
    credential,
    item,
    menu,
    group,
    option,
    extra,
    shift,
    api,
    calls,
    setCurrent: (s) => {
      current = s;
    },
  };
}

test('modifier quantities affect identity and price; distinct compositions survive journal reload', async () => {
  const f = fixture(),
    sessions = memory(),
    storage = memory();
  const model = new PosController(f.api, sessions, storage, randomUUID);
  await model.login(JSON.stringify(f.credential));
  model.configure(f.item.variant_id, [{ group_id: f.group, option_id: f.option, quantity: 2 }], 1);
  model.configure(
    f.item.variant_id,
    [
      { group_id: f.group, option_id: f.option, quantity: 1 },
      { group_id: f.group, option_id: f.extra, quantity: 1 },
    ],
    2,
  );
  assert.equal(model.state.draft.items.length, 2);
  assert.equal(linePrice(f.item, model.state.draft.items[0].modifiers), 719000n);
  assert.equal(linePrice(f.item, model.state.draft.items[1].modifiers), 709000n);
  assert.notEqual(lineKey(model.state.draft.items[0]), lineKey(model.state.draft.items[1]));
  model.quantity(lineKey(model.state.draft.items[0]), 3);
  const reloaded = new PosController(f.api, sessions, storage, randomUUID);
  await reloaded.boot();
  assert.deepEqual(reloaded.state.draft, model.state.draft);
  assert.ok(!JSON.stringify([...storage.data.values()]).includes(f.credential.token));
  const before = globalThis.structuredClone(model.state.draft);
  model.configure(f.item.variant_id, [{ group_id: f.group, option_id: f.option, quantity: 1 }], 1);
  assert.equal(model.state.error.message, 'INVALID_MODIFIERS');
  assert.deepEqual(model.state.draft, before);
  assert.equal(
    lineKey({
      variant_id: f.item.variant_id,
      modifiers: [{ group_id: f.group, option_id: f.option }],
    }),
    lineKey({
      variant_id: f.item.variant_id,
      modifiers: [{ group_id: f.group, option_id: f.option, quantity: 1 }],
    }),
  );
});

test('shift open unknown result persists exact key/body; restart retries once and reads current report', async () => {
  const f = fixture(),
    sessions = memory(),
    storage = memory();
  f.setCurrent(null);
  let posted = 0,
    first;
  const api = async (path, credential, options = {}) => {
    if (path === 'cash-shifts' && options.method === 'POST') {
      const stored = JSON.parse([...storage.data.values()][0]);
      assert.equal(stored.pending.kind, 'shift_open');
      assert.equal(stored.pending.key, options.key);
      assert.deepEqual(stored.pending.body, { opening_cash_minor: '500000' });
      posted++;
      if (posted === 1) {
        first = globalThis.structuredClone(options);
        f.setCurrent(f.shift);
        throw new ApiError('EDGE_UNREACHABLE');
      }
      assert.deepEqual(options, first);
      return f.shift;
    }
    return f.api(path, credential, options);
  };
  const model = new PosController(api, sessions, storage, randomUUID);
  await model.login(JSON.stringify(f.credential));
  await model.openShift('500000');
  assert.equal(model.state.pending.kind, 'shift_open');
  const restored = new PosController(api, sessions, storage, randomUUID);
  await restored.boot();
  assert.equal(posted, 1, 'boot must never resubmit an unknown command automatically');
  await restored.recover();
  assert.equal(posted, 2);
  assert.equal(restored.state.pending, null);
  assert.equal(
    restored.state.shift.order_count,
    137,
    'counter comes from authoritative shift report, not the 0-item feed',
  );
});

test('shift close flushes counted cash and reason before POST and failed write blocks dispatch', async () => {
  const f = fixture(),
    storage = memory(),
    sessions = memory();
  let closes = 0,
    posts = 0;
  const api = async (path, credential, options = {}) => {
    if (options.method === 'POST') posts++;
    if (path.endsWith('/close')) {
      closes++;
      const saved = JSON.parse([...storage.data.values()][0]).pending;
      assert.equal(saved.kind, 'shift_close');
      assert.deepEqual(saved.body, {
        expected_version: 1,
        counted_cash_minor: '490000',
        reason: 'Пересчёт наличных',
      });
      assert.equal(saved.key, options.key);
      throw new ApiError('EDGE_UNREACHABLE');
    }
    return f.api(path, credential, options);
  };
  const model = new PosController(api, sessions, storage, randomUUID);
  await model.login(JSON.stringify(f.credential));
  await model.closeShift(f.shift.shift_id, '490000', ' Пересчёт наличных ');
  assert.equal(closes, 1);
  assert.equal(model.state.pending.kind, 'shift_close');
  const blocked = new PosController(
    api,
    memory(),
    {
      ...memory(),
      setItem() {
        throw new Error('disk full');
      },
    },
    randomUUID,
  );
  await blocked.login(JSON.stringify(f.credential));
  await blocked.openShift('0');
  assert.equal(posts, 1, 'failed journal write must block every POST');
  assert.equal(blocked.state.storageBlocked, true);
});

test('display parser rejects external images and cash inputs never round through float', () => {
  const f = fixture();
  assert.equal(parseMenu(f.menu).items[0].image_url, '/assets/menu/i7.jpg');
  assert.throws(() =>
    parseMenu({ ...f.menu, items: [{ ...f.item, image_url: 'https://example.com/image.jpg' }] }),
  );
  assert.throws(() =>
    parseMenu({ ...f.menu, items: [{ ...f.item, image_url: '/assets/menu/../secret.jpg' }] }),
  );
  assert.equal(inputMoney('5000,09'), '500009');
  assert.equal(inputMoney('90071992547409.91'), '9007199254740991');
  for (const input of ['-1', '1e4', '0.001', 'NaN', '', '1,2,3'])
    assert.throws(() => inputMoney(input));
});

test('late operations reads cannot overwrite a newer authoritative shift count', async () => {
  const f = fixture();
  let hold = false,
    resume,
    markHeld;
  const held = new Promise((resolve) => {
    markHeld = resolve;
  });
  const api = async (...args) => {
    const value = await f.api(...args);
    if (hold && args[0] === 'cash-shifts/current') {
      hold = false;
      markHeld();
      await new Promise((resolve) => {
        resume = resolve;
      });
    }
    return value;
  };
  const model = new PosController(api, memory(), memory(), randomUUID);
  await model.login(JSON.stringify(f.credential));
  hold = true;
  const staleRead = model.refreshOperations();
  await held;
  f.setCurrent({ ...f.shift, order_count: 138, awaiting_payment_count: 131 });
  await model.refreshOperations();
  resume();
  await staleRead;
  assert.equal(model.state.shift.order_count, 138);
});

test('oversized modifier drafts leave the last recoverable journal intact', async () => {
  const f = fixture(),
    sessions = memory(),
    storage = memory();
  f.item.modifier_groups = Array.from({ length: 5 }, () => ({
    id: randomUUID(),
    name: { ru: 'Добавки', kk: '-' },
    min_selected: 0,
    max_selected: 99,
    options: Array.from({ length: 20 }, () => ({
      id: randomUUID(),
      name: { ru: 'Вариант', kk: '-' },
      price_minor: '0',
      max_quantity: 99,
    })),
  }));
  const selected = f.item.modifier_groups.flatMap((g) =>
    g.options.map((o) => ({ group_id: g.id, option_id: o.id, quantity: 1 })),
  );
  const model = new PosController(f.api, sessions, storage, randomUUID);
  await model.login(JSON.stringify(f.credential));
  for (let quantity = 1; quantity <= 40; quantity++) {
    model.configure(f.item.variant_id, [{ ...selected[0], quantity }, ...selected.slice(1)], 1);
    if (model.state.error) break;
  }
  assert.equal(model.state.error.message, 'LIMIT');
  assert.equal(model.state.storageBlocked, false);
  assert(model.state.draft.items.length > 1 && model.state.draft.items.length < 40);
  const restored = new PosController(f.api, sessions, storage, randomUUID);
  await restored.boot();
  assert.equal(restored.state.error, null);
  assert.deepEqual(restored.state.draft, model.state.draft);
});

for (const state of ['never_confirmed', 'last_read_failed', 'closed']) {
  test(`valid quote cannot create an order when shift is ${state}`, async () => {
    const f = fixture();
    f.item.modifier_groups = [];
    if (state === 'closed') f.setCurrent(null);
    let readFails = state === 'never_confirmed',
      posts = 0;
    const api = async (path, actor, options = {}) => {
      if (path === 'cash-shifts/current' && readFails) throw new ApiError('EDGE_UNREACHABLE');
      if (path === 'orders' && options.method === 'POST') {
        posts++;
        throw new ApiError('EDGE_UNREACHABLE');
      }
      return f.api(path, actor, options);
    };
    const model = new PosController(api, memory(), memory(), randomUUID);
    await model.login(JSON.stringify(f.credential));
    model.quantity(f.item.variant_id, 1);
    await model.calculate();
    assert(model.state.quote);
    if (state === 'last_read_failed') {
      assert(model.hasConfirmedOpenShift);
      readFails = true;
      await model.refreshOperations();
    }
    assert.equal(model.hasConfirmedOpenShift, false);
    await model.create();
    assert.equal(posts, 0);
    assert.equal(model.state.pending, null);
    assert.equal(
      model.state.error.message,
      state === 'closed' ? 'CASH_SHIFT_REQUIRED' : 'CASH_SHIFT_STATUS_UNKNOWN',
    );
    readFails = false;
    f.setCurrent(f.shift);
    await model.refreshOperations();
    assert(model.hasConfirmedOpenShift);
    await model.create();
    assert.equal(posts, 1, 'confirmed own open shift permits dispatch');
    assert.equal(model.state.pending.kind, 'create');
  });
}

for (const kind of ['open', 'close']) {
  for (const refreshFails of [false, true]) {
    test(`definitive shift ${kind} conflict resolves journal and refreshes state, refresh fails=${refreshFails}`, async () => {
      const f = fixture(),
        storage = memory(),
        sessions = memory();
      if (kind === 'open') f.setCurrent(null);
      let posts = 0,
        readsAfterConflict = 0;
      const api = async (path, actor, options = {}) => {
        if (options.method === 'POST') {
          posts++;
          assert.equal(JSON.parse([...storage.data.values()][0]).pending.kind, `shift_${kind}`);
          f.setCurrent(kind === 'open' ? f.shift : null);
          throw new ApiError('CONFLICT', 409);
        }
        if (path === 'cash-shifts/current' && posts) {
          readsAfterConflict++;
          if (refreshFails) throw new ApiError('EDGE_UNREACHABLE');
        }
        return f.api(path, actor, options);
      };
      const model = new PosController(api, sessions, storage, randomUUID);
      await model.login(JSON.stringify(f.credential));
      if (kind === 'open') await model.openShift('500000');
      else await model.closeShift(f.shift.shift_id, '500000', 'Пересчёт');
      assert.equal(posts, 1);
      assert.equal(model.state.pending, null, 'HTTP 409 rejected this exact command');
      assert.equal(model.state.error.code, 'CONFLICT');
      assert.equal(readsAfterConflict, 1);
      assert.equal(model.hasConfirmedOpenShift, !refreshFails && kind === 'open');
      if (refreshFails) assert.equal(model.state.operationsAvailable, false);
      else
        assert.equal(
          model.state.shift?.shift_id ?? null,
          kind === 'open' ? f.shift.shift_id : null,
        );
      await model.recover();
      const restored = new PosController(api, sessions, storage, randomUUID);
      await restored.boot();
      assert.equal(restored.state.pending, null);
      assert.equal(posts, 1, 'rejected command must not retry forever');
    });
  }
}

for (const error of [
  new ApiError('EDGE_UNREACHABLE'),
  new ApiError('CONFLICT', 500),
  new ApiError('INVALID_RESPONSE', 200),
]) {
  test(`uncertain shift result ${error.code}/${error.status} retains exact replay command`, async () => {
    const f = fixture(),
      sessions = memory(),
      storage = memory(),
      requests = [];
    f.setCurrent(null);
    const api = async (path, actor, options = {}) => {
      if (options.method === 'POST') {
        requests.push(globalThis.structuredClone(options));
        throw error;
      }
      return f.api(path, actor, options);
    };
    const model = new PosController(api, sessions, storage, randomUUID);
    await model.login(JSON.stringify(f.credential));
    await model.openShift('500000');
    const pending = globalThis.structuredClone(model.state.pending);
    assert.equal(pending.kind, 'shift_open');
    const restored = new PosController(api, sessions, storage, randomUUID);
    await restored.boot();
    assert.equal(requests.length, 1);
    assert.deepEqual(restored.state.pending, pending);
    await restored.recover();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], requests[0]);
    assert.deepEqual(restored.state.pending, pending);
  });
}

// ---- Cutover 19.11: paid sales on the cashier (contracts section 5.1, section 00) -----------
// The edge side is built by the pos lane in parallel; this synthetic edge follows section 5.1.

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
const MANAGER_PIN = '2468';
const posConfigFor = (overrides = {}) => ({
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
  server_time: new Date().toISOString(),
  ...overrides,
});
const confirmationOf = (method) =>
  method === 'cash'
    ? 'drawer'
    : method.startsWith('aggregator_') || method === 'chocofood'
      ? 'aggregator_attested'
      : method === 'staff_meal' || method === 'marketing'
        ? 'manager_approved'
        : 'cashier_attested';
/**
 * Synthetic paid-mode edge: GET pos/config, quotes with sales_channel and channel prices,
 * POST pos/sales through an idempotent command store, approvals and Webkassa numbers.
 */
function saleEdge({
  config = posConfigFor(),
  price = '699000',
  channelPrice = '750000',
  quoteTtlMs = 120000,
} = {}) {
  const f = fixture();
  f.item.modifier_groups = [];
  f.item.price_minor = price;
  const state = {
    config,
    price,
    quotes: new Map(),
    orders: new Map(),
    sales: new Map(),
    commands: new Map(),
    approvals: new Map(),
    number: 26,
    posts: [],
    reject: null,
    loseNextSale: false,
    quoteError: null,
    echoChannel: true,
  };
  const quoteFor = (body) => {
    const unit = body.sales_channel ? channelPrice : state.price;
    const quote = {
      quote_id: randomUUID(),
      branch_id: f.actor.branch_id,
      release_id: f.menu.release_id,
      menu_version: f.menu.version,
      service_mode: body.service_mode,
      ...(body.sales_channel && state.echoChannel ? { sales_channel: body.sales_channel } : {}),
      channel: 'pos',
      lines: [
        {
          product_id: f.item.product_id,
          variant_id: f.item.variant_id,
          name: f.item.name,
          quantity: body.items[0].quantity,
          unit_price_minor: unit,
          total_minor: (BigInt(unit) * BigInt(body.items[0].quantity)).toString(),
        },
      ],
      currency: 'KZT',
      subtotal_minor: (BigInt(unit) * BigInt(body.items[0].quantity)).toString(),
      discount_minor: '0',
      total_minor: (BigInt(unit) * BigInt(body.items[0].quantity)).toString(),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + quoteTtlMs).toISOString(),
    };
    state.quotes.set(quote.quote_id, quote);
    return quote;
  };
  const sell = (body) => {
    const quote = state.quotes.get(body.quote_id);
    const order_id = randomUUID(),
      number = ++state.number,
      total = quote.total_minor,
      created_at = new Date().toISOString();
    const cash = body.tenders.find((t) => t.method === 'cash');
    const single = body.tenders.length === 1 ? body.tenders[0].method : null;
    const order = {
      cash_shift_id: f.shift.shift_id,
      order_id,
      branch_id: f.actor.branch_id,
      quote_id: quote.quote_id,
      version: 1,
      state: 'paid',
      payment_state: 'captured',
      fiscal_state: 'not_requested',
      fulfillment_state: 'accepted',
      execution_mode: 'pos_sale',
      fulfillment: { version: 1, display_number: String(number), state: 'accepted' },
      next_action: 'none',
      snapshot: quote,
      created_at,
      cancellation_reason: null,
    };
    const fiscalPolicy = state.config.methods.find((m) => m.code === body.tenders[0].method);
    const sale = {
      order_id,
      display_number: number,
      pickup: quote.sales_channel ? 'delivery_handover' : 'issue',
      sales_channel: quote.sales_channel ?? 'hall',
      external_order_ref: body.external_order_ref ?? null,
      service_mode: quote.service_mode,
      revenue_kind: single === 'staff_meal' || single === 'marketing' ? single : 'revenue',
      total_minor: total,
      cash_tendered_minor: cash ? body.cash_tendered_minor : null,
      change_minor: cash
        ? (BigInt(body.cash_tendered_minor) - BigInt(cash.amount_minor)).toString()
        : null,
      tenders: body.tenders.map((t) => ({
        tender_id: randomUUID(),
        method: t.method,
        amount_minor: t.amount_minor,
        confirmation: confirmationOf(t.method),
        reference: t.reference ?? null,
      })),
      refunds: [],
      refundable_minor: total,
      fiscal: [
        {
          receipt_id: randomUUID(),
          kind: 'sale',
          state: fiscalPolicy.fiscal_policy === 'manual_webkassa' ? 'pending' : 'not_required',
          receipt_number: null,
          version: 1,
          amount_minor: total,
        },
      ],
      shift_id: f.shift.shift_id,
      terminal_id: f.actor.terminal_id,
      cashier_staff_id: f.actor.staff_id,
      created_at,
    };
    state.orders.set(order_id, order);
    state.sales.set(order_id, sale);
    return { order, sale };
  };
  const api = async (path, auth, options = {}) => {
    f.calls.push({ path, ...globalThis.structuredClone(options) });
    if (path === 'pos/config') {
      if (state.config instanceof Error) throw state.config;
      return state.config;
    }
    if (path === 'checkout/quotes') {
      if (state.quoteError) throw state.quoteError;
      return quoteFor(options.body);
    }
    if (path === 'pos/sales' && options.method === 'POST') {
      state.posts.push(globalThis.structuredClone(options));
      const saved = state.commands.get(options.key);
      if (saved) {
        assert.equal(saved.body, JSON.stringify(options.body), 'same key, same body');
        return saved.result;
      }
      if (state.reject) throw state.reject;
      const result = sell(options.body);
      state.commands.set(options.key, { body: JSON.stringify(options.body), result });
      if (state.loseNextSale) {
        state.loseNextSale = false;
        throw new ApiError('EDGE_UNREACHABLE');
      }
      return result;
    }
    if (/^pos\/sales\/[0-9a-f-]+$/.test(path)) {
      const sale = state.sales.get(path.split('/')[2]);
      if (!sale) throw new ApiError('NOT_FOUND', 404);
      return sale;
    }
    if (/^orders\/[0-9a-f-]+$/.test(path)) {
      const order = state.orders.get(path.split('/')[1]);
      if (!order) throw new ApiError('NOT_FOUND', 404);
      return order;
    }
    if (path === 'staff/approvals') {
      assert.equal(options.method, 'POST');
      assert.ok(options.key, 'approvals are sent with an Idempotency-Key');
      if (options.body.pin === '0000') throw new ApiError('ROLE_NOT_ALLOWED', 403);
      if (options.body.pin !== MANAGER_PIN) throw new ApiError('UNAUTHORIZED', 401);
      const approval = {
        approval_id: randomUUID(),
        token: 'c'.repeat(64),
        expires_at: new Date(Date.now() + 120000).toISOString(),
        manager: { staff_id: randomUUID(), name: 'Тестовый начальник' },
      };
      state.approvals.set(approval.approval_id, options.body);
      return approval;
    }
    if (/^pos\/fiscal-receipts\/[0-9a-f-]+\/record$/.test(path)) {
      const id = path.split('/')[2];
      for (const sale of state.sales.values())
        for (const receipt of sale.fiscal)
          if (receipt.receipt_id === id) {
            assert.equal(options.body.expected_version, receipt.version);
            Object.assign(receipt, {
              state: 'recorded',
              receipt_number: options.body.receipt_number,
              version: receipt.version + 1,
            });
            return { ...receipt };
          }
      throw new ApiError('NOT_FOUND', 404);
    }
    return f.api(path, auth, options);
  };
  return { ...f, api, edge: state };
}
async function saleCashier(edge, storage = memory(), sessions = memory(), options = {}) {
  const model = new PosController(
    edge.api,
    sessions,
    storage,
    randomUUID,
    undefined,
    undefined,
    options.now,
  );
  await model.login(JSON.stringify(edge.credential));
  return model;
}
/** Cart of one item, service mode chosen, quoted and confirmed on the repeat screen. */
async function reviewed(model, edge, mode = 'dine_in') {
  model.quantity(edge.item.variant_id, 1);
  model.chooseServiceMode(mode);
  await model.calculate();
  assert.ok(model.state.quote, String(model.state.error));
  model.confirmReview();
  assert.equal(model.reviewed, true);
}
const posted = (edge) => edge.edge.posts.map((p) => p.body);

test('pos/config 404 or any refused read keeps today unpaid cashier with the same requests', async () => {
  const run = async (answer) => {
    const f = fixture();
    f.item.modifier_groups = [];
    const api = async (path, auth, options = {}) => {
      if (path === 'pos/config') {
        f.calls.push({ path, ...options });
        if (answer instanceof Error) throw answer;
        return answer;
      }
      if (path === 'orders' && options.method === 'POST') {
        f.calls.push({ path, ...globalThis.structuredClone(options) });
        throw new ApiError('EDGE_UNREACHABLE');
      }
      if (path === 'ordering')
        return { ...(await f.api(path, auth, options)), pos_service_mode: 'unpaid_service' };
      return f.api(path, auth, options);
    };
    const key = '11111111-1111-4111-8111-111111111111';
    const model = new PosController(api, memory(), memory(), () => key);
    await model.login(JSON.stringify(f.credential));
    model.quantity(f.item.variant_id, 1);
    await model.calculate();
    await model.create(true);
    assert.equal(model.saleMode, false);
    assert.equal(model.state.sale, null);
    assert.equal(model.state.pending.kind, 'create');
    const config = f.calls.filter((c) => c.path === 'pos/config');
    assert.deepEqual(config, [{ path: 'pos/config' }], 'one plain GET at login, nothing else');
    const quote = f.calls.find((c) => c.path === 'checkout/quotes');
    assert.deepEqual(Object.keys(quote.body), ['release_id', 'service_mode', 'items']);
    assert.deepEqual(f.calls.find((c) => c.path === 'orders' && c.method === 'POST').body, {
      quote_id: model.state.pending.body.quote_id,
      kitchen_admission: 'unpaid',
    });
    return {
      model,
      calls: f.calls
        .filter((c) => c.path !== 'pos/config')
        .map((c) => {
          const { body, path, ...rest } = c;
          // Ids differ between runs; their shape and every other byte must not.
          const ids = (text) => text.replace(/[0-9a-f-]{36}/g, 'id');
          return { ...rest, path: ids(path), body: body && ids(JSON.stringify(body)) };
        }),
    };
  };
  const missing = await run(new ApiError('NOT_FOUND', 404));
  assert.equal(missing.model.state.posConfigMissing, true);
  for (const other of [
    new ApiError('EDGE_UNREACHABLE'),
    new Error('Unexpected synthetic transport path'),
    { ...posConfigFor(), mode: 'unpaid_service' },
    { ...posConfigFor(), mode: 'payment_required' },
    { mode: 'pos_sale' },
  ]) {
    const result = await run(other);
    assert.equal(result.model.state.posConfigMissing, false);
    assert.deepEqual(result.calls, missing.calls, 'pos/config never changes another request');
  }
});

test('pos/config is polled with operations; a failed read keeps the mode, a 404 waits 10 min', async () => {
  const edge = saleEdge();
  let now = 1_000_000;
  const model = await saleCashier(edge, memory(), memory(), { now: () => now });
  assert.equal(model.saleMode, true);
  const reads = () => edge.calls.filter((c) => c.path === 'pos/config').length;
  assert.equal(reads(), 1);
  await model.refreshOperations();
  assert.equal(reads(), 1, 'not asked again inside the poll interval');
  now += POS_CONFIG_POLL_MS;
  edge.edge.config = new ApiError('EDGE_UNREACHABLE');
  await model.refreshOperations();
  assert.equal(reads(), 2);
  assert.equal(model.saleMode, true, 'a lost LAN answer never flips the screens');
  now += POS_CONFIG_POLL_MS;
  edge.edge.config = new ApiError('NOT_FOUND', 404);
  await model.refreshOperations();
  assert.equal(model.saleMode, false);
  assert.equal(model.state.posConfigMissing, true);
  now += POS_CONFIG_POLL_MS * 2;
  await model.refreshOperations();
  assert.equal(reads(), 3, 'an edge without the route is not asked every poll');
  now += POS_CONFIG_MISSING_MS;
  edge.edge.config = posConfigFor();
  await model.refreshOperations();
  assert.equal(reads(), 4);
  assert.equal(model.saleMode, true);
});

test('paid mode: no POST without "В зале / С собой" and the repeat screen; cash with change', async () => {
  const edge = saleEdge();
  const storage = memory();
  const model = await saleCashier(edge, storage);
  assert.equal(model.saleMode, true);
  model.quantity(edge.item.variant_id, 1);
  assert.equal(model.state.saleDraft.serviceModeChosen, false, 'never assumed');
  await model.calculate();
  await model.sell({ method: 'cash', tendered_minor: '1000000' });
  assert.equal(model.state.error.message, 'SERVICE_MODE_REQUIRED');
  model.chooseServiceMode('dine_in');
  await model.calculate();
  const quote = edge.calls.findLast((c) => c.path === 'checkout/quotes');
  assert.equal(quote.body.service_mode, 'dine_in');
  assert.equal('sales_channel' in quote.body, false, 'hall quotes are the plain cart');
  await model.sell({ method: 'cash', tendered_minor: '1000000' });
  assert.equal(model.state.error.message, 'ORDER_REVIEW_REQUIRED');
  await model.create(true);
  assert.equal(model.state.error.message, 'SERVICE_MODE_DISABLED', 'POST orders never in pos_sale');
  assert.equal(edge.edge.posts.length, 0);
  assert.equal(edge.calls.filter((c) => c.path === 'orders' && c.method === 'POST').length, 0);
  model.confirmReview();
  const quoteId = model.state.quote.quote_id;
  await model.sell({ method: 'cash', tendered_minor: '1000000' });
  assert.deepEqual(posted(edge), [
    {
      quote_id: quoteId,
      service_mode_confirmed: true,
      order_repeated: true,
      tenders: [{ method: 'cash', amount_minor: '699000' }],
      cash_tendered_minor: '1000000',
    },
  ]);
  assert.equal(model.state.pending, null);
  assert.equal(model.state.sale.display_number, '27');
  assert.equal(model.state.sale.change_minor, '301000');
  assert.equal(pickupText(model.state.sale), 'Забрать на выдаче');
  assert.equal(model.state.order.state, 'paid');
  assert.equal(JSON.parse([...storage.data.values()][0]).draft, null, 'the sold cart is gone');
  model.newDraft();
  assert.equal(model.state.sale, null);
  assert.equal(model.state.saleDraft.serviceModeChosen, false, 'next order asks again');
});

test('lost sale answer: journaled before POST, never resent on boot, recovered with its key', async () => {
  const edge = saleEdge(),
    storage = memory(),
    sessions = memory();
  const model = await saleCashier(edge, storage, sessions);
  await reviewed(model, edge, 'takeaway');
  edge.edge.loseNextSale = true;
  const journaled = [];
  const write = storage.setItem;
  storage.setItem = (k, v) => {
    journaled.push(JSON.parse(v).pending);
    write(k, v);
  };
  await model.sell({ method: 'kaspi_terminal' });
  assert.equal(edge.edge.posts.length, 1);
  assert.equal(journaled[0].kind, 'sale', 'the exact command is saved before it is sent');
  assert.equal(journaled[0].key, edge.edge.posts[0].key);
  assert.deepEqual(journaled[0].body, edge.edge.posts[0].body);
  assert.equal(model.state.pending.kind, 'sale');
  assert.equal(model.state.error.code, 'EDGE_UNREACHABLE');
  const restored = new PosController(edge.api, sessions, storage, randomUUID);
  await restored.boot();
  assert.equal(edge.edge.posts.length, 1, 'boot never resubmits an unknown sale');
  assert.equal(restored.state.pending.kind, 'sale');
  await restored.recover();
  assert.equal(edge.edge.posts.length, 2);
  assert.equal(edge.edge.posts[1].key, edge.edge.posts[0].key);
  assert.deepEqual(edge.edge.posts[1].body, edge.edge.posts[0].body);
  assert.equal(edge.edge.sales.size, 1, 'the guest paid once');
  assert.equal(restored.state.pending, null);
  assert.equal(restored.state.sale.tenders[0].method, 'kaspi_terminal');
  assert.equal(restored.state.sale.tenders[0].confirmation, 'cashier_attested');
});

test('cash below the total and fractional terminal amounts are refused before sending', async () => {
  const edge = saleEdge({ price: '699050' });
  const model = await saleCashier(edge);
  await reviewed(model, edge);
  await model.sell({ method: 'cash', tendered_minor: '600000' });
  assert.equal(model.state.error.message, 'CASH_TENDERED_TOO_LOW');
  await model.sell({ method: 'kaspi_terminal' });
  assert.equal(model.state.error.message, 'TERMINAL_AMOUNT_NOT_WHOLE');
  await model.sell({
    method: 'mixed',
    parts: [
      { method: 'cash', amount_minor: '200000' },
      { method: 'kaspi_terminal', amount_minor: '499050' },
    ],
  });
  assert.equal(model.state.error.message, 'TERMINAL_AMOUNT_NOT_WHOLE');
  assert.equal(edge.edge.posts.length, 0);
  // Kaspi manual needs no whole tenge (section 00): the fraction goes there.
  await model.sell({
    method: 'mixed',
    parts: [
      { method: 'kaspi_terminal', amount_minor: '500000' },
      { method: 'kaspi_manual', amount_minor: '199050', reference: ' TEST-OP-1 ' },
    ],
  });
  assert.equal(model.state.error, null);
  assert.deepEqual(posted(edge)[0].tenders, [
    { method: 'kaspi_terminal', amount_minor: '500000' },
    { method: 'kaspi_manual', amount_minor: '199050', reference: 'TEST-OP-1' },
  ]);
  assert.equal('cash_tendered_minor' in posted(edge)[0], false);
});

for (const [name, payment, expected] of [
  ['Kaspi terminal', { method: 'kaspi_terminal' }, { tenders: [['kaspi_terminal', '699000']] }],
  [
    'Kaspi manual without a number',
    { method: 'kaspi_manual', reference: '  ' },
    { tenders: [['kaspi_manual', '699000']] },
  ],
  [
    'Kaspi manual with an operation number',
    { method: 'kaspi_manual', reference: 'TEST-123' },
    { tenders: [['kaspi_manual', '699000', 'TEST-123']] },
  ],
  [
    'mixed cash and Kaspi terminal with change from cash',
    {
      method: 'mixed',
      parts: [
        { method: 'cash', amount_minor: '199000' },
        { method: 'kaspi_terminal', amount_minor: '500000' },
      ],
      tendered_minor: '200000',
    },
    {
      tenders: [
        ['cash', '199000'],
        ['kaspi_terminal', '500000'],
      ],
      cash_tendered_minor: '200000',
      change: '1000',
    },
  ],
  [
    'mixed cash and Kaspi manual, exact cash',
    {
      method: 'mixed',
      parts: [
        { method: 'kaspi_manual', amount_minor: '399000' },
        { method: 'cash', amount_minor: '300000' },
      ],
    },
    {
      tenders: [
        ['kaspi_manual', '399000'],
        ['cash', '300000'],
      ],
      cash_tendered_minor: '300000',
      change: '0',
    },
  ],
]) {
  test(`paid tenders: ${name}`, async () => {
    const edge = saleEdge();
    const model = await saleCashier(edge);
    await reviewed(model, edge);
    await model.sell(payment);
    assert.equal(model.state.error, null, String(model.state.error));
    const body = posted(edge)[0];
    assert.deepEqual(
      body.tenders,
      expected.tenders.map(([method, amount_minor, reference]) => ({
        method,
        amount_minor,
        ...(reference ? { reference } : {}),
      })),
    );
    assert.equal(body.cash_tendered_minor, expected.cash_tendered_minor);
    assert.equal(model.state.sale.change_minor, expected.change ?? null);
    assert.equal(
      model.state.sale.tenders.reduce((n, t) => n + BigInt(t.amount_minor), 0n),
      699000n,
    );
  });
}

test('mixed payment: exactly two parts of cash/Kaspi, at most one cash, sums must match', async () => {
  const config = posConfigFor();
  config.methods.find((m) => m.code === 'kaspi_manual').allow_in_mix = false;
  const edge = saleEdge({ config });
  const model = await saleCashier(edge);
  assert.deepEqual(mixableMethods(model.state.posConfig), ['cash', 'kaspi_terminal']);
  await reviewed(model, edge);
  for (const [parts, code] of [
    [
      [
        { method: 'cash', amount_minor: '300000' },
        { method: 'cash', amount_minor: '399000' },
      ],
      'MIX_INVALID',
    ],
    [[{ method: 'cash', amount_minor: '699000' }], 'MIX_INVALID'],
    [
      [
        { method: 'cash', amount_minor: '300000' },
        { method: 'kaspi_manual', amount_minor: '399000' },
      ],
      'MIX_INVALID',
    ],
    [
      [
        { method: 'cash', amount_minor: '300000' },
        { method: 'chocofood', amount_minor: '399000' },
      ],
      'MIX_INVALID',
    ],
    [
      [
        { method: 'cash', amount_minor: '300000' },
        { method: 'kaspi_terminal', amount_minor: '300000' },
      ],
      'TENDER_SUM_MISMATCH',
    ],
    [
      [
        { method: 'cash', amount_minor: '0' },
        { method: 'kaspi_terminal', amount_minor: '699000' },
      ],
      'TENDER_SUM_MISMATCH',
    ],
  ]) {
    await model.sell({ method: 'mixed', parts });
    assert.equal(model.state.error.message, code, JSON.stringify(parts));
  }
  await model.sell({
    method: 'mixed',
    parts: [
      { method: 'cash', amount_minor: '199000' },
      { method: 'kaspi_terminal', amount_minor: '500000' },
    ],
    tendered_minor: '100000',
  });
  assert.equal(model.state.error.message, 'CASH_TENDERED_TOO_LOW');
  assert.equal(edge.edge.posts.length, 0);
});

test('ChocoFood: its order number is required, hall prices and the chosen service mode', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  await reviewed(model, edge, 'dine_in');
  await model.sell({ method: 'chocofood', external_order_ref: ' ' });
  assert.equal(model.state.error.message, 'EXTERNAL_REF_REQUIRED');
  assert.equal(
    saleErrorMessage(model.state.error, { method: 'chocofood' }),
    'Введите номер заказа ChocoFood',
  );
  await model.sell({ method: 'chocofood', external_order_ref: 'cf-1001' });
  assert.deepEqual(posted(edge), [
    {
      quote_id: model.state.order.quote_id,
      service_mode_confirmed: true,
      order_repeated: true,
      external_order_ref: 'CF-1001',
      tenders: [{ method: 'chocofood', amount_minor: '699000' }],
    },
  ]);
  assert.equal(model.state.sale.service_mode, 'dine_in');
  assert.equal(model.state.sale.pickup, 'issue');
  assert.equal(model.state.sale.fiscal[0].state, 'not_required');
});

test('aggregator: channel price from the quote, takeaway forced, number required, delivery pickup', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  model.quantity(edge.item.variant_id, 1);
  model.chooseServiceMode('dine_in');
  model.setChannel('yandex_eda');
  assert.equal(model.state.draft.service_mode, 'takeaway');
  assert.equal(model.state.saleDraft.serviceModeChosen, true);
  model.chooseServiceMode('dine_in');
  assert.equal(model.state.error.message, 'AGGREGATOR_TAKEAWAY_ONLY');
  assert.equal(saleErrorMessage(model.state.error), 'Заказ агрегатора - только с собой');
  await model.calculate();
  const request = edge.calls.findLast((c) => c.path === 'checkout/quotes');
  assert.equal(request.body.sales_channel, 'yandex_eda');
  assert.equal(request.body.service_mode, 'takeaway');
  assert.equal(model.state.quote.total_minor, '750000', 'aggregator price, not the hall price');
  model.confirmReview();
  await model.sell({ method: 'cash', tendered_minor: '750000' });
  assert.equal(model.state.error.message, 'METHOD_DISABLED', 'hall methods never pay a delivery');
  await model.sell({ method: 'aggregator' });
  assert.equal(model.state.error.message, 'EXTERNAL_REF_REQUIRED');
  assert.equal(saleErrorMessage(model.state.error, {}), 'Введите номер заказа агрегатора');
  model.setExternalOrderRef(' ya-123 ');
  assert.equal(model.reviewed, false, 'a changed number is repeated to the guest again');
  model.confirmReview();
  await model.sell({ method: 'aggregator' });
  assert.equal(model.state.error, null, String(model.state.error));
  assert.deepEqual(posted(edge)[0], {
    quote_id: model.state.order.quote_id,
    service_mode_confirmed: true,
    order_repeated: true,
    external_order_ref: 'YA-123',
    tenders: [{ method: 'aggregator_yandex_eda', amount_minor: '750000' }],
  });
  assert.equal(pickupText(model.state.sale), 'Выдача доставки · Яндекс Еда №YA-123');
  assert.equal(model.state.sale.tenders[0].confirmation, 'aggregator_attested');
  assert.equal(model.state.saleDraft.channel, 'hall', 'the next order starts in the hall');
});

test('aggregator quote must echo its channel; missing channel price shows the channel menu', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  model.quantity(edge.item.variant_id, 1);
  model.setChannel('glovo');
  edge.edge.echoChannel = false;
  await model.calculate();
  assert.equal(model.state.quote, null);
  assert.equal(model.state.error.message, 'INVALID_RESPONSE');
  edge.edge.echoChannel = true;
  edge.edge.quoteError = new ApiError('CHANNEL_PRICE_UNAVAILABLE', 409);
  await model.calculate();
  assert.equal(saleErrorMessage(model.state.error, { channel: 'glovo' }), 'Нет в меню Glovo');
  assert.equal(
    saleErrorMessage(model.state.error, { channel: 'yandex_eda' }),
    'Нет в меню Яндекс Еды',
  );
});

test('staff meal and marketing need a one-time shift manager approval; the PIN is never stored', async () => {
  // Quotes outlive the approval here, so only the approval TTL is under test.
  const edge = saleEdge({ quoteTtlMs: 600000 }),
    storage = memory();
  let now = Date.now();
  const model = await saleCashier(edge, storage, memory(), { now: () => now });
  await reviewed(model, edge);
  await model.sell({ method: 'staff_meal', beneficiary: 'Тестовый сотрудник' });
  assert.equal(model.state.error.message, 'APPROVAL_REQUIRED');
  await model.requestApproval('9999', 'staff_meal');
  assert.equal(model.state.error.code, 'APPROVAL_PIN_REJECTED');
  assert.equal(saleErrorMessage(model.state.error), 'Неверный PIN или нет прав начальника смены');
  assert.ok(model.state.actor, 'a refused manager PIN never ends the cashier session');
  await model.requestApproval('0000', 'staff_meal');
  assert.equal(model.state.error.code, 'APPROVAL_PIN_REJECTED', 'any 403 code is a refused PIN');
  assert.ok(model.state.actor);
  await model.requestApproval(MANAGER_PIN, 'staff_meal');
  const request = edge.calls.findLast((c) => c.path === 'staff/approvals');
  assert.deepEqual(request.body, {
    staff_id: edge.actor.staff_id,
    pin: MANAGER_PIN,
    action: 'staff_meal',
    subject: { quote_id: model.state.quote.quote_id, amount_minor: '699000' },
  });
  assert.ok(model.approvalFor('staff_meal'));
  assert.equal(model.approvalFor('marketing'), null, 'an approval covers one action');
  await model.sell({ method: 'marketing', reason: 'Тестовая дегустация' });
  assert.equal(model.state.error.message, 'APPROVAL_INVALID');
  await model.sell({ method: 'staff_meal', beneficiary: ' ' });
  assert.equal(model.state.error.message, 'BENEFICIARY_REQUIRED');
  now += 116000;
  assert.equal(model.approvalFor('staff_meal'), null, 'expires before the edge TTL runs out');
  await model.sell({ method: 'staff_meal', beneficiary: 'Тестовый сотрудник' });
  assert.equal(model.state.error.message, 'APPROVAL_INVALID', 'the edge TTL also binds the client');
  now -= 116000;
  await model.sell({ method: 'staff_meal', beneficiary: ' Тестовый сотрудник ' });
  assert.equal(model.state.error, null, String(model.state.error));
  const body = posted(edge)[0];
  assert.deepEqual(body.tenders, [{ method: 'staff_meal', amount_minor: '699000' }]);
  assert.equal(body.beneficiary, 'Тестовый сотрудник');
  assert.deepEqual(body.approval, {
    approval_id: [...edge.edge.approvals.keys()][0],
    token: 'c'.repeat(64),
  });
  assert.equal(model.state.sale.revenue_kind, 'staff_meal');
  assert.equal(model.state.approval, null, 'an approval is used once');
  for (const value of storage.data.values())
    assert.ok(!value.includes(`"pin"`) && !value.includes(MANAGER_PIN), 'no PIN in the journal');
});

test('marketing: a reason of 3..300 characters and a marketing approval', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  await reviewed(model, edge);
  await model.requestApproval(MANAGER_PIN, 'marketing');
  await model.sell({ method: 'marketing', reason: 'аб' });
  assert.equal(model.state.error.message, 'REASON_REQUIRED');
  await model.sell({ method: 'marketing', reason: 'Тестовая дегустация' });
  assert.equal(model.state.error, null, String(model.state.error));
  assert.equal(posted(edge)[0].reason, 'Тестовая дегустация');
  assert.equal(model.state.sale.revenue_kind, 'marketing');
});

test('methods and channels switched off by the operator are never offered or sent', async () => {
  const config = posConfigFor();
  config.methods.find((m) => m.code === 'kaspi_manual').enabled = false;
  config.methods.find((m) => m.code === 'aggregator_glovo').enabled = false;
  config.channels.find((c) => c.code === 'yandex_eda').enabled = false;
  const edge = saleEdge({ config });
  const model = await saleCashier(edge);
  model.quantity(edge.item.variant_id, 1);
  for (const channel of ['yandex_eda', 'glovo']) {
    model.setChannel(channel);
    assert.equal(model.state.error.message, 'METHOD_DISABLED', channel);
    assert.equal(model.state.saleDraft.channel, 'hall');
  }
  model.chooseServiceMode('takeaway');
  await model.calculate();
  model.confirmReview();
  await model.sell({ method: 'kaspi_manual' });
  assert.equal(model.state.error.message, 'METHOD_DISABLED');
  assert.deepEqual(mixableMethods(model.state.posConfig), ['cash', 'kaspi_terminal']);
  assert.equal(edge.edge.posts.length, 0);
});

test('definite edge refusals end the command and keep the quote; uncertain answers keep it pending', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  await reviewed(model, edge);
  const quote = model.state.quote.quote_id;
  edge.edge.reject = new ApiError('METHOD_DISABLED', 409);
  await model.sell({ method: 'kaspi_manual' });
  assert.equal(model.state.pending, null);
  assert.equal(model.state.error.code, 'METHOD_DISABLED');
  assert.equal(model.state.quote.quote_id, quote, 'pay another way without quoting again');
  assert.equal(model.reviewed, true);
  await model.requestApproval(MANAGER_PIN, 'staff_meal');
  edge.edge.reject = new ApiError('APPROVAL_INVALID', 409);
  await model.sell({ method: 'staff_meal', beneficiary: 'Тестовый сотрудник' });
  assert.equal(model.state.pending, null);
  assert.equal(model.state.approval, null, 'a refused approval is asked again');
  edge.edge.reject = new ApiError('SERVICE_UNAVAILABLE', 503);
  await model.sell({ method: 'cash', tendered_minor: '699000' });
  assert.equal(model.state.pending.kind, 'sale', 'a 5xx is not an answer: same key later');
  const key = model.state.pending.key;
  edge.edge.reject = null;
  await model.recover();
  assert.equal(edge.edge.posts.at(-1).key, key);
  assert.equal(model.state.sale.tenders[0].method, 'cash');
  assert.equal(edge.edge.posts.length, 4);
  assert.equal(new Set(edge.edge.posts.map((p) => p.key)).size, 3, 'each refusal took a new key');
});

test('every section 5.1 error code has the Russian cashier text; unpaid texts are unchanged', () => {
  const texts = {
    SERVICE_MODE_DISABLED: 'Касса не принимает оплату - сообщите менеджеру',
    METHOD_DISABLED: 'Этот способ оплаты выключен',
    TENDER_SUM_MISMATCH: 'Сумма оплат не равна сумме заказа',
    CASH_TENDERED_TOO_LOW: 'Внесено меньше суммы наличными',
    TERMINAL_AMOUNT_NOT_WHOLE: 'На терминале - только целые тенге',
    CHANNEL_PRICE_UNAVAILABLE: 'Нет в меню Яндекс Еды',
    EXTERNAL_REF_REQUIRED: 'Введите номер заказа агрегатора',
    EXTERNAL_REF_DUPLICATE: 'Этот номер заказа уже пробит',
    APPROVAL_REQUIRED: 'Нужен PIN начальника смены',
    APPROVAL_INVALID: 'Подтверждение недействительно или истекло - введите PIN ещё раз',
    ORDER_IN_PRODUCTION: 'Кухня уже начала - оформите возврат',
    REFUND_LIMIT: 'Сумма больше доступной к возврату',
    REFUND_NOT_SUPPORTED: 'Возврат агрегатора оформляется в кабинете агрегатора',
    DRAWER_INSUFFICIENT: 'В кассе недостаточно наличных',
    FISCAL_PENDING: 'Есть неоформленные чеки Webkassa',
  };
  for (const [code, text] of Object.entries(texts))
    assert.equal(saleErrorMessage(new ApiError(code, 409), { channel: 'yandex_eda' }), text);
  assert.equal(
    saleErrorMessage(new ApiError('CHANNEL_PRICE_UNAVAILABLE', 409), { channel: 'glovo' }),
    'Нет в меню Glovo',
  );
  assert.equal(
    saleErrorMessage(new ApiError('REFUND_NOT_SUPPORTED', 409), { method: 'chocofood' }),
    'Возврат ChocoFood оформляется в кабинете ChocoFood',
  );
  for (const code of ['EDGE_UNREACHABLE', 'QUOTE_EXPIRED', 'CASH_SHIFT_REQUIRED', 'NOPE'])
    assert.equal(saleErrorMessage(new ApiError(code)), errorMessage(new ApiError(code)));
  // The unpaid cashier keeps its own wording for the shared codes.
  assert.equal(
    errorMessage(new ApiError('SERVICE_MODE_DISABLED')),
    'Передача без оплаты сейчас отключена. Обратитесь к управляющему.',
  );
  assert.equal(
    errorMessage(new ApiError('ORDER_IN_PRODUCTION')),
    'Приготовление уже началось. Отмена с кассы недоступна.',
  );
  for (const text of Object.values(texts)) assert.ok(!/[\u2013\u2014]/.test(text), text);
});

test('Webkassa receipt number on the done screen is journaled and the sale read again', async () => {
  const edge = saleEdge(),
    storage = memory();
  const model = await saleCashier(edge, storage);
  await reviewed(model, edge);
  await model.sell({ method: 'cash', tendered_minor: '700000' });
  const receipt = model.state.sale.fiscal[0];
  assert.equal(receipt.state, 'pending');
  await model.recordReceipt(' ');
  assert.equal(model.state.error.message, 'RECEIPT_NUMBER_INVALID');
  let saved;
  const write = storage.setItem;
  storage.setItem = (k, v) => {
    saved ??= JSON.parse(v).pending;
    write(k, v);
  };
  await model.recordReceipt(' TEST-WK-1 ');
  assert.deepEqual(saved, {
    kind: 'fiscal_record',
    path: `pos/fiscal-receipts/${receipt.receipt_id}/record`,
    body: { expected_version: 1, receipt_number: 'TEST-WK-1' },
    key: saved.key,
    at: saved.at,
    subject: model.state.sale.order_id,
  });
  assert.equal(model.state.pending, null);
  assert.equal(model.state.sale.fiscal[0].state, 'recorded');
  assert.equal(model.state.sale.fiscal[0].receipt_number, 'TEST-WK-1');
  assert.equal(edge.calls.findLast((c) => c.path.startsWith('pos/sales/')).method, undefined);
  await model.recordReceipt('TEST-WK-2');
  assert.equal(model.state.error.message, 'RECEIPT_NOT_PENDING');
});

test('journal keeps only well-formed paid commands; damaged ones block every POST', async () => {
  const edge = saleEdge();
  const scope = `${edge.actor.branch_id}.${edge.actor.staff_id}.${edge.actor.terminal_id}`;
  const body = {
    quote_id: randomUUID(),
    service_mode_confirmed: true,
    order_repeated: true,
    tenders: [{ method: 'cash', amount_minor: '699000' }],
    cash_tendered_minor: '700000',
  };
  const journal = (pending) =>
    JSON.stringify({ version: 1, scope, draft: null, pending, known: [], selected: null });
  const pending = { kind: 'sale', path: 'pos/sales', body, key: randomUUID(), at: 'x' };
  for (const [value, ok] of [
    [pending, true],
    [{ ...pending, body: { ...body, discount_minor: '100' } }, false],
    [{ ...pending, body: { ...body, order_repeated: false } }, false],
    [{ ...pending, body: { ...body, tenders: [{ method: 'card', amount_minor: '1' }] } }, false],
    [{ ...pending, body: { ...body, approval: { approval_id: randomUUID() } } }, false],
    [{ ...pending, path: 'orders' }, false],
    [
      {
        kind: 'fiscal_record',
        path: `pos/fiscal-receipts/${randomUUID()}/record`,
        body: { expected_version: 1, receipt_number: 'TEST-WK-1' },
        key: randomUUID(),
        at: 'x',
        subject: randomUUID(),
      },
      true,
    ],
    [
      {
        kind: 'fiscal_record',
        path: `pos/fiscal-receipts/${randomUUID()}/record`,
        body: { expected_version: 1, receipt_number: 'TEST-WK-1' },
        key: randomUUID(),
        at: 'x',
      },
      false,
    ],
  ]) {
    const storage = memory();
    storage.setItem(`pickchick.pos.journal.v1.${scope}`, journal(value));
    const model = await saleCashier(edge, storage);
    assert.equal(model.state.storageBlocked, !ok, JSON.stringify(value));
    if (ok) assert.equal(model.state.pending.kind, value.kind);
    else assert.equal(model.state.error.message, 'STORAGE_DAMAGED');
  }
});

test('paid orders, sales and sales-mode shifts parse; unpaid parsing stays strict', () => {
  const edge = saleEdge();
  const quote = {
    quote_id: randomUUID(),
    branch_id: edge.actor.branch_id,
    release_id: edge.menu.release_id,
    menu_version: 2,
    service_mode: 'takeaway',
    channel: 'pos',
    lines: [
      {
        product_id: edge.item.product_id,
        variant_id: edge.item.variant_id,
        name: edge.item.name,
        quantity: 1,
        unit_price_minor: '699000',
        total_minor: '699000',
      },
    ],
    currency: 'KZT',
    subtotal_minor: '699000',
    discount_minor: '0',
    total_minor: '699000',
    created_at: new Date().toISOString(),
    expires_at: new Date().toISOString(),
  };
  const paid = {
    order_id: randomUUID(),
    branch_id: edge.actor.branch_id,
    quote_id: quote.quote_id,
    version: 1,
    state: 'paid',
    payment_state: 'captured',
    fiscal_state: 'not_requested',
    fulfillment_state: 'accepted',
    execution_mode: 'pos_sale',
    fulfillment: { version: 1, display_number: '27', state: 'accepted' },
    next_action: 'none',
    snapshot: quote,
    created_at: new Date().toISOString(),
    cancellation_reason: null,
  };
  assert.equal(parseOrder(paid).state, 'paid');
  assert.equal(parseOrder({ ...paid, state: 'cancelled' }).state, 'cancelled');
  for (const broken of [
    { ...paid, payment_state: 'not_started' },
    { ...paid, state: 'awaiting_payment' },
    { ...paid, execution_mode: 'unpaid_service' },
    { ...paid, execution_mode: undefined, fulfillment: undefined, fulfillment_state: 'blocked' },
    {
      ...paid,
      execution_mode: 'unpaid_service',
      state: 'awaiting_payment',
      payment_state: 'not_started',
      snapshot: { ...quote, sales_channel: 'glovo' },
    },
    { ...paid, snapshot: { ...quote, sales_channel: 'hall' } },
    { ...paid, snapshot: { ...quote, service_mode: 'dine_in', sales_channel: 'glovo' } },
  ])
    assert.throws(() => parseOrder(broken), /INVALID_RESPONSE/, JSON.stringify(broken));
  const shift = { ...edge.shift, cash_movements: [] };
  assert.equal(parseShift(shift).cash_received_minor, '0');
  const sales = parseShift({
    ...shift,
    cash_received_minor: '350000',
    cash_refunded_minor: '0',
    payment_processing_available: true,
  });
  assert.equal(sales.cash_received_minor, '350000');
  assert.equal(sales.payment_processing_available, true);
  assert.throws(() => parseShift({ ...shift, cash_received_minor: '-1' }));
  assert.throws(() => parseShift({ ...shift, payment_processing_available: 'yes' }));
  const sale = {
    order_id: paid.order_id,
    display_number: 27,
    pickup: 'issue',
    sales_channel: 'hall',
    external_order_ref: null,
    service_mode: 'takeaway',
    revenue_kind: 'revenue',
    total_minor: '699000',
    cash_tendered_minor: '1000000',
    change_minor: '301000',
    tenders: [
      {
        tender_id: randomUUID(),
        method: 'cash',
        amount_minor: '699000',
        confirmation: 'drawer',
        reference: null,
      },
    ],
    refunds: [],
    refundable_minor: '699000',
    fiscal: [
      {
        receipt_id: randomUUID(),
        kind: 'sale',
        state: 'pending',
        receipt_number: null,
        version: 1,
        amount_minor: '699000',
      },
    ],
    shift_id: edge.shift.shift_id,
    terminal_id: edge.actor.terminal_id,
    cashier_staff_id: edge.actor.staff_id,
    created_at: new Date().toISOString(),
  };
  assert.equal(parseSale(sale).display_number, '27');
  assert.equal(parseSale({ ...sale, display_number: '27' }).display_number, '27');
  for (const broken of [
    { ...sale, change_minor: '300000' },
    { ...sale, cash_tendered_minor: '600000', change_minor: '0' },
    { ...sale, total_minor: '700000' },
    { ...sale, pickup: 'delivery_handover' },
    { ...sale, revenue_kind: 'staff_meal' },
    { ...sale, display_number: 0 },
    {
      ...sale,
      sales_channel: 'glovo',
      pickup: 'delivery_handover',
      tenders: [{ ...sale.tenders[0], method: 'aggregator_glovo' }],
      cash_tendered_minor: null,
      change_minor: null,
    },
    { ...sale, fiscal: [{ ...sale.fiscal[0], state: 'recorded' }] },
    { ...sale, fiscal: [{ ...sale.fiscal[0], receipt_number: 'TEST-WK-1' }] },
  ])
    assert.throws(() => parseSale(broken), /INVALID_RESPONSE/, JSON.stringify(broken));
  const config = parsePosConfig({
    ...posConfigFor(),
    methods: [...posConfigFor().methods, { code: 'card_terminal', enabled: true }],
    channels: [...posConfigFor().channels, { code: 'wolt', enabled: true }],
    extra: 'ignored',
  });
  assert.deepEqual(
    config.methods.map((m) => m.code),
    METHODS,
    'unknown future codes are skipped, never offered',
  );
  assert.throws(() => parsePosConfig({ ...posConfigFor(), mode: 'sale' }));
  assert.throws(() => parsePosConfig({ ...posConfigFor(), fiscal_mode: 'webkassa_api' }));
  assert.throws(() =>
    parsePosConfig({
      ...posConfigFor(),
      methods: [...posConfigFor().methods, posConfigFor().methods[0]],
    }),
  );
});

test('a quote close to expiry is quoted again before payment; same content keeps the review', async () => {
  const edge = saleEdge();
  let now = Date.now();
  const model = await saleCashier(edge, memory(), memory(), { now: () => now });
  await reviewed(model, edge);
  const first = model.state.quote.quote_id;
  now += 110000;
  await model.sell({ method: 'cash', tendered_minor: '700000' });
  assert.equal(model.state.error, null, String(model.state.error));
  assert.notEqual(posted(edge)[0].quote_id, first, 'paid on a fresh quote');
  assert.equal(edge.edge.quotes.get(posted(edge)[0].quote_id).total_minor, '699000');
  // A price change between the two quotes must be repeated to the guest before payment.
  model.newDraft();
  await reviewed(model, edge);
  edge.edge.price = '709000';
  now += 110000;
  await model.sell({ method: 'cash', tendered_minor: '710000' });
  assert.equal(model.state.error.message, 'ORDER_REVIEW_REQUIRED');
  assert.equal(model.state.quote.total_minor, '709000');
  assert.equal(edge.edge.posts.length, 1);
});

// ---- Paid-mode screens (apps/pos/src/v2/sale-view.js): DOM-free template values -------------

function screens(model) {
  const said = [];
  let nexts = 0;
  const view = new SaleView(model, {
    onChange: () => {},
    guard:
      (fn) =>
      async (...args) => {
        if (model.state.busy || model.state.pending) return;
        await fn(...args);
      },
    say: (text) => said.push(text),
    pinLength: 4,
    next: () => {
      nexts++;
      model.newDraft();
      view.reset();
    },
  });
  return { view, said, nexts: () => nexts };
}
const legacyValues = { totalLabel: '6 990 ₸', interactionBusy: false };
const tap = async (keys, labels) => {
  for (const label of labels) await keys.find((k) => k.label === label).tap();
};
const texts = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) texts(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) texts(v, out);
  return out;
};

test('screens: the unpaid cashier renders none of the paid-mode blocks', async () => {
  const f = fixture();
  const api = async (path, auth, options) => {
    if (path === 'pos/config') throw new ApiError('NOT_FOUND', 404);
    return f.api(path, auth, options);
  };
  const model = new PosController(api, memory(), memory(), randomUUID);
  await model.login(JSON.stringify(f.credential));
  const { view } = screens(model);
  view.setState({ screen: 'pay', method: 'cash', approvalOpen: true });
  assert.deepEqual(view.templateValues(legacyValues), {
    saleChannelBar: false,
    saleRefShown: false,
    isSaleReview: false,
    isSalePay: false,
    isSaleDone: false,
    saleApprovalOpen: false,
    saleEntryOpen: false,
  });
});

test('screens: order screen never preselects the service mode and names what is missing', async () => {
  const config = posConfigFor();
  config.channels.find((c) => c.code === 'glovo').enabled = false;
  const edge = saleEdge({ config });
  const model = await saleCashier(edge);
  const { view, said } = screens(model);
  // What the app renders: the order screen values win over the closed overlays.
  let order = view.templateValues(legacyValues);
  assert.equal(order.saleChannelBar, true);
  assert.equal(order.isSalePay, false);
  assert.equal(order.payBtnLabel, 'К ОПЛАТЕ');
  assert.deepEqual(
    order.saleChannels.map((c) => c.label),
    ['ЗАЛ', 'ЯНДЕКС ЕДА'],
    'a switched-off channel is not shown',
  );
  model.quantity(edge.item.variant_id, 1);
  order = view.orderValues(legacyValues);
  assert.equal(order.payBtnLabel, 'Выберите: в зале или с собой');
  assert.equal(order.payBtnBg, 'var(--n300)');
  assert.deepEqual(
    order.modeOpts.map((o) => o.bg),
    ['#fff', '#fff'],
    'neither option looks chosen',
  );
  await order.toPay();
  assert.deepEqual(said, ['Выберите: в зале или с собой']);
  assert.equal(edge.calls.filter((c) => c.path === 'checkout/quotes').length, 0);
  await order.modeOpts[1].pick();
  order = view.orderValues(legacyValues);
  assert.equal(model.state.draft.service_mode, 'dine_in');
  assert.equal(order.modeOpts[1].bg, 'var(--blue)');
  assert.equal(order.payBtnLabel, 'К ОПЛАТЕ · 6 990 ₸');
  assert.equal(order.payBtnBg, undefined, 'the designer colours of an active button stay');
  await order.saleChannels[1].pick();
  order = view.orderValues(legacyValues);
  assert.equal(order.saleRefShown, true);
  assert.equal(order.saleRefTitle, 'Номер заказа Яндекс Еды*');
  assert.equal(order.payBtnLabel, 'Введите номер заказа агрегатора');
  assert.equal(order.modeOpts[0].bg, 'var(--blue)', 'aggregator orders are takeaway');
  assert.equal(order.modeOpts[0].note, 'доставка');
  await order.toPay();
  assert.equal(view.values().saleEntryOpen, true, 'the number is asked first');
  assert.equal(view.values().saleEntryTitle, 'Номер заказа Яндекс Еды');
});

test('screens: payment tiles follow pos/config; an aggregator order has one tile', async () => {
  const config = posConfigFor();
  config.methods.find((m) => m.code === 'kaspi_manual').enabled = false;
  const edge = saleEdge({ config });
  const model = await saleCashier(edge);
  const { view } = screens(model);
  await reviewed(model, edge);
  view.setState({ screen: 'pay' });
  assert.deepEqual(
    view.values().saleTiles.map((t) => t.label),
    ['НАЛИЧНЫЕ', 'KASPI ТЕРМИНАЛ', 'СМЕШАННАЯ', 'CHOCOFOOD', 'ПИТАНИЕ СОТРУДНИКА', 'МАРКЕТИНГ'],
  );
  model.state.posConfig.methods.find((m) => m.code === 'kaspi_terminal').allow_in_mix = false;
  assert.ok(!view.values().saleTiles.some((t) => t.label === 'СМЕШАННАЯ'), 'needs two methods');
  model.newDraft();
  model.quantity(edge.item.variant_id, 1);
  model.setChannel('glovo');
  model.setExternalOrderRef('GL-77');
  await model.calculate();
  model.confirmReview();
  view.setState({ screen: 'pay', method: 'aggregator' });
  const values = view.values();
  assert.deepEqual(
    values.saleTiles.map((t) => t.label),
    ['ОПЛАЧЕНО АГРЕГАТОРОМ'],
  );
  assert.equal(values.saleReviewType, 'ДОСТАВКА · GLOVO №GL-77');
  assert.equal(
    values.saleAggregatorNote,
    'Заказ оплачен в Glovo №GL-77 - деньги придут от агрегатора.',
  );
  assert.equal(values.salePayLabel, 'Провести заказ Glovo');
});

test('screens: cash from the keypad with change, then the done screen with number and Webkassa', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  const { view, nexts } = screens(model);
  model.quantity(edge.item.variant_id, 1);
  await view.orderValues(legacyValues).modeOpts[0].pick();
  await view.orderValues(legacyValues).toPay();
  let values = view.values();
  assert.equal(values.isSaleReview, true);
  assert.equal(values.saleReviewType, 'С СОБОЙ');
  assert.deepEqual(
    values.saleReviewLines.map((l) => [l.qty, l.name, l.total]),
    [['1 ×', 'Комбо на двоих', '6 990 ₸']],
  );
  assert.equal(values.saleReviewTotal, '6 990 ₸');
  await values.saleReviewConfirm();
  values = view.values();
  assert.equal(values.isSalePay, true);
  assert.equal(values.salePanelNone, true);
  await values.saleTiles[0].pick();
  values = view.values();
  assert.equal(values.salePayDisabled, 'true');
  await tap(values.saleCashKeys, ['1', '0', '0', '0', '0']);
  values = view.values();
  assert.equal(values.saleCashLabel, '10 000 ₸');
  assert.equal(values.saleChangeTitle, 'Сдача');
  assert.equal(values.saleChangeLabel, '3 010 ₸');
  assert.equal(values.salePayLabel, 'Принять 10 000 ₸ · сдача 3 010 ₸');
  await values.saleCashQuick.find((q) => q.label === 'Без сдачи').tap();
  assert.equal(view.values().saleCashLabel, '6 990 ₸');
  await view
    .values()
    .saleCashQuick.find((q) => q.label === '10 000 ₸')
    .tap();
  await view.values().salePayConfirm();
  assert.deepEqual(posted(edge)[0].tenders, [{ method: 'cash', amount_minor: '699000' }]);
  assert.equal(posted(edge)[0].cash_tendered_minor, '1000000');
  values = view.values();
  assert.equal(values.isSaleDone, true);
  assert.equal(values.isSalePay, false);
  assert.equal(values.saleDoneNo, '27');
  assert.equal(values.saleDonePickup, 'Забрать на выдаче');
  assert.equal(values.saleDoneMethod, 'Наличные');
  assert.equal(values.saleDoneChange, 'Сдача 3 010 ₸');
  assert.equal(values.saleFiscalPending, true);
  await values.saleReceiptSave();
  assert.equal(view.values().saleEntryTitle, 'Номер чека Webkassa', 'an empty number is asked');
  await tap(view.values().saleEntryKeys, ['T', 'E', 'S', 'T', '-', 'W', 'K', '-', '1']);
  await view.values().saleEntrySave();
  await view.values().saleReceiptSave();
  values = view.values();
  assert.equal(values.saleFiscalPending, false);
  assert.equal(values.saleFiscalNote, 'Чек Webkassa №TEST-WK-1 сохранён');
  await values.saleNext();
  assert.equal(nexts(), 1);
  assert.equal(view.values().isSaleDone, false);
  assert.equal(model.state.sale, null);
});

test('screens: Kaspi terminal instructions, declined terminal, and Webkassa later', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  const { view, said } = screens(model);
  await reviewed(model, edge);
  view.setState({ screen: 'pay' });
  await view
    .values()
    .saleTiles.find((t) => t.label === 'KASPI ТЕРМИНАЛ')
    .pick();
  let values = view.values();
  assert.deepEqual(values.saleTerminalSteps, [
    '1. Введите на терминале Kaspi 6 990 ₸.',
    '2. Дождитесь на терминале «Оплата прошла».',
    '3. Только после этого нажмите «Оплата на терминале прошла».',
  ]);
  assert.equal(values.salePayLabel, 'Оплата на терминале прошла');
  await values.saleTerminalDecline();
  assert.equal(view.values().salePanelNone, true);
  assert.match(said.at(-1), /Оплата не прошла/);
  assert.equal(edge.edge.posts.length, 0);
  await view
    .values()
    .saleTiles.find((t) => t.label === 'KASPI ТЕРМИНАЛ')
    .pick();
  await view.values().salePayConfirm();
  values = view.values();
  assert.equal(values.saleDoneMethod, 'Kaspi терминал');
  assert.equal(values.saleDoneChange, false);
  await values.saleReceiptLater();
  assert.equal(view.values().saleFiscalNote, 'Номер чека Webkassa нужно внести до закрытия смены');
});

test('screens: mixed payment parts, staff meal with the PIN modal, aggregator number entry', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  const { view } = screens(model);
  await reviewed(model, edge);
  view.setState({ screen: 'pay' });
  await view
    .values()
    .saleTiles.find((t) => t.label === 'СМЕШАННАЯ')
    .pick();
  let values = view.values();
  assert.deepEqual(
    values.saleMixParts.map((p) => p.methods.find((m) => m.pressed === 'true').label),
    ['Наличные', 'Kaspi терминал'],
  );
  assert.equal(values.salePayDisabled, 'true');
  await tap(values.saleMixKeys, ['1', '9', '9', '0']);
  values = view.values();
  assert.deepEqual(
    values.saleMixParts.map((p) => p.amount),
    ['1 990 ₸', '5 000 ₸'],
  );
  assert.equal(values.saleMixRestTitle, 'Сдача');
  await values.saleMixCashPick();
  await tap(view.values().saleMixKeys, ['2', '0', '0', '0']);
  values = view.values();
  assert.equal(values.saleMixCashLabel, '2 000 ₸');
  assert.equal(values.saleMixRestLabel, '10 ₸');
  // Choosing cash for the second part moves the first part to the other method.
  await values.saleMixParts[1].methods.find((m) => m.label === 'Наличные').pick();
  assert.deepEqual(view.state.mix, ['kaspi_terminal', 'cash']);
  await view
    .values()
    .saleMixParts[1].methods.find((m) => m.label === 'Kaspi терминал')
    .pick();
  await view
    .values()
    .saleMixParts[0].methods.find((m) => m.label === 'Наличные')
    .pick();
  await view.values().saleMixCashPick();
  await tap(view.values().saleMixKeys, ['2', '0', '0', '0']);
  await view.values().salePayConfirm();
  assert.deepEqual(posted(edge)[0], {
    quote_id: model.state.order.quote_id,
    service_mode_confirmed: true,
    order_repeated: true,
    tenders: [
      { method: 'cash', amount_minor: '199000' },
      { method: 'kaspi_terminal', amount_minor: '500000' },
    ],
    cash_tendered_minor: '200000',
  });
  assert.equal(view.values().saleDoneMethod, 'Наличные 1 990 ₸ + Kaspi терминал 5 000 ₸');
  await view.values().saleNext();

  await reviewed(model, edge);
  view.setState({ screen: 'pay' });
  await view
    .values()
    .saleTiles.find((t) => t.label === 'ПИТАНИЕ СОТРУДНИКА')
    .pick();
  values = view.values();
  assert.equal(values.saleFreeTextTitle, 'Кому*');
  await values.saleFreeTextPick();
  await tap(view.values().saleEntryKeys, ['А', 'Й', 'Г', 'Е', 'Р', 'И', 'М']);
  assert.equal(view.values().saleEntryShown, 'Айгерим');
  await view.values().saleEntrySave();
  assert.equal(view.state.beneficiary, 'Айгерим');
  await view.values().saleApprovalPick();
  values = view.values();
  assert.equal(values.saleApprovalOpen, true);
  assert.equal(values.saleApprovalSub, 'Питание сотрудника · 6 990 ₸');
  await tap(values.saleApprovalKeys, ['1', '1', '1', '1']);
  assert.equal(view.values().saleApprovalError, 'Неверный PIN или нет прав начальника смены');
  assert.equal(view.state.approvalPin, '', 'a typed PIN is never kept');
  await tap(view.values().saleApprovalKeys, MANAGER_PIN.split(''));
  values = view.values();
  assert.equal(values.saleApprovalOpen, false);
  assert.equal(values.saleApprovalLabel, 'Подтвердил: Тестовый начальник');
  assert.equal(values.salePayDisabled, false);
  await values.salePayConfirm();
  assert.equal(posted(edge)[1].beneficiary, 'Айгерим');
  assert.equal(view.values().saleDoneTitle, 'Заказ без выручки передан на кухню');
  assert.equal(view.values().saleFiscalNote, 'Чек Webkassa для этого способа оплаты не нужен');
  await view.values().saleNext();

  model.quantity(edge.item.variant_id, 1);
  await view.orderValues(legacyValues).saleChannels[1].pick();
  await view.orderValues(legacyValues).saleRefPick();
  await tap(view.values().saleEntryKeys, ['Y', 'A']);
  await view.values().saleEntrySave();
  assert.equal(model.state.saleDraft.externalOrderRef, '', 'two characters are not a number');
  await tap(view.values().saleEntryKeys, ['-', '1', '2', '3']);
  await view.values().saleEntrySave();
  assert.equal(model.state.saleDraft.externalOrderRef, 'YA-123');
  await view.orderValues(legacyValues).toPay();
  values = view.values();
  assert.equal(values.saleReviewType, 'ДОСТАВКА · ЯНДЕКС ЕДА №YA-123');
  await values.saleReviewConfirm();
  assert.equal(view.state.method, 'aggregator', 'the only method is preselected');
  await view.values().salePayConfirm();
  assert.equal(view.values().saleDonePickup, 'Выдача доставки · Яндекс Еда №YA-123');
});

test('screens: every paid-mode text is Russian copy with the plain hyphen only', async () => {
  const edge = saleEdge({ price: '699050' });
  const model = await saleCashier(edge);
  const { view } = screens(model);
  const seen = [...texts(view.orderValues(legacyValues))];
  await reviewed(model, edge);
  for (const method of [
    'cash',
    'kaspi_terminal',
    'kaspi_manual',
    'mixed',
    'chocofood',
    'staff_meal',
    'marketing',
  ]) {
    view.setState({ screen: 'pay' });
    view.pick(method);
    seen.push(...texts(view.values()), view.missing());
    view.setState({ approvalOpen: true, entry: { purpose: 'reason', value: '' } });
    seen.push(...texts(view.values()));
    view.setState({ approvalOpen: false, entry: null });
  }
  for (const text of seen) assert.ok(!/[\u2013\u2014]/.test(text), text);
  assert.ok(seen.includes('На терминале - только целые тенге. Выберите другой способ.'));
});
