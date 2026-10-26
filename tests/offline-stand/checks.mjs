/**
 * Offline stand invariants. `snapshot` reads both ledgers (edge and cloud); `evaluate` is pure
 * and compares them with what the actors were told (Restaurant.ledger). Every check has a Russian
 * title for the staff/owner report and machine-readable expected/actual values.
 */
import { effectiveLocalStops } from '@pickchick/menu-sync';

const num = (v) => Number(v ?? 0);
const LIVE = ['held', 'accepted', 'in_production', 'ready', 'cancel_requested'];
const rows = async (pool, sql, args) => (await pool.query(sql, args)).rows;

/** Everything that must be drained before the two ledgers can be compared. */
export async function pendingWork(stand) {
  const b = [stand.ids.branch];
  const [edge] = await rows(
    stand.edge,
    `SELECT
      (SELECT count(*) FROM outbox_events WHERE branch_id=$1 AND aggregate_type='order_commercial' AND acknowledged_at IS NULL) pos_events,
      (SELECT count(*) FROM fulfillment_outbox WHERE branch_id=$1 AND acknowledged_at IS NULL) kitchen_events,
      (SELECT count(*) FROM cashier_report_outbox WHERE branch_id=$1 AND acknowledged_at IS NULL) cashier_reports,
      (SELECT count(*) FROM fulfillment_transport_state WHERE branch_id=$1 AND pending_cloud IS NOT NULL) transport_pending,
      (SELECT count(*) FROM pos_kitchen_sync_state WHERE branch_id=$1 AND dead_lettered_at IS NOT NULL) kitchen_dead_letter,
      (SELECT count(*) FROM fulfillment_transport_failures WHERE branch_id=$1 AND resolved_at IS NULL) transport_failures,
      (SELECT count(*) FROM remote_stop_commands WHERE branch_id=$1 AND state<>'received' AND reported_at IS NULL) stop_receipts`,
    b,
  );
  const [cloud] = await rows(
    stand.cloud,
    `SELECT
      (SELECT count(*) FROM commerce_outbox e JOIN commerce_orders o ON o.id=e.order_id WHERE o.branch_id=$1
        AND e.event_type IN ('edge.admission_requested','edge.kitchen_admission_requested','edge.admission_release_requested')
        AND e.acknowledged_at IS NULL AND NOT o.attention_required) admission_commands,
      (SELECT count(*) FROM cloud_stop_commands WHERE branch_id=$1 AND state IN ('pending','delivered')) stop_commands`,
    b,
  );
  const result = {};
  for (const [key, value] of Object.entries({ ...edge, ...cloud })) result[key] = num(value);
  return result;
}
export const drained = (pending) => Object.values(pending).every((v) => v === 0);

