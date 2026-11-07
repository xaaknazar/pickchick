import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { EventEnvelopeSchema, MoneyMinorSchema, QuoteSchema } from '@pickchick/contracts';
import { hashJson } from '@pickchick/menu-sync';
import { parseEvent, parseKitchenEvent, receiptFor, kitchenReceiptFor } from '../dist/index.js';

// POS-6 (contracts 5.6 end): the two old POS streams carry a paid pos_sale. Synthetic data only;
// the quotes are the posSales wire vectors (fixtures/pos-sale-vectors.json).
const { vectors } = JSON.parse(
  await readFile(new URL('./fixtures/pos-sale-vectors.json', import.meta.url), 'utf8'),
);
const copy = (value) => globalThis.structuredClone(value);
const quoteOf = (name) => copy(vectors[name].event.payload.quote);
const PRODUCER = '10000000-0000-4000-8000-000000000901';
const ORDER = '10000000-0000-4000-8000-000000000902';

/** Frozen copy of the order_commercial payload of D0 (5b212949, model.ts:24-36). */
const FrozenPosOrderEventSchema = EventEnvelopeSchema.extend({
  aggregate_type: z.literal('order_commercial'),
  aggregate_version: z.union([z.literal(1), z.literal(2)]),
  event_type: z.enum(['order.created', 'order.cancelled']),
  payload: z.strictObject({
    order_id: z.uuid(),
    quote_id: z.uuid(),
    state: z.enum(['awaiting_payment', 'cancelled']),
    payment_state: z.literal('not_started'),
    fulfillment_state: z.literal('blocked'),
    execution_mode: z.literal('unpaid_service').optional(),
    total_minor: MoneyMinorSchema,
    currency: z.literal('KZT'),
    channel: z.literal('pos'),
    service_mode: z.enum(['takeaway', 'dine_in']),
    snapshot: QuoteSchema,
  }),
});

/** order_commercial event exactly as orders.ts orderEvent() writes it. */
function orderEvent(quote, { type = 'order.created', mode, state, payment } = {}) {
  const created = type === 'order.created';
  return {
    event_id: created
      ? '10000000-0000-4000-8000-000000000903'
      : '10000000-0000-4000-8000-000000000904',
    producer_id: PRODUCER,
    producer_sequence: created ? '41' : '42',
    aggregate_type: 'order_commercial',
    aggregate_id: ORDER,
    aggregate_version: created ? 1 : 2,
    event_type: type,
    schema_version: 1,
    branch_id: quote.branch_id,
    occurred_at: '2026-11-19T06:02:00.000Z',
    correlation_id: ORDER,
    causation_id: null,
    payload: {
      order_id: ORDER,
      quote_id: quote.quote_id,
      state: state ?? (created ? (mode === 'pos_sale' ? 'paid' : 'awaiting_payment') : 'cancelled'),
      payment_state: payment ?? (mode === 'pos_sale' ? 'captured' : 'not_started'),
      fulfillment_state: 'blocked',
      ...(mode ? { execution_mode: mode } : {}),
      total_minor: quote.total_minor,
      currency: 'KZT',
      channel: 'pos',
      service_mode: quote.service_mode,
      snapshot: quote,
    },
  };
}
const invalid = (event) => assert.throws(() => parseEvent(event), /INVALID_REQUEST/);

test('order_commercial: unpaid and payment_required events parse as before, byte for byte', () => {
  const hall = quoteOf('sale_cash_with_change');
  for (const mode of ['unpaid_service', undefined])
    for (const type of ['order.created', 'order.cancelled']) {
      const event = orderEvent(hall, { type, mode });
      // The frozen D0 schema accepts it, the widened parser returns the same object and receipt.
      assert.deepEqual(FrozenPosOrderEventSchema.parse(event), event);
      const parsed = parseEvent(event);
      assert.deepEqual(parsed, event);
      assert.equal(hashJson(parsed), hashJson(event));
      assert.equal(receiptFor(parsed).payloadHash, hashJson(event));
      assert.equal(Object.hasOwn(parsed.payload, 'execution_mode'), mode !== undefined);
    }
  // What the old stream refused stays refused for an unpaid order.
  invalid(orderEvent(hall, { mode: 'unpaid_service', payment: 'captured' }));
  invalid(orderEvent(hall, { mode: 'unpaid_service', state: 'paid' }));
  invalid(orderEvent(hall, { state: 'paid' }));
  invalid(orderEvent(hall, { payment: 'paid' }));
  invalid(
    orderEvent(hall, { type: 'order.cancelled', mode: 'unpaid_service', payment: 'captured' }),
  );
});

