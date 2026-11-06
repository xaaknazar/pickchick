import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  POS_CONFIG_MISSING_MS,
  POS_CONFIG_POLL_MS,
  PosController,
  approvalQuoteSpare,
  closeSubject,
  fiscalSubject,
  mixableMethods,
  refundSubject,
  voidSubject,
} from '../../apps/pos/dist/model.js';
import { ApiError, errorMessage, saleErrorMessage } from '../../apps/pos/dist/api.js';
import { SaleView } from '../../apps/pos/dist/v2/sale-view.js';
import {
  DAY_SUM_NOTE,
  OpsView,
  drawerMessage,
  orderTicket,
  paidDayStats,
  printMessage,
  refundTicket,
} from '../../apps/pos/dist/v2/ops-view.js';
import { RECEIPT_READS } from '../../apps/pos/dist/model.js';
import { receiptRow, reportLines } from '../../apps/pos/dist/v2/ops-view.js';
import {
  DESK_MODE_KEY,
  PAID_TEXTS,
  TEST_TEXTS,
  closeReasonText,
  deskTexts,
  findGuestText,
  kitchenOffText,
  rememberDeskMode,
  shiftClosedText,
  shiftOpenedText,
  storedDeskPaid,
  unavailableText,
} from '../../apps/pos/dist/v2/mode-texts.js';
import { parseTicket } from '../../apps/pos-desktop/printer.mjs';
import { JOURNAL_PREFIX, validateJournal } from '../../apps/pos-desktop/journal.mjs';
import {
  cashShift as parseShift,
  inputMoney,
  lineKey,
  linePrice,
  money,
  menu as parseMenu,
  order as parseOrder,
  pickupText,
  posConfig as parsePosConfig,
  posSale as parseSale,
  shiftReport as parseReport,
  tenderRefundable,
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
  // The edge clock of quote times; a test that moves the cashier clock passes the same one.
  clock = () => Date.now(),
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
    // Part B: voids, refunds, receipts, X/Z and closing (contracts section 5.1, POS-3..5).
    ops: [],
    opReject: null,
    loseNextOp: false,
    started: new Set(),
    used: new Set(),
    closed: null,
    reportOverride: null,
    drawerTaken: 0n,
  };
  const quoteFor = (body) => {
    const unit = body.sales_channel ? channelPrice : state.price;
    const at = clock();
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
      created_at: new Date(at).toISOString(),
      expires_at: new Date(at + quoteTtlMs).toISOString(),
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
      state.approvals.set(approval.approval_id, {
        ...options.body,
        manager: approval.manager.staff_id,
      });
      return approval;
    }
    if (/^pos\/fiscal-receipts\/[0-9a-f-]+\/record$/.test(path))
      return command(path, options, () => {
        const id = path.split('/')[2];
        for (const sale of state.sales.values())
          for (const receipt of sale.fiscal)
            if (receipt.receipt_id === id) {
              if (options.body.expected_version !== receipt.version)
                throw new ApiError('CONFLICT', 409);
              // A recorded number is corrected only with a fiscal_correct approval.
              if (receipt.state === 'recorded')
                consume(options.body.approval, 'fiscal_correct', {
                  order_id: sale.order_id,
                  amount_minor: receipt.amount_minor,
                });
              else assert.equal(options.body.approval, undefined);
              Object.assign(receipt, {
                state: 'recorded',
                receipt_number: options.body.receipt_number,
                version: receipt.version + 1,
              });
              return { ...receipt, order_id: sale.order_id, mode: 'manual_webkassa' };
            }
        throw new ApiError('NOT_FOUND', 404);
      });
    if (path.startsWith('pos/fiscal-receipts/pending')) {
      const shift = new URL(path, 'http://edge.invalid/').searchParams.get('shift_id');
      return { receipts: pendingReceipts(shift) };
    }
    if (/^pos\/sales\/[0-9a-f-]+\/void$/.test(path))
      return command(path, options, () => voidSale(path.split('/')[2], options.body));
    if (/^pos\/sales\/[0-9a-f-]+\/refunds$/.test(path))
      return command(path, options, () => refundSale(path.split('/')[2], options.body));
    if (/^cash-shifts\/[0-9a-f-]+\/x-report$/.test(path))
      return state.reportOverride ?? report('x');
    if (/^cash-shifts\/[0-9a-f-]+\/z-report$/.test(path)) {
      if (!state.closed) throw new ApiError('CONFLICT', 409);
      return report('z');
    }
    if (path === `cash-shifts/${f.shift.shift_id}/close` && options.method === 'POST')
      return command(path, options, () => closeShift(options.body));
    if (state.closed && path === 'cash-shifts/current')
      return { shift: null, server_time: new Date().toISOString() };
    if (state.closed && path === 'cash-shifts')
      return { shifts: [state.closed], server_time: new Date().toISOString() };
    if (state.closed && path === `cash-shifts/${f.shift.shift_id}`) return state.closed;
    return f.api(path, auth, options);
  };
  /** Idempotent command store of the synthetic edge: same key, same body, same result. */
  const command = (path, options, run) => {
    assert.equal(options.method, 'POST');
    state.ops.push({ path, ...globalThis.structuredClone(options) });
    const saved = state.commands.get(options.key);
    if (saved) {
      assert.equal(saved.body, JSON.stringify(options.body), 'same key, same body');
      return globalThis.structuredClone(saved.result);
    }
    if (state.opReject) throw state.opReject;
    const result = run();
    state.commands.set(options.key, {
      body: JSON.stringify(options.body),
      result: globalThis.structuredClone(result),
    });
    if (state.loseNextOp) {
      state.loseNextOp = false;
      throw new ApiError('EDGE_UNREACHABLE');
    }
    return result;
  };
  /** One-time approval: same action, same subject, unused (contracts section 5.1). */
  const consume = (proof, action, subject) => {
    const issued = proof && state.approvals.get(proof.approval_id);
    if (!proof) throw new ApiError('APPROVAL_REQUIRED', 409);
    if (
      !issued ||
      issued.action !== action ||
      JSON.stringify(issued.subject) !== JSON.stringify(subject) ||
      state.used.has(proof.approval_id)
    )
      throw new ApiError('APPROVAL_INVALID', 409);
    state.used.add(proof.approval_id);
  };
  const manualFiscal = (method) =>
    state.config.methods.find((m) => m.code === method)?.fiscal_policy === 'manual_webkassa';
  const tenderLeft = (sale, tender) =>
    BigInt(tender.amount_minor) -
    sale.refunds
      .flatMap((r) => r.tenders)
      .filter((t) => t.tender_id === tender.tender_id)
      .reduce((n, t) => n + BigInt(t.amount_minor), 0n);
  const pendingReceipts = (shift) =>
    [...state.sales.values()]
      .filter((sale) => !shift || sale.shift_id === shift)
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
  const drawer = () =>
    BigInt(f.shift.opening_cash_minor) +
    [...state.sales.values()].reduce((n, sale) => {
      const cash = sale.tenders.find((t) => t.method === 'cash');
      return cash ? n + tenderLeft(sale, cash) : n;
    }, 0n);
  const voidSale = (id, body) => {
    const order = state.orders.get(id),
      sale = state.sales.get(id);
    if (!order || !sale) throw new ApiError('NOT_FOUND', 404);
    if (state.started.has(id)) throw new ApiError('ORDER_IN_PRODUCTION', 409);
    if (body.expected_version !== order.version || order.state !== 'paid')
      throw new ApiError('CONFLICT', 409);
    consume(body.approval, 'void', { order_id: id, amount_minor: sale.refundable_minor });
    const refund = {
      refund_id: randomUUID(),
      kind: 'void',
      amount_minor: sale.refundable_minor,
      reason_code: body.reason_code,
      approved_by_staff_id: state.approvals.get(body.approval.approval_id).manager,
      created_at: new Date().toISOString(),
      tenders: sale.tenders
        .map((t) => ({ tender_id: t.tender_id, amount_minor: tenderLeft(sale, t).toString() }))
        .filter((t) => t.amount_minor !== '0'),
    };
    sale.refunds.push(refund);
    sale.refundable_minor = '0';
    const receipt = sale.fiscal.find((r) => r.kind === 'sale');
    if (receipt.state === 'pending' && !body.fiscal_sale_issued)
      Object.assign(receipt, { state: 'not_required', version: receipt.version + 1 });
    else if (receipt.state !== 'not_required')
      sale.fiscal.push({
        receipt_id: randomUUID(),
        kind: 'refund',
        state: 'pending',
        receipt_number: null,
        version: 1,
        amount_minor: refund.amount_minor,
      });
    Object.assign(order, {
      state: 'cancelled',
      version: order.version + 1,
      fulfillment_state: 'cancelled',
      fulfillment: { ...order.fulfillment, version: 2, state: 'cancelled' },
      cancellation_reason: body.reason,
    });
    return { order: { ...order }, sale: globalThis.structuredClone(sale) };
  };
  const refundSale = (id, body) => {
    const sale = state.sales.get(id);
    if (!sale) throw new ApiError('NOT_FOUND', 404);
    const sum = body.tenders.reduce((n, t) => n + BigInt(t.amount_minor), 0n);
    consume(body.approval, 'refund', { order_id: id, amount_minor: sum.toString() });
    let cash = 0n;
    for (const part of body.tenders) {
      const tender = sale.tenders.find((t) => t.tender_id === part.tender_id);
      if (!tender || BigInt(part.amount_minor) > tenderLeft(sale, tender))
        throw new ApiError('REFUND_LIMIT', 409);
      if (tender.method === 'cash') cash += BigInt(part.amount_minor);
    }
    if (cash > drawer() - state.drawerTaken) throw new ApiError('DRAWER_INSUFFICIENT', 409);
    sale.refunds.push({
      refund_id: body.refund_id,
      kind: 'refund',
      amount_minor: sum.toString(),
      reason_code: body.reason_code,
      approved_by_staff_id: state.approvals.get(body.approval.approval_id).manager,
      created_at: new Date().toISOString(),
      tenders: body.tenders.map((t) => ({ ...t })),
    });
    sale.refundable_minor = (BigInt(sale.refundable_minor) - sum).toString();
    if (sale.tenders.some((t) => manualFiscal(t.method)))
      sale.fiscal.push({
        receipt_id: randomUUID(),
        kind: 'refund',
        state: 'pending',
        receipt_number: null,
        version: 1,
        amount_minor: sum.toString(),
      });
    return globalThis.structuredClone(sale);
  };
  const report = (kind) => {
    const methods = new Map(),
      channels = new Map(),
      fiscal = { pending: 0, recorded: 0, not_required: 0 };
    let voided = 0;
    const sales = [...state.sales.values()];
    for (const sale of sales) {
      for (const t of sale.tenders) {
        const m = methods.get(t.method) ?? { sales: 0n, refunds: 0n, count: 0 };
        m.sales += BigInt(t.amount_minor);
        m.count++;
        methods.set(t.method, m);
      }
      for (const r of sale.refunds) {
        if (r.kind === 'void') voided++;
        for (const part of r.tenders) {
          const method = sale.tenders.find((t) => t.tender_id === part.tender_id).method;
          methods.get(method).refunds += BigInt(part.amount_minor);
        }
      }
      const c = channels.get(sale.sales_channel) ?? { total: 0n, count: 0 };
      c.total += BigInt(sale.total_minor);
      c.count++;
      channels.set(sale.sales_channel, c);
      for (const r of sale.fiscal) fiscal[r.state]++;
    }
    const cash = methods.get('cash') ?? { sales: 0n, refunds: 0n };
    const expected = BigInt(f.shift.opening_cash_minor) + cash.sales - cash.refunds;
    const terminal = methods.get('kaspi_terminal') ?? { sales: 0n, refunds: 0n };
    const closed = state.closed;
    return {
      kind,
      shift_id: f.shift.shift_id,
      terminal_id: f.actor.terminal_id,
      state: closed ? 'closed' : 'open',
      opened_at: f.shift.opened_at,
      closed_at: closed?.closed_at ?? null,
      opening_cash_minor: f.shift.opening_cash_minor,
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
      terminal_reported_minor: closed?.terminal_reported ?? null,
      terminal_discrepancy_minor: closed?.terminal_reported
        ? (BigInt(closed.terminal_reported) - (terminal.sales - terminal.refunds)).toString()
        : null,
      fiscal,
      orders: { count: sales.length, voided_count: voided },
      report_at: new Date().toISOString(),
    };
  };
  const closeShift = (body) => {
    if (state.closed || body.expected_version !== f.shift.version)
      throw new ApiError('CONFLICT', 409);
    const pending = pendingReceipts(f.shift.shift_id);
    if (pending.length)
      consume(body.approval, 'shift_close_pending_fiscal', {
        shift_id: f.shift.shift_id,
        amount_minor: pending.reduce((n, r) => n + BigInt(r.amount_minor), 0n).toString(),
      });
    const expected = BigInt(report('x').expected_cash_minor);
    state.closed = {
      ...f.shift,
      version: f.shift.version + 1,
      state: 'closed',
      closed_at: new Date().toISOString(),
      closed_by_staff_id: f.actor.staff_id,
      expected_cash_minor: expected.toString(),
      counted_cash_minor: body.counted_cash_minor,
      discrepancy_minor: (BigInt(body.counted_cash_minor) - expected).toString(),
      closing_reason: body.reason,
      terminal_reported: body.terminal_reported_minor ?? null,
    };
    const { terminal_reported: _reported, ...shift } = state.closed;
    void _reported;
    return shift;
  };
  return { ...f, api, edge: state };
}
/**
 * The cash desks run pos-desktop, whose main process writes the journal only when its own
 * validator (apps/pos-desktop/journal.mjs) accepts it; a refused write blocks the desk with
 * STORAGE_UNAVAILABLE before anything is sent. Every paid-mode cashier here saves through it.
 */
