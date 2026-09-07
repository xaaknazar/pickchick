import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { digest, priceSnapshot, MinorSchema } from '../dist/index.js';

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
