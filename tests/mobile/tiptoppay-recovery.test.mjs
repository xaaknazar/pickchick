import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ORDER_TTL_MS,
  HOLD_WINDOW_MS,
  CHARGE_IN_FLIGHT_MS,
  chargeLiveOrder,
  guardKaspiPress,
  intentNeedsServer,
  leaveForOtherMethod,
  settlePaidIntent,
  RETRY_WINDOW_MS,
  TIPTOPPAY_INTENT_MAX_AGE_MS,
  decideTipTopPay,
  holdAfterConflict,
  markChargeSent,
  newTipTopPayIntent,
  parseTipTopPayIntent,
  showStateOf,
  startLiveOrder,
  tipTopPayIntentKey,
} from '../../apps/mobile/src/tiptoppay-recovery.ts';
import { PAYMENT_IN_REVIEW_NOTICE } from '../../apps/mobile/src/commerce-presentation.ts';
import { translate } from '../../apps/mobile/src/i18n/core.ts';

// Audit 28.11 P0-2: the app never opens a second order or a second charge while the first
// TipTopPay payment may still be paid. The server answers CONFLICT for it; the app decides by its
// own orders and by the intent it saved before the charge left the phone.
const now = Date.parse('2026-11-28T12:00:00.000Z');
const iso = (offset) => new Date(now + offset).toISOString();
const CUSTOMER = '10000000-0000-4000-8000-000000000001';
const ORDER = '40000000-0000-4000-8000-000000000001';
const OTHER = '40000000-0000-4000-8000-000000000002';
const CART = JSON.stringify({ items: ['a'], mode: 'takeaway' });
const order = (phase, changes = {}) => ({
  orderId: ORDER,
  phase,
  createdAt: iso(-60_000),
  updatedAt: iso(-30_000),
  expiresAt: null,
  totalMinor: '250000',
  items: [{ productId: 'p', title: 'Pick', quantity: 1, totalMinor: '250000', modifiers: [] }],
  ...changes,
});
const intent = (changes = {}) => ({
  customerId: CUSTOMER,
  orderId: ORDER,
  method: 'apple_pay',
  createdAt: now - 60_000,
  signature: CART,
  ...changes,
});
const raw = (changes = {}) => JSON.stringify(intent(changes));
const parse = (value, at = now) => parseTipTopPayIntent(value, { customerId: CUSTOMER, now: at });

test('storage key is per customer', () => {
  assert.notEqual(tipTopPayIntentKey('a'), tipTopPayIntentKey('b'));
  assert.match(tipTopPayIntentKey('a'), /tiptoppay/);
});

test('(ж) a broken, foreign or old record is ignored, never thrown', () => {
  assert.deepEqual(parse(raw()), intent());
  assert.equal(parse(null), null);
  assert.equal(parse(''), null);
  assert.equal(parse('{not json'), null);
  assert.equal(parse('null'), null);
  assert.equal(parse('[]'), null);
  assert.equal(parse(raw({ orderId: 'nope' })), null);
  assert.equal(parse(raw({ method: 'kaspi' })), null);
  assert.equal(parse(raw({ createdAt: 'x' })), null);
  assert.equal(parse(raw({ createdAt: 0 })), null);
  assert.equal(parse(raw({ createdAt: now + 3_600_000 })), null);
  assert.equal(parse(raw({ sentAt: -5 })), null);
  assert.equal(parse(raw({ signature: 5 })), null);
  // Another customer's intent in this customer's slot.
  assert.equal(parse(raw({ customerId: '10000000-0000-4000-8000-000000000009' })), null);
  const noCustomer = intent();
  delete noCustomer.customerId;
  assert.equal(parse(JSON.stringify(noCustomer)), null);
  // Too old: ignored.
  assert.equal(parse(raw({ createdAt: now - TIPTOPPAY_INTENT_MAX_AGE_MS - 1 })), null);
  assert.ok(parse(raw({ createdAt: now - TIPTOPPAY_INTENT_MAX_AGE_MS + 1_000 })));
  // Unknown fields are dropped.
  assert.equal(parse(raw({ extra: 'x' })).extra, undefined);
});

