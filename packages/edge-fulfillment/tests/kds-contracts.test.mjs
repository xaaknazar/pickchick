// Cutover lane kds, KDS-1 (contracts section 5.4): the optional KDS fields of fulfillment.ts keep
// every existing payload byte-identical, and the new kds.ts schemas enforce the layout rules.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import {
  AggregatorChannelSchema,
  CourierIncidentKindSchema,
  CourierIncidentListQuerySchema,
  CourierIncidentListSchema,
  CourierIncidentRequestSchema,
  CourierIncidentSchema,
  FulfillmentActionSchema,
  FulfillmentKitchenOrderSchema,
  FulfillmentKitchenSchema,
  FulfillmentLayoutSchema,
  FulfillmentOrderSchema,
  FulfillmentTaskSchema,
  KDS_FUNCTION_KIND,
  KDS_FUNCTION_UNITS,
  KdsBreadingSchema,
  KdsFunctionSchema,
  KdsLayoutSchema,
  KdsUnitSchema,
  MenuSourceIdSchema,
  jsonSchema,
} from '@pickchick/contracts';

// Frozen copy of the D0 (5b212949) fulfillment schemas: what installed kitchen clients and the
// current edge output accept. Never update it; it is the compatibility reference.
const frozen = (() => {
  const uuid = z.uuid();
  const version = z.int().positive().max(2147483647);
  const reference = z.string().min(1).max(160);
  const bilingual = z.strictObject({ ru: z.string().min(1).max(250), kk: z.string().max(250) });
  const number = z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine((v) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
  const Summary = z.strictObject({
    orderId: uuid,
    branchId: uuid,
    version,
    state: z.enum([
      'held',
      'accepted',
      'in_production',
      'ready',
      'handed_over',
      'cancel_requested',
      'cancelled',
      'released',
    ]),
    displayNumber: number.nullable(),
    routingVersion: version,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  });
  const Modifier = z.strictObject({
    groupId: reference,
    groupTitle: bilingual,
    optionId: reference,
    label: bilingual,
    quantity: z.int().min(1).max(1_000_000),
    linkedProductId: reference.nullable(),
  });
  const Task = z.strictObject({
    taskId: uuid,
    stationId: uuid,
    version,
    state: z.enum(['queued', 'in_progress', 'done', 'cancel_requested', 'cancelled']),
    kind: z.enum(['prep', 'assembly_item']),
    details: z.strictObject({
      lineId: uuid,
      productId: reference,
      title: z.string().min(1).max(250),
      parentTitle: z.string().min(1).max(250),
      description: z.string().max(2000),
      quantity: z.int().min(1).max(1_000_000),
      modifiers: z.array(Modifier).max(100),
    }),
  });
  const KitchenOrder = Summary.extend({
    restoreReview: z
      .strictObject({ epoch: z.int().min(2), status: z.enum(['pending', 'resume', 'retire']) })
      .optional(),
    assemblyStationId: uuid,
    channel: z.enum(['mobile', 'kiosk', 'pos']),
    serviceMode: z.enum(['takeaway', 'dine_in']),
    kitchenComment: z.string().max(60).optional(),
    tasks: z.array(Task).max(2000),
  });
  const Order = KitchenOrder.extend({
    cancellationReason: z.string().min(1).max(500).nullable(),
    inventoryDisposition: z.enum(['requires_inventory_review', 'recorded_elsewhere']).nullable(),
  });
  const Kitchen = z.strictObject({
    items: z.array(KitchenOrder).max(100),
    nextAfterOrderId: uuid.nullable(),
  });
  const Action = z.discriminatedUnion('action', [
    z.strictObject({
      action: z.enum(['start_task', 'complete_task', 'confirm_stop']),
      expectedVersion: version,
      taskId: uuid,
      expectedTaskVersion: version,
    }),
    z.strictObject({
      action: z.literal('complete_station'),
      expectedVersion: version,
      stationId: uuid,
    }),
    z.strictObject({ action: z.enum(['ready', 'handoff']), expectedVersion: version }),
    z.strictObject({
      action: z.literal('confirm_cancel'),
      expectedVersion: version,
      reason: z.string().trim().min(1).max(500),
      inventoryDisposition: z.enum(['requires_inventory_review', 'recorded_elsewhere']),
    }),
  ]);
  return { Task, KitchenOrder, Order, Kitchen, Action };
})();

const task = (extra = {}) => ({
  taskId: randomUUID(),
  stationId: randomUUID(),
  version: 2,
  state: 'in_progress',
  kind: 'prep',
  details: {
    lineId: randomUUID(),
    productId: 'pick-combo',
    title: 'Синтетический комбо',
    parentTitle: 'Синтетический комбо',
    description: 'Без лука',
    quantity: 2,
    modifiers: [
      {
        groupId: 'drink',
        groupTitle: { ru: 'Напиток', kk: '' },
        optionId: 'cola',
        label: { ru: 'Кола', kk: '' },
        quantity: 1,
        linkedProductId: null,
      },
    ],
    ...extra,
  },
});
const kitchenOrder = (extra = {}) => ({
  orderId: randomUUID(),
  branchId: randomUUID(),
  version: 3,
  state: 'in_production',
  displayNumber: '27',
  routingVersion: 1,
  createdAt: '2026-11-19T06:00:00.000Z',
  updatedAt: '2026-11-19T06:01:00.000Z',
  restoreReview: { epoch: 2, status: 'resume' },
  assemblyStationId: randomUUID(),
  channel: 'pos',
  serviceMode: 'takeaway',
  kitchenComment: 'Позвонить',
  tasks: [task(), task()],
  ...extra,
});
const minimalOrder = () => {
  const order = kitchenOrder({ displayNumber: null, channel: 'kiosk', serviceMode: 'dine_in' });
  delete order.restoreReview;
  delete order.kitchenComment;
  return order;
};
const actions = () => [
  { action: 'start_task', expectedVersion: 1, taskId: randomUUID(), expectedTaskVersion: 1 },
  { action: 'complete_task', expectedVersion: 2, taskId: randomUUID(), expectedTaskVersion: 2 },
  { action: 'confirm_stop', expectedVersion: 2, taskId: randomUUID(), expectedTaskVersion: 1 },
  { action: 'complete_station', expectedVersion: 3, stationId: randomUUID() },
  { action: 'ready', expectedVersion: 4 },
  { action: 'handoff', expectedVersion: 5 },
  {
    action: 'confirm_cancel',
    expectedVersion: 2,
    reason: 'Гость ушёл',
    inventoryDisposition: 'recorded_elsewhere',
  },
];
const same = (schema, value) =>
  assert.equal(JSON.stringify(schema.parse(value)), JSON.stringify(value));

test('every existing kitchen payload parses and serialises byte-identically', () => {
  const orders = [kitchenOrder(), minimalOrder()];
  for (const order of orders) {
    same(FulfillmentKitchenOrderSchema, order);
    assert.equal(
      JSON.stringify(FulfillmentKitchenOrderSchema.parse(order)),
      JSON.stringify(frozen.KitchenOrder.parse(order)),
    );
    for (const t of order.tasks) same(FulfillmentTaskSchema, t);
  }
  const full = {
    ...kitchenOrder(),
    cancellationReason: null,
    inventoryDisposition: null,
  };
  same(FulfillmentOrderSchema, full);
  assert.equal(
    JSON.stringify(FulfillmentOrderSchema.parse(full)),
    JSON.stringify(frozen.Order.parse(full)),
  );
  const page = { items: orders, nextAfterOrderId: null };
  same(FulfillmentKitchenSchema, page);
  assert.equal(
    JSON.stringify(FulfillmentKitchenSchema.parse(page)),
    JSON.stringify(frozen.Kitchen.parse(page)),
  );
  // Key order of the response is the schema order; an unordered input comes out the same.
  const shuffled = Object.fromEntries(Object.entries(kitchenOrder()).reverse());
  assert.equal(
    JSON.stringify(FulfillmentKitchenOrderSchema.parse(shuffled)),
    JSON.stringify(frozen.KitchenOrder.parse(shuffled)),
  );
});

test('every existing kitchen action parses unchanged; handover is only for handoff', () => {
  for (const action of actions()) {
    same(FulfillmentActionSchema, action);
    assert.deepEqual(FulfillmentActionSchema.parse(action), frozen.Action.parse(action));
  }
  const handover = { numberMatched: true, courierAccepted: true, photoTaken: true };
  same(FulfillmentActionSchema, { action: 'handoff', expectedVersion: 5, handover });
  for (const bad of [
    { action: 'ready', expectedVersion: 5, handover },
    { action: 'handoff', expectedVersion: 5, handover: { ...handover, photoTaken: false } },
    {
      action: 'handoff',
      expectedVersion: 5,
      handover: { numberMatched: true, courierAccepted: true },
    },
    { action: 'handoff', expectedVersion: 5, handover: { ...handover, extra: true } },
    { action: 'complete_station', expectedVersion: 3, stationId: randomUUID(), cascade: true },
  ])
    assert.equal(FulfillmentActionSchema.safeParse(bad).success, false, JSON.stringify(bad));
  // An installed client never sends handover; an old edge parser would refuse it (gated by KDS).
  assert.equal(
    frozen.Action.safeParse({ action: 'handoff', expectedVersion: 5, handover }).success,
    false,
  );
});

test('KDS ticket fields are optional, strict and refused by installed parsers', () => {
  const kds = {
    function: 'toasts',
    upstreamOf: randomUUID(),
    units: 2,
    unit: 'toast',
  };
  const order = kitchenOrder({
    delivery: { provider: 'yandex_eda', externalNumber: 'YA-1234' },
    tasks: [task({ kds }), task({ kds: { function: 'assembly_delivery', fingers: 6 } })],
  });
  // New keys sit where the schema puts them; their content is kept exactly.
  assert.deepEqual(FulfillmentKitchenOrderSchema.parse(order), order);
  same(FulfillmentTaskSchema, task({ kds: { function: 'assembly_hall', unmapped: true } }));
  assert.equal(frozen.KitchenOrder.safeParse(order).success, false);
  for (const bad of [
    { delivery: { provider: 'chocofood', externalNumber: 'CH-123' } },
    { delivery: { provider: 'glovo', externalNumber: 'gl-123' } },
    { delivery: { provider: 'glovo', externalNumber: 'G1' } },
    { delivery: { provider: 'glovo', externalNumber: 'G-123', name: 'x' } },
    { tasks: [task({ kds: { function: 'drinks' } })] },
    { tasks: [task({ kds: { function: 'toasts', unit: 'cup' } })] },
    { tasks: [task({ kds: { function: 'toasts', units: 0 } })] },
    { tasks: [task({ kds: { function: 'issue', unmapped: false } })] },
    { tasks: [task({ kds: { function: 'issue', breading: true } })] },
    { tasks: [task({ kds: { function: 'issue', upstreamOf: 'table' } })] },
  ])
    assert.equal(
      FulfillmentKitchenOrderSchema.safeParse(kitchenOrder(bad)).success,
      false,
      JSON.stringify(bad),
    );
});

const BRANCH = '10000000-0000-4000-8000-000000000003';
const station = (fn, extra = {}) => ({
  edge_station_id: randomUUID(),
  function: fn,
  terminal_ids: [],
  product_ids: [],
  ...extra,
});
const layout = (stations) => ({ schema_version: 1, branch_id: BRANCH, version: 1, stations });
const fullLayout = () => {
  const [t6, t5, t1, t2, t3] = [1, 2, 3, 4, 5].map(() => randomUUID());
  return layout([
    station('breading', {
      terminal_ids: [t6],
      product_ids: ['pick-combo', 'strips-3'],
      counts: [
        { product_id: 'pick-combo', unit: 'finger', count: 3 },
        { product_id: 'strips-3', unit: 'finger', count: 3 },
      ],
    }),
    station('toasts', {
      terminal_ids: [t5],
      product_ids: ['pick-burger', 'toast-chicken'],
      counts: [
        { product_id: 'pick-burger', unit: 'burger', count: 1 },
        { product_id: 'toast-chicken', unit: 'toast', count: 1 },
      ],
    }),
    // Morning: one person on table 1 and issue, tabs on one screen.
    station('assembly_hall', { terminal_ids: [t1], product_ids: ['pick-combo', 'pick-burger'] }),
    station('assembly_delivery', { terminal_ids: [t2], product_ids: ['pick-combo'] }),
    station('issue', { terminal_ids: [t3, t1], product_ids: ['cola', 'sauce-cheese'] }),
    // Station 3 is a tab on the table 2 screen.
    station('delivery_handover', { terminal_ids: [t2] }),
  ]);
};

test('KdsLayoutSchema accepts the restaurant layout and stays strict', () => {
  same(KdsLayoutSchema, fullLayout());
  same(KdsLayoutSchema, layout([station('assembly_hall'), station('issue')]));
  const minimal = layout([station('issue'), station('assembly_hall', { product_ids: ['cola'] })]);
  same(KdsLayoutSchema, minimal);
  for (const extra of [{ name: 'x' }, { counts: [] }]) {
    const value = fullLayout();
    Object.assign(value.stations[4], extra);
    // counts: [] is a valid empty list; an unknown key is not.
    assert.equal(KdsLayoutSchema.safeParse(value).success, 'counts' in extra);
  }
  assert.equal(KdsLayoutSchema.safeParse({ ...fullLayout(), schema_version: 2 }).success, false);
  assert.equal(KdsLayoutSchema.safeParse({ ...fullLayout(), extra: true }).success, false);
});

test('KdsLayoutSchema rejects every broken layout rule', () => {
  const broken = {
    'duplicate function': (l) => l.stations.push(station('issue')),
    'duplicate edge station': (l) =>
      (l.stations[1].edge_station_id = l.stations[0].edge_station_id),
    'missing issue': (l) => l.stations.splice(4, 1),
    'missing table 1': (l) => l.stations.splice(2, 1),
    'duplicate product': (l) => l.stations[2].product_ids.push('pick-combo'),
    'duplicate terminal': (l) => l.stations[0].terminal_ids.push(l.stations[0].terminal_ids[0]),
    'bad slug': (l) => l.stations[2].product_ids.push('Pick Combo'),
    'too many products': (l) =>
      (l.stations[2].product_ids = Array.from({ length: 201 }, (_, i) => 'p-' + i)),
    'too many terminals': (l) =>
      (l.stations[3].terminal_ids = Array.from({ length: 11 }, () => randomUUID())),
    'count outside station': (l) =>
      l.stations[0].counts.push({ product_id: 'cola', unit: 'finger', count: 1 }),
    'duplicate count': (l) =>
      l.stations[0].counts.push({ product_id: 'pick-combo', unit: 'finger', count: 2 }),
    'finger on toasts': (l) => (l.stations[1].counts[0].unit = 'finger'),
    'toast on breading': (l) => (l.stations[0].counts[0].unit = 'toast'),
    'count on a table': (l) =>
      (l.stations[2].counts = [{ product_id: 'pick-combo', unit: 'finger', count: 3 }]),
    'count zero': (l) => (l.stations[0].counts[0].count = 0),
    'count over 100': (l) => (l.stations[0].counts[0].count = 101),
    'terminal on three stations': (l) =>
      l.stations[4].terminal_ids.push(l.stations[3].terminal_ids[0]),
    'terminal on prep and assembly': (l) =>
      l.stations[2].terminal_ids.push(l.stations[1].terminal_ids[0]),
    'seventh station': (l) => l.stations.push(station('breading')),
    'unknown function': (l) => (l.stations[0].function = 'assembly_burgers'),
  };
  for (const [name, mutate] of Object.entries(broken)) {
    const value = fullLayout();
    mutate(value);
    assert.equal(KdsLayoutSchema.safeParse(value).success, false, name);
  }
});

test('function kinds and units cover the shared enum exactly', () => {
  assert.deepEqual(Object.keys(KDS_FUNCTION_KIND).sort(), [...KdsFunctionSchema.options].sort());
  assert.deepEqual(Object.keys(KDS_FUNCTION_UNITS).sort(), [...KdsFunctionSchema.options].sort());
  for (const units of Object.values(KDS_FUNCTION_UNITS))
    for (const unit of units) assert.ok(KdsUnitSchema.options.includes(unit));
  // The layout slug rule is the catalog slug rule.
  for (const slug of ['pick-combo', 'a', '0-x', 'A', '-a', 'a_b', 'a'.repeat(40), 'a'.repeat(41)])
    assert.equal(
      KdsLayoutSchema.safeParse(
        layout([station('assembly_hall', { product_ids: [slug] }), station('issue')]),
      ).success,
      MenuSourceIdSchema.safeParse(slug).success,
      slug,
    );
});

test('GET fulfillment/layout: {enabled:false} only, or a strict enabled view', () => {
  same(FulfillmentLayoutSchema, { enabled: false });
  assert.equal(
    FulfillmentLayoutSchema.safeParse({ enabled: false, layoutVersion: 1 }).success,
    false,
  );
  const stations = ['assembly_hall', 'issue'].map((fn) => ({
    id: randomUUID(),
    function: fn,
    name: 'Станция',
    kind: 'assembly',
  }));
  const view = {
    enabled: true,
    layoutVersion: 3,
    mode: 'normal',
    stations,
    screens: [stations[0].id, stations[1].id],
  };
  same(FulfillmentLayoutSchema, view);
  same(FulfillmentLayoutSchema, { ...view, screens: [] });
  for (const bad of [
    { ...view, screens: [randomUUID()] },
    { ...view, screens: [stations[0].id, stations[0].id] },
    { ...view, screens: [stations[0].id, stations[1].id, stations[0].id] },
    { ...view, mode: 'rush' },
    { ...view, stations: [] },
    { ...view, extra: 1 },
  ])
    assert.equal(FulfillmentLayoutSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test('GET fulfillment/kds/breading view', () => {
  const view = {
    orders: [
      {
        orderId: randomUUID(),
        displayNumber: '12',
        serviceMode: 'takeaway',
        delivery: { provider: 'glovo', externalNumber: 'G-456' },
        lines: [
          { title: 'Pick Combo', quantity: 2, fingers: 6 },
          { title: 'Кола', quantity: 1 },
        ],
        fingers: 6,
      },
      {
        orderId: randomUUID(),
        displayNumber: null,
        serviceMode: 'dine_in',
        lines: [{ title: 'Бургер', quantity: 1 }],
      },
    ],
    totalFingers: 6,
  };
  same(KdsBreadingSchema, view);
  same(KdsBreadingSchema, { orders: [] });
  for (const bad of [
    { orders: [{ ...view.orders[0], lines: [] }] },
    { orders: [{ ...view.orders[0], fingers: 0 }] },
    { orders: [{ ...view.orders[1], serviceMode: 'delivery' }] },
    { orders: view.orders, totalFingers: -1 },
    { orders: Array.from({ length: 101 }, () => view.orders[1]) },
  ])
    assert.equal(KdsBreadingSchema.safeParse(bad).success, false);
});

test('courier incident request, record and list', () => {
  assert.deepEqual(
    CourierIncidentRequestSchema.parse({
      orderId: randomUUID().toString(),
      provider: 'yandex_eda',
      claimedNumber: ' YA-77 ',
      kind: 'number_mismatch',
      description: '  Номер в приложении курьера другой  ',
    }).claimedNumber,
    'YA-77',
  );
  same(CourierIncidentRequestSchema, {
    provider: 'other',
    kind: 'courier_refused',
    description: 'Курьер отказался',
  });
  for (const bad of [
    { provider: 'chocofood', kind: 'other', description: 'abc' },
    { provider: 'glovo', kind: 'late', description: 'abc' },
    { provider: 'glovo', kind: 'other', description: '  a ' },
    { provider: 'glovo', kind: 'other', description: 'x'.repeat(501) },
    { provider: 'glovo', kind: 'other', description: 'abc', claimedNumber: '+7 777 000' },
    { provider: 'glovo', kind: 'other', description: 'abc', phone: '0' },
  ])
    assert.equal(CourierIncidentRequestSchema.safeParse(bad).success, false, JSON.stringify(bad));
  const item = {
    incidentId: randomUUID(),
    provider: 'glovo',
    claimedNumber: null,
    kind: 'no_photo',
    description: 'Курьер не сфотографировал заказ',
    recordedAt: '2026-11-19T07:00:00.000Z',
    displayNumber: '31',
  };
  same(CourierIncidentSchema, item);
  same(CourierIncidentListSchema, {
    items: [item, { ...item, displayNumber: undefined }].map((i) => JSON.parse(JSON.stringify(i))),
  });
  assert.equal(CourierIncidentSchema.safeParse({ ...item, displayNumber: null }).success, false);
  same(CourierIncidentListQuerySchema, { scope: 'open' });
  assert.equal(CourierIncidentListQuerySchema.safeParse({ scope: 'all' }).success, false);
  assert.deepEqual(CourierIncidentRequestSchema.shape.provider.options, [
    ...AggregatorChannelSchema.options,
    'other',
  ]);
  assert.ok(CourierIncidentKindSchema.options.includes('not_accepted_in_app'));
});

test('new schemas generate JSON Schema for openapi', () => {
  for (const schema of [
    KdsLayoutSchema,
    FulfillmentLayoutSchema,
    KdsBreadingSchema,
    CourierIncidentRequestSchema,
    CourierIncidentSchema,
    CourierIncidentListSchema,
    FulfillmentActionSchema,
    FulfillmentOrderSchema,
  ])
    assert.equal(typeof jsonSchema(schema), 'object');
});
