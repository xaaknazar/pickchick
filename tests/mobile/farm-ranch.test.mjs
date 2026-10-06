import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFarm,
  isPlantingCell,
  isUnlockedCell,
  HOUSE_DISPLAY_CELL,
  LAND_MAX,
} from '../../packages/farm-game/dist/index.js';
import { isoPoint } from '../../apps/mobile/src/games/pick-farm/geometry.ts';
import {
  PEN_ART,
  PEN_CORNER,
  SPOTS,
  SCENERY,
  penAt,
  penCenter,
  penRect,
  landSigns,
  landSignAt,
} from '../../apps/mobile/src/games/pick-farm/ranch-layout.ts';

const PENS = ['coop', 'barn'];

test('coop and barn yards stand outside the planting field and away from the house', () => {
  for (const pen of PENS) {
    const c = PEN_CORNER[pen],
      yard = PEN_ART[pen].yard;
    for (let x = c.x; x <= c.x + yard.x; x += 0.25)
      for (let y = c.y; y <= c.y + yard.y; y += 0.25) {
        const cell = { x: Math.round(x), y: Math.round(y) };
        assert.equal(isPlantingCell(cell.x, cell.y), false, `${pen} covers field cell ${x},${y}`);
      }
    // The house sprite starts at its display cell and is 240 px wide.
    const house = isoPoint(HOUSE_DISPLAY_CELL.x, HOUSE_DISPLAY_CELL.y);
    assert.ok(penRect(pen).minX > house.x + 240 - 20, `${pen} overlaps the house`);
  }
  const coop = penRect('coop'),
    barn = penRect('barn');
  assert.ok(coop.maxX - barn.minX < 12, 'pens barely touch, never overlap');
});

test('a tap on a pen opens it; field cells and open grass are not pens', () => {
  for (const pen of PENS) assert.equal(penAt(penCenter(pen)), pen);
  for (const [x, y] of [
    [16, 16],
    [31, 31],
    [47, 16],
    [16, 47],
  ])
    assert.equal(penAt(isoPoint(x, y)), null, `${x},${y}`);
});

test('animals stand inside their yard, clear of the fence', () => {
  for (const pen of PENS) {
    const yard = PEN_ART[pen].yard;
    for (const spot of SPOTS[pen]) {
      assert.ok(spot.x > 0.2 && spot.x < yard.x - 0.2, `${pen} ${spot.x}`);
      assert.ok(spot.y > 0.2 && spot.y < yard.y - 0.2, `${pen} ${spot.y}`);
    }
  }
  assert.equal(SPOTS.coop.length, 6, 'one spot per coop place');
  assert.equal(SPOTS.barn.length, 4, 'one spot per barn place');
});

test('scenery never stands on the field, the pens or the workshops', () => {
  for (const item of SCENERY) {
    for (const dx of [-1, 0, 1])
      for (const dy of [-1, 0, 1])
        assert.equal(
          isPlantingCell(Math.round(item.x + dx), Math.round(item.y + dy)),
          false,
          `${item.kind} at ${item.x},${item.y} is on the field`,
        );
    const p = isoPoint(item.x, item.y);
    assert.equal(penAt(p, 30), null, `${item.kind} at ${item.x},${item.y} is in a pen`);
    for (const station of [
      { x: 13, y: 18 },
      { x: 13, y: 21 },
    ])
      assert.ok(
        Math.hypot(item.x - station.x, item.y - station.y) > 3,
        `${item.kind} near a workshop`,
      );
  }
});

test('land sale signs stand on locked field ground at every stage, none when all is open', () => {
  let s = createFarm(0);
  for (let land = 0; land < LAND_MAX; land++) {
    s = { ...s, progression: { ...s.progression, land } };
    const signs = landSigns(s);
    assert.equal(signs.length, 2);
    for (const sign of signs) {
      const cell = { x: Math.round(sign.x), y: Math.round(sign.y) };
      assert.equal(isPlantingCell(cell.x, cell.y), true, `land ${land}: sign off the field`);
      assert.equal(isUnlockedCell(s, cell.x, cell.y), false, `land ${land}: sign on open land`);
      const p = isoPoint(sign.x, sign.y);
      assert.equal(landSignAt(s, { x: p.x, y: p.y - 40 }), true);
    }
  }
  s = { ...s, progression: { ...s.progression, land: LAND_MAX } };
  assert.deepEqual(landSigns(s), []);
});

