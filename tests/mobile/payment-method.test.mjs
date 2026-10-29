import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PAYMENT_METHOD,
  LAST_PAYMENT_METHOD_PREFIX,
  PAYMENT_METHOD_IDS,
  PAYMENT_METHOD_NOT_CONNECTED,
  activePaymentMethod,
  createPaymentMethodStore,
  lastPaymentMethodKey,
  noteLastPaymentMethod,
  parseLastPaymentMethod,
  paymentHandleLabel,
  paymentMethodAvailable,
  paymentMethodLabel,
  paymentMethods,
  paymentPayAction,
  serializeLastPaymentMethod,
} from '../../apps/mobile/src/payment-method.ts';
import {
  KASPI_PAY,
  brandSlotParts,
  cartPaymentMethods,
} from '../../apps/mobile/src/cart-payment.ts';
import { translate } from '../../apps/mobile/src/i18n/core.ts';

const A = '40000000-0000-4000-8000-0000000000a1';
const B = '40000000-0000-4000-8000-0000000000b2';
// This build: only Kaspi.kz pays. A future build where Apple Pay and cards work (listed with
// EXPO_PUBLIC_UPCOMING_PAYMENTS=1 today, then available).
const today = paymentMethods('ios');
const future = paymentMethods('ios', true).map((method) => ({ ...method, available: true }));

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

test('App Store build: the cart lists Kaspi.kz only; the flag lists the others as «скоро»', () => {
  assert.deepEqual(cartPaymentMethods, paymentMethods);
  // Owner 29.10.2026 (App Review 2.1): no Apple Pay / Google Pay / card row by default.
  for (const platform of ['ios', 'android', 'web'])
    assert.deepEqual(
      paymentMethods(platform).map((m) => [m.id, m.label, m.available]),
      [['kaspi', 'Kaspi.kz', true]],
      platform,
    );
  // EXPO_PUBLIC_UPCOMING_PAYMENTS=1 brings back the disabled list in its order.
  assert.deepEqual(
    paymentMethods('ios', true).map((m) => [m.id, m.available]),
    [
      ['kaspi', true],
      ['apple_pay', false],
      ['card', false],
    ],
  );
  assert.deepEqual(
    paymentMethods('android', true).map((m) => m.id),
    ['kaspi', 'google_pay', 'card'],
  );
  // A method that starts to pay is listed in every build (filter by availability, not by id).
  assert.deepEqual(
    future.filter((m) => m.available).map((m) => m.id),
    ['kaspi', 'apple_pay', 'card'],
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

test('the pay button reads naturally for every method in RU, KK and EN', () => {
  const read = (method, locale) => {
    const action = paymentPayAction(method);
    return translate(action.template, locale, { p0: translate(action.name, locale) });
  };
  assert.deepEqual(
    PAYMENT_METHOD_IDS.map((method) => read(method, 'ru')),
    ['Оплатить с Kaspi.kz', 'Оплатить с Apple Pay', 'Оплатить с Google Pay', 'Оплатить картой'],
  );
  assert.deepEqual(
    PAYMENT_METHOD_IDS.map((method) => read(method, 'kk')),
    [
      'Kaspi.kz арқылы төлеу',
      'Apple Pay арқылы төлеу',
      'Google Pay арқылы төлеу',
      'Картамен төлеу',
    ],
  );
  assert.deepEqual(
    PAYMENT_METHOD_IDS.map((method) => read(method, 'en')),
    ['Pay with Kaspi.kz', 'Pay with Apple Pay', 'Pay with Google Pay', 'Pay by card'],
  );
  // Brands keep the Kaspi template (the mark stands in its slot); a card is not a brand name.
  for (const method of ['kaspi', 'apple_pay', 'google_pay'])
    assert.equal(paymentPayAction(method).template, KASPI_PAY, method);
  for (const locale of ['ru', 'kk', 'en']) {
    const card = read('card', locale);
    assert.ok(!/Банковская карта|Банк картасы|Bank card/.test(card), card);
    // The card mark stands before «картой» in RU/EN and first in KK, like the Kaspi mark.
    const parts = brandSlotParts(translate(paymentPayAction('card').template, locale));
    assert.ok(parts.before || parts.after, locale);
  }
  // The footer builds its text and label from paymentPayAction, never «Оплатить с» + any name.
  const sheet = readFileSync(
    new URL('../../apps/mobile/src/components/CartSheet.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(sheet.includes('paymentPayAction(method)'));
  assert.ok(!sheet.includes('t(KASPI_PAY, { p0: name })'));
});

test('a method without its own payment flow stops with a message, nothing is sent', () => {
  const messages = JSON.parse(
    readFileSync(new URL('../../apps/mobile/src/i18n/messages.json', import.meta.url), 'utf8'),
  );
  for (const ru of [PAYMENT_METHOD_NOT_CONNECTED, 'Выбрать Kaspi.kz', 'Оплатить {p0}', 'картой']) {
    const entry = messages.find((message) => message.ru === ru);
    assert.ok(entry && entry.kk && entry.en, ru);
    assert.ok(!/[\u2013\u2014]/.test(Object.values(entry).join(' ')), ru);
  }
  assert.equal(
    translate(PAYMENT_METHOD_NOT_CONNECTED, 'en'),
    'This payment method is not connected yet. No order was placed and you were not charged. Choose Kaspi.kz in Payment method.',
  );
  // The Kaspi cart: a press or a slide with another active method shows the stop and returns
  // before consent, quote, order or invoice; choosing Kaspi there is a choice, not a payment.
  const screen = readFileSync(
    new URL('../../apps/mobile/src/screens/KaspiCheckoutScreen.tsx', import.meta.url),
    'utf8',
  );
  const submit = screen.slice(screen.indexOf('const submit = async () => {'));
  const stop = submit.indexOf("if (payment.method !== 'kaspi') {");
  assert.ok(stop > 0);
  const guard = submit.slice(stop, submit.indexOf('}', stop) + 1);
  assert.ok(guard.includes('setMethodStop(true);') && guard.includes('return;'), guard);
  for (const step of ['lock.current = true', 'props.authorizeLegal()', "'/quotes'", 'recover('])
    assert.ok(submit.indexOf(step) > stop, step);
  assert.ok(screen.includes('testID="cart-pay-method-stop"'));
  assert.ok(screen.includes('t(PAYMENT_METHOD_NOT_CONNECTED)'));
  assert.ok(screen.includes("onPress={() => payment.choose('kaspi')}"));
});
