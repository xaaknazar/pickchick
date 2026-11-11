import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import { BackofficeError, parse } from './model.js';
import { P1_FEATURE_RELATIONS, p1RelationsReady } from './p1-flags.js';
import { readable, type BackofficeOptions } from './stops.js';
import { readStaffPositions, type StaffPosition } from './positions.js';
import { requirePermission, type BackofficeEffectiveRole } from './roles.js';
import { stockWindowValid } from './stock-v2.js';

/**
 * Staff assignment «Расстановка» (А9; lane bo-ui2 step 5, owner decision 06.11;
 * design-bo-ui.md §9.4, design-backoffice.md section 2 А9). Runs only behind
 * BACKOFFICE_STAFF_ASSIGNMENT_ENABLED with the staff positions and the cloud076 rights of
 * infra/staging/backoffice-supply-grants.mjs (p2-flags.ts staffAssignmentAvailable). The commands
 * are parsed by their own schema (p2-commands.ts) and run in the shared envelope of index.ts
 * (request_id, digest, bo_audit with before and after, the branch lock), with expected_revision.
 *
 * - Stations are the kitchen's codes: a position with KDS functions gives one station per
 *   function (breading, toasts, assembly_hall, assembly_delivery, issue, delivery_handover: the
 *   codes of contracts §2.3 and of the KDS layout, with the names of the kitchen screens); a
 *   position with a station number and no KDS function gives a station with its own code
 *   (cashier 1, fryer 7, prep 8, runner 9). Managers have no station.
 * - An employee goes only to a station of his position or of his extra stations; anything else
 *   needs a reason and the permission staff.assign_override (the manager).
 * - «X at S from HH:MM»: the business day is the Almaty day of the start minus 6 hours, so a
 *   time from 00:00 to 05:59 is the night after the business day (a shift that closes after
 *   midnight belongs to the day it was opened). The command names the business day and the
 *   clock time; the server turns them into the instant. Never more than 5 minutes ahead.
 * - One open interval per employee (076 index): a reassignment closes the open interval at the
 *   start of the new one in the same transaction; intervals never overlap (076 trigger, checked
 *   here first). A reassignment stays in the business day of the open interval; an interval of
 *   an earlier day must be ended first. A closed interval never changes.
 */

type Db = Pick<DatabaseClient, 'query'>;
/** A clock time before this is the night after the business day (00:00-05:59). */
export const NIGHT_END = '06:00';
/** How far ahead of the database clock a start or an end may be (the cabinet clock may run ahead). */
export const ASSIGNMENT_AHEAD_MINUTES = 5;
/** Intervals of one business day in the day view; intervals of a window in the range view. */
export const ASSIGNMENT_DAY_LIMIT = 500;
export const ASSIGNMENT_RANGE_LIMIT = 3000;
/** Open intervals of earlier days listed for ending (the day view). */
export const ASSIGNMENT_OPEN_LIMIT = 200;
/** The screen names of the KDS stations (contracts §2.3), in the kitchen's order. */
export const KDS_STATION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  issue: 'Выдача (2)',
  delivery_handover: 'Выдача доставки (3)',
  assembly_hall: 'Сборка - зал (стол 1)',
  assembly_delivery: 'Сборка - доставка (стол 2)',
  toasts: 'Тосты и бургеры (5)',
  breading: 'Панировка (6)',
});

const code = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
const clockTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
/** An Almaty calendar day within the bounds of cloud076. */
const day = z.iso
  .date()
  .refine(
    (v) =>
      v >= '2024-01-01' &&
      v <= '2099-12-31' &&
      new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v,
  );
const revision = z.number().int().min(0).max(2147483646);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/**
 * Put an employee on a station from HH:MM of a business day. expected_revision is the revision
 * of the employee's open interval, 0 when he has none. With an open interval this is a
 * reassignment («Переставить»). override_reason: the station is not one of his positions and
 * the manager confirms it (staff.assign_override).
 */
