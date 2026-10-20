import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  digest,
  priceSnapshot,
  MinorSchema,
  customerCheckoutOptions,
  kioskCheckoutOptions,
  qrStatusOutcome,
} from '../dist/index.js';
import { catalogPayload, pricePublication } from './catalog-fixture.mjs';
import { catalogPayloadHash } from '@pickchick/catalog-pricing';

const input = () => ({
  releaseId: randomUUID(),
  channel: 'mobile',
  serviceMode: 'takeaway',
  currency: 'KZT',
  ttlSeconds: 300,
  lines: [
    {
      lineId: randomUUID(),
      productId: 'synthetic',
      title: 'Synthetic',
      quantity: 3,
      unitPriceMinor: '333',
      discountMinor: '1',
      taxCode: 'TEST',
    },
  ],
});
test('quote arithmetic uses integer minor units and immutable line allocations', () => {
  const quote = input(),
    result = priceSnapshot(quote);
  assert.equal(result.totalMinor, '998');
  assert.equal(result.lines[0].grossMinor, '999');
  quote.lines[0].unitPriceMinor = '1';
  assert.equal(result.lines[0].unitPriceMinor, '333');
  assert.equal(result.customerId, null);
});
test('canonical digest ignores object insertion order, preserves arrays and values', () => {
  assert.equal(digest({ z: 2, a: { b: 1, a: 2 } }), digest({ a: { a: 2, b: 1 }, z: 2 }));
  assert.notEqual(digest({ a: [1, 2] }), digest({ a: [2, 1] }));
  assert.notEqual(digest({ amount: '10' }), digest({ amount: '100' }));
  assert.throws(() => digest({ bad: undefined }));
});
test('money rejects floats, negative/exponent/leading-zero values and oversized totals', () => {
  for (const value of [1, 1.1, '1.1', '-1', '01', '1e4', '9000000000000001'])
    assert.equal(MinorSchema.safeParse(value).success, false);
  const quote = input();
  quote.lines[0].unitPriceMinor = '9000000000000000';
  assert.throws(() => priceSnapshot(quote), { code: 'INVALID' });
});
test('duplicate lines, excess discounts, zero settlement and edge-owned channels are rejected', () => {
  const quote = input();
  quote.lines.push({ ...quote.lines[0] });
  assert.throws(() => priceSnapshot(quote), { code: 'INVALID' });
  const discount = input();
  discount.lines[0].discountMinor = '1000';
  assert.throws(() => priceSnapshot(discount), { code: 'INVALID' });
  discount.lines[0].discountMinor = '999';
  assert.throws(() => priceSnapshot(discount), { code: 'INVALID' });
  for (const channel of ['kiosk', 'pos'])
    assert.throws(() => priceSnapshot({ ...input(), channel }), { code: 'INVALID' });
});

function published() {
  const payload = catalogPayload();
  return pricePublication(
    {
      organizationId: randomUUID(),
      branchId: randomUUID(),
      version: 1,
      payloadHash: catalogPayloadHash(payload),
      publishedAt: new Date().toISOString(),
    },
    payload,
    randomUUID(),
  );
}
test('catalog quote requires explicit tax approval and every line code, mutually exclusive source', () => {
  const quote = published();
  assert.equal(priceSnapshot(quote).totalMinor, '32000');
  const missing = globalThis.structuredClone(quote);
  delete missing.taxBinding;
  assert.throws(() => priceSnapshot(missing), { code: 'INVALID' });
  const code = globalThis.structuredClone(quote);
  delete code.lines[0].taxCode;
  assert.throws(() => priceSnapshot(code), { code: 'INVALID' });
  assert.throws(() => priceSnapshot({ ...quote, releaseId: randomUUID() }), { code: 'INVALID' });
  assert.throws(() => priceSnapshot({ ...quote, ttlSeconds: 301 }), { code: 'INVALID' });
  assert.equal(priceSnapshot({ ...quote, channel: 'kiosk' }).channel, 'kiosk');
  assert.throws(() => priceSnapshot({ ...quote, channel: 'pos' }), { code: 'INVALID' });
});
test('published arithmetic validates input totals and copies selected details without aliasing', () => {
  const original = published(),
    snapshot = priceSnapshot(original);
  const name = snapshot.lines[0].selectedDetails.name.ru;
  original.lines[0].selectedDetails.name.ru = 'Changed externally';
  assert.equal(snapshot.lines[0].selectedDetails.name.ru, name);
  for (const field of [
    'grossMinor',
    'totalMinor',
    'baseUnitPriceMinor',
    'modifiersUnitPriceMinor',
  ]) {
    const bad = published();
    bad.lines[0][field] = '1';
    assert.throws(() => priceSnapshot(bad), { code: 'INVALID' });
  }
  for (const field of ['subtotalMinor', 'totalMinor'])
    assert.throws(() => priceSnapshot({ ...published(), [field]: '1' }), { code: 'INVALID' });
});

