import test from 'node:test';
import assert from 'node:assert/strict';
import { stockEffect, periodStart, parse, Request, Schemas } from '../dist/model.js';
test('warehouse valuation uses integer proportional cost and removes the final remainder', () => {
  assert.deepEqual(
    stockEffect(
      'waste',
      { quantity: '3', value_minor: '100' },
      { quantity: '1', value_minor: '999' },
    ),
    { quantity_delta: '-1', value_delta_minor: '-33', quantity: '2', value_minor: '67' },
  );
  assert.equal(
    stockEffect('waste', { quantity: '2', value_minor: '67' }, { quantity: '2', value_minor: '0' })
      .value_minor,
    '0',
  );
  assert.throws(
    () =>
      stockEffect(
        'waste',
        { quantity: '1', value_minor: '5' },
        { quantity: '2', value_minor: '0' },
      ),
    /INSUFFICIENT_STOCK/,
  );
  assert.equal(
    stockEffect(
      'receipt',
      { quantity: '0', value_minor: '0' },
      { quantity: '999999999999999', value_minor: '999999999999999' },
    ).quantity,
    '999999999999999',
  );
  assert.throws(
    () =>
      stockEffect(
        'receipt',
        { quantity: '1', value_minor: '0' },
        { quantity: '999999999999999', value_minor: '0' },
      ),
    /INVALID_REQUEST/,
  );
});
test('count computes differences against current quantity, not a replacement movement', () => {
  assert.equal(
    stockEffect(
      'count',
      { quantity: '10', value_minor: '200' },
      { quantity: '12', value_minor: '9999' },
    ).value_delta_minor,
    '40',
  );
  assert.equal(
    stockEffect(
      'count',
      { quantity: '10', value_minor: '200' },
      { quantity: '8', value_minor: '9999' },
    ).value_delta_minor,
    '-40',
  );
});
test('periods follow Almaty calendar boundaries', () => {
  assert.equal(
    periodStart('day', new Date('2026-09-08T20:01:00Z')).toISOString(),
    '2026-09-08T19:00:00.000Z',
  );
  assert.equal(
    periodStart('week', new Date('2026-09-08T10:00:00Z')).toISOString(),
    '2026-09-06T19:00:00.000Z',
  );
  assert.equal(
    periodStart('quarter', new Date('2026-09-08T10:00:00Z')).toISOString(),
    '2026-06-30T19:00:00.000Z',
  );
});
test('command boundary forbids duplicated stock lines and unvalidated remote game rewards', () => {
  assert.throws(
    () => parse(Request, { request_id: 'bad', reason: 'test', command: { type: 'save' } }),
    /INVALID_REQUEST/,
  );
  assert.throws(
    () =>
      parse(Schemas.game, {
        name: 'test',
        template: 'pick-blocks',
        enabled: true,
        daily_attempts: 5,
        reward_chiki: '1',
        schedule: { starts_at: '2026-09-01T00:00:00Z', ends_at: '2026-10-01T00:00:00Z' },
      }),
    /INVALID_REQUEST/,
  );
});