test('intent builders keep the fields of the format', () => {
  const made = newTipTopPayIntent({
    customerId: CUSTOMER,
    orderId: ORDER,
    method: 'card',
    now,
    signature: CART,
  });
  assert.deepEqual(made, {
    customerId: CUSTOMER,
    orderId: ORDER,
    method: 'card',
    createdAt: now,
    signature: CART,
  });
  assert.equal(markChargeSent(made, now + 5).sentAt, now + 5);
  assert.equal(made.sentAt, undefined);
});

test('show state: paid, in review, 3-D Secure; nothing for the rest', () => {
  for (const phase of ['paid', 'preparing', 'ready', 'handed_over'])
    assert.equal(showStateOf(order(phase)), 'paid');
  assert.equal(showStateOf(order('sending')), 'review');
  assert.equal(showStateOf(order('checking')), 'review');
  assert.equal(showStateOf(order('awaiting_payment')), 'three_ds');
  for (const phase of ['ready_to_pay', 'awaiting_restaurant', 'failed', 'attention'])
    assert.equal(showStateOf(order(phase)), null);
});

test('no intent and nothing unfinished: a new order', () => {
  assert.deepEqual(decideTipTopPay({ intent: null, orders: [], now }), {
    kind: 'create',
    forget: false,
  });
  assert.deepEqual(decideTipTopPay({ intent: null, orders: [order('handed_over')], now }), {
    kind: 'create',
    forget: false,
  });
});

test('(б) the intent order in review is shown, never replaced by a new order', () => {
  for (const [phase, state] of [
    ['sending', 'review'],
    ['checking', 'review'],
    ['awaiting_payment', 'three_ds'],
  ]) {
    const decision = decideTipTopPay({ intent: intent(), orders: [order(phase)], now });
    assert.equal(decision.kind, 'show');
    assert.equal(decision.state, state);
    assert.equal(decision.order.orderId, ORDER);
  }
});

test('a paid intent order is shown as paid, long after the poll window', () => {
  const late = intent({ createdAt: now - 2 * 3_600_000, sentAt: now - 2 * 3_600_000 });
  const decision = decideTipTopPay({ intent: late, orders: [order('paid')], now });
  assert.equal(decision.kind, 'show');
  assert.equal(decision.state, 'paid');
});

test('an order in review without an intent still blocks a new order (intent lost)', () => {
  const decision = decideTipTopPay({ intent: null, orders: [order('checking')], now });
  assert.equal(decision.kind, 'show');
  assert.equal(decision.order.orderId, ORDER);
  // A paid order without an intent is only history.
  assert.equal(decideTipTopPay({ intent: null, orders: [order('paid')], now }).kind, 'create');
});

test('(е) a failed order is paid again as the same order', () => {
  const decision = decideTipTopPay({
    intent: intent({ sentAt: now - 30_000 }),
    orders: [order('failed')],
    now,
    cart: CART,
  });
  assert.equal(decision.kind, 'retry');
  assert.equal(decision.order.orderId, ORDER);
});

test('a failed order of an older cart is not paid again for a different cart', () => {
  const decision = decideTipTopPay({
    intent: intent(),
    orders: [order('failed')],
    now,
    cart: JSON.stringify({ items: ['b'] }),
  });
  assert.deepEqual(decision, { kind: 'create', forget: true });
});

test('a failed order too old to retry is forgotten and a new one is created', () => {
  const decision = decideTipTopPay({
    intent: intent({ createdAt: now - RETRY_WINDOW_MS - 1_000 }),
    orders: [order('failed')],
    now,
    cart: CART,
  });
  assert.deepEqual(decision, { kind: 'create', forget: true });
});

test('(и) a wallet closed by the guest leaves an unsent order: the same order is paid again', () => {
  const decision = decideTipTopPay({
    intent: intent(),
    orders: [order('ready_to_pay')],
    now,
    cart: CART,
  });
  assert.equal(decision.kind, 'retry');
  assert.equal(decision.order.orderId, ORDER);
});

test('a charge that has just left the phone is waited for, not repeated', () => {
  const sent = intent({ sentAt: now - 10_000 });
  const decision = decideTipTopPay({
    intent: sent,
    orders: [order('ready_to_pay')],
    now,
    cart: CART,
  });
  assert.equal(decision.kind, 'wait');
  // After the in-flight window the order is plainly unsent again.
  const later = intent({ sentAt: now - CHARGE_IN_FLIGHT_MS - 1_000 });
  assert.equal(
    decideTipTopPay({ intent: later, orders: [order('ready_to_pay')], now, cart: CART }).kind,
    'retry',
  );
});