test('all verified customer audience requires an explicit server environment switch', () => {
  const env = {
    CUSTOMER_KASPI_PILOT_ENABLED: 'true',
    CUSTOMER_KASPI_ORGANIZATION_ID: randomUUID(),
    CUSTOMER_KASPI_BRANCH_ID: randomUUID(),
    KASPI_REMOTE_ACCOUNT_ID: randomUUID(),
    CUSTOMER_KASPI_PILOT_CUSTOMER_IDS: randomUUID(),
    CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE: 'Synthetic approval',
  };
  assert.equal(customerCheckoutOptions(env).allVerifiedCustomers, false);
  assert.equal(
    customerCheckoutOptions({ ...env, CUSTOMER_KASPI_ALL_VERIFIED_CUSTOMERS: 'true' })
      .allVerifiedCustomers,
    true,
  );
  assert.equal(
    customerCheckoutOptions({ ...env, CUSTOMER_KASPI_ALL_VERIFIED_CUSTOMERS: 'false' })
      .allVerifiedCustomers,
    false,
  );
  assert.equal(
    customerCheckoutOptions({
      ...env,
      CUSTOMER_KASPI_PILOT_ENABLED: 'false',
      CUSTOMER_KASPI_ALL_VERIFIED_CUSTOMERS: 'true',
    }),
    null,
  );
});

test('kiosk phone invoice is offered only on the account the invoice worker serves', () => {
  const served = randomUUID(),
    other = randomUUID();
  const env = {
    KIOSK_CHECKOUT_ENABLED: 'true',
    KIOSK_CHECKOUT_ORGANIZATION_ID: randomUUID(),
    KIOSK_CHECKOUT_BRANCH_ID: randomUUID(),
    KIOSK_CHECKOUT_PAYMENT_METHOD: 'kaspi_qr',
    KIOSK_KASPI_QR_ACCOUNT_ID: randomUUID(),
    KIOSK_KASPI_INVOICE_ACCOUNT_ID: other,
    KASPI_REMOTE_ACCOUNT_ID: served,
    KIOSK_CHECKOUT_FISCAL_POLICY: 'deferred_pilot',
    KIOSK_CHECKOUT_APPROVAL_REFERENCE: 'Synthetic approval',
    KIOSK_CHECKOUT_TAX_CODE: 'PENDING_PILOT',
    CUSTOMER_KASPI_OPENING_TIME: '10:00',
    CUSTOMER_KASPI_CLOSING_TIME: '00:00',
    CUSTOMER_KASPI_TIMEZONE: 'Asia/Almaty',
  };
  // Finding 0.6: the only invoice worker claims KASPI_REMOTE_ACCOUNT_ID; another account
  // would leave the guest on "sending" forever, so the method is not offered at all.
  assert.equal(kioskCheckoutOptions(env).invoicePaymentAccountId, undefined);
  assert.equal(
    kioskCheckoutOptions({ ...env, KIOSK_KASPI_INVOICE_ACCOUNT_ID: served })
      .invoicePaymentAccountId,
    served,
  );
  const withoutWorker = { ...env, KIOSK_KASPI_INVOICE_ACCOUNT_ID: served };
  delete withoutWorker.KASPI_REMOTE_ACCOUNT_ID;
  assert.equal(kioskCheckoutOptions(withoutWorker).invoicePaymentAccountId, undefined);
  assert.throws(() =>
    kioskCheckoutOptions({ ...env, KIOSK_KASPI_INVOICE_ACCOUNT_ID: 'not-a-uuid' }),
  );
  // The QR path itself is unchanged.
  assert.equal(kioskCheckoutOptions(env).paymentAccountId, env.KIOSK_KASPI_QR_ACCOUNT_ID);
  assert.equal(kioskCheckoutOptions(env).paymentMethod, 'kaspi_qr');
});