function desktopJournal(inner) {
  return {
    ...inner,
    getItem: (key) => inner.getItem(key),
    setItem: (key, value) => {
      validateJournal(key, value, key.slice(JOURNAL_PREFIX.length));
      inner.setItem(key, value);
    },
  };
}
/** pos-desktop main keeps (ok) or refuses a journal as the cashier reads it back (the tables). */
function desktopKeeps(scope, raw, ok, label) {
  const key = JOURNAL_PREFIX + scope;
  if (ok) assert.equal(validateJournal(key, raw, scope), raw, label);
  else assert.throws(() => validateJournal(key, raw, scope), /STORAGE_UNAVAILABLE/, label);
}
/** When a journaled command was saved, as the cashier writes it (an ISO time). */
const SAVED_AT = '2026-11-19T03:00:00.000Z';
async function saleCashier(edge, storage = memory(), sessions = memory(), options = {}) {
  const model = new PosController(
    edge.api,
    sessions,
    desktopJournal(storage),
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
    // The operations poll of today's cashier asks nothing new (no receipts, no X report).
    await model.refreshOperations();
    await model.refreshSaleOperations(true);
    model.quantity(f.item.variant_id, 1);
    await model.calculate();
    await model.create(true);
    assert.equal(model.saleMode, false);
    assert.equal(model.state.sale, null);
    assert.equal(model.state.pending.kind, 'create');
    const config = f.calls.filter((c) => c.path === 'pos/config');
    assert.deepEqual(config, [{ path: 'pos/config' }], 'one plain GET at login, nothing else');
    assert.deepEqual(
      f.calls.filter((c) => /^pos\/(?!config$)|-report$|^staff\/approvals/.test(c.path)),
      [],
      'no paid-mode route is ever asked by the unpaid cashier',
    );
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

test('an edge that answers only a bare CONFLICT for the POS codes: each command ends, none is retried', async () => {
  // Until ErrorSchema lists the 13 POS codes (CR pos-1 section 2, CR client-4), the edge error
  // filter turns EXTERNAL_REF_DUPLICATE, REFUND_LIMIT, DRAWER_INSUFFICIENT... into 409 CONFLICT.
  // Degraded but safe: the command ends, the generic text shows, nothing is sent again.
  const edge = saleEdge();
  const model = await saleCashier(edge);
  await reviewed(model, edge, 'takeaway');
  edge.edge.reject = new ApiError('CONFLICT', 409);
  await model.sell({ method: 'cash', tendered_minor: '700000' });
  assert.equal(model.state.pending, null, 'the sale command ends');
  assert.equal(model.state.error.code, 'CONFLICT');
  assert.equal(
    saleErrorMessage(model.state.error, { method: 'cash' }),
    errorMessage(new ApiError('CONFLICT', 409)),
    'today the generic text, not a section 5.1 text',
  );
  assert.equal(model.state.quote, null, 'quoted again before the next try');
  assert.ok(model.state.draft?.items.length, 'the cart stays');
  await model.recover();
  await model.refreshOperations();
  assert.equal(edge.edge.posts.length, 1, 'never sent again with its key');
  assert.equal(edge.edge.sales.size, 0, 'nothing was sold');
  // The next try is a new command: new quote, new key, the guest's confirmation again.
  edge.edge.reject = null;
  await model.calculate();
  model.confirmReview();
  await model.sell({ method: 'cash', tendered_minor: '700000' });
  assert.equal(model.state.error, null, String(model.state.error));
  assert.equal(edge.edge.posts.length, 2);
  assert.notEqual(edge.edge.posts[1].key, edge.edge.posts[0].key);
  assert.notEqual(edge.edge.posts[1].body.quote_id, edge.edge.posts[0].body.quote_id);
  // A refund refused the same way (REFUND_LIMIT or DRAWER_INSUFFICIENT on a merged edge).
  const id = model.state.sale.order_id;
  model.newDraft();
  await model.openSale(id);
  const parts = [{ tender_id: model.state.sale.tenders[0].tender_id, amount_minor: '100000' }];
  await model.requestApproval(MANAGER_PIN, 'refund', refundSubject(id, parts));
  assert.ok(model.approvalFor('refund', refundSubject(id, parts)));
  edge.edge.opReject = new ApiError('CONFLICT', 409);
  const ops = edge.edge.ops.length;
  await model.refund({ tenders: parts, reason_code: 'quality', reason: 'Качество блюда' });
  assert.equal(model.state.pending, null, 'the refund command ends');
  assert.equal(model.state.error.code, 'CONFLICT');
  assert.equal(model.state.approval, null, 'the approval it carried is asked again');
  assert.equal(edge.edge.ops.length, ops + 1);
  await model.recover();
  await model.refreshOperations();
  assert.equal(edge.edge.ops.length, ops + 1, 'never sent again');
  assert.equal(edge.edge.sales.get(id).refunds.length, 0);
});

test('a 401 on staff/approvals asks the session once: an ended session logs the desk out, a wrong PIN does not', async () => {
  const edge = saleEdge();
  // The edge says 401 to every request of an ended session; a probe answer can be lost.
  let ended = false,
    probeLost = false;
  const asked = { 'cash-shifts/current': 0, session: 0 };
  const desk = {
    ...edge,
    api: async (path, auth, options) => {
      if (path in asked) asked[path]++;
      if (path === 'cash-shifts/current' && probeLost) throw new ApiError('EDGE_UNREACHABLE');
      if (ended && path !== 'staff/approvals') throw new ApiError('UNAUTHORIZED', 401);
      return edge.api(path, auth, options);
    },
  };
  const model = await saleCashier(desk);
  await reviewed(model, edge);
  const probes = () => asked['cash-shifts/current'];
  const sessions = asked.session;
  let before = probes();
  await model.requestApproval('9999', 'staff_meal');
  assert.equal(model.state.error.code, 'APPROVAL_PIN_REJECTED');
  assert.equal(probes(), before + 1, 'a 401 asks the session once');
  assert.ok(model.state.actor, 'the session is alive: only the PIN was wrong');
  before = probes();
  await model.requestApproval('0000', 'staff_meal');
  assert.equal(model.state.error.code, 'APPROVAL_PIN_REJECTED', 'PIN right, not a shift manager');
  assert.equal(probes(), before, 'a 403 never asks the session');
  // A lost probe answer is not an ended session: the PIN is refused, the desk stays.
  probeLost = true;
  await model.requestApproval('9999', 'staff_meal');
  assert.equal(model.state.error.code, 'APPROVAL_PIN_REJECTED');
  assert.ok(model.state.actor);
  probeLost = false;
  // Never GET session: on pos-desktop that read takes the journal away until it answers 200.
  assert.equal(asked.session, sessions, 'GET session is asked at login only');
  // The cashier's own session ended on the edge: staff/approvals and the probe both say 401.
  ended = true;
  before = probes();
  await model.requestApproval('9999', 'staff_meal');
  assert.equal(probes(), before + 1);
  assert.equal(model.state.error.code, 'UNAUTHORIZED');
  assert.equal(
    saleErrorMessage(model.state.error),
    errorMessage(new ApiError('UNAUTHORIZED', 401)),
    'the desk says the session ended, not that the PIN is wrong',
  );
  assert.equal(model.state.actor, null, 'the desk logs out at once');
  assert.equal(edge.edge.posts.length, 0);
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
  const pending = { kind: 'sale', path: 'pos/sales', body, key: randomUUID(), at: SAVED_AT };
  const approval = { approval_id: randomUUID(), token: 'c'.repeat(64) };
  const sale = (changes) => ({ ...pending, body: { ...body, ...changes } });
  const one = (method, amount_minor = '699000') => [{ method, amount_minor }];
  for (const [value, ok] of [
    [pending, true],
    [
      sale({
        tenders: [
          { method: 'cash', amount_minor: '400000' },
          { method: 'kaspi_manual', amount_minor: '299000', reference: 'OP-1' },
        ],
        cash_tendered_minor: '500000',
      }),
      true,
    ],
    [
      {
        ...pending,
        body: {
          quote_id: body.quote_id,
          service_mode_confirmed: true,
          order_repeated: true,
          external_order_ref: 'YA-123',
          tenders: one('aggregator_yandex_eda', '750000'),
        },
      },
      true,
    ],
    [
      {
        ...pending,
        body: {
          quote_id: body.quote_id,
          service_mode_confirmed: true,
          order_repeated: true,
          tenders: one('staff_meal'),
          beneficiary: 'Тестовый сотрудник',
          approval,
        },
      },
      true,
    ],
    [sale({ discount_minor: '100' }), false],
    [sale({ order_repeated: false }), false],
    [sale({ tenders: [{ method: 'card', amount_minor: '1' }] }), false],
    [sale({ tenders: one('cash', '0') }), false],
    [sale({ tenders: [...one('cash'), ...one('kaspi_manual'), ...one('kaspi_terminal')] }), false],
    [sale({ tenders: [{ ...one('cash')[0], pin: '1234' }] }), false],
    [sale({ external_order_ref: 'YA 123' }), false],
    [sale({ approval: { approval_id: randomUUID() } }), false],
    [sale({ approval: { ...approval, token: 't' } }), false],
    [sale({ approval: { ...approval, pin: MANAGER_PIN } }), false],
    [sale({ reason: ' аб ' }), false],
    [{ ...pending, path: 'orders' }, false],
    [
      {
        kind: 'fiscal_record',
        path: `pos/fiscal-receipts/${randomUUID()}/record`,
        body: { expected_version: 1, receipt_number: 'TEST-WK-1' },
        key: randomUUID(),
        at: SAVED_AT,
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
        at: SAVED_AT,
      },
      false,
    ],
  ]) {
    desktopKeeps(scope, journal(value), ok, JSON.stringify(value));
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

test('a sale approval is taken on a quote that outlives it: paying later needs no second PIN', async () => {
  let now = Date.now();
  // Edge quotes live 300 s, approvals 120 s (contracts section 5.1).
  const edge = saleEdge({ quoteTtlMs: 300000, clock: () => now });
  const model = await saleCashier(edge, memory(), memory(), { now: () => now });
  await reviewed(model, edge);
  const first = model.state.quote.quote_id;
  now += 200000; // 100 s of the quote left: less than the approval may still be used
  await model.requestApproval(MANAGER_PIN, 'staff_meal');
  assert.equal(model.state.error, null, String(model.state.error));
  const approved = edge.calls.findLast((c) => c.path === 'staff/approvals').body.subject;
  assert.notEqual(approved.quote_id, first, 'quoted again before the PIN, not at payment');
  assert.equal(approved.quote_id, model.state.quote.quote_id);
  assert.equal(model.reviewed, true, 'same lines and prices keep the guest confirmation');
  now += 100000; // paid 100 s later, inside the approval
  await model.sell({ method: 'staff_meal', beneficiary: 'Тестовый сотрудник' });
  assert.equal(model.state.error, null, String(model.state.error));
  assert.equal(posted(edge)[0].quote_id, approved.quote_id, 'the approved quote is the one sold');
  assert.equal(edge.edge.approvals.size, 1, 'one PIN');
  // A quote with enough life left is approved as it is: no extra quote.
  model.newDraft();
  await reviewed(model, edge);
  const fresh = model.state.quote.quote_id,
    quotes = edge.edge.quotes.size;
  now += 10000;
  await model.requestApproval(MANAGER_PIN, 'marketing');
  assert.equal(
    edge.calls.findLast((c) => c.path === 'staff/approvals').body.subject.quote_id,
    fresh,
  );
  assert.equal(edge.edge.quotes.size, quotes);
  // An edge whose quotes live shorter than the approval is not asked again in vain.
  assert.equal(
    approvalQuoteSpare(
      { created_at: '2026-11-19T03:00:00.000Z', expires_at: '2026-11-19T03:02:00.000Z' },
      120,
    ),
    105000,
  );
  assert.equal(
    approvalQuoteSpare(
      { created_at: '2026-11-19T03:00:00.000Z', expires_at: '2026-11-19T03:05:00.000Z' },
      120,
    ),
    147000,
  );
});

// ---- Part B: void, refunds, Webkassa receipts, X/Z and closing a sales shift --------------

/** One paid sale on the synthetic edge, then opened again in the order card. */
async function soldAndOpened(model, edge, payment = { method: 'cash', tendered_minor: '700000' }) {
  await reviewed(model, edge);
  await model.sell(payment);
  assert.equal(model.state.error, null, String(model.state.error));
  const id = model.state.sale.order_id;
  model.newDraft();
  await model.openSale(id);
  assert.equal(model.state.error, null, String(model.state.error));
  assert.equal(model.state.order.order_id, id);
  return id;
}
const lastOp = (edge) => edge.edge.ops.at(-1);

test('void before the kitchen starts: reason, the Webkassa answer and a void PIN for the order', async () => {
  const edge = saleEdge(),
    storage = memory();
  const model = await saleCashier(edge, storage);
  const id = await soldAndOpened(model, edge);
  const input = { reason_code: 'guest_changed_mind', reason: 'Гость передумал' };
  await model.voidSale({ ...input, fiscal_sale_issued: false });
  assert.equal(model.state.error.message, 'APPROVAL_REQUIRED');
  await model.voidSale({ reason_code: 'mistake', reason: 'Гость передумал' });
  assert.equal(model.state.error.message, 'REFUND_REASON_REQUIRED');
  await model.voidSale({ ...input, reason: ' аб ' });
  assert.equal(model.state.error.message, 'REASON_REQUIRED');
  // An approval for another amount does not cover this void.
  await model.requestApproval(MANAGER_PIN, 'void', { order_id: id, amount_minor: '1' });
  await model.voidSale({ ...input, fiscal_sale_issued: false });
  assert.equal(model.state.error.message, 'APPROVAL_INVALID');
  await model.requestApproval(MANAGER_PIN, 'void', voidSubject(model.state.sale));
  assert.deepEqual(edge.calls.findLast((c) => c.path === 'staff/approvals').body, {
    staff_id: edge.actor.staff_id,
    pin: MANAGER_PIN,
    action: 'void',
    subject: { order_id: id, amount_minor: '699000' },
  });
  // The sale receipt is still pending: the cashier must say whether it was punched.
  await model.voidSale(input);
  assert.equal(model.state.error.message, 'FISCAL_SALE_ANSWER_REQUIRED');
  assert.equal(edge.edge.ops.length, 0, 'nothing is sent before every answer is given');
  let journaled;
  const write = storage.setItem;
  storage.setItem = (k, v) => {
    journaled ??= JSON.parse(v).pending;
    write(k, v);
  };
  await model.voidSale({ ...input, fiscal_sale_issued: false });
  assert.equal(model.state.error, null, String(model.state.error));
  assert.equal(journaled.kind, 'void', 'saved before it is sent');
  assert.equal(journaled.key, lastOp(edge).key);
  assert.equal(lastOp(edge).path, `pos/sales/${id}/void`);
  assert.deepEqual(lastOp(edge).body, {
    expected_version: 1,
    reason_code: 'guest_changed_mind',
    reason: 'Гость передумал',
    fiscal_sale_issued: false,
    approval: { approval_id: [...edge.edge.approvals.keys()][1], token: 'c'.repeat(64) },
  });
  assert.equal(model.state.pending, null);
  assert.equal(model.state.approval, null, 'an approval is used once');
  assert.equal(model.state.order.state, 'cancelled');
  assert.equal(model.state.sale.refunds[0].kind, 'void');
  assert.equal(model.state.sale.refundable_minor, '0');
  assert.equal(model.state.sale.fiscal[0].state, 'not_required', 'never punched, never needed');
  await model.voidSale({ ...input, fiscal_sale_issued: false });
  assert.equal(model.state.error.message, 'SALE_NOT_ACTIVE');
  assert.equal(saleErrorMessage(model.state.error), 'Заказ уже отменён или возвращён полностью');
  for (const value of storage.data.values())
    assert.ok(!value.includes(MANAGER_PIN), 'no PIN in the journal');
});

test('void after the kitchen started is refused before sending; the edge refusal ends it too', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  const id = await soldAndOpened(model, edge);
  const order = edge.edge.orders.get(id);
  Object.assign(order, {
    fulfillment_state: 'in_production',
    fulfillment: { ...order.fulfillment, state: 'in_production' },
  });
  await model.openSale(id);
  await model.requestApproval(MANAGER_PIN, 'void', voidSubject(model.state.sale));
  const input = { reason_code: 'wrong_order', reason: 'Неверный заказ', fiscal_sale_issued: true };
  await model.voidSale(input);
  assert.equal(model.state.error.message, 'ORDER_IN_PRODUCTION');
  assert.equal(saleErrorMessage(model.state.error), 'Кухня уже начала - оформите возврат');
  assert.equal(edge.edge.ops.length, 0);
  // The cashier saw "На кухне", but the kitchen starts before the PIN: the edge decides.
  Object.assign(order, {
    fulfillment_state: 'accepted',
    fulfillment: { ...order.fulfillment, state: 'accepted' },
  });
  edge.edge.started.add(id);
  await model.openSale(id);
  await model.requestApproval(MANAGER_PIN, 'void', voidSubject(model.state.sale));
  await model.voidSale(input);
  assert.equal(model.state.error.code, 'ORDER_IN_PRODUCTION');
  assert.equal(edge.edge.ops.length, 1);
  assert.equal(model.state.pending, null, 'a definite refusal ends the command');
  assert.equal(model.state.approval, null);
  assert.equal(model.state.order.state, 'paid', 'the order is read again and stays paid');
  assert.equal(model.state.sale.refunds.length, 0);
});

test('refund by tender: partial amounts, per-tender and order limits, whole tenge on the terminal', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  const id = await soldAndOpened(model, edge, {
    method: 'mixed',
    parts: [
      { method: 'cash', amount_minor: '199000' },
      { method: 'kaspi_terminal', amount_minor: '500000' },
    ],
    tendered_minor: '200000',
  });
  const [cash, terminal] = model.state.sale.tenders;
  const reason = { reason_code: 'quality', reason: 'Качество блюда' };
  const refund = (tenders) => model.refund({ tenders, ...reason });
  await refund([]);
  assert.equal(model.state.error.message, 'REFUND_AMOUNT_INVALID');
  await refund([{ tender_id: cash.tender_id, amount_minor: '0' }]);
  assert.equal(model.state.error.message, 'REFUND_AMOUNT_INVALID');
  await refund([{ tender_id: cash.tender_id, amount_minor: '199001' }]);
  assert.equal(model.state.error.message, 'REFUND_LIMIT', 'never more than the tender paid');
  await refund([{ tender_id: terminal.tender_id, amount_minor: '100050' }]);
  assert.equal(model.state.error.message, 'TERMINAL_AMOUNT_NOT_WHOLE');
  const parts = [
    { tender_id: cash.tender_id, amount_minor: '100000' },
    { tender_id: terminal.tender_id, amount_minor: '200000' },
  ];
  await refund(parts);
  assert.equal(model.state.error.message, 'APPROVAL_REQUIRED');
  await model.requestApproval(MANAGER_PIN, 'refund', refundSubject(id, parts));
  assert.deepEqual(edge.calls.findLast((c) => c.path === 'staff/approvals').body.subject, {
    order_id: id,
    amount_minor: '300000',
  });
  await refund(parts);
  assert.equal(model.state.error, null, String(model.state.error));
  const body = lastOp(edge).body;
  assert.equal(lastOp(edge).path, `pos/sales/${id}/refunds`);
  assert.deepEqual(Object.keys(body), [
    'refund_id',
    'tenders',
    'reason_code',
    'reason',
    'approval',
  ]);
  assert.match(body.refund_id, /^[0-9a-f-]{36}$/);
  assert.notEqual(body.refund_id, lastOp(edge).key, 'the refund id is not the command key');
  assert.deepEqual(body.tenders, parts);
  assert.equal(model.state.sale.refundable_minor, '399000');
  assert.equal(tenderRefundable(model.state.sale, cash.tender_id), 99000n);
  assert.equal(tenderRefundable(model.state.sale, terminal.tender_id), 300000n);
  assert.deepEqual(
    model.state.sale.fiscal.map((r) => [r.kind, r.state, r.amount_minor]),
    [
      ['sale', 'pending', '699000'],
      ['refund', 'pending', '300000'],
    ],
    'a refund receipt is to be punched in Webkassa',
  );
  assert.equal(model.state.approval, null);
  await refund([{ tender_id: cash.tender_id, amount_minor: '100000' }]);
  assert.equal(model.state.error.message, 'REFUND_LIMIT', 'what is left of the tender');
  // The drawer cannot pay out: a definite refusal, read the sale again, nothing pending.
  edge.edge.drawerTaken = 10_000_000n;
  const rest = [{ tender_id: cash.tender_id, amount_minor: '99000' }];
  await model.requestApproval(MANAGER_PIN, 'refund', refundSubject(id, rest));
  await refund(rest);
  assert.equal(model.state.error.code, 'DRAWER_INSUFFICIENT');
  assert.equal(saleErrorMessage(model.state.error), 'В кассе недостаточно наличных');
  assert.equal(model.state.pending, null);
  assert.equal(model.state.approval, null);
  assert.equal(model.state.sale.refunds.length, 1);
});

test('aggregator and ChocoFood money is refunded in their cabinets, never from the desk', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  await reviewed(model, edge);
  await model.sell({ method: 'chocofood', external_order_ref: 'CF-1001' });
  const sale = model.state.sale;
  model.newDraft();
  await model.openSale(sale.order_id);
  await model.refund({
    tenders: [{ tender_id: sale.tenders[0].tender_id, amount_minor: '100000' }],
    reason_code: 'quality',
    reason: 'Качество блюда',
  });
  assert.equal(model.state.error.message, 'REFUND_NOT_SUPPORTED');
  assert.equal(
    saleErrorMessage(model.state.error, { method: 'chocofood' }),
    'Возврат ChocoFood оформляется в кабинете ChocoFood',
  );
  assert.equal(edge.edge.ops.length, 0);
});

test('lost void and refund answers stay journaled and are recovered with their own key and body', async () => {
  const edge = saleEdge(),
    storage = memory(),
    sessions = memory();
  const model = await saleCashier(edge, storage, sessions);
  const id = await soldAndOpened(model, edge);
  const parts = [{ tender_id: model.state.sale.tenders[0].tender_id, amount_minor: '100000' }];
  await model.requestApproval(MANAGER_PIN, 'refund', refundSubject(id, parts));
  edge.edge.loseNextOp = true;
  await model.refund({ tenders: parts, reason_code: 'quality', reason: 'Качество блюда' });
  assert.equal(model.state.error.code, 'EDGE_UNREACHABLE');
  assert.equal(model.state.pending.kind, 'refund');
  const sent = lastOp(edge);
  const restored = new PosController(edge.api, sessions, storage, randomUUID);
  await restored.boot();
  assert.equal(edge.edge.ops.length, 1, 'boot never resends an unknown refund');
  assert.equal(restored.state.pending.kind, 'refund');
  assert.equal(restored.state.pending.key, sent.key);
  await restored.recover();
  assert.equal(restored.state.error, null, String(restored.state.error));
  assert.equal(lastOp(edge).key, sent.key, 'the same key');
  assert.deepEqual(lastOp(edge).body, sent.body, 'the same body, the same refund_id');
  assert.equal(restored.state.pending, null);
  assert.equal(restored.state.sale.refunds.length, 1, 'refunded once');
  assert.equal(restored.state.order.order_id, id, 'the selected order comes back after a restart');
  await restored.requestApproval(MANAGER_PIN, 'void', voidSubject(restored.state.sale));
  edge.edge.loseNextOp = true;
  await restored.voidSale({ reason_code: 'other', reason: 'Гость ушёл', fiscal_sale_issued: true });
  assert.equal(restored.state.pending.kind, 'void');
  const voidKey = restored.state.pending.key;
  await restored.recover();
  assert.equal(lastOp(edge).key, voidKey);
  assert.equal(restored.state.order.state, 'cancelled');
  assert.equal(restored.state.sale.refunds.length, 2);
  assert.deepEqual(
    restored.state.sale.fiscal.map((r) => [r.kind, r.state]),
    [
      ['sale', 'pending'],
      ['refund', 'pending'],
      ['refund', 'pending'],
    ],
    'a punched sale receipt is cancelled by a refund receipt',
  );
});

test('journal keeps only well-formed void, refund, receipt and close commands', async () => {
  const edge = saleEdge();
  const scope = `${edge.actor.branch_id}.${edge.actor.staff_id}.${edge.actor.terminal_id}`;
  const approval = { approval_id: randomUUID(), token: 'c'.repeat(64) };
  const order = randomUUID();
  const entry = (kind, path, body, extra = {}) => ({
    kind,
    path,
    body,
    key: randomUUID(),
    at: SAVED_AT,
    ...extra,
  });
  const voidBody = {
    expected_version: 1,
    reason_code: 'guest_changed_mind',
    reason: 'Гость передумал',
    fiscal_sale_issued: false,
    approval,
  };
  const refundBody = {
    refund_id: randomUUID(),
    tenders: [{ tender_id: randomUUID(), amount_minor: '1000' }],
    reason_code: 'quality',
    reason: 'Качество блюда',
    approval,
  };
  const closeBody = {
    expected_version: 1,
    counted_cash_minor: '100',
    reason: 'Закрытие смены',
    terminal_reported_minor: '0',
    approval,
  };
  const fiscalPath = `pos/fiscal-receipts/${randomUUID()}/record`;
  for (const [value, ok] of [
    [entry('void', `pos/sales/${order}/void`, voidBody), true],
    [entry('void', `pos/sales/${order}/void`, { ...voidBody, approval: undefined }), false],
    [entry('void', `pos/sales/${order}/void`, { ...voidBody, fiscal_sale_issued: 'no' }), false],
    [entry('void', `pos/sales/${order}/void`, { ...voidBody, reason_code: 'x' }), false],
    [entry('void', `pos/sales/${order}/refunds`, voidBody), false],
    [entry('refund', `pos/sales/${order}/refunds`, refundBody), true],
    [
      entry('refund', `pos/sales/${order}/refunds`, {
        ...refundBody,
        tenders: [refundBody.tenders[0], refundBody.tenders[0]],
      }),
      false,
    ],
    [
      entry('refund', `pos/sales/${order}/refunds`, {
        ...refundBody,
        tenders: [{ ...refundBody.tenders[0], amount_minor: '0' }],
      }),
      false,
    ],
    [entry('refund', `pos/sales/${order}/refunds`, { ...refundBody, lines: [] }), false],
    [
      entry('refund', `pos/sales/${order}/refunds`, {
        ...refundBody,
        tenders: [{ ...refundBody.tenders[0], method: 'cash' }],
      }),
      false,
    ],
    [entry('refund', `pos/sales/${order}/refunds/x`, refundBody), false],
    [entry('shift_close', `cash-shifts/${edge.shift.shift_id}/close`, closeBody), true],
    [
      entry('shift_close', `cash-shifts/${edge.shift.shift_id}/close`, {
        expected_version: 1,
        counted_cash_minor: '100',
        reason: 'Закрытие смены',
      }),
      true,
    ],
    [
      entry('shift_close', `cash-shifts/${edge.shift.shift_id}/close`, {
        ...closeBody,
        pin: MANAGER_PIN,
      }),
      false,
    ],
    [
      entry('shift_close', `cash-shifts/${edge.shift.shift_id}/close`, {
        ...closeBody,
        terminal_reported_minor: '-1',
      }),
      false,
    ],
    [
      entry('shift_close', `cash-shifts/${edge.shift.shift_id}/close`, {
        ...closeBody,
        approval: { approval_id: 'x', token: 't' },
      }),
      false,
    ],
    [
      entry(
        'fiscal_record',
        fiscalPath,
        { expected_version: 2, receipt_number: 'TEST-WK-2', approval },
        { subject: order },
      ),
      true,
    ],
    [
      entry(
        'fiscal_record',
        fiscalPath,
        { expected_version: 2, receipt_number: 'TEST-WK-2', pin: MANAGER_PIN },
        { subject: order },
      ),
      false,
    ],
    [entry('fiscal_record', fiscalPath, { expected_version: 2 }, { subject: order }), false],
  ]) {
    const storage = memory();
    const body = JSON.parse(JSON.stringify(value));
    const raw = JSON.stringify({
      version: 1,
      scope,
      draft: null,
      pending: body,
      known: [],
      selected: null,
    });
    desktopKeeps(scope, raw, ok, JSON.stringify(value));
    storage.setItem(`pickchick.pos.journal.v1.${scope}`, raw);
    const model = await saleCashier(edge, storage);
    assert.equal(model.state.storageBlocked, !ok, JSON.stringify(value));
    if (ok) assert.equal(model.state.pending.kind, value.kind);
    else assert.equal(model.state.error.message, 'STORAGE_DAMAGED');
  }
});

test('Webkassa tab: pending receipts of this shift, numbers recorded later, a correction needs a PIN', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  await reviewed(model, edge);
  await model.sell({ method: 'cash', tendered_minor: '700000' });
  model.newDraft();
  await reviewed(model, edge);
  await model.sell({ method: 'kaspi_manual' });
  model.newDraft();
  await model.refreshFiscal();
  assert.equal(
    edge.calls.findLast((c) => c.path.startsWith('pos/fiscal-receipts/pending')).path,
    `pos/fiscal-receipts/pending?shift_id=${edge.shift.shift_id}`,
  );
  assert.equal(model.state.fiscal.scope, 'shift');
  assert.deepEqual(
    model.state.fiscal.receipts.map((r) => [r.display_number, r.kind, r.methods]),
    [
      ['27', 'sale', ['cash']],
      ['28', 'sale', ['kaspi_manual']],
    ],
  );
  await model.refreshFiscal('all');
  assert.equal(
    edge.calls.findLast((c) => c.path.startsWith('pos/fiscal-receipts/pending')).path,
    'pos/fiscal-receipts/pending',
    'every shift: no query',
  );
  const [first] = model.state.fiscal.receipts;
  await model.recordFiscal({ ...first, state: 'pending' }, '\u0007');
  assert.equal(model.state.error.message, 'RECEIPT_NUMBER_INVALID');
  await model.recordFiscal({ ...first, state: 'pending' }, ' TEST-WK-7 ');
  assert.equal(model.state.error, null, String(model.state.error));
  assert.deepEqual(lastOp(edge).body, { expected_version: 1, receipt_number: 'TEST-WK-7' });
  assert.deepEqual(
    model.state.fiscal.receipts.map((r) => r.display_number),
    ['28'],
    'the list is read again',
  );
  // A wrong number already recorded: corrected from the order card with fiscal_correct.
  await model.openSale(first.order_id);
  const receipt = { ...model.state.sale.fiscal[0], order_id: first.order_id };
  assert.deepEqual(
    [receipt.state, receipt.receipt_number, receipt.version],
    ['recorded', 'TEST-WK-7', 2],
  );
  await model.recordFiscal(receipt, 'TEST-WK-7');
  assert.equal(model.state.error.message, 'RECEIPT_NUMBER_SAME');
  await model.recordFiscal(receipt, 'TEST-WK-8');
  assert.equal(model.state.error.message, 'APPROVAL_REQUIRED');
  await model.requestApproval(MANAGER_PIN, 'fiscal_correct', fiscalSubject(receipt));
  await model.recordFiscal(receipt, 'TEST-WK-8');
  assert.equal(model.state.error, null, String(model.state.error));
  assert.deepEqual(lastOp(edge).body, {
    expected_version: 2,
    receipt_number: 'TEST-WK-8',
    approval: { approval_id: [...edge.edge.approvals.keys()].at(-1), token: 'c'.repeat(64) },
  });
  assert.deepEqual(
    [model.state.sale.fiscal[0].receipt_number, model.state.sale.fiscal[0].version],
    ['TEST-WK-8', 3],
  );
  assert.equal(model.state.approval, null);
  // A stale version: the edge refuses (CONFLICT), the command ends, the sale is read again.
  await model.requestApproval(MANAGER_PIN, 'fiscal_correct', fiscalSubject(receipt));
  await model.recordFiscal(receipt, 'TEST-WK-9');
  assert.equal(model.state.error.code, 'CONFLICT');
  assert.equal(model.state.pending, null);
  assert.equal(model.state.sale.fiscal[0].receipt_number, 'TEST-WK-8');
});

test('X report, closing a sales shift with the Kaspi total and a PIN for pending receipts, then Z', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  await reviewed(model, edge);
  await model.sell({ method: 'cash', tendered_minor: '700000' });
  model.newDraft();
  await reviewed(model, edge);
  await model.sell({ method: 'kaspi_terminal' });
  model.newDraft();
  await model.xReport();
  const x = model.state.shiftReport;
  assert.equal(x.kind, 'x');
  assert.equal(x.cash_sales_minor, '699000');
  assert.equal(x.expected_cash_minor, '1199000', 'opening 5 000 + cash sales 6 990');
  assert.deepEqual(
    x.methods.map((m) => [m.method, m.sales_minor]),
    [
      ['cash', '699000'],
      ['kaspi_terminal', '699000'],
    ],
  );
  // A report that does not add up is never shown or printed.
  edge.edge.reportOverride = { ...x, expected_cash_minor: '1' };
  await model.xReport();
  assert.equal(model.state.error.message, 'INVALID_RESPONSE');
  assert.equal(model.state.shiftReport, x);
  edge.edge.reportOverride = null;
  assert.throws(() => parseReport({ ...x, kind: 'z' }), /INVALID_RESPONSE/, 'Z of an open shift');
  const shiftId = edge.shift.shift_id;
  const input = {
    counted_cash_minor: '1199000',
    terminal_reported_minor: '699000',
    reason: 'Закрытие смены',
  };
  await model.closeSaleShift(shiftId, input);
  assert.equal(model.state.error.message, 'FISCAL_PENDING');
  assert.equal(saleErrorMessage(model.state.error), 'Есть неоформленные чеки Webkassa');
  assert.equal(edge.edge.ops.length, 0);
  const pending = await model.pendingForClose(shiftId);
  assert.equal(pending.length, 2);
  await model.requestApproval(
    MANAGER_PIN,
    'shift_close_pending_fiscal',
    closeSubject(shiftId, pending),
  );
  assert.deepEqual(edge.calls.findLast((c) => c.path === 'staff/approvals').body.subject, {
    shift_id: shiftId,
    amount_minor: '1398000',
  });
  await model.closeSaleShift(shiftId, input);
  assert.equal(model.state.error, null, String(model.state.error));
  assert.equal(lastOp(edge).path, `cash-shifts/${shiftId}/close`);
  assert.deepEqual(lastOp(edge).body, {
    expected_version: 1,
    counted_cash_minor: '1199000',
    reason: 'Закрытие смены',
    terminal_reported_minor: '699000',
    approval: { approval_id: [...edge.edge.approvals.keys()].at(-1), token: 'c'.repeat(64) },
  });
  assert.equal(model.state.pending, null);
  assert.equal(model.state.approval, null);
  assert.equal(model.state.shift, null, 'no open shift on this desk any more');
  await model.zReport(shiftId);
  const z = model.state.zReport;
  assert.deepEqual(
    [z.kind, z.state, z.counted_cash_minor, z.discrepancy_minor, z.terminal_discrepancy_minor],
    ['z', 'closed', '1199000', '0', '0'],
  );
  assert.equal(z.fiscal.pending, 2);
});