test('an intent whose order is gone or needs a manager is forgotten', () => {
  assert.deepEqual(decideTipTopPay({ intent: intent(), orders: [], now }), {
    kind: 'create',
    forget: true,
  });
  assert.deepEqual(decideTipTopPay({ intent: intent(), orders: [order('attention')], now }), {
    kind: 'create',
    forget: true,
  });
});

test('another order in review beats a retry of the failed intent order', () => {
  const decision = decideTipTopPay({
    intent: intent(),
    orders: [order('failed'), order('checking', { orderId: OTHER })],
    now,
    cart: CART,
  });
  assert.equal(decision.kind, 'show');
  assert.equal(decision.order.orderId, OTHER);
});

test('a review that outlived its window keeps the intent but does not trap the guest', () => {
  const old = order('checking', {
    createdAt: iso(-3_600_000),
    updatedAt: iso(-3_600_000),
  });
  const decision = decideTipTopPay({
    intent: intent({ createdAt: now - 3_500_000, sentAt: now - 3_500_000 }),
    orders: [old],
    now,
  });
  assert.deepEqual(decision, { kind: 'create', forget: false });
});

test('(з) holdAfterConflict holds only for the intent order of this guest, inside the server window', () => {
  const recent = intent({ sentAt: now - 5 * 60_000 });
  assert.equal(holdAfterConflict([], null, now), null);
  assert.equal(holdAfterConflict([order('checking')], recent, now).order.orderId, ORDER);
  assert.equal(holdAfterConflict([order('awaiting_payment')], recent, now).state, 'three_ds');
  assert.equal(holdAfterConflict([order('paid')], recent, now).state, 'paid');
  // The intent order is not at the bank (failed, unsent): it holds nobody.
  assert.equal(holdAfterConflict([order('failed')], recent, now), null);
  // Past the server's 25 minutes (plus the clock margin) a stuck order holds nobody.
  const old = intent({
    createdAt: now - HOLD_WINDOW_MS - 60_000,
    sentAt: now - HOLD_WINDOW_MS - 1_000,
  });
  assert.equal(holdAfterConflict([order('checking')], old, now), null);
});

test('(з) a 409 is never blamed on an old Kaspi order or on any order outside the intent', () => {
  const oldKaspi = order('checking', { updatedAt: iso(-3_600_000), createdAt: iso(-3_600_000) });
  assert.equal(holdAfterConflict([oldKaspi], null, now), null);
  // A fresh bank wait of another order, no TipTopPay intent: still not ours.
  assert.equal(holdAfterConflict([order('checking', { orderId: OTHER })], null, now), null);
  // The intent names ORDER; another order in review does not make the 409 «TipTopPay in review».
  const mine = intent({ sentAt: now - 60_000 });
  assert.equal(
    holdAfterConflict([order('failed'), order('checking', { orderId: OTHER })], mine, now),
    null,
  );
});

// startLiveOrder drives the same decision with the storage and the server behind it.
function world({ stored = null, orders = [], single = null, quote, createdOrder, fail } = {}) {
  const log = [];
  const state = { stored };
  const deps = {
    customerId: CUSTOMER,
    method: 'apple_pay',
    cart: CART,
    now: () => now,
    readIntent: async () => state.stored,
    writeIntent: async (value) => {
      log.push('write');
      if (fail === 'write') throw new Error('disk');
      state.stored = JSON.stringify(value);
    },
    forgetIntent: async () => {
      log.push('forget');
      state.stored = null;
    },
    listOrders: async () => {
      log.push('list');
      return orders;
    },
    readOrder: async (id) => {
      log.push('read');
      return single && single.orderId === id ? single : null;
    },
    newQuote:
      quote === null
        ? async () => null
        : async () => {
            log.push('quote');
            return quote ?? { quoteId: 'q', totalMinor: '250000', signature: CART };
          },
    prepare: async () => {
      log.push('prepare');
    },
    createOrder: async () => {
      log.push('create');
      if (fail === 'conflict') throw Object.assign(new Error('CONFLICT'), { code: 'CONFLICT' });
      if (fail === 'other') throw new Error('NETWORK');
      return createdOrder ?? order('ready_to_pay');
    },
  };
  return { deps, log, state };
}

