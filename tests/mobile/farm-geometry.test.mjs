import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isoPoint,
  cellAtPoint,
  fitFarm,
  clampCamera,
  frameWorldRect,
  screenAtWorld,
  MEADOW,
  WORLD_OFFSET_Y,
  MIN_ZOOM,
  MAX_ZOOM,
} from '../../apps/mobile/src/games/pick-farm/geometry.ts';
test('isometric projection roundtrips every historical cell and new32x32 field edge', () => {
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const point = isoPoint(x, y);
      assert.deepEqual(cellAtPoint(point.x, point.y), { x, y });
    }
  for (const [x, y] of [
    [16, 16],
    [47, 16],
    [16, 47],
    [47, 47],
    [14, 14],
  ]) {
    const point = isoPoint(x, y);
    assert.deepEqual(cellAtPoint(point.x + 10, point.y + 3), { x, y });
  }
});
test('overview shows the whole field and house, and the meadow always covers the screen', () => {
  for (const [width, height] of [
    [320, 568],
    [390, 844],
    [667, 375],
    [844, 390],
    [932, 430],
    [1024, 768],
  ]) {
    const fit = fitFarm(width, height);
    // Field diamond plus the house above it fit in landscape phones and tablets.
    if (width > height) {
      assert.ok(3072 * fit <= width, `${width}x${height} field width`);
      assert.ok(1840 * fit <= height, `${width}x${height} field height`);
    }
    for (const zoom of [MIN_ZOOM, 2, MAX_ZOOM])
      for (const [x, y] of [
        [1e6, 1e6],
        [-1e6, -1e6],
        [0, 0],
      ]) {
        const camera = clampCamera(x, y, zoom, fit, width, height);
        const s = fit * camera.zoom;
        const left = width / 2 + camera.x - (MEADOW.width / 2) * s;
        const right = width / 2 + camera.x + (MEADOW.width / 2) * s;
        const top = height / 2 + WORLD_OFFSET_Y + camera.y - (MEADOW.height / 2) * s;
        const bottom = height / 2 + WORLD_OFFSET_Y + camera.y + (MEADOW.height / 2) * s;
        const label = JSON.stringify({ width, height, zoom, x, y });
        assert.ok(left <= 1e-6 && right >= width - 1e-6, label);
        assert.ok(top <= 1e-6 && bottom >= height - 1e-6, label);
      }
  }
});
test('zoom clamps between the overview and the close view; the garden frame stays inside', () => {
  const width = 844,
    height = 390,
    fit = fitFarm(width, height);
  assert.equal(clampCamera(0, 0, 0, fit, width, height).zoom, MIN_ZOOM);
  assert.equal(clampCamera(0, 0, 100, fit, width, height).zoom, MAX_ZOOM);
  const a = isoPoint(29, 29),
    b = isoPoint(33, 31);
  const rect = { minX: a.x - 200, maxX: b.x + 200, minY: a.y - 100, maxY: b.y + 40 };
  const camera = frameWorldRect(rect, fit, width, height);
  assert.ok(camera.zoom > MIN_ZOOM && camera.zoom <= 3.2, String(camera.zoom));
  const centre = screenAtWorld(
    { x: (rect.minX + rect.maxX) / 2, y: (rect.minY + rect.maxY) / 2 },
    camera,
    fit,
    width,
    height,
  );
  assert.ok(Math.abs(centre.x - width / 2) < 1, String(centre.x));
  assert.ok(Math.abs(centre.y - (height / 2 + 16)) < 1, String(centre.y));
  // A garden at the very edge is framed without revealing the meadow border.
  const corner = isoPoint(47, 47);
  const edge = frameWorldRect(
    { minX: corner.x - 50, maxX: corner.x + 50, minY: corner.y - 90, maxY: corner.y + 30 },
    fit,
    width,
    height,
  );
  assert.deepEqual(edge, clampCamera(edge.x, edge.y, edge.zoom, fit, width, height));
});
test('screen hit inverse agrees with pan and scaling used by world rendering', () => {
  const width = 844,
    height = 390,
    fit = fitFarm(width, height);
  for (const zoom of [1, 2, 8])
    for (const [x, y] of [
      [16, 16],
      [47, 47],
      [0, 63],
    ]) {
      const camera = clampCamera(42, -21, zoom, fit, width, height),
        world = isoPoint(x, y),
        scale = camera.zoom * fit;
      const page = {
        x: width / 2 + camera.x + (world.x - 450) * scale,
        y: height / 2 + 48 + camera.y + (world.y - 300) * scale,
      };
      assert.deepEqual(
        cellAtPoint(
          (page.x - width / 2 - camera.x) / scale + 450,
          (page.y - height / 2 - 48 - camera.y) / scale + 300,
        ),
        { x, y },
      );
    }
});

