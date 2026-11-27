import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import { parse, periodWindow, Station } from './model.js';

/**
 * «Скорость кухни» (owner 27.11): how fast each kitchen station worked on one Almaty calendar
 * day, and how many orders took longer than the red limit. Built only from the kitchen events
 * the cashier already sends to the cloud: cloud orders (app, kiosk) through the fulfillment
 * transport (cloud_fulfillment_inbox) and cashier orders through the POS kitchen sync
 * (pos_kitchen_sync_inbox), when that sync is on. Times are the cashier's own event times
 * (payload updatedAt), not the moment the cloud received them, so a tunnel outage does not
 * stretch them. No migration: read only.
 */
type Db = Pick<DatabaseClient, 'query'>;

const calendarDay = z.iso.date().refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    value >= '2000-01-01' &&
    value <= '2099-12-31' &&
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
});
export const KitchenSpeedQuery = z.strictObject({ date: calendarDay });

/** Default limits when the back office has no station norm: amber 5 min, red 10 min. */
export const DEFAULT_TARGET_SECONDS = 300;
/** At most this many events per day are read; more is reported as `truncated`. */
export const KITCHEN_SPEED_EVENT_LIMIT = 50000;
const TABLES = [
  'cloud_fulfillment_inbox',
  'pos_kitchen_sync_inbox',
  'bo_station_plan_edge_state',
] as const;

type Payload = {
  orderId?: unknown;
  state?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  taskId?: unknown;
  taskState?: unknown;
  stationId?: unknown;
  assemblyStationId?: unknown;
};
type Event = { source: 'cloud' | 'pos'; event_type: string; payload: Payload };

const time = (v: unknown) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const str = (v: unknown) => (typeof v === 'string' && v.length <= 100 ? v : null);
const average = (list: number[]) =>
  list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null;
const median = (list: number[]) => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2);
};

/** Which tables this role can read (an older cloud or a narrower role reads fewer). */
async function readable(db: Db) {
  const rows = (
    await db.query<{ t: string; ok: boolean }>(
      `SELECT t, to_regclass(t) IS NOT NULL AND has_table_privilege(current_user, to_regclass(t), 'SELECT') AS ok
       FROM unnest($1::text[]) t`,
      [TABLES],
    )
  ).rows;
  return new Set(rows.filter((r) => r.ok).map((r) => r.t));
}

/** Station names and norms: back-office stations bound to a cashier station, then the names the cashier reported. */
async function stationInfo(db: Db, branch: string, edgeState: boolean) {
  const info = new Map<string, { name: string; target: number | null; kind: string | null }>();
  const reported = edgeState
    ? (
        await db.query<{ stations: unknown }>(
          `SELECT stations FROM bo_station_plan_edge_state WHERE branch_id=$1`,
          [branch],
        )
      ).rows
    : [];
  for (const row of reported)
    if (Array.isArray(row.stations))
      for (const s of row.stations as Record<string, unknown>[]) {
        const id = str(s.id),
          name = str(s.name);
        if (id && name) info.set(id, { name, target: null, kind: str(s.kind) });
      }
  const published = (
    await db.query<{ payload: unknown }>(
      `SELECT DISTINCT ON(record_id) payload FROM bo_publications
       WHERE branch_id=$1 AND kind='station' ORDER BY record_id,revision DESC`,
      [branch],
    )
  ).rows;
  for (const row of published) {
    const parsed = Station.safeParse(row.payload);
    if (!parsed.success || !parsed.data.edge_station_id || !parsed.data.active) continue;
    const old = info.get(parsed.data.edge_station_id);
    info.set(parsed.data.edge_station_id, {
      name: parsed.data.name,
      target: parsed.data.target_seconds,
      kind: old?.kind ?? (parsed.data.role === 'assembly' ? 'assembly' : 'prep'),
    });
  }
  return info;
}

export async function readKitchenSpeed(db: Db, branch: string, input: unknown, now: Date) {
  const q = parse(KitchenSpeedQuery, input);
  const { start, end } = periodWindow(
    { period: 'custom', start_date: q.date, end_date: q.date },
    now,
  );
  const tables = await readable(db);
  // Events arrive late after an outage: read a day either side by arrival, keep by event time.
  const parts: string[] = [];
  if (tables.has('cloud_fulfillment_inbox'))
    parts.push(`SELECT 'cloud' AS source,event_type,payload FROM cloud_fulfillment_inbox
      WHERE branch_id=$1 AND received_at >= $2::timestamptz - interval '1 day' AND received_at < $3::timestamptz + interval '1 day'`);
  if (tables.has('pos_kitchen_sync_inbox'))
    parts.push(`SELECT 'pos' AS source,event_type,envelope->'payload' AS payload FROM pos_kitchen_sync_inbox
      WHERE branch_id=$1 AND received_at >= $2::timestamptz - interval '1 day' AND received_at < $3::timestamptz + interval '1 day'`);
  const events: Event[] = parts.length
    ? (
        await db.query<Event>(
          `${parts.join(' UNION ALL ')} LIMIT ${KITCHEN_SPEED_EVENT_LIMIT + 1}`,
          [branch, start.toISOString(), end.toISOString()],
        )
      ).rows
    : [];
  const info = await stationInfo(db, branch, tables.has('bo_station_plan_edge_state'));
  return {
    date: q.date,
    timezone: 'Asia/Almaty' as const,
    sources: {
      cloud_orders: tables.has('cloud_fulfillment_inbox'),
      cashier_orders: tables.has('pos_kitchen_sync_inbox'),
    },
    ...summarizeKitchenSpeed(events, info, start.getTime(), end.getTime()),
  };
}

