import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import { BackofficeError, Employee, parse } from './model.js';
import { edgeStaffId } from './edge-staff.js';

/**
 * Staff positions of the back office (lane bo-ui step 6, owner decision 05.11; design-bo-ui.md 5.7,
 * design-backoffice.md section 2 А8 and Д3). Everything here runs only while
 * BACKOFFICE_STAFF_POSITIONS_ENABLED is on.
 *
 * - The list of positions: the built-in eleven (version 1, code) or the branch's own version
 *   (bo_branch_templates kind 'staff_positions', version 2 and up, cloud075 section 8). A position
 *   has a code (fixed once listed), a label, a station number of the station summary, the KDS
 *   functions of that station and the default cashier access of a card that takes it. A position
 *   is never removed from the list, only made inactive, so every card stays valid.
 * - The employee card (bo_records kind 'employee', no DDL) may carry `position_code`,
 *   `extra_position_codes` (up to three other stations) and `pos_access`
 *   ('none' | 'cashier' | 'shift_manager'). Old cards without them stay valid. A save that omits
 *   them keeps the values the card already has (also with the flag off: a rollback never wipes
 *   positions; with the flag off only cards that already have them are affected).
 * - GET .../ops/staff-roster: the roster of the cashier edge, the input of
 *   scripts/staff-roster-apply.mjs and scripts/staff-pin-batch.mjs on the branch server. Every card
 *   (also inactive and removed ones, so their edge accounts are revoked) with its edge role and
 *   the deterministic edge staff id (edge-staff.ts), plus a sha256 of the canonical content.
 */

type Db = Pick<DatabaseClient, 'query'>;
/** KDS functions of the kitchen stations (lane kds), for the «Доступы» column. */
export const STAFF_KDS_FUNCTIONS = [
  'issue',
  'delivery_handover',
  'assembly_hall',
  'assembly_delivery',
  'toasts',
  'breading',
] as const;
/** Cashier access of a card: the edge role of its account, or none. */
export const POS_ACCESS = ['none', 'cashier', 'shift_manager'] as const;
export type PosAccess = (typeof POS_ACCESS)[number];

const code = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
export const StaffPositionSchema = z.strictObject({
  code,
  label: z.string().trim().min(1).max(60),
  /** Station number of the station summary (1 cash desk ... 9 runners), none for managers. */
  station: z.number().int().min(1).max(9).nullable(),
  kds: z
    .array(z.enum(STAFF_KDS_FUNCTIONS))
    .max(2)
    .refine((v) => new Set(v).size === v.length),
  pos_access: z.enum(POS_ACCESS),
  active: z.boolean(),
});
export type StaffPosition = z.infer<typeof StaffPositionSchema>;
export const StaffPositionsSchema = z
  .array(StaffPositionSchema)
  .min(1)
  .max(30)
  .superRefine((list, ctx) => {
    const codes = new Set<string>(),
      labels = new Set<string>();
    for (const p of list) {
      const label = p.label.toLocaleLowerCase('ru-RU');
      if (codes.has(p.code) || labels.has(label))
        ctx.addIssue({ code: 'custom', message: 'Duplicate position' });
      codes.add(p.code);
      labels.add(label);
    }
    if (!list.some((p) => p.active))
      ctx.addIssue({ code: 'custom', message: 'No active position' });
  });

/**
 * The built-in eleven (design-bo-ui 5.7): ten station positions of tracker А8 and the manager
 * (design-bo-ui 8 q3). Station numbers by the station summary.
 */
export const STAFF_POSITIONS_V1: readonly StaffPosition[] = Object.freeze(
  (
    [
      ['cashier', 'Кассир', 1, [], 'cashier'],
      ['issue', 'Выдача', 2, ['issue'], 'none'],
      ['delivery_handover', 'Выдача доставки', 3, ['delivery_handover'], 'none'],
      ['assembler', 'Сборщик', 4, ['assembly_hall', 'assembly_delivery'], 'none'],
      ['toasts_fries', 'Тосты, бургеры, фри', 5, ['toasts'], 'none'],
      ['breading', 'Панировщик', 6, ['breading'], 'none'],
      ['fryer', 'Жарщик', 7, [], 'none'],
      ['prep', 'Заготовщик', 8, [], 'none'],
      ['runner', 'Раннер', 9, [], 'none'],
      ['shift_manager', 'Менеджер смены', null, [], 'shift_manager'],
      ['manager', 'Управляющий', null, [], 'shift_manager'],
    ] as const
  ).map(([c, label, station, kds, pos_access]) =>
    Object.freeze({ code: c, label, station, kds: [...kds], pos_access, active: true }),
  ),
);