test('(a) a new order is saved as an intent right after it is created, before anything is paid', async () => {
  const w = world();
  const result = await startLiveOrder(w.deps);
  assert.equal(result.kind, 'pay');
  assert.equal(result.created, true);
  assert.equal(result.totalMinor, '250000');
  assert.deepEqual(
    w.log.filter((step) => ['list', 'quote', 'prepare', 'create', 'write'].includes(step)),
    ['list', 'quote', 'prepare', 'create', 'write'],
  );
  const saved = parse(w.state.stored);
  assert.equal(saved.orderId, ORDER);
  assert.equal(saved.method, 'apple_pay');
  assert.equal(saved.signature, CART);
});

test('(a) if the intent cannot be saved nothing is paid', async () => {
  const w = world({ fail: 'write' });
  await assert.rejects(startLiveOrder(w.deps), /CHECKOUT_STORAGE/);
});

test('(б)(д) after a restart (memory empty, intent in storage) an order in review gets no new order', async () => {
  const w = world({ stored: raw({ sentAt: now - 20_000 }), orders: [order('checking')] });
  const result = await startLiveOrder(w.deps);
  assert.equal(result.kind, 'show');
  assert.equal(result.state, 'review');
  assert.equal(result.order.orderId, ORDER);
  assert.equal(w.log.includes('create'), false);
  assert.equal(w.log.includes('quote'), false);
});

test('the intent order is read by id when the list does not carry it', async () => {
  const w = world({ stored: raw(), orders: [], single: order('awaiting_payment') });
  const result = await startLiveOrder(w.deps);
  assert.equal(result.kind, 'show');
  assert.equal(result.state, 'three_ds');
  assert.equal(w.log.includes('create'), false);
});

test('(е) a failed order is paid again without a quote or a new order', async () => {
  const w = world({ stored: raw({ sentAt: now - 40_000 }), orders: [order('failed')] });
  const result = await startLiveOrder(w.deps);
  assert.equal(result.kind, 'pay');
  assert.equal(result.created, false);
  assert.equal(result.order.orderId, ORDER);
  assert.equal(result.totalMinor, '250000');
  assert.equal(w.log.includes('create'), false);
  assert.equal(w.log.includes('quote'), false);
  // The retry starts a new attempt: the old «sent» mark is gone.
  assert.equal(parse(w.state.stored).sentAt, undefined);
});

test('(и) after a closed Apple Pay sheet the same unsent order is paid again', async () => {
  const w = world({ stored: raw(), orders: [order('ready_to_pay')] });
  const result = await startLiveOrder(w.deps);
  assert.equal(result.kind, 'pay');
  assert.equal(result.created, false);
  assert.equal(w.log.includes('create'), false);
});

test('a charge in flight is waited for', async () => {
  const w = world({ stored: raw({ sentAt: now - 5_000 }), orders: [order('ready_to_pay')] });
  const result = await startLiveOrder(w.deps);
  assert.equal(result.kind, 'wait');
  assert.equal(w.log.includes('create'), false);
});

test('(ж) a foreign or broken record does not hold the press: a new order is made', async () => {
  for (const stored of [
    '{broken',
    raw({ customerId: '10000000-0000-4000-8000-000000000009' }),
    raw({ createdAt: now - TIPTOPPAY_INTENT_MAX_AGE_MS - 1 }),
  ]) {
    const w = world({ stored });
    const result = await startLiveOrder(w.deps);
    assert.equal(result.kind, 'pay');
    assert.equal(result.created, true);
  }
});

test('a press stopped at the quote (prices changed) creates nothing', async () => {
  const w = world({ quote: null });
  assert.deepEqual(await startLiveOrder(w.deps), { kind: 'stop' });
  assert.equal(w.log.includes('create'), false);
});

const SAME_CART = { cartTotalMinor: '250000', cartLines: [{ productId: 'p', quantity: 1 }] };

