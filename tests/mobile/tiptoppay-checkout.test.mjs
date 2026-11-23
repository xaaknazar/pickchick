import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CARD_PROBLEM_TEXT,
  cardInput,
  cardProblem,
  confirmConnectedMethod,
  connectedTipTopPayMethods,
  createConnectedMethodsStore,
  formatCardNumber,
  formatExpiry,
  luhnValid,
  tipTopPayResultCopy,
  walletAmount,
} from '../../apps/mobile/src/tiptoppay-checkout.ts';
import { paymentMethods } from '../../apps/mobile/src/payment-method.ts';

// Owner 18.11.2026: TipTopPay card, Apple Pay and Google Pay in the app, «Полностью нативно».

const phone = { module: true, applePay: true, googlePay: true };
const testConfig = {
  paymentMethods: ['kaspi', 'card', 'apple_pay', 'google_pay'],
  paymentEnvironment: 'test',
};

test('a test terminal reaches only the TipTopPay test build (App Review 2.1)', () => {
  assert.deepEqual(connectedTipTopPayMethods(testConfig, phone, true), [
    'apple_pay',
    'google_pay',
    'card',
  ]);
  assert.deepEqual(connectedTipTopPayMethods(testConfig, phone, false), []);
  // An older server (no wallets profile) or a build without the native module: Kaspi only.
  assert.deepEqual(connectedTipTopPayMethods({}, phone, true), []);
  assert.deepEqual(connectedTipTopPayMethods(null, phone, true), []);
  assert.deepEqual(connectedTipTopPayMethods(testConfig, { ...phone, module: false }, true), []);
  // A live terminal is offered by every build that knows the methods.
  assert.deepEqual(
    connectedTipTopPayMethods(
      { paymentMethods: ['kaspi', 'card'], paymentEnvironment: 'live' },
      phone,
      false,
    ),
    ['card'],
  );
});

test('wallets need the phone: no Apple Pay without a set-up wallet and merchant id', () => {
  assert.deepEqual(
    connectedTipTopPayMethods(
      testConfig,
      { module: true, applePay: false, googlePay: false },
      true,
    ),
    ['card'],
  );
  assert.deepEqual(
    connectedTipTopPayMethods(
      { paymentMethods: ['kaspi', 'apple_pay'], paymentEnvironment: 'test' },
      { module: true, applePay: false, googlePay: true },
      true,
    ),
    [],
  );
});

test('the selector lists a connected method as available, the platform wallet only', () => {
  const ios = paymentMethods('ios', undefined, ['apple_pay', 'card']);
  assert.deepEqual(
    ios.map((m) => [m.id, m.available]),
    [
      ['kaspi', true],
      ['apple_pay', true],
      ['card', true],
    ],
  );
  const android = paymentMethods('android', undefined, ['card']);
  assert.deepEqual(
    android.map((m) => m.id),
    ['kaspi', 'card'],
  );
  assert.deepEqual(
    paymentMethods('ios').map((m) => m.id),
    ['kaspi'],
  );
});

test('the connected-methods store notifies only on a change', () => {
  const store = createConnectedMethodsStore();
  let calls = 0;
  const stop = store.subscribe(() => calls++);
  store.set(['card'], 'test');
  store.set(['card'], 'test');
  assert.equal(calls, 1);
  assert.equal(store.version(), 1);
  store.set([], 'live');
  assert.equal(calls, 2);
  assert.deepEqual(store.methods(), []);
  assert.equal(store.environment(), 'live');
  stop();
  store.set(['card'], 'test');
  assert.equal(calls, 2);
});

test('the first /config answer of a run is news even with the same list (audit 23.11 #3)', async () => {
  // Restored from the last run, then the same list from the server: subscribers must still
  // render, because `fresh` changes what the handle may show (launchPaymentMethod).
  const storage = {
    getItem: async () => JSON.stringify({ methods: ['card'], environment: 'live' }),
    setItem: async () => {},
  };
  const store = createConnectedMethodsStore(storage);
  await store.restore();
  let calls = 0;
  store.subscribe(() => calls++);
  const restoredVersion = store.version();
  assert.equal(store.fresh(), false);
  store.set(['card'], 'live');
  assert.equal(store.fresh(), true);
  assert.equal(calls, 1);
  assert.ok(store.version() > restoredVersion);
  // Later answers with the same list stay quiet.
  store.set(['card'], 'live');
  assert.equal(calls, 1);
  // The same for an empty list that was never saved.
  const empty = createConnectedMethodsStore();
  let emptyCalls = 0;
  empty.subscribe(() => emptyCalls++);
  empty.set([], null);
  empty.set([], null);
  assert.equal(emptyCalls, 1);
});

