import test from 'node:test';
import assert from 'node:assert/strict';
import {
  money,
  cartTotal,
  clearMatchingCart,
  updateQuantity,
  parsePreferences,
  restoreCart,
} from '../../apps/mobile/src/domain.ts';

const product = {
  id: 'test',
  name: 'Example',
  description: '',
  category: 'Menu',
  priceMinor: '349000',
  image: 1,
  source: 'server',
};
const preferences = {
  version: 1,
  catalogMode: 'server',
  diningMode: 'takeaway',
  locale: 'ru',
  nickname: '',
  branchId: null,
  releaseId: 'release-1',
  lines: [{ id: 'test', quantity: 2 }],
};

test('mobile totals preserve minor units beyond Number safe range', () => {
  assert.equal(money('349000'), '3 490 ₸');
  assert.equal(money('101'), '1,01 ₸');
  assert.equal(money('0'), '0 ₸');
  assert.equal(
    cartTotal([{ product: { ...product, priceMinor: '9007199254740993' }, quantity: 2 }]),
    '18014398509481986',
  );
  assert.throws(() => money('34.90'));
  assert.throws(() => money('-1'));
});

test('local basket bounds quantities and never combines design with server items', () => {
  const lines = updateQuantity([], product, 2);
  assert.equal(cartTotal(lines), '698000');
  assert.deepEqual(updateQuantity(lines, product, 21), lines);
  assert.deepEqual(updateQuantity(lines, product, 1.5), lines);
  assert.deepEqual(updateQuantity(lines, { ...product, id: 'design', source: 'design' }, 1), lines);
  assert.deepEqual(updateQuantity(lines, product, 0), []);
});

test('delayed order approval never clears a different current basket', () => {
  const paid = [{ id: product.id, quantity: 1 }];
  const original = [{ product, quantity: 1 }];
  const changedQuantity = updateQuantity(original, product, 2);
  const newItem = updateQuantity(original, { ...product, id: 'second' }, 1);
  assert.deepEqual(clearMatchingCart(original, paid), []);
  assert.equal(clearMatchingCart(changedQuantity, paid), changedQuantity);
  assert.equal(clearMatchingCart(newItem, paid), newItem);
  assert.deepEqual(clearMatchingCart(newItem), []);
});

test('untrusted local preferences reject corrupt, oversized, duplicate and invalid quantities', () => {
  assert.equal(parsePreferences('{'), null);
  assert.equal(parsePreferences('x'.repeat(20001)), null);
  assert.equal(parsePreferences(JSON.stringify({ ...preferences, version: 2 })), null);
  assert.equal(
    parsePreferences(
      JSON.stringify({ ...preferences, lines: [...preferences.lines, ...preferences.lines] }),
    ),
    null,
  );
  for (const quantity of [-1, 0, 21, 1.2, '2']) {
    assert.equal(
      parsePreferences(JSON.stringify({ ...preferences, lines: [{ id: 'test', quantity }] })),
      null,
    );
  }
  assert.deepEqual(parsePreferences(JSON.stringify(preferences)), preferences);
  assert.deepEqual(
    parsePreferences(JSON.stringify({ ...preferences, orderComment: 'Соус отдельно' })),
    { ...preferences, orderComment: 'Соус отдельно' },
  );
  assert.equal(
    parsePreferences(JSON.stringify({ ...preferences, orderComment: 'а'.repeat(61) })),
    null,
  );
});

test('restoration resolves server-owned product data and discards obsolete releases', () => {
  assert.deepEqual(restoreCart(preferences, [product], 'release-1'), [{ product, quantity: 2 }]);
  assert.deepEqual(restoreCart(preferences, [product], 'release-2'), []);
  assert.deepEqual(restoreCart(preferences, [], 'release-1'), []);
  assert.deepEqual(restoreCart(preferences, [{ ...product, source: 'design' }], 'release-1'), []);
});

// Different combo choices must retain their own price/quantity through restart
// and late payment responses, without trusting amounts saved on the device.
test('combo variants preserve server-defined selection prices and independent lines', async () => {
  const { defaultSelections, cartLineKey, lineUnitPrice, validSelections } =
    await import('../../apps/mobile/src/domain.ts');
  const { testCompleteCatalog } = await import('@pickchick/test-order-flow/complete-catalog');
  const item = testCompleteCatalog.products.find((p) => p.id === 'pick-combo');
  const combo = {
    ...product,
    id: item.id,
    priceMinor: item.price_minor,
    modifierGroups: item.modifier_groups,
  };
  const standard = defaultSelections(combo);
  const changed = standard
    .filter((s) => s.group_id !== 'drink')
    .concat({ group_id: 'drink', option_id: 'lemonade', quantity: 1 });
  const first = updateQuantity([], combo, 1, standard);
  const both = updateQuantity(first, combo, 2, changed);
  assert.equal(both.length, 2);
  assert.equal(lineUnitPrice(both[0]), item.price_minor);
  assert.equal(BigInt(lineUnitPrice(both[1])) - BigInt(item.price_minor), 20000n);
  assert.equal(validSelections(combo, changed.concat(changed[0])), false);
  assert.equal(
    validSelections(combo, [{ group_id: 'drink', option_id: 'forged', quantity: 1 }]),
    false,
  );
  const saved = {
    ...preferences,
    lines: both.map((l) => ({ id: l.product.id, quantity: l.quantity, selections: l.selections })),
  };
  const parsed = parsePreferences(JSON.stringify(saved));
  assert.ok(parsed);
  const restored = restoreCart(parsed, [combo], 'release-1');
  assert.equal(cartTotal(restored), cartTotal(both));
  assert.deepEqual(restored.map(cartLineKey), both.map(cartLineKey));
  const paidDifferentChoice = [{ id: cartLineKey(both[0]), quantity: 2 }];
  assert.equal(clearMatchingCart([both[1]], paidDifferentChoice)[0], both[1]);
  assert.deepEqual(
    clearMatchingCart(
      both,
      both.map((l) => ({ id: cartLineKey(l), quantity: l.quantity })),
    ),
    [],
  );
});