test('touches in an offset sheet map to the same cell at every zoom and pan', async () => {
  const { worldAtPagePoint } = await import('../../apps/mobile/src/games/pick-farm/geometry.ts');
  for (const frame of [
    { x: 44, y: 72, width: 756, height: 318 },
    { x: 0, y: 110, width: 390, height: 734 },
  ]) {
    const fit = fitFarm(frame.width, frame.height);
    for (const zoom of [1, 3, 8]) {
      const camera = { x: 38, y: -25, zoom };
      for (const [x, y] of [
        [16, 16],
        [31, 32],
        [47, 47],
      ]) {
        const world = isoPoint(x, y);
        const page = {
          x: frame.x + frame.width / 2 + camera.x + (world.x - 450) * fit * zoom,
          y: frame.y + frame.height / 2 + 48 + camera.y + (world.y - 300) * fit * zoom,
        };
        const hit = worldAtPagePoint(page, frame, camera, fit);
        assert.deepEqual(cellAtPoint(hit.x, hit.y), { x, y });
      }
    }
  }
});

test('every field edge rejects the outside half of its boundary cell', () => {
  for (let i = 16; i <= 47; i++) {
    for (const [x, y, inside] of [
      [15.5001, i, true],
      [15.4999, i, false],
      [47.4999, i, true],
      [47.5001, i, false],
      [i, 15.5001, true],
      [i, 15.4999, false],
      [i, 47.4999, true],
      [i, 47.5001, false],
    ]) {
      const p = isoPoint(x, y),
        cell = cellAtPoint(p.x, p.y);
      const inField = cell.x >= 16 && cell.x <= 47 && cell.y >= 16 && cell.y <= 47;
      assert.equal(inField, inside, JSON.stringify({ x, y, cell }));
    }
  }
});

test('visible crop above its ground diamond selects that crop, not the cell behind', async () => {
  const { plotAtPoint } = await import('../../apps/mobile/src/games/pick-farm/hit-zones.ts');
  const now = 1_800_000_000_000;
  const plot = {
    id: 1,
    x: 31,
    y: 31,
    kind: 'bed',
    cropId: 'sunflower',
    plantedAt: now - 4 * 3600 * 1000,
    harvests: 0,
  };
  const center = isoPoint(31, 31);
  const hit = { x: center.x - 8, y: center.y - 57 };
  assert.notDeepEqual(cellAtPoint(hit.x, hit.y), { x: 31, y: 31 });
  assert.equal(plotAtPoint([plot], hit, now)?.id, 1);
  // Transparent top-left corner of the image must not create an invisible rectangular target.
  assert.equal(plotAtPoint([plot], { x: center.x - 32, y: center.y - 70 }, now), undefined);
});

test('frontmost opaque plant wins overlaps while transparent pixels pass through', async () => {
  const { plotAtPoint } = await import('../../apps/mobile/src/games/pick-farm/hit-zones.ts');
  const now = 1_800_000_000_000;
  const back = {
    id: 1,
    x: 31,
    y: 31,
    kind: 'bed',
    cropId: 'sunflower',
    plantedAt: now - 4 * 3600 * 1000,
    harvests: 0,
  };
  const front = { ...back, id: 2, x: 32 };
  let overlap = 0,
    passThrough = 0;
  const center = isoPoint(31, 31);
  for (let y = -75; y <= 25; y += 2)
    for (let x = -40; x <= 90; x += 2) {
      const point = { x: center.x + x, y: center.y + y };
      const a = plotAtPoint([back], point, now),
        b = plotAtPoint([front], point, now);
      const hit = plotAtPoint([front, back], point, now);
      if (a && b) {
        assert.equal(hit?.id, 2);
        overlap++;
      }
      if (a && !b) {
        assert.equal(hit?.id, 1);
        passThrough++;
      }
    }
  assert.ok(overlap > 0);
  assert.ok(passThrough > 0);
});