test('closing approval is bound to what is pending; without receipts no approval is sent', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  await reviewed(model, edge);
  await model.sell({ method: 'cash', tendered_minor: '700000' });
  model.newDraft();
  await reviewed(model, edge);
  await model.sell({ method: 'kaspi_manual' });
  model.newDraft();
  const shiftId = edge.shift.shift_id;
  const pending = await model.pendingForClose(shiftId);
  assert.equal(pending.length, 2);
  await model.requestApproval(
    MANAGER_PIN,
    'shift_close_pending_fiscal',
    closeSubject(shiftId, pending),
  );
  // Another desk records one of the numbers after the PIN: the approval names a sum now gone.
  const recordOnEdge = (receipt) =>
    Object.assign(edge.edge.sales.get(receipt.order_id).fiscal[0], {
      state: 'recorded',
      receipt_number: 'TEST-WK-' + receipt.display_number,
      version: 2,
    });
  recordOnEdge(pending[0]);
  const input = { counted_cash_minor: '1199000', reason: 'Закрытие смены' };
  await model.closeSaleShift(shiftId, input);
  assert.equal(model.state.error.message, 'APPROVAL_INVALID');
  assert.equal(edge.edge.ops.length, 0);
  recordOnEdge(pending[1]);
  await model.closeSaleShift(shiftId, input);
  assert.equal(model.state.error, null, String(model.state.error));
  assert.deepEqual(
    lastOp(edge).body,
    { expected_version: 1, counted_cash_minor: '1199000', reason: 'Закрытие смены' },
    'nothing pending: no approval and no terminal total were sent',
  );
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
  // A new quote under the open payment screen goes back to "Повторите заказ гостю".
  await model.calculate();
  assert.equal(model.reviewed, false);
  assert.equal(view.values().isSalePay, false);
  assert.equal(view.values().isSaleReview, true);
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

// ---- Part B screens (apps/pos/src/v2/ops-view.js): DOM-free template values ----------------

function opsScreens(model, options = {}) {
  const base = screens(model);
  const tabs = [];
  let ended = 0;
  const ops = new OpsView(model, base.view, {
    onChange: () => {},
    guard:
      (fn) =>
      async (...args) => {
        if (model.state.busy || model.state.pending) return;
        await fn(...args);
      },
    say: (text) => base.said.push(text),
    setTab: (tab) => tabs.push(tab),
    pinCredential:
      options.pinCredential ??
      (async () => {
        throw new Error('Неверный PIN или нет доступа к рабочему месту');
      }),
    logoutCredential: async () => {},
    endSession: () => ended++,
    printer: options.printer,
    terminalLabel: 'Тестовая точка',
  });
  return { ...base, ops, tabs, ended: () => ended };
}
const legacyShift = {
  ...legacyValues,
  shiftOrders: 137,
  drawerLabel: '5 000 ₸',
  cashLog: [
    { time: '09:00', what: 'Начальный остаток · тест', sum: '5 000 ₸', fg: 'var(--green)' },
  ],
  navItems: [{ label: 'ЗАКАЗ' }],
};
const pinTap = (view, pin) => tap(view.values().saleApprovalKeys, pin.split(''));

test('screens: part B renders nothing for the unpaid cashier', async () => {
  const f = fixture();
  const api = async (path, auth, options) => {
    if (path === 'pos/config') throw new ApiError('NOT_FOUND', 404);
    return f.api(path, auth, options);
  };
  const model = new PosController(api, memory(), memory(), randomUUID);
  await model.login(JSON.stringify(f.credential));
  const { ops } = opsScreens(model);
  ops.setState({ card: { mode: 'view' }, report: 'x', close: { step: 1 } });
  assert.deepEqual(ops.templateValues(legacyShift, 'fiscal'), {
    isFiscalTab: false,
    isOpsCard: false,
    isOpsReport: false,
    isOpsClose: false,
  });
});

test('screens: paid order card - void with a reason, the Webkassa answer and the PIN modal', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  const { view, ops, said } = opsScreens(model);
  await reviewed(model, edge);
  await model.sell({ method: 'cash', tendered_minor: '700000' });
  const id = model.state.sale.order_id;
  model.newDraft();
  await ops.openCard(id);
  let values = ops.templateValues(legacyShift, 'orders');
  assert.equal(values.isOpsCard, true);
  assert.equal(values.opsCardTitle, 'Заказ №27');
  assert.equal(values.opsCardStatus, 'На кухне · оплачен · в зале');
  assert.equal(values.opsCardPickup, 'Забрать на выдаче');
  assert.deepEqual(
    values.opsCardReceipts.map((r) => [r.text, r.action]),
    [['Чек продажи · 6 990 ₸ · не оформлен', 'Внести номер']],
  );
  assert.equal(values.opsCardCanVoid, true);
  assert.equal(values.opsCardCanRefund, true);
  await values.opsCardVoidPick();
  values = ops.templateValues(legacyShift, 'orders');
  assert.equal(values.opsCardVoid, true);
  assert.equal(values.opsConfirmDisabled, 'true');
  await values.opsConfirm();
  assert.equal(said.at(-1), 'Выберите причину');
  await values.opsReasons.find((r) => r.label === 'Гость передумал').pick();
  values = ops.templateValues(legacyShift, 'orders');
  assert.equal(values.opsReasonValue, 'Гость передумал', 'the reason text starts from the chip');
  await values.opsConfirm();
  assert.equal(said.at(-1), 'Ответьте: чек продажи уже пробит в Webkassa?');
  await values.opsVoidAnswers.find((a) => a.label === 'Чек продажи не пробит').pick();
  values = ops.templateValues(legacyShift, 'orders');
  assert.equal(values.opsConfirmLabel, 'Отменить заказ · PIN начальника смены');
  await values.opsConfirm();
  let modal = view.values();
  assert.equal(modal.saleApprovalOpen, true);
  assert.equal(modal.saleApprovalSub, 'Отмена заказа №27 · 6 990 ₸');
  await pinTap(view, '1111');
  assert.equal(view.values().saleApprovalError, 'Неверный PIN или нет прав начальника смены');
  assert.equal(edge.edge.ops.length, 0);
  await pinTap(view, MANAGER_PIN);
  assert.equal(view.values().saleApprovalOpen, false);
  values = ops.templateValues(legacyShift, 'orders');
  assert.equal(values.opsCardView, true);
  assert.match(values.opsCardStatus, /^Отменён/);
  assert.equal(values.opsCardRefunds.length, 1);
  assert.match(values.opsCardRefunds[0].text, /^Отмена · \d\d:\d\d · Гость передумал$/);
  assert.equal(values.opsCardRefunds[0].sum, '-6 990 ₸');
  assert.equal(values.opsCardCanVoid, false);
  assert.equal(values.opsCardCanRefund, false);
  assert.equal(values.opsCardNote, 'Заказ отменён.');
  assert.deepEqual(lastOp(edge).body.fiscal_sale_issued, false);
  assert.ok(said.includes('Заказ отменён'));
  await values.opsCardClose();
  assert.equal(ops.templateValues(legacyShift, 'orders').isOpsCard, false);
  assert.equal(model.state.order, null, 'the cart is editable again');
});

