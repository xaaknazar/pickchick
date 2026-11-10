import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  channelOrdersLostByRestore,
  evaluate,
  evaluatePosSales,
  paidDay,
  volumes,
  zMismatch,
} from './checks.mjs';
import { LABELS, distinguishable } from './staff-view.mjs';
import { mergeVerifyContext, parseArgs, parseDuration, profileFor, PROFILES } from './run.mjs';
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

test('restore reconciliation never exempts an unreviewed or changed canonical history', () => {
  const { data, ledger } = world();
  const remote = { ...data.cloud.posKitchen[0] };
  const edge = data.edge.reservations.find((r) => r.order_id === remote.order_id);
  edge.state = 'accepted';
  edge.version = 1;
  const record = {
    orderId: edge.order_id,
    epoch: 2,
    decision: 'retire',
    canonical: remote,
    edgeState: 'accepted',
    edgeVersion: 1,
  };
  const context = { pending, reviewedRestores: [record] };
  assert.ok(failed(evaluate(data, ledger, context)).includes('restore_reviews_preserve_history'));
  data.edge.restoreDecisions = [
    {
      order_id: edge.order_id,
      epoch: 2,
      decision: 'retire',
      expected_version: 1,
      reason: 'Physically reviewed',
    },
  ];
  assert.ok(!failed(evaluate(data, ledger, context)).includes('pos_kitchen_in_cloud'));
  data.cloud.posKitchen[0].version++;
  assert.ok(failed(evaluate(data, ledger, context)).includes('restore_reviews_preserve_history'));
  data.cloud.posKitchen[0].version--;
  edge.version++;
  assert.ok(failed(evaluate(data, ledger, context)).includes('restore_reviews_preserve_history'));
});

test('resumed restore requires the latest durable observation, not merely a manager click', () => {
  const { data, ledger } = world();
  const remote = { ...data.cloud.posKitchen[0] };
  const edge = data.edge.reservations.find((r) => r.order_id === remote.order_id);
  edge.version++;
  const context = {
    pending,
    reviewedRestores: [
      {
        orderId: edge.order_id,
        epoch: 2,
        decision: 'resume',
        canonical: remote,
        edgeState: 'accepted',
        edgeVersion: 1,
      },
    ],
  };
  data.edge.restoreDecisions = [
    {
      order_id: edge.order_id,
      epoch: 2,
      decision: 'resume',
      expected_version: 1,
      reason: 'Physically reviewed',
    },
  ];
  assert.ok(failed(evaluate(data, ledger, context)).includes('restore_reviews_preserve_history'));
  data.cloud.restoreConflicts = [
    {
      order_id: edge.order_id,
      aggregate_version: edge.version,
      envelope: { payload: { state: edge.state } },
    },
  ];
  assert.ok(!failed(evaluate(data, ledger, context)).includes('restore_reviews_preserve_history'));
  data.cloud.restoreConflicts[0].aggregate_version--;
  assert.ok(failed(evaluate(data, ledger, context)).includes('restore_reviews_preserve_history'));
});

/**
 * A consistent paid day (pos_sale) on both sides: one desk, one shift; A paid in cash with
 * change, B paid by Kaspi terminal and voided. Money in tiyn as text, as the snapshot reads it.
 */
