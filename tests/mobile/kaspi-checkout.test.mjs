import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  KASPI_PENDING_KEY,
  KaspiCheckoutCore,
  KaspiCheckoutError,
  kaspiCart,
  kaspiErrorMessage,
  kaspiStageCopy,
  parseKaspiStatus,
  parseKaspiView,
} from '../../apps/mobile/src/kaspi-checkout.ts';
const { structuredClone } = globalThis;

// In-memory stand-in for /v1/customer/checkout with the server's idempotency rules:
// a replayed key returns the stored result, a new pay key creates at most one attempt.
function server() {
  const quotes = new Map(),
    orders = new Map(),
    keys = new Map(),
    calls = [];
  let expireNextOrder = false;
  let loseNextResponse = false;
  const view = (order) => ({
    order_id: order.id,
    stage: order.stage,
    total_minor: order.total,
    service_mode: 'takeaway',
    lines: [{ title: 'Pick Combo', quantity: 1, total_minor: order.total }],
    invoice:
      order.stage === 'invoice_sent'
        ? { expires_at: '2026-09-29T10:10:00.000Z', closed_reason: null }
        : order.stage === 'invoice_closed'
          ? { expires_at: null, closed_reason: 'expired' }
          : null,
    can_retry: order.stage === 'invoice_closed',
    kitchen_queued: false,
  });
  const once = (key, run) => {
    if (keys.has(key)) return keys.get(key);
    const result = run();
    keys.set(key, result);
    return result;
  };
  const handle = (path, body, key) => {
    calls.push([path, key ?? null]);
    if (path === '')
      return { enabled: true, payment_method: 'kaspi', phone_masked: '+7 701 ••• •• 67' };
    if (path === '/quotes')
      return once(key, () => {
        const id = randomUUID();
        quotes.set(id, { expired: false });
        return { quote_id: id, total_minor: '350000', currency: 'KZT', expires_at: '', lines: [] };
      });
    if (path === '/orders') {
      if (expireNextOrder) {
        expireNextOrder = false;
        throw new KaspiCheckoutError(409, 'QUOTE_EXPIRED');
      }
      return once(key, () => {
        const order = { id: randomUUID(), stage: 'accepting', total: '350000', attempts: 0 };
        orders.set(order.id, order);
        return view(order);
      });
    }
    const pay = path.match(/^\/orders\/([^/]+)\/kaspi-payment$/);
    if (pay) {
      const order = orders.get(pay[1]);
      if (!['ready_to_pay', 'invoice_closed'].includes(order.stage)) return view(order);
      return once(key, () => {
        order.attempts++;
        order.stage = 'sending_invoice';
        return view(order);
      });
    }
    const read = path.match(/^\/orders\/([^/]+)$/);
    if (read) {
      const order = orders.get(read[1]);
      if (!order) throw new KaspiCheckoutError(404, 'NOT_FOUND');
      return view(order);
    }
    throw new Error('unexpected ' + path);
  };
  return {
    calls,
    orders,
    set expireNextOrder(v) {
      expireNextOrder = v;
    },
    set loseNextResponse(v) {
      loseNextResponse = v;
    },
    async request(path, body, key) {
      const result = handle(path, body, key);
      if (loseNextResponse && body !== undefined) {
        loseNextResponse = false;
        throw new KaspiCheckoutError(0, 'NETWORK');
      }
      return structuredClone(result);
    },
  };
}
function device(api, storage = new Map()) {
  return {
    storage,
    core: new KaspiCheckoutCore({
      request: (path, body, key) => api.request(path, body, key),
      read: async (key) => storage.get(key) ?? null,
      write: async (key, raw) => void storage.set(key, raw),
      remove: async (key) => void storage.delete(key),
      uuid: randomUUID,
    }),
  };
}
const product = (id) => ({
  id,
  name: id,
  description: '',
  category: '',
  priceMinor: '1',
  image: 0,
  source: 'server',
});
const cart = kaspiCart(
  [
    {
      product: product('pick-combo'),
      quantity: 1,
      selections: [{ group_id: 'drink', option_id: 'cola', quantity: 1 }],
    },
  ],
  'takeaway',
);

test('cart is sent as SKUs and selections only, never prices', () => {
  assert.deepEqual(cart, {
    service_mode: 'takeaway',
    items: [
      {
        sku: 'pick-combo',
        quantity: 1,
        selections: [{ group_id: 'drink', option_id: 'cola', quantity: 1 }],
      },
    ],
  });
  assert.equal(JSON.stringify(cart).includes('priceMinor'), false);
});

