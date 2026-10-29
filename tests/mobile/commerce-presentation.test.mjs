import assert from 'node:assert/strict';
import test from 'node:test';
import {
  paymentReceived,
  invoiceSecondsRemaining,
  paymentCopy,
  checkoutError,
  commerceStatus,
  closePaymentCopy,
  stuckCopy,
  EARLIER_ORDER_NOTICE,
  earlierOrderNotice,
} from '../../apps/mobile/src/commerce-presentation.ts';
import { CustomerCommerceOrderSchema } from '../../packages/contracts/dist/index.js';
import { readFileSync } from 'node:fs';
import { setAppLocale, t } from '../../apps/mobile/src/i18n/core.ts';

test('uncertain, failed and sent invoices never render as received money', () => {
  for (const phase of [
    'awaiting_restaurant',
    'ready_to_pay',
    'sending',
    'awaiting_payment',
    'checking',
    'failed',
    'attention',
  ]) {
    assert.equal(paymentReceived(phase), false);
    assert.ok(paymentCopy[phase].title && paymentCopy[phase].detail);
  }
  for (const phase of ['paid', 'preparing', 'ready', 'handed_over'])
    assert.equal(paymentReceived(phase), true);
  assert.match(checkoutError(new Error('QUOTE_EXPIRED')), /Цены обновились/);
  assert.match(checkoutError(new Error('CHECKOUT_STORAGE')), /Счёт не отправлен/);
  // Cloud kitchen gate (ADR-0014): plain hyphen, no dash.
  assert.equal(
    checkoutError(new Error('KITCHEN_OFFLINE')),
    'Кухня сейчас не на связи - заказ оформить нельзя. Попробуйте чуть позже.',
  );
});
test('customer payment contract rejects extra financial internals and invalid phases', () => {
  const value = {
    orderId: '40000000-0000-4000-8000-000000000003',
    revision: 'a'.repeat(64),
    restaurant: 'Synthetic',
    branchId: '40000000-0000-4000-8000-000000000001',
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    kitchenStage: null,
    displayNumber: null,
    totalMinor: '10000',
    serviceMode: 'takeaway',
    phase: 'checking',
    expiresAt: null,
    receipt: 'deferred',
    receiptUrl: null,
    items: [],
  };
  assert.ok(CustomerCommerceOrderSchema.safeParse(value).success);
  assert.equal(CustomerCommerceOrderSchema.safeParse({ ...value, attempts: [] }).success, false);
  assert.equal(
    CustomerCommerceOrderSchema.safeParse({ ...value, phase: 'verified' }).success,
    false,
  );
  assert.equal(CustomerCommerceOrderSchema.safeParse({ ...value, totalMinor: -1 }).success, false);
});

test('closing payment status aborts its long poll without widening the auth transport', async () => {
  const { createCustomerRequest } = await import('../../apps/mobile/src/customer-http.ts');
  const controller = new AbortController();
  let aborted = false;
  const fetcher = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(new Error('cancelled'));
        },
        { once: true },
      );
    });
  const transport = createCustomerRequest('https://example.test', fetcher, {
    allowed: /^\/v1\/customer-checkout\/orders$/,
    timeoutMs: 28000,
    maxBytes: 128000,
    signal: controller.signal,
  });
  const pending = transport('/v1/customer-checkout/orders', 'GET', undefined, 'a'.repeat(64));
  controller.abort();
  await assert.rejects(pending, /NETWORK_UNAVAILABLE/);
  assert.equal(aborted, true);
  await assert.rejects(
    createCustomerRequest('https://example.test', fetcher)('/v1/customer-checkout/orders', 'GET'),
    /INVALID_API_PATH/,
  );
});