const ADMISSION_TYPES = `('edge.admission_requested','edge.kitchen_admission_requested','edge.admission_release_requested')`;
/** The backlog at one moment (for example at reconnect): newest unacknowledged positions. */
export async function backlogMark(stand) {
  const b = [stand.ids.branch];
  const [edge] = await rows(
    stand.edge,
    `SELECT
      (SELECT max(producer_sequence)::text FROM outbox_events WHERE branch_id=$1 AND aggregate_type='order_commercial' AND acknowledged_at IS NULL) pos,
      (SELECT max(sequence)::text FROM fulfillment_outbox WHERE branch_id=$1 AND acknowledged_at IS NULL) kitchen,
      (SELECT max(sequence)::text FROM cashier_report_outbox WHERE branch_id=$1 AND acknowledged_at IS NULL) cashier`,
    b,
  );
  const commands = (
    await rows(
      stand.cloud,
      `SELECT e.id FROM commerce_outbox e JOIN commerce_orders o ON o.id=e.order_id WHERE o.branch_id=$1
      AND e.event_type IN ${ADMISSION_TYPES} AND e.acknowledged_at IS NULL AND NOT o.attention_required`,
      b,
    )
  ).map((r) => r.id);
  return { ...edge, commands };
}
/** True once everything in the mark is delivered, even while new traffic keeps arriving. */
export async function backlogDelivered(stand, mark) {
  const b = [stand.ids.branch, mark.pos ?? '0', mark.kitchen ?? '0', mark.cashier ?? '0'];
  const [left] = await rows(
    stand.edge,
    `SELECT
      (SELECT count(*) FROM outbox_events WHERE branch_id=$1 AND aggregate_type='order_commercial' AND acknowledged_at IS NULL AND producer_sequence<=$2::bigint)
      + (SELECT count(*) FROM fulfillment_outbox WHERE branch_id=$1 AND acknowledged_at IS NULL AND sequence<=$3::bigint)
      + (SELECT count(*) FROM cashier_report_outbox WHERE branch_id=$1 AND acknowledged_at IS NULL AND sequence<=$4::bigint) n`,
    b,
  );
  if (num(left.n) > 0) return false;
  if (!mark.commands.length) return true;
  const [open] = await rows(
    stand.cloud,
    `SELECT count(*) n FROM commerce_outbox e JOIN commerce_orders o ON o.id=e.order_id
    WHERE e.id=ANY($1::uuid[]) AND e.acknowledged_at IS NULL AND NOT o.attention_required`,
    [mark.commands],
  );
  return num(open.n) === 0;
}
/** The cloud's stop list for kiosk/mobile equals the cashier's effective stops. */
export async function stopsConverged(stand) {
  const cloud = [
    ...((
      await rows(
        stand.cloud,
        'SELECT stopped_ids FROM cloud_branch_availability WHERE branch_id=$1',
        [stand.ids.branch],
      )
    )[0]?.stopped_ids ?? []),
  ].sort();
  const edge = [...(await effectiveLocalStops(stand.edge, stand.ids.branch))].sort();
  return JSON.stringify(cloud) === JSON.stringify(edge);
}

