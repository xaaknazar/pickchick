// «Скорость кухни» (owner 27.11): station and order figures from the kitchen events of one day.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeKitchenSpeed, KitchenSpeedQuery } from '../dist/index.js';

const PREP = '00000000-0000-4000-8000-0000000000a1';
const ASM = '00000000-0000-4000-8000-0000000000a2';
const day = Date.parse('2026-11-27T00:00:00+05:00');
const at = (minutes) => new Date(day + 10 * 3600000 + minutes * 60000).toISOString();
const order = (source, id, created, events) =>
  events.map(([type, extra]) => ({
    source,
    event_type: type,
    payload: { orderId: id, createdAt: at(created), assemblyStationId: ASM, ...extra },
  }));
const task = (taskId, stationId, state, minute) => [
  'edge.task_changed',
  { taskId, stationId, taskState: state, updatedAt: at(minute), state: 'in_production' },
];

test('stations: time from acceptance to done, cooking from start; late is over twice the norm', () => {
  const events = [
    ...order('cloud', 'o1', 0, [
      ['edge.fulfillment_accepted', { state: 'accepted', updatedAt: at(0) }],
      task('t1', PREP, 'in_progress', 1),
      task('t1', PREP, 'done', 4),
      task('t1', PREP, 'done', 9), // a replayed event never moves the first «done»
      ['edge.fulfillment_ready', { state: 'ready', updatedAt: at(6) }],
    ]),
    ...order('pos', 'o2', 10, [
      task('t2', PREP, 'done', 22),
      ['edge.fulfillment_ready', { state: 'ready', updatedAt: at(23) }],
    ]),
    ...order('cloud', 'o3', 20, [task('t3', PREP, 'in_progress', 21)]),
    ...order('pos', 'o4', 30, [
      task('t4', PREP, 'done', 31),
      ['edge.fulfillment_cancelled', { state: 'cancelled', updatedAt: at(32) }],
    ]),
    // Accepted the day before: left out.
    ...order('cloud', 'o5', -24 * 60, [task('t5', PREP, 'done', -24 * 60 + 2)]),
  ];
  const info = new Map([
    [PREP, { name: 'Фритюр', target: 300, kind: 'prep' }],
    [ASM, { name: 'Сборка', target: null, kind: 'assembly' }],
  ]);
  const r = summarizeKitchenSpeed(events, info, day, day + 86400000);
  assert.deepEqual(r.stations, [
    {
      station_id: PREP,
      name: 'Фритюр',
      kind: 'prep',
      target_seconds: 300,
      tasks: 2,
      avg_seconds: (240 + 720) / 2,
      median_seconds: (240 + 720) / 2,
      avg_cook_seconds: 180,
      late_tasks: 1,
    },
  ]);
  assert.deepEqual(r.orders, {
    total: 3,
    from_app_and_kiosk: 2,
    from_cashier: 1,
    ready: 2,
    not_ready: 1,
    avg_ready_seconds: (360 + 780) / 2,
    median_ready_seconds: (360 + 780) / 2,
    late: 1,
  });
  assert.equal(r.truncated, false);
});

test('unknown stations keep their id; bad payloads are skipped; the query takes one day', () => {
  const r = summarizeKitchenSpeed(
    [
      { source: 'cloud', event_type: 'edge.task_changed', payload: null },
      { source: 'cloud', event_type: 'edge.task_changed', payload: { orderId: 7 } },
      ...order('cloud', 'o1', 0, [task('t1', PREP, 'done', 2)]),
    ],
    new Map(),
    day,
    day + 86400000,
  );
  assert.equal(r.stations[0].name, null);
  assert.equal(r.stations[0].tasks, 1);
  assert.equal(r.orders.not_ready, 1);
  assert.equal(KitchenSpeedQuery.safeParse({ date: '2026-11-27' }).success, true);
  assert.equal(KitchenSpeedQuery.safeParse({ date: '2026-02-30' }).success, false);
  assert.equal(KitchenSpeedQuery.safeParse({ date: '2026-11-27', extra: 1 }).success, false);
});