test('commercial status reuses chef scenes without fabricating TEST authority', async () => {
  const { orderScene, orderStage } = await import('../../apps/mobile/src/order-status.ts');
  const base = {
    orderId: 'order',
    displayNumber: '8',
    branchId: 'branch',
    restaurant: 'Restaurant',
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:04:00.000Z',
    serviceMode: 'takeaway',
    totalMinor: '10000',
    phase: 'preparing',
    kitchenStage: 'cooking',
    items: [
      {
        productId: 'burger',
        title: 'Burger',
        quantity: 1,
        totalMinor: '10000',
        modifiers: ['Extra'],
      },
    ],
  };
  assert.equal(orderScene(commerceStatus(base)), 'cooking');
  assert.equal(orderScene(commerceStatus({ ...base, kitchenStage: 'assembly' })), 'assembly');
  assert.equal(orderScene(commerceStatus({ ...base, phase: 'ready' })), 'ready-takeaway');
  assert.equal(
    orderScene(commerceStatus({ ...base, phase: 'ready', serviceMode: 'dine_in' })),
    'ready',
  );
  assert.equal(orderStage(commerceStatus({ ...base, phase: 'paid' })), 'Оплата получена');
  assert.equal('synthetic' in commerceStatus(base), false);
  assert.equal(commerceStatus(base).snapshot.lines[0].line_total_minor, '10000');
  assert.throws(() => commerceStatus({ ...base, phase: 'checking' }), /PAYMENT_NOT_CONFIRMED/);
});

test('transient order failures stay silent while actionable checkout decisions remain visible', () => {
  for (const code of ['NETWORK_UNAVAILABLE', 'NOT_READY', 'AVAILABILITY_STALE', 'INTERNAL_ERROR'])
    assert.equal(checkoutError(new Error(code)), '');
  assert.equal(checkoutError(new TypeError('Network request failed')), '');
  for (const code of [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CONFLICT',
    'QUOTE_EXPIRED',
    'ITEM_STOPPED',
    'CHECKOUT_STORAGE',
    'CATALOG_UPGRADE_REQUIRED',
    'COMMENT_UNAVAILABLE',
  ])
    assert.ok(checkoutError(new Error(code)), code);
  for (const phase of Object.values(paymentCopy))
    assert.doesNotMatch(
      phase.detail,
      /Связь прервалась|заказ сохранён|повторно|проверить соединение/i,
    );
});

test('invoice countdown uses the server deadline and never manufactures a payment outcome', () => {
  const deadline = '2026-10-01T00:03:00.000Z';
  assert.equal(invoiceSecondsRemaining(deadline, Date.parse('2026-10-01T00:00:00Z')), 180);
  assert.equal(invoiceSecondsRemaining(deadline, Date.parse(deadline) - 1), 1);
  assert.equal(invoiceSecondsRemaining(deadline, Date.parse(deadline)), 0);
  assert.equal(invoiceSecondsRemaining(deadline, Date.parse(deadline) + 60000), 0);
  assert.equal(invoiceSecondsRemaining(null, Date.now()), null);
  assert.equal(invoiceSecondsRemaining('invalid', Date.now()), null);
  assert.equal(paymentReceived('awaiting_payment'), false);
});

test('authoritative closure explains hours without claiming a saved or confirmed payment', () => {
  const message = checkoutError(new Error('RESTAURANT_CLOSED'));
  assert.match(message, /Ресторан сейчас закрыт/);
  assert.doesNotMatch(message, /Связь прервалась|Заказ сохранён|оплачивать не нужно/);
});

