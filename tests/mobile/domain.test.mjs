import test from 'node:test';
import assert from 'node:assert/strict';
import {
  money,
  cartTotal,
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
});

test('restoration resolves server-owned product data and discards obsolete releases', () => {
  assert.deepEqual(restoreCart(preferences, [product], 'release-1'), [{ product, quantity: 2 }]);
  assert.deepEqual(restoreCart(preferences, [product], 'release-2'), []);
  assert.deepEqual(restoreCart(preferences, [], 'release-1'), []);
  assert.deepEqual(restoreCart(preferences, [{ ...product, source: 'design' }], 'release-1'), []);
});