test('screens: refund by tender with the keypad and "Всё"; the desk never refunds an aggregator', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  const { view, ops, said } = opsScreens(model);
  await reviewed(model, edge);
  await model.sell({
    method: 'mixed',
    parts: [
      { method: 'cash', amount_minor: '199000' },
      { method: 'kaspi_terminal', amount_minor: '500000' },
    ],
    tendered_minor: '200000',
  });
  const id = model.state.sale.order_id;
  model.newDraft();
  await ops.openCard(id);
  await ops.templateValues(legacyShift, 'orders').opsCardRefundPick();
  let values = ops.templateValues(legacyShift, 'orders');
  assert.deepEqual(
    values.opsRefundTenders.map((t) => [t.name, t.left, t.amount, t.note]),
    [
      ['Наличные', 'можно вернуть 1 990 ₸', '-', 'Выдайте наличные из ящика кассы.'],
      [
        'Kaspi терминал',
        'можно вернуть 5 000 ₸',
        '-',
        'Сначала проведите возврат на терминале Kaspi, затем подтвердите.',
      ],
    ],
  );
  assert.equal(values.opsConfirmLabel, 'Введите сумму возврата');
  await tap(values.opsRefundKeys, ['1', '0', '0', '0']);
  await ops.templateValues(legacyShift, 'orders').opsRefundTenders[1].all();
  await ops
    .templateValues(legacyShift, 'orders')
    .opsReasons.find((r) => r.label === 'Качество блюда')
    .pick();
  values = ops.templateValues(legacyShift, 'orders');
  assert.deepEqual(
    values.opsRefundTenders.map((t) => t.amount),
    ['1 000 ₸', '5 000 ₸'],
  );
  assert.equal(values.opsRefundSum, '6 000 ₸');
  assert.equal(values.opsConfirmLabel, 'Вернуть 6 000 ₸ · PIN начальника смены');
  await values.opsConfirm();
  assert.equal(view.values().saleApprovalSub, 'Возврат по заказу №27 · 6 000 ₸');
  await pinTap(view, MANAGER_PIN);
  assert.deepEqual(lastOp(edge).body.tenders, [
    { tender_id: model.state.sale.tenders[0].tender_id, amount_minor: '100000' },
    { tender_id: model.state.sale.tenders[1].tender_id, amount_minor: '500000' },
  ]);
  values = ops.templateValues(legacyShift, 'orders');
  assert.equal(values.opsCardView, true);
  assert.ok(said.includes('Возврат проведён. Пробейте чек возврата в Webkassa.'));
  assert.deepEqual(
    values.opsCardReceipts.map((r) => r.text),
    ['Чек продажи · 6 990 ₸ · не оформлен', 'Чек возврата · 6 000 ₸ · не оформлен'],
  );
  assert.equal(values.opsCardTenders[0].left, 'доступно к возврату 990 ₸');
  await values.opsCardClose();
  // Aggregator money goes back in the aggregator cabinet: no refund screen at the desk.
  model.quantity(edge.item.variant_id, 1);
  model.setChannel('yandex_eda');
  model.setExternalOrderRef('YA-77');
  await model.calculate();
  model.confirmReview();
  await model.sell({ method: 'aggregator' });
  const aggregator = model.state.sale.order_id;
  model.newDraft();
  await ops.openCard(aggregator);
  values = ops.templateValues(legacyShift, 'orders');
  assert.equal(values.opsCardCanRefund, false);
  assert.equal(values.opsCardCanVoid, true, 'an aggregator order is voided before the kitchen');
  ops.startRefund();
  assert.equal(said.at(-1), 'Возврат агрегатора оформляется в кабинете агрегатора');
});

