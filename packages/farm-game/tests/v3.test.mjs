import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFarm,
  applyFarmCommand as run,
  upgradeFarmState,
  FarmStateSchema,
  landBounds,
  nextLandExpansion,
  isUnlockedCell,
  animalStatus,
  animalCost,
  boardEntries,
  boardOrder,
  dailyStatus,
  itemCount,
  DAILY_REWARDS,
  LAND_MAX,
  LEVEL_XP,
  FARM_PROTOCOL,
} from '../dist/index.js';

const MIN = 60000;
const DAY = 86400000;
const rich = (xp = 2000, coins = 100000) => ({ ...createFarm(0), xp, coins });

test('protocol 3 rules version is exported for client and API', () => {
  assert.equal(FARM_PROTOCOL, 3);
});

test('new farms open a central 12x12 square; expansions grow it to the full field', () => {
  let s = createFarm(0);
  assert.deepEqual(landBounds(s), { minX: 26, maxX: 37, minY: 26, maxY: 37, land: 0 });
  assert.throws(() => run(s, { type: 'buyPlot', x: 16, y: 16 }, 0), /CELL_LOCKED/);
  assert.throws(() => run(s, { type: 'buyPlot', x: 3, y: 3 }, 0), /CELL_OUTSIDE_FIELD/);
  s = run(s, { type: 'buyPlot', x: 26, y: 26 }, 0);
  assert.throws(() => run({ ...s, coins: 10000 }, { type: 'expandLand' }, 0), /LAND_LOCKED/);
  assert.throws(
    () => run({ ...s, xp: LEVEL_XP[1], coins: 100 }, { type: 'expandLand' }, 0),
    /INSUFFICIENT_COINS/,
  );
  s = { ...s, xp: 5000, coins: 100000 };
  for (let i = 0; i < LAND_MAX; i++) {
    const before = s.coins;
    const expansion = nextLandExpansion(s);
    s = run(s, { type: 'expandLand' }, 0);
    assert.equal(s.coins, before - expansion.cost);
    assert.equal(landBounds(s).land, i + 1);
  }
  assert.deepEqual(landBounds(s), { minX: 16, maxX: 47, minY: 16, maxY: 47, land: LAND_MAX });
  assert.equal(nextLandExpansion(s), null);
  assert.throws(() => run(s, { type: 'expandLand' }, 0), /LAND_MAX/);
  assert.equal(isUnlockedCell(s, 16, 16), true);
  // Moving an object into locked land is refused like a purchase.
  const small = run({ ...createFarm(0), coins: 1000 }, { type: 'buyPlot', x: 30, y: 30 }, 0);
  assert.throws(() => run(small, { type: 'movePlot', plotId: 0, x: 40, y: 40 }, 0), /CELL_LOCKED/);
});

test('saves from before land expansion keep the whole field', () => {
  const old = createFarm(0);
  delete old.progression.land;
  assert.equal(landBounds(old).land, LAND_MAX);
  assert.ok(run({ ...old, coins: 1000 }, { type: 'buyPlot', x: 16, y: 47 }, 0).plots.length);
  const legacy = upgradeFarmState({ ...old, progression: undefined });
  assert.equal(landBounds(legacy).land, LAND_MAX);
});

test('coop: buy pen and chickens, feed with carrots, collect eggs after 20 minutes', () => {
  let s = rich(LEVEL_XP[1] - 1);
  assert.throws(() => run(s, { type: 'buyPen', pen: 'coop' }, 0), /PEN_LOCKED/);
  s = { ...s, xp: LEVEL_XP[1] };
  assert.throws(() => run(s, { type: 'buyAnimal', kind: 'chicken' }, 0), /PEN_NOT_OWNED/);
  s = run(s, { type: 'buyPen', pen: 'coop' }, 0);
  assert.throws(() => run(s, { type: 'buyPen', pen: 'coop' }, 0), /PEN_OWNED/);
  const prices = [];
  for (let i = 0; i < 6; i++) {
    prices.push(animalCost(s, 'chicken'));
    s = run(s, { type: 'buyAnimal', kind: 'chicken' }, 0);
  }
  assert.deepEqual(prices, [60, 80, 100, 120, 140, 160]);
  assert.throws(() => run(s, { type: 'buyAnimal', kind: 'chicken' }, 0), /PEN_FULL/);
  assert.throws(() => run(s, { type: 'feedAnimals', kind: 'chicken' }, 0), /INSUFFICIENT_FEED/);
  s = { ...s, inventory: { ...s.inventory, carrot: 4 } };
  s = run(s, { type: 'feedAnimals', kind: 'chicken' }, 0);
  assert.equal(s.inventory.carrot, 0, 'four carrots feed four of six chickens');
  const status = animalStatus(s, 'chicken', 0);
  assert.equal(status.busy.length, 4);
  assert.equal(status.hungry.length, 2);
  assert.throws(
    () => run(s, { type: 'collectAnimals', kind: 'chicken' }, 20 * MIN - 1),
    /ANIMALS_NOT_READY/,
  );
  const xp = s.xp;
  s = run(s, { type: 'collectAnimals', kind: 'chicken' }, 20 * MIN);
  assert.equal(s.progression.goods.egg, 4);
  assert.equal(s.xp, xp + 8);
  assert.equal(animalStatus(s, 'chicken', 20 * MIN).hungry.length, 6);
  const coins = s.coins;
  s = run(s, { type: 'sellGood', good: 'egg', quantity: 1 }, 20 * MIN);
  assert.equal(s.coins, coins + 14);
  assert.throws(
    () => run(s, { type: 'sellGood', good: 'egg', quantity: 4 }, 0),
    /INSUFFICIENT_INVENTORY/,
  );
  assert.equal(FarmStateSchema.safeParse(s).success, true);
});

