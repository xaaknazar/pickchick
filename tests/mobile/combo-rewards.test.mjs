import {
  comboNextStep,
  comboProgressView,
  matchesPaidComboCart,
} from '../../apps/mobile/src/loyalty/combo-progress.ts';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { CustomerComboRewardsSchema } from '../../packages/contracts/src/combo-rewards.ts';
import {
  COMBO_REWARD_THRESHOLD,
  comboRewardProgress,
} from '../../packages/commerce-core/src/combo-rewards.ts';

const progress = (earnedUnits, usedGifts = 0, reservedGifts = 0) =>
  comboRewardProgress({ earnedUnits, usedGifts, reservedGifts });

test('owner rule 27.10.2026: six paid combos earn the seventh as a gift', () => {
  assert.equal(COMBO_REWARD_THRESHOLD, 6);
  assert.equal(progress(5).availableGifts, 0);
  assert.equal(progress(5).remainingToNextGift, 1);
  assert.equal(progress(6).availableGifts, 1);
});

test('one purchased unit is one stamp, even when several units share a receipt', () => {
  for (let units = 0; units < 6; units++) {
    const result = progress(units);
    assert.equal(result.visibleStamps, units);
    assert.equal(result.availableGifts, 0);
    assert.equal(result.remainingToNextGift, 6 - units);
  }
  assert.equal(progress(6).visibleStamps, 6);
  assert.equal(progress(6).availableGifts, 1);
});

test('excess purchased units carry into the next cycle; gifts accumulate separately', () => {
  for (const [units, stamps, gifts] of [
    [7, 1, 1],
    [11, 5, 1],
    [12, 6, 2],
    [13, 1, 2],
    [18, 6, 3],
    [1001, 5, 166],
    [1002, 6, 167],
  ]) {
    assert.equal(progress(units).visibleStamps, stamps);
    assert.equal(progress(units).availableGifts, gifts);
  }
});

test('using or holding a gift does not earn another stamp or discard a remainder', () => {
  assert.equal(progress(6, 1).availableGifts, 0);
  assert.equal(progress(6, 1).visibleStamps, 0);
  assert.equal(progress(6, 0, 1).visibleStamps, 6);
  assert.equal(progress(7, 1).visibleStamps, 1);
  assert.equal(progress(13, 1, 1).availableGifts, 0);
  assert.equal(progress(13, 1, 1).currentStamps, 1);
  // Cancelling a definitively unpaid checkout releases its hold, not its stamps.
  assert.equal(progress(13, 1, 0).availableGifts, 1);
});

test('returns after gift use expose reconciliation, not an invented debt or new gift', () => {
  const result = progress(5, 1);
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.availableGifts, 0);
  assert.equal(result.visibleStamps, 5);
  assert.equal(progress(0, 0, 1).visibleStamps, 0);
  assert.equal(progress(6, 1).reconciliationRequired, false);
  assert.equal(progress(6, 1).availableGifts, 0);
  assert.equal(progress(12, 1).availableGifts, 1);
});

// Exact copy of CustomerComboRewardsSchema in installed builds 21 and 23 (82ddc326).
// It must keep accepting every response of the 6 + 1 API.
const zod = createRequire(new URL('../../packages/contracts/package.json', import.meta.url))('zod');
const count = zod.z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const installedBuildSchema = zod.z.discriminatedUnion('enabled', [
  zod.z.strictObject({ enabled: zod.z.literal(false) }),
  zod.z.strictObject({
    enabled: zod.z.literal(true),
    programId: zod.z.uuid(),
    giftProductId: zod.z.literal('pick-combo'),
    earnedUnits: count,
    completedCycles: count,
    currentStamps: count.max(6),
    availableGifts: count,
    usedGifts: count,
    reservedGifts: count,
    reconciliationRequired: zod.z.boolean(),
    visibleStamps: count.max(7),
    remainingToNextGift: count.min(1).max(7),
  }),
]);
const response = (balance) => ({
  enabled: true,
  programId: '40000000-0000-4000-8000-000000000010',
  giftProductId: 'pick-combo',
  ...balance,
});
// The old API arithmetic (threshold 7), kept here only to model an un-updated server.
function oldApiProgress(earnedUnits, usedGifts = 0, reservedGifts = 0) {
  const completedCycles = Math.floor(earnedUnits / 7),
    currentStamps = earnedUnits % 7,
    committed = usedGifts + reservedGifts,
    availableGifts = Math.max(0, completedCycles - committed),
    reconciliationRequired = committed > completedCycles;
  return {
    earnedUnits,
    completedCycles,
    currentStamps,
    availableGifts,
    usedGifts,
    reservedGifts,
    reconciliationRequired,
    visibleStamps:
      currentStamps === 0 && !reconciliationRequired && (availableGifts > 0 || reservedGifts > 0)
        ? 7
        : currentStamps,
    remainingToNextGift: 7 - currentStamps,
  };
}
const balances = [];
for (let units = 0; units <= 30; units++)
  for (const [used, held] of [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
    [3, 0],
  ])
    balances.push([units, used, held]);

test('installed builds 21/23 parse every 6 + 1 response without a new field', () => {
  for (const [units, used, held] of balances) {
    const body = response(progress(units, used, held));
    assert.deepEqual(Object.keys(body).sort(), Object.keys(response(oldApiProgress(0))).sort());
    assert.ok(installedBuildSchema.safeParse(body).success, JSON.stringify(body));
    assert.ok(CustomerComboRewardsSchema.safeParse(body).success, JSON.stringify(body));
  }
});

test('the new app parses an API still on 7 + 1 and never draws more than six stamps', () => {
  for (const [units, used, held] of balances) {
    const body = CustomerComboRewardsSchema.parse(response(oldApiProgress(units, used, held)));
    const state = { status: 'ready', data: null, commercial: body };
    const view = comboProgressView(state);
    assert.ok(view.count >= 0 && view.count <= 6, JSON.stringify(body));
    assert.equal(view.count, Math.min(body.visibleStamps, 6));
    assert.ok(comboNextStep(state).title.length > 0);
  }
  // A just-completed old card (7 of 7) shows all six slots, never an overflow.
  const completed = CustomerComboRewardsSchema.parse(response(oldApiProgress(7)));
  assert.equal(completed.visibleStamps, 7);
  assert.equal(comboProgressView({ status: 'ready', data: null, commercial: completed }).count, 6);
});

test('negative, fractional and unsafe balances are never rendered as real progress', () => {
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '7', null]) {
    for (const field of ['earnedUnits', 'usedGifts', 'reservedGifts']) {
      assert.throws(
        () =>
          comboRewardProgress({ earnedUnits: 6, usedGifts: 0, reservedGifts: 0, [field]: invalid }),
        /INVALID_COMBO_BALANCE/,
      );
    }
  }
  assert.throws(() => progress(6, Number.MAX_SAFE_INTEGER, 1), /INVALID_COMBO_BALANCE/);
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
