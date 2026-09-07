import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidBirthDate,
  formatBirthDate,
  normalizeProfileDetails,
  emptyDemoProfile,
} from '../../apps/mobile/src/profile-details.ts';

const now = Date.parse('2026-09-07T12:00:00Z');

test('birth date accepts real Gregorian dates from 1900 through today, including century leap rules', () => {
  for (const value of ['1900-01-01', '1996-02-29', '2000-02-29', '2024-02-29', '2026-09-07'])
    assert.equal(isValidBirthDate(value, now), true, value);
  for (const value of [
    '1899-12-31',
    '1900-02-29',
    '2001-02-29',
    '2100-02-29',
    '2026-04-31',
    '2026-02-30',
    '2026-00-01',
    '2026-13-01',
    '2026-01-00',
    '2026-09-08',
    '2027-01-01',
  ])
    assert.equal(isValidBirthDate(value, now), false, value);
  assert.equal(isValidBirthDate('2100-02-28', Date.parse('2100-03-01T00:00:00Z')), true);
  assert.equal(isValidBirthDate('2100-02-29', Date.parse('2100-03-01T00:00:00Z')), false);
});

test('future date changes exactly at Almaty midnight, independent of host timezone or UTC date', () => {
  assert.equal(isValidBirthDate('2026-09-08', Date.parse('2026-09-07T18:59:59.999Z')), false);
  assert.equal(isValidBirthDate('2026-09-08', Date.parse('2026-09-07T19:00:00.000Z')), true);
  assert.equal(isValidBirthDate('2027-01-01', Date.parse('2026-12-31T18:59:59.999Z')), false);
  assert.equal(isValidBirthDate('2027-01-01', Date.parse('2026-12-31T19:00:00.000Z')), true);
});

test('date validator rejects normalized timestamps, malformed calendar strings and invalid clocks', () => {
  for (const value of [
    '',
    null,
    20000101,
    '2000-1-01',
    '2000-01-1',
    '01.01.2000',
    '2000/01/01',
    '2000-01-01T00:00:00Z',
    ' 2000-01-01',
    '2000-01-01\n',
    '２０００-01-01',
  ])
    assert.equal(isValidBirthDate(value, now), false);
  for (const clock of [NaN, Infinity, -Infinity, 1e30])
    assert.equal(isValidBirthDate('2000-01-01', clock), false);
});

test('Russian date formatting preserves literal date parts without UTC or locale shifts', () => {
  assert.equal(formatBirthDate('2000-02-29'), '29.02.2000');
  assert.equal(formatBirthDate('1900-01-01'), '01.01.1900');
  for (const value of [null, '', '2001-02-29', '2000-02-30', '2000-02-29T00:00:00Z'])
    assert.equal(formatBirthDate(value), '');
});

test('optional profile fields are normalized without requiring birthday or gender', () => {
  assert.deepEqual(
    normalizeProfileDetails({ nickname: '  Чики  ', birthDate: null, gender: null }, now),
    { nickname: 'Чики', birthDate: null, gender: null },
  );
  assert.deepEqual(
    normalizeProfileDetails({ nickname: '  ', birthDate: '2000-02-29', gender: 'female' }, now),
    { nickname: '', birthDate: '2000-02-29', gender: 'female' },
  );
  const empty = emptyDemoProfile();
  empty.nickname = 'Изменено';
  assert.deepEqual(emptyDemoProfile(), {
    nickname: '',
    birthDate: null,
    gender: null,
    completedAt: null,
  });
});

test('nickname limit is 32 Unicode code points after trimming, including non-BMP characters', () => {
  for (const nickname of [
    'я'.repeat(32),
    '🐥'.repeat(32),
    ' '.repeat(10) + '🐥'.repeat(32) + ' '.repeat(10),
  ])
    assert.equal(
      normalizeProfileDetails({ nickname, birthDate: null, gender: null }, now)?.nickname,
      nickname.trim(),
    );
  for (const nickname of ['я'.repeat(33), '🐥'.repeat(33), 'e\u0301'.repeat(17)])
    assert.equal(normalizeProfileDetails({ nickname, birthDate: null, gender: null }, now), null);
});

test('profile boundary rejects missing/unknown fields and unsupported optional values', () => {
  const valid = { nickname: '', birthDate: null, gender: null };
  for (const value of [
    null,
    [],
    {},
    { ...valid, role: 'manager' },
    { ...valid, completedAt: now },
    { ...valid, nickname: 123 },
    { ...valid, birthDate: '' },
    { ...valid, birthDate: '2026-09-08' },
    { ...valid, birthDate: 0 },
    { ...valid, gender: '' },
    { ...valid, gender: 'other' },
  ])
    assert.equal(normalizeProfileDetails(value, now), null);
});
