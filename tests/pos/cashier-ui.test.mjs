import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PosController } from '../../apps/pos/dist/model.js';
import { ApiError } from '../../apps/pos/dist/api.js';
import { inputMoney, lineKey, linePrice, menu as parseMenu } from '../../apps/pos/dist/types.js';

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
