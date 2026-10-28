import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { channelOrdersLostByRestore, evaluate, volumes } from './checks.mjs';
import { LABELS, distinguishable } from './staff-view.mjs';
import { parseArgs, parseDuration, profileFor, PROFILES } from './run.mjs';
import { checkedAdminUrl, scopedUrl, standCatalog } from './stand.mjs';
import { renderMarkdown } from './report.mjs';
import { CatalogPayloadSchema } from '@pickchick/catalog-admin/contracts';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A consistent synthetic restaurant: 3 POS orders (one cancelled), 1 mobile, 1 kiosk. */
function world() {
  const pos = [1, 2, 3].map((n) => ({ orderId: id(n), total: '1000', cancelled: n === 3 }));
  const mobile = { orderId: id(10), paid: true, comboUnits: 1 };
  const kiosk = { orderId: id(11), paid: true };
  const ledger = {
    pos: new Map(pos.map((o) => [o.orderId, o])),
    mobile: new Map([[mobile.orderId, mobile]]),
    kiosk: new Map([[kiosk.orderId, kiosk]]),
  };
  const reservations = [
    ...pos.map((o, i) => ({
      order_id: o.orderId,
      commercial_owner: 'edge_pos',
      state: o.cancelled ? 'cancelled' : 'handed_over',
      version: 5,
      display_number: String(i + 1),
      business_day: '2026-10-24',
    })),
    {
      order_id: id(10),
      commercial_owner: 'cloud',
      state: 'accepted',
      version: 2,
      display_number: '4',
      business_day: '2026-10-24',
    },
    {
      order_id: id(11),
      commercial_owner: 'cloud',
      state: 'ready',
      version: 4,
      display_number: '5',
      business_day: '2026-10-24',
    },
  ];
  const data = {
    edge: {
      orders: pos.map((o) => ({
        id: o.orderId,
        total_minor: '1000',
        state: o.cancelled ? 'cancelled' : 'awaiting_payment',
        version: o.cancelled ? 2 : 1,
      })),
      posEvents: { total: 4, distinct_versions: 4 },
      reservations,
      taskDuplicates: [],
      taskCounts: reservations.map((r) => ({ order_id: r.order_id, n: 2 })),
      kitchenEvents: { pos: 12, cloud: 6 },
      inbox: [{ event_type: 'edge.admission_requested', n: 2 }],
      cashierReports: [{ kind: 'order', n: 3 }],
      shifts: [{ id: id(20), state: 'closed' }],
      remoteStops: [{ command_id: id(30), state: 'applied' }],
      stops: [id(40)],
      activeRelease: id(50),
    },
    cloud: {
      posOrders: pos.map((o) => ({
        order_id: o.orderId,
        total_minor: '1000',
        state: o.cancelled ? 'cancelled' : 'awaiting_payment',
        version: o.cancelled ? 2 : 1,
      })),
      posInbox: { total: 4, distinct_versions: 4 },
      posKitchen: reservations
        .filter((r) => r.commercial_owner === 'edge_pos')
        .map((r) => ({ order_id: r.order_id, state: r.state, version: r.version })),
      posKitchenInbox: { total: 12, distinct_versions: 12 },
      projection: reservations
        .filter((r) => r.commercial_owner === 'cloud')
        .map((r) => ({
          order_id: r.order_id,
          state: r.state,
          version: r.version,
          display_number: r.display_number,
        })),
      orders: [id(10), id(11)].map((o, i) => ({
        id: o,
        channel: i ? 'kiosk' : 'mobile',
        total_minor: '2500',
        attention_required: false,
        state: 'paid',
        kitchen_effect: true,
        captures: 1,
        captured: '2500',
        refunds: 0,
      })),
      accruals: [{ order_id: id(10), units: 1 }],
      cashierOrders: pos.map((o) => ({ id: o.orderId })),
      cashierShifts: [{ id: id(20) }],
      stopCommands: [{ id: id(30), state: 'applied' }],
      availability: { fresh: true, stoppedIds: [id(40)] },
      availabilityStops: [id(40)],
      activation: { release_id: id(50), acknowledged: true },
    },
  };
  return { data, ledger };
}
const failed = (results) => results.filter((r) => !r.ok).map((r) => r.id);
const pending = { pos_events: 0, kitchen_events: 0 };

