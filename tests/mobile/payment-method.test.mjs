import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PAYMENT_METHOD,
  LAST_PAYMENT_METHOD_PREFIX,
  PAYMENT_METHOD_IDS,
  activePaymentMethod,
  createPaymentMethodStore,
  lastPaymentMethodKey,
  noteLastPaymentMethod,
  parseLastPaymentMethod,
  paymentHandleLabel,
  paymentMethodAvailable,
  paymentMethodLabel,
  paymentMethods,
  serializeLastPaymentMethod,
} from '../../apps/mobile/src/payment-method.ts';
import { cartPaymentMethods } from '../../apps/mobile/src/cart-payment.ts';
import { translate } from '../../apps/mobile/src/i18n/core.ts';

const A = '40000000-0000-4000-8000-0000000000a1';
const B = '40000000-0000-4000-8000-0000000000b2';
// This build: only Kaspi.kz pays. A future build where Apple Pay and cards work.
const today = paymentMethods('ios');
const future = today.map((method) => ({ ...method, available: true }));

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const writes = [];
  return {
    data,
    writes,
    async getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    async setItem(key, value) {
      writes.push([key, value]);
      data.set(key, value);
    },
  };
}

test('the cart lists Kaspi.kz first and the only available method; the others are «скоро»', () => {
  assert.deepEqual(cartPaymentMethods, paymentMethods);
  assert.deepEqual(
    paymentMethods('ios').map((m) => [m.id, m.available]),
    [
      ['kaspi', true],
      ['apple_pay', false],
      ['card', false],
    ],
  );
  assert.deepEqual(
    paymentMethods('android').map((m) => m.id),
    ['kaspi', 'google_pay', 'card'],
  );
  assert.deepEqual(PAYMENT_METHOD_IDS, ['kaspi', 'apple_pay', 'google_pay', 'card']);
  assert.equal(DEFAULT_PAYMENT_METHOD, 'kaspi');
});

test('choice: the saved method while it can pay, else the first available one (Kaspi)', () => {
  const saved = (method, source = 'payment') => ({ method, source, at: 1_000 });
  // New customer / guest: Kaspi.
  assert.equal(activePaymentMethod(null, today), 'kaspi');
  assert.equal(activePaymentMethod(undefined, future), 'kaspi');
  // Today Apple Pay, Google Pay and cards are «скоро»: everyone falls back to Kaspi.
  for (const method of ['apple_pay', 'google_pay', 'card'])
    assert.equal(activePaymentMethod(saved(method), today), 'kaspi', method);
  assert.equal(activePaymentMethod(saved('kaspi'), today), 'kaspi');
  // Once a method is connected, the last used one is shown and paid with.
  assert.equal(activePaymentMethod(saved('apple_pay'), future), 'apple_pay');
  assert.equal(activePaymentMethod(saved('card', 'choice'), future), 'card');
  // Google Pay is not offered on iOS: a value saved on Android falls back on an iPhone.
  assert.equal(activePaymentMethod(saved('google_pay'), future), 'kaspi');
  // The first AVAILABLE method, not simply the first listed one.
  const kaspiDown = future.map((m) => (m.id === 'kaspi' ? { ...m, available: false } : m));
  assert.equal(activePaymentMethod(saved('kaspi'), kaspiDown), 'apple_pay');
  assert.equal(activePaymentMethod(null, kaspiDown), 'apple_pay');
  // Nothing available at all: Kaspi (the cart keeps its own guards).
  assert.equal(
    activePaymentMethod(
      saved('card'),
      today.map((m) => ({ ...m, available: false })),
    ),
    'kaspi',
  );
  assert.equal(paymentMethodAvailable('kaspi', today), true);
  assert.equal(paymentMethodAvailable('apple_pay', today), false);
  assert.equal(paymentMethodAvailable('google_pay', future), false);
});

