import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFarm,
  applyFarmCommand as run,
  FarmStateSchema,
  FarmCommandSchema,
  CROPS,
  cropPhase,
  cropTiming,
  isWatered,
  canWater,
  growthProgress,
  msUntilReady,
  HARVEST_WINDOW_SECONDS,
  WATER_XP,
  BATCH_LIMIT,
  upgradeFarmState,
} from '../dist/index.js';

const HOUR = 3600000;
function garden(count = 4, coins = 5000) {
  let state = { ...createFarm(0), coins };
  for (let i = 0; i < count; i++) state = run(state, { type: 'buyPlot', x: 20 + i, y: 20 }, 0);
  // Spend the two 45-second tutorial carrots so the regular balance applies.
  state = run(state, { type: 'plant', plotId: 0, cropId: 'carrot' }, 0);
  state = run(state, { type: 'harvest', plotId: 0, destination: 'sell' }, 45000);
  state = run(state, { type: 'plant', plotId: 0, cropId: 'carrot' }, 45000);
  return run(state, { type: 'harvest', plotId: 0, destination: 'sell' }, 90000);
}

test('watering speeds maturity by a quarter without moving the wither deadline', () => {
  for (const crop of CROPS.filter((c) => c.kind !== 'tree')) {
    let state = run(garden(1), { type: 'plant', plotId: 0, cropId: crop.id }, HOUR);
    const before = state.plots[0];
    assert.equal(isWatered(before), false);
    assert.equal(canWater(before, HOUR), true);
    const deadline = HOUR + (crop.growSeconds + HARVEST_WINDOW_SECONDS) * 1000;
    const xp = state.xp;
    state = run(state, { type: 'water', plotId: 0 }, HOUR + 1000);
    const plot = state.plots[0];
    const saved = Math.floor(crop.growSeconds * 0.25);
    assert.equal(cropTiming(plot).growSeconds, crop.growSeconds - saved);
    assert.equal(cropTiming(plot).harvestWindowSeconds, HARVEST_WINDOW_SECONDS + saved);
    assert.equal(state.xp, xp + WATER_XP);
    assert.equal(
      state.coins,
      run(garden(1), { type: 'plant', plotId: 0, cropId: crop.id }, HOUR).coins,
    );
    assert.equal(isWatered(plot), true);
    assert.equal(canWater(plot, HOUR + 2000), false);
    const ready = HOUR + (crop.growSeconds - saved) * 1000;
    assert.equal(cropPhase(plot, ready - 1), 'growing');
    assert.equal(cropPhase(plot, ready), 'ready');
    assert.equal(cropPhase(plot, deadline - 1), 'ready');
    assert.equal(cropPhase(plot, deadline), 'withered');
    assert.throws(() => run(state, { type: 'water', plotId: 0 }, HOUR + 2000), /ALREADY_WATERED/);
    assert.equal(FarmStateSchema.safeParse(state).success, true);
  }
});

test('watering rules: growing crops only, trees every cycle, legacy plantings once', () => {
  let state = garden(2);
  assert.throws(() => run(state, { type: 'water', plotId: 1 }, HOUR), /PLOT_EMPTY/);
  assert.throws(() => run(state, { type: 'water', plotId: 99 }, HOUR), /PLOT_NOT_FOUND/);
  state = run(state, { type: 'plant', plotId: 1, cropId: 'carrot' }, HOUR);
  assert.throws(() => run(state, { type: 'water', plotId: 1 }, HOUR + 300000), /CROP_NOT_GROWING/);

  let tree = run(
    { ...createFarm(0), coins: 1000 },
    { type: 'buyTree', cropId: 'apple', x: 30, y: 30 },
    0,
  );
  tree = run(tree, { type: 'water', plotId: 0 }, 1000);
  const grow = cropTiming(tree.plots[0]).growSeconds;
  tree = run(tree, { type: 'harvest', plotId: 0, destination: 'storage' }, grow * 1000);
  assert.equal(isWatered(tree.plots[0]), false, 'next fruiting cycle can be watered again');
  assert.equal(canWater(tree.plots[0], grow * 1000 + 1), true);

  // A planting saved before timing existed keeps its historical clock until watered.
  const legacy = upgradeFarmState({
    version: 2,
    revision: 3,
    coins: 0,
    xp: 0,
    completedOrders: 0,
    nextPlotId: 1,
    inventory: { carrot: 0, tomato: 0, strawberry: 0, sunflower: 0, tulip: 0, apple: 0 },
    plots: [{ id: 0, x: 30, y: 30, kind: 'bed', cropId: 'tomato', plantedAt: 0, harvests: 0 }],
  });
  assert.equal(isWatered(legacy.plots[0]), false);
  const watered = run(legacy, { type: 'water', plotId: 0 }, HOUR);
  assert.deepEqual(cropTiming(watered.plots[0]), {
    growSeconds: 8100,
    harvestWindowSeconds: 13500,
    rewardXp: 10,
  });
  assert.equal(isWatered(watered.plots[0]), true);
  assert.equal(cropPhase(watered.plots[0], 21600000 - 1), 'ready', 'legacy deadline unchanged');
  assert.equal(cropPhase(watered.plots[0], 21600000), 'withered');
});