export const StaffAssignCommand = z.strictObject({
  type: z.literal('staff_assign'),
  employee_id: z.uuid(),
  station_code: code,
  business_date: day,
  time: clockTime,
  expected_revision: revision,
  override_reason: z
    .string()
    .trim()
    .min(3)
    .max(300)
    .refine((v) => !CONTROL.test(v))
    .optional(),
});
/** End the employee's open interval at HH:MM of its own business day. */
export const StaffUnassignCommand = z.strictObject({
  type: z.literal('staff_unassign'),
  employee_id: z.uuid(),
  time: clockTime,
  expected_revision: revision.min(1),
});
export type StaffAssignmentCommandInput =
  z.infer<typeof StaffAssignCommand> | z.infer<typeof StaffUnassignCommand>;

// ------------------------------------------------------------------------- stations ----

export type AssignmentStation = {
  code: string;
  label: string;
  /** Station number of the station summary (1 cash desk ... 9 runners). */
  number: number;
  /** The KDS function of the station, or null for a station without a kitchen screen. */
  kds: string | null;
  /** Position codes whose employees may stand here. */
  positions: string[];
  /** Some active position gives it: only active stations take new assignments. */
  active: boolean;
};
/**
 * The stations of a list of positions: one per KDS function of a position, or one per position
 * with a station number and no KDS function; ordered by number, then by the kitchen's order.
 */
export function assignmentStations(list: readonly StaffPosition[]): AssignmentStation[] {
  const out = new Map<string, AssignmentStation>();
  const order = new Map<string, number>();
  const kdsOrder = Object.keys(KDS_STATION_LABELS);
  list.forEach((p, index) => {
    if (p.station === null) return;
    const entries = p.kds.length
      ? p.kds.map((fn) => ({
          code: fn as string,
          label: KDS_STATION_LABELS[fn] ?? `${p.label} (${p.station})`,
          kds: fn as string,
          order: kdsOrder.indexOf(fn),
        }))
      : [{ code: p.code, label: `${p.label} (${p.station})`, kds: null, order: 100 + index }];
    for (const e of entries) {
      const known = out.get(e.code);
      if (known) {
        if (!known.positions.includes(p.code)) known.positions.push(p.code);
        known.active ||= p.active;
      } else {
        out.set(e.code, {
          code: e.code,
          label: e.label,
          number: p.station,
          kds: e.kds,
          positions: [p.code],
          active: p.active,
        });
        order.set(e.code, e.order);
      }
    }
  });
  return [...out.values()].sort(
    (a, b) => a.number - b.number || order.get(a.code)! - order.get(b.code)!,
  );
}
/** The position and the extra stations of an employee card. */
export function cardPositions(payload: Record<string, unknown>): string[] {
  const extra = Array.isArray(payload['extra_position_codes'])
    ? (payload['extra_position_codes'] as unknown[])
    : [];
  return [payload['position_code'], ...extra].filter((v): v is string => typeof v === 'string');
}
/** The active stations an employee card may stand on without an override. */
export function cardStations(
  payload: Record<string, unknown>,
  stations: readonly AssignmentStation[],
): string[] {
  const mine = cardPositions(payload);
  return stations
    .filter((s) => s.active && s.positions.some((p) => mine.includes(p)))
    .map((s) => s.code);
}
/** A card that works: active, not removed and not marked «не работает». */
export const workingCard = (payload: Record<string, unknown>) =>
  payload['active'] === true &&
  payload['deleted'] !== true &&
  payload['employment_status'] !== 'inactive';

// ------------------------------------------------------------------------ intervals ----

type Row = {
  id: string;
  business_date: string;
  employee_id: string;
  employee_name: string | null;
  station_code: string;
  started_at: Date;
  ended_at: Date | null;
  set_by_name: string | null;
  set_at: Date;
  ended_by_name: string | null;
  revision: number;
};
const COLUMNS = `a.id::text AS id,a.business_date::text AS business_date,a.employee_id::text AS employee_id,
  e.payload->>'name' AS employee_name,a.station_code,a.started_at,a.ended_at,s.name AS set_by_name,
  a.set_at,x.name AS ended_by_name,a.revision
  FROM bo_staff_assignments a
  LEFT JOIN bo_records e ON e.branch_id=a.branch_id AND e.kind='employee' AND e.id=a.employee_id
  LEFT JOIN catalog_managers s ON s.id=a.set_by LEFT JOIN catalog_managers x ON x.id=a.ended_by`;