function paidWorld() {
  const [A, B, S, T, tA, tB, rB] = [60, 61, 62, 63, 64, 65, 66].map(id);
  const z = {
    kind: 'z',
    shift_id: S,
    terminal_id: T,
    state: 'closed',
    opening_cash_minor: '0',
    cash_in_minor: '0',
    cash_out_minor: '0',
    cash_sales_minor: '150000',
    cash_refunds_minor: '0',
    expected_cash_minor: '150000',
    counted_cash_minor: '150000',
    discrepancy_minor: '0',
    methods: [
      { method: 'cash', sales_minor: '150000', refunds_minor: '0', count: 1 },
      { method: 'kaspi_terminal', sales_minor: '100000', refunds_minor: '100000', count: 1 },
    ],
    channels: [{ sales_channel: 'hall', total_minor: '150000', count: 1 }],
    terminal_reported_minor: '0',
    terminal_discrepancy_minor: '0',
    fiscal: { pending: 0, recorded: 1, not_required: 1 },
    orders: { count: 2, voided_count: 1 },
  };
  const sale = (order, total, tendered, change, state) => ({
    order_id: order,
    shift_id: S,
    terminal_id: T,
    total_minor: total,
    cash_tendered_minor: tendered,
    change_minor: change,
    sales_channel: 'hall',
    external_order_ref: null,
    revenue_kind: 'revenue',
    state,
  });
  const tenders = [
    {
      tender_id: tA,
      order_id: A,
      method: 'cash',
      amount_minor: '150000',
      confirmation: 'drawer',
      reference: null,
    },
    {
      tender_id: tB,
      order_id: B,
      method: 'kaspi_terminal',
      amount_minor: '100000',
      confirmation: 'cashier_attested',
      reference: null,
    },
  ];
  const refunds = [
    {
      refund_id: rB,
      order_id: B,
      kind: 'void',
      shift_id: S,
      amount_minor: '100000',
      parts: [[tB, 'kaspi_terminal', '100000']],
    },
  ];
  const receipts = [
    {
      receipt_id: id(67),
      order_id: A,
      refund_id: null,
      kind: 'sale',
      state: 'recorded',
      receipt_number: 'SYN-1',
      version: 2,
      amount_minor: '150000',
    },
    {
      receipt_id: id(68),
      order_id: B,
      refund_id: null,
      kind: 'sale',
      state: 'not_required',
      receipt_number: null,
      version: 2,
      amount_minor: '100000',
    },
  ];
  const events = ['sale', 'sale', 'void', 'fiscal', 'fiscal', 'shift_report'].map((kind, i) => ({
    event_id: id(70 + i),
    kind,
    sequence: String(i + 1),
    acknowledged: true,
    last_error: null,
  }));
  const posSales = {
    edge: {
      sales: [
        sale(A, '150000', '200000', '50000', 'paid'),
        sale(B, '100000', null, null, 'cancelled'),
      ],
      tenders,
      refunds,
      receipts,
      reports: [{ shift_id: S, terminal_id: T, report: z, terminal_reported_minor: '0' }],
      events,
    },
    cloud: {
      sales: [
        { ...sale(A, '150000', '200000', '50000', 'paid'), device_id: id(69) },
        { ...sale(B, '100000', null, null, 'voided'), device_id: id(69) },
      ],
      tenders: tenders.map((t) => ({ ...t })),
      refunds: refunds.map((r) => ({ ...r })),
      receipts: receipts.map((r) => ({ ...r })),
      reports: [
        {
          shift_id: S,
          terminal_id: T,
          device_id: id(69),
          // jsonb comes back with its own key order: the comparison must not care.
          report: Object.fromEntries(Object.entries(z).reverse()),
          expected_cash_minor: '150000',
          counted_cash_minor: '150000',
          discrepancy_minor: '0',
          terminal_reported_minor: '0',
        },
      ],
      inbox: events.map((e) => ({
        event_id: e.event_id,
        kind: e.kind,
        sequence: e.sequence,
        device_id: id(69),
      })),
      acceptedRestoredZ: [],
    },
  };
  const ledger = {
    posSales: new Map([
      [
        A,
        {
          orderId: A,
          total: '150000',
          voided: false,
          tenders: [{ tenderId: tA, method: 'cash', amount: '150000' }],
          refunds: [],
        },
      ],
      [
        B,
        {
          orderId: B,
          total: '100000',
          voided: true,
          tenders: [{ tenderId: tB, method: 'kaspi_terminal', amount: '100000' }],
          refunds: [],
        },
      ],
    ]),
    salesShifts: [{ shiftId: S, desk: 1, z: { ...z } }],
  };
  const data = { edge: { posSales: posSales.edge }, cloud: { posSales: posSales.cloud } };
  return { data, ledger, ids: { A, B, S, T, tA, tB, rB } };
}
const PAID_CHECKS = [
  'paid_sales_in_cloud',
  'paid_tenders_in_cloud',
  'paid_refunds_in_cloud',
  'paid_receipts_in_cloud',
  'paid_z_in_cloud',
  'paid_events_once',
  'paid_cashier_told',
];

