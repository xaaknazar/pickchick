import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { hashJson } from '@pickchick/menu-sync';
import {
  MAX_POS_SALE_BATCH,
  MAX_POS_SALE_BATCH_BYTES,
  POS_SALES_SYNC_PATH,
  PosSaleBatchResultSchema,
  parsePosSaleBatch,
  parsePosSaleEvent,
  posSaleEventViolation,
  posSalePayloadHash,
  posSaleReceiptFor,
  PosSaleEventSchema,
} from '../dist/index.js';

// Synthetic vectors shared with the cloud receiver (contracts 5.6); payload_hash is pinned so a
// change of canonical JSON or of the payload shapes is visible on both sides.
const { vectors } = JSON.parse(
  await readFile(new URL('./fixtures/pos-sale-vectors.json', import.meta.url), 'utf8'),
);
const copy = (value) => globalThis.structuredClone(value);
const mutate = (name, change) => {
  const event = copy(vectors[name].event);
  change(event.payload, event);
  return event;
};

test('every wire vector parses, keeps its bytes and pins its payload hash and receipt', () => {
  assert.equal(POS_SALES_SYNC_PATH, '/internal/v1/edge/pos-orders/sales');
  assert.equal(Object.keys(vectors).length, 14);
  for (const [name, { event, payload_hash }] of Object.entries(vectors)) {
    const parsed = parsePosSaleEvent(event);
    assert.deepEqual(parsed, event, name);
    assert.equal(hashJson(event.payload), payload_hash, name);
    assert.equal(posSalePayloadHash(parsed), payload_hash, name);
    assert.deepEqual(posSaleReceiptFor(parsed), {
      event_id: event.event_id,
      sequence: event.sequence,
      payload_hash,
      acknowledged: true,
    });
  }
  // All eight methods of contracts section 00 appear in the vectors.
  const methods = new Set(
    Object.values(vectors)
      .filter(({ event }) => event.kind === 'sale')
      .flatMap(({ event }) => event.payload.tenders.map((tender) => tender.method)),
  );
  assert.deepEqual([...methods].sort(), [
    'aggregator_glovo',
    'aggregator_yandex_eda',
    'cash',
    'chocofood',
    'kaspi_manual',
    'kaspi_terminal',
    'marketing',
    'staff_meal',
  ]);
});

test('sale invariants of contracts 2.2 and section 00 reject each broken rule', () => {
  const cases = [
    ['sale_cash_with_change', (p) => (p.tenders[0].amount_minor = '340000'), 'tender_sum'],
    ['sale_cash_with_change', (p) => (p.change_minor = '140000'), 'cash'],
    [
      'sale_cash_with_change',
      (p) => {
        p.cash_tendered_minor = '300000';
        p.change_minor = '0';
      },
      'cash',
    ],
    ['sale_cash_with_change', (p) => (p.cash_tendered_minor = p.change_minor = null), 'cash'],
    [
      'sale_cash_with_change',
      (p) => (p.tenders[0].confirmation = 'cashier_attested'),
      'tender_method',
    ],
    [
      'sale_mixed_cash_kaspi_terminal',
      (p) => {
        p.tenders[0].amount_minor = '20050';
        p.tenders[1].amount_minor = '399950';
      },
      'tender_method',
    ],
    [
      'sale_mixed_cash_kaspi_terminal',
      (p) => {
        p.tenders[1].method = 'cash';
        p.tenders[1].confirmation = 'drawer';
      },
      'mix',
    ],
    [
      'sale_mixed_cash_kaspi_terminal',
      (p) => {
        p.tenders[1].method = 'chocofood';
        p.tenders[1].confirmation = 'aggregator_attested';
        p.external_order_ref = 'CF-SYN-9';
      },
      'mix',
    ],
    ['sale_yandex_eda', (p) => (p.external_order_ref = null), 'external_order_ref'],
    [
      'sale_yandex_eda',
      (p) => {
        p.service_mode = 'dine_in';
        p.quote.service_mode = 'dine_in';
      },
      'external_order_ref',
    ],
    ['sale_yandex_eda', (p) => (p.sales_channel = 'glovo'), 'quote'],
    [
      'sale_yandex_eda',
      (p) => {
        p.sales_channel = 'glovo';
        p.quote.sales_channel = 'glovo';
      },
      'tender_method',
    ],
    ['sale_chocofood', (p) => (p.external_order_ref = null), 'external_order_ref'],
    ['sale_kaspi_manual', (p) => (p.external_order_ref = 'SYN-REF'), 'external_order_ref'],
    ['sale_staff_meal', (p) => (p.approval = null), 'revenue_kind'],
    ['sale_staff_meal', (p) => (p.approval.action = 'marketing'), 'revenue_kind'],
    ['sale_staff_meal', (p) => (p.beneficiary = null), 'revenue_kind'],
    ['sale_marketing', (p) => (p.reason = null), 'revenue_kind'],
    ['sale_marketing', (p) => (p.revenue_kind = 'revenue'), 'revenue_kind'],
    ['sale_cash_with_change', (p, e) => (e.branch_id = p.order_id), 'quote'],
    ['sale_cash_with_change', (p) => (p.quote.total_minor = '350001'), 'quote'],
    ['sale_cash_with_change', (p) => (p.quote.lines[0].quantity = 2), 'quote'],
  ];
  for (const [name, change, expected] of cases) {
    const event = mutate(name, change);
    const parsed = PosSaleEventSchema.parse(event);
    assert.equal(posSaleEventViolation(parsed), expected, `${name}: ${change}`);
    assert.throws(() => parsePosSaleEvent(event), { code: 'INVALID_REQUEST' });
  }
});