test('order_commercial: a paid pos_sale is created paid/captured (v1) and voided cancelled (v2)', () => {
  for (const name of [
    'sale_cash_with_change',
    'sale_mixed_cash_kaspi_terminal',
    'sale_yandex_eda',
    'sale_glovo',
    'sale_chocofood',
    'sale_kaspi_manual',
    'sale_staff_meal',
    'sale_marketing',
  ]) {
    const quote = quoteOf(name);
    for (const type of ['order.created', 'order.cancelled']) {
      const event = orderEvent(quote, { type, mode: 'pos_sale' });
      // Today's installed cloud would refuse it; the widened parser keeps every byte.
      assert.equal(FrozenPosOrderEventSchema.safeParse(event).success, false, name);
      const parsed = parseEvent(event);
      assert.deepEqual(parsed, event, name);
      assert.equal(receiptFor(parsed).payloadHash, hashJson(event));
    }
  }
  const hall = quoteOf('sale_cash_with_change');
  // A pos_sale is never awaiting payment, never uncaptured, never paid after its void.
  invalid(orderEvent(hall, { mode: 'pos_sale', state: 'awaiting_payment' }));
  invalid(orderEvent(hall, { mode: 'pos_sale', payment: 'not_started' }));
  invalid(orderEvent(hall, { type: 'order.cancelled', mode: 'pos_sale', state: 'paid' }));
  invalid(orderEvent(hall, { type: 'order.cancelled', mode: 'pos_sale', payment: 'not_started' }));
  const paid = orderEvent(hall, { mode: 'pos_sale' });
  invalid({ ...paid, aggregate_version: 2 });
  invalid({ ...paid, payload: { ...paid.payload, execution_mode: 'payment_required' } });
  // An aggregator quote belongs to a paid takeaway sale only.
  const yandex = quoteOf('sale_yandex_eda');
  invalid(orderEvent(yandex, { mode: 'unpaid_service' }));
  invalid(orderEvent(yandex));
  invalid(orderEvent({ ...yandex, service_mode: 'dine_in' }, { mode: 'pos_sale' }));
  invalid(orderEvent({ ...yandex, sales_channel: 'hall' }, { mode: 'pos_sale' }));
});

/** Kitchen observation exactly as records.ts view() + emit() write it. */
function kitchenEvent(mode, { type = 'edge.fulfillment_accepted', version = 1 } = {}) {
  const at = '2026-11-19T06:02:00.000Z';
  return {
    event_id: '10000000-0000-4000-8000-000000000905',
    producer_id: PRODUCER,
    producer_sequence: '7',
    aggregate_type: 'order_fulfillment',
    aggregate_id: ORDER,
    aggregate_version: version,
    event_type: type,
    schema_version: 1,
    branch_id: '10000000-0000-4000-8000-000000000001',
    occurred_at: at,
    correlation_id: ORDER,
    causation_id: null,
    payload: {
      orderId: ORDER,
      branchId: '10000000-0000-4000-8000-000000000001',
      reservationId: '10000000-0000-4000-8000-000000000906',
      quoteId: '10000000-0000-4000-8000-000000000101',
      quoteDigest: 'a'.repeat(64),
      ownerHash: 'b'.repeat(64),
      commercialOwner: 'edge_pos',
      ...(mode === undefined ? {} : { executionMode: mode }),
      fulfillmentOwner: 'edge',
      deviceId: '10000000-0000-4000-8000-000000000907',
      version,
      state: type === 'edge.fulfillment_cancelled' ? 'cancelled' : 'accepted',
      displayNumber: '27',
      createdAt: at,
      updatedAt: at,
      routingVersion: 1,
      assemblyStationId: '10000000-0000-4000-8000-000000000908',
      staffId: '10000000-0000-4000-8000-000000000909',
      ...(type === 'edge.fulfillment_cancelled'
        ? { reason: 'Синтетическая отмена', inventoryEffect: 'none' }
        : {}),
    },
  };
}

test('kitchen stream: unpaid as before, pos_sale accepted and cancelled, nothing else', () => {
  for (const mode of ['unpaid_service', 'pos_sale']) {
    const accepted = kitchenEvent(mode);
    assert.deepEqual(parseKitchenEvent(accepted), accepted);
    assert.equal(kitchenReceiptFor(parseKitchenEvent(accepted)).payloadHash, hashJson(accepted));
    const cancelled = kitchenEvent(mode, { type: 'edge.fulfillment_cancelled', version: 2 });
    assert.deepEqual(parseKitchenEvent(cancelled), cancelled);
  }
  for (const mode of [undefined, 'payment_required', 'cloud_authorized', 'POS_SALE'])
    assert.throws(() => parseKitchenEvent(kitchenEvent(mode)), /INVALID_REQUEST/);
});
