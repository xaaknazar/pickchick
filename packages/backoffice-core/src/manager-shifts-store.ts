import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import { BackofficeError, parse, periodWindow } from './model.js';
import { readable, type BackofficeOptions } from './stops.js';
import { P1_FEATURE_RELATIONS, p1RelationsReady } from './p1-flags.js';
import { readPosDay } from './pos-day.js';
import {
  autoconsumeAvailable,
  consumptionBacklog,
  readStockSettings,
} from './consumption-store.js';
import { branchTemplatesWritable, latestTemplate } from './positions.js';
import { staffAssignmentAvailable } from './p2-flags.js';
import { staffAssignmentCheck } from './staff-assignments.js';
import {
  ChecklistTemplateSchema,
  MANAGER_SHIFT_AUTO,
  MANAGER_SHIFT_TEMPLATE_V1,
  STAFF_ASSIGNMENT_ITEM,
  checklistProblems,
  storedAnswers,
  type ChecklistItemAny,
  type ChecklistTemplate,
  type ManagerShiftAuto,
  type ManagerShiftAutoAny,
  type ManagerShiftCheck,
  ManagerShiftCloseCommand,
  ManagerShiftOpenCommand,
  ManagerShiftSaveCommand,
  ManagerShiftTemplateCommand,
} from './manager-shifts.js';

/**
 * Database side of the manager shift (lane bo-ui step 6; design-bo-ui.md 5.6). One shift row per
 * shift (bo_manager_shifts, cloud075 section 6): at most one open per branch, the business day is
 * the Almaty day of the opening (a shift that closes after midnight belongs to the day it was
 * opened), a closed shift never changes (075 triggers). Commands run inside the command envelope
 * of index.ts (request_id, digest, bo_audit, branch lock bo:branch:<id>, expected_revision).
 *
 * The checklist is the branch's newest version (bo_branch_templates kind 'manager_shift', 075
 * section 8) or the built-in version 1; a shift keeps the version it was opened with, so a new
 * version never changes the closing of a shift that is already open.
 */

type Db = Pick<DatabaseClient, 'query'>;
/** Shifts of the asked day in GET .../ops/manager-shifts (newest first). */
export const MANAGER_SHIFTS_LIMIT = 50;
/** The cash desks are «not sending» when nothing arrived for this long while a desk is open. */
export const POS_STALE_MINUTES = 10;

/** The flag and the cloud075 rights of the manager shift (P1 grants helper, managerShifts). */
export async function managerShiftsAvailable(db: Db, options: BackofficeOptions) {
  return (
    options.managerShiftsEnabled === true &&
    (await p1RelationsReady(db, P1_FEATURE_RELATIONS.manager_shifts))
  );
}

