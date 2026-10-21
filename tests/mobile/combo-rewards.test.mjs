import { matchesPaidComboCart } from '../../apps/mobile/src/loyalty/combo-progress.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { comboRewardProgress } from '../../packages/commerce-core/src/combo-rewards.ts';

const progress = (earnedUnits, usedGifts = 0, reservedGifts = 0) =>
  comboRewardProgress({ earnedUnits, usedGifts, reservedGifts });

test('one purchased unit is one stamp, even when several units share a receipt', () => {
  for (let units = 0; units < 7; units++) {
    const result = progress(units);
    assert.equal(result.visibleStamps, units);
    assert.equal(result.availableGifts, 0);
    assert.equal(result.remainingToNextGift, 7 - units);
  }
  assert.equal(progress(7).visibleStamps, 7);
  assert.equal(progress(7).availableGifts, 1);
});

test('excess purchased units carry into the next cycle; gifts accumulate separately', () => {
  for (const [units, stamps, gifts] of [
    [8, 1, 1],
    [13, 6, 1],
    [14, 7, 2],
    [15, 1, 2],
    [21, 7, 3],
    [1001, 7, 143],
  ]) {
    assert.equal(progress(units).visibleStamps, stamps);
    assert.equal(progress(units).availableGifts, gifts);
  }
});

test('using or holding a gift does not earn another stamp or discard a remainder', () => {
  assert.equal(progress(7, 1).availableGifts, 0);
  assert.equal(progress(7, 1).visibleStamps, 0);
  assert.equal(progress(8, 1).visibleStamps, 1);
  assert.equal(progress(15, 1, 1).availableGifts, 0);
  assert.equal(progress(15, 1, 1).currentStamps, 1);
  // Cancelling a definitively unpaid checkout releases its hold, not its stamps.
  assert.equal(progress(15, 1, 0).availableGifts, 1);
});

test('returns after gift use expose reconciliation, not an invented debt or new gift', () => {
  const result = progress(6, 1);
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.availableGifts, 0);
  assert.equal(result.visibleStamps, 6);
  assert.equal(progress(0, 0, 1).visibleStamps, 0);
  assert.equal(progress(7, 1).reconciliationRequired, false);
  assert.equal(progress(7, 1).availableGifts, 0);
  assert.equal(progress(14, 1).availableGifts, 1);
});

test('negative, fractional and unsafe balances are never rendered as real progress', () => {
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '7', null]) {
    for (const field of ['earnedUnits', 'usedGifts', 'reservedGifts']) {
      assert.throws(
        () =>
          comboRewardProgress({ earnedUnits: 7, usedGifts: 0, reservedGifts: 0, [field]: invalid }),
        /INVALID_COMBO_BALANCE/,
      );
    }
  }
  assert.throws(() => progress(7, Number.MAX_SAFE_INTEGER, 1), /INVALID_COMBO_BALANCE/);
});

test('paid gift recovery recognizes the saved cart after restart without clearing a changed cart', () => {
  const cart = {
    items: [
      {
        productId: 'pick-combo',
        quantity: 1,
        selections: [{ group_id: 'drink', option_id: 'cola', quantity: 1 }],
      },
    ],
    serviceMode: 'takeaway',
  };
  const pending = JSON.stringify({ ...cart, giftItemIndex: 0, kitchenComment: 'Без соли' });
  const restarted = JSON.stringify({ ...cart, kitchenComment: 'Без соли' });
  assert.equal(matchesPaidComboCart(pending, restarted), true);
  assert.equal(matchesPaidComboCart(pending, pending), true);
  assert.equal(
    matchesPaidComboCart(pending, JSON.stringify({ ...cart, kitchenComment: 'Другая корзина' })),
    false,
  );
  assert.equal(
    matchesPaidComboCart(
      pending,
      JSON.stringify({
        ...cart,
        items: [{ productId: 'pick-combo', quantity: 2, selections: [] }],
        kitchenComment: 'Без соли',
      }),
    ),
    false,
  );
  assert.equal(matchesPaidComboCart('broken', restarted), false);
  assert.equal(matchesPaidComboCart('null', restarted), false);
});