const iso = (v: Date | null) => (v === null ? null : v.toISOString());
export type AssignmentView = {
  id: string;
  employee_id: string;
  employee_name: string | null;
  station_code: string;
  station_label: string;
  business_date: string;
  started_at: string;
  ended_at: string | null;
  set_by_name: string | null;
  set_at: string;
  ended_by_name: string | null;
  revision: number;
  /** The manager's reason for a station outside the employee's positions, else null. */
  override_reason: string | null;
};
export function assignmentView(
  r: Row,
  stations: readonly AssignmentStation[],
  override: string | null,
): AssignmentView {
  return {
    id: r.id,
    employee_id: r.employee_id,
    employee_name: r.employee_name,
    station_code: r.station_code,
    station_label: stations.find((s) => s.code === r.station_code)?.label ?? r.station_code,
    business_date: r.business_date,
    started_at: r.started_at.toISOString(),
    ended_at: iso(r.ended_at),
    set_by_name: r.set_by_name,
    set_at: r.set_at.toISOString(),
    ended_by_name: r.ended_by_name,
    revision: r.revision,
    override_reason: override,
  };
}
/**
 * The override reasons of intervals (bo_audit of the command that opened each). The audit row is
 * written in the same transaction after the interval, so `since` (the oldest set_at) keeps the
 * lookup on the branch index of bo_audit.
 */
async function overrides(db: Db, branch: string, rows: readonly Row[]) {
  if (!rows.length) return new Map<string, string | null>();
  const since = new Date(Math.min(...rows.map((r) => r.set_at.getTime())));
  return new Map(
    (
      await db.query<{ entity_id: string; reason: string | null }>(
        `SELECT DISTINCT ON (entity_id) entity_id::text AS entity_id,
           after_value->'assignment'->>'override_reason' AS reason
         FROM bo_audit WHERE branch_id=$1 AND action='staff_assign' AND entity_id=ANY($2::uuid[])
           AND created_at >= $3
         ORDER BY entity_id,created_at,id`,
        [branch, rows.map((r) => r.id), since],
      )
    ).rows.map((r) => [r.entity_id, r.reason]),
  );
}
async function views(
  db: Db,
  branch: string,
  rows: readonly Row[],
  stations: readonly AssignmentStation[],
) {
  const reasons = await overrides(db, branch, rows);
  return rows.map((r) => assignmentView(r, stations, reasons.get(r.id) ?? null));
}
async function openOf(db: Db, branch: string, employee: string, lock = false) {
  if (lock)
    await db.query(
      'SELECT 1 FROM bo_staff_assignments WHERE branch_id=$1 AND employee_id=$2 AND ended_at IS NULL FOR UPDATE',
      [branch, employee],
    );
  return (
    await db.query<Row>(
      `SELECT ${COLUMNS} WHERE a.branch_id=$1 AND a.employee_id=$2 AND a.ended_at IS NULL`,
      [branch, employee],
    )
  ).rows[0];
}
async function rowById(db: Db, branch: string, id: string) {
  return (await db.query<Row>(`SELECT ${COLUMNS} WHERE a.branch_id=$1 AND a.id=$2`, [branch, id]))
    .rows[0]!;
}
/**
 * The instant of HH:MM in a business day (a time before 06:00 is the next calendar day) and the
 * database clock, both from PostgreSQL (its tzdata decides Asia/Almaty).
 */
async function instant(db: Db, businessDate: string, time: string) {
  return (
    await db.query<{ at: Date; now: Date }>(
      `SELECT ((($1::date + CASE WHEN $2::time < $3::time THEN 1 ELSE 0 END) + $2::time)
         AT TIME ZONE 'Asia/Almaty') AS at, clock_timestamp() AS now`,
      [businessDate, time, NIGHT_END],
    )
  ).rows[0]!;
}
const ahead = (at: Date, now: Date) =>
  at.getTime() > now.getTime() + ASSIGNMENT_AHEAD_MINUTES * 60000;
async function stationsOf(db: Db, branch: string) {
  return assignmentStations((await readStaffPositions(db, branch)).positions);
}