test('batched sweeps equal the same single commands and skip objects that changed', () => {
  let state = garden(6);
  const ids = state.plots.map((p) => p.id);
  const many = run(state, { type: 'plantMany', plotIds: ids, cropId: 'strawberry' }, HOUR);
  let single = state;
  for (const plotId of ids)
    single = run(single, { type: 'plant', plotId, cropId: 'strawberry' }, HOUR);
  assert.deepEqual({ ...many, revision: 0 }, { ...single, revision: 0 });
  assert.equal(many.revision, state.revision + 1);

  const watered = run(many, { type: 'waterMany', plotIds: ids }, HOUR + 1);
  assert.equal(watered.xp, many.xp + ids.length * WATER_XP);
  assert.ok(watered.plots.every(isWatered));
  // Already watered objects are skipped, a fully stale batch is rejected unchanged.
  assert.throws(
    () => run(watered, { type: 'waterMany', plotIds: ids }, HOUR + 2),
    /ALREADY_WATERED/,
  );
  const ready = HOUR + 1 + cropTiming(watered.plots[0]).growSeconds * 1000;
  const harvested = run(
    watered,
    { type: 'harvestMany', plotIds: [...ids, 404], destination: 'sell' },
    ready,
  );
  const strawberry = CROPS.find((c) => c.id === 'strawberry');
  assert.equal(harvested.coins, watered.coins + ids.length * strawberry.sellPrice * 3);
  assert.equal(harvested.progression.harvested, watered.progression.harvested + ids.length);
  assert.ok(harvested.plots.every((p) => p.cropId === null));
  assert.throws(
    () => run(harvested, { type: 'harvestMany', plotIds: ids, destination: 'sell' }, ready),
    /PLOT_EMPTY/,
  );
});

test('batch planting stops charging at the balance and validates the list', () => {
  const state = { ...garden(5), coins: 2 * CROPS.find((c) => c.id === 'tomato').seedCost + 3 };
  const result = run(
    state,
    { type: 'plantMany', plotIds: state.plots.map((p) => p.id), cropId: 'tomato' },
    HOUR,
  );
  assert.equal(result.plots.filter((p) => p.cropId === 'tomato').length, 2);
  assert.equal(result.coins, 3);
  assert.throws(
    () => run({ ...state, coins: 0 }, { type: 'plantMany', plotIds: [0], cropId: 'tomato' }, HOUR),
    /INSUFFICIENT_COINS/,
  );
  for (const plotIds of [[], [1, 1], Array.from({ length: BATCH_LIMIT + 1 }, (_, i) => i)])
    assert.equal(
      FarmCommandSchema.safeParse({ type: 'waterMany', plotIds }).success,
      false,
      JSON.stringify(plotIds).slice(0, 20),
    );
});

test('growth helpers follow the timing fixed at planting, including tutorial carrots', () => {
  let state = { ...createFarm(0), coins: 1000 };
  state = run(state, { type: 'buyPlot', x: 20, y: 20 }, 0);
  state = run(state, { type: 'plant', plotId: 0, cropId: 'carrot' }, 0);
  const plot = state.plots[0];
  assert.equal(growthProgress(plot, 22500), 0.5);
  assert.equal(msUntilReady(plot, 22500), 22500);
  assert.equal(growthProgress(plot, 99999), 1);
  assert.equal(msUntilReady(plot, 99999), 0);
});