test('a consistent restaurant passes every invariant', () => {
  const { data, ledger } = world();
  const results = evaluate(data, ledger, { pending });
  assert.deepEqual(failed(results), []);
  assert.ok(results.length >= 15);
  assert.ok(
    results.every((r) => /[а-я]/i.test(r.title)),
    'Russian titles for the report',
  );
  assert.equal(volumes(data).total_sync_events, 4 + 12 + 6 + 2 + 3);
});

test('a POS order the cashier was told about but the edge lacks is a lost order', () => {
  const { data, ledger } = world();
  data.edge.orders.pop();
  data.cloud.posOrders.pop();
  data.cloud.cashierOrders.pop();
  assert.ok(failed(evaluate(data, ledger, { pending })).includes('pos_no_lost_orders'));
  // ... unless a restore drill lost it on purpose (kept in the cloud as the lost timeline).
  const again = world();
  again.data.edge.orders.pop();
  const lostId = id(3);
  assert.ok(
    !failed(evaluate(again.data, again.ledger, { pending, lostPosOrders: [lostId] })).includes(
      'pos_no_lost_orders',
    ),
  );
});

test('an extra edge order from a retried request is a duplicate', () => {
  const { data, ledger } = world();
  data.edge.orders.push({ id: id(99), total_minor: '1000', state: 'awaiting_payment', version: 1 });
  assert.ok(failed(evaluate(data, ledger, { pending })).includes('pos_no_duplicate_orders'));
});

test('cloud missing, extra or diverging POS orders and events are reported', () => {
  const { data, ledger } = world();
  data.cloud.posOrders[0].state = 'cancelled';
  data.cloud.posInbox = { total: 5, distinct_versions: 4 };
  const ids = failed(evaluate(data, ledger, { pending }));
  assert.ok(ids.includes('pos_orders_in_cloud'));
  assert.ok(ids.includes('pos_events_once'));
});

test('kitchen state drift between edge and cloud is reported for POS and channel orders', () => {
  const { data, ledger } = world();
  data.cloud.posKitchen[0].version = 4;
  data.cloud.projection[1].state = 'accepted';
  const ids = failed(evaluate(data, ledger, { pending }));
  assert.ok(ids.includes('pos_kitchen_in_cloud'));
  assert.ok(ids.includes('channel_projection_matches'));
  assert.ok(ids.includes('channel_orders_admitted_once'));
});

test('a paid order never admitted, a double capture, a refund or a double stamp fail', () => {
  const { data, ledger } = world();
  data.edge.reservations = data.edge.reservations.filter((r) => r.order_id !== id(11));
  data.cloud.orders[0].captures = 2;
  data.cloud.orders[0].captured = '5000';
  data.cloud.orders[1].refunds = 1;
  data.cloud.accruals.push({ order_id: id(10), units: 1 });
  const ids = failed(evaluate(data, ledger, { pending }));
  for (const expected of ['channel_orders_admitted_once', 'payments_once', 'stamps_once'])
    assert.ok(ids.includes(expected), expected);
});

test('a manager review is acceptable only without kitchen work', () => {
  const { data, ledger } = world();
  // The cashier refused the paid kiosk order: its reservation never left 'held'.
  data.cloud.orders[1].attention_required = true;
  data.edge.reservations.find((r) => r.order_id === id(11)).state = 'held';
  data.cloud.projection.find((r) => r.order_id === id(11)).state = 'held';
  assert.ok(!failed(evaluate(data, ledger, { pending })).includes('channel_orders_admitted_once'));
  data.edge.reservations.find((r) => r.order_id === id(11)).state = 'in_production';
  data.cloud.projection.find((r) => r.order_id === id(11)).state = 'in_production';
  assert.ok(failed(evaluate(data, ledger, { pending })).includes('channel_orders_admitted_once'));
});

test('live orders may not share a display number; finished ones may (numbers restart per shift)', () => {
  const { data, ledger } = world();
  data.edge.reservations[0].display_number = '4'; // handed over: may reuse 4
  assert.ok(!failed(evaluate(data, ledger, { pending })).includes('kitchen_tickets_once'));
  data.edge.reservations[1].state = 'ready';
  data.edge.reservations[1].display_number = '4';
  assert.ok(failed(evaluate(data, ledger, { pending })).includes('kitchen_tickets_once'));
  const dup = world();
  dup.data.edge.taskDuplicates = [{ order_id: id(1), component_key: 'x', n: 2 }];
  assert.ok(failed(evaluate(dup.data, dup.ledger, { pending })).includes('kitchen_tickets_once'));
});