test('strolling animals follow one pure schedule: drawing and taps agree, ready ones stay put', async () => {
  const { animalPlace, animalAt, STROLL, WALK, yardAnimals } =
    await import('../../apps/mobile/src/games/pick-farm/ranch-layout.ts');
  const t0 = 1_770_000_000_000;
  for (const pen of PENS)
    for (let id = 0; id < 6; id++)
      for (let t = t0; t < t0 + 3 * STROLL.period; t += 450) {
        const p = animalPlace(pen, id, id, 'stroll', t);
        const yard = PEN_ART[pen].yard;
        assert.ok(
          p.x >= 0.2 && p.x <= yard.x - 0.2 + 1e-9 && p.y >= 0.2 && p.y <= yard.y - 0.2 + 1e-9,
          `${pen} ${id}`,
        );
        assert.ok(WALK[pen].some((w) => w.x === p.to.x && w.y === p.to.y));
      }
  // Ready and hungry animals stand on their own spot at any time.
  assert.deepEqual(
    {
      x: animalPlace('coop', 3, 1, 'home', t0).x,
      y: animalPlace('coop', 3, 1, 'home', t0 + 5e6).y,
    },
    { x: SPOTS.coop[1].x, y: SPOTS.coop[1].y },
  );
  // A tap on the drawn body finds the animal, wherever it has walked.
  const list = [
    { id: 4, index: 0, mode: 'stroll' },
    { id: 5, index: 1, mode: 'home' },
  ];
  for (const t of [t0, t0 + 1300, t0 + 7000]) {
    const place = animalPlace('coop', 4, 0, 'stroll', t);
    const c = PEN_CORNER.coop;
    const feet = isoPoint(c.x + place.x, c.y + place.y);
    const hit = animalAt({ x: feet.x, y: feet.y - 22 }, 'coop', 'chicken', list, t);
    assert.ok(hit === 4 || hit === 5, `t=${t}`);
  }
  assert.equal(animalAt(penCenter('barn'), 'coop', 'chicken', list, t0), null);
  // Only busy animals stroll, and only with motion on.
  let s = { ...createFarm(0), coins: 5000, xp: 200 };
  const { applyFarmCommand } = await import('../../packages/farm-game/dist/index.js');
  s = applyFarmCommand(s, { type: 'buyPen', pen: 'coop' }, 0);
  s = applyFarmCommand(s, { type: 'buyAnimal', kind: 'chicken' }, 0);
  s = applyFarmCommand(s, { type: 'buyAnimal', kind: 'chicken' }, 0);
  s = { ...s, inventory: { ...s.inventory, carrot: 1 } };
  s = applyFarmCommand(s, { type: 'feedAnimals', kind: 'chicken', animalIds: [1] }, 0);
  assert.deepEqual(
    yardAnimals(s, 'chicken', 1000, true).map((a) => [a.id, a.condition, a.mode]),
    [
      [0, 'hungry', 'home'],
      [1, 'busy', 'stroll'],
    ],
  );
  assert.equal(yardAnimals(s, 'chicken', 1000, false)[1].mode, 'home', 'reduced motion: still');
  assert.equal(yardAnimals(s, 'chicken', 20 * 60000, true)[1].condition, 'ready');
});

test('a land purchase reveals exactly the new ring, sweeping from the front corner', async () => {
  const { revealTiles } = await import('../../apps/mobile/src/games/pick-farm/ranch-layout.ts');
  for (let land = 0; land < LAND_MAX; land++) {
    const tiles = revealTiles(land, land + 1);
    const cells = new Set();
    for (const t of tiles)
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ])
        cells.add(`${t.x + dx},${t.y + dy}`);
    const before = 12 + 4 * land,
      after = before + 4;
    assert.equal(cells.size, after * after - before * before, `land ${land}`);
    const front = tiles.find((t) => t.x + t.y === Math.max(...tiles.map((v) => v.x + v.y)));
    assert.equal(front.delay, Math.min(...tiles.map((t) => t.delay)));
    assert.ok(Math.max(...tiles.map((t) => t.delay)) <= 900);
  }
});
