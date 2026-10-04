import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFarm,
  applyFarmCommand as run,
  FarmCommandSchema,
  CROPS,
  cropEconomics,
  nextLandCost,
  canRecoverFarm,
} from '../dist/index.js';
import { economyScenarios } from '../scripts/simulate-economy.mjs';

const planted = () =>
  run(
    run(createFarm(0), { type: 'buyPlot', x: 0, y: 0 }, 0),
    { type: 'plant', plotId: 0, cropId: 'carrot' },
    0,
  );
test('atomic sale and legacy/explicit storage yield equal economic value and one lifecycle transition', () => {
  const input = planted();
  const before = globalThis.structuredClone(input);
  const sold = run(input, { type: 'harvest', plotId: 0, destination: 'sell' }, 3600000);
  const stored = run(input, { type: 'harvest', plotId: 0, destination: 'storage' }, 3600000);
  const legacy = run(input, { type: 'harvest', plotId: 0 }, 3600000);
  assert.deepEqual(legacy, stored);
  assert.equal(sold.coins, input.coins + 12);
  assert.equal(sold.inventory.carrot, 0);
  assert.equal(sold.xp, 10);
  assert.equal(sold.revision, input.revision + 1);
  assert.equal(sold.plots[0].cropId, null);
  assert.equal(
    run(stored, { type: 'sell', cropId: 'carrot', quantity: 3 }, 3600000).coins,
    sold.coins,
  );
  assert.deepEqual(input, before);
  assert.deepEqual(FarmCommandSchema.parse({ type: 'harvest', plotId: 0 }), {
    type: 'harvest',
    plotId: 0,
  });
  assert.throws(
    () => run(sold, { type: 'harvest', plotId: 0, destination: 'sell' }, 3600000),
    /PLOT_EMPTY/,
  );
  assert.equal(
    FarmCommandSchema.safeParse({ type: 'harvest', plotId: 0, destination: 'money' }).success,
    false,
  );
  assert.throws(
    () =>
      run(
        { ...input, coins: 1000000000 },
        { type: 'harvest', plotId: 0, destination: 'sell' },
        3600000,
      ),
    /PROGRESSION_LIMIT/,
  );
  assert.throws(
    () => run(input, { type: 'harvest', plotId: 0, destination: 'sell' }, 7200000),
    /CROP_WITHERED/,
  );
});
test('longer bed crops increase per-harvest profit while short crops reward frequent visits', () => {
  const crops = [...CROPS]
    .filter((c) => c.kind !== 'tree')
    .sort((a, b) => a.growSeconds - b.growSeconds);
  let profit = 0,
    hourly = Infinity;
  for (const crop of crops) {
    const economics = cropEconomics(crop.id);
    assert.equal(economics.revenue, crop.sellPrice * crop.harvestYield);
    assert.equal(economics.plantingCost, crop.seedCost);
    assert.ok(economics.profit > profit);
    assert.ok(economics.profit / economics.growthSeconds < hourly);
    profit = economics.profit;
    hourly = economics.profit / economics.growthSeconds;
    assert.equal(economics.paybackHarvests, Math.ceil(150 / economics.profit));
  }
  const apple = cropEconomics('apple');
  assert.deepEqual(apple, {
    revenue: 30,
    plantingCost: 250,
    profit: 30,
    growthSeconds: 28800,
    paybackHarvests: 9,
  });
  assert.ok(
    apple.paybackHarvests * apple.growthSeconds > cropEconomics('carrot').paybackHarvests * 3600,
  );
  let tree = run(createFarm(0), { type: 'buyTree', x: 0, y: 0, cropId: 'apple' }, 0);
  for (let cycle = 1; cycle <= 9; cycle++)
    tree = run(tree, { type: 'harvest', plotId: 0, destination: 'sell' }, cycle * 28800000);
  assert.equal(tree.coins, 520);
  assert.equal(tree.inventory.apple, 0);
  assert.equal(tree.plots[0].cropId, 'apple');
});
test('land price grows quadratically by lifetime placements and cannot reset via deletion', () => {
  let state = createFarm(0);
  assert.equal(nextLandCost(state, 'bed'), 150);
  assert.equal(nextLandCost(state, 'tree'), 250);
  state = run(state, { type: 'buyPlot', x: 0, y: 0 }, 0);
  assert.equal(nextLandCost(state, 'bed'), 175);
  state = run(state, { type: 'removePlot', plotId: 0 }, 0);
  assert.equal(nextLandCost(state, 'bed'), 175);
  assert.equal(canRecoverFarm({ ...state, coins: 154 }, 0), true);
  assert.equal(canRecoverFarm({ ...state, coins: 179 }, 0), false);
  assert.throws(
    () => run({ ...state, coins: 174 }, { type: 'buyPlot', x: 0, y: 0 }, 0),
    /INSUFFICIENT_COINS/,
  );
  const recovered = run({ ...state, coins: 0 }, { type: 'recover' }, 0);
  assert.equal(recovered.coins, 0);
  assert.equal(recovered.xp, 0);
  assert.equal(nextLandCost(recovered, 'bed'), 250);
});
test('deterministic 1/7/30 day active, casual, reinvestment and missed-window simulations stay bounded', () => {
  const results = economyScenarios();
  assert.deepEqual(
    results.map(({ coins, plots, harvests, losses, recoveries }) => [
      coins,
      plots,
      harvests,
      losses,
      recoveries,
    ]),
    [
      [551, 2, 48, 0, 0],
      [343, 2, 8, 0, 0],
      [78, 4, 68, 0, 0],
      [159, 2, 0, 2, 0],
      [2855, 2, 336, 0, 0],
      [1639, 2, 56, 0, 0],
      [347, 10, 1064, 0, 0],
      [111, 2, 0, 14, 0],
      [11687, 2, 1440, 0, 0],
      [6607, 2, 240, 0, 0],
      [4236, 21, 9840, 0, 0],
      [3, 2, 0, 51, 9],
    ],
  );
  for (const days of [1, 7, 30]) {
    const [active, casual, reinvest, loss] = results.filter((item) => item.days === days);
    assert.equal(active.plots, 2);
    assert.equal(casual.plots, 2);
    assert.ok(active.coins > casual.coins);
    assert.ok(casual.coins > 0);
    assert.ok(reinvest.plots >= 2 && reinvest.plots < 100);
    assert.ok(reinvest.harvests >= active.harvests);
    assert.equal(loss.harvests, 0);
    assert.equal(loss.xp, 0);
    assert.ok(loss.losses > 0);
    assert.ok(loss.coins >= 0 && loss.coins < 175);
    assert.ok(active.coins < 1000000000 && reinvest.coins < 1000000000);
  }
  assert.ok(results.find((item) => item.days === 30 && item.intervalHours === 24).recoveries > 0);
});
