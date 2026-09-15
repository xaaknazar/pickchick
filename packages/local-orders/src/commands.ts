import { UuidSchema } from '@pickchick/contracts';
import type { StaffSession } from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { hashJson } from '@pickchick/menu-sync';
import { authenticateStaff, requirePermission } from './staff.js';
import type { StaffAuth } from './staff.js';
import { OrderError } from './errors.js';

export interface BranchState {
  id: string;
  ordering_enabled: boolean;
  ordering_version: number;
}
export async function lockBranch(client: DatabaseClient, branchId: string): Promise<BranchState> {
  const result = await client.query<BranchState>(
    'SELECT id, ordering_enabled, ordering_version FROM branch_config WHERE id = $1 FOR UPDATE',
    [branchId],
  );
  if (!result.rows[0]) throw new OrderError('BRANCH_UNAVAILABLE');
  return result.rows[0];
}
export async function command<T>(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  permission: 'checkout' | 'manage',
  type: string,
  key: string,
  input: unknown,
  run: (client: DatabaseClient, actor: StaffSession, branch: BranchState) => Promise<T>,
): Promise<T> {
  if (!UuidSchema.safeParse(key).success) throw new OrderError('INVALID_REQUEST');
  return transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, permission);
    const branch = await lockBranch(client, branchId);
    const scope = [branchId, actor.staff_id, actor.terminal_id, type, key];
    const old = await client.query(
      `SELECT request_hash, result FROM local_command_results
      WHERE branch_id=$1 AND staff_id=$2 AND terminal_id=$3 AND command_type=$4 AND idempotency_key=$5`,
      scope,
    );
    if (old.rows[0]) {
      if (old.rows[0].request_hash !== hashJson(input)) throw new OrderError('CONFLICT');
      return old.rows[0].result as T;
    }
    const result = await run(client, actor, branch);
    await client.query(
      `INSERT INTO local_command_results(branch_id,staff_id,terminal_id,command_type,idempotency_key,request_hash,result)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [...scope, hashJson(input), result],
    );
    return result;
  });
}