test('cows give milk; eggs and milk feed kitchen recipes', () => {
  let s = rich();
  s = run(s, { type: 'buyPen', pen: 'barn' }, 0);
  s = run(s, { type: 'buyAnimal', kind: 'cow' }, 0);
  s = { ...s, inventory: { ...s.inventory, tomato: 2, strawberry: 5 } };
  s = run(s, { type: 'feedAnimals', kind: 'cow' }, 0);
  s = run(s, { type: 'collectAnimals', kind: 'cow' }, 60 * MIN);
  assert.equal(itemCount(s, 'milk'), 1);
  s = run(s, { type: 'buyStation', stationId: 'kitchen' }, 60 * MIN);
  s = run(s, { type: 'startProduction', recipeId: 'milkshake' }, 60 * MIN);
  assert.equal(itemCount(s, 'milk'), 0);
  assert.equal(s.inventory.strawberry, 2);
  assert.throws(
    () => run(s, { type: 'startProduction', recipeId: 'pancakes' }, 60 * MIN),
    /INSUFFICIENT_INVENTORY/,
  );
});

test('order board: deterministic requests, rewards, cooldowns and order counters', () => {
  let s = run(rich(LEVEL_XP[5]), { type: 'claimDaily' }, 0);
  const board = boardEntries(s);
  assert.equal(board.length, 3);
  const order = boardOrder(0, board[0]);
  assert.deepEqual(boardOrder(0, board[0]), order, 'same entry, same order');
  assert.ok(Object.keys(order.requires).length >= 1 && order.rewardCoins > 0);
  assert.throws(() => run(s, { type: 'fulfillBoard', slot: 0 }, 0), /ORDER_NOT_READY/);
  const stock = { ...s.inventory };
  const goods = { egg: 9, milk: 9 };
  const products = { ...s.progression.products };
  for (const id of Object.keys(order.requires)) {
    if (id in stock) stock[id] = 50;
    else if (id in goods) goods[id] = 9;
    else products[id] = 9;
  }
  s = { ...s, inventory: stock, progression: { ...s.progression, goods, products } };
  const before = s;
  s = run(s, { type: 'fulfillBoard', slot: 0 }, 1000);
  assert.equal(s.coins, before.coins + order.rewardCoins);
  assert.equal(s.xp, before.xp + order.rewardXp);
  assert.equal(s.progression.orders, before.progression.orders + 1);
  for (const [id, n] of Object.entries(order.requires))
    assert.equal(itemCount(s, id), itemCount(before, id) - n);
  assert.equal(s.progression.board[0].gen, board[0].gen + 3);
  assert.equal(s.progression.board[0].readyAt, 1000 + MIN);
  assert.throws(() => run(s, { type: 'fulfillBoard', slot: 0 }, 1000 + MIN - 1), /BOARD_NOT_READY/);
  s = run(s, { type: 'skipBoard', slot: 1 }, 2000);
  assert.equal(s.progression.board[1].readyAt, 2000 + 5 * MIN);
  assert.notDeepEqual(boardOrder(1, s.progression.board[1]), boardOrder(1, board[1]));
});

test('daily reward: once per server day, streak continues, a missed day restarts it', () => {
  let s = createFarm(0);
  assert.deepEqual(dailyStatus(s, 0), { available: true, streak: 1, reward: DAILY_REWARDS[0] });
  s = run(s, { type: 'claimDaily' }, 10);
  assert.equal(s.coins, 500 + DAILY_REWARDS[0].coins);
  assert.throws(() => run(s, { type: 'claimDaily' }, DAY - 1), /REWARD_CLAIMED/);
  for (let d = 1; d < 7; d++) s = run(s, { type: 'claimDaily' }, d * DAY);
  assert.equal(s.progression.daily.streak, 7);
  assert.equal(dailyStatus(s, 7 * DAY).reward, DAILY_REWARDS[0], 'the ladder repeats after 7');
  s = run(s, { type: 'claimDaily' }, 9 * DAY);
  assert.equal(s.progression.daily.streak, 1);
});

test('a version 2 save gains the board and every recipe on its first command', () => {
  const old = createFarm(0);
  old.progression.products = { jam: 2, juice: 0, bouquet: 0, 'spring-bouquet': 0 };
  delete old.progression.board;
  const parsed = upgradeFarmState(old);
  assert.equal(parsed.progression.board, undefined);
  const next = run(parsed, { type: 'claimDaily' }, 0);
  assert.equal(next.progression.board.length, 3);
  assert.equal(next.progression.products.jam, 2);
  assert.equal(next.progression.products.pancakes, 0);
  assert.equal(FarmStateSchema.safeParse(next).success, true);
});