test('grabbing foliage preserves the ground offset while moving one cell', () => {
  const ground = isoPoint(31, 31),
    grab = { x: ground.x - 16, y: ground.y - 57 };
  const offset = { x: ground.x - grab.x, y: ground.y - grab.y };
  const released = { x: grab.x + 48, y: grab.y + 24 };
  assert.deepEqual(cellAtPoint(released.x + offset.x, released.y + offset.y), { x: 32, y: 31 });
});

test('hit masks belong to the current rendered sprite atlases', async () => {
  const { readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const masks = await readFile(
    new URL('../../apps/mobile/src/games/pick-farm/sprite-hit-masks.ts', import.meta.url),
    'utf8',
  );
  for (const name of ['props-painted-v2.png', 'plants-painted-v2.png']) {
    const bytes = await readFile(
      new URL(`../../apps/mobile/assets/games/pick-farm/${name}`, import.meta.url),
    );
    assert.ok(
      masks.includes(`${name}: ${createHash('sha256').update(bytes).digest('hex')}`),
      `Regenerate hit masks for ${name}`,
    );
  }
});

test('soil corners share the placement diamond and reject adjacent ground', async () => {
  const { groundContains } = await import('../../apps/mobile/src/games/pick-farm/geometry.ts');
  const center = isoPoint(31, 32);
  const plot = { id: 7, x: 31, y: 32, kind: 'bed', cropId: null, plantedAt: null, harvests: 0 };
  const { plotAtPoint } = await import('../../apps/mobile/src/games/pick-farm/hit-zones.ts');
  for (const [x, y] of [
    [0, -24],
    [48, 0],
    [0, 24],
    [-48, 0],
  ]) {
    assert.equal(Math.abs(x) / 48 + Math.abs(y) / 24, 1);
    assert.ok(groundContains(x * 0.999, y * 0.999));
    assert.equal(groundContains(x * 1.001, y * 1.001), false);
    assert.equal(
      plotAtPoint([plot], { x: center.x + x * 0.999, y: center.y + y * 0.999 }, 0)?.id,
      7,
    );
    assert.equal(
      plotAtPoint([plot], { x: center.x + x * 1.001, y: center.y + y * 1.001 }, 0),
      undefined,
    );
  }
});

test('pinch preserves held point and culling retains edge sprites', async () => {
  const { cameraAroundPoint, worldPointVisible } =
    await import('../../apps/mobile/src/games/pick-farm/geometry.ts');
  const old = { x: 20, y: -30, zoom: 2 },
    point = { x: 90, y: 50 };
  const next = cameraAroundPoint(old, point, 4);
  assert.equal((point.x - old.x) / old.zoom, (point.x - next.x) / next.zoom);
  assert.equal((point.y - old.y) / old.zoom, (point.y - next.y) / next.zoom);
  assert.equal(worldPointVisible({ x: 450, y: 300 }, old, 0.125, 844, 390), true);
  assert.equal(worldPointVisible({ x: 9000, y: 9000 }, old, 0.125, 844, 390), false);
});

test('tutorial carrots use their own timing for the drawn stage and its touch zone', async () => {
  const { plotAtPoint } = await import('../../apps/mobile/src/games/pick-farm/hit-zones.ts');
  const now = 1_800_000_000_000;
  const plot = {
    id: 3,
    x: 31,
    y: 31,
    kind: 'bed',
    cropId: 'carrot',
    plantedAt: now - 30000,
    harvests: 0,
    timing: { growSeconds: 45, harvestWindowSeconds: 129600, rewardXp: 5 },
  };
  const center = isoPoint(31, 31);
  // Soil and seeds end 24 world px above the bed centre; the drawn carrot leaves reach higher.
  const tallHits = (at) => {
    let hits = 0;
    for (let y = -45; y < -25; y += 1)
      for (let x = -30; x <= 30; x += 1)
        if (plotAtPoint([plot], { x: center.x + x, y: center.y + y }, at)?.id === 3) hits++;
    return hits;
  };
  // 20 s of 45: drawn as a full plant (44%); base carrot time (300 s) would mean seeds.
  assert.ok(tallHits(now - 10000) > 0, 'the drawn full plant must be the touch target');
  // At 3 s the same planting is still seeds: only its soil responds.
  assert.equal(tallHits(now - 27000), 0);
});

test('status badges and a fingertip margin select the object under them', async () => {
  const { plotAtPoint, BADGE_OFFSET } =
    await import('../../apps/mobile/src/games/pick-farm/hit-zones.ts');
  const now = 1_800_000_000_000;
  const ready = {
    id: 4,
    x: 30,
    y: 30,
    kind: 'bed',
    cropId: 'strawberry',
    plantedAt: now - 2 * 3600 * 1000,
    harvests: 0,
  };
  const center = isoPoint(30, 30);
  const badge = { x: center.x + 10, y: center.y + BADGE_OFFSET.bed - 10 };
  assert.equal(plotAtPoint([ready], badge, now), undefined);
  assert.equal(plotAtPoint([ready], badge, now, { badgeRadius: 16 })?.id, 4);
  // Just outside the soil diamond: only a fingertip margin selects the bed.
  const empty = { ...ready, id: 5, x: 34, cropId: null, plantedAt: null };
  const edge = isoPoint(34, 30);
  const outside = { x: edge.x + 52, y: edge.y };
  assert.equal(plotAtPoint([empty], outside, now), undefined);
  assert.equal(plotAtPoint([empty], outside, now, { slop: 12 })?.id, 5);
  assert.equal(plotAtPoint([empty], { x: edge.x + 90, y: edge.y }, now, { slop: 12 }), undefined);
});

test('the repeated grass plane covers every ground rectangle the camera can show', async () => {
  const { GRASS_CELLS } = await import('../../apps/mobile/src/games/pick-farm/geometry.ts');
  assert.equal(GRASS_CELLS % 8, 0, 'grass is drawn in 8x8 cell blocks');
  // Grass diamond: |dx| / (cells * 48) + |dy| / (cells * 24) <= 1 around cell (31.5, 31.5).
  const centre = isoPoint(31.5, 31.5);
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      const dx = (sx * MEADOW.width) / 2 + 450 - centre.x;
      const dy = (sy * MEADOW.height) / 2 + 300 - centre.y;
      assert.ok(Math.abs(dx) / (GRASS_CELLS * 48) + Math.abs(dy) / (GRASS_CELLS * 24) < 0.95);
    }
  // Grass squares share the cell grid: cell edges fall on whole squares of the plane.
  const firstCell = 31.5 - GRASS_CELLS / 2;
  assert.equal(firstCell + 0.5, Math.round(firstCell + 0.5));
});

