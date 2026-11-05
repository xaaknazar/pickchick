import { z } from 'zod';
import { transaction, type DatabaseClient, type DatabasePool } from '@pickchick/database';
import { BackofficeError, parse, type Command } from './model.js';

/**
 * Back-office roles (cutover CC-5; contracts 5.10, 6.1; design-backoffice 4).
 *
 * bo_access_grants keeps its two roles: manager writes, analyst reads. Behind
 * BACKOFFICE_ROLES_ENABLED (default off) the operator may designate a personal login that has an
 * analyst grant as shift_manager or accountant of a branch (bo_role_designations, cloud074,
 * append-only, the latest row is in force):
 *
 *   effectiveRole = grant.manager ? 'manager' : (BACKOFFICE_ROLES_ENABLED ? designation : null) ?? 'analyst'
 *
 * With the flag off nothing here reads the database and every role is exactly the grant role, so
 * manager and analyst keep today's rights and errors (FORBIDDEN without a reason). A designated
 * role that lacks a permission gets FORBIDDEN with reason ROLE_FORBIDDEN.
 */

/** Verbatim copy of BackofficeDesignationSchema (packages/contracts/src/cutover-enums.ts). */
export const BACKOFFICE_DESIGNATIONS = ['shift_manager', 'accountant'] as const;
/** Verbatim copy of BackofficeEffectiveRoleSchema (packages/contracts/src/cutover-enums.ts). */
export const BACKOFFICE_EFFECTIVE_ROLES = [
  'manager',
  'shift_manager',
  'accountant',
  'analyst',
] as const;
export type BackofficeDesignation = (typeof BACKOFFICE_DESIGNATIONS)[number];
export type BackofficeEffectiveRole = (typeof BACKOFFICE_EFFECTIVE_ROLES)[number];
export type BackofficeGrantRole = 'manager' | 'analyst';

/** Every action the back-office API checks. The list order is the order of `permissions[]`. */
export const BACKOFFICE_PERMISSIONS = [
  /** GET branches/:id, order cards, stop lists, ops views: every role. */
  'reports.read',
  /** Management finance ledger (ДДС/ОПиУ). */
  'finance.read',
  'finance.write',
  /** Daily payment reconciliation. */
  'reconciliation.read',
  'reconciliation.write',
  /** Schedule, time sheet, hourly rates and payroll. */
  'workforce.read',
  'workforce.write',
  /** Back-office records (menu content, promo, stations, employees, tickets, ...) and publishing. */
  'records.write',
  'devices.write',
  'restore_reviews.write',
  /** Stop/unstop on the cashier edge and in the cloud channels. */
  'stops.write',
  /** Cancel an unpaid cloud order. */
  'orders.cancel',
  /** Refunds of cloud orders: manual Kaspi Pay refunds (У3), adapter requests and withdrawals. */
  'orders.refund',
  'stock.receipt',
  'stock.waste',
  'stock.count',
  /** Production by a recipe and consumption by a cloud order. */
  'stock.production',
] as const;
export type BackofficePermission = (typeof BACKOFFICE_PERMISSIONS)[number];

/**
 * P0 matrix (contracts 5.10): manager - everything; shift_manager - cancellations of cloud
 * orders, manual refunds, receipt/waste/count, stops, reports, without finance, reconciliation,
 * rates and payroll; accountant - finance and reconciliation (write), receipts, reports, without
 * cancellations, refunds and waste; analyst - read-only, as today.
 */
export const ROLE_PERMISSIONS: Readonly<
  Record<BackofficeEffectiveRole, readonly BackofficePermission[]>
> = Object.freeze({
  manager: BACKOFFICE_PERMISSIONS,
  shift_manager: Object.freeze([
    'reports.read',
    'stops.write',
    'orders.cancel',
    'orders.refund',
    'stock.receipt',
    'stock.waste',
    'stock.count',
  ] as const),
  accountant: Object.freeze([
    'reports.read',
    'finance.read',
    'finance.write',
    'reconciliation.read',
    'reconciliation.write',
    'workforce.read',
    'stock.receipt',
  ] as const),
  analyst: Object.freeze([
    'reports.read',
    'finance.read',
    'reconciliation.read',
    'workforce.read',
  ] as const),
});

export function effectiveRole(
  grant: BackofficeGrantRole,
  designation: BackofficeDesignation | null,
  rolesEnabled: boolean,
): BackofficeEffectiveRole {
  return grant === 'manager' ? 'manager' : ((rolesEnabled ? designation : null) ?? 'analyst');
}
export function can(role: BackofficeEffectiveRole, permission: BackofficePermission): boolean {
  return (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);
}
/** permissions[] of GET branches/:id, in BACKOFFICE_PERMISSIONS order. */
export function permissionsOf(role: BackofficeEffectiveRole): BackofficePermission[] {
  return BACKOFFICE_PERMISSIONS.filter((permission) => can(role, permission));
}
/**
 * FORBIDDEN unless `role` has `permission`. Manager and analyst keep the bare FORBIDDEN of today;
 * a designated role is told why (ROLE_FORBIDDEN).
 */
