import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceCartLine, cartTotal, cartLineKey } from '../../apps/mobile/src/domain.ts';
const product = {
  id: 'combo',
  source: 'server',
  catalogVersion: 'mockup-v0.3',
  priceMinor: '10000',
  modifierGroups: [
    {
      id: 'drink',
      title: 'Напиток',
      min: 1,
      max: 1,
      options: [
        { id: 'cola', label: 'Cola', price_delta_minor: '0', available: true, max: 1 },
        { id: 'water', label: 'Water', price_delta_minor: '5000', available: true, max: 1 },
      ],
    },
  ],
};
const cola = [{ group_id: 'drink', option_id: 'cola', quantity: 1 }];
const water = [{ group_id: 'drink', option_id: 'water', quantity: 1 }];
const original = { product, quantity: 2, selections: cola };
test('edit replaces selections and quantity without appending old line, updates total', () => {
  const next = replaceCartLine([original], original, water, 3);
  assert.equal(next.length, 1);
  assert.equal(next[0].quantity, 3);
  assert.equal(cartTotal(next), '45000');
  assert.notEqual(cartLineKey(next[0]), cartLineKey(original));
});
test('edit merges matching line without silently clipping quantity', () => {
  const other = { product, quantity: 3, selections: water };
  assert.equal(replaceCartLine([original, other], original, water, 4)[0].quantity, 7);
  const lines = [original, { ...other, quantity: 19 }];
  assert.equal(replaceCartLine(lines, original, water, 2), lines);
});
test('stale edit, removed line, invalid modifiers and oversized quantity preserve basket', () => {
  for (const lines of [[], [{ ...original, quantity: 3 }]])
    assert.equal(replaceCartLine(lines, original, water, 1), lines);
  const lines = [original];
  for (const qty of [0, 21, 1.5]) assert.equal(replaceCartLine(lines, original, water, qty), lines);
  assert.equal(replaceCartLine(lines, original, [], 1), lines);
});

test('open editor survives publication and applies choices using current prices', () => {
  const current = [
    { ...original, product: { ...product, catalogVersion: 'next', priceMinor: '20000' } },
  ];
  const next = replaceCartLine(current, original, water, 1);
  assert.equal(next[0].product.catalogVersion, 'next');
  assert.equal(cartTotal(next), '25000');
});
