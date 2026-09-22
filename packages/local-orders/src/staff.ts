import { randomBytes, randomUUID } from 'node:crypto';
import {
  StaffSetupSchema,
  StaffSessionSchema,
  StaffCredentialSchema,
  UuidSchema,
} from '@pickchick/contracts';
import type { StaffSession } from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { hashToken } from '@pickchick/menu-sync';
import { OrderError } from './errors.js';

export interface StaffAuth {
  sessionId: string;
  token: string;
}
export async function audit(
  client: DatabaseClient,
  branchId: string,
  staffId: string,
  action: string,
  resourceId: string,
) {
  await client.query(
    'INSERT INTO local_audit(id,branch_id,staff_id,action,resource_id) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), branchId, staffId, action, resourceId],
  );
}

// Trusted localhost operator command, not a public login/provisioning endpoint.
export async function provisionStaff(pool: DatabasePool, branchId: string, input: unknown) {
  const parsed = StaffSetupSchema.safeParse(input);
  if (!parsed.success || !UuidSchema.safeParse(branchId).success)
    throw new OrderError('INVALID_REQUEST');
  const setup = parsed.data;
  return transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO local_staff(id,branch_id,name,role,access_expires_at)
      VALUES ($1,$2,$3,$4,clock_timestamp() + interval '8 hours') ON CONFLICT DO NOTHING`,
      [setup.staff_id, branchId, setup.name, setup.role],
    );
    const existing = await client.query('SELECT * FROM local_staff WHERE id = $1 FOR UPDATE', [
      setup.staff_id,
    ]);
    const staff = existing.rows[0];
    if (!staff || staff.branch_id !== branchId || staff.role !== setup.role || !staff.active)
      throw new OrderError('CONFLICT');
    await client.query(
      'INSERT INTO local_terminals(id,branch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [setup.terminal_id, branchId],
    );
    const terminal = await client.query('SELECT * FROM local_terminals WHERE id = $1 FOR UPDATE', [
      setup.terminal_id,
    ]);
    if (terminal.rows[0]?.branch_id !== branchId || !terminal.rows[0]?.active)
      throw new OrderError('CONFLICT');
    await client.query(
      `UPDATE local_staff SET access_expires_at = clock_timestamp() + interval '8 hours' WHERE id = $1`,
      [setup.staff_id],
    );
    await client.query(
      'UPDATE staff_sessions SET revoked = true WHERE staff_id = $1 AND terminal_id = $2',
      [setup.staff_id, setup.terminal_id],
    );
    const sessionId = randomUUID(),
      token = randomBytes(32).toString('hex');
    const result = await client.query(
      `INSERT INTO staff_sessions(id,staff_id,terminal_id,branch_id,token_hash,expires_at)
      SELECT $1,id,$2,branch_id,$3,access_expires_at FROM local_staff WHERE id = $4 RETURNING expires_at`,
      [sessionId, setup.terminal_id, hashToken(token), setup.staff_id],
    );
    await audit(client, branchId, setup.staff_id, 'staff.session_issued', sessionId);
    return StaffCredentialSchema.parse({
      session_id: sessionId,
      staff_id: setup.staff_id,
      terminal_id: setup.terminal_id,
      branch_id: branchId,
      role: setup.role,
      name: staff.name,
      token,
      expires_at: result.rows[0].expires_at.toISOString(),
    });
  });
}

export async function revokeStaff(pool: DatabasePool, branchId: string, staffId: string) {
  if (!UuidSchema.safeParse(staffId).success) throw new OrderError('INVALID_REQUEST');
  await transaction(pool, async (client) => {
    const changed = await client.query(
      'UPDATE local_staff SET active = false WHERE id = $1 AND branch_id = $2 AND active RETURNING id',
      [staffId, branchId],
    );
    if (changed.rowCount) await audit(client, branchId, staffId, 'staff.revoked', staffId);
  });
}

export async function authenticateStaff(
  client: DatabaseClient,
  branchId: string,
  auth: StaffAuth,
): Promise<StaffSession> {
  if (!UuidSchema.safeParse(auth.sessionId).success || !/^[a-f0-9]{64}$/.test(auth.token))
    throw new OrderError('UNAUTHORIZED');
  // Same lock order as renewal: staff -> terminal -> session. Recheck credentials
  // after acquiring locks; the initial read only discovers the locking identities.
  const candidate = (
    await client.query(
      'SELECT staff_id, terminal_id FROM staff_sessions WHERE id=$1 AND token_hash=$2 AND branch_id=$3',
      [auth.sessionId, hashToken(auth.token), branchId],
    )
  ).rows[0];
  if (!candidate) throw new OrderError('UNAUTHORIZED');
  await client.query('SELECT id FROM local_staff WHERE id=$1 AND branch_id=$2 FOR SHARE', [
    candidate.staff_id,
    branchId,
  ]);
  await client.query('SELECT id FROM local_terminals WHERE id=$1 AND branch_id=$2 FOR SHARE', [
    candidate.terminal_id,
    branchId,
  ]);
  const result = await client.query(
    `SELECT s.id AS session_id, s.staff_id, s.terminal_id, s.branch_id, g.role, g.name,
    least(s.expires_at,g.access_expires_at) AS expires_at FROM staff_sessions s
    JOIN local_staff g ON g.id = s.staff_id AND g.branch_id = s.branch_id
    JOIN local_terminals t ON t.id = s.terminal_id AND t.branch_id = s.branch_id
    WHERE s.id = $1 AND s.token_hash = $2 AND s.branch_id = $3 AND NOT s.revoked AND g.active AND t.active
      AND s.expires_at > clock_timestamp() AND g.access_expires_at > clock_timestamp() FOR SHARE OF s`,
    [auth.sessionId, hashToken(auth.token), branchId],
  );
  if (!result.rows[0]) throw new OrderError('UNAUTHORIZED');
  return StaffSessionSchema.parse({
    ...result.rows[0],
    expires_at: result.rows[0].expires_at.toISOString(),
  });
}
export function requirePermission(
  session: StaffSession,
  permission: 'checkout' | 'manage' | 'read',
) {
  if (session.role === 'kitchen' || (permission === 'manage' && session.role !== 'shift_manager'))
    throw new OrderError('FORBIDDEN');
}
export function readSession(pool: DatabasePool, branchId: string, auth: StaffAuth) {
  return transaction(pool, (client) => authenticateStaff(client, branchId, auth));
}