async function assign(
  db: Db,
  branch: string,
  actor: string,
  role: BackofficeEffectiveRole,
  c: z.infer<typeof StaffAssignCommand>,
) {
  const stations = await stationsOf(db, branch);
  const station = stations.find((s) => s.code === c.station_code);
  if (!station || !station.active) throw new BackofficeError('INVALID_REQUEST', 'STATION_UNKNOWN');
  const card = (
    await db.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM bo_records WHERE branch_id=$1 AND kind='employee' AND id=$2 FOR SHARE",
      [branch, c.employee_id],
    )
  ).rows[0];
  if (!card) throw new BackofficeError('NOT_FOUND');
  if (!workingCard(card.payload))
    throw new BackofficeError('INVALID_REQUEST', 'EMPLOYEE_NOT_WORKING');
  let override: string | null = null;
  if (!cardStations(card.payload, stations).includes(station.code)) {
    if (c.override_reason === undefined)
      throw new BackofficeError('INVALID_REQUEST', 'STATION_NOT_ALLOWED');
    requirePermission(role, 'staff.assign_override');
    override = c.override_reason;
  }
  const { at, now } = await instant(db, c.business_date, c.time);
  if (ahead(at, now)) throw new BackofficeError('INVALID_REQUEST', 'ASSIGNMENT_TIME');
  const open = await openOf(db, branch, c.employee_id, true);
  if ((open?.revision ?? 0) !== c.expected_revision) throw new BackofficeError('CONFLICT');
  const before = open ? (await views(db, branch, [open], stations))[0]! : null;
  if (open) {
    if (open.business_date !== c.business_date)
      throw new BackofficeError('CONFLICT', 'ASSIGNMENT_PREVIOUS_DAY');
    if (at.getTime() < open.started_at.getTime())
      throw new BackofficeError('CONFLICT', 'ASSIGNMENT_OVERLAP');
    // Already there: nothing changes (the start of an open interval never moves).
    if (open.station_code === station.code)
      return {
        result: { assignment: before!, closed: null, changed: false },
        before,
        entity: open.id,
      };
    await db.query(
      `UPDATE bo_staff_assignments SET ended_at=$3,ended_by=$4,revision=revision+1,
         updated_at=clock_timestamp() WHERE branch_id=$1 AND id=$2`,
      [branch, open.id, at, actor],
    );
  }
  // No earlier interval of this employee may reach past the new start (the 076 trigger refuses
  // it too; here it is said in words and nothing is written).
  if (
    (
      await db.query(
        `SELECT 1 FROM bo_staff_assignments WHERE branch_id=$1 AND employee_id=$2
           AND tstzrange(started_at,ended_at,'[)') && tstzrange($3,NULL,'[)') LIMIT 1`,
        [branch, c.employee_id, at],
      )
    ).rowCount
  )
    throw new BackofficeError('CONFLICT', 'ASSIGNMENT_OVERLAP');
  const id = randomUUID();
  await db.query(
    `INSERT INTO bo_staff_assignments(id,branch_id,business_date,employee_id,station_code,started_at,
       set_by,revision) VALUES($1,$2,$3::date,$4,$5,$6,$7,1)`,
    [id, branch, c.business_date, c.employee_id, station.code, at, actor],
  );
  const [assignment] = await views(db, branch, [await rowById(db, branch, id)], stations);
  const closed = open
    ? assignmentView(await rowById(db, branch, open.id), stations, before!.override_reason)
    : null;
  return {
    result: { assignment: { ...assignment!, override_reason: override }, closed, changed: true },
    before,
    entity: id,
  };
}
async function unassign(
  db: Db,
  branch: string,
  actor: string,
  c: z.infer<typeof StaffUnassignCommand>,
) {
  const stations = await stationsOf(db, branch);
  const open = await openOf(db, branch, c.employee_id, true);
  if (!open || open.revision !== c.expected_revision) throw new BackofficeError('CONFLICT');
  const [before] = await views(db, branch, [open], stations);
  const { at, now } = await instant(db, open.business_date, c.time);
  if (ahead(at, now) || at.getTime() < open.started_at.getTime())
    throw new BackofficeError('INVALID_REQUEST', 'ASSIGNMENT_TIME');
  await db.query(
    `UPDATE bo_staff_assignments SET ended_at=$3,ended_by=$4,revision=revision+1,
       updated_at=clock_timestamp() WHERE branch_id=$1 AND id=$2`,
    [branch, open.id, at, actor],
  );
  return {
    result: {
      assignment: assignmentView(
        await rowById(db, branch, open.id),
        stations,
        before!.override_reason,
      ),
      closed: null,
      changed: true,
    },
    before: before!,
    entity: open.id,
  };
}
/**
 * One staff assignment command (design-bo-ui 9.4). The caller holds the branch lock and the
 * command envelope. Answers the result ({assignment, closed, changed}), the state before (the
 * audit's before_value) and the entity of the audit row. Throws BackofficeError: NOT_FOUND (no
 * such card), INVALID_REQUEST/STATION_UNKNOWN (not an active station of the list),
 * INVALID_REQUEST/EMPLOYEE_NOT_WORKING, INVALID_REQUEST/STATION_NOT_ALLOWED (not his position, no
 * override), FORBIDDEN (an override without staff.assign_override; ROLE_FORBIDDEN for a
 * designated role), INVALID_REQUEST/ASSIGNMENT_TIME (more than 5 minutes ahead, or an end before
 * the start), CONFLICT (another revision, no open interval to end),
 * CONFLICT/ASSIGNMENT_PREVIOUS_DAY (the open interval belongs to another business day),
 * CONFLICT/ASSIGNMENT_OVERLAP (a start before the open start or inside an earlier interval).
 */