test('the later event wins: a payment sent or a choice in «Способ оплаты»', async () => {
  let now = 1_700_000_000_000;
  const storage = memoryStorage();
  const store = createPaymentMethodStore({ storage, now: () => now });
  await store.load(A);
  assert.equal(store.active(A, future), 'kaspi');
  assert.equal(store.record(A, 'apple_pay', 'payment', future), true);
  assert.equal(store.active(A, future), 'apple_pay');
  now += 1_000;
  store.record(A, 'card', 'choice', future);
  assert.deepEqual(store.saved(A), { method: 'card', source: 'choice', at: now });
  assert.equal(store.active(A, future), 'card');
  now += 1_000;
  store.record(A, 'kaspi', 'payment', future);
  assert.deepEqual(store.saved(A), { method: 'kaspi', source: 'payment', at: now });
  assert.deepEqual(noteLastPaymentMethod('card', 'choice', 12.7), {
    method: 'card',
    source: 'choice',
    at: 12,
  });
});

test('persistence: one key per account, restored on the next start, no card data', async () => {
  let now = 1_700_000_000_000;
  const storage = memoryStorage();
  const store = createPaymentMethodStore({ storage, now: () => now });
  assert.equal(lastPaymentMethodKey(A), LAST_PAYMENT_METHOD_PREFIX + A);
  assert.equal(lastPaymentMethodKey(A), 'pickchick.payment.last-method.v1:' + A);
  assert.notEqual(lastPaymentMethodKey(A), lastPaymentMethodKey(B));
  for (const guest of [undefined, null, '', 'x'.repeat(101)])
    assert.equal(lastPaymentMethodKey(guest), null);
  await Promise.all([store.load(A), store.load(B)]);
  store.record(A, 'apple_pay', 'payment', future);
  assert.equal(store.active(A, future), 'apple_pay');
  // Another account on the same device keeps its own value (a new customer: Kaspi).
  assert.equal(store.active(B, future), 'kaspi');
  assert.deepEqual(storage.writes, [
    [
      'pickchick.payment.last-method.v1:' + A,
      JSON.stringify({ method: 'apple_pay', source: 'payment', at: now }),
    ],
  ]);
  // Only the method id, its source and the time are stored: never card numbers or tokens.
  assert.deepEqual(Object.keys(JSON.parse(storage.writes[0][1])).sort(), [
    'at',
    'method',
    'source',
  ]);
  // The next app start reads it back for that account only.
  const restarted = createPaymentMethodStore({ storage, now: () => now });
  assert.equal(restarted.ready(A), false);
  assert.equal(restarted.active(A, future), 'kaspi');
  await restarted.load(A);
  assert.equal(restarted.ready(A), true);
  assert.equal(restarted.active(A, future), 'apple_pay');
  // ...and this build, where Apple Pay is «скоро», falls back to Kaspi without erasing it.
  assert.equal(restarted.active(A, today), 'kaspi');
  assert.equal(restarted.saved(A).method, 'apple_pay');
  await restarted.load(B);
  assert.equal(restarted.active(B, future), 'kaspi');
});

test('only a method this build can pay with is remembered; a guest is never persisted', async () => {
  const storage = memoryStorage();
  const store = createPaymentMethodStore({ storage, now: () => 5_000 });
  await store.load(A);
  assert.equal(store.record(A, 'apple_pay', 'choice', today), false);
  assert.equal(store.saved(A), null);
  assert.equal(store.record(A, 'kaspi', 'choice', today), true);
  assert.equal(store.active(A, today), 'kaspi');
  // Guest: ready at once, the choice lives in memory for this run, nothing is written.
  assert.equal(store.ready(undefined), true);
  assert.equal(store.record(undefined, 'card', 'choice', future), true);
  assert.equal(store.active(undefined, future), 'card');
  assert.equal(store.active(A, future), 'kaspi');
  assert.deepEqual(
    storage.writes.map(([key]) => key),
    [LAST_PAYMENT_METHOD_PREFIX + A],
  );
});

test('a choice made while the saved value is still being read is not overwritten by it', async () => {
  let release;
  const storage = {
    getItem: () =>
      new Promise((resolve) => {
        release = () =>
          resolve(serializeLastPaymentMethod({ method: 'card', source: 'payment', at: 1 }));
      }),
    setItem: async () => {},
  };
  const store = createPaymentMethodStore({ storage, now: () => 9_000 });
  let notified = 0;
  const unsubscribe = store.subscribe(() => notified++);
  const loading = store.load(A);
  assert.equal(store.load(A), loading, 'one read per account');
  store.record(A, 'apple_pay', 'choice', future);
  release();
  await loading;
  assert.equal(store.active(A, future), 'apple_pay');
  assert.ok(notified >= 2 && store.version() >= 2);
  unsubscribe();
});

