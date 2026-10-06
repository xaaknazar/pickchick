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