test('screens: Webkassa tab lists pending receipts, records numbers, a correction asks the PIN', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  const { view, ops, said, tabs } = opsScreens(model);
  for (const payment of [
    { method: 'cash', tendered_minor: '700000' },
    { method: 'kaspi_manual' },
  ]) {
    await reviewed(model, edge);
    await model.sell(payment);
    model.newDraft();
  }
  let values = ops.templateValues(legacyShift, 'order');
  const nav = values.navItems.at(-1);
  assert.deepEqual([nav.label, nav.badge], ['ЧЕКИ WEBKASSA', '2']);
  assert.equal(values.isFiscalTab, false);
  await nav.go();
  assert.deepEqual(tabs, ['fiscal']);
  values = ops.templateValues(legacyShift, 'fiscal');
  assert.equal(values.isFiscalTab, true);
  assert.equal(values.opsFiscalTitle, 'Не оформлено: 2 на 13 980 ₸');
  assert.match(values.opsFiscalSub, /^Эта смена · обновлено в \d\d:\d\d$/);
  assert.deepEqual(
    values.opsFiscalRows.map((r) => [r.no, r.kind, r.methods, r.sum]),
    [
      ['№27', 'Продажа', 'Наличные', '6 990 ₸'],
      ['№28', 'Продажа', 'Kaspi вручную', '6 990 ₸'],
    ],
  );
  await values.opsFiscalRows[0].record();
  assert.equal(view.values().saleEntryTitle, 'Номер чека Webkassa');
  await view.values().saleEntrySave();
  assert.equal(said.at(-1), 'Номер чека Webkassa - от 1 до 40 символов', 'an empty number');
  await tap(view.values().saleEntryKeys, ['T', 'E', 'S', 'T', '-', 'W', 'K', '-', '5']);
  await view.values().saleEntrySave();
  assert.equal(said.at(-1), 'Чек заказа №27 оформлен');
  values = ops.templateValues(legacyShift, 'fiscal');
  assert.equal(values.opsFiscalTitle, 'Не оформлено: 1 на 6 990 ₸');
  assert.equal(values.navItems.at(-1).badge, '1');
  await values.opsFiscalScopes.find((c) => c.label === 'Все смены').pick();
  assert.equal(
    edge.calls.findLast((c) => c.path.startsWith('pos/fiscal-receipts/pending')).path,
    'pos/fiscal-receipts/pending',
  );
  assert.match(ops.templateValues(legacyShift, 'fiscal').opsFiscalSub, /^Все смены точки/);
  // A wrong number already recorded: from the order card, a new number and the manager's PIN.
  await ops.openCard([...edge.edge.sales.keys()][0]);
  values = ops.templateValues(legacyShift, 'fiscal');
  assert.deepEqual(
    values.opsCardReceipts.map((r) => [r.text, r.action]),
    [['Чек продажи · 6 990 ₸ · №TEST-WK-5', 'Исправить']],
  );
  await values.opsCardReceipts[0].tap();
  await tap(view.values().saleEntryKeys, ['T', 'E', 'S', 'T', '-', 'W', 'K', '-', '5']);
  await view.values().saleEntrySave();
  assert.equal(said.at(-1), 'Это тот же номер чека');
  await ops.templateValues(legacyShift, 'fiscal').opsCardReceipts[0].tap();
  await tap(view.values().saleEntryKeys, ['T', 'E', 'S', 'T', '-', 'W', 'K', '-', '6']);
  await view.values().saleEntrySave();
  assert.equal(view.values().saleApprovalSub, 'Исправление чека Webkassa №TEST-WK-5');
  await pinTap(view, MANAGER_PIN);
  assert.equal(view.values().saleApprovalOpen, false);
  assert.equal(said.at(-1), 'Номер чека Webkassa исправлен');
  assert.equal(lastOp(edge).body.receipt_number, 'TEST-WK-6');
  assert.ok(lastOp(edge).body.approval, 'the correction carries its approval');
});

test('screens: day cards of the order tab are order sums, not takings, and say so', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  // A cash sale refunded in part, a staff meal, and a sale voided before the kitchen started.
  const refunded = await soldAndOpened(model, edge);
  const parts = [{ tender_id: model.state.sale.tenders[0].tender_id, amount_minor: '100000' }];
  await model.requestApproval(MANAGER_PIN, 'refund', refundSubject(refunded, parts));
  await model.refund({ tenders: parts, reason_code: 'quality', reason: 'Качество блюда' });
  assert.equal(model.state.error, null, String(model.state.error));
  assert.equal(model.state.sale.refundable_minor, '599000');
  model.newDraft();
  await reviewed(model, edge);
  await model.requestApproval(MANAGER_PIN, 'staff_meal');
  await model.sell({ method: 'staff_meal', beneficiary: 'Тестовый сотрудник' });
  assert.equal(model.state.error, null, String(model.state.error));
  assert.equal(model.state.sale.revenue_kind, 'staff_meal');
  model.newDraft();
  const voided = await soldAndOpened(model, edge);
  await model.requestApproval(MANAGER_PIN, 'void', voidSubject(model.state.sale));
  await model.voidSale({
    reason_code: 'guest_changed_mind',
    reason: 'Гость передумал',
    fiscal_sale_issued: false,
  });
  assert.equal(model.state.error, null, String(model.state.error));
  assert.equal(edge.edge.orders.get(voided).state, 'cancelled');
  const orders = [...edge.edge.orders.values()];
  assert.deepEqual(
    orders.map((o) => o.state),
    ['paid', 'paid', 'cancelled'],
  );
  const [all, hall, delivery] = paidDayStats(orders);
  assert.equal(all.label, 'ВСЕ ЗАКАЗЫ');
  assert.equal(all.orders, '2', 'the voided order is left out');
  // 6 990 ₸ refunded in part plus a 6 990 ₸ staff meal: 13 980 ₸ of orders, 5 990 ₸ of takings.
  assert.equal(all.revenue, money('1398000'), 'order totals: the refund is not taken off');
  assert.equal(all.avg, money('699000'));
  assert.equal(hall.orders, '2');
  assert.equal(delivery.orders, '0');
  assert.equal(delivery.avg, '-');
  for (const card of [all, hall, delivery]) {
    assert.equal(card.note, DAY_SUM_NOTE);
    assert.equal(card.share, 'Без отменённых заказов');
  }
  assert.match(DAY_SUM_NOTE, /^Не выручка: питание и маркетинг включены, возвраты не вычтены/);
  assert.match(DAY_SUM_NOTE, /выручка в X-отчёте$/);
  assert.ok(!/[–—]/.test(DAY_SUM_NOTE), 'the plain hyphen only');
});