test('a broken or foreign saved value is ignored, never trusted', async () => {
  const good = { method: 'kaspi', source: 'payment', at: 1_700_000_000_000 };
  assert.deepEqual(parseLastPaymentMethod(JSON.stringify(good)), good);
  assert.deepEqual(parseLastPaymentMethod(serializeLastPaymentMethod(good)), good);
  for (const raw of [
    null,
    undefined,
    '',
    'kaspi',
    '{',
    '[]',
    'null',
    JSON.stringify({ ...good, method: 'bitcoin' }),
    JSON.stringify({ ...good, source: 'guess' }),
    JSON.stringify({ ...good, at: 0 }),
    JSON.stringify({ ...good, at: 1.5 }),
    JSON.stringify({ ...good, at: '1' }),
    JSON.stringify({ method: 'card', source: 'payment' }),
    // Card data never belongs here: a value with any extra field is dropped.
    JSON.stringify({ ...good, method: 'card', pan: '4111111111111111' }),
    JSON.stringify({ ...good, token: 'x' }),
    'x'.repeat(201),
  ])
    assert.equal(parseLastPaymentMethod(raw), null, String(raw));
  // A broken value in storage reads as a new customer: Kaspi.
  const store = createPaymentMethodStore({
    storage: memoryStorage({ [LAST_PAYMENT_METHOD_PREFIX + A]: '{"method":"card"' }),
    now: () => 1,
  });
  await store.load(A);
  assert.equal(store.active(A, future), 'kaspi');
  // A storage failure reads the same way and never throws.
  const failing = createPaymentMethodStore({
    storage: {
      getItem: () => Promise.reject(new Error('disk')),
      setItem: () => Promise.reject(new Error('disk')),
    },
    now: () => 1,
  });
  await failing.load(A);
  assert.equal(failing.ready(A), true);
  assert.equal(failing.record(A, 'kaspi', 'payment', today), true);
  assert.equal(failing.active(A, today), 'kaspi');
});

test('the handle names its method in RU, KK and EN; the hint opens the cart with payment', () => {
  const messages = JSON.parse(
    readFileSync(new URL('../../apps/mobile/src/i18n/messages.json', import.meta.url), 'utf8'),
  );
  const has = (ru) => messages.find((entry) => entry.ru === ru);
  for (const method of PAYMENT_METHOD_IDS) {
    const entry = has(paymentHandleLabel(method));
    assert.ok(entry && entry.kk && entry.en, method);
  }
  assert.equal(paymentHandleLabel('kaspi'), 'Оплатить через Kaspi');
  assert.equal(translate(paymentHandleLabel('kaspi'), 'kk'), 'Kaspi арқылы төлеу');
  assert.equal(translate(paymentHandleLabel('kaspi'), 'en'), 'Pay with Kaspi');
  assert.equal(paymentMethodLabel('kaspi'), 'Kaspi.kz');
  assert.equal(translate(paymentMethodLabel('card'), 'en'), 'Bank card');
  const hint = 'Удерживайте и потяните вправо. Двойное касание откроет корзину с оплатой.';
  assert.equal(
    translate(hint, 'en'),
    'Hold and slide to the right. Double-tap opens the cart with payment.',
  );
  assert.ok(has(hint).kk.includes('себет'));
  assert.equal(translate('Открыть корзину с оплатой', 'kk'), 'Төлеммен себетті ашу');
  // The handle reads its label and mark from the active method, never a hard-coded Kaspi.
  const source = readFileSync(
    new URL('../../apps/mobile/src/components/KaspiSlideToPay.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(!source.includes('оформление заказа') && !source.includes("t('Оформить заказ')"));
  assert.ok(!source.includes("t('Оплатить через Kaspi')"));
  assert.ok(source.includes('t(paymentHandleLabel(method))'));
  assert.ok(source.includes('<MethodMark method={method}'));
  // Plain hyphen only in the new texts.
  for (const ru of [
    hint,
    'Открыть корзину с оплатой',
    ...PAYMENT_METHOD_IDS.map(paymentHandleLabel),
  ])
    assert.ok(!/[\u2013\u2014]/.test(Object.values(has(ru)).join(' ')), ru);
});
