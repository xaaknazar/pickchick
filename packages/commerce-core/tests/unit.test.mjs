import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { digest, priceSnapshot, MinorSchema, customerCheckoutOptions } from '../dist/index.js';
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
