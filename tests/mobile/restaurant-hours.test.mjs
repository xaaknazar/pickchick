import test from 'node:test';
import assert from 'node:assert/strict';
import {
  almatyMinuteOfDay,
  clockMinutes,
  hoursStatusAtMinute,
  hoursStatusText,
  restaurantCountLabel,
  restaurantHoursStatus,
} from '../../apps/mobile/src/restaurant-hours.ts';

const at = (clock) => clockMinutes(clock);

test('clock values are strict HH:MM; 00:00 is midnight', () => {
  assert.equal(clockMinutes('00:00'), 0);
  assert.equal(clockMinutes('10:00'), 600);
  assert.equal(clockMinutes('23:59'), 1439);
  for (const value of ['24:00', '9:00', '10:60', '', null, undefined, '10:00 ']) {
    assert.equal(clockMinutes(value), null);
  }
});

test('a 00:00 closing time means open until midnight', () => {
  assert.deepEqual(hoursStatusAtMinute('10:00', '00:00', at('09:59')), {
    open: false,
    opensAt: '10:00',
    opensTomorrow: false,
  });
  assert.deepEqual(hoursStatusAtMinute('10:00', '00:00', at('10:00')), {
    open: true,
    closesAt: '00:00',
  });
  assert.deepEqual(hoursStatusAtMinute('10:00', '00:00', at('23:59')), {
    open: true,
    closesAt: '00:00',
  });
  assert.equal(hoursStatusAtMinute('10:00', '00:00', at('00:00')).open, false);
  assert.equal(hoursStatusAtMinute('10:00', '00:00', at('03:00')).opensTomorrow, false);
});

test('a closing time after midnight keeps the restaurant open overnight', () => {
  assert.equal(hoursStatusAtMinute('10:00', '02:00', at('23:30')).open, true);
  assert.deepEqual(hoursStatusAtMinute('10:00', '02:00', at('01:59')), {
    open: true,
    closesAt: '02:00',
  });
  assert.deepEqual(hoursStatusAtMinute('10:00', '02:00', at('02:00')), {
    open: false,
    opensAt: '10:00',
    opensTomorrow: false,
  });
});

test('same-day hours open again tomorrow after closing', () => {
  assert.equal(hoursStatusAtMinute('09:00', '21:00', at('08:00')).opensTomorrow, false);
  assert.equal(hoursStatusAtMinute('09:00', '21:00', at('12:00')).open, true);
  assert.deepEqual(hoursStatusAtMinute('09:00', '21:00', at('21:00')), {
    open: false,
    opensAt: '09:00',
    opensTomorrow: true,
  });
});

test('equal opening and closing times mean open around the clock', () => {
  assert.deepEqual(hoursStatusAtMinute('00:00', '00:00', at('04:00')), {
    open: true,
    closesAt: null,
  });
  assert.deepEqual(hoursStatusText({ open: true, closesAt: null }), {
    state: 'Открыто',
    detail: 'круглосуточно',
  });
});

test('invalid hours or minutes produce no status instead of a guess', () => {
  assert.equal(hoursStatusAtMinute('10:00', '24:00', 700), null);
  assert.equal(hoursStatusAtMinute('10:00', '00:00', 1440), null);
  assert.equal(hoursStatusAtMinute('10:00', '00:00', Number.NaN), null);
  assert.equal(restaurantHoursStatus(undefined, new Date()), null);
  assert.equal(restaurantHoursStatus({ opening_time: '10:00' }, new Date()), null);
});

test('the status uses Almaty time whatever the device time zone', () => {
  // Kazakhstan is UTC+5 since 2024 (UTC+6 with older tz data): both cases agree here.
  const noon = new Date('2026-10-12T07:00:00Z');
  const night = new Date('2026-10-11T22:00:00Z');
  assert.ok([12 * 60, 13 * 60].includes(almatyMinuteOfDay(noon)));
  assert.ok([3 * 60, 4 * 60].includes(almatyMinuteOfDay(night)));
  const hours = { opening_time: '10:00', closing_time: '00:00' };
  assert.deepEqual(restaurantHoursStatus(hours, noon), { open: true, closesAt: '00:00' });
  assert.deepEqual(restaurantHoursStatus(hours, night), {
    open: false,
    opensAt: '10:00',
    opensTomorrow: false,
  });
  // Midnight is minute 0, never 24:00 (1440).
  const midnight = new Date(noon.getTime() - almatyMinuteOfDay(noon) * 60_000);
  assert.equal(almatyMinuteOfDay(midnight), 0);
  assert.equal(restaurantHoursStatus(hours, midnight).open, false);
});

test('status texts use the owner-approved wording', () => {
  assert.deepEqual(hoursStatusText({ open: true, closesAt: '00:00' }), {
    state: 'Открыто',
    detail: 'до 00:00',
  });
  assert.deepEqual(hoursStatusText({ open: false, opensAt: '10:00', opensTomorrow: false }), {
    state: 'Закрыто',
    detail: 'откроется в 10:00',
  });
  assert.deepEqual(hoursStatusText({ open: false, opensAt: '09:00', opensTomorrow: true }), {
    state: 'Закрыто',
    detail: 'откроется завтра в 09:00',
  });
});

test('restaurant counts are pluralised in Russian', () => {
  const cases = {
    1: '1 ресторан',
    2: '2 ресторана',
    4: '4 ресторана',
    5: '5 ресторанов',
    11: '11 ресторанов',
    12: '12 ресторанов',
    14: '14 ресторанов',
    21: '21 ресторан',
    22: '22 ресторана',
    25: '25 ресторанов',
    101: '101 ресторан',
    111: '111 ресторанов',
  };
  for (const [count, label] of Object.entries(cases)) {
    assert.equal(restaurantCountLabel(Number(count)), label);
  }
});
