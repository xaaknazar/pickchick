import assert from 'node:assert/strict';
import test from 'node:test';
import { MoneyMinorSchema, MenuSnapshotSchema, EventEnvelopeSchema } from '@pickchick/contracts';
import { fixtureMenu, fixtureIds } from '@pickchick/test-fixtures';

test('money is lossless above JavaScript safe integer and bounded by PostgreSQL bigint', () => {
  for (const amount of ['0', '349000', '9007199254740993', '9223372036854775807']) {
    assert.equal(MoneyMinorSchema.parse(amount), amount);
  }
  for (const amount of [349000, -1, '1.5', '-10', '01', '1e4', '9223372036854775808']) {
    assert.equal(MoneyMinorSchema.safeParse(amount).success, false);
  }
});

test('menu rejects missing Kazakh text, foreign currency, unknown fields and future schema', () => {
  assert.deepEqual(MenuSnapshotSchema.parse(fixtureMenu), fixtureMenu);
  for (const change of [
    { schema_version: 2 },
    { staff_secret: 'not-a-real-secret' },
    { items: [{ ...fixtureMenu.items[0], currency: 'USD' }] },
    { items: [{ ...fixtureMenu.items[0], name: { ru: 'test' } }] },
  ]) {
    assert.equal(MenuSnapshotSchema.safeParse({ ...fixtureMenu, ...change }).success, false);
  }
});

test('event envelope preserves independent commercial and fulfillment aggregates', () => {
  const event = {
    event_id: fixtureIds.release,
    producer_id: fixtureIds.device,
    producer_sequence: '1',
    aggregate_type: 'order_fulfillment',
    aggregate_id: fixtureIds.product,
    aggregate_version: 1,
    event_type: 'order.handed_over',
    schema_version: 1,
    branch_id: fixtureIds.branch,
    occurred_at: fixtureMenu.published_at,
    correlation_id: fixtureIds.release,
    causation_id: null,
    payload: {},
  };
  assert.equal(EventEnvelopeSchema.parse(event).aggregate_type, 'order_fulfillment');
  assert.equal(EventEnvelopeSchema.safeParse({ ...event, producer_sequence: 1 }).success, false);
  assert.equal(EventEnvelopeSchema.safeParse({ ...event, schema_version: 2 }).success, false);
});
