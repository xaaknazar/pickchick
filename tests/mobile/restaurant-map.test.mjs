import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import map from '../../apps/mobile/assets/maps/abay-plaza.json' with { type: 'json' };
import directory from '../../config/restaurant-locations.json' with { type: 'json' };
import { coverPoint, dgisAppUrl, staticMapPoint } from '../../apps/mobile/src/restaurant-map.ts';

const asset = (name) => new URL(`../../apps/mobile/assets/maps/${name}`, import.meta.url);

test('the static map is a small @3x asset with OpenStreetMap attribution', () => {
  assert.equal(map.image, 'abay-plaza.webp');
  assert.ok(existsSync(asset(map.image)));
  assert.ok(statSync(asset(map.image)).size < 150_000, 'keep the bundled map small');
  assert.ok(existsSync(asset('pin-logo-closed.png')));
  assert.equal(map.attribution, '© OpenStreetMap');
  assert.match(map.licence, /ODbL/);
  assert.deepEqual([map.width, map.height], [393, 320]);
});

test('every configured restaurant projects onto the map below the controls', () => {
  for (const location of directory.locations) {
    const point = staticMapPoint(map, location.latitude, location.longitude);
    assert.ok(Math.abs(point.x - map.width / 2) < 1, `${location.branch_id} is centred`);
    assert.ok(Math.abs(point.y - 158) < 1, `${location.branch_id} sits above the sheet`);
  }
});

test('cover fitting keeps the pin on the same map spot for other screen widths', () => {
  const point = { x: 196.5, y: 158 };
  assert.deepEqual(coverPoint(map, point, 393, 320), point);
  // Narrower phones crop the sides; the pin stays centred.
  const narrow = coverPoint(map, point, 375, 320);
  assert.ok(Math.abs(narrow.x - 187.5) < 0.01 && Math.abs(narrow.y - 158) < 0.01);
  // Wider phones scale the image up and crop top and bottom.
  const wide = coverPoint(map, point, 430, 320);
  const scale = 430 / 393;
  assert.ok(Math.abs(wide.x - 215) < 0.01);
  assert.ok(Math.abs(wide.y - ((320 - 320 * scale) / 2 + 158 * scale)) < 0.01);
});

test('2GIS opens in the app through dgis:// with the web page as fallback', () => {
  assert.equal(
    dgisAppUrl('https://2gis.kz/almaty/geo/70030076952394244'),
    'dgis://2gis.ru/geo/70030076952394244',
  );
  assert.equal(dgisAppUrl('https://2gis.ru/geo/1'), 'dgis://2gis.ru/geo/1');
  for (const url of [
    'https://example.com/almaty/geo/70030076952394244',
    'https://2gis.kz/almaty/firm/70000001',
    'http://2gis.kz/almaty/geo/1',
    'https://2gis.kz.evil.example/geo/1',
  ]) {
    assert.equal(dgisAppUrl(url), null, url);
  }
  for (const location of directory.locations) {
    assert.ok(dgisAppUrl(location.map_url), location.branch_id);
  }
});