test('undelivered queues, stale availability, open stops and an unacknowledged menu fail', () => {
  const { data, ledger } = world();
  data.cloud.availability.fresh = false;
  data.cloud.stopCommands.push({ id: id(31), state: 'pending' });
  data.cloud.stopCommands.push({ id: id(32), state: 'expired' });
  data.edge.remoteStops.push({ command_id: id(32), state: 'applied' });
  data.cloud.activation.acknowledged = false;
  data.cloud.cashierShifts = [];
  const ids = failed(evaluate(data, ledger, { pending: { pos_events: 2 } }));
  for (const expected of [
    'queues_drained',
    'availability_converged',
    'remote_stops_resolved',
    'menu_converged',
    'cashier_reports_delivered',
  ])
    assert.ok(ids.includes(expected), expected);
});

test('staff labels are the texts the POS model and the kitchen screen produce', async () => {
  const pos = await readFile(new URL('../../apps/pos/src/model.ts', import.meta.url), 'utf8');
  const kitchen = await readFile(new URL('../../apps/kitchen/src/app.ts', import.meta.url), 'utf8');
  for (const label of [LABELS.posLanOk, LABELS.posLanDown, LABELS.posWanDown])
    assert.ok(pos.includes(`'${label}'`), label);
  assert.ok(kitchen.includes(`'${LABELS.kitchenLanOk}'`));
  assert.ok(kitchen.includes(`'${LABELS.kitchenLanDown}'`));
});

test('WAN and LAN loss are distinguishable only when each changes what staff see', () => {
  const normal = { pos: LABELS.posLanOk, kitchen: LABELS.kitchenLanOk, cloud_link: 'online' };
  const lanLoss = { ...normal, kitchen: LABELS.kitchenLanDown };
  // Before the fix: the edge knew it was offline but the header did not change.
  const silent = { ...normal, cloud_link: 'offline' };
  assert.equal(distinguishable({ normal, wanLoss: silent, lanLoss }).ok, false);
  const wanLoss = { ...normal, pos: LABELS.posWanDown, cloud_link: 'offline' };
  assert.deepEqual(distinguishable({ normal, wanLoss, lanLoss }), {
    wanVisible: true,
    lanVisible: true,
    different: true,
    ok: true,
  });
});

test('runner options: profiles, durations and refused input', () => {
  assert.equal(parseDuration('8h'), 8 * 3600000);
  assert.equal(parseDuration('90s'), 90000);
  assert.throws(() => parseDuration('8 hours'));
  assert.equal(parseArgs([]).mode, 'ci');
  const soak = parseArgs(['--mode', 'soak', '--duration', '2h', '--rate', '6']);
  assert.equal(profileFor(soak).durationMs, 2 * 3600000);
  assert.equal(profileFor(soak).rates.posPerMinute, 6);
  assert.equal(
    profileFor(parseArgs(['--mode', 'backlog', '--events', '10000'])).backlogEvents,
    10000,
  );
  const short = profileFor(
    parseArgs([
      '--mode',
      'soak',
      '--duration',
      '30m',
      '--sample-every',
      '2m',
      '--shift-every',
      '10m',
    ]),
  );
  assert.deepEqual([short.checkEveryMs, short.shiftEveryMs], [120000, 600000]);
  assert.equal(parseArgs(['--', '--mode', 'soak']).mode, 'soak');
  for (const bad of [
    ['--mode', 'production'],
    ['--events', '-1'],
    ['--scenarios', 'unknown'],
    ['--seed', 'x'],
    ['--rate', '0'],
    ['--wat'],
  ])
    assert.throws(() => parseArgs(bad), bad.join(' '));
  assert.ok(PROFILES.ci.wanOutageMs > 30000, 'longer than the 30 s availability window');
  assert.ok(PROFILES.soak.durationMs >= 8 * 3600000);
});

test('only local pickchick databases and run-owned schemas are accepted', () => {
  const ok = 'postgresql://u:p@127.0.0.1:56050/pickchick_cloud';
  assert.equal(checkedAdminUrl(ok, 'cloud').hostname, '127.0.0.1');
  assert.equal(
    checkedAdminUrl('postgresql://u:p@127.0.0.1:56050/pickchick_edge', 'restore').pathname,
    '/pickchick_edge',
  );
  for (const bad of [
    'postgresql://u:p@203.0.113.1:5432/pickchick_cloud',
    'postgresql://u:p@127.0.0.1:5432/postgres',
    ok + '?sslmode=disable',
    'not a url',
  ])
    assert.throws(() => checkedAdminUrl(bad, 'cloud'));
  const scoped = new URL(scopedUrl(ok, 'offstand_0123456789abcdef'));
  assert.equal(scoped.searchParams.get('options'), '-c search_path=offstand_0123456789abcdef');
  assert.throws(() => scopedUrl(ok, 'public'));
  assert.throws(() => scopedUrl(ok, 'offstand_x; DROP SCHEMA public'));
});