test('refund, fiscal and Z report invariants; schema rejects unknown keys and bad money', () => {
  const cases = [
    ['void_cash_sale', (p) => (p.kind = 'refund'), 'kind'],
    ['refund_terminal_part', (p) => (p.amount_minor = '100001'), 'tender_sum'],
    [
      'refund_terminal_part',
      (p) => p.tenders.push({ ...p.tenders[0], amount_minor: '1' }),
      'tender_sum',
    ],
    ['fiscal_sale_recorded', (p) => (p.receipt_number = null), 'receipt'],
    ['fiscal_sale_pending', (p) => (p.recorded_at = '2026-11-19T07:00:00.000Z'), 'receipt'],
    ['fiscal_refund_pending', (p) => (p.refund_id = null), 'receipt'],
    ['shift_report_z', (p) => (p.report.expected_cash_minor = '820001'), 'cash'],
    ['shift_report_z', (p) => (p.report.discrepancy_minor = '5000'), 'cash'],
    ['shift_report_z', (p) => (p.report.methods[0].sales_minor = '1'), 'cash'],
    ['shift_report_z', (p) => (p.report.terminal_discrepancy_minor = '1'), 'terminal'],
    ['shift_report_z', (p) => (p.report.terminal_discrepancy_minor = null), 'terminal'],
    ['shift_report_z', (p) => (p.report.kind = 'x'), 'identity'],
    ['shift_report_z', (p) => (p.report.shift_id = p.terminal_id), 'identity'],
  ];
  for (const [name, change, expected] of cases) {
    const event = mutate(name, change);
    assert.equal(posSaleEventViolation(PosSaleEventSchema.parse(event)), expected, name);
    assert.throws(() => parsePosSaleEvent(event), { code: 'INVALID_REQUEST' });
  }
  for (const change of [
    (p, e) => (e.extra = true),
    (p) => (p.extra = true),
    (p) => (p.tenders[0].amount_minor = '0'),
    (p) => (p.tenders[0].amount_minor = '01'),
    (p) => (p.total_minor = '9223372036854775808'),
    (p) => (p.tenders[0].method = 'kaspi_ailillu'),
    (p) => (p.external_order_ref = 'cf-lower'),
    (p, e) => (e.sequence = '0'),
    (p) => (p.quote.discount_minor = '100'),
  ])
    assert.throws(() => parsePosSaleEvent(mutate('sale_cash_with_change', change)), {
      code: 'INVALID_REQUEST',
    });
  // A trimmed value would change the canonical bytes: refused rather than silently rewritten.
  assert.throws(
    () =>
      parsePosSaleEvent(
        mutate('sale_staff_meal', (p) => (p.beneficiary = ' Синтетический сотрудник')),
      ),
    { code: 'INVALID_REQUEST' },
  );
});

test('batch: probe, order, one branch, size budget; result shape with prefix rejection', () => {
  assert.deepEqual(parsePosSaleBatch({ events: [] }), { events: [] });
  const events = Object.values(vectors).map(({ event }) => event);
  assert.equal(parsePosSaleBatch({ events }).events.length, events.length);
  assert.throws(() => parsePosSaleBatch({ events: [events[1], events[0]] }), {
    code: 'INVALID_REQUEST',
  });
  assert.throws(() => parsePosSaleBatch({ events: [events[0], events[0]] }), {
    code: 'INVALID_REQUEST',
  });
  const other = copy(events[1]);
  other.branch_id = events[1].payload.order_id;
  assert.throws(() => parsePosSaleBatch({ events: [events[0], other] }), {
    code: 'INVALID_REQUEST',
  });
  assert.throws(() => parsePosSaleBatch({ events: [], extra: 1 }), { code: 'INVALID_REQUEST' });
  const many = Array.from({ length: MAX_POS_SALE_BATCH + 1 }, (_, index) => ({
    ...copy(events[0]),
    event_id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    sequence: String(index + 1),
  }));
  assert.throws(() => parsePosSaleBatch({ events: many }), { code: 'INVALID_REQUEST' });
  assert.equal(parsePosSaleBatch({ events: many.slice(0, 50) }).events.length, 50);
  // A 50-line quote with long names (about 60 KB): two such sales exceed the request budget.
  const big = mutate('sale_cash_with_change', (p) => {
    const name = { ru: 'Б'.repeat(300), kk: 'К'.repeat(300) };
    p.quote.lines = Array.from({ length: 50 }, (_, index) => ({
      ...p.quote.lines[0],
      product_id: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      variant_id: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      name,
      unit_price_minor: '7000',
      total_minor: '7000',
    }));
  });
  assert.equal(parsePosSaleEvent(big).payload.quote.lines.length, 50);
  const heavy = [0, 1].map((index) => ({
    ...copy(big),
    event_id: `50000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    sequence: String(index + 1),
  }));
  assert.ok(Buffer.byteLength(JSON.stringify({ events: heavy })) > MAX_POS_SALE_BATCH_BYTES);
  assert.throws(() => parsePosSaleBatch({ events: heavy }), { code: 'INVALID_REQUEST' });
  assert.equal(parsePosSaleBatch({ events: heavy.slice(0, 1) }).events.length, 1);
  const receipt = posSaleReceiptFor(events[0]);
  assert.deepEqual(
    PosSaleBatchResultSchema.parse({
      receipts: [receipt],
      rejected: { event_id: events[1].event_id, code: 'CONFLICT' },
    }).rejected,
    { event_id: events[1].event_id, code: 'CONFLICT' },
  );
  assert.equal(
    PosSaleBatchResultSchema.safeParse({ receipts: [], rejected: { event_id: receipt.event_id } })
      .success,
    false,
  );
});