test('screens: shift tab of the paid mode shows real money; X report prints a typed ticket', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  const printed = [];
  let fail = false;
  const printer = {
    print: async (ticket) => {
      printed.push(ticket);
      if (fail) throw new Error('lost');
      return { state: 'sent' };
    },
  };
  const { ops, said } = opsScreens(model, { printer });
  await reviewed(model, edge);
  await model.sell({ method: 'cash', tendered_minor: '700000' });
  model.newDraft();
  let values = ops.templateValues(legacyShift, 'shift');
  assert.equal(values.shiftRevenue, '6 990 ₸');
  assert.equal(values.shiftOrders, 1);
  assert.deepEqual(
    values.shiftPays.map((p) => [p.name, p.sum]),
    [['Наличные', '6 990 ₸']],
  );
  assert.equal(values.drawerLabel, '11 990 ₸');
  assert.equal(values.kkmLine, 'Чеки: вручную в Webkassa · не оформлено: 1');
  assert.equal(values.cashLog[0].what, 'Начальный остаток');
  assert.ok(!texts(values).some((t) => /Тест/.test(t)), 'no test-mode texts in the paid mode');
  await values.sayRetry();
  await values.sayX();
  values = ops.templateValues(legacyShift, 'shift');
  assert.equal(values.isOpsReport, true);
  assert.equal(values.opsReportTitle, 'X-отчёт PickChick (не фискальный)');
  assert.deepEqual(
    values.opsReportRows.map((r) => [r.label, r.value]),
    [
      ['Начальный остаток', '5 000 ₸'],
      ['Внесения', '0 ₸'],
      ['Изъятия', '0 ₸'],
      ['Наличные продажи', '6 990 ₸'],
      ['Наличные возвраты', '0 ₸'],
      ['Ожидается в ящике', '11 990 ₸'],
    ],
  );
  assert.equal(values.opsReportRevenue, '6 990 ₸');
  await values.opsReportPrint();
  assert.equal(printed.length, 1);
  assert.deepEqual(
    { ...printed[0], printed_at: 'x' },
    {
      kind: 'x_report',
      title: 'X-отчёт PickChick (не фискальный)',
      lines: ['Заказов: 1, отменено: 0', 'Чеки Webkassa: оформлено 0, не оформлено 1, не нужен 0'],
      totals: values.opsReportRows.map((r, i) => ({
        label: r.label,
        amount_minor: ['500000', '0', '0', '699000', '0', '1199000'][i],
      })),
      tenders: [
        {
          method: 'cash',
          label: 'Наличные',
          sales_minor: '699000',
          refunds_minor: '0',
          count: 1,
        },
      ],
      printed_at: 'x',
      terminal_label: 'Тестовая точка',
    },
  );
  assert.equal(said.at(-1), 'Отправлено на печать');
  fail = true;
  await values.opsReportPrint();
  assert.equal(printed.length, 2, 'one attempt per tap, never repeated by itself');
  assert.equal(said.at(-1), saleErrorMessage(new Error('PRINT_FAILED')));
  await values.opsReportClose();
  assert.equal(ops.templateValues(legacyShift, 'shift').isOpsReport, false);
  const bare = opsScreens(model);
  await bare.ops.templateValues(legacyShift, 'shift').sayDrawer();
  assert.equal(bare.said.at(-1), 'Печать не настроена');
});

test('screens: closing wizard - counted cash, Kaspi total, receipts, PIN, then Z and the lock', async () => {
  const edge = saleEdge();
  edge.actor.role = 'shift_manager';
  edge.credential.role = 'shift_manager';
  const model = await saleCashier(edge);
  let credentials = 0;
  const { view, ops, said, ended } = opsScreens(model, {
    pinCredential: async (pin) => {
      credentials++;
      if (pin !== MANAGER_PIN) throw new Error('Неверный PIN или нет доступа к рабочему месту');
      return edge.credential;
    },
  });
  for (const payment of [
    { method: 'cash', tendered_minor: '700000' },
    { method: 'kaspi_terminal' },
  ]) {
    await reviewed(model, edge);
    await model.sell(payment);
    model.newDraft();
  }
  await ops.templateValues(legacyShift, 'shift').startClose();
  let values = ops.templateValues(legacyShift, 'shift');
  assert.equal(values.isOpsClose, true);
  assert.equal(values.opsCloseSteps.length, 6, 'the Kaspi terminal step is asked');
  assert.equal(values.opsCloseTitle, '1 · Сводка смены');
  assert.deepEqual(
    values.opsCloseRows.map((r) => [r.label, r.value]),
    [
      ['Наличные', '6 990 ₸'],
      ['Kaspi терминал', '6 990 ₸'],
      ['Выручка', '13 980 ₸'],
      ['Заказов', '2'],
    ],
  );
  await values.opsCloseNext();
  values = ops.templateValues(legacyShift, 'shift');
  assert.equal(values.opsCloseTitle, '2 · Пересчитайте наличные');
  await tap(values.opsCloseKeys, ['1', '1', '9', '9', '0']);
  values = ops.templateValues(legacyShift, 'shift');
  assert.deepEqual([values.opsCloseAmount, values.opsCloseDiff], ['11 990 ₸', 'Расхождения нет']);
  await values.opsCloseNext();
  values = ops.templateValues(legacyShift, 'shift');
  assert.equal(values.opsCloseTitle, '3 · Итог терминала Kaspi за смену');
  await tap(values.opsCloseKeys, ['6', '9', '0', '0']);
  assert.equal(
    ops.templateValues(legacyShift, 'shift').opsCloseDiff,
    'Расхождение терминала -90 ₸',
  );
  await tap(ops.templateValues(legacyShift, 'shift').opsCloseKeys, ['⌫', '⌫', '9', '0']);
  values = ops.templateValues(legacyShift, 'shift');
  assert.equal(values.opsCloseDiff, 'Совпадает с кассой');
  await values.opsCloseNext();
  values = ops.templateValues(legacyShift, 'shift');
  assert.equal(values.opsCloseTitle, '4 · Чеки Webkassa');
  assert.equal(
    values.opsCloseNote,
    'Не оформлено: 2 на 13 980 ₸. Закрыть смену можно только с PIN начальника смены.',
  );
  assert.equal(values.opsCloseAction, 'Оформить чеки сейчас');
  await values.opsCloseNext();
  values = ops.templateValues(legacyShift, 'shift');
  assert.deepEqual(
    [values.opsCloseTitle, values.opsCloseNote],
    ['5 · Причина', 'Расхождений нет.'],
  );
  await values.opsCloseNext();
  values = ops.templateValues(legacyShift, 'shift');
  assert.equal(values.opsCloseCta, 'Закрыть смену · PIN начальника смены');
  await values.opsCloseNext();
  assert.equal(view.values().saleApprovalSub, 'Закрытие смены · не оформлено чеков Webkassa: 2');
  await pinTap(view, '1111');
  assert.equal(view.values().saleApprovalError, 'Неверный PIN или нет доступа к рабочему месту');
  assert.equal(edge.edge.ops.length, 0, 'a wrong PIN changes nothing');
  await pinTap(view, MANAGER_PIN);
  assert.equal(credentials, 2);
  assert.equal(view.values().saleApprovalOpen, false);
  assert.deepEqual(lastOp(edge).body, {
    expected_version: 1,
    counted_cash_minor: '1199000',
    reason: 'Закрытие смены',
    terminal_reported_minor: '699000',
    approval: { approval_id: [...edge.edge.approvals.keys()].at(-1), token: 'c'.repeat(64) },
  });
  assert.equal(
    edge.edge.approvals.get([...edge.edge.approvals.keys()].at(-1)).action,
    'shift_close_pending_fiscal',
  );
  values = ops.templateValues(legacyShift, 'shift');
  assert.equal(values.isOpsClose, false);
  assert.equal(values.isOpsReport, true);
  assert.equal(values.opsReportTitle, 'Z-отчёт PickChick (не фискальный)');
  assert.equal(values.opsReportZ, true);
  assert.ok(said.includes('Смена закрыта. Не забудьте закрыть смену в кабинете Webkassa.'));
  assert.ok(values.opsReportLines.some((l) => l.text === 'Расхождение терминала Kaspi: 0 ₸'));
  await values.opsReportClose();
  assert.equal(ended(), 1, 'the desk is locked after the Z report');
});

test('screens: a discrepancy at closing needs a typed reason', async () => {
  const edge = saleEdge();
  edge.actor.role = 'shift_manager';
  edge.credential.role = 'shift_manager';
  const config = posConfigFor();
  config.methods.find((m) => m.code === 'kaspi_terminal').enabled = false;
  edge.edge.config = config;
  const model = await saleCashier(edge);
  const { view, ops, said } = opsScreens(model);
  await ops.templateValues(legacyShift, 'shift').startClose();
  let values = ops.templateValues(legacyShift, 'shift');
  assert.equal(values.opsCloseSteps.length, 5, 'no Kaspi terminal step without the method');
  await values.opsCloseNext();
  await tap(ops.templateValues(legacyShift, 'shift').opsCloseKeys, ['4', '9', '0', '0']);
  values = ops.templateValues(legacyShift, 'shift');
  assert.equal(values.opsCloseDiff, 'Расхождение -100 ₸');
  await values.opsCloseNext();
  assert.equal(ops.templateValues(legacyShift, 'shift').opsCloseTitle, '4 · Чеки Webkassa');
  await ops.templateValues(legacyShift, 'shift').opsCloseNext();
  values = ops.templateValues(legacyShift, 'shift');
  assert.equal(values.opsCloseField, true);
  await values.opsCloseNext();
  assert.equal(said.at(-1), 'Укажите причину - от 3 до 300 символов');
  await values.opsCloseFieldPick();
  await tap(view.values().saleEntryKeys, ['Н', 'Е', 'Д', 'О', 'С', 'Т', 'А', 'Ч', 'А']);
  await view.values().saleEntrySave();
  values = ops.templateValues(legacyShift, 'shift');
  assert.equal(values.opsCloseFieldValue, 'Недостача');
  await values.opsCloseNext();
  assert.equal(ops.templateValues(legacyShift, 'shift').opsCloseTitle, '6 · PIN начальника смены');
  await ops.templateValues(legacyShift, 'shift').opsCloseBack();
  assert.equal(ops.templateValues(legacyShift, 'shift').opsCloseTitle, '5 · Причина');
});

test('screens: every part B text is Russian copy with the plain hyphen only', async () => {
  const edge = saleEdge();
  edge.actor.role = 'shift_manager';
  edge.credential.role = 'shift_manager';
  const model = await saleCashier(edge);
  const { ops, view } = opsScreens(model);
  await reviewed(model, edge);
  await model.sell({ method: 'cash', tendered_minor: '700000' });
  const id = model.state.sale.order_id;
  model.newDraft();
  const seen = [];
  const collect = (tab = 'shift') => seen.push(...texts(ops.templateValues(legacyShift, tab)));
  await ops.openCard(id);
  collect('fiscal');
  ops.startVoid();
  collect();
  ops.setState({ card: { mode: 'view' } });
  ops.startRefund();
  collect();
  ops.closeCard();
  await ops.openX();
  collect();
  ops.setState({ report: null });
  await ops.startClose();
  for (let step = 1; step <= 6; step++) {
    ops.setState({ close: { ...ops.state.close, step } });
    collect();
  }
  for (const purpose of ['opsReason', 'fiscalNumber', 'closeReason']) {
    view.setState({ entry: { purpose, value: '' } });
    seen.push(...texts(view.values()));
  }
  for (const code of [
    'REFUND_REASON_REQUIRED',
    'REFUND_AMOUNT_INVALID',
    'FISCAL_SALE_ANSWER_REQUIRED',
    'SALE_NOT_ACTIVE',
    'RECEIPT_NUMBER_SAME',
    'PRINTER_NOT_CONFIGURED',
    'PRINT_FAILED',
  ])
    seen.push(saleErrorMessage(new Error(code)));
  assert.ok(seen.length > 100);
  for (const text of seen) assert.ok(!/[\u2013\u2014]/.test(text), text);
});

// ---- Cutover 19.11 (CL-3): tickets and the cash drawer from the cashier screens -------------

/** The pos-desktop printer bridge (preload): answers what main would answer. */
function printerBridge(answers = {}) {
  const calls = [];
  return {
    calls,
    answers,
    print: async (ticket) => {
      calls.push(['print', ticket]);
      return answers.print ?? { state: 'sent' };
    },
    openDrawer: async () => {
      calls.push(['drawer']);
      return answers.drawer ?? { state: 'sent' };
    },
  };
}
/** SaleView and OpsView wired as in app.js: the sale hands its drawer and ticket to ops. */
function wiredScreens(model, printer) {
  const said = [];
  const guard =
    (fn) =>
    async (...args) => {
      if (model.state.busy || model.state.pending) return;
      await fn(...args);
    };
  let ops;
  const view = new SaleView(model, {
    onChange: () => {},
    guard,
    say: (text) => said.push(text),
    pinLength: 4,
    next: () => {
      model.newDraft();
      view.reset();
    },
    onSold: (paid) => ops.sold(paid),
    printOrder: () => ops.printOrder(),
  });
  ops = new OpsView(model, view, {
    onChange: () => {},
    guard,
    say: (text) => said.push(text),
    setTab: () => {},
    pinCredential: async () => {
      throw new Error('Неверный PIN или нет доступа к рабочему месту');
    },
    logoutCredential: async () => {},
    endSession: () => {},
    printer,
    terminalLabel: 'Тестовая точка',
  });
  return { view, ops, said };
}
async function payOnScreen(view, method, cash) {
  view.setState({ screen: 'pay', method, cash: cash ?? '' });
  await view.values().salePayConfirm();
  assert.equal(view.values().isSaleDone, true);
}

