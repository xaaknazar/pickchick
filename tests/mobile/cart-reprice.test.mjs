import test from 'node:test';
import assert from 'node:assert/strict';
import { repriceCart } from '../../apps/mobile/src/cart-reprice.ts';
import {
  cartLineKey,
  cartTotal,
  restoreCart,
  parsePreferences,
  updateQuantity,
} from '../../apps/mobile/src/domain.ts';
const product = {
  id: 'combo',
  name: 'Combo',
  category: 'Combo',
  description: '',
  image: 0,
  source: 'server',
  available: true,
  catalogVersion: 'published:1',
  priceMinor: '10000',
  modifierGroups: [
    { id: 'drink', min: 1, max: 1, options: [{ id: 'cola', price_delta_minor: '1000' }] },
  ],
};
const choices = [{ group_id: 'drink', option_id: 'cola', quantity: 1 }];
const cart = [{ product, quantity: 2, selections: choices }];
test('publication reprices the entire basket atomically, retaining quantities and choices', () => {
  const current = { ...product, catalogVersion: 'published:2', priceMinor: '15000' };
  const next = repriceCart(cart, [current]);
  assert.equal(cartTotal(next.cart), '32000');
  assert.equal(next.changes.oldTotal, '22000');
  assert.equal(next.cart[0].previousUnitPriceMinor, '11000');
  assert.deepEqual(next.cart[0].selections, choices);
  assert.equal(next.cart[0].quantity, 2);
  assert.equal(cartLineKey(next.cart[0]), cartLineKey(cart[0]));
  assert.equal(updateQuantity(next.cart, current, 3, choices).length, 1);
  assert.equal(repriceCart(next.cart, [current]).changes.oldTotal, '22000');
  assert.deepEqual(
    repriceCart(
      next.cart.map((line) => ({ ...line, previousUnitPriceMinor: undefined })),
      [current],
    ).changes.priceChanged,
    [],
  );
});
test('a line whose chosen option left the menu is removed entirely, never re-chosen', () => {
  const other = { ...product, id: 'toast', modifierGroups: [] };
  const basket = [...cart, { product: other, quantity: 1 }];
  const current = {
    ...product,
    catalogVersion: 'published:2',
    modifierGroups: [
      { id: 'drink', min: 1, max: 1, options: [{ id: 'water', default_selected: true }] },
    ],
  };
  const next = repriceCart(basket, [current, other]);
  assert.equal(next.cart.length, 1);
  assert.equal(next.cart[0].product.id, 'toast');
  assert.deepEqual(next.changes.removed, [cartLineKey(cart[0])]);
  assert.deepEqual(next.changes.priceChanged, []);
  assert.equal(next.changes.oldTotal, '32000');
  assert.equal(next.changes.newTotal, '10000');
  assert.ok(!('optionsDropped' in next.changes) && !('needsChoice' in next.changes));
});
test('an optional option that left the menu also removes the line', () => {
  const optional = {
    ...product,
    modifierGroups: [
      {
        id: 'sauce',
        min: 0,
        max: 2,
        options: [
          { id: 'cheese', price_delta_minor: '500' },
          { id: 'bbq', price_delta_minor: '0' },
        ],
      },
    ],
  };
  const line = {
    product: optional,
    quantity: 1,
    selections: [{ group_id: 'sauce', option_id: 'cheese', quantity: 1 }],
  };
  const current = {
    ...optional,
    modifierGroups: [{ ...optional.modifierGroups[0], options: [{ id: 'bbq' }] }],
  };
  const next = repriceCart([line], [current]);
  assert.deepEqual(next.cart, []);
  assert.equal(next.changes.newTotal, '0');
});
test('removed dish remains visible, cannot be checked out, returns when republished', () => {
  const removed = repriceCart(cart, []);
  assert.equal(removed.cart.length, 1);
  assert.equal(removed.cart[0].issue, 'unavailable');
  assert.equal(cartTotal(removed.cart), '22000');
  const restored = repriceCart(removed.cart, [product]);
  assert.equal(restored.cart[0].issue, undefined);
  assert.deepEqual(restored.cart[0].selections, choices);
});
test('version 2 storage keeps unavailable dishes and drops lines whose option left the menu', () => {
  const saved = {
    version: 2,
    catalogMode: 'server',
    diningMode: 'takeaway',
    locale: 'ru',
    nickname: '',
    branchId: null,
    releaseId: 'published:2',
    lines: [
      {
        id: 'removed',
        key: 'removed-old',
        quantity: 2,
        unavailable: { name: 'Removed', unitMinor: '11000' },
      },
      { id: product.id, key: 'combo-empty', quantity: 1, selections: [] },
      {
        id: product.id,
        key: 'combo-gone',
        quantity: 1,
        selections: [{ group_id: 'drink', option_id: 'gone', quantity: 1 }],
      },
      { id: product.id, key: 'combo-ok', quantity: 1, selections: choices },
    ],
  };
  const next = restoreCart(parsePreferences(JSON.stringify(saved)), [product], 'published:2');
  assert.deepEqual(
    next.map((line) => line.key),
    ['removed-old', 'combo-ok'],
  );
  assert.equal(next[0].issue, 'unavailable');
  assert.equal(next[1].issue, undefined);
  assert.equal(cartTotal(next), '33000');
});
test('restore keeps a stopped dish marked unavailable, drops gone options and removed dishes', () => {
  const stopped = {
    ...product,
    available: false,
    modifierGroups: [
      {
        id: 'drink',
        min: 1,
        max: 1,
        options: [{ id: 'cola', price_delta_minor: '1000', available: false }],
      },
    ],
  };
  const saved = (lines) => ({
    version: 2,
    catalogMode: 'server',
    diningMode: 'takeaway',
    locale: 'ru',
    nickname: '',
    branchId: null,
    releaseId: 'published:2',
    lines,
  });
  const restore = (lines, products) =>
    restoreCart(parsePreferences(JSON.stringify(saved(lines))), products, 'published:2');
  const stoppedLine = restore(
    [{ id: product.id, key: 'combo-stopped', quantity: 2, selections: choices }],
    [stopped],
  );
  assert.equal(stoppedLine.length, 1);
  assert.equal(stoppedLine[0].key, 'combo-stopped');
  assert.equal(stoppedLine[0].issue, 'unavailable');
  assert.equal(stoppedLine[0].quantity, 2);
  assert.deepEqual(stoppedLine[0].selections, choices);
  // Back on sale: the same saved line restores without an issue.
  assert.equal(
    restore(
      [{ id: product.id, key: 'combo-stopped', quantity: 2, selections: choices }],
      [product],
    )[0].issue,
    undefined,
  );
  // Stopped dish whose chosen option left the publication: removed.
  const withoutCola = {
    ...stopped,
    modifierGroups: [{ id: 'drink', min: 1, max: 1, options: [{ id: 'water' }] }],
  };
  assert.deepEqual(
    restore(
      [{ id: product.id, key: 'combo-gone', quantity: 1, selections: choices }],
      [withoutCola],
    ),
    [],
  );
  // Available dish whose chosen option left the publication: removed.
  assert.deepEqual(
    restore(
      [{ id: product.id, key: 'combo-gone', quantity: 1, selections: choices }],
      [{ ...withoutCola, available: true }],
    ),
    [],
  );
  // Dish removed from the publication: kept only with a saved snapshot, otherwise dropped.
  assert.deepEqual(
    restore([{ id: product.id, key: 'combo-x', quantity: 1, selections: choices }], []),
    [],
  );
  const snap = restore(
    [
      {
        id: product.id,
        key: 'combo-x',
        quantity: 1,
        unavailable: { name: 'Combo', unitMinor: '11000' },
      },
    ],
    [],
  );
  assert.equal(snap.length, 1);
  assert.equal(snap[0].issue, 'unavailable');
});
test('reprice keeps a stopped dish in the basket marked unavailable', () => {
  const next = repriceCart(cart, [{ ...product, available: false }]);
  assert.equal(next.cart.length, 1);
  assert.equal(next.cart[0].issue, 'unavailable');
  assert.deepEqual(next.changes.removed, []);
});