const iso = (v: unknown) =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v);
const almatyDay = (v: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(v);

export type ChecklistVersion = ChecklistTemplate & {
  version: number;
  updated_at: string | null;
  updated_by_name: string | null;
};
/** The checklist in force for new shifts. */
export async function currentChecklist(db: Db, branch: string): Promise<ChecklistVersion> {
  const row = (await branchTemplatesWritable(db))
    ? await latestTemplate(db, branch, 'manager_shift')
    : null;
  if (!row)
    return {
      version: 1,
      opening: [...MANAGER_SHIFT_TEMPLATE_V1.opening],
      closing: [...MANAGER_SHIFT_TEMPLATE_V1.closing],
      updated_at: null,
      updated_by_name: null,
    };
  const body = parse(ChecklistTemplateSchema, row.body);
  return {
    version: row.version,
    ...body,
    updated_at: row.created_at.toISOString(),
    updated_by_name: row.created_by_name,
  };
}
/** The checklist a shift was opened with. */
async function checklistVersion(db: Db, branch: string, version: number) {
  if (version === 1)
    return {
      version: 1,
      opening: [...MANAGER_SHIFT_TEMPLATE_V1.opening],
      closing: [...MANAGER_SHIFT_TEMPLATE_V1.closing],
    };
  const row = (
    await db.query<{ body: unknown }>(
      "SELECT body FROM bo_branch_templates WHERE branch_id=$1 AND kind='manager_shift' AND version=$2",
      [branch, version],
    )
  ).rows[0];
  if (!row) throw new BackofficeError('NOT_READY');
  return { version, ...parse(ChecklistTemplateSchema, row.body) };
}

// ------------------------------------------------------------------------ checks ----

type Checks = Record<ManagerShiftAuto, ManagerShiftCheck> &
  Partial<Record<ManagerShiftAutoAny, ManagerShiftCheck>>;
const check = (status: ManagerShiftCheck['status'], facts: Record<string, unknown> = {}) => ({
  status,
  facts,
});
/**
 * The automatic checks of the business day `day`, computed now (design-bo-ui 5.6). Every source
 * that is missing or not readable gives `no_data` (or `off` for a feature that is not running),
 * never a made-up zero. Lane bo-ui2 step 5: `staff_assignment` comes last and only while the
 * staff assignment is available; otherwise the checks are exactly bo-ui's.
 */
export async function managerShiftChecks(
  db: Db,
  branch: string,
  day: string,
  now: Date,
  options: BackofficeOptions,
): Promise<Checks> {
  const { start, end } = periodWindow({ period: 'custom', start_date: day, end_date: day }, now);
  const out = {} as Checks;

  // Schedule: published shifts of the day (workforce), and how many are already marked.
  if ((await readable(db, 'bo_workforce_records')) && (await readable(db, 'bo_records'))) {
    const row = (
      await db.query<{ planned: number; recorded: number; names: string[] | null }>(
        `SELECT count(*) FILTER (WHERE w.kind='plan')::int planned,
           count(*) FILTER (WHERE w.kind='time')::int recorded,
           (array_agg(DISTINCT e.payload->>'name' ORDER BY e.payload->>'name') FILTER (WHERE w.kind='plan'))[1:10] names
         FROM bo_workforce_records w
         LEFT JOIN bo_records e ON e.branch_id=w.branch_id AND e.kind='employee' AND e.id=w.employee_id
         WHERE w.branch_id=$1 AND w.payload->>'deleted' IS NULL AND (
           (w.kind='plan' AND w.payload->>'status'='published'
             AND (w.payload->>'start')::timestamptz >= $2 AND (w.payload->>'start')::timestamptz < $3)
           OR (w.kind='time' AND w.payload->>'date'=$4 AND w.payload->>'attendance'='worked'
             AND w.payload->>'status'<>'voided'))`,
        [branch, start, end, day],
      )
    ).rows[0]!;
    out.attendance = check(row.planned > 0 ? 'ok' : 'no_data', {
      planned: row.planned,
      recorded: row.recorded,
      names: row.names ?? [],
    });
  } else out.attendance = check('no_data', { planned: null, recorded: null, names: [] });

  // Stop list: what the cashier edge reported last.
  const stops = (
    await db.query<{ stopped: number; observed_at: Date }>(
      `SELECT cardinality(a.stopped_ids)::int stopped,a.observed_at FROM cloud_branch_availability a
       JOIN fulfillment_transport_bindings b ON b.branch_id=a.branch_id AND b.device_id=a.device_id AND b.active
       JOIN devices d ON d.id=b.device_id AND d.status='active' WHERE a.branch_id=$1`,
      [branch],
    )
  ).rows[0];
  out.stoplist = stops
    ? check('ok', { stopped: stops.stopped, observed_at: iso(stops.observed_at) })
    : check('no_data', { stopped: null, observed_at: null });

  // Cash desks of the day (ops/pos-day: a cash shift belongs to the day it was opened).
  const pos = await readPosDay(db, branch, { date: day }, now);
  const labels = new Map(pos.terminals.map((t) => [t.terminal_id, t.label]));
  const received = [pos.coverage.last_received_at, pos.coverage.cashier_reports_at]
    .filter((v): v is string => v !== null)
    .sort()
    .at(-1);
  const sources = pos.coverage.pos_tables || pos.coverage.cashier_reports;
  const desks = pos.shifts.map((s) => ({
    label: s.terminal_id ? (labels.get(s.terminal_id) ?? 'Касса') : 'Касса',
    state: s.state,
    opening_cash_minor: s.cash?.opening_cash_minor ?? null,
    discrepancy_minor: s.cash?.discrepancy_minor ?? null,
    terminal_discrepancy_minor: s.terminal.discrepancy_minor,
  }));
  out.cash_float = !sources
    ? check('no_data', { reason: 'not_received', desks: [] })
    : desks.some((d) => d.opening_cash_minor !== null)
      ? check('ok', {
          desks: desks
            .filter((d) => d.opening_cash_minor !== null)
            .map((d) => ({ label: d.label, opening_cash_minor: d.opening_cash_minor })),
        })
      : check('no_data', { reason: 'no_shifts', desks: [] });
  const open = desks.filter((d) => d.state !== 'closed').length;
  const sum = (key: 'discrepancy_minor' | 'terminal_discrepancy_minor') =>
    desks.reduce((a, d) => a + BigInt(d[key] ?? '0'), 0n).toString();
  const cashFacts = {
    total: desks.length,
    closed: desks.length - open,
    open,
    cash_discrepancy_minor: sum('discrepancy_minor'),
    terminal_discrepancy_minor: sum('terminal_discrepancy_minor'),
    last_received_at: received ?? null,
  };
  const stale =
    open > 0 && (!received || now.getTime() - Date.parse(received) >= POS_STALE_MINUTES * 60000);
  out.cash_shifts = !sources
    ? check('no_data', { ...cashFacts, reason: 'not_received' })
    : desks.length === 0
      ? check('no_data', { ...cashFacts, reason: 'no_shifts' })
      : stale
        ? check('no_data', { ...cashFacts, reason: 'stale' })
        : check(
            open > 0 ||
              cashFacts.cash_discrepancy_minor !== '0' ||
              cashFacts.terminal_discrepancy_minor !== '0'
              ? 'problem'
              : 'ok',
            cashFacts,
          );
  out.webkassa_receipts = pos.fiscal_summary
    ? check(pos.fiscal_summary.pending.count > 0 ? 'problem' : 'ok', {
        pending: pos.fiscal_summary.pending.count,
        pending_minor: pos.fiscal_summary.pending.amount_minor,
        recorded: pos.fiscal_summary.recorded.count,
      })
    : check('no_data', { reason: 'not_received' });

  // Stock documents of the day.
  const stock = (
    await db.query<{ waste: number; counts: number; counted: number; last_count_at: Date | null }>(
      `SELECT count(*) FILTER (WHERE d.kind='waste')::int waste,
         count(*) FILTER (WHERE d.kind='count')::int counts,
         (SELECT count(DISTINCT m.ingredient_id)::int FROM bo_stock_movements m JOIN bo_stock_documents c
            ON c.id=m.document_id AND c.branch_id=m.branch_id
          WHERE c.branch_id=$1 AND c.kind='count' AND c.created_at >= $2 AND c.created_at < $3) counted,
         max(d.created_at) FILTER (WHERE d.kind='count') last_count_at
       FROM bo_stock_documents d WHERE d.branch_id=$1 AND d.created_at >= $2 AND d.created_at < $3`,
      [branch, start, end],
    )
  ).rows[0]!;
  out.waste = check(stock.waste > 0 ? 'ok' : 'no_data', { documents: stock.waste });
  // Key positions (Ск7, step 8): the used ingredients marked «считать каждый день»
  // (count_daily, stock P1). Without any, the check stays «a count of the day exists».
  const keys = (
    await db.query<{ id: string; name: string; counted: boolean }>(
      `SELECT r.id,r.payload->>'name' AS name,EXISTS(
           SELECT 1 FROM bo_stock_movements m JOIN bo_stock_documents c ON c.id=m.document_id AND c.branch_id=m.branch_id
           WHERE c.branch_id=$1 AND c.kind='count' AND c.created_at >= $2 AND c.created_at < $3 AND m.ingredient_id=r.id) counted
       FROM bo_records r WHERE r.branch_id=$1 AND r.kind='ingredient' AND r.payload->>'count_daily'='true'
         AND r.payload->>'active'='true' AND r.payload->>'deleted' IS DISTINCT FROM 'true'
       ORDER BY r.payload->>'name',r.id`,
      [branch, start, end],
    )
  ).rows;
  const missing = keys.filter((k) => !k.counted);
  out.key_count = keys.length
    ? check(missing.length ? 'problem' : 'ok', {
        documents: stock.counts,
        items: stock.counted,
        last_at: iso(stock.last_count_at),
        key_items: keys.length,
        key_counted: keys.length - missing.length,
        key_missing: missing.slice(0, 10).map((k) => k.name),
        key_missing_count: missing.length,
      })
    : check(stock.counts > 0 ? 'ok' : 'no_data', {
        documents: stock.counts,
        items: stock.counted,
        last_at: iso(stock.last_count_at),
      });

  // Automatic consumption: sales of the day that could not be written off.
  if (await autoconsumeAvailable(db, options)) {
    const blocked = (
      await db.query<{ n: number }>(
        `SELECT count(*)::int n FROM bo_consumption_items WHERE branch_id=$1 AND state='blocked'
         AND sold_at >= $2 AND sold_at < $3`,
        [branch, start, end],
      )
    ).rows[0]!.n;
    // Review BOUI-R2: sales the worker should have handled and has not (any day) are a problem
    // too, so «Заблокированных списаний нет» never stands for a worker that does not run.
    const backlog = await consumptionBacklog(db, branch, await readStockSettings(db, branch), now);
    out.blocked_consumption = check(blocked > 0 || backlog.stalled ? 'problem' : 'ok', {
      blocked,
      not_processed: backlog.not_queued + backlog.waiting,
      not_processed_since: backlog.since,
    });
  } else out.blocked_consumption = check('off');
  const checks = Object.fromEntries(MANAGER_SHIFT_AUTO.map((k) => [k, out[k]])) as Checks;
  if (await staffAssignmentAvailable(db, options))
    checks.staff_assignment = await staffAssignmentCheck(db, branch, day, { start, end });
  return checks;
}
/**
 * The items a second-wave feature adds to a phase after the template's (lane bo-ui2 step 5: «Расстановка
 * заполнена» at closing while the staff assignment is available), or null: then every phase is
 * exactly its template's.
 */
async function extraItems(
  db: Db,
  options: BackofficeOptions,
): Promise<{ opening: ChecklistItemAny[]; closing: ChecklistItemAny[] } | null> {
  return (await staffAssignmentAvailable(db, options))
    ? { opening: [], closing: [STAFF_ASSIGNMENT_ITEM] }
    : null;
}
const withExtra = (items: readonly ChecklistItemAny[], extra: readonly ChecklistItemAny[] = []) => [
  ...items,
  ...extra.filter((e) => !items.some((i) => i.code === e.code)),
];

// ------------------------------------------------------------------------- shifts ----

type ShiftRow = {
  id: string;
  business_date: string;
  state: 'open' | 'closed';
  manager_employee_id: string | null;
  manager_name: string | null;
  opened_at: Date;
  opened_by: string;
  opened_by_name: string | null;
  closed_at: Date | null;
  closed_by: string | null;
  closed_by_name: string | null;
  opening: Record<string, unknown>;
  closing: Record<string, unknown> | null;
  template_version: number;
  revision: number;
  updated_at: Date;
};
const SHIFT_COLUMNS = `s.id::text AS id,s.business_date::text AS business_date,s.state,
  s.manager_employee_id::text AS manager_employee_id,e.payload->>'name' AS manager_name,
  s.opened_at,s.opened_by::text AS opened_by,o.name AS opened_by_name,s.closed_at,
  s.closed_by::text AS closed_by,c.name AS closed_by_name,s.opening,s.closing,s.template_version,
  s.revision,s.updated_at`;
const SHIFT_FROM = `bo_manager_shifts s
  LEFT JOIN bo_records e ON e.branch_id=s.branch_id AND e.kind='employee' AND e.id=s.manager_employee_id
  LEFT JOIN catalog_managers o ON o.id=s.opened_by LEFT JOIN catalog_managers c ON c.id=s.closed_by`;
/** A shift as the API returns it (times as ISO strings: a command replay is the same JSON). */
export function shiftView(r: ShiftRow) {
  return {
    id: r.id,
    business_date: r.business_date,
    state: r.state,
    manager_employee_id: r.manager_employee_id,
    manager_name: r.manager_name,
    opened_at: iso(r.opened_at),
    opened_by_name: r.opened_by_name,
    closed_at: iso(r.closed_at),
    closed_by_name: r.closed_by_name,
    template_version: r.template_version,
    opening: r.opening,
    closing: r.closing,
    revision: r.revision,
    updated_at: iso(r.updated_at),
  };
}
async function shiftById(db: Db, branch: string, id: string, lock = false) {
  if (lock)
    await db.query('SELECT 1 FROM bo_manager_shifts WHERE id=$1 AND branch_id=$2 FOR UPDATE', [
      id,
      branch,
    ]);
  return (
    await db.query<ShiftRow>(
      `SELECT ${SHIFT_COLUMNS} FROM ${SHIFT_FROM} WHERE s.id=$1 AND s.branch_id=$2`,
      [id, branch],
    )
  ).rows[0];
}
async function openShift(db: Db, branch: string) {
  return (
    await db.query<ShiftRow>(
      `SELECT ${SHIFT_COLUMNS} FROM ${SHIFT_FROM} WHERE s.branch_id=$1 AND s.state='open'`,
      [branch],
    )
  ).rows[0];
}

const day = z.iso.date().refine((v) => v >= '2024-03-01' && v <= '2099-12-31');
export const ManagerShiftsQuery = z.strictObject({ date: day.optional() });
/**
 * GET .../ops/manager-shifts?date=YYYY-MM-DD (default: today in Almaty): the checklist in force,
 * the open shift (of any day) with its checklist, the shifts of the day and the automatic checks
 * of the open shift's business day (or of the asked day when nothing is open).
 */
export async function readManagerShifts(
  db: Db,
  branch: string,
  input: unknown,
  now: Date,
  options: BackofficeOptions,
) {
  const q = parse(ManagerShiftsQuery, input);
  const date = q.date ?? almatyDay(now);
  const template = await currentChecklist(db, branch);
  const open = await openShift(db, branch);
  const shifts = (
    await db.query<ShiftRow>(
      `SELECT ${SHIFT_COLUMNS} FROM ${SHIFT_FROM} WHERE s.branch_id=$1 AND s.business_date=$2::date
       ORDER BY s.opened_at DESC,s.id LIMIT ${MANAGER_SHIFTS_LIMIT + 1}`,
      [branch, date],
    )
  ).rows;
  const checksDate = open?.business_date ?? date;
  const extra = await extraItems(db, options);
  return {
    schema_version: 1 as const,
    branch_id: branch,
    date,
    timezone: 'Asia/Almaty' as const,
    as_of: now.toISOString(),
    template: { ...template, editable: await branchTemplatesWritable(db) },
    open: open ? shiftView(open) : null,
    open_template:
      open && open.template_version !== template.version
        ? await checklistVersion(db, branch, open.template_version)
        : null,
    shifts: shifts.slice(0, MANAGER_SHIFTS_LIMIT).map(shiftView),
    truncated: shifts.length > MANAGER_SHIFTS_LIMIT,
    checks_date: checksDate,
    checks: await managerShiftChecks(db, branch, checksDate, now, options),
    // Lane bo-ui2 step 5: the items the cabinet adds after the template's, only while there are.
    ...(extra ? { extra_items: extra } : {}),
  };
}

const incomplete = () => new BackofficeError('INVALID_REQUEST', 'CHECKLIST_INCOMPLETE');
const clock = async (db: Db) =>
  (
    await db.query<{ at: Date; day: string }>(
      "SELECT t.at,(t.at AT TIME ZONE 'Asia/Almaty')::date::text AS day FROM (SELECT clock_timestamp() AS at) t",
    )
  ).rows[0]!;
function phaseAnswers(
  items: readonly ChecklistItemAny[],
  given: z.infer<typeof ManagerShiftOpenCommand>['items'],
  checks: Checks,
  partial: boolean,
) {
  if (checklistProblems(items, given, checks, partial).length) throw incomplete();
  return storedAnswers(items, given, checks);
}

export type ManagerShiftCommandInput =
  | z.infer<typeof ManagerShiftOpenCommand>
  | z.infer<typeof ManagerShiftSaveCommand>
  | z.infer<typeof ManagerShiftCloseCommand>
  | z.infer<typeof ManagerShiftTemplateCommand>;
/**
 * One manager shift command. The caller holds the branch lock and the command envelope. Errors:
 * CONFLICT/MANAGER_SHIFT_OPEN (another shift is open), CONFLICT (revision, closed shift, existing
 * id, template version), NOT_FOUND, INVALID_REQUEST/CHECKLIST_INCOMPLETE (a required answer or a
 * comment is missing, see checklistProblems), INVALID_REQUEST/HANDOVER_REQUIRED, INVALID_REQUEST
 * (an unknown employee card, a malformed checklist), NOT_READY (the template rights are missing).
 */
export async function managerShiftCommand(
  db: Db,
  branch: string,
  actor: string,
  c: ManagerShiftCommandInput,
  now: Date,
  options: BackofficeOptions,
) {
  if (c.type === 'manager_shift_template') {
    if (!(await branchTemplatesWritable(db))) throw new BackofficeError('NOT_READY');
    const current = await currentChecklist(db, branch);
    if (current.version !== c.expected_version) throw new BackofficeError('CONFLICT');
    const body = parse(ChecklistTemplateSchema, { opening: c.opening, closing: c.closing });
    const version = current.version + 1;
    await db.query(
      `INSERT INTO bo_branch_templates(branch_id,kind,version,body,created_by)
       VALUES($1,'manager_shift',$2,$3,$4)`,
      [branch, version, body, actor],
    );
    return { version, ...body };
  }
  if (c.type === 'manager_shift_open') {
    if (await openShift(db, branch)) throw new BackofficeError('CONFLICT', 'MANAGER_SHIFT_OPEN');
    if ((await db.query('SELECT 1 FROM bo_manager_shifts WHERE id=$1', [c.id])).rowCount)
      throw new BackofficeError('CONFLICT');
    if (
      c.manager_employee_id &&
      !(
        await db.query(
          "SELECT 1 FROM bo_records WHERE branch_id=$1 AND kind='employee' AND id=$2 AND payload->>'deleted' IS DISTINCT FROM 'true'",
          [branch, c.manager_employee_id],
        )
      ).rowCount
    )
      throw new BackofficeError('INVALID_REQUEST');
    const template = await currentChecklist(db, branch);
    const at = await clock(db);
    const checks = await managerShiftChecks(db, branch, at.day, now, options);
    const items = phaseAnswers(template.opening, c.items, checks, false);
    await db.query(
      `INSERT INTO bo_manager_shifts(id,branch_id,business_date,manager_employee_id,opened_at,opening,
         template_version,revision,opened_by,updated_at)
       VALUES($1,$2,$3::date,$4,$5,$6,$7,1,$8,$5)`,
      [
        c.id,
        branch,
        at.day,
        c.manager_employee_id,
        at.at,
        { items, saved_at: at.at.toISOString() },
        template.version,
        actor,
      ],
    );
    return shiftView((await shiftById(db, branch, c.id))!);
  }
  const shift = await shiftById(db, branch, c.id, true);
  if (!shift) throw new BackofficeError('NOT_FOUND');
  if (shift.state !== 'open' || shift.revision !== c.expected_revision)
    throw new BackofficeError('CONFLICT');
  const template = await checklistVersion(db, branch, shift.template_version);
  const checks = await managerShiftChecks(db, branch, shift.business_date, now, options);
  const at = await clock(db);
  // The closing of a second-wave feature (lane bo-ui2 step 5), after the template's items.
  const closing = withExtra(template.closing, (await extraItems(db, options))?.closing);
  if (c.type === 'manager_shift_save' && c.phase === 'opening') {
    const items = phaseAnswers(template.opening, c.items, checks, false);
    await db.query(
      'UPDATE bo_manager_shifts SET opening=$3,revision=revision+1,updated_at=$4 WHERE id=$1 AND branch_id=$2',
      [c.id, branch, { items, saved_at: at.at.toISOString() }, at.at],
    );
  } else if (c.type === 'manager_shift_save') {
    // A draft of the closing: partial answers and the handover written so far.
    const items = phaseAnswers(closing, c.items, checks, true);
    const handover = (c.handover ?? String(shift.closing?.['handover'] ?? '')).trim();
    await db.query(
      'UPDATE bo_manager_shifts SET closing=$3,revision=revision+1,updated_at=$4 WHERE id=$1 AND branch_id=$2',
      [c.id, branch, { items, handover, draft: true, saved_at: at.at.toISOString() }, at.at],
    );
  } else {
    const items = phaseAnswers(closing, c.items, checks, false);
    const handover = c.handover.trim();
    if (handover.length < 3) throw new BackofficeError('INVALID_REQUEST', 'HANDOVER_REQUIRED');
    await db.query(
      `UPDATE bo_manager_shifts SET state='closed',closed_at=$3,closed_by=$4,closing=$5,
         revision=revision+1,updated_at=$3 WHERE id=$1 AND branch_id=$2`,
      [c.id, branch, at.at, actor, { items, handover, saved_at: at.at.toISOString() }],
    );
  }
  return shiftView((await shiftById(db, branch, c.id))!);
}