test('a TipTopPay press before the first /config answer asks the server first (audit 23.11 #3)', async () => {
  // The handle showed Apple Pay on the phone's word; the restored list is empty.
  const store = createConnectedMethodsStore();
  let reads = 0;
  assert.equal(
    await confirmConnectedMethod(store, 'apple_pay', async () => {
      reads += 1;
      store.set(['apple_pay', 'card'], 'live');
    }),
    true,
  );
  assert.equal(reads, 1);
  // With a fresh answer the list decides at once: no second read.
  assert.equal(
    await confirmConnectedMethod(store, 'google_pay', async () => assert.fail('read again')),
    false,
  );
  assert.equal(await confirmConnectedMethod(store, 'card', async () => assert.fail('read')), true);
  // The server does not offer the method: refused after the answer, not before it.
  const refused = createConnectedMethodsStore();
  assert.equal(
    await confirmConnectedMethod(refused, 'apple_pay', async () => refused.set(['card'], 'live')),
    false,
  );
  // No answer: the last known list decides, as before.
  const offline = createConnectedMethodsStore({
    getItem: async () => JSON.stringify({ methods: ['card'], environment: 'live' }),
    setItem: async () => {},
  });
  await offline.restore();
  const fail = async () => {
    throw new Error('NETWORK_UNAVAILABLE');
  };
  assert.equal(await confirmConnectedMethod(offline, 'card', fail), true);
  assert.equal(await confirmConnectedMethod(offline, 'apple_pay', fail), false);
  assert.equal(offline.fresh(), false);

  // The cart: the check only reads /config; the press itself is still tipTopPay.start, and
  // nothing starts if the customer left or chose another method meanwhile.
  const screen = readFileSync(
    new URL('../../apps/mobile/src/screens/KaspiCheckoutScreen.tsx', import.meta.url),
    'utf8',
  );
  const submit = screen.slice(screen.indexOf('const submit = async () => {'));
  const guard = submit.slice(
    submit.indexOf("if (payment.method !== 'kaspi') {"),
    submit.indexOf('setMethodStop(false);\n    lock.current'),
  );
  const check = guard.slice(guard.indexOf('await confirmConnectedMethod('));
  assert.ok(guard.indexOf('if (connectedMethodsStore.fresh()) {') < guard.indexOf(check));
  assert.match(check, /request\('\/config', 'GET', undefined, controller\.signal\)/);
  assert.match(check, /noteConnectedMethods\(setup\);/);
  assert.match(
    check,
    /if \(controller\.signal\.aborted \|\| methodRef\.current !== method\) return;/,
  );
  assert.match(check, /tipTopPay\.start\(method, quote\?\.totalMinor \?\? localTotal\);/);
  for (const sent of ["'/orders'", "'/quotes'", "'POST'", 'randomUUID', 'props.authorizeLegal('])
    assert.ok(!guard.includes(sent), sent);
});

test('wallet amounts come from integer minor units, never floats', () => {
  assert.equal(walletAmount('125000'), '1250.00');
  assert.equal(walletAmount('5'), '0.05');
  assert.equal(walletAmount('99999999999999'), '999999999999.99');
  for (const bad of ['0', '-1', '1.5', '', '012'])
    assert.throws(() => walletAmount(bad), /INVALID_AMOUNT/);
});

