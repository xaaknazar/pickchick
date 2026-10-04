import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFarm,
  applyFarmCommand as run,
  FarmStateSchema,
  FarmCommandSchema,
  CROPS,
} from '../dist/index.js';
const plant = (state, cropId = 'carrot', now = 0, plotId = 0) =>
  run(state, { type: 'plant', cropId, plotId }, now);
const harvest = (state, now, plotId = 0) => run(state, { type: 'harvest', plotId }, now);
test('growth deadline exact, immutable and only successful commands increment revision', () => {
  const original = createFarm(0);
  const planted = plant(original);
  assert.equal(original.plots[0].cropId, null);
  assert.equal(planted.revision, 1);
  assert.throws(() => harvest(planted, 29999), /CROP_NOT_READY/);
  const ready = harvest(planted, 30000);
  assert.equal(ready.inventory.carrot, 3);
  assert.equal(ready.revision, 2);
  assert.equal(ready.plots[0].cropId, null);
});
test('rejects impossible actions and untrusted clock/state/reward payloads', () => {
  const state = createFarm(0);
  assert.throws(() => harvest(state, 0), /PLOT_EMPTY/);
  assert.throws(() => plant(state, 'carrot', 0, 40), /PLOT_NOT_FOUND/);
  assert.throws(() => plant(plant(state)), /PLOT_OCCUPIED/);
  assert.throws(() => harvest(plant(state, 'carrot', 100), 99), /CLOCK_BEFORE_PLANTING/);
  assert.equal(
    FarmCommandSchema.safeParse({ type: 'harvest', plotId: 0, now: 999999 }).success,
    false,
  );
  assert.equal(
    FarmCommandSchema.safeParse({ type: 'sell', cropId: 'carrot', quantity: 1.5 }).success,
    false,
  );
  assert.equal(FarmStateSchema.safeParse({ ...state, coins: Infinity }).success, false);
  assert.equal(FarmStateSchema.safeParse({ ...state, rewardCoins: 100 }).success, false);
  const corrupt = structuredClone(state);
  corrupt.plots[1].id = 0;
  assert.equal(FarmStateSchema.safeParse(corrupt).success, false);
  corrupt.plots[1].id = 1;
  corrupt.plots[1].harvests = 1;
  assert.equal(FarmStateSchema.safeParse(corrupt).success, false);
});
test('apple has three independently timed harvests', () => {
  let state = plant(createFarm(0), 'apple');
  for (let cycle = 1; cycle <= 3; cycle++) {
    assert.throws(() => harvest(state, cycle * 180000 - 1), /CROP_NOT_READY/);
    state = harvest(state, cycle * 180000);
    assert.equal(state.inventory.apple, cycle * 3);
    assert.equal(state.plots[0].plantedAt, cycle === 3 ? null : cycle * 180000);
  }
  assert.throws(() => harvest(state, 720000), /PLOT_EMPTY/);
});
test('sales and repeatable orders consume inventory exactly once', () => {
  let state = harvest(plant(createFarm(0)), 30000);
  state = run(state, { type: 'sell', cropId: 'carrot', quantity: 2 }, 30000);
  assert.equal(state.coins, 102);
  assert.equal(state.inventory.carrot, 1);
  assert.throws(
    () => run(state, { type: 'sell', cropId: 'carrot', quantity: 2 }, 30000),
    /INSUFFICIENT_INVENTORY/,
  );
  state.inventory.carrot = 6;
  state.inventory.tomato = 6;
  state = run(state, { type: 'fulfill', orderId: 'vegetable-basket' }, 30000);
  state = run(state, { type: 'fulfill', orderId: 'vegetable-basket' }, 30000);
  assert.equal(state.completedOrders, 2);
  assert.equal(state.inventory.tomato, 0);
  assert.throws(
    () => run(state, { type: 'fulfill', orderId: 'vegetable-basket' }, 30000),
    /ORDER_NOT_READY/,
  );
});
test('expansion caps plots and reserves starter seed money, progression bounded', () => {
  let state = createFarm(0);
  state.coins = 10000;
  for (let i = 0; i < 12; i++) state = run(state, { type: 'expand' }, 0);
  assert.equal(state.plots.length, 24);
  assert.throws(() => run(state, { type: 'expand' }, 0), /MAX_PLOTS/);
  state = createFarm(0);
  state.coins = 50;
  assert.throws(() => run(state, { type: 'expand' }, 0), /INSUFFICIENT_COINS/);
  state.coins = 54;
  assert.equal(run(state, { type: 'expand' }, 0).coins, 4);
  state.coins = 1000000000;
  state.inventory.carrot = 1;
  assert.throws(
    () => run(state, { type: 'sell', cropId: 'carrot', quantity: 1 }, 0),
    /PROGRESSION_LIMIT/,
  );
});
test('every crop creates positive economy from initial purchase', () => {
  for (const crop of CROPS) {
    let state = plant(createFarm(0), crop.id);
    for (let i = 1; i <= crop.maxHarvests; i++) state = harvest(state, i * crop.growSeconds * 1000);
    state = run(
      state,
      { type: 'sell', cropId: crop.id, quantity: state.inventory[crop.id] },
      crop.growSeconds * crop.maxHarvests * 1000,
    );
    assert.ok(state.coins > 100);
  }
});
