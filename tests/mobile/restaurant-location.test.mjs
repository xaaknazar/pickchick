import test from 'node:test';
import assert from 'node:assert/strict';
import { restaurantLocation } from '../../apps/mobile/src/restaurant-location.ts';

test('the current branch has the owner-confirmed address; unknown branches never inherit it', () => {
  const location = restaurantLocation('10000000-0000-4000-8000-000000000003');
  assert.equal(location.name, 'ТЦ Abay Plaza');
  assert.equal(location.city, 'Алматы');
  assert.equal(location.address, '4-й микрорайон, 10Б');
  assert.equal(location.map_url, 'https://2gis.kz/almaty/geo/70030076952394244');
  for (const id of [null, undefined, '', '10000000-0000-4000-8000-000000000099']) {
    assert.equal(restaurantLocation(id), undefined);
  }
});
