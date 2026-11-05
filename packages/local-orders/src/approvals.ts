import { randomBytes, randomUUID } from 'node:crypto';
import { ManagerApprovalRequestSchema, ManagerApprovalSchema } from '@pickchick/contracts';
import type {
  ManagerApproval,
  ManagerApprovalAction,
  PosApprovalProof,
  StaffSession,
} from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { hashJson, hashToken } from '@pickchick/menu-sync';
import { audit, authenticateStaff, requirePermission } from './staff.js';
import type { StaffAuth } from './staff.js';
import { verifyStaffPin } from './staff-passwords.js';
import { OrderError } from './errors.js';

/**
 * Edge schema026 is installed and this runtime role holds its grants (contracts 3.2.4): the new
 * runtime on an older edge answers 404 on the pos_sale routes and keeps everything else as before.
 */
export async function posSalesInstalled(client: DatabaseClient) {
  const installed = (
    await client.query<{ ready: boolean }>(
      `SELECT to_regclass('pos_sale_outbox') IS NOT NULL AND EXISTS(SELECT 1 FROM schema_migrations
         WHERE scope='edge' AND version='026_edge_pos_sales.sql') AS ready`,
    )
  ).rows[0]!.ready;
  if (!installed) return false;
  return (
    await client.query<{ ready: boolean }>(
      `SELECT has_table_privilege('pos_payment_methods','SELECT')
        AND has_table_privilege('pos_config_fetches','INSERT')
        AND has_table_privilege('local_manager_approvals','INSERT')
        AND has_table_privilege('pos_sales','INSERT')
        AND has_table_privilege('pos_sale_outbox','INSERT') AS ready`,
    )
  ).rows[0]!.ready;
}

/** What one approval is for: the action and its subject (order, quote or shift and the amount). */
export type ApprovalSubject =
  | { order_id: string; amount_minor: string }
  | { quote_id: string; amount_minor: string }
  | { shift_id: string; amount_minor: string };
export const approvalSubjectHash = (action: ManagerApprovalAction, subject: ApprovalSubject) =>
  hashJson({ action, subject });

/** A wrong manager PIN on this cash desk (the controller logs the terminal, never the PIN). */
export class ApprovalPinError extends OrderError {
  constructor(readonly terminalId: string) {
    super('UNAUTHORIZED');
  }
}

/**
 * POST staff/approvals (contracts 5.1, R13): the shift manager types their PIN on the cashier's
 * desk. The terminal is the session's; the PIN check has the backoff of staff/pin. The result is
 * a one-time token valid for 120 s, bound to this desk, the action and the subject hash; only its
 * SHA-256 is stored. Not a command(): replaying a request issues another approval (the unused one
 * expires), and the token never lands in local_command_results.
 */
export async function requestManagerApproval(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  input: unknown,
): Promise<ManagerApproval> {
  const parsed = ManagerApprovalRequestSchema.safeParse(input);
  if (!parsed.success) throw new OrderError('INVALID_REQUEST');
  const request = parsed.data;
  const requester = await transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'checkout');
    if (!(await posSalesInstalled(client))) throw new OrderError('NOT_FOUND');
    return actor;
  });
  let manager;
  try {
    manager = await verifyStaffPin(
      pool,
      branchId,
      requester.terminal_id,
      request.staff_id,
      request.pin,
    );
  } catch (error) {
    if (error instanceof OrderError && error.code === 'UNAUTHORIZED')
      throw new ApprovalPinError(requester.terminal_id);
    throw error;
  }
  if (manager.role !== 'shift_manager') throw new OrderError('FORBIDDEN');
  const token = randomBytes(32).toString('hex');
  return transaction(pool, async (client) => {
    // The cashier session may have ended during the PIN work.
    const actor = await authenticateStaff(client, branchId, auth);
    if (actor.terminal_id !== requester.terminal_id) throw new OrderError('UNAUTHORIZED');
    const id = randomUUID();
    // TTL POS_APPROVAL_TTL_SECONDS; the schema026 CHECK pins the same 120 s (created_at is the
    // trigger's clock, taken after this expression).
    let row;
    try {
      row = (
        await client.query<{ expires_at: Date }>(
          `INSERT INTO local_manager_approvals(id,branch_id,terminal_id,manager_staff_id,
           requested_by_staff_id,action,subject,subject_hash,token_hash,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+interval '120 seconds')
           RETURNING expires_at`,
          [
            id,
            branchId,
            actor.terminal_id,
            manager.staff_id,
            actor.staff_id,
            request.action,
            request.subject,
            approvalSubjectHash(request.action, request.subject),
            hashToken(token),
          ],
        )
      ).rows[0]!;
    } catch (error) {
      // The manager was deactivated or lost the role after the PIN check (schema026 guard).
      if ((error as { code?: string }).code === '23514') throw new OrderError('FORBIDDEN');
      throw error;
    }
    await audit(client, branchId, manager.staff_id, 'staff.approval_issued', id);
    return ManagerApprovalSchema.parse({
      approval_id: id,
      token,
      expires_at: row.expires_at.toISOString(),
      manager: { staff_id: manager.staff_id, name: manager.name },
    });
  });
}

export interface ConsumedApproval {
  approval_id: string;
  manager_staff_id: string;
  action: ManagerApprovalAction;
}
/**
 * Spends one approval inside the command transaction that needs it (contracts 5.1): the token,
 * this cash desk, the action and the subject must match, it must be unexpired and unused, and the
 * manager must still be an active shift manager. A command replayed with its Idempotency-Key
 * returns the stored result before this runs, so an approval is never spent twice.
 */
export async function consumeApproval(
  client: DatabaseClient,
  branchId: string,
  actor: StaffSession,
  commandKey: string,
  proof: PosApprovalProof | undefined,
  action: ManagerApprovalAction,
  subject: ApprovalSubject,
): Promise<ConsumedApproval> {
  if (!proof) throw new OrderError('APPROVAL_REQUIRED');
  const row = (
    await client.query(
      `SELECT a.id,a.terminal_id,a.manager_staff_id,a.action,a.subject_hash,a.token_hash,
       a.consumed_at IS NULL AS unused, a.expires_at>clock_timestamp() AS live,
       EXISTS(SELECT 1 FROM local_staff s WHERE s.id=a.manager_staff_id AND s.branch_id=a.branch_id
         AND s.role='shift_manager' AND s.active) AS manager_active
       FROM local_manager_approvals a WHERE a.id=$1 AND a.branch_id=$2 FOR UPDATE OF a`,
      [proof.approval_id, branchId],
    )
  ).rows[0];
  if (
    !row ||
    row.token_hash !== hashToken(proof.token) ||
    row.terminal_id !== actor.terminal_id ||
    row.action !== action ||
    row.subject_hash !== approvalSubjectHash(action, subject) ||
    !row.unused ||
    !row.live ||
    !row.manager_active
  )
    throw new OrderError('APPROVAL_INVALID');
  try {
    await client.query(
      'UPDATE local_manager_approvals SET consumed_at=clock_timestamp(),consumed_command_key=$2 WHERE id=$1',
      [row.id, commandKey],
    );
  } catch (error) {
    // Expired between the check and the write (schema026: consumed_at <= expires_at).
    if ((error as { code?: string }).code === '23514') throw new OrderError('APPROVAL_INVALID');
    throw error;
  }
  return { approval_id: row.id, manager_staff_id: row.manager_staff_id, action };
}
