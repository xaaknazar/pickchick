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
