import assert from 'node:assert/strict';
import test from 'node:test';
import {
  withAvailability,
  unavailableCartLine,
  parseAvailability,
} from '../../apps/mobile/src/availability.ts';
const product = {
  id: 'pick-combo',
  priceMinor: '419000',
  modifierGroups: [
    {
      id: 'drink',
      min: 1,
      max: 1,
      options: [
        { id: 'cola', available: true },
        { id: 'tea', available: false },
      ],
    },
  ],
};
const base = {
  enabled: true,
  fresh: true,
  signature: 'a'.repeat(64),
  products: [{ id: product.id, available: false, stoppedOptions: [] }],
};
test('stops preserve products and basket composition; removing stop restores only server-available options', () => {
  const stopped = withAvailability([product], base)[0];
  assert.equal(stopped.available, false);
  assert.equal(stopped.priceMinor, '419000');
  assert.equal(product.available, undefined);
  assert.equal(unavailableCartLine({ product: stopped, quantity: 1 }), 'Сейчас нет в наличии');
  const state = {
    ...base,
    products: [
      { id: product.id, available: true, stoppedOptions: [{ groupId: 'drink', optionId: 'cola' }] },
    ],
  };
  const modified = withAvailability([product], state)[0];
  const cart = {
    product: modified,
    quantity: 1,
    selections: [{ group_id: 'drink', option_id: 'cola', quantity: 1 }],
  };
  assert.match(unavailableCartLine(cart), /вариант закончился/);
  const restored = withAvailability([product], {
    ...base,
    products: [{ id: product.id, available: true, stoppedOptions: [] }],
  })[0];
  assert.equal(restored.modifierGroups[0].options[0].available, true);
  assert.equal(restored.modifierGroups[0].options[1].available, false);
  assert.equal(cart.selections[0].option_id, 'cola');
});
test('malformed or unbounded availability is rejected; unknown product is unavailable', () => {
  assert.deepEqual(parseAvailability(base), base);
  assert.throws(() => parseAvailability({ ...base, products: [{}] }));
  assert.throws(() => parseAvailability({ ...base, signature: 'bad' }));
  assert.equal(withAvailability([product], { ...base, products: [] })[0].available, false);
});