test('screens: a cash sale opens the drawer once; the done screen prints the order ticket', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  const printer = printerBridge();
  const { view, said } = wiredScreens(model, printer);
  await reviewed(model, edge, 'takeaway');
  await payOnScreen(view, 'cash', '10000');
  assert.deepEqual(printer.calls, [['drawer']], 'one pulse, nothing printed by itself');
  assert.deepEqual(said, [], 'a drawer that opened says nothing');
  await view.values().saleDonePrint();
  assert.equal(printer.calls.length, 2);
  const ticket = printer.calls[1][1];
  assert.deepEqual(
    { ...ticket, printed_at: 'x' },
    {
      kind: 'order',
      title: 'Чек заказа (не фискальный)',
      display_number: '27',
      pickup_text: 'Забрать на выдаче',
      lines: [{ name: 'Комбо на двоих', quantity: 1, total_minor: '699000', options: [] }],
      totals: [{ label: 'Итого', amount_minor: '699000' }],
      tenders: [{ method: 'cash', label: 'Наличные', amount_minor: '699000' }],
      change_minor: '301000',
      printed_at: 'x',
      terminal_label: 'Тестовая точка',
    },
  );
  // Main accepts exactly what the renderer sends (apps/pos-desktop/printer.mjs).
  assert.deepEqual(parseTicket(ticket), ticket);
  assert.equal(said.at(-1), 'Отправлено на печать');
  // Every answer of main has its own words; none is printed again by itself.
  for (const [answer, text] of [
    [{ state: 'unknown' }, saleErrorMessage(new Error('PRINT_UNKNOWN'))],
    [{ state: 'failed' }, saleErrorMessage(new Error('PRINT_FAILED'))],
    [{ state: 'failed', code: 'PRINTER_BUSY' }, saleErrorMessage(new Error('PRINTER_BUSY'))],
    [{ state: 'not_configured' }, 'Печать не настроена'],
    [undefined, saleErrorMessage(new Error('PRINT_UNKNOWN'))],
  ]) {
    printer.answers.print = answer ?? null;
    if (!answer) printer.print = async (t) => (printer.calls.push(['print', t]), undefined);
    const before = printer.calls.length;
    await view.values().saleDonePrint();
    assert.equal(printer.calls.length, before + 1);
    assert.equal(said.at(-1), text, JSON.stringify(answer));
  }
  assert.equal(
    saleErrorMessage(new Error('PRINT_UNKNOWN')),
    'Неизвестно, напечатан ли чек. Проверьте принтер; при необходимости повторите печать вручную.',
  );
  assert.equal(model.state.pending, null, 'printing never touches the command journal');
});

test('screens: only cash opens the drawer; a drawer that did not open is said once', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  const printer = printerBridge();
  const { view, said } = wiredScreens(model, printer);
  await reviewed(model, edge);
  await payOnScreen(view, 'kaspi_terminal');
  assert.deepEqual(printer.calls, [], 'no drawer for a Kaspi terminal sale');
  await view.values().saleNext();
  printer.answers.drawer = { state: 'unknown' };
  await reviewed(model, edge);
  await payOnScreen(view, 'cash', '7000');
  assert.deepEqual(printer.calls, [['drawer']]);
  assert.equal(said.at(-1), 'Неизвестно, открылся ли ящик - проверьте его');
  assert.equal(drawerMessage({ state: 'failed' }, true), 'Ящик не открылся - откройте его ключом');
  assert.equal(drawerMessage({ state: 'unsupported' }, true), null);
  assert.equal(drawerMessage({ state: 'not_configured' }, true), null);
  assert.equal(drawerMessage({ state: 'sent' }, true), null);
  // The shift tab button says every answer.
  assert.equal(drawerMessage({ state: 'sent' }), 'Ящик кассы открыт');
  assert.equal(drawerMessage({ state: 'unsupported' }), 'Ящик открывается ключом');
  assert.equal(drawerMessage({ state: 'not_configured' }), 'Печать не настроена');
  assert.equal(printMessage({ state: 'sent' }), 'Отправлено на печать');
});

test('screens: without a printer the sale completes and printing says "Печать не настроена"', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  const { view, said } = wiredScreens(model, undefined);
  await reviewed(model, edge);
  await payOnScreen(view, 'cash', '7000');
  assert.equal(model.state.sale.display_number, '27');
  assert.deepEqual(said, [], 'no drawer message without a printer');
  await view.values().saleDonePrint();
  assert.equal(said.at(-1), 'Печать не настроена');
  // The browser cashier (no printOrder at all) says the same.
  const bare = screens(model);
  bare.view.done();
  await bare.view.values().saleDonePrint();
  assert.equal(bare.said.at(-1), 'Печать не настроена');
});

test('screens: the order card reprints the order ticket and the slip of each refund; cash refunds open the drawer', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  const printer = printerBridge();
  const { view, ops } = wiredScreens(model, printer);
  await reviewed(model, edge);
  await model.sell({
    method: 'mixed',
    parts: [
      { method: 'cash', amount_minor: '199000' },
      { method: 'kaspi_terminal', amount_minor: '500000' },
    ],
    tendered_minor: '200000',
  });
  const id = model.state.sale.order_id;
  model.newDraft();
  await ops.openCard(id);
  await ops.templateValues(legacyShift, 'orders').opsCardPrint();
  let ticket = printer.calls.at(-1)[1];
  assert.equal(ticket.kind, 'order');
  assert.deepEqual(ticket.tenders, [
    { method: 'cash', label: 'Наличные', amount_minor: '199000' },
    { method: 'kaspi_terminal', label: 'Kaspi терминал', amount_minor: '500000' },
  ]);
  assert.equal(ticket.change_minor, '1000');
  assert.deepEqual(parseTicket(ticket), ticket);
  // A Kaspi-only refund: no drawer.
  await ops.templateValues(legacyShift, 'orders').opsCardRefundPick();
  await ops.templateValues(legacyShift, 'orders').opsRefundTenders[1].all();
  await ops
    .templateValues(legacyShift, 'orders')
    .opsReasons.find((r) => r.label === 'Качество блюда')
    .pick();
  printer.calls.length = 0;
  await ops.templateValues(legacyShift, 'orders').opsConfirm();
  await pinTap(view, MANAGER_PIN);
  assert.deepEqual(printer.calls, [], 'no drawer when no cash goes back');
  // A cash refund: one pulse.
  await ops.templateValues(legacyShift, 'orders').opsCardRefundPick();
  await ops.templateValues(legacyShift, 'orders').opsRefundTenders[0].all();
  await ops
    .templateValues(legacyShift, 'orders')
    .opsReasons.find((r) => r.label === 'Качество блюда')
    .pick();
  await ops.templateValues(legacyShift, 'orders').opsConfirm();
  await pinTap(view, MANAGER_PIN);
  assert.deepEqual(printer.calls, [['drawer']]);
  const values = ops.templateValues(legacyShift, 'orders');
  assert.equal(values.opsCardRefunds.length, 2);
  await values.opsCardRefunds[0].print();
  ticket = printer.calls.at(-1)[1];
  assert.deepEqual(
    { ...ticket, printed_at: 'x' },
    {
      kind: 'refund',
      title: 'Возврат (не фискальный)',
      display_number: '27',
      totals: [{ label: 'Возвращено', amount_minor: '500000' }],
      tenders: [{ method: 'kaspi_terminal', label: 'Kaspi терминал', amount_minor: '500000' }],
      printed_at: 'x',
      terminal_label: 'Тестовая точка',
    },
  );
  assert.deepEqual(parseTicket(ticket), { ...ticket, lines: [] });
  const sale = model.state.sale;
  const slip = refundTicket(sale, { ...sale.refunds[0], kind: 'void' }, 'Касса');
  assert.equal(slip.title, 'Отмена заказа (не фискальный)');
  assert.deepEqual(slip.totals, [{ label: 'Отменено', amount_minor: '500000' }]);
  assert.equal(orderTicket(model.state.order, sale, 'Касса').kind, 'order');
});

test('screens: the X report ticket of the renderer is a valid PosTicket for main', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  const printer = printerBridge();
  const { ops, said } = wiredScreens(model, printer);
  await reviewed(model, edge);
  await model.sell({ method: 'cash', tendered_minor: '700000' });
  model.newDraft();
  await ops.templateValues(legacyShift, 'shift').sayX();
  await ops.templateValues(legacyShift, 'shift').opsReportPrint();
  const ticket = printer.calls.at(-1)[1];
  assert.equal(ticket.kind, 'x_report');
  assert.deepEqual(parseTicket(ticket), ticket);
  // The shift tab drawer button of a Windows-driver desk: the drawer opens by key.
  printer.answers.drawer = { state: 'unsupported' };
  await ops.templateValues(legacyShift, 'shift').sayDrawer();
  assert.deepEqual(printer.calls.at(-1), ['drawer']);
  assert.equal(said.at(-1), 'Ящик открывается ключом');
});

test('screens: voiding a cash sale opens the drawer once; the void slip prints', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  const printer = printerBridge();
  const { view, ops } = wiredScreens(model, printer);
  await reviewed(model, edge);
  await model.sell({ method: 'cash', tendered_minor: '700000' });
  const id = model.state.sale.order_id;
  model.newDraft();
  await ops.openCard(id);
  await ops.templateValues(legacyShift, 'orders').opsCardVoidPick();
  await ops
    .templateValues(legacyShift, 'orders')
    .opsReasons.find((r) => r.label === 'Гость передумал')
    .pick();
  await ops
    .templateValues(legacyShift, 'orders')
    .opsVoidAnswers.find((a) => a.label === 'Чек продажи не пробит')
    .pick();
  await ops.templateValues(legacyShift, 'orders').opsConfirm();
  assert.deepEqual(printer.calls, []);
  await pinTap(view, MANAGER_PIN);
  assert.deepEqual(printer.calls, [['drawer']], 'the cash goes back from the drawer');
  await ops.templateValues(legacyShift, 'orders').opsCardRefunds[0].print();
  const slip = printer.calls.at(-1)[1];
  assert.equal(slip.title, 'Отмена заказа (не фискальный)');
  assert.deepEqual(slip.totals, [{ label: 'Отменено', amount_minor: '699000' }]);
  assert.deepEqual(parseTicket(slip), { ...slip, lines: [] });
});

// ---- CR client-5: test-mode texts of today's screens on a desk that sells ------------------

test('mode texts: a desk without payments keeps today texts byte for byte', () => {
  // Exactly the strings of D0 (apps/pos/src/v2/app.js and template.html before CR client-5).
  assert.deepEqual(TEST_TEXTS, {
    shiftOpened: 'Тестовая смена открыта',
    shiftClosed: 'Тестовая смена закрыта. Фискальный Z-отчёт не формировался.',
    closeReason: 'Тестовая смена без оплаты',
    unavailable: 'В тестовом режиме эта интеграция не подключена. Деньги и чеки не проводятся.',
    findGuest: 'Поиск аккаунтов и Чики подключим отдельно. Для теста укажите имя на табло.',
    kitchenOff: 'Тестовая передача на кухню ещё не включена оператором.',
    deskPrefix: 'Касса 1 · ',
    deskChip: ' · касса 1',
    appLine: 'Pick Chick POS 0.4 · TEST',
  });
  const testShift = fixture().shift;
  assert.equal(testShift.payment_processing_available, false);
  for (const shift of [testShift, null, undefined]) {
    assert.equal(shiftOpenedText(shift), 'Тестовая смена открыта');
    assert.equal(
      shiftClosedText(shift),
      'Тестовая смена закрыта. Фискальный Z-отчёт не формировался.',
    );
    assert.equal(closeReasonText(shift), 'Тестовая смена без оплаты');
  }
  assert.equal(unavailableText(false), TEST_TEXTS.unavailable);
  assert.equal(findGuestText(false), TEST_TEXTS.findGuest);
  for (const ordering of [
    null,
    { pos_service_mode: 'payment_required' },
    { pos_service_mode: 'unpaid_service' },
    {},
  ])
    assert.equal(kitchenOffText(ordering), TEST_TEXTS.kitchenOff, JSON.stringify(ordering));
  // The app version never reaches a desk without payments: its footer stays as it was.
  for (const version of ['0.5.0', undefined, 'x'])
    assert.deepEqual(deskTexts(false, version), {
      deskPrefix: 'Касса 1 · ',
      deskChip: ' · касса 1',
      appLine: 'Pick Chick POS 0.4 · TEST',
    });
});

test('mode texts: a desk that sells names no test, no wrong desk and its real version', () => {
  const sales = { ...fixture().shift, payment_processing_available: true };
  assert.equal(shiftOpenedText(sales), 'Смена открыта');
  assert.equal(
    shiftClosedText(sales),
    'Смена закрыта. Не забудьте закрыть смену в кабинете Webkassa.',
  );
  assert.equal(closeReasonText(sales), 'Закрытие смены');
  assert.equal(unavailableText(true), 'Эта функция пока не подключена.');
  assert.equal(
    findGuestText(true),
    'Поиск аккаунтов и Чики подключим отдельно. Укажите имя на табло.',
  );
  assert.equal(
    kitchenOffText({ pos_service_mode: 'pos_sale' }),
    'Касса получает настройки оплаты - повторите через полминуты.',
  );
  assert.deepEqual(deskTexts(true, '0.5.0'), {
    deskPrefix: '',
    deskChip: '',
    appLine: 'Pick Chick POS 0.5.0',
  });
  assert.equal(deskTexts(true, '0.5.1-rc.2').appLine, 'Pick Chick POS 0.5.1-rc.2');
  for (const version of [undefined, null, '', '0.5', '0.5.0+build', '<b>1.0.0</b>', 5])
    assert.equal(deskTexts(true, version).appLine, 'Pick Chick POS', String(version));
  for (const text of texts(PAID_TEXTS)) {
    assert.doesNotMatch(text, /тест|test/i, text);
    assert.doesNotMatch(text, /[‒-―]/, 'plain hyphen only: ' + text);
    assert.doesNotMatch(text, /Касса \d|касса \d/, text);
  }
});

