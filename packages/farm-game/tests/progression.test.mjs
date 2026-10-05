import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFarm,
  applyFarmCommand as run,
  cropPhase,
  cropTiming,
  questProgress,
  goalProgress,
  FarmStateSchema,
  nextLandCost,
} from '../dist/index.js';
const plant = () =>
  run(
    run(createFarm(0), { type: 'buyPlot', x: 16, y: 16 }, 0),
    { type: 'plant', plotId: 0, cropId: 'carrot' },
    0,
  );
test('tutorial is limited to two cycles; legacy timer unaffected and new safe window exact', () => {
  let s = plant();
  assert.equal(cropTiming(s.plots[0]).growSeconds, 45);
  for (let i = 1; i <= 3; i++) {
    s = run(s, { type: 'harvest', plotId: 0 }, i * 300000);
    s = run(s, { type: 'plant', plotId: 0, cropId: 'carrot' }, i * 300000);
  }
  assert.equal(cropTiming(s.plots[0]).growSeconds, 300);
  const old = { ...s.plots[0] };
  delete old.timing;
  assert.equal(cropPhase(old, old.plantedAt + 3599999), 'growing');
  assert.equal(cropPhase(old, old.plantedAt + 7200000), 'withered');
  assert.equal(cropPhase(s.plots[0], s.plots[0].plantedAt + 129900000), 'withered');
});
test('chapter rewards are once only and starter decoration can be placed freely', () => {
  let s = run(plant(), { type: 'harvest', plotId: 0 }, 45000);
  s = run(s, { type: 'claimQuest', questId: 'first-harvest' }, 45000);
  assert.equal(questProgress(s)[0].claimed, true);
  assert.throws(
    () => run(s, { type: 'claimQuest', questId: 'first-harvest' }, 45000),
    /REWARD_CLAIMED/,
  );
  const coins = s.coins;
  s = run(s, { type: 'placeDecoration', instanceId: 0, x: 17, y: 16 }, 45000);
  assert.equal(s.coins, coins);
  assert.throws(
    () => run(s, { type: 'movePlot', plotId: 0, x: 17, y: 16 }, 45000),
    /CELL_OCCUPIED/,
  );
});
test('production consumes inputs once, serializes three jobs and never repeats output', () => {
  let s = createFarm(0);
  s.xp = 2500;
  s.inventory.strawberry = 12;
  s = run(s, { type: 'buyStation', stationId: 'kitchen' }, 0);
  for (let i = 0; i < 3; i++) s = run(s, { type: 'startProduction', recipeId: 'jam' }, 0);
  assert.equal(s.inventory.strawberry, 3);
  assert.throws(() => run(s, { type: 'startProduction', recipeId: 'jam' }, 0), /QUEUE_FULL/);
  assert.throws(
    () => run(s, { type: 'collectProduction', stationId: 'kitchen', jobId: 0 }, 899999),
    /PRODUCTION_NOT_READY/,
  );
  s = run(s, { type: 'collectProduction', stationId: 'kitchen', jobId: 0 }, 900000);
  assert.equal(s.progression.products.jam, 1);
  assert.throws(
    () => run(s, { type: 'collectProduction', stationId: 'kitchen', jobId: 0 }, 900000),
    /JOB_NOT_FOUND/,
  );
  assert.equal(s.progression.stations[0].queue[0].readyAt, 1800000);
});
test('daily reward resets baseline and weekly reward requires current week activity', () => {
  let s = plant();
  for (let i = 1; i <= 3; i++) {
    s = run(s, { type: 'harvest', plotId: 0 }, i * 300000);
    s = run(s, { type: 'plant', plotId: 0, cropId: 'carrot' }, i * 300000);
  }
  assert.equal(goalProgress(s, 900000)[0].progress, 3);
  s = run(s, { type: 'claimGoal', goalId: 'daily-harvest' }, 900000);
  assert.throws(
    () => run(s, { type: 'claimGoal', goalId: 'daily-harvest' }, 900000),
    /REWARD_CLAIMED/,
  );
  assert.throws(
    () => run(s, { type: 'claimGoal', goalId: 'weekly-garden' }, 8 * 86400000),
    /GOAL_NOT_READY/,
  );
});
test('storage preserves tree timers and category prices; malformed ownership rejected', () => {
  let s = run(createFarm(0), { type: 'buyTree', cropId: 'apple', x: 16, y: 16 }, 0);
  const price = nextLandCost(s, 'tree');
  s = run(s, { type: 'storePlot', plotId: 0 }, 1000);
  assert.equal(nextLandCost(s, 'tree'), price);
  assert.throws(() => run(s, { type: 'harvest', plotId: 0 }, 28800000), /PLOT_NOT_FOUND/);
  s = run(s, { type: 'placePlot', plotId: 0, x: 17, y: 17 }, 28800000);
  assert.equal(s.plots[0].plantedAt, 0);
  s.progression.storedPlots.push({ ...s.plots[0] });
  assert.equal(FarmStateSchema.safeParse(s).success, false);
});
test('explicit reservation stores needed units while sale routes only excess', () => {
  let s = run(plant(), { type: 'setOrderReserve', orderId: 'welcome-basket' }, 0);
  s = run(s, { type: 'harvest', plotId: 0, destination: 'sell' }, 45000);
  assert.equal(s.inventory.carrot, 3);
  s = run(s, { type: 'plant', plotId: 0, cropId: 'carrot' }, 45000);
  s = run(s, { type: 'harvest', plotId: 0, destination: 'sell' }, 90000);
  assert.equal(s.inventory.carrot, 3);
  assert.equal(s.coins, 354);
});

test('three-day absence withers but permits recovery and 90-day full-field bounds fit currency cap', async () => {
  const s = plant();
  assert.equal(cropPhase(s.plots[0], 3 * 86400000), 'withered');
  const { fullFieldBounds } = await import('../scripts/simulate-economy.mjs');
  for (const b of fullFieldBounds(90)) {
    assert.ok(b.grossCoins < 1000000000);
    assert.ok(b.xp < 1000000000);
  }
});