/** The card fields of a position (all optional: old cards stay valid). */
export const EMPLOYEE_P1_KEYS = ['position_code', 'extra_position_codes', 'pos_access'] as const;
export const EmployeeP1 = Employee.extend({
  position_code: code.optional(),
  extra_position_codes: z
    .array(code)
    .max(3)
    .refine((v) => new Set(v).size === v.length)
    .optional(),
  pos_access: z.enum(POS_ACCESS).optional(),
}).refine(
  (v) => !v.position_code || !(v.extra_position_codes ?? []).includes(v.position_code),
  'An extra station repeats the position',
);
export type EmployeeP1Payload = z.infer<typeof EmployeeP1>;

/** cloud075 section 8 is there and the current role may read and append to it. */
export async function branchTemplatesWritable(db: Db): Promise<boolean> {
  const r = await db.query<{ ok: boolean | null }>(
    `SELECT to_regclass('bo_branch_templates') IS NOT NULL
       AND has_table_privilege(current_user, to_regclass('bo_branch_templates'), 'SELECT')
       AND has_table_privilege(current_user, to_regclass('bo_branch_templates'), 'INSERT') AS ok`,
  );
  return r.rows[0]?.ok === true;
}
/** The newest row of a branch list, or null (the built-in version 1 applies). */
export async function latestTemplate(
  db: Db,
  branch: string,
  kind: 'manager_shift' | 'staff_positions',
) {
  return (
    (
      await db.query<{
        version: number;
        body: Record<string, unknown>;
        created_at: Date;
        created_by: string;
        created_by_name: string | null;
      }>(
        `SELECT t.version,t.body,t.created_at,t.created_by,m.name created_by_name FROM bo_branch_templates t
         LEFT JOIN catalog_managers m ON m.id=t.created_by
         WHERE t.branch_id=$1 AND t.kind=$2 ORDER BY t.version DESC LIMIT 1`,
        [branch, kind],
      )
    ).rows[0] ?? null
  );
}

export type StaffPositionsView = {
  version: number;
  /** The branch may save its own list (bo_branch_templates is writable). */
  editable: boolean;
  positions: StaffPosition[];
  updated_at: string | null;
  updated_by_name: string | null;
};
/** The list in force: the branch's newest version or the built-in eleven. */
export async function readStaffPositions(db: Db, branch: string): Promise<StaffPositionsView> {
  const editable = await branchTemplatesWritable(db);
  const row = editable ? await latestTemplate(db, branch, 'staff_positions') : null;
  if (!row)
    return {
      version: 1,
      editable,
      positions: STAFF_POSITIONS_V1.map((p) => ({ ...p, kds: [...p.kds] })),
      updated_at: null,
      updated_by_name: null,
    };
  return {
    version: row.version,
    editable,
    positions: parse(StaffPositionsSchema, row.body['positions']),
    updated_at: row.created_at.toISOString(),
    updated_by_name: row.created_by_name,
  };
}

export const StaffPositionsSaveCommand = z.strictObject({
  type: z.literal('staff_positions_save'),
  positions: StaffPositionsSchema,
  expected_version: z.number().int().min(1).max(2147483646),
});
/**
 * A new version of the branch's list. Every code of the list in force stays (inactive at most),
 * so no card loses its position; the version shown is the version in force (CONFLICT otherwise).
 * The caller holds the branch lock and the command envelope.
 */
export async function saveStaffPositions(
  db: Db,
  branch: string,
  actor: string,
  command: z.infer<typeof StaffPositionsSaveCommand>,
) {
  if (!(await branchTemplatesWritable(db))) throw new BackofficeError('NOT_READY');
  const current = await readStaffPositions(db, branch);
  if (current.version !== command.expected_version) throw new BackofficeError('CONFLICT');
  const codes = new Set(command.positions.map((p) => p.code));
  if (current.positions.some((p) => !codes.has(p.code)))
    throw new BackofficeError('INVALID_REQUEST', 'POSITION_IN_USE');
  const version = current.version + 1;
  await db.query(
    `INSERT INTO bo_branch_templates(branch_id,kind,version,body,created_by)
     VALUES($1,'staff_positions',$2,$3,$4)`,
    [branch, version, { positions: command.positions }, actor],
  );
  return { version, positions: command.positions };
}

/**
 * The position fields of a card being saved while the flag is on: the position and the extra
 * stations exist in the list in force and are active, unless the card already had them (a
 * position made inactive later stays on its cards).
 */
