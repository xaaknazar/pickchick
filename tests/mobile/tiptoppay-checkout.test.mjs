import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CARD_PROBLEM_TEXT,
  cardInput,
  cardProblem,
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