export async function snapshot(stand) {
  const b = [stand.ids.branch];
  const e = stand.edge,
    c = stand.cloud;
  const commerce = await import('../../packages/commerce-core/dist/index.js');
  return {
    edge: {
      orders: await rows(
        e,
        'SELECT id,total_minor::text,state,version FROM local_orders WHERE branch_id=$1',
        b,
      ),
      posEvents: (
        await rows(
          e,
          `SELECT count(*)::int total,count(DISTINCT (aggregate_id,aggregate_version))::int distinct_versions
          FROM outbox_events WHERE branch_id=$1 AND aggregate_type='order_commercial'`,
          b,
        )
      )[0],
      reservations: await rows(
        e,
        `SELECT order_id,commercial_owner,state,version,display_number::text,business_day::text
        FROM fulfillment_reservations WHERE branch_id=$1`,
        b,
      ),
      taskDuplicates: await rows(
        e,
        `SELECT order_id,component_key,count(*)::int n FROM fulfillment_tasks WHERE branch_id=$1
        GROUP BY 1,2 HAVING count(*)>1`,
        b,
      ),
      taskCounts: await rows(
        e,
        'SELECT order_id,count(*)::int n FROM fulfillment_tasks WHERE branch_id=$1 GROUP BY 1',
        b,
      ),
      kitchenEvents: (
        await rows(
          e,
          `SELECT count(*) FILTER (WHERE payload->>'commercialOwner'='edge_pos')::int pos,
          count(*) FILTER (WHERE payload->>'commercialOwner' IS DISTINCT FROM 'edge_pos')::int cloud
          FROM fulfillment_outbox WHERE branch_id=$1`,
          b,
        )
      )[0],
      inbox: await rows(
        e,
        'SELECT event_type,count(*)::int n FROM fulfillment_inbox WHERE branch_id=$1 GROUP BY 1',
        b,
      ),
      cashierReports: await rows(
        e,
        'SELECT kind,count(*)::int n FROM cashier_report_outbox WHERE branch_id=$1 GROUP BY 1',
        b,
      ),
      shifts: await rows(e, 'SELECT id,state FROM local_cash_shifts WHERE branch_id=$1', b),
      remoteStops: await rows(
        e,
        'SELECT command_id,state FROM remote_stop_commands WHERE branch_id=$1',
        b,
      ),
      stops: [...(await effectiveLocalStops(e, stand.ids.branch))].sort(),
      activeRelease: (await rows(e, 'SELECT release_id FROM active_menu WHERE branch_id=$1', b))[0]
        ?.release_id,
    },
    cloud: {
      posOrders: await rows(
        c,
        'SELECT order_id,total_minor::text,state,version FROM pos_order_sync_projection WHERE branch_id=$1',
        b,
      ),
      posInbox: (
        await rows(
          c,
          `SELECT count(*)::int total,count(DISTINCT (order_id,aggregate_version))::int distinct_versions
          FROM pos_order_sync_inbox WHERE branch_id=$1`,
          b,
        )
      )[0],
      posKitchen: await rows(
        c,
        'SELECT order_id,state,version FROM pos_kitchen_sync_projection WHERE branch_id=$1',
        b,
      ),
      posKitchenInbox: (
        await rows(
          c,
          `SELECT count(*)::int total,count(DISTINCT (order_id,aggregate_version))::int distinct_versions
          FROM pos_kitchen_sync_inbox WHERE branch_id=$1`,
          b,
        )
      )[0],
      projection: await rows(
        c,
        `SELECT order_id,state,version,display_number::text FROM cloud_fulfillment_projection WHERE branch_id=$1`,
        b,
      ),
      cloudFacts: (
        await rows(
          c,
          `SELECT count(*)::int total,count(DISTINCT event_id)::int distinct_events
          FROM cloud_fulfillment_inbox WHERE branch_id=$1`,
          b,
        )
      )[0],
      orders: await rows(
        c,
        `SELECT o.id,o.snapshot->>'channel' channel,o.total_minor::text,o.attention_required,o.state,
          o.kitchen_effect_id IS NOT NULL kitchen_effect,
          (SELECT count(*)::int FROM commerce_captures x WHERE x.order_id=o.id) captures,
          (SELECT coalesce(sum(amount_minor),0)::text FROM commerce_captures x WHERE x.order_id=o.id) captured,
          (SELECT count(*)::int FROM commerce_refunds r WHERE r.order_id=o.id) refunds
        FROM commerce_orders o WHERE o.branch_id=$1`,
        b,
      ),
      accruals: await rows(
        c,
        'SELECT a.order_id,a.units FROM combo_reward_accruals a JOIN commerce_orders o ON o.id=a.order_id WHERE o.branch_id=$1',
        b,
      ),
      cashierOrders: await rows(c, 'SELECT id FROM cloud_cashier_orders WHERE branch_id=$1', b),
      cashierShifts: await rows(c, 'SELECT id FROM cloud_cashier_shifts WHERE branch_id=$1', b),
      stopCommands: await rows(c, 'SELECT id,state FROM cloud_stop_commands WHERE branch_id=$1', b),
      availability: await commerce.branchAvailability(c, stand.ids.branch),
      availabilityStops: (
        await rows(c, 'SELECT stopped_ids FROM cloud_branch_availability WHERE branch_id=$1', b)
      )[0]?.stopped_ids,
      activation: (
        await rows(
          c,
          'SELECT release_id,acknowledged_at IS NOT NULL acknowledged FROM branch_menu_activations WHERE branch_id=$1',
          b,
        )
      )[0],
    },
  };
}

function check(id, title, ok, expected, actual, details) {
  return { id, title, ok: Boolean(ok), expected, actual, ...(details ? { details } : {}) };
}
const sample = (list, n = 5) => list.slice(0, n);

/**
 * Kiosk and app orders the restored cashier no longer knows: the cloud projection has them (the
 * cashier admitted them after the backup), the restored reservations do not. Every state counts:
 * an order admitted and handed over (or cancelled) on the lost timeline is lost by the restore as
 * much as one still cooking (QA 25.10: only live states were listed, so a handed-over one failed
 * `channel_orders_admitted_once` as "paid, not admitted"). `live` ones still wait in the cloud's
 * kitchen view and need the manual check of edge-restore.md.
 */
