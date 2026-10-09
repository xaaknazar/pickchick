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
test('removed required option is dropped and flagged, never replaced with another default', () => {
  const current = {
    ...product,
    modifierGroups: [
      { id: 'drink', min: 1, max: 1, options: [{ id: 'water', default_selected: true }] },
    ],
  };
  const next = repriceCart(cart, [current]);
  assert.deepEqual(next.cart[0].selections, []);
  assert.equal(next.cart[0].issue, 'choose_options');
  assert.deepEqual(next.changes.optionsDropped, [cartLineKey(cart[0])]);
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
test('version 2 storage preserves unavailable dishes and unfinished configuration after restart', () => {
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
      { id: product.id, key: 'combo-old', quantity: 1, selections: [] },
    ],
  };
  const next = restoreCart(parsePreferences(JSON.stringify(saved)), [product], 'published:2');
  assert.equal(next.length, 2);
  assert.equal(next[0].issue, 'unavailable');
  assert.equal(next[1].issue, 'choose_options');
  assert.equal(cartTotal(next), '32000');
});
