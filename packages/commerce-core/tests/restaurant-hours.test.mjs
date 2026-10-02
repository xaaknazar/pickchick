import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RestaurantHoursSchema,
  restaurantOrderingOpen,
  restaurantHoursFromEnv,
} from '../dist/restaurant-hours.js';
import { customerCheckoutOptions } from '../dist/customer-checkout.js';
const hours = RestaurantHoursSchema.parse({
  openingTime: '10:00',
  closingTime: '00:00',
  timeZone: 'Asia/Almaty',
});
test('confirmed Almaty daily schedule opens at10 inclusive and closes at midnight exclusive', () => {
  for (const [iso, expected] of [
    ['2026-10-01T18:59:59.999Z', true], //23:59 local
    ['2026-10-01T19:00:00.000Z', false], //00:00 next local day
    ['2026-10-02T04:59:59.999Z', false], //09:59 local
    ['2026-10-02T05:00:00.000Z', true], //10:00 local
    ['2026-10-02T18:59:59.999Z', true],
    ['2026-10-02T19:00:00.000Z', false],
  ])
    assert.equal(restaurantOrderingOpen(hours, new Date(iso)), expected, iso);
});
test('cross-midnight schedule and daylight saving use configured timezone rather than server timezone', () => {
  const late = RestaurantHoursSchema.parse({
    ...hours,
    openingTime: '22:00',
    closingTime: '02:00',
  });
  for (const [iso, expected] of [
    ['2026-10-02T16:59:59Z', false],
    ['2026-10-02T17:00:00Z', true],
    ['2026-10-02T19:00:00Z', true],
    ['2026-10-02T20:59:59Z', true],
    ['2026-10-02T21:00:00Z', false],
  ])
    assert.equal(restaurantOrderingOpen(late, new Date(iso)), expected, iso);
  const ny = RestaurantHoursSchema.parse({
    openingTime: '10:00',
    closingTime: '18:00',
    timeZone: 'America/New_York',
  });
  assert.equal(restaurantOrderingOpen(ny, new Date('2026-01-01T14:30:00Z')), false);
  assert.equal(restaurantOrderingOpen(ny, new Date('2026-07-01T14:30:00Z')), true);
});
test('absent schedule preserves current behavior and incomplete/malformed config fails closed', () => {
  assert.equal(restaurantHoursFromEnv({}), undefined);
  assert.equal(restaurantOrderingOpen(undefined, new Date('2026-10-02T19:00:00Z')), true);
  for (const env of [
    { CUSTOMER_KASPI_OPENING_TIME: '10:00' },
    { CUSTOMER_KASPI_OPENING_TIME: '10:00', CUSTOMER_KASPI_CLOSING_TIME: '00:00' },
    {
      CUSTOMER_KASPI_OPENING_TIME: '24:00',
      CUSTOMER_KASPI_CLOSING_TIME: '00:00',
      CUSTOMER_KASPI_TIMEZONE: 'Asia/Almaty',
    },
    {
      CUSTOMER_KASPI_OPENING_TIME: '10:00',
      CUSTOMER_KASPI_CLOSING_TIME: '10:00',
      CUSTOMER_KASPI_TIMEZONE: 'Asia/Almaty',
    },
    {
      CUSTOMER_KASPI_OPENING_TIME: '10:00',
      CUSTOMER_KASPI_CLOSING_TIME: '00:00',
      CUSTOMER_KASPI_TIMEZONE: 'Mars/Restaurant',
    },
    {
      CUSTOMER_KASPI_OPENING_TIME: '',
      CUSTOMER_KASPI_CLOSING_TIME: '00:00',
      CUSTOMER_KASPI_TIMEZONE: 'Asia/Almaty',
    },
  ])
    assert.throws(() => restaurantHoursFromEnv(env), /INVALID/);
  assert.deepEqual(
    restaurantHoursFromEnv({
      CUSTOMER_KASPI_OPENING_TIME: '10:00',
      CUSTOMER_KASPI_CLOSING_TIME: '00:00',
      CUSTOMER_KASPI_TIMEZONE: 'Asia/Almaty',
    }),
    hours,
  );
  assert.throws(() => restaurantOrderingOpen(hours, new Date('bad')), /INVALID/);
  assert.equal(customerCheckoutOptions({}), null);
});