export async function staffAssignmentCommand(
  db: Db,
  branch: string,
  actor: string,
  role: BackofficeEffectiveRole,
  c: StaffAssignmentCommandInput,
): Promise<{ result: unknown; before: unknown; entity: string }> {
  return c.type === 'staff_assign'
    ? assign(db, branch, actor, role, c)
    : unassign(db, branch, actor, c);
}

// ----------------------------------------------------------------------------- view ----

/**
 * The default business day: the Almaty day of now minus 6 hours (until 06:00 it is still the
 * night of the day before), and the open manager shift when the manager shift runs. In normal
 * operation (opened after 06:00, closed before 06:00) its day is the same day.
 */
export async function assignmentDay(db: Db, branch: string, options: BackofficeOptions) {
  const today = (
    await db.query<{ day: string }>(
      `SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Almaty') - $1::time::interval)::date::text AS day`,
      [NIGHT_END],
    )
  ).rows[0]!.day;
  const shifts =
    options.managerShiftsEnabled === true &&
    (await p1RelationsReady(db, P1_FEATURE_RELATIONS.manager_shifts));
  const shift = shifts
    ? ((
        await db.query<{ id: string; business_date: string; opened_at: Date }>(
          `SELECT id::text AS id,business_date::text AS business_date,opened_at FROM bo_manager_shifts
           WHERE branch_id=$1 AND state='open'`,
          [branch],
        )
      ).rows[0] ?? null)
    : null;
  return {
    today,
    manager_shift: shift
      ? { id: shift.id, business_date: shift.business_date, opened_at: iso(shift.opened_at) }
      : null,
  };
}

export const StaffAssignmentsQuery = z
  .strictObject({
    date: day.optional(),
    start_date: day.optional(),
    end_date: day.optional(),
    employee_id: z.uuid().optional(),
    station_code: code.optional(),
  })
  .refine((q) =>
    q.start_date !== undefined || q.end_date !== undefined
      ? q.date === undefined &&
        q.start_date !== undefined &&
        q.end_date !== undefined &&
        stockWindowValid({ start_date: q.start_date, end_date: q.end_date })
      : q.employee_id === undefined && q.station_code === undefined,
  );
type EmployeeRow = { id: string; payload: Record<string, unknown> };
/**
 * GET .../ops/staff-assignments (design-bo-ui 9.4).
 *
 * - `?date=YYYY-MM-DD` or nothing (the default business day): the grid of a business day. The
 *   stations of the list in force, the working employees with the stations they may stand on,
 *   every interval of the day (oldest first, up to 500) and the open intervals of earlier days
 *   (left open: they must be ended before a new assignment).
 * - `?start_date&end_date[&employee_id][&station_code]` (at most 92 days): the read for the time
 *   sheet and for the kitchen error statistics (КД9): the intervals of the business days of the
 *   window, compact (id, employee, station, business day, start, end), up to 3000, oldest first,
 *   with the names of their employees and the stations.
 */