test('paid day: a consistent edge and cloud pass every posSales check; an unpaid run gets none', () => {
  const { data, ledger } = paidWorld();
  const results = evaluatePosSales(data, ledger);
  assert.deepEqual(
    results.map((r) => r.id),
    PAID_CHECKS,
  );
  assert.deepEqual(failed(results), []);
  assert.ok(results.every((r) => /[а-я]/i.test(r.title)));
  // An unpaid run: no posSales rows (or no posSales keys at all, as before) - no paid checks.
  const unpaid = world();
  const before = evaluate(unpaid.data, unpaid.ledger, { pending }).map((r) => r.id);
  assert.ok(before.every((check) => !check.startsWith('paid_')));
  const empty = paidWorld().data;
  for (const side of [empty.edge.posSales, empty.cloud.posSales])
    for (const key of Object.keys(side)) if (Array.isArray(side[key])) side[key] = [];
  Object.assign(unpaid.data.edge, { posSales: empty.edge.posSales });
  Object.assign(unpaid.data.cloud, { posSales: empty.cloud.posSales });
  assert.equal(paidDay(unpaid.data), false);
  assert.deepEqual(
    evaluate(unpaid.data, unpaid.ledger, { pending }).map((r) => r.id),
    before,
  );
  assert.equal(volumes(unpaid.data).paid_sales, undefined);
  // With a paid day the same evaluate adds them, after every unpaid check.
  const both = world();
  Object.assign(both.data.edge, { posSales: data.edge.posSales });
  Object.assign(both.data.cloud, { posSales: data.cloud.posSales });
  const ids = evaluate(both.data, both.ledger, { pending }).map((r) => r.id);
  assert.deepEqual(ids.slice(0, before.length), before);
  assert.deepEqual(ids.slice(before.length), PAID_CHECKS);
  assert.deepEqual(volumes(both.data).paid_sales, 2);
});

test('paid day: a missing, extra or changed sale, tender, refund or receipt in the cloud fails its check', () => {
  const fails = (mutate) => {
    const w = paidWorld();
    mutate(w.data.cloud.posSales, w.ids);
    return failed(evaluatePosSales(w.data, w.ledger));
  };
  assert.ok(fails((c) => c.sales.pop()).includes('paid_sales_in_cloud'));
  assert.ok(fails((c) => (c.sales[1].state = 'paid')).includes('paid_sales_in_cloud'));
  assert.ok(fails((c) => (c.sales[0].change_minor = '49999')).includes('paid_sales_in_cloud'));
  assert.ok(
    fails((c) => c.sales.push({ ...c.sales[0], order_id: id(90) })).includes('paid_sales_in_cloud'),
  );
  // One tiyn more on a tender.
  assert.ok(fails((c) => (c.tenders[0].amount_minor = '150001')).includes('paid_tenders_in_cloud'));
  assert.ok(fails((c) => c.tenders.pop()).includes('paid_tenders_in_cloud'));
  assert.ok(fails((c) => c.refunds.pop()).includes('paid_refunds_in_cloud'));
  assert.ok(
    fails((c) => (c.refunds[0].parts = [[c.refunds[0].parts[0][0], 'cash', '100000']])).includes(
      'paid_refunds_in_cloud',
    ),
  );
  assert.ok(
    fails((c) => (c.receipts[0].receipt_number = 'SYN-2')).includes('paid_receipts_in_cloud'),
  );
  assert.ok(fails((c) => (c.receipts[0].version = 1)).includes('paid_receipts_in_cloud'));
});

test('paid day: a Z that differs from the edge, from its money rows or is missing in the cloud fails', () => {
  const run = (mutate) => {
    const w = paidWorld();
    mutate(w);
    return failed(evaluatePosSales(w.data, w.ledger));
  };
  assert.ok(run((w) => w.data.cloud.posSales.reports.pop()).includes('paid_z_in_cloud'));
  assert.ok(
    run((w) => (w.data.cloud.posSales.reports[0].counted_cash_minor = '150001')).includes(
      'paid_z_in_cloud',
    ),
  );
  assert.ok(
    run(
      (w) =>
        (w.data.cloud.posSales.reports[0].report = {
          ...w.data.cloud.posSales.reports[0].report,
          cash_sales_minor: '150001',
        }),
    ).includes('paid_z_in_cloud'),
  );
  // The edge's own Z against its own rows (a Kaspi refund the Z does not count).
  assert.ok(
    run((w) => {
      w.data.edge.posSales.tenders[1].amount_minor = '100100';
      w.data.cloud.posSales.tenders[1].amount_minor = '100100';
    }).includes('paid_z_in_cloud'),
  );
  // A method with money must have its own Z row.
  const report = paidWorld().data.edge.posSales.reports[0].report;
  const totals = new Map([
    ['cash', { sales: 150000n, refunds: 0n, count: 1 }],
    ['kaspi_terminal', { sales: 100000n, refunds: 100000n, count: 1 }],
    ['chocofood', { sales: 1n, refunds: 0n, count: 1 }],
  ]);
  assert.deepEqual(zMismatch(report, totals), [{ what: 'chocofood.missing' }]);
});

