import { z } from 'zod';
import { transaction, type DatabaseClient, type DatabasePool } from '@pickchick/database';
import { BackofficeError, parse, type Command } from './model.js';

/**
 * Back-office roles (cutover CC-5; contracts 5.10, 6.1; design-backoffice 4).
 *
 * bo_access_grants keeps its two roles: manager writes, analyst reads. Behind
 * BACKOFFICE_ROLES_ENABLED (default off) the operator may designate a personal login that has an
 * analyst grant as shift_manager or accountant of a branch (bo_role_designations, cloud074,
 * append-only, the latest row is in force until the actor's grant role changes):
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
 * Back-office P1 permissions (lane bo-ui, design-bo-ui 4), never part of BACKOFFICE_PERMISSIONS:
 * a P1 permission is checked only by a P1 command and listed in permissions[] only while its
 * feature is available (design-bo-ui 2 rule 5), so the P0 matrix stays the cloud lane's.
 */
export const BACKOFFICE_P1_PERMISSIONS = [
  /** Storno of a stock document (stock P1, BACKOFFICE_STOCK_V2_ENABLED with cloud075). */
  'stock.reverse',
  /** Menu-stock links: edit a link (menu_link_save) and approve links for the chef (stock P1). */
  'menu_links.write',
  'menu_links.approve',
  /** Branch mode of the automatic consumption (BACKOFFICE_STOCK_AUTOCONSUME_ENABLED). */
  'stock.settings',
  /** Retry or skip a queued consumption (BACKOFFICE_STOCK_AUTOCONSUME_ENABLED). */
  'consumption.write',
] as const;
export type BackofficeP1Permission = (typeof BACKOFFICE_P1_PERMISSIONS)[number];
export type BackofficeAnyPermission = BackofficePermission | BackofficeP1Permission;

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
/**
 * P1 matrix (design-bo-ui 4): storno by the manager and the accountant (design-backoffice 4
 * table, design-bo-ui 8 q2; the shift manager only if the owner says so); links and the branch
 * mode by the manager only (the chef approves through the manager); retry and skip of a queued
 * consumption by the manager and the shift manager.
 */
export const P1_ROLE_PERMISSIONS: Readonly<
  Record<BackofficeEffectiveRole, readonly BackofficeP1Permission[]>
> = Object.freeze({
  manager: BACKOFFICE_P1_PERMISSIONS,
  shift_manager: Object.freeze(['consumption.write'] as const),
  accountant: Object.freeze(['stock.reverse'] as const),
  analyst: Object.freeze([] as const),
});

export function effectiveRole(
  grant: BackofficeGrantRole,
  designation: BackofficeDesignation | null,
  rolesEnabled: boolean,
): BackofficeEffectiveRole {
  return grant === 'manager' ? 'manager' : ((rolesEnabled ? designation : null) ?? 'analyst');
}
export function can(role: BackofficeEffectiveRole, permission: BackofficeAnyPermission): boolean {
  return (
    (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission) ||
    (P1_ROLE_PERMISSIONS[role] as readonly string[]).includes(permission)
  );
}
/**
 * permissions[] of GET branches/:id, in BACKOFFICE_PERMISSIONS order, then the P1 permissions of
 * the features listed in `p1` (none by default: the cloud lane's list).
 */
export function permissionsOf(
  role: BackofficeEffectiveRole,
  p1: readonly BackofficeP1Permission[] = [],
): BackofficeAnyPermission[] {
  return [
    ...BACKOFFICE_PERMISSIONS.filter((permission) => can(role, permission)),
    ...BACKOFFICE_P1_PERMISSIONS.filter(
      (permission) => p1.includes(permission) && can(role, permission),
    ),
  ];
}
/**
 * FORBIDDEN unless `role` has `permission`. Manager and analyst keep the bare FORBIDDEN of today;
 * a designated role is told why (ROLE_FORBIDDEN).
 */
export function requirePermission(
  role: BackofficeEffectiveRole,
  permission: BackofficeAnyPermission,
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
/**
 * cloud074 is applied and the current database role may read the designations and the grant
 * audit they are checked against (bo_access_audit, read by the back-office role since cloud017).
 */
export async function roleDesignationsReadable(db: Db): Promise<boolean> {
  const r = await db.query<{ ok: boolean | null }>(
    `SELECT to_regclass('bo_role_designations') IS NOT NULL
      AND has_table_privilege(current_user, to_regclass('bo_role_designations'), 'SELECT')
      AND to_regclass('bo_access_audit') IS NOT NULL
      AND has_table_privilege(current_user, to_regclass('bo_access_audit'), 'SELECT') AS ok`,
  );
  return r.rows[0]?.ok === true;
}
/**
 * The designation in force: the latest row of the actor on the branch, and only while it is
 * newer than the last change of the actor's grant role there (bo_access_audit rows whose role
 * differs from previous_role; both are written under the same advisory lock). A grant change
 * ends a designation, so an analyst promoted to manager and demoted again is an analyst until
 * the operator designates anew. Re-recording the same grant role changes nothing.
 */
async function designationInForce(db: Db, actorId: string, branchId: string) {
  const row = (
    await db.query<{ role: BackofficeDesignation | null; current: boolean }>(
      `SELECT d.role,d.created_at > coalesce((SELECT max(a.created_at) FROM bo_access_audit a
         WHERE a.actor_id=$1 AND a.branch_id=$2 AND a.previous_role IS DISTINCT FROM a.role),
         '-infinity'::timestamptz) AS current
       FROM bo_role_designations d WHERE d.actor_id=$1 AND d.branch_id=$2 ORDER BY d.id DESC LIMIT 1`,
      [actorId, branchId],
    )
  ).rows[0];
  return row?.current ? row.role : null;
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
    designations && grant !== 'manager' ? await designationInForce(db, actorId, branchId) : null;
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
    const previous = await designationInForce(db, actorId, branchId);
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
