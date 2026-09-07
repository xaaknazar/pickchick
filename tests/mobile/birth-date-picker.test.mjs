import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  almatyToday,
  allowedBirthDate,
  initialBirthDate,
} from '../../apps/mobile/src/components/birth-date-picker.ts';

test('birthday upper bound changes at midnight in Almaty, not UTC', () => {
  assert.equal(almatyToday(new Date('2026-09-07T18:59:59.999Z')), '2026-09-07');
  assert.equal(almatyToday(new Date('2026-09-07T19:00:00.000Z')), '2026-09-08');
});

test('birthday input rejects impossible dates and future days, allowing inclusive boundaries', () => {
  const maximum = '2026-09-07';
  for (const value of ['1900-01-01', '2000-02-29', '2024-02-29', maximum]) {
    assert.equal(allowedBirthDate(value, maximum), true, value);
  }
  for (const value of [
    '',
    '1899-12-31',
    '1900-02-29',
    '2001-02-29',
    '2026-04-31',
    '2026-00-10',
    '2026-13-10',
    '2026-01-00',
    '2026-9-7',
    '2026-09-07T00:00:00Z',
    '2026-09-08',
  ]) {
    assert.equal(allowedBirthDate(value, maximum), false, value);
  }
  assert.equal(initialBirthDate('2000-02-29', maximum), '2000-02-29');
  assert.equal(initialBirthDate(null, maximum), '2000-01-01');
  assert.equal(initialBirthDate('2001-02-29', maximum), '2000-01-01');
});

for (const timezone of ['Asia/Almaty', 'Pacific/Honolulu', 'Pacific/Kiritimati']) {
  test(`native date-only roundtrip keeps local noon in ${timezone}`, () => {
    const moduleUrl = new URL(
      '../../apps/mobile/src/components/birth-date-picker.ts',
      import.meta.url,
    );
    const script = `
      import assert from 'node:assert/strict';
      import { almatyToday, birthDateAtLocalNoon, birthDateFromNative } from ${JSON.stringify(moduleUrl.href)};
      for (const value of ['1900-01-01', '2000-02-29', '2024-02-29', '2026-09-07']) {
        const date = birthDateAtLocalNoon(value);
        assert.equal(date.getHours(), 12);
        assert.equal(birthDateFromNative(date), value);
      }
      assert.equal(almatyToday(new Date('2026-09-07T19:00:00Z')), '2026-09-08');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TZ: timezone },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
  });
}
