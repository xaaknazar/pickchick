import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFarm,
  applyFarmCommand as run,
  FarmStateSchema,
  FarmCommandSchema,
  CROPS,
  cropPhase,
  upgradeFarmState,
  BED_COST,
  TREE_COST,
  HOUSE_CELL,
} from '../dist/index.js';
const bed = (state = createFarm(0), x = 0, y = 0) => run(state, { type: 'buyPlot', x, y }, 0);
const plant = (state = bed(), cropId = 'carrot', now = 0) =>
  run(state, { type: 'plant', cropId, plotId: 0 }, now);
const harvest = (state, now) => run(state, { type: 'harvest', plotId: 0 }, now);
test('empty field, placement prices, collision, reserved cell and immutable moves', () => {
  const initial = createFarm(0);
  assert.equal(initial.plots.length, 0);
  assert.equal(initial.coins, 500);
  const purchased = bed(initial);
  assert.equal(purchased.coins, 500 - BED_COST);
  assert.equal(initial.plots.length, 0);
  assert.throws(() => bed(purchased), /CELL_OCCUPIED/);
  assert.throws(() => bed(initial, HOUSE_CELL.x, HOUSE_CELL.y), /CELL_RESERVED/);
  const moved = run(purchased, { type: 'movePlot', plotId: 0, x: 63, y: 63 }, 0);
  assert.equal(moved.coins, purchased.coins);
  assert.equal(purchased.plots[0].x, 0);
  assert.throws(
    () => run(bed(purchased, 1, 1), { type: 'movePlot', plotId: 0, x: 1, y: 1 }, 0),
    /CELL_OCCUPIED/,
  );
  assert.throws(() => bed({ ...initial, coins: 149 }), /INSUFFICIENT_COINS/);
  for (const x of [-1, 64, 1.5, Infinity])
    assert.equal(FarmCommandSchema.safeParse({ type: 'buyPlot', x, y: 0 }).success, false);
});
test('every crop has an equal harvest window and exact growth/loss boundaries', () => {
  for (const crop of CROPS) {
    let state =
      crop.kind === 'tree'
        ? run(createFarm(0), { type: 'buyTree', cropId: 'apple', x: 0, y: 0 }, 0)
        : plant(bed(), crop.id);
    const deadline = crop.growSeconds * 1000;
    const plot = state.plots[0];
    assert.equal(crop.harvestWindowSeconds, crop.growSeconds);
    assert.equal(cropPhase(plot, deadline - 1), 'growing');
    assert.throws(() => harvest(state, deadline - 1), /CROP_NOT_READY/);
    assert.equal(cropPhase(plot, deadline), 'ready');
    assert.equal(harvest(state, deadline).inventory[crop.id], 3);
    assert.equal(cropPhase(plot, 2 * deadline - 1), 'ready');
    assert.equal(harvest(state, 2 * deadline - 1).inventory[crop.id], 3);
    assert.equal(cropPhase(plot, 2 * deadline), 'withered');
    assert.throws(() => harvest(state, 2 * deadline), /CROP_WITHERED/);
    const cleared = run(state, { type: 'clear', plotId: 0 }, 2 * deadline);
    assert.equal(cleared.inventory[crop.id], 0);
    assert.equal(cleared.xp, 0);
    assert.equal(cleared.plots[0].cropId, crop.kind === 'tree' ? 'apple' : null);
    assert.throws(() => run(state, { type: 'clear', plotId: 0 }, deadline), /CROP_NOT_WITHERED/);
  }
});
test('permanent trees continue after three harvests and lost fruit, beds remain empty', () => {
  let state = run(createFarm(0), { type: 'buyTree', cropId: 'apple', x: 0, y: 0 }, 0);
  assert.equal(state.coins, 500 - TREE_COST);
  const growth = CROPS.find((c) => c.id === 'apple').growSeconds * 1000;
  for (let cycle = 1; cycle <= 7; cycle++) {
    state = harvest(state, cycle * growth);
    assert.equal(state.plots[0].cropId, 'apple');
    assert.equal(state.plots[0].harvests, cycle % 3);
  }
  state = run(state, { type: 'clear', plotId: 0 }, 9 * growth);
  assert.equal(state.plots[0].plantedAt, 9 * growth);
  assert.equal(state.inventory.apple, 21);
  assert.throws(() => plant(bed(), 'apple'), /CROP_REQUIRES_TREE/);
  const empty = harvest(plant(), 3600000);
  assert.equal(empty.plots.length, 1);
  assert.equal(cropPhase(empty.plots[0], 3600000), 'empty');
});
test('strict state/command validation and trusted clock protect progression', () => {
  const state = plant(bed(), 'carrot', 100);
  assert.throws(() => run(state, { type: 'expand' }, 100), /LEGACY_COMMAND/);
  assert.throws(() => harvest(state, 99), /CLOCK_BEFORE_PLANTING/);
  for (const command of [
    { type: 'harvest', plotId: 0, now: 999999 },
    { type: 'buyTree', x: 0, y: 0, cropId: 'carrot' },
    { type: 'sell', cropId: 'carrot', quantity: 1.5 },
  ])
    assert.equal(FarmCommandSchema.safeParse(command).success, false);
  for (const altered of [
    { ...state, coins: Infinity },
    { ...state, rewardCoins: 1 },
    { ...state, plots: [...state.plots, { ...state.plots[0], id: 1 }] },
    { ...state, plots: [{ ...state.plots[0], harvests: 1 }] },
    { ...state, plots: [{ ...state.plots[0], kind: 'tree' }] },
  ])
    assert.equal(FarmStateSchema.safeParse(altered).success, false);
  assert.throws(
    () =>
      run(
        {
          ...createFarm(0),
          coins: 1000000000,
          inventory: { ...createFarm(0).inventory, carrot: 1 },
        },
        { type: 'sell', cropId: 'carrot', quantity: 1 },
        0,
      ),
    /PROGRESSION_LIMIT/,
  );
});
test('sales and repeated orders consume inventory, failed actions leave inputs unchanged', () => {
  let state = harvest(plant(), 3600000);
  const before = globalThis.structuredClone(state);
  state = run(state, { type: 'sell', cropId: 'carrot', quantity: 2 }, 3600000);
  assert.equal(state.coins, 352);
  assert.deepEqual(before.inventory, {
    carrot: 3,
    tomato: 0,
    strawberry: 0,
    sunflower: 0,
    tulip: 0,
    apple: 0,
  });
  assert.throws(
    () => run(state, { type: 'sell', cropId: 'carrot', quantity: 2 }, 3600000),
    /INSUFFICIENT_INVENTORY/,
  );
  state.inventory.carrot = 6;
  state.inventory.tomato = 6;
  for (let i = 0; i < 2; i++)
    state = run(state, { type: 'fulfill', orderId: 'vegetable-basket' }, 3600000);
  assert.equal(state.completedOrders, 2);
  assert.equal(state.inventory.carrot, 0);
  assert.throws(
    () => run(state, { type: 'fulfill', orderId: 'vegetable-basket' }, 3600000),
    /ORDER_NOT_READY/,
  );
});
test('legacy upgrade preserves progress/timestamps with deterministic unique positions', () => {
  const legacy = {
    ...createFarm(0),
    version: 1,
    revision: 14,
    coins: 123,
    xp: 45,
    completedOrders: 2,
    plots: Array.from({ length: 24 }, (_, id) => ({
      id,
      cropId: id === 0 ? 'apple' : id === 1 ? 'carrot' : null,
      plantedAt: id < 2 ? 100 : null,
      harvests: id === 0 ? 2 : 0,
    })),
  };
  legacy.inventory.carrot = 15;
  const migrated = upgradeFarmState(legacy);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.revision, 14);
  assert.equal(migrated.coins, 123);
  assert.equal(migrated.inventory.carrot, 15);
  assert.equal(migrated.plots[0].kind, 'tree');
  assert.equal(migrated.plots[0].plantedAt, 100);
  assert.equal(migrated.plots[0].harvests, 2);
  assert.equal(new Set(migrated.plots.map((p) => `${p.x},${p.y}`)).size, 24);
  assert.deepEqual(upgradeFarmState(migrated), migrated);
  assert.deepEqual(upgradeFarmState(legacy), migrated);
  assert.equal(legacy.version, 1);
  assert.throws(() => upgradeFarmState({ ...legacy, plots: [legacy.plots[0]] }));
  assert.throws(() => upgradeFarmState({ ...legacy, version: 99 }));
});
test('full field permits 4095 unique cells and rejects extra purchases', () => {
  const state = createFarm(0);
  state.coins = 1000;
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      if (x === HOUSE_CELL.x && y === HOUSE_CELL.y) continue;
      state.plots.push({
        id: state.plots.length,
        x,
        y,
        kind: 'bed',
        cropId: null,
        plantedAt: null,
        harvests: 0,
      });
    }
  assert.equal(FarmStateSchema.safeParse(state).success, true);
  assert.throws(() => run(state, { type: 'buyPlot', x: 0, y: 0 }, 0), /MAX_PLOTS/);
  assert.equal(state.plots.length, 4095);
});
