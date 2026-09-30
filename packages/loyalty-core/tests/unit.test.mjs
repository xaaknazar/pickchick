import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Amount,
  Rules,
  parse,
  earnedPoints,
  maxRedemption,
  availablePoints,
  digest,
} from '../dist/index.js';
const rules = {
  earnBasisPoints: 700,
  pointValueMinor: '100',
  maxRedemptionBasisPoints: 3000,
  lotTtlDays: 180,
  refundSpentExpiry: 'new_lot_ttl',
  expiredEarnRefund: 'ignore_expired',
};
test('integer money rounds once and never uses floating point', () => {
  assert.equal(earnedPoints('19999', rules), 13n);
  assert.equal(maxRedemption('19999', rules), 59n);
  assert.equal(
    earnedPoints('9000000000000000', { ...rules, earnBasisPoints: 10000, pointValueMinor: '1' }),
    9000000000000000n,
  );
  for (const bad of ['1.1', '-1', '1e3', '01', 'NaN', '9000000000000001', 100])
    assert.throws(() => parse(Amount, bad), { code: 'INVALID' });
});
test('no implicit economics and supported policies must be explicitly approved', () => {
  assert.throws(() => parse(Rules, {}), { code: 'INVALID' });
  assert.throws(() => parse(Rules, { ...rules, pointValueMinor: '1.1' }), { code: 'INVALID' });
  assert.throws(() => parse(Rules, { ...rules, expiredEarnRefund: 'debit_again' }), {
    code: 'INVALID',
  });
  assert.equal(availablePoints(-2n, 9n), 0n);
  assert.equal(availablePoints(100n, 80n), 20n);
});
test('canonical digests are order-independent but bind content', () => {
  assert.equal(digest({ b: 2, a: { c: 1 } }), digest({ a: { c: 1 }, b: 2 }));
  assert.notEqual(digest({ a: '1' }), digest({ a: 1 }));
  assert.throws(() => digest({ a: undefined }), { code: 'INVALID' });
});