test('the larger apple tree is selectable across its whole drawn canopy', async () => {
  const { plotAtPoint } = await import('../../apps/mobile/src/games/pick-farm/hit-zones.ts');
  const { TREE_ART, TREE_TOP } = await import('../../apps/mobile/src/games/pick-farm/geometry.ts');
  const now = 1_800_000_000_000;
  const tree = {
    id: 7,
    x: 30,
    y: 30,
    kind: 'tree',
    cropId: 'apple',
    plantedAt: now - 1000,
    harvests: 0,
  };
  const c = isoPoint(30, 30);
  let top = 0;
  for (let y = TREE_TOP; y < 0; y++)
    for (let x = -TREE_ART / 2; x <= TREE_ART / 2; x += 2)
      if (plotAtPoint([tree], { x: c.x + x, y: c.y + y }, now)?.id === 7) {
        top = Math.min(top, y);
      }
  // The old 112 px tree reached about 70 px above its cell; the new art reaches higher.
  assert.ok(top < -95, String(top));
  assert.ok(TREE_ART > 112);
});

test('framing keeps the object below the HUD rows', () => {
  const fit = fitFarm(844, 390);
  const rect = { minX: 600, maxX: 900, minY: -500, maxY: -300 };
  for (const hudTop of [32, 74, 120]) {
    const cam = frameWorldRect(rect, fit, 844, 390, 0.62, 3.2, hudTop);
    const top = screenAtWorld({ x: 750, y: rect.minY }, cam, fit, 844, 390);
    const bottom = screenAtWorld({ x: 750, y: rect.maxY }, cam, fit, 844, 390);
    assert.ok(top.y >= hudTop - 1, `hud ${hudTop}: top ${top.y}`);
    assert.ok(bottom.y <= 390 + 1);
    assert.ok(Math.abs((top.y + bottom.y) / 2 - (hudTop + (390 - hudTop) / 2)) < 2);
  }
});