test('mobile Kaspi sales switch and unpaid TTL are explicit server flags with safe defaults', () => {
  const env = {
    CUSTOMER_KASPI_PILOT_ENABLED: 'true',
    CUSTOMER_KASPI_ORGANIZATION_ID: randomUUID(),
    CUSTOMER_KASPI_BRANCH_ID: randomUUID(),
    KASPI_REMOTE_ACCOUNT_ID: randomUUID(),
    CUSTOMER_KASPI_PILOT_CUSTOMER_IDS: randomUUID(),
    CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE: 'Synthetic approval',
  };
  // Default = today's behaviour: sales open, never-billed orders expire after 30 minutes.
  assert.equal(customerCheckoutOptions(env).salesEnabled, true);
  assert.equal(customerCheckoutOptions(env).unpaidOrderTtlMinutes, 30);
  assert.equal(
    customerCheckoutOptions({ ...env, CUSTOMER_KASPI_SALES_ENABLED: 'false' }).salesEnabled,
    false,
  );
  assert.equal(
    customerCheckoutOptions({ ...env, CUSTOMER_KASPI_SALES_ENABLED: 'true' }).salesEnabled,
    true,
  );
  assert.equal(
    customerCheckoutOptions({ ...env, CUSTOMER_UNPAID_ORDER_TTL_MINUTES: '0' })
      .unpaidOrderTtlMinutes,
    0,
  );
  assert.equal(
    customerCheckoutOptions({ ...env, CUSTOMER_UNPAID_ORDER_TTL_MINUTES: '45' })
      .unpaidOrderTtlMinutes,
    45,
  );
  for (const bad of [
    { CUSTOMER_KASPI_SALES_ENABLED: 'no' },
    { CUSTOMER_KASPI_SALES_ENABLED: 'False' },
    { CUSTOMER_UNPAID_ORDER_TTL_MINUTES: '3' },
    { CUSTOMER_UNPAID_ORDER_TTL_MINUTES: '-1' },
    { CUSTOMER_UNPAID_ORDER_TTL_MINUTES: '1441' },
    { CUSTOMER_UNPAID_ORDER_TTL_MINUTES: '10.5' },
  ])
    assert.throws(() => customerCheckoutOptions({ ...env, ...bad }), { code: 'INVALID' });
});

test('kiosk QR status: an empty identity is anonymous, a named foreign one stays unknown (3.2)', () => {
  const row = {
    operation_id: '123',
    amount_minor: '10000',
    expires_at: new Date('2026-10-08T14:36:03Z'),
  };
  const before = new Date('2026-10-08T14:35:52Z');
  const after = new Date('2026-10-08T14:36:04Z');
  const outcome = (data, now = after) => qrStatusOutcome(data, row, now);
  // 8.10 shapes: discarded without amount and without a usable id fails only after expiry.
  for (const anonymous of [
    { Status: 'QrTokenDiscarded' },
    { Status: 'QrTokenDiscarded', Id: null, Amount: null },
    { Status: 'QrTokenDiscarded', Id: '', QrOperationId: 0, Amount: '0.00' },
    { Status: 'Expired', Amount: '0 ₸' },
  ]) {
    assert.equal(outcome(anonymous), 'failed', JSON.stringify(anonymous));
    assert.equal(outcome(anonymous, before), 'unknown', JSON.stringify(anonymous));
  }
  assert.equal(outcome({ Status: 'QrTokenDiscarded', Id: 124 }), 'unknown');
  assert.equal(outcome({ Status: 'QrTokenDiscarded', Id: 123, QrOperationId: 124 }), 'unknown');
  assert.equal(outcome({ Status: 'Expired', Amount: 999 }), 'unknown');
  assert.equal(outcome({ Status: 'QrTokenDiscarded', Id: 123 }, before), 'failed');
  // Money needs Processed with the exact id and amount, never an anonymous answer.
  assert.equal(outcome({ Status: 'Processed', Id: 123, Amount: 100 }), 'paid');
  assert.equal(outcome({ Status: 'Processed', Amount: 100 }), 'unknown');
  assert.equal(outcome({ Status: 'Processed', Id: 123 }), 'unknown');
  assert.equal(outcome({ Status: 'QrTokenCreated', Id: 123 }), 'pending');
  assert.equal(outcome({ Status: 'QrTokenCreated', Id: null }), 'pending');
  assert.equal(outcome({ Status: 'QrTokenScanned', Id: 124 }), 'unknown');
  assert.equal(outcome({ Status: 'SomethingNew', Id: 123 }), 'unknown');
});