export function assertEmployeePositions(
  positions: readonly StaffPosition[],
  payload: Record<string, unknown>,
  old: Record<string, unknown> | null,
) {
  const known = new Map(positions.map((p) => [p.code, p]));
  const had = new Set(
    [old?.['position_code'], ...((old?.['extra_position_codes'] as unknown[]) ?? [])].filter(
      (v): v is string => typeof v === 'string',
    ),
  );
  const wanted = [
    payload['position_code'],
    ...((payload['extra_position_codes'] as unknown[]) ?? []),
  ].filter((v): v is string => typeof v === 'string');
  for (const c of wanted) {
    const p = known.get(c);
    if (!p || (!p.active && !had.has(c)))
      throw new BackofficeError('INVALID_REQUEST', 'POSITION_UNKNOWN');
  }
}
/**
 * With the flag off: the position fields of an incoming card payload that are exactly the ones
 * the stored card has are dropped before the strict check (they are kept by
 * keepEmployeePositions), so an editor that sends the whole card back is not refused after a
 * rollback. Any other payload is returned as it is (cards without position fields: the cloud
 * lane's behaviour).
 */
export function stripKeptPositions(
  input: unknown,
  old: Record<string, unknown> | null | undefined,
) {
  if (!old || !input || typeof input !== 'object' || Array.isArray(input)) return input;
  const value = input as Record<string, unknown>;
  if (!EMPLOYEE_P1_KEYS.some((k) => k in value)) return input;
  const out = { ...value };
  for (const k of EMPLOYEE_P1_KEYS)
    if (k in out && k in old && JSON.stringify(out[k]) === JSON.stringify(old[k])) delete out[k];
  return out;
}
/**
 * The payload to store: the parsed one, plus the position fields of the old card that the new
 * payload does not name (a cabinet without positions never wipes them).
 */
export function keepEmployeePositions(
  payload: Record<string, unknown>,
  old: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!old || !EMPLOYEE_P1_KEYS.some((k) => k in old && !(k in payload))) return payload;
  const out = { ...payload };
  for (const k of EMPLOYEE_P1_KEYS) if (k in old && !(k in out)) out[k] = old[k];
  return out;
}

export type RosterEntry = {
  employee_id: string;
  name: string;
  position_code: string | null;
  pos_access: PosAccess;
  /** Edge role of the account the card should have, or null (no access, not working, removed). */
  role: 'cashier' | 'shift_manager' | null;
  edge_staff_id: string | null;
  active: boolean;
};
/** Canonical content of a roster (fixed key order), the bytes its sha256 covers. */
export function rosterCanonical(branch: string, staff: readonly RosterEntry[]): string {
  return JSON.stringify({
    schema_version: 1,
    branch_id: branch,
    staff: staff.map((s) => ({
      employee_id: s.employee_id,
      name: s.name,
      position_code: s.position_code,
      pos_access: s.pos_access,
      role: s.role,
      edge_staff_id: s.edge_staff_id,
      active: s.active,
    })),
  });
}
export const rosterDigest = (branch: string, staff: readonly RosterEntry[]) =>
  createHash('sha256').update(rosterCanonical(branch, staff)).digest('hex');
/** One roster entry of an employee card (bo_records kind employee). */
export function rosterEntry(id: string, payload: Record<string, unknown>): RosterEntry {
  const access = (POS_ACCESS as readonly string[]).includes(String(payload['pos_access']))
    ? (payload['pos_access'] as PosAccess)
    : 'none';
  const active = payload['active'] === true && payload['deleted'] !== true;
  const role = active && access !== 'none' ? access : null;
  const employee = id.toLowerCase();
  return {
    employee_id: employee,
    name: String(payload['name'] ?? ''),
    position_code: typeof payload['position_code'] === 'string' ? payload['position_code'] : null,
    pos_access: access,
    role,
    edge_staff_id: role ? edgeStaffId(employee, role) : null,
    active,
  };
}
/** GET .../ops/staff-roster: every card of the branch, the file for the edge scripts. */
export async function readStaffRoster(db: Db, branch: string, now: Date) {
  const cards = (
    await db.query<{ id: string; payload: Record<string, unknown> }>(
      `SELECT id::text AS id,payload FROM bo_records WHERE branch_id=$1 AND kind='employee'
       ORDER BY id LIMIT 1001`,
      [branch],
    )
  ).rows;
  if (cards.length > 1000) throw new BackofficeError('NOT_READY');
  const staff = cards.map((c) => rosterEntry(c.id, c.payload));
  const positions = await readStaffPositions(db, branch);
  return {
    schema_version: 1 as const,
    branch_id: branch,
    generated_at: now.toISOString(),
    positions_version: positions.version,
    staff,
    sha256: rosterDigest(branch, staff),
  };
}