test('an in-memory retry order is used when storage has no intent and the cart is the same in substance', async () => {
  const w = world({ orders: [order('failed')] });
  const result = await startLiveOrder({ ...w.deps, ...SAME_CART, fallbackOrderId: ORDER });
  assert.equal(result.kind, 'pay');
  assert.equal(result.created, false);
  assert.equal(parse(w.state.stored).orderId, ORDER);
});

test('(HIGH 1) a remembered failed order never pays for a changed cart (no signature of the new cart)', async () => {
  for (const changed of [
    { cartTotalMinor: '990000', cartLines: [{ productId: 'p', quantity: 1 }] },
    { cartTotalMinor: '250000', cartLines: [{ productId: 'q', quantity: 1 }] },
    { cartTotalMinor: '250000', cartLines: [{ productId: 'p', quantity: 2 }] },
    {},
  ]) {
    const w = world({ orders: [order('failed')] });
    const result = await startLiveOrder({ ...w.deps, ...changed, fallbackOrderId: ORDER });
    assert.equal(result.kind, 'pay');
    assert.equal(result.created, true, JSON.stringify(changed));
    assert.notEqual(result.order.orderId, undefined);
    assert.equal(w.log.includes('create'), true);
  }
});

test('(HIGH 1) a saved intent of another cart is not retried either, by signature and by substance', () => {
  const failed = order('failed');
  const other = JSON.stringify({ items: ['b'] });
  assert.deepEqual(decideTipTopPay({ intent: intent(), orders: [failed], now, cart: other }), {
    kind: 'create',
    forget: true,
  });
  // The same signature but another total (the order was made for another price): new order.
  assert.deepEqual(
    decideTipTopPay({
      intent: intent(),
      orders: [failed],
      now,
      cart: CART,
      cartTotalMinor: '1',
      cartLines: [{ productId: 'p', quantity: 1 }],
    }),
    { kind: 'create', forget: true },
  );
});

test('leaving for another method forgets the retry order and the intent', async () => {
  const retry = { current: ORDER };
  const log = [];
  await leaveForOtherMethod(
    () => {
      retry.current = null;
    },
    async () => {
      log.push('forget');
    },
  );
  assert.equal(retry.current, null);
  assert.deepEqual(log, ['forget']);
});

test('(з) CONFLICT on the new order while the intent order is in review shows that order', async () => {
  // The app's own window (15 min) has passed, the server's (25 min) has not.
  const stale = order('checking', { createdAt: iso(-1_200_000), updatedAt: iso(-1_200_000) });
  const w = world({
    stored: raw({ createdAt: now - 1_200_000, sentAt: now - 1_200_000 }),
    orders: [stale],
    fail: 'conflict',
  });
  const result = await startLiveOrder(w.deps);
  assert.equal(result.kind, 'show');
  assert.equal(result.hold, true);
  assert.equal(result.order.orderId, ORDER);
  assert.equal(w.log.filter((step) => step === 'create').length, 1);
});

test('CONFLICT without any payment in review is a menu change, not a hold', async () => {
  const w = world({ fail: 'conflict' });
  await assert.rejects(startLiveOrder(w.deps), (e) => e.code === 'CONFLICT');
});

test('any other create error passes through', async () => {
  const w = world({ fail: 'other' });
  await assert.rejects(startLiveOrder(w.deps), /NETWORK/);
});

test('(з) the exact «payment in review» text exists in three languages', () => {
  assert.equal(
    PAYMENT_IN_REVIEW_NOTICE,
    'Предыдущая оплата ещё проверяется. Новый заказ можно оформить после её завершения.',
  );
  const kk = translate(PAYMENT_IN_REVIEW_NOTICE, 'kk');
  const en = translate(PAYMENT_IN_REVIEW_NOTICE, 'en');
  assert.notEqual(kk, PAYMENT_IN_REVIEW_NOTICE);
  assert.notEqual(en, PAYMENT_IN_REVIEW_NOTICE);
  assert.match(kk, /[ңғқүұәөһі]/i);
  assert.match(en, /previous payment/i);
  // Owner rule: plain hyphen, no long dashes in interface texts.
  for (const text of [PAYMENT_IN_REVIEW_NOTICE, kk, en]) assert.doesNotMatch(text, /[–—]/);
  const messages = JSON.parse(
    readFileSync(new URL('../../apps/mobile/src/i18n/messages.json', import.meta.url), 'utf8'),
  );
  assert.equal(messages.filter((m) => m.ru === PAYMENT_IN_REVIEW_NOTICE).length, 1);
});

