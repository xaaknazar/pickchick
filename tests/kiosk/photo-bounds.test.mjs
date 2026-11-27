// Visible photo bounds (owner 23.11.2026: «фото комбо стоят разные»): every measured cutout is
// fitted by the dish itself, centred and edge to edge in the photo area.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fitPhoto, publishedPhotoBounds } from '../../apps/kiosk/src/photo-bounds.ts';

const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);

test('a dish with a wide margin is scaled up until it touches the tile', () => {
  // chick-burger-combo: the dish spans y 0.145-0.848 of a square card photo.
  const bounds = publishedPhotoBounds(
    '0b7087d917d4ccb63b85289c61414bc5ce82fcb726ad9e58db0074c0fd3d4c06',
    'card',
  );
  assert.ok(bounds);
  const [ratio, l, t, r, b] = bounds;
  assert.equal(ratio, 1);
  const placed = fitPhoto(bounds, 300, 200);
  const side = placed.height;
  near(placed.width, side, 'square image');
  // The dish fills one side exactly and stays inside the other.
  const dishW = side * (r - l);
  const dishH = side * (b - t);
  assert.ok(dishW <= 300 + 1e-6 && dishH <= 200 + 1e-6);
  assert.ok(Math.abs(dishW - 300) < 1e-6 || Math.abs(dishH - 200) < 1e-6);
  // And its centre is the tile centre.
  near(placed.left + (side * (l + r)) / 2, 150, 'centre x');
  near(placed.top + (side * (t + b)) / 2, 100, 'centre y');
  assert.ok(side > 200, 'bigger than the plain square fit');
});

test('fill leaves a margin around the dish', () => {
  const bounds = [1, 0.25, 0.25, 0.75, 0.75];
  const placed = fitPhoto(bounds, 100, 100, 0.8);
  near(placed.width, 160, 'width');
  near(placed.left, -30, 'left');
  near(placed.top, -30, 'top');
});

test('an unmeasured photo keeps the plain fit', () => {
  assert.equal(publishedPhotoBounds('0'.repeat(64), 'card'), undefined);
  assert.equal(publishedPhotoBounds(undefined, 'hero'), undefined);
});

// The check reads the PNG/WebP files with Pillow; a runner without it skips (like the other
// scripts/kiosk photo checks, which run where the photos are made).
const pillow = spawnSync('python3', ['-c', 'import PIL']).status === 0;
test(
  'the bundled bounds match the bundled photos',
  { skip: pillow ? false : 'Pillow is not installed' },
  () => {
    execFileSync('python3', ['scripts/kiosk/photo-bounds.py', '--check'], { stdio: 'pipe' });
  },
);