test('card fields format as typed and are checked before encryption', () => {
  assert.equal(formatCardNumber('4242a4242 42424242'), '4242 4242 4242 4242');
  assert.equal(formatCardNumber('1'.repeat(25)).replace(/ /g, '').length, 19);
  assert.equal(formatExpiry('1'), '1');
  assert.equal(formatExpiry('1229'), '12/29');
  assert.equal(formatExpiry('12/299'), '12/29');
  assert.ok(luhnValid('4242 4242 4242 4242'));
  assert.ok(!luhnValid('4242 4242 4242 4241'));
  assert.ok(!luhnValid('4242'));
  const now = new Date('2026-11-18T10:00:00Z');
  const good = { number: '4242 4242 4242 4242', expiry: '11/26', cvv: '123' };
  assert.equal(cardProblem(good, now), null);
  assert.equal(cardProblem({ ...good, number: '4242 4242 4242 4241' }, now), 'number');
  assert.equal(cardProblem({ ...good, expiry: '10/26' }, now), 'expiry');
  assert.equal(cardProblem({ ...good, expiry: '13/27' }, now), 'expiry');
  assert.equal(cardProblem({ ...good, expiry: '11/99' }, now), 'expiry');
  assert.equal(cardProblem({ ...good, cvv: '12' }, now), 'cvv');
  for (const text of Object.values(CARD_PROBLEM_TEXT)) assert.ok(text.startsWith('Проверьте'));
});

test('the native module gets digits only and the server key of this terminal', () => {
  const setup = {
    publicId: 'test_api_00000000000000000000000000000001',
    publicKey: { pem: '-----BEGIN PUBLIC KEY-----\nAA==\n-----END PUBLIC KEY-----', version: 4 },
    googlePay: null,
    environment: 'test',
  };
  assert.deepEqual(
    cardInput({ number: '4242 4242 4242 4242', expiry: '11/26', cvv: '123' }, setup),
    {
      number: '4242424242424242',
      expMonth: '11',
      expYear: '26',
      cvv: '123',
      publicId: setup.publicId,
      publicKeyPem: setup.publicKey.pem,
      keyVersion: 4,
    },
  );
});

test('result copy says honestly that a test payment takes no money and sends no order', () => {
  assert.match(tipTopPayResultCopy({ state: 'paid' }, true).detail, /тестовая/);
  assert.equal(tipTopPayResultCopy({ state: 'paid' }, false).detail, 'Заказ оплачен.');
  assert.equal(
    tipTopPayResultCopy({ state: 'failed', message: 'Недостаточно средств' }, true).detail,
    'Недостаточно средств',
  );
  assert.match(tipTopPayResultCopy({ state: 'failed' }, true).detail, /Деньги не списаны/);
  assert.equal(tipTopPayResultCopy({ state: 'expired' }, true).tone, 'danger');
  assert.equal(tipTopPayResultCopy({ state: 'pending' }, true).tone, 'pending');
});

test('every new TipTopPay phrase has Kazakh and English text', () => {
  const messages = JSON.parse(
    readFileSync(new URL('../../apps/mobile/src/i18n/messages.json', import.meta.url), 'utf8'),
  );
  const known = new Set(messages.map((m) => m.ru));
  const sources = [
    '../../apps/mobile/src/components/TipTopPaySheets.tsx',
    '../../apps/mobile/src/tiptoppay-checkout.ts',
    '../../apps/mobile/src/useTipTopPayCheckout.tsx',
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));
  const phrases = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/\bt\('([^']+)'/g)) phrases.add(match[1]);
    for (const match of source.matchAll(
      /(?:title|detail|message):\s*(?:test\s*\?\s*)?'([^']*[А-Яа-я][^']*)'/g,
    ))
      phrases.add(match[1]);
  }
  for (const text of Object.values(CARD_PROBLEM_TEXT)) phrases.add(text);
  assert.ok(phrases.size > 20);
  for (const phrase of phrases) assert.ok(known.has(phrase), phrase);
});

test('success notice: centred icon and it closes itself (owner 23.11.2026)', () => {
  const sheet = readFileSync(
    new URL('../../apps/mobile/src/components/TipTopPaySheets.tsx', import.meta.url),
    'utf8',
  );
  // The card stretches its children, so the icon needs its own centred row.
  assert.match(sheet, /<View style=\{s\.iconRow\} testID="tiptoppay-result-icon">/);
  assert.match(sheet, /iconRow: \{ alignSelf: 'stretch', alignItems: 'center'/);
  // Only a success closes by itself; a failure or a pending check keeps its buttons.
  assert.match(sheet, /TIPTOPPAY_SUCCESS_AUTO_CLOSE_MS = 2500/);
  assert.match(sheet, /if \(!success\) return;/);
  assert.match(sheet, /clearTimeout\(timer\)/);
});