test('the review text is not the old «Деньги не списаны» failure copy', () => {
  assert.doesNotMatch(PAYMENT_IN_REVIEW_NOTICE, /не списаны/);
});

test('(5) a storage read that throws is not «no intent»: nothing is created or charged', async () => {
  const w = world();
  w.deps.readIntent = async () => {
    throw new Error('disk read');
  };
  await assert.rejects(startLiveOrder(w.deps), /CHECKOUT_STORAGE/);
  assert.deepEqual(w.log, []);
  // The next press works once the storage does (the lock is released).
  const again = world();
  assert.equal((await startLiveOrder(again.deps)).kind, 'pay');
});

test('listOrders failing creates nothing, and the lock is released', async () => {
  const w = world({ stored: raw() });
  w.deps.listOrders = async () => {
    throw new Error('NETWORK');
  };
  await assert.rejects(startLiveOrder(w.deps), /NETWORK/);
  assert.equal(w.log.includes('create'), false);
  assert.equal(w.log.includes('quote'), false);
  assert.equal((await startLiveOrder(world().deps)).kind, 'pay');
});

test('an intent whose order the server does not know (404) is forgotten and a new order is made', async () => {
  const w = world({ stored: raw({ sentAt: now - 30_000 }), orders: [], single: null });
  const result = await startLiveOrder(w.deps);
  assert.equal(result.kind, 'pay');
  assert.equal(result.created, true);
  assert.ok(w.log.indexOf('read') < w.log.indexOf('forget'));
  assert.ok(w.log.indexOf('forget') < w.log.indexOf('create'));
});

test('(7) an expired order is not retried, and a fresh attempt mark never extends it', () => {
  const failed = (changes) => order('failed', changes);
  const retryOf = (i, o) => decideTipTopPay({ intent: i, orders: [o], now, cart: CART }).kind;
  assert.equal(retryOf(intent(), failed()), 'retry');
  // The server's own deadline of the order has passed.
  assert.equal(retryOf(intent(), failed({ expiresAt: iso(-1_000) })), 'create');
  assert.equal(retryOf(intent(), failed({ expiresAt: iso(60_000) })), 'retry');
  // No deadline in the answer: created + the unpaid TTL.
  assert.equal(
    retryOf(
      intent({ createdAt: now - ORDER_TTL_MS - 1 }),
      failed({ createdAt: iso(-ORDER_TTL_MS - 1) }),
    ),
    'create',
  );
  // Attempts every few minutes: createdAt does not move, the retry window ends.
  const loop = intent({ createdAt: now - RETRY_WINDOW_MS - 60_000, sentAt: now - 30_000 });
  assert.equal(retryOf(loop, failed({ createdAt: iso(-RETRY_WINDOW_MS - 60_000) })), 'create');
});

test('two simultaneous presses of one guest create one order', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = world();
  const slowCreate = first.deps.createOrder;
  first.deps.createOrder = async (id) => {
    await gate;
    return slowCreate(id);
  };
  const second = world();
  const running = startLiveOrder(first.deps);
  const other = await startLiveOrder(second.deps);
  assert.deepEqual(other, { kind: 'busy' });
  assert.deepEqual(second.log, []);
  release();
  assert.equal((await running).kind, 'pay');
  assert.equal(first.log.filter((step) => step === 'create').length, 1);
  // Released after the first start: a later press is served.
  assert.equal((await startLiveOrder(world().deps)).kind, 'pay');
});

test('(3) a Kaspi press is held by a TipTopPay charge in flight, in review or paid', () => {
  assert.equal(guardKaspiPress(null, [order('checking')], now), null);
  const sent = intent({ sentAt: now - 20_000 });
  const wait = guardKaspiPress(sent, [order('ready_to_pay')], now);
  assert.equal(wait.kind, 'wait');
  const review = guardKaspiPress(sent, [order('checking')], now);
  assert.equal(review.kind, 'show');
  assert.equal(review.state, 'review');
  assert.equal(guardKaspiPress(sent, [order('paid')], now).state, 'paid');
  // Nothing to protect: unsent or failed orders do not stop Kaspi.
  assert.equal(guardKaspiPress(intent(), [order('ready_to_pay')], now), null);
  assert.equal(guardKaspiPress(sent, [order('failed')], now), null);
});