export async function readStaffAssignments(
  db: Db,
  branch: string,
  input: unknown,
  now: Date,
  options: BackofficeOptions,
) {
  const q = parse(StaffAssignmentsQuery, input);
  const stations = await stationsOf(db, branch);
  const { today, manager_shift } = await assignmentDay(db, branch, options);
  const head = {
    schema_version: 1 as const,
    branch_id: branch,
    view: 'staff-assignments' as const,
    timezone: 'Asia/Almaty' as const,
    as_of: now.toISOString(),
    today,
    night_end: NIGHT_END,
    manager_shift,
  };
  if (q.start_date !== undefined) {
    const rows = (
      await db.query<{
        id: string;
        employee_id: string;
        employee_name: string | null;
        station_code: string;
        business_date: string;
        started_at: Date;
        ended_at: Date | null;
      }>(
        `SELECT a.id::text AS id,a.employee_id::text AS employee_id,e.payload->>'name' AS employee_name,
           a.station_code,a.business_date::text AS business_date,a.started_at,a.ended_at
         FROM bo_staff_assignments a
         LEFT JOIN bo_records e ON e.branch_id=a.branch_id AND e.kind='employee' AND e.id=a.employee_id
         WHERE a.branch_id=$1 AND a.business_date BETWEEN $2::date AND $3::date
           AND ($4::uuid IS NULL OR a.employee_id=$4) AND ($5::text IS NULL OR a.station_code=$5)
         ORDER BY a.started_at,a.id LIMIT ${ASSIGNMENT_RANGE_LIMIT + 1}`,
        [branch, q.start_date, q.end_date, q.employee_id ?? null, q.station_code ?? null],
      )
    ).rows;
    const listed = rows.slice(0, ASSIGNMENT_RANGE_LIMIT);
    const names = new Map(listed.map((r) => [r.employee_id, r.employee_name]));
    return {
      ...head,
      mode: 'range' as const,
      start_date: q.start_date,
      end_date: q.end_date,
      employee_id: q.employee_id ?? null,
      station_code: q.station_code ?? null,
      stations,
      employees: [...names].map(([employee_id, name]) => ({ employee_id, name })),
      intervals: listed.map((r) => ({
        id: r.id,
        employee_id: r.employee_id,
        station_code: r.station_code,
        business_date: r.business_date,
        started_at: r.started_at.toISOString(),
        ended_at: iso(r.ended_at),
      })),
      limits: { intervals: ASSIGNMENT_RANGE_LIMIT },
      truncated: { intervals: rows.length > ASSIGNMENT_RANGE_LIMIT },
    };
  }
  const date = q.date ?? today;
  const dayRows = (
    await db.query<Row>(
      `SELECT ${COLUMNS} WHERE a.branch_id=$1 AND a.business_date=$2::date
       ORDER BY a.started_at,a.id LIMIT ${ASSIGNMENT_DAY_LIMIT + 1}`,
      [branch, date],
    )
  ).rows;
  const listed = dayRows.slice(0, ASSIGNMENT_DAY_LIMIT);
  const earlier = (
    await db.query<Row>(
      `SELECT ${COLUMNS} WHERE a.branch_id=$1 AND a.ended_at IS NULL AND a.business_date<>$2::date
       ORDER BY a.business_date,a.started_at,a.id LIMIT ${ASSIGNMENT_OPEN_LIMIT}`,
      [branch, date],
    )
  ).rows;
  const all = await views(db, branch, [...listed, ...earlier], stations);
  const intervals = all.slice(0, listed.length);
  const cards = (
    await db.query<EmployeeRow>(
      `SELECT id::text AS id,payload FROM bo_records WHERE branch_id=$1 AND kind='employee'
       ORDER BY payload->>'name',id LIMIT 1001`,
      [branch],
    )
  ).rows;
  if (cards.length > 1000) throw new BackofficeError('NOT_READY');
  const employees = cards
    .filter((card) => workingCard(card.payload))
    .map((card) => ({
      employee_id: card.id,
      name: String(card.payload['name'] ?? ''),
      position_code:
        typeof card.payload['position_code'] === 'string' ? card.payload['position_code'] : null,
      extra_position_codes: cardPositions(card.payload).slice(
        typeof card.payload['position_code'] === 'string' ? 1 : 0,
      ),
      stations: cardStations(card.payload, stations),
    }));
  return {
    ...head,
    mode: 'day' as const,
    date,
    stations,
    employees,
    intervals,
    // Open intervals of other business days: ended first, then the employee can stand again.
    earlier_open: all.slice(listed.length),
    counts: {
      intervals: listed.length,
      open: intervals.filter((i) => i.ended_at === null).length,
      employees: new Set(intervals.map((i) => i.employee_id)).size,
    },
    limits: { intervals: ASSIGNMENT_DAY_LIMIT, earlier_open: ASSIGNMENT_OPEN_LIMIT },
    truncated: { intervals: dayRows.length > ASSIGNMENT_DAY_LIMIT },
  };
}