test('checkout creates one order and waits for the restaurant before any invoice', async () => {
  const api = server();
  const { core } = device(api);
  let view = await core.checkout(cart);
  assert.equal(view.stage, 'accepting');
  assert.equal(api.orders.size, 1);
  // The restaurant accepts; the same intent key now requests the invoice once.
  api.orders.get(view.order_id).stage = 'ready_to_pay';
  view = await core.pay(view.order_id);
  assert.equal(view.stage, 'sending_invoice');
  view = await core.pay(view.order_id);
  assert.equal(api.orders.get(view.order_id).attempts, 1);
});

test('lost responses and app restarts replay the same keys: no duplicate order', async () => {
  const api = server();
  const storage = new Map();
  api.loseNextResponse = true;
  await assert.rejects(device(api, storage).core.checkout(cart), KaspiCheckoutError);
  api.loseNextResponse = true;
  await assert.rejects(device(api, storage).core.checkout(cart), KaspiCheckoutError);
  const view = await device(api, storage).core.checkout(cart);
  assert.equal(api.orders.size, 1);
  assert.equal(await device(api, storage).core.currentOrderId(), view.order_id);
});

test('an expired quote is re-priced once with new keys', async () => {
  const api = server();
  const { core } = device(api);
  api.expireNextOrder = true;
  const view = await core.checkout(cart);
  assert.equal(view.stage, 'accepting');
  assert.equal(api.calls.filter(([p]) => p === '/quotes').length, 2);
});

test('an open order blocks a different cart; a closed invoice is re-sent only with a new key', async () => {
  const api = server();
  const { core, storage } = device(api);
  let view = await core.checkout(cart);
  const other = kaspiCart([{ product: product('fries'), quantity: 2 }], 'takeaway');
  await assert.rejects(core.checkout(other), (e) => e.code === 'PREVIOUS_ORDER_PENDING');
  const order = api.orders.get(view.order_id);
  order.stage = 'ready_to_pay';
  view = await core.checkout(cart);
  assert.equal(view.stage, 'sending_invoice');
  order.stage = 'invoice_closed';
  // Checking out the same cart again asks for a new invoice on the same order.
  view = await core.checkout(cart);
  assert.equal(order.attempts, 2);
  assert.equal(api.orders.size, 1);
  // After payment the draft is forgotten and the next cart is a new order.
  order.stage = 'paid';
  await core.finish(await core.read(view.order_id));
  assert.equal(storage.has(KASPI_PENDING_KEY), false);
  await core.checkout(other);
  assert.equal(api.orders.size, 2);
});

test('server responses are validated and unknown shapes rejected', () => {
  assert.throws(() => parseKaspiView({ order_id: 'x' }), KaspiCheckoutError);
  assert.throws(
    () =>
      parseKaspiView({
        order_id: randomUUID(),
        stage: 'paid_maybe',
        total_minor: '1',
        service_mode: 'takeaway',
        lines: [],
        invoice: null,
        can_retry: false,
        kitchen_queued: false,
      }),
    KaspiCheckoutError,
  );
  assert.deepEqual(parseKaspiStatus({ enabled: false }), { enabled: false, phoneMasked: null });
  assert.deepEqual(
    parseKaspiStatus({ enabled: true, payment_method: 'kaspi', phone_masked: '+77011234567' }),
    { enabled: true, phoneMasked: null },
  );
});

test('customer wording never claims payment before the server does', () => {
  const base = {
    order_id: randomUUID(),
    total_minor: '350000',
    service_mode: 'takeaway',
    lines: [],
    can_retry: false,
    kitchen_queued: false,
    invoice: null,
  };
  const copy = (stage, extra = {}) =>
    kaspiStageCopy({ ...base, stage, ...extra }, '+7 701 ••• •• 67');
  for (const stage of ['accepting', 'ready_to_pay', 'sending_invoice', 'checking', 'unconfirmed'])
    assert.doesNotMatch(copy(stage).title + copy(stage).body, /Оплачено|отправлен в Kaspi/);
  assert.match(copy('sending_invoice').body, /\+7\u00a0701\u00a0•••\u00a0••\u00a067/);
  const sent = copy('invoice_sent', {
    invoice: { expires_at: '2026-09-29T10:10:00.000Z', closed_reason: null },
  });
  assert.equal(sent.title, 'Счёт отправлен в Kaspi');
  assert.match(sent.body, /до 15:10/);
  assert.equal(copy('paid').title, 'Оплачено');
  assert.equal(
    copy('invoice_closed', { invoice: { expires_at: null, closed_reason: 'rejected' } }).title,
    'Счёт отклонён в Kaspi',
  );
  for (const stage of [
    'accepting',
    'invoice_sent',
    'checking',
    'paid',
    'invoice_closed',
    'unconfirmed',
    'attention',
  ])
    assert.doesNotMatch(copy(stage).title + copy(stage).body, /—/, 'owner rule: plain hyphen');
  assert.match(kaspiErrorMessage(new KaspiCheckoutError(409, 'ITEM_STOPPED')), /недоступна/);
  assert.match(kaspiErrorMessage(new Error('x')), /интернет/);
});