export function channelOrdersLostByRestore(projection, restoredOrderIds) {
  const lost = projection.filter((p) => !restoredOrderIds.has(p.order_id));
  const states = {};
  for (const p of lost) states[p.state] = (states[p.state] ?? 0) + 1;
  return {
    lost: lost.map((p) => p.order_id),
    live: lost.filter((p) => LIVE.includes(p.state)).map((p) => p.order_id),
    states,
  };
}

/**
 * Pure comparison. `ledger` is what the actors were told; `context.lostPosOrders` lists POS
 * orders the edge lost in a restore drill (kept in the cloud as the lost timeline);
 * `context.pending` is pendingWork() after convergence.
 */
export function evaluate(data, ledger, context = {}) {
  const results = [];
  const lost = new Set(context.lostPosOrders ?? []);
  const lostKitchen = new Set(context.lostKitchenOrders ?? context.lostPosOrders ?? []);
  const edgeOrders = new Map(data.edge.orders.map((o) => [o.id, o]));
  const told = [...ledger.pos.values()];
  // 1-2. POS: every acknowledged sale is on the edge exactly once; retries made no extras.
  const missing = told.filter((o) => !edgeOrders.has(o.orderId) && !lost.has(o.orderId));
  results.push(
    check(
      'pos_no_lost_orders',
      'Каждый заказ, который касса подтвердила, сохранён на кассовом узле',
      missing.length === 0,
      0,
      missing.length,
      missing.length ? { missing: sample(missing.map((o) => o.orderId)) } : undefined,
    ),
  );
  const unknown = data.edge.orders.filter((o) => !ledger.pos.has(o.id));
  results.push(
    check(
      'pos_no_duplicate_orders',
      'Повторы запросов кассы не создали лишних заказов',
      unknown.length === 0 && data.edge.orders.length === told.length - lost.size,
      told.length - lost.size,
      data.edge.orders.length,
      unknown.length ? { unknown: sample(unknown.map((o) => o.id)) } : undefined,
    ),
  );
  const wrongTotals = told.filter(
    (o) => edgeOrders.has(o.orderId) && edgeOrders.get(o.orderId).total_minor !== o.total,
  );
  results.push(
    check(
      'pos_totals',
      'Суммы заказов кассы совпадают с подтверждёнными кассиру',
      wrongTotals.length === 0,
      0,
      wrongTotals.length,
    ),
  );
  // 3-4. POS orders in the cloud: same set, totals and states; each event once.
  const cloudPos = new Map(data.cloud.posOrders.map((o) => [o.order_id, o]));
  const posDiff = [];
  for (const o of data.edge.orders) {
    const remote = cloudPos.get(o.id);
    const expectedState = o.state === 'cancelled' ? 'cancelled' : 'awaiting_payment';
    if (!remote || remote.total_minor !== o.total_minor || remote.state !== expectedState)
      posDiff.push({ order: o.id, edge: o.state, cloud: remote?.state ?? null });
  }
  const extraCloud = data.cloud.posOrders.filter(
    (o) => !edgeOrders.has(o.order_id) && !lost.has(o.order_id),
  );
  results.push(
    check(
      'pos_orders_in_cloud',
      'Облако видит те же заказы кассы с теми же суммами и статусами',
      posDiff.length === 0 && extraCloud.length === 0,
      data.edge.orders.length,
      data.cloud.posOrders.length,
      posDiff.length || extraCloud.length
        ? { different: sample(posDiff), extra: sample(extraCloud.map((o) => o.order_id)) }
        : undefined,
    ),
  );
  results.push(
    check(
      'pos_events_once',
      'Каждое событие заказа кассы принято облаком ровно один раз',
      data.cloud.posInbox.total === data.cloud.posInbox.distinct_versions &&
        data.edge.posEvents.total === data.edge.posEvents.distinct_versions &&
        data.cloud.posInbox.total >= data.edge.posEvents.total,
      data.edge.posEvents.total,
      data.cloud.posInbox.total,
    ),
  );
  // 5. POS kitchen progress observed in the cloud equals the edge.
  const reservations = new Map(data.edge.reservations.map((r) => [r.order_id, r]));
  const posReservations = data.edge.reservations.filter((r) => r.commercial_owner === 'edge_pos');
  const posKitchen = new Map(data.cloud.posKitchen.map((r) => [r.order_id, r]));
  const kitchenDiff = posReservations
    .filter((r) => {
      const remote = posKitchen.get(r.order_id);
      return !remote || remote.state !== r.state || remote.version !== r.version;
    })
    .map((r) => ({
      order: r.order_id,
      edge: `${r.state}/${r.version}`,
      cloud: posKitchen.has(r.order_id)
        ? `${posKitchen.get(r.order_id).state}/${posKitchen.get(r.order_id).version}`
        : null,
    }));
  const extraKitchen = data.cloud.posKitchen.filter(
    (r) => !reservations.has(r.order_id) && !lostKitchen.has(r.order_id),
  );
  results.push(
    check(
      'pos_kitchen_in_cloud',
      'Статусы кухни по заказам кассы в облаке совпадают с кассовым узлом',
      kitchenDiff.length === 0 && extraKitchen.length === 0,
      posReservations.length,
      data.cloud.posKitchen.length,
      kitchenDiff.length || extraKitchen.length
        ? { different: sample(kitchenDiff), extra: sample(extraKitchen.map((r) => r.order_id)) }
        : undefined,
    ),
  );
  results.push(
    check(
      'pos_kitchen_events_once',
      'Каждое кухонное событие кассы принято облаком ровно один раз',
      data.cloud.posKitchenInbox.total === data.cloud.posKitchenInbox.distinct_versions &&
        data.cloud.posKitchenInbox.total >= data.edge.kitchenEvents.pos,
      data.edge.kitchenEvents.pos,
      data.cloud.posKitchenInbox.total,
    ),
  );
  // 6-8. Kiosk and mobile orders: one kitchen admission, one payment, matching projection.
  const cloudOrders = new Map(data.cloud.orders.map((o) => [o.id, o]));
  const projection = new Map(data.cloud.projection.map((p) => [p.order_id, p]));
  const channelOrders = [...ledger.mobile.values(), ...ledger.kiosk.values()];
  const admissionProblems = [];
  const lostChannel = new Set(context.lostChannelOrders ?? []);
  for (const entry of channelOrders) {
    // Admitted on the lost timeline of a restore drill: reported by that scenario.
    if (lostChannel.has(entry.orderId)) continue;
    const order = cloudOrders.get(entry.orderId),
      edge = reservations.get(entry.orderId),
      remote = projection.get(entry.orderId);
    if (!order) {
      admissionProblems.push({ order: entry.orderId, problem: 'missing_in_cloud' });
      continue;
    }
    if (order.attention_required) {
      // Manager case: no kitchen work may exist for it.
      if (edge && !['held', 'released', 'cancelled'].includes(edge.state))
        admissionProblems.push({ order: entry.orderId, problem: 'review_but_cooking' });
      continue;
    }
    if (!entry.paid) continue;
    if (!edge || !['accepted', 'in_production', 'ready', 'handed_over'].includes(edge.state))
      admissionProblems.push({
        order: entry.orderId,
        problem: 'paid_not_admitted',
        edge: edge?.state ?? null,
      });
    else if (!remote || remote.state !== edge.state || remote.version !== edge.version)
      admissionProblems.push({
        order: entry.orderId,
        problem: 'projection_differs',
        edge: `${edge.state}/${edge.version}`,
        cloud: remote ? `${remote.state}/${remote.version}` : null,
      });
  }
  results.push(
    check(
      'channel_orders_admitted_once',
      'Оплаченные заказы киоска и приложения приняты кухней ровно один раз или ждут решения менеджера',
      admissionProblems.length === 0,
      0,
      admissionProblems.length,
      admissionProblems.length ? { problems: sample(admissionProblems, 10) } : undefined,
    ),
  );
  const projectionDiff = data.edge.reservations
    .filter((r) => r.commercial_owner === 'cloud')
    .filter((r) => {
      const p = projection.get(r.order_id);
      return (
        !p ||
        p.state !== r.state ||
        p.version !== r.version ||
        p.display_number !== r.display_number
      );
    });
  results.push(
    check(
      'channel_projection_matches',
      'Облачная проекция заказов киоска и приложения совпадает с кухней кассы',
      projectionDiff.length === 0,
      0,
      projectionDiff.length,
      projectionDiff.length ? { orders: sample(projectionDiff.map((r) => r.order_id)) } : undefined,
    ),
  );
  const paymentProblems = [];
  for (const entry of channelOrders) {
    const order = cloudOrders.get(entry.orderId);
    if (!order) continue;
    if (order.refunds) paymentProblems.push({ order: order.id, problem: 'refund_created' });
    if (entry.paid && (order.captures !== 1 || order.captured !== order.total_minor))
      paymentProblems.push({
        order: order.id,
        problem: 'capture',
        captures: order.captures,
        captured: order.captured,
        total: order.total_minor,
      });
    if (!entry.paid && order.captures)
      paymentProblems.push({ order: order.id, problem: 'unexpected_capture' });
  }
  results.push(
    check(
      'payments_once',
      'Каждая оплата учтена ровно один раз, автоматических возвратов нет',
      paymentProblems.length === 0,
      0,
      paymentProblems.length,
      paymentProblems.length ? { problems: sample(paymentProblems, 10) } : undefined,
    ),
  );
  const accruals = new Map();
  for (const a of data.cloud.accruals)
    accruals.set(a.order_id, (accruals.get(a.order_id) ?? 0) + a.units);
  const stampProblems = [];
  let expectedStamps = 0,
    actualStamps = 0;
  for (const entry of ledger.mobile.values()) {
    const units = accruals.get(entry.orderId) ?? 0;
    actualStamps += units;
    const want = entry.paid && !cloudOrders.get(entry.orderId)?.refunds ? entry.comboUnits : 0;
    expectedStamps += want;
    if (units !== want) stampProblems.push({ order: entry.orderId, expected: want, actual: units });
  }
  results.push(
    check(
      'stamps_once',
      'Отметки комбо начислены один раз за каждую оплаченную покупку',
      stampProblems.length === 0 && data.cloud.accruals.length <= ledger.mobile.size,
      expectedStamps,
      actualStamps,
      stampProblems.length ? { problems: sample(stampProblems) } : undefined,
    ),
  );
  // 9. Kitchen tickets: one set of tasks per order; two live orders never share a display
  // number (edge022 restarts numbers at every opened shift, so only live orders are unique).
  const numbers = new Map();
  for (const r of data.edge.reservations) {
    if (!r.display_number || !LIVE.includes(r.state)) continue;
    numbers.set(r.display_number, (numbers.get(r.display_number) ?? 0) + 1);
  }
  const reusedNumbers = [...numbers.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  const admittedWithoutTasks = data.edge.reservations.filter(
    (r) =>
      ['accepted', 'in_production', 'ready', 'handed_over'].includes(r.state) &&
      !data.edge.taskCounts.some((t) => t.order_id === r.order_id && t.n > 0),
  );
  results.push(
    check(
      'kitchen_tickets_once',
      'Кухонные задания созданы один раз на заказ, у живых заказов разные номера выдачи',
      data.edge.taskDuplicates.length === 0 &&
        reusedNumbers.length === 0 &&
        admittedWithoutTasks.length === 0,
      0,
      data.edge.taskDuplicates.length + reusedNumbers.length + admittedWithoutTasks.length,
      data.edge.taskDuplicates.length || reusedNumbers.length || admittedWithoutTasks.length
        ? {
            duplicateTasks: sample(data.edge.taskDuplicates),
            reusedNumbers: sample(reusedNumbers),
            withoutTasks: sample(admittedWithoutTasks.map((r) => r.order_id)),
          }
        : undefined,
    ),
  );
  // 10. Shift reports reach the cabinet.
  const closed = data.edge.shifts.filter((s) => s.state === 'closed').map((s) => s.id);
  const cloudShifts = new Set(data.cloud.cashierShifts.map((s) => s.id));
  const missingShifts = closed.filter((id) => !cloudShifts.has(id));
  const cashierOrders = new Set(data.cloud.cashierOrders.map((o) => o.id));
  const missingCashierOrders = data.edge.orders.filter((o) => !cashierOrders.has(o.id));
  results.push(
    check(
      'cashier_reports_delivered',
      'Отчёты смен и заказов кассы дошли до кабинета',
      missingShifts.length === 0 && missingCashierOrders.length === 0,
      { shifts: closed.length, orders: data.edge.orders.length },
      {
        shifts: closed.length - missingShifts.length,
        orders: data.edge.orders.length - missingCashierOrders.length,
      },
      missingShifts.length || missingCashierOrders.length
        ? { shifts: sample(missingShifts), orders: sample(missingCashierOrders.map((o) => o.id)) }
        : undefined,
    ),
  );
  // 11. Queues drained, availability and stops converged, menu confirmed.
  if (context.pending)
    results.push(
      check(
        'queues_drained',
        'Очереди касса <-> облако пусты, тупиковых сообщений нет',
        drained(context.pending),
        0,
        Object.values(context.pending).reduce((a, b) => a + b, 0),
        drained(context.pending) ? undefined : { pending: context.pending },
      ),
    );
  const cloudStops = [...(data.cloud.availabilityStops ?? [])].sort();
  results.push(
    check(
      'availability_converged',
      'Облако снова видит кассу на связи и тот же стоп-лист',
      data.cloud.availability.fresh === true &&
        JSON.stringify(cloudStops) === JSON.stringify(data.edge.stops),
      { fresh: true, stops: data.edge.stops.length },
      { fresh: data.cloud.availability.fresh, stops: cloudStops.length },
    ),
  );
  const edgeCommands = new Map(data.edge.remoteStops.map((r) => [r.command_id, r.state]));
  const stopProblems = data.cloud.stopCommands
    .filter((command) => {
      const local = edgeCommands.get(command.id);
      if (['pending', 'delivered'].includes(command.state)) return true;
      if (command.state === 'applied') return local !== 'applied';
      // Expired in the cloud: the edge may not have applied it late.
      if (command.state === 'expired') return local === 'applied';
      return false;
    })
    .map((command) => ({
      command: command.id,
      cloud: command.state,
      edge: edgeCommands.get(command.id) ?? null,
    }));
  results.push(
    check(
      'remote_stops_resolved',
      'Команды стопа из кабинета применены один раз или честно истекли',
      stopProblems.length === 0,
      0,
      stopProblems.length,
      stopProblems.length ? { problems: sample(stopProblems) } : undefined,
    ),
  );
  results.push(
    check(
      'menu_converged',
      'Касса работает на опубликованном меню, облако получило подтверждение',
      Boolean(data.cloud.activation?.acknowledged) &&
        data.cloud.activation?.release_id === data.edge.activeRelease,
      data.cloud.activation?.release_id ?? null,
      data.edge.activeRelease ?? null,
    ),
  );
  return results;
}

/** Totals for the report: how much moved through each stream. */
export function volumes(data) {
  return {
    pos_orders: data.edge.orders.length,
    pos_cancelled: data.edge.orders.filter((o) => o.state === 'cancelled').length,
    pos_events: data.edge.posEvents.total,
    kitchen_events_pos: data.edge.kitchenEvents.pos,
    kitchen_events_channel: data.edge.kitchenEvents.cloud,
    cloud_commands_applied: data.edge.inbox.reduce((n, r) => n + r.n, 0),
    channel_orders: data.cloud.orders.length,
    channel_orders_review: data.cloud.orders.filter((o) => o.attention_required).length,
    handed_over: data.edge.reservations.filter((r) => r.state === 'handed_over').length,
    cashier_report_events: data.edge.cashierReports.reduce((n, r) => n + r.n, 0),
    stamps: data.cloud.accruals.reduce((n, a) => n + a.units, 0),
    remote_stop_commands: data.cloud.stopCommands.length,
    total_sync_events:
      data.edge.posEvents.total +
      data.edge.kitchenEvents.pos +
      data.edge.kitchenEvents.cloud +
      data.edge.inbox.reduce((n, r) => n + r.n, 0) +
      data.edge.cashierReports.reduce((n, r) => n + r.n, 0),
  };
}
