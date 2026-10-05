import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isoPoint,
  cellAtPoint,
  fitFarm,
  clampCamera,
  MIN_ZOOM,
  MAX_ZOOM,
} from '../../apps/mobile/src/games/pick-farm/geometry.ts';

const normalizeCamera = (camera) => ({ ...camera, x: camera.x || 0, y: camera.y || 0 });
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
test('overview fits field diamond within available phone viewport and prevents panning', () => {
  for (const [width, height] of [
    [320, 568],
    [390, 844],
    [844, 390],
    [1024, 768],
  ]) {
    const fit = fitFarm(width, height);
    assert.ok(3072 * fit <= width - 48 + 1e-9);
    assert.ok(1960 * fit <= height - 144 + 1e-9);
    assert.deepEqual(normalizeCamera(clampCamera(10000, -10000, MIN_ZOOM, fit, width, height)), {
      x: 0,
      y: 0,
      zoom: MIN_ZOOM,
    });
  }
});
test('zoom clamps to overview and maximum; pan remains bounded after zooming in', () => {
  const width = 844,
    height = 390,
    fit = fitFarm(width, height);
  assert.deepEqual(normalizeCamera(clampCamera(123, -321, 0, fit, width, height)), {
    x: 0,
    y: 0,
    zoom: MIN_ZOOM,
  });
  const maxX = Math.max(0, (3072 * fit * MAX_ZOOM - (width - 48)) / 2);
  const maxY = Math.max(0, (1960 * fit * MAX_ZOOM - (height - 144)) / 2);
  assert.deepEqual(clampCamera(1e6, -1e6, 100, fit, width, height), {
    x: maxX,
    y: -maxY,
    zoom: MAX_ZOOM,
  });
  assert.deepEqual(clampCamera(-1e6, 1e6, MAX_ZOOM, fit, width, height), {
    x: -maxX,
    y: maxY,
    zoom: MAX_ZOOM,
  });
  assert.deepEqual(clampCamera(0, 0, 2, fit, width, height), { x: 0, y: 0, zoom: 2 });
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
