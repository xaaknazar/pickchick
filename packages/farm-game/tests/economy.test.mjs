import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFarm as newFarm,
  LAND_MAX,
  applyFarmCommand as run,
  FarmCommandSchema,
  CROPS,
  cropEconomics,
  nextLandCost,
} from '../dist/index.js';
// These checks predate land expansion: start from a farm with all land opened.
const createFarm = (now) => {
  const farm = newFarm(now);
  return { ...farm, progression: { ...farm.progression, land: LAND_MAX } };
};
import { economyScenarios } from '../scripts/simulate-economy.mjs';

const planted = () =>
  run(
    run(createFarm(0), { type: 'buyPlot', x: 16, y: 16 }, 0),
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
  assert.equal(sold.xp, 5);
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
    () => run(input, { type: 'harvest', plotId: 0, destination: 'sell' }, 129645000),
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
  let tree = run(createFarm(0), { type: 'buyTree', x: 16, y: 16, cropId: 'apple' }, 0);
  for (let cycle = 1; cycle <= 9; cycle++)
    tree = run(tree, { type: 'harvest', plotId: 0, destination: 'sell' }, cycle * 28800000);
  assert.equal(tree.coins, 520);
  assert.equal(tree.inventory.apple, 0);
  assert.equal(tree.plots[0].cropId, 'apple');
});
test('land price scales linearly within categories and stored beds retain purchase count', () => {
  let s = run(createFarm(0), { type: 'buyPlot', x: 16, y: 16 }, 0);
  assert.equal(nextLandCost(s, 'bed'), 175);
  assert.equal(nextLandCost(s, 'tree'), 250);
  s = run(s, { type: 'storePlot', plotId: 0 }, 0);
  assert.equal(nextLandCost(s, 'bed'), 175);
  const coins = s.coins;
  s = run(s, { type: 'placePlot', plotId: 0, x: 17, y: 17 }, 0);
  assert.equal(s.coins, coins);
});
test('daily and absent profiles preserve meaningful harvests and bounded balances', () => {
  const results = economyScenarios();
  for (const r of results) {
    assert.ok(r.coins >= 0 && r.coins < 1000000000);
    assert.ok(r.xp < 1000000000);
    assert.ok(r.plots <= 1024);
    assert.equal(r.losses, 0);
    assert.ok(r.harvests > 0);
  }
});