export function requirePermission(
  role: BackofficeEffectiveRole,
  permission: BackofficePermission,
): void {
  if (can(role, permission)) return;
  throw new BackofficeError(
    'FORBIDDEN',
    role === 'shift_manager' || role === 'accountant' ? 'ROLE_FORBIDDEN' : undefined,
  );
}

/** The permission a POST .../commands command needs (one place, also for the UI matrix test). */
export function commandPermission(command: z.infer<typeof Command>): BackofficePermission {
  switch (command.type) {
    case 'save':
    case 'publish':
    case 'deliver_station_plan':
      return 'records.write';
    case 'stock':
      return command.kind === 'receipt'
        ? 'stock.receipt'
        : command.kind === 'waste'
          ? 'stock.waste'
          : 'stock.count';
    case 'produce':
    case 'consume':
      return 'stock.production';
    case 'revoke_device':
      return 'devices.write';
    case 'cancel_order':
      return 'orders.cancel';
    case 'refund':
    case 'manual_refund':
    case 'withdraw_refund':
      return 'orders.refund';
  }
}

type Db = Pick<DatabaseClient, 'query'>;
/** cloud074 is applied and the current database role may read the designations. */
export async function roleDesignationsReadable(db: Db): Promise<boolean> {
  const r = await db.query<{ ok: boolean | null }>(
    `SELECT to_regclass('bo_role_designations') IS NOT NULL
      AND has_table_privilege(current_user, to_regclass('bo_role_designations'), 'SELECT') AS ok`,
  );
  return r.rows[0]?.ok === true;
}
async function latestDesignation(db: Db, actorId: string, branchId: string) {
  const row = (
    await db.query<{ role: BackofficeDesignation | null }>(
      'SELECT role FROM bo_role_designations WHERE actor_id=$1 AND branch_id=$2 ORDER BY id DESC LIMIT 1',
      [actorId, branchId],
    )
  ).rows[0];
  return row?.role ?? null;
}
export type ResolvedRole = {
  role: BackofficeEffectiveRole;
  /** BACKOFFICE_ROLES_ENABLED and cloud074 readable: designations are in force. */
  designations: boolean;
};
/**
 * The effective role of an actor whose grant was already checked. With the flag off this never
 * touches the database (a runtime on a schema without 074 behaves exactly as before).
 */
export async function resolveBackofficeRole(
  db: Db,
  actorId: string,
  branchId: string,
  grant: BackofficeGrantRole,
  rolesEnabled: boolean,
): Promise<ResolvedRole> {
  if (!rolesEnabled) return { role: grant, designations: false };
  const designations = await roleDesignationsReadable(db);
  const designation =
    designations && grant !== 'manager' ? await latestDesignation(db, actorId, branchId) : null;
  return { role: effectiveRole(grant, designation, designations), designations };
}

const DesignationInput = z.enum(BACKOFFICE_DESIGNATIONS).nullable();
const Reason = z.string().trim().min(3).max(500);
/**
 * Trusted local setup only (scripts/backoffice-setup.mjs --designation, run with the owner
 * database URL). Appends a designation for an actor that already has a grant on the branch;
 * `null` withdraws it. A manager grant always wins, so designating a manager is refused.
 */
export async function designateBackoffice(
  pool: DatabasePool,
  actorId: string,
  branchId: string,
  designation: BackofficeDesignation | null,
  reason: string,
) {
  parse(z.uuid(), actorId);
  parse(z.uuid(), branchId);
  const role = parse(DesignationInput, designation);
  const text = parse(Reason, reason);
  return transaction(pool, async (db) => {
    // Same lock as grantBackoffice: a grant change and a designation never interleave.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'bo:grant:' + actorId + ':' + branchId,
    ]);
    if (!(await db.query("SELECT to_regclass('bo_role_designations') IS NOT NULL ok")).rows[0].ok)
      throw new BackofficeError('NOT_READY');
    const grant = (
      await db.query<{ role: BackofficeGrantRole }>(
        'SELECT g.role FROM bo_access_grants g JOIN catalog_manager_branches s ON s.actor_id=g.actor_id AND s.branch_id=g.branch_id WHERE g.actor_id=$1 AND g.branch_id=$2 FOR SHARE OF g,s',
        [actorId, branchId],
      )
    ).rows[0];
    if (!grant) throw new BackofficeError('FORBIDDEN');
    if (role !== null && grant.role === 'manager') throw new BackofficeError('CONFLICT');
    const previous = await latestDesignation(db, actorId, branchId);
    const row = (
      await db.query<{ id: string; created_at: Date }>(
        `INSERT INTO bo_role_designations(actor_id,branch_id,role,reason) VALUES($1,$2,$3,$4)
         RETURNING id::text,created_at`,
        [actorId, branchId, role, text],
      )
    ).rows[0]!;
    return {
      id: row.id,
      actor_id: actorId,
      branch_id: branchId,
      grant: grant.role,
      previous_role: previous,
      role,
      created_at: row.created_at.toISOString(),
    };
  });
}