test('only an intent that reached the bank needs a server read when the cart opens (4)', () => {
  assert.equal(intentNeedsServer(intent()), false);
  assert.equal(intentNeedsServer(intent({ sentAt: now - 1_000 })), true);
  assert.equal(intentNeedsServer(null), false);
});

test('(path 4) only the paid cart is cleared, once, and only for the intent order', () => {
  const paid = order('paid');
  assert.deepEqual(settlePaidIntent({ order: paid, intent: intent(), cart: CART }), {
    clearCart: true,
  });
  // A cart built later stays.
  assert.deepEqual(
    settlePaidIntent({ order: paid, intent: intent(), cart: JSON.stringify({ items: ['b'] }) }),
    { clearCart: false },
  );
  // Another order, no intent, an order not paid: nothing.
  assert.equal(
    settlePaidIntent({ order: order('paid', { orderId: OTHER }), intent: intent(), cart: CART }),
    null,
  );
  assert.equal(settlePaidIntent({ order: paid, intent: null, cart: CART }), null);
  assert.equal(settlePaidIntent({ order: order('checking'), intent: intent(), cart: CART }), null);
  // An intent without a signature clears nothing, but is still settled.
  assert.deepEqual(
    settlePaidIntent({ order: paid, intent: intent({ signature: undefined }), cart: CART }),
    {
      clearCart: false,
    },
  );
});

function charging({ aborted = false, answer, markFails = false } = {}) {
  const log = [];
  return {
    log,
    deps: {
      markSent: async () => {
        log.push('mark');
        if (markFails) throw new Error('disk');
      },
      charge: async () => {
        log.push('charge');
        return answer ?? { order: order('checking') };
      },
      completeApplePay: async (ok) => {
        log.push(`apple:${ok}`);
      },
      openThreeDs: async () => {
        log.push('3ds');
      },
      poll: async () => {
        log.push('poll');
        return order('paid');
      },
      aborted: () => aborted,
    },
  };
}

test('(a) the intent is marked as sent before the charge leaves, and a failed mark does not stop it', async () => {
  const c = charging({ markFails: true });
  const result = await chargeLiveOrder(c.deps, intent(), { applePay: true, now: () => now });
  assert.deepEqual(c.log.slice(0, 2), ['mark', 'charge']);
  assert.equal(result.kind, 'settled');
});

test('leaving the screen never cuts the charge: its answer is completed, 3-D Secure opens, the poll stops', async () => {
  const c = charging({
    aborted: true,
    answer: { order: order('awaiting_payment'), threeDsUrl: 'https://bank.example/3ds' },
  });
  const result = await chargeLiveOrder(c.deps, intent(), { applePay: true, now: () => now });
  assert.equal(result.kind, 'left');
  assert.deepEqual(c.log, ['mark', 'charge', 'apple:true', '3ds']);
});

test('a charge answer with the bank words is a decline for Apple Pay and settles through the poll', async () => {
  const c = charging({ answer: { order: order('failed'), message: 'Недостаточно средств' } });
  const result = await chargeLiveOrder(c.deps, intent(), { applePay: true, now: () => now });
  assert.equal(c.log.includes('apple:false'), true);
  assert.equal(result.kind, 'settled');
  assert.equal(result.message, 'Недостаточно средств');
  const paid = charging();
  const done = await chargeLiveOrder(paid.deps, intent(), { applePay: false, now: () => now });
  assert.deepEqual(paid.log, ['mark', 'charge', 'poll']);
  assert.equal(done.order.phase, 'paid');
});

test('(9) the Kazakh review text has no adverb that the store check forbids', () => {
  assert.equal(
    translate(PAYMENT_IN_REVIEW_NOTICE, 'kk'),
    'Алдыңғы төлем тексерілуде. Жаңа тапсырысты ол аяқталғаннан кейін рәсімдеуге болады.',
  );
});