test('paid day: an event parked, pending, missing or received twice fails; what the cashier was told must be on the edge', () => {
  const run = (mutate) => {
    const w = paidWorld();
    mutate(w);
    return failed(evaluatePosSales(w.data, w.ledger));
  };
  assert.ok(
    run(
      (w) =>
        (w.data.edge.posSales.events[5] = {
          ...w.data.edge.posSales.events[5],
          acknowledged: false,
          last_error: 'rejected:INVALID_EVENT',
        }),
    ).includes('paid_events_once'),
  );
  assert.ok(
    run((w) => (w.data.edge.posSales.events[0].acknowledged = false)).includes('paid_events_once'),
  );
  assert.ok(run((w) => w.data.cloud.posSales.inbox.pop()).includes('paid_events_once'));
  assert.ok(
    run((w) => w.data.cloud.posSales.inbox.push({ ...w.data.cloud.posSales.inbox[0] })).includes(
      'paid_events_once',
    ),
  );
  // A cloud event the edge never had (only a restore drill's lost timeline may have one).
  assert.ok(
    run((w) =>
      w.data.cloud.posSales.inbox.push({
        event_id: id(99),
        kind: 'sale',
        sequence: '9',
        device_id: id(69),
      }),
    ).includes('paid_events_once'),
  );
  assert.ok(
    run((w) => (w.ledger.posSales.get(w.ids.A).total = '150100')).includes('paid_cashier_told'),
  );
  assert.ok(
    run((w) => (w.ledger.posSales.get(w.ids.B).voided = false)).includes('paid_cashier_told'),
  );
  assert.ok(
    run((w) =>
      w.ledger.posSales.get(w.ids.A).refunds.push({ refundId: id(91), amount: '1000' }),
    ).includes('paid_cashier_told'),
  );
  assert.ok(
    run(
      (w) =>
        (w.ledger.salesShifts[0].z = { ...w.ledger.salesShifts[0].z, expected_cash_minor: '1' }),
    ).includes('paid_cashier_told'),
  );
});

test('paid day after a restore: the cloud may hold more than the Z only for a Z its owner accepted, and only lost-timeline sales may be cloud-only', () => {
  // The cloud has sale L of the lost timeline in the same shift; the restored edge never had it.
  const lostWorld = () => {
    const w = paidWorld();
    const L = id(80);
    const c = w.data.cloud.posSales;
    c.sales.push({
      ...c.sales[0],
      order_id: L,
      total_minor: '50000',
      cash_tendered_minor: '50000',
      change_minor: '0',
    });
    c.tenders.push({ ...c.tenders[0], tender_id: id(81), order_id: L, amount_minor: '50000' });
    c.inbox.push({ event_id: id(82), kind: 'sale', sequence: '1000000001', device_id: id(69) });
    return { ...w, L };
  };
  const plain = lostWorld();
  assert.deepEqual(
    failed(evaluatePosSales(plain.data, plain.ledger)).sort(),
    ['paid_events_once', 'paid_sales_in_cloud', 'paid_tenders_in_cloud', 'paid_z_in_cloud'].sort(),
  );
  // Declared lost but the Z not accepted by the owner: the Z still fails against the cloud rows.
  const declared = lostWorld();
  assert.deepEqual(
    failed(evaluatePosSales(declared.data, declared.ledger, { lostPosOrders: [declared.L] })),
    ['paid_z_in_cloud'],
  );
  const accepted = lostWorld();
  accepted.data.cloud.posSales.acceptedRestoredZ = [accepted.ids.S];
  assert.deepEqual(
    failed(evaluatePosSales(accepted.data, accepted.ledger, { lostPosOrders: [accepted.L] })),
    [],
  );
  // Accepted, but the Z claims more than the cloud holds: never allowed.
  const more = lostWorld();
  more.data.cloud.posSales.acceptedRestoredZ = [more.ids.S];
  more.data.cloud.posSales.reports[0].report = {
    ...more.data.cloud.posSales.reports[0].report,
    cash_sales_minor: '999999',
  };
  more.data.edge.posSales.reports[0].report = { ...more.data.cloud.posSales.reports[0].report };
  assert.ok(
    failed(evaluatePosSales(more.data, more.ledger, { lostPosOrders: [more.L] })).includes(
      'paid_z_in_cloud',
    ),
  );
});

test('what a restore lost stays excluded in the scenarios that follow it', () => {
  const restore = {
    lostPosOrders: ['a'],
    lostChannelOrders: ['c'],
    reviewedRestores: [{ orderId: 'r' }],
  };
  const afterRestore = mergeVerifyContext({}, restore);
  assert.deepEqual(afterRestore, restore);
  // paid_day returns no context: the restore's lists are still passed to the comparison.
  assert.deepEqual(mergeVerifyContext(afterRestore, undefined), restore);
  assert.deepEqual(mergeVerifyContext(afterRestore, { lostPosOrders: ['b'] }).lostPosOrders, [
    'a',
    'b',
  ]);
  assert.deepEqual(restore.lostPosOrders, ['a']);
});
