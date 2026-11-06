// Cutover lane kds, KDS-4 (contracts section 5.4): the courier handover marks of the edge staff
// command and the courier incident request mirror the HTTP contract exactly, and every existing
// command hashes as before. Pure: no PostgreSQL.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CourierIncidentListQuerySchema,
  CourierIncidentRequestSchema,
  FulfillmentActionSchema,
  FulfillmentHandoverSchema,
} from '@pickchick/contracts';
import {
  CourierIncidentInputSchema,
  CourierIncidentQuerySchema,
  StaffCommandSchema,
  digest,
} from '../dist/index.js';

const MARKS = { numberMatched: true, courierAccepted: true, photoTaken: true };
const base = () => ({
  commandId: randomUUID(),
  orderId: randomUUID(),
  expectedVersion: 7,
  action: 'handoff',
});

test('staff command handover marks mirror FulfillmentHandoverSchema of the contract', () => {
  const vectors = [
    MARKS,
    { numberMatched: true, courierAccepted: true },
    { ...MARKS, photoTaken: false },
    { ...MARKS, numberMatched: 'true' },
    { ...MARKS, extra: true },
    {},
    null,
    [],
    true,
  ];
  for (const handover of vectors) {
    const http = FulfillmentHandoverSchema.safeParse(handover).success;
    assert.equal(
      StaffCommandSchema.safeParse({ ...base(), handover }).success,
      http,
      JSON.stringify(handover),
    );
    assert.equal(
      FulfillmentActionSchema.safeParse({ action: 'handoff', expectedVersion: 7, handover })
        .success,
      http,
      JSON.stringify(handover),
    );
  }
  assert.deepEqual(StaffCommandSchema.parse({ ...base(), handover: MARKS }).handover, MARKS);
});

test('a command without marks parses and hashes exactly as before KDS-4', () => {
  // Every action of the D0 command shape: the parsed value has no new key, so the request hash
  // stored in fulfillment_commands for a replay is unchanged.
  for (const action of [
    { action: 'start_task', taskId: randomUUID(), expectedTaskVersion: 1 },
    { action: 'complete_task', taskId: randomUUID(), expectedTaskVersion: 2 },
    { action: 'confirm_stop', taskId: randomUUID(), expectedTaskVersion: 3 },
    { action: 'complete_station', stationId: randomUUID() },
    { action: 'ready' },
    { action: 'handoff' },
    {
      action: 'confirm_cancel',
      reason: 'Гость отказался',
      inventoryDisposition: 'recorded_elsewhere',
    },
  ]) {
    const command = { ...base(), ...action };
    const parsed = StaffCommandSchema.parse(command);
    assert.deepEqual(parsed, command);
    assert.ok(!('handover' in parsed));
    assert.equal(digest(parsed), digest(command));
  }
  // The marks are part of the request: the same key with or without them is another request.
  const command = base();
  assert.notEqual(
    digest(StaffCommandSchema.parse(command)),
    digest(StaffCommandSchema.parse({ ...command, handover: MARKS })),
  );
});

test('the edge incident request mirrors CourierIncidentRequestSchema of the contract', () => {
  const good = {
    orderId: randomUUID(),
    provider: 'yandex_eda',
    claimedNumber: ' ya-12 ',
    kind: 'number_mismatch',
    description: '  Номер не совпал  ',
  };
  const vectors = [
    good,
    { provider: 'other', kind: 'courier_refused', description: 'Курьер отказался' },
    { provider: 'glovo', kind: 'no_photo', description: 'abc', claimedNumber: 'G-1' },
    ...['yandex_eda', 'glovo', 'other', 'chocofood', 'hall', ''].map((provider) => ({
      ...good,
      provider,
    })),
    ...[
      'number_mismatch',
      'not_accepted_in_app',
      'no_photo',
      'courier_refused',
      'other',
      'late',
    ].map((kind) => ({ ...good, kind })),
    { ...good, claimedNumber: '' },
    { ...good, claimedNumber: '+7 700 000' },
    { ...good, claimedNumber: 'A'.repeat(40) },
    { ...good, claimedNumber: 'A'.repeat(41) },
    { ...good, description: ' ab ' },
    { ...good, description: 'x'.repeat(500) },
    { ...good, description: 'x'.repeat(501) },
    { ...good, orderId: 'not-a-uuid' },
    { ...good, phone: '0' },
    // No phone numbers in the journal (synthetic all-zero numbers).
    { ...good, claimedNumber: '87000000000' },
    { ...good, claimedNumber: '8700000000' },
    { ...good, claimedNumber: 'G-87000000000' },
    { ...good, description: 'Курьер просил звонить +7 700 000 00 00' },
    { ...good, description: 'Курьер просил звонить 8 (700) 000-00-00' },
    { ...good, description: 'Курьер просил звонить 8700000000000' },
    { ...good, description: 'Заказ Y-87000000000 не совпал' },
    { ...good, description: 'Ждал 8 минут, 10 заказов в очереди' },
    { provider: 'glovo', kind: 'other' },
    {},
  ];
  for (const vector of vectors) {
    const http = CourierIncidentRequestSchema.safeParse(vector);
    const edge = CourierIncidentInputSchema.safeParse(vector);
    assert.equal(edge.success, http.success, JSON.stringify(vector));
    if (http.success) assert.deepEqual(edge.data, http.data);
  }
  const accepted = (patch) => CourierIncidentInputSchema.safeParse({ ...good, ...patch }).success;
  for (const phone of [
    { claimedNumber: '87000000000' },
    { description: 'Курьер просил звонить +7 700 000 00 00' },
    { description: 'Курьер просил звонить 8 (700) 000-00-00' },
  ])
    assert.equal(accepted(phone), false, JSON.stringify(phone));
  for (const plain of [
    { claimedNumber: '8700000000' },
    { claimedNumber: 'G-87000000000' },
    { description: 'Заказ Y-87000000000 не совпал' },
    { description: 'Ждал 8 минут, 10 заказов в очереди' },
  ])
    assert.equal(accepted(plain), true, JSON.stringify(plain));
  for (const scope of ['open', 'today', 'all', ''])
    assert.equal(
      CourierIncidentQuerySchema.safeParse({ scope }).success,
      CourierIncidentListQuerySchema.safeParse({ scope }).success,
    );
  assert.equal(CourierIncidentQuerySchema.safeParse({ scope: 'open', x: 1 }).success, false);
});