/**
 * Who stood on a station at an instant (for the kitchen error statistics КД9 on the server):
 * the intervals of the station with started_at <= at < ended_at (an open one: up to now). Several
 * people may share a station.
 */
export async function assignedAt(db: Db, branch: string, station: string, at: Date) {
  return (
    await db.query<{ id: string; employee_id: string; started_at: Date; ended_at: Date | null }>(
      `SELECT id::text AS id,employee_id::text AS employee_id,started_at,ended_at
       FROM bo_staff_assignments WHERE branch_id=$1 AND station_code=$2 AND started_at<=$3
         AND (ended_at IS NULL OR ended_at>$3) ORDER BY started_at,id`,
      [branch, station, at],
    )
  ).rows.map((r) => ({
    id: r.id,
    employee_id: r.employee_id,
    started_at: r.started_at.toISOString(),
    ended_at: iso(r.ended_at),
  }));
}

/**
 * «Расстановка заполнена» of the manager shift checklist for a business day (manager-shifts-store
 * managerShiftChecks, only while the staff assignment is available): a problem while nobody was
 * placed that day, while somebody of the published schedule of the day has no interval, or while
 * an interval of an earlier day is still open.
 */
export async function staffAssignmentCheck(
  db: Db,
  branch: string,
  date: string,
  window: { start: Date; end: Date },
) {
  const day = (
    await db.query<{ intervals: number; employees: number; open: number; stations: number }>(
      `SELECT count(*)::int intervals,count(DISTINCT employee_id)::int employees,
         count(*) FILTER (WHERE ended_at IS NULL)::int open,count(DISTINCT station_code)::int stations
       FROM bo_staff_assignments WHERE branch_id=$1 AND business_date=$2::date`,
      [branch, date],
    )
  ).rows[0]!;
  const earlier = (
    await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM bo_staff_assignments WHERE branch_id=$1 AND ended_at IS NULL
         AND business_date<$2::date`,
      [branch, date],
    )
  ).rows[0]!.n;
  // The published schedule of the day (as «Явка по графику» reads it), without an interval.
  const missing = (await readable(db, 'bo_workforce_records'))
    ? (
        await db.query<{ name: string }>(
          `SELECT DISTINCT coalesce(e.payload->>'name','') AS name FROM bo_workforce_records w
           LEFT JOIN bo_records e ON e.branch_id=w.branch_id AND e.kind='employee' AND e.id=w.employee_id
           WHERE w.branch_id=$1 AND w.kind='plan' AND w.payload->>'deleted' IS NULL
             AND w.payload->>'status'='published'
             AND (w.payload->>'start')::timestamptz >= $3 AND (w.payload->>'start')::timestamptz < $4
             AND NOT EXISTS (SELECT 1 FROM bo_staff_assignments a WHERE a.branch_id=w.branch_id
               AND a.employee_id=w.employee_id AND a.business_date=$2::date)
           ORDER BY 1`,
          [branch, date, window.start, window.end],
        )
      ).rows.map((r) => r.name)
    : [];
  return {
    status: (day.intervals === 0 || missing.length > 0 || earlier > 0 ? 'problem' : 'ok') as
      'problem' | 'ok',
    facts: {
      intervals: day.intervals,
      employees: day.employees,
      open: day.open,
      stations: day.stations,
      missing: missing.slice(0, 10),
      missing_count: missing.length,
      earlier_open: earlier,
    },
  };
}