test('a stuck payment and «Закрыть оплату?» speak honestly in RU, KK and EN', () => {
  // Owner 28.10.2026 (TestFlight 25): the X of a payment screen and the 20 s stuck notice.
  const messages = JSON.parse(
    readFileSync(new URL('../../apps/mobile/src/i18n/messages.json', import.meta.url), 'utf8'),
  );
  assert.equal(stuckCopy.bank.title, 'Kaspi отвечает дольше обычного');
  assert.equal(stuckCopy.restaurant.title, 'Ресторан не подтверждает заказ');
  // Before admission nothing was billed; while sending the invoice may still arrive.
  assert.match(stuckCopy.restaurant.detail, /Счёт не выставлен, деньги не списаны/);
  assert.match(stuckCopy.bank.detail, /ещё не пришёл/);
  const sending = closePaymentCopy('sending');
  const invoiced = closePaymentCopy('awaiting_payment');
  assert.equal(sending.title, 'Закрыть оплату?');
  assert.deepEqual([sending.close, sending.stay], ['Закрыть', 'Остаться']);
  assert.equal(closePaymentCopy('checking').detail, invoiced.detail);
  assert.equal(closePaymentCopy(undefined).detail, sending.detail);
  assert.match(invoiced.detail, /^Счёт уже в Kaspi/);
  // What submit() guarantees: the same order is reopened, no second invoice is created.
  for (const copy of [sending, invoiced])
    assert.match(copy.detail, /Повторная оплата откроет этот же заказ - второй счёт не создаётся/);
  const texts = [
    ...Object.values(stuckCopy).flatMap((copy) => [copy.title, copy.detail]),
    ...[sending, invoiced].flatMap((copy) => [copy.title, copy.detail, copy.close, copy.stay]),
    'Закрыть оплату',
    'Проверить ещё раз',
    'Вернуться в корзину',
    'К списку заказов',
  ];
  for (const ru of texts) {
    const entry = messages.find((message) => message.ru === ru);
    assert.ok(entry?.kk && entry.en, ru);
    for (const text of [entry.ru, entry.kk, entry.en]) assert.doesNotMatch(text, /[—–]/, text);
    setAppLocale('en');
    assert.doesNotMatch(t(ru), /[а-яё]/i, ru);
    setAppLocale('kk');
    assert.notEqual(t(ru), ru, ru);
    setAppLocale('ru');
  }
});

test('a reopened earlier order says so while the bank may act and the cart differs', () => {
  // Independent QA 28.10 (item 19): «sending» order of 1 Pick Combo (4 190 ₸) closed with the X,
  // the cart raised to 2 combos (8 380 ₸), «Оплатить» reopens the same order (the boundary).
  const cart = { lines: 1, totalMinor: '838000' };
  for (const phase of ['sending', 'awaiting_payment', 'checking'])
    assert.equal(earlierOrderNotice({ phase, totalMinor: '419000' }, cart), true, phase);
  // The same cart reopened is the same order; nothing at the bank, paid or failed: no notice.
  assert.equal(earlierOrderNotice({ phase: 'sending', totalMinor: '838000' }, cart), false);
  for (const phase of ['awaiting_restaurant', 'ready_to_pay', 'failed', 'attention', 'paid'])
    assert.equal(earlierOrderNotice({ phase, totalMinor: '419000' }, cart), false, phase);
  assert.equal(earlierOrderNotice(null, cart), false);
  assert.equal(
    earlierOrderNotice({ phase: 'sending', totalMinor: '419000' }, { lines: 0, totalMinor: '0' }),
    false,
  );
  // The amount and why no new order, in RU, KK and EN, plain hyphen.
  const messages = JSON.parse(
    readFileSync(new URL('../../apps/mobile/src/i18n/messages.json', import.meta.url), 'utf8'),
  );
  const entry = messages.find((message) => message.ru === EARLIER_ORDER_NOTICE);
  assert.ok(entry?.kk && entry.en);
  assert.equal(
    t(EARLIER_ORDER_NOTICE, { p0: '4 190 ₸' }).startsWith('Это ваш прошлый заказ на 4 190 ₸.'),
    true,
  );
  assert.match(EARLIER_ORDER_NOTICE, /новый заказ не создаётся/);
  for (const text of [entry.ru, entry.kk, entry.en]) assert.doesNotMatch(text, /[—–]/, text);
  setAppLocale('en');
  assert.match(
    t(EARLIER_ORDER_NOTICE, { p0: '4 190 ₸' }),
    /^This is your earlier order for 4 190 ₸\./,
  );
  assert.doesNotMatch(t(EARLIER_ORDER_NOTICE, { p0: '4 190 ₸' }), /[а-яё]/i);
  setAppLocale('kk');
  assert.match(
    t(EARLIER_ORDER_NOTICE, { p0: '4 190 ₸' }),
    /4 190 ₸ сомасындағы алдыңғы тапсырысыңыз/,
  );
  setAppLocale('ru');
});