test('the stand catalog is a valid publication', () => {
  assert.ok(CatalogPayloadSchema.safeParse(standCatalog()).success);
});

test('the Russian report lists results, failed checks and the staff view', () => {
  const md = renderMarkdown({
    run_id: 'r1',
    mode: 'ci',
    status: 'failed',
    seed: 1,
    duration_seconds: 600,
    scenarios: [
      {
        id: 'wan_outage',
        title: 'Потеря интернета',
        status: 'failed',
        duration_seconds: 150,
        notes: { outage_seconds: 75, convergence_seconds: 40 },
        checks: [{ id: 'x', title: 'Проверка | с чертой', ok: false, expected: 0, actual: 1 }],
        volumes: {
          pos_orders: 3,
          pos_cancelled: 1,
          channel_orders: 2,
          channel_orders_review: 0,
          handed_over: 2,
          stamps: 1,
          remote_stop_commands: 1,
          total_sync_events: 30,
          pos_events: 4,
          kitchen_events_pos: 10,
          kitchen_events_channel: 6,
          cloud_commands_applied: 4,
          cashier_report_events: 6,
        },
      },
    ],
    staff_view: {
      normal: { pos: LABELS.posLanOk, kitchen: LABELS.kitchenLanOk, cloud_link: 'online' },
      wan_loss: { pos: LABELS.posLanOk, kitchen: LABELS.kitchenLanOk, cloud_link: 'http_404' },
      lan_loss: { pos: LABELS.posLanOk, kitchen: LABELS.kitchenLanDown, cloud_link: 'online' },
      verdict: { ok: false },
    },
    wan_faults: {
      requests: 10,
      refused: 1,
      reset: 1,
      dropped_response: 2,
      duplicated: 3,
      late: 1,
      reordered: 1,
    },
    restarts: { edge: 1 },
    actors: {
      counters: { pos_refused: { KITCHEN_UNAVAILABLE: 2 }, mobile_refused: {}, kiosk_refused: {} },
    },
  });
  assert.match(md, /НЕ ПРОЙДЕН/);
  assert.match(md, /касса \{"KITCHEN_UNAVAILABLE":2\}/);
  assert.match(md, /Проверка \/ с чертой/);
  assert.match(md, /\*\*не различимы\*\*/);
  assert.match(md, /без связи 75 с/);
  assert.match(md, /потеряно ответов после записи 2/);
});

test('QA: a kiosk order handed over on the lost timeline of a restore is a restore loss, not a missed admission', () => {
  const { data, ledger } = world();
  // The cloud saw the paid kiosk order admitted and handed over after the backup; the restored
  // cashier no longer has its reservation.
  data.cloud.projection.find((p) => p.order_id === id(11)).state = 'handed_over';
  data.edge.reservations = data.edge.reservations.filter((r) => r.order_id !== id(11));
  const restored = new Set(data.edge.reservations.map((r) => r.order_id));
  // Listing only live states (before QA 25.10) left it as "paid, not admitted".
  const liveOnly = data.cloud.projection
    .filter((p) => ['held', 'accepted', 'in_production', 'ready'].includes(p.state))
    .filter((p) => !restored.has(p.order_id))
    .map((p) => p.order_id);
  assert.ok(
    failed(evaluate(data, ledger, { pending, lostChannelOrders: liveOnly })).includes(
      'channel_orders_admitted_once',
    ),
  );
  const lost = channelOrdersLostByRestore(data.cloud.projection, restored);
  assert.deepEqual(lost, { lost: [id(11)], live: [], states: { handed_over: 1 } });
  assert.ok(
    !failed(evaluate(data, ledger, { pending, lostChannelOrders: lost.lost })).includes(
      'channel_orders_admitted_once',
    ),
  );
  // A live one is lost as well and listed for the manual kitchen check; an order the restored
  // cashier still has is never excused.
  data.cloud.projection.find((p) => p.order_id === id(11)).state = 'ready';
  assert.deepEqual(channelOrdersLostByRestore(data.cloud.projection, restored).live, [id(11)]);
  assert.deepEqual(
    channelOrdersLostByRestore(data.cloud.projection, new Set([...restored, id(11)])).lost,
    [],
  );
});