test('mode texts: the lock screen keeps the edge last definite answer per desk', () => {
  const storage = memory();
  assert.equal(storedDeskPaid(storage), false, 'a desk never told anything shows today texts');
  const config = (mode) => ({ posConfig: { mode }, posConfigMissing: false });
  const unknown = { posConfig: null, posConfigMissing: false };
  // A desk without payments writes nothing at all.
  assert.equal(rememberDeskMode(storage, config('unpaid_service'), false), false);
  assert.equal(
    rememberDeskMode(storage, { posConfig: null, posConfigMissing: true }, false),
    false,
  );
  assert.equal(storage.data.size, 0);
  // pos_sale is kept for the next lock screen, also after a restart (read back from storage).
  assert.equal(rememberDeskMode(storage, config('pos_sale'), false), true);
  assert.equal(storage.data.get(DESK_MODE_KEY), 'pos_sale');
  assert.equal(storedDeskPaid(storage), true);
  // No session or a failed read is no answer: the last one stays.
  assert.equal(rememberDeskMode(storage, unknown, true), true);
  assert.equal(storage.data.get(DESK_MODE_KEY), 'pos_sale');
  // Back to unpaid (rollback, or 404 of an edge without schema026): today texts again.
  assert.equal(rememberDeskMode(storage, config('unpaid_service'), true), false);
  assert.equal(storedDeskPaid(storage), false);
  assert.equal(rememberDeskMode(storage, config('pos_sale'), false), true);
  assert.equal(rememberDeskMode(storage, { posConfig: null, posConfigMissing: true }, true), false);
  assert.equal(storedDeskPaid(storage), false);
  // Blocked storage never breaks the screen; only the hint is lost after a restart.
  const blocked = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(storedDeskPaid(blocked), false);
  assert.equal(rememberDeskMode(blocked, config('pos_sale'), false), true);
  assert.equal(storedDeskPaid(undefined), false);
});

test('screens: a paid order row says its Webkassa receipt as the X report counts it', () => {
  const order = (execution_mode) => ({ order_id: randomUUID(), execution_mode });
  assert.deepEqual(receiptRow(order('unpaid_service'), undefined), {
    fiscalLabel: 'без чека',
    fiscal: 'var(--n300)',
  });
  assert.deepEqual(receiptRow(order(undefined), 'pending'), {
    fiscalLabel: 'без чека',
    fiscal: 'var(--n300)',
  });
  const paid = order('pos_sale');
  assert.deepEqual(
    ['pending', 'recorded', 'not_required', undefined].map((state) => receiptRow(paid, state)),
    [
      { fiscalLabel: 'не оформлен', fiscal: 'var(--orange)' },
      { fiscalLabel: 'оформлен', fiscal: '#0B7A3B' },
      { fiscalLabel: 'не нужен', fiscal: 'var(--n600)' },
      { fiscalLabel: '-', fiscal: 'var(--n300)' },
    ],
  );
  // The words of the X report line «Чеки Webkassa: оформлено …, не оформлено …, не нужен …».
  const line = reportLines({
    discrepancy_minor: null,
    terminal_discrepancy_minor: null,
    orders: { count: 3, voided_count: 0 },
    fiscal: { pending: 1, recorded: 1, not_required: 1 },
  }).find((text) => text.startsWith('Чеки Webkassa'));
  assert.equal(line, 'Чеки Webkassa: оформлено 1, не оформлено 1, не нужен 1');
});

/** A desk that sells, with the orders feed listing the sales of the synthetic edge. */
function feedEdge(edge) {
  return {
    ...edge,
    api: async (path, auth, options) =>
      path === 'orders'
        ? {
            orders: [...edge.edge.orders.values()].reverse(),
            server_time: new Date().toISOString(),
          }
        : edge.api(path, auth, options),
  };
}

test('ЗАКАЗЫ in the paid mode: each paid row is read once; a pending receipt again after the pause', async () => {
  const edge = saleEdge();
  const seller = await saleCashier(edge);
  for (const payment of [
    { method: 'cash', tendered_minor: '700000' },
    { method: 'chocofood', external_order_ref: 'CF-100' },
    { method: 'kaspi_manual' },
  ]) {
    await reviewed(seller, edge);
    await seller.sell(payment);
    assert.equal(seller.state.error, null, String(seller.state.error));
    seller.newDraft();
  }
  const [cash, choco, manual] = [...edge.edge.sales.values()];
  // The desk sold them: their receipts are known without any extra read.
  assert.deepEqual(seller.state.saleReceipts, {
    [cash.order_id]: 'pending',
    [choco.order_id]: 'not_required',
    [manual.order_id]: 'pending',
  });
  // The next cashier of the desk (a new session) reads each listed paid order once.
  let now = Date.now();
  const desk = feedEdge(edge);
  const model = await saleCashier(desk, memory(), memory(), { now: () => now });
  assert.deepEqual(model.state.saleReceipts, {});
  const ids = model.state.orders.map((o) => o.order_id);
  assert.deepEqual(ids, [manual.order_id, choco.order_id, cash.order_id], 'newest first');
  const reads = () => edge.calls.filter((c) => /^pos\/sales\/[0-9a-f-]+$/.test(c.path));
  const before = reads().length;
  await model.refreshSaleReceipts([...ids, randomUUID()]);
  assert.deepEqual(
    reads()
      .slice(before)
      .map((c) => c.path),
    ids.map((id) => `pos/sales/${id}`),
    'only listed paid orders, in the order of the rows',
  );
  assert.deepEqual(model.state.saleReceipts, {
    [cash.order_id]: 'pending',
    [choco.order_id]: 'not_required',
    [manual.order_id]: 'pending',
  });
  await model.refreshSaleReceipts(ids);
  assert.equal(reads().length, before + 3, 'nothing again before the pause');
  // The other desk records the cash receipt in Webkassa; after the pause only pending ones
  // are read again, and the cash one turns "оформлен".
  Object.assign(cash.fiscal[0], { state: 'recorded', receipt_number: 'TEST-WK-1', version: 2 });
  now += POS_CONFIG_POLL_MS;
  await model.refreshSaleReceipts(ids);
  assert.deepEqual(
    reads()
      .slice(before + 3)
      .map((c) => c.path),
    [`pos/sales/${manual.order_id}`, `pos/sales/${cash.order_id}`],
  );
  assert.equal(model.state.saleReceipts[cash.order_id], 'recorded');
  // A pending receipt on this shift's list needs no read: the list says it.
  now += POS_CONFIG_POLL_MS;
  await model.refreshFiscal();
  await model.refreshSaleReceipts(ids);
  assert.equal(reads().length, before + 5, 'recorded and not required stay; pending is listed');
  assert.equal(model.state.saleReceipts[manual.order_id], 'pending');
  // A read that fails is asked again only after the pause; the row keeps "-".
  const failing = feedEdge({
    ...edge,
    api: async (path, auth, options) => {
      if (/^pos\/sales\/[0-9a-f-]+$/.test(path)) throw new ApiError('EDGE_TIMEOUT', 504);
      return edge.api(path, auth, options);
    },
  });
  const other = await saleCashier(failing, memory(), memory(), { now: () => now });
  await other.refreshSaleReceipts(ids);
  await other.refreshSaleReceipts(ids);
  assert.deepEqual(other.state.saleReceipts, {});
  assert.equal(other.state.error, null, 'best effort: no error toast for a background read');
  // Leaving the paid mode forgets them.
  edge.edge.config = new ApiError('NOT_FOUND', 404);
  await model.refreshPosConfig(true);
  assert.equal(model.saleMode, false);
  assert.deepEqual(model.state.saleReceipts, {});
});

test('ЗАКАЗЫ in the paid mode: at most RECEIPT_READS reads per refresh; none without payments', async () => {
  const edge = saleEdge();
  const seller = await saleCashier(edge);
  for (let n = 0; n < RECEIPT_READS + 2; n++) {
    await reviewed(seller, edge);
    await seller.sell({ method: 'cash', tendered_minor: '700000' });
    seller.newDraft();
  }
  const desk = feedEdge(edge);
  const model = await saleCashier(desk);
  const ids = model.state.orders.map((o) => o.order_id);
  assert.equal(ids.length, RECEIPT_READS + 2);
  const reads = () => edge.calls.filter((c) => /^pos\/sales\/[0-9a-f-]+$/.test(c.path)).length;
  const before = reads();
  await model.refreshSaleReceipts(ids);
  assert.equal(reads() - before, RECEIPT_READS);
  await model.refreshSaleReceipts(ids);
  assert.equal(reads() - before, RECEIPT_READS + 2, 'the rest at the next refresh');
  assert.equal(Object.keys(model.state.saleReceipts).length, RECEIPT_READS + 2);
  // An edge without paid sales (pos/config 404): the same rows ask nothing.
  const f = fixture();
  const calls = [];
  const unpaid = new PosController(
    async (path, auth, options) => {
      calls.push(path);
      if (path === 'pos/config') throw new ApiError('NOT_FOUND', 404);
      return f.api(path, auth, options);
    },
    memory(),
    memory(),
    randomUUID,
  );
  await unpaid.login(JSON.stringify(f.credential));
  const asked = calls.length;
  await unpaid.refreshSaleReceipts(ids);
  assert.equal(calls.length, asked);
});

test('screens: «Чек» of a paid row: the Webkassa entry of a receipt to punch, else the order ticket', async () => {
  const edge = saleEdge();
  const model = await saleCashier(edge);
  const printer = printerBridge();
  const { view, ops, said } = wiredScreens(model, printer);
  await reviewed(model, edge, 'takeaway');
  await model.sell({ method: 'kaspi_manual' });
  const sale = model.state.sale;
  model.newDraft();
  // Not punched yet: the card of the order opens at the number entry, nothing is printed.
  await ops.printReceipt(sale.order_id);
  assert.equal(ops.state.card?.mode, 'view', 'the card shows its Webkassa receipt');
  assert.deepEqual(
    ops.cardValues().opsCardReceipts.map((r) => [r.text, r.action]),
    [['Чек продажи · 6 990 ₸ · не оформлен', 'Внести номер']],
  );
  assert.equal(view.state.entry?.purpose, 'fiscalNumber');
  assert.equal(view.values().saleEntryTitle, 'Номер чека Webkassa');
  assert.deepEqual(printer.calls, [], 'no paper the cashier did not ask for');
  view.setState({ entry: { ...view.state.entry, value: 'WK-7' } });
  await view.saveEntry();
  assert.equal(said.at(-1), 'Номер чека Webkassa сохранён');
  assert.equal(model.state.saleReceipts[sale.order_id], 'recorded', 'the row says оформлен');
  ops.closeCard();
  // Punched (or not needed): «Чек» prints «Чек заказа (не фискальный)» once.
  await ops.printReceipt(sale.order_id);
  assert.equal(ops.state.card?.mode, 'view');
  assert.equal(view.state.entry, null);
  assert.equal(printer.calls.length, 1);
  const [kind, ticket] = printer.calls[0];
  assert.equal(kind, 'print');
  assert.equal(ticket.title, 'Чек заказа (не фискальный)');
  assert.equal(ticket.display_number, sale.display_number);
  assert.deepEqual(parseTicket(ticket), ticket);
  assert.equal(said.at(-1), 'Отправлено на печать');
  // Without a printer the card still opens and the desk says so; nothing claims a test mode.
  const bare = wiredScreens(model, undefined);
  await bare.ops.printReceipt(sale.order_id);
  assert.equal(bare.ops.state.card?.mode, 'view');
  assert.equal(bare.said.at(-1), 'Печать не настроена');
  assert.ok(![...said, ...bare.said].some((t) => /тест/i.test(t)), bare.said.join(' | '));
  // A cancelled order prints nothing by itself: its card has the slip of the void.
  bare.ops.closeCard();
  const voided = edge.edge.orders.get(sale.order_id);
  Object.assign(voided, {
    state: 'cancelled',
    version: voided.version + 1,
    fulfillment_state: 'cancelled',
    fulfillment: { ...voided.fulfillment, version: 2, state: 'cancelled' },
    cancellation_reason: 'Синтетическая отмена',
  });
  const quiet = printerBridge();
  const after = wiredScreens(model, quiet);
  await after.ops.printReceipt(sale.order_id);
  assert.equal(after.ops.state.card?.mode, 'view');
  assert.equal(after.view.state.entry, null);
  assert.deepEqual(quiet.calls, []);
});

test('web POS publishes the app version for the lock screen only when it is given', async () => {
  const { createPosServer } = await import('../../apps/pos/server.mjs');
  for (const bad of ['', '0.5', '0.5.0+build', 5, '1.0.0 '])
    assert.throws(() => createPosServer({ appVersion: bad }), /app version/, String(bad));
  for (const [options, expected] of [
    [{}, undefined],
    [{ appVersion: '0.5.0' }, '0.5.0'],
  ]) {
    const pos = createPosServer({ edgePort: 9, ...options });
    await new Promise((resolve) => pos.listen(0, '127.0.0.1', resolve));
    try {
      const config = await (
        await fetch(`http://127.0.0.1:${pos.address().port}/config.json`)
      ).json();
      assert.equal(config.appVersion, expected);
      if (expected === undefined)
        assert.deepEqual(Object.keys(config).sort(), ['branchLabel', 'categories']);
    } finally {
      await new Promise((resolve) => pos.close(resolve));
    }
  }
});