export type KitchenEvent = Event;
export type StationInfo = Map<string, { name: string; target: number | null; kind: string | null }>;
/**
 * Pure part of the report: events of the day (any order) to station and order figures. A task
 * counts when its order was accepted in [start, end) and is not cancelled; its time runs from
 * order acceptance to the task's first «done» (cooking: from its first «in progress»). An order
 * counts from acceptance to its first «ready». Late = more than twice the norm (red timer).
 */
export function summarizeKitchenSpeed(
  events: KitchenEvent[],
  info: StationInfo,
  startMs: number,
  endMs: number,
) {
  const truncated = events.length > KITCHEN_SPEED_EVENT_LIMIT;

  type OrderRow = {
    source: 'cloud' | 'pos';
    createdAt: number | null;
    readyAt: number | null;
    assembly: string | null;
    cancelled: boolean;
  };
  type TaskRow = {
    station: string;
    orderId: string;
    startedAt: number | null;
    doneAt: number | null;
  };
  const orders = new Map<string, OrderRow>();
  const tasks = new Map<string, TaskRow>();
  for (const e of events.slice(0, KITCHEN_SPEED_EVENT_LIMIT)) {
    const p = e.payload ?? {};
    const orderId = str(p.orderId);
    if (!orderId) continue;
    const at = time(p.updatedAt);
    const order = orders.get(orderId) ?? {
      source: e.source,
      createdAt: null,
      readyAt: null,
      assembly: null,
      cancelled: false,
    };
    order.createdAt ??= time(p.createdAt);
    order.assembly ??= str(p.assemblyStationId);
    if (p.state === 'ready' && at !== null && (order.readyAt === null || at < order.readyAt))
      order.readyAt = at;
    if (p.state === 'cancelled' || p.state === 'released') order.cancelled = true;
    orders.set(orderId, order);
    const taskId = str(p.taskId),
      station = str(p.stationId);
    if (e.event_type !== 'edge.task_changed' || !taskId || !station || at === null) continue;
    const task = tasks.get(taskId) ?? { station, orderId, startedAt: null, doneAt: null };
    if (p.taskState === 'in_progress' && (task.startedAt === null || at < task.startedAt))
      task.startedAt = at;
    if (p.taskState === 'done' && (task.doneAt === null || at < task.doneAt)) task.doneAt = at;
    tasks.set(taskId, task);
  }
  const inDay = (t: number | null) => t !== null && t >= startMs && t < endMs;
  const assemblyTarget = (o: OrderRow) =>
    (o.assembly ? info.get(o.assembly)?.target : null) ?? DEFAULT_TARGET_SECONDS;

  // Stations: each finished task of an order accepted this day.
  const byStation = new Map<string, { wait: number[]; cook: number[]; late: number }>();
  for (const t of tasks.values()) {
    const o = orders.get(t.orderId);
    if (!o || !inDay(o.createdAt) || t.doneAt === null || o.cancelled) continue;
    const s = byStation.get(t.station) ?? { wait: [], cook: [], late: 0 };
    const total = Math.max(0, Math.round((t.doneAt - o.createdAt!) / 1000));
    s.wait.push(total);
    if (t.startedAt !== null) s.cook.push(Math.max(0, Math.round((t.doneAt - t.startedAt) / 1000)));
    const target = info.get(t.station)?.target ?? DEFAULT_TARGET_SECONDS;
    if (total > 2 * target) s.late++;
    byStation.set(t.station, s);
  }
  const stations = [...byStation]
    .map(([id, s]) => {
      const known = info.get(id);
      return {
        station_id: id,
        name: known?.name ?? null,
        kind: known?.kind ?? null,
        target_seconds: known?.target ?? null,
        tasks: s.wait.length,
        avg_seconds: average(s.wait),
        median_seconds: median(s.wait),
        avg_cook_seconds: average(s.cook),
        late_tasks: s.late,
      };
    })
    .sort(
      (a, b) =>
        (a.name ?? '').localeCompare(b.name ?? '') || a.station_id.localeCompare(b.station_id),
    );

  // Orders: from acceptance to «Заказ собран» (ready).
  const ready: number[] = [];
  let late = 0,
    open = 0;
  const bySource = { cloud: 0, pos: 0 };
  for (const o of orders.values()) {
    if (!inDay(o.createdAt) || o.cancelled) continue;
    bySource[o.source]++;
    if (o.readyAt === null) {
      open++;
      continue;
    }
    const seconds = Math.max(0, Math.round((o.readyAt - o.createdAt!) / 1000));
    ready.push(seconds);
    if (seconds > 2 * assemblyTarget(o)) late++;
  }
  return {
    orders: {
      total: ready.length + open,
      from_app_and_kiosk: bySource.cloud,
      from_cashier: bySource.pos,
      ready: ready.length,
      not_ready: open,
      avg_ready_seconds: average(ready),
      median_ready_seconds: median(ready),
      late,
    },
    stations,
    default_target_seconds: DEFAULT_TARGET_SECONDS,
    truncated,
  };
}
