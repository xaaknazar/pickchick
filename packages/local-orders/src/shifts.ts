import { randomUUID } from 'node:crypto';
import {
  CashShiftOpenSchema,
  CashMovementInputSchema,
  CashShiftCloseSchema,
  CashShiftSchema,
  CashShiftCurrentSchema,
  CashShiftListSchema,
  UuidSchema,
} from '@pickchick/contracts';
import type { StaffSession } from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { authenticateStaff, requirePermission, audit } from './staff.js';
import type { StaffAuth } from './staff.js';
import { command, lockBranch } from './commands.js';
import { OrderError } from './errors.js';

async function report(client: DatabaseClient, branchId: string, shiftId: string) {
  const result = (
    await client.query(
      `SELECT count(*)::text AS order_count,
    count(*) FILTER(WHERE state='awaiting_payment')::text AS awaiting_payment_count,
    count(*) FILTER(WHERE state='cancelled')::text AS cancelled_count,
    coalesce(sum(total_minor),0)::text AS order_total_minor,
    coalesce(sum(total_minor) FILTER(WHERE state='awaiting_payment'),0)::text AS unpaid_total_minor,
    clock_timestamp() AS report_at FROM local_orders WHERE branch_id=$1 AND cash_shift_id=$2`,
      [branchId, shiftId],
    )
  ).rows[0];
  return {
    ...result,
    order_count: Number(result.order_count),
    awaiting_payment_count: Number(result.awaiting_payment_count),
    cancelled_count: Number(result.cancelled_count),
    cash_received_minor: '0' as const,
    cash_refunded_minor: '0' as const,
    payment_processing_available: false as const,
    report_at: result.report_at.toISOString(),
  };
}

export async function loadCashShift(
  client: DatabaseClient,
  branchId: string,
  actor: StaffSession,
  shiftId: string,
) {
  const row = (
    await client.query(
      `SELECT * FROM local_cash_shifts WHERE id=$1 AND branch_id=$2
    AND ($3::boolean OR (terminal_id=$5 AND $4::uuid IS NOT NULL))`,
      [shiftId, branchId, actor.role === 'shift_manager', actor.staff_id, actor.terminal_id],
    )
  ).rows[0];
  if (!row) throw new OrderError('NOT_FOUND');
  return CashShiftSchema.parse({
    shift_id: row.id,
    branch_id: row.branch_id,
    terminal_id: row.terminal_id,
    staff_id: row.staff_id,
    version: row.version,
    state: row.state,
    opened_at: row.opened_at.toISOString(),
    closed_at: row.closed_at?.toISOString() ?? null,
    closed_by_staff_id: row.closed_by_staff_id,
    opening_cash_minor: row.opening_cash_minor,
    ...(await drawer(client, branchId, shiftId, row.opening_cash_minor)),
    counted_cash_minor: row.counted_cash_minor,
    discrepancy_minor: row.discrepancy_minor,
    closing_reason: row.closing_reason,
    currency: 'KZT',
    ...(row.closed_report ?? (await report(client, branchId, shiftId))),
  });
}

export async function requireOpenCashShift(
  client: DatabaseClient,
  branchId: string,
  actor: StaffSession,
) {
  const row = (
    await client.query(
      `SELECT id FROM local_cash_shifts
    WHERE branch_id=$1 AND terminal_id=$2 AND state='open' AND $3::uuid IS NOT NULL FOR UPDATE`,
      [branchId, actor.terminal_id, actor.staff_id],
    )
  ).rows[0];
  if (!row) throw new OrderError('CASH_SHIFT_REQUIRED');
  return row as { id: string };
}

export function openCashShift(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  key: string,
  input: unknown,
) {
  const parsed = CashShiftOpenSchema.safeParse(input);
  if (!parsed.success) throw new OrderError('INVALID_REQUEST');
  return command(
    pool,
    branchId,
    auth,
    'manage',
    'cash_shift.open',
    key,
    parsed.data,
    async (client, actor) => {
      const old = await client.query(
        "SELECT id FROM local_cash_shifts WHERE branch_id=$1 AND terminal_id=$2 AND state='open'",
        [branchId, actor.terminal_id],
      );
      if (old.rowCount) throw new OrderError('CONFLICT');
      const id = randomUUID();
      await client.query(
        `INSERT INTO local_cash_shifts(id,branch_id,staff_id,terminal_id,opening_cash_minor)
      VALUES($1,$2,$3,$4,$5)`,
        [id, branchId, actor.staff_id, actor.terminal_id, parsed.data.opening_cash_minor],
      );
      await audit(client, branchId, actor.staff_id, 'cash_shift.opened', id);
      return loadCashShift(client, branchId, actor, id);
    },
  );
}

export function closeCashShift(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  key: string,
  shiftId: string,
  input: unknown,
) {
  const parsed = CashShiftCloseSchema.safeParse(input);
  if (!parsed.success || !UuidSchema.safeParse(shiftId).success)
    throw new OrderError('INVALID_REQUEST');
  return command(
    pool,
    branchId,
    auth,
    'manage',
    'cash_shift.close',
    key,
    { shift_id: shiftId, ...parsed.data },
    async (client, actor) => {
      const old = await loadCashShift(client, branchId, actor, shiftId);
      if (old.state !== 'open' || old.version !== parsed.data.expected_version)
        throw new OrderError('CONFLICT');
      const snapshot = {
        ...(await report(client, branchId, shiftId)),
        ...(await drawer(client, branchId, shiftId, old.opening_cash_minor)),
      };
      await client.query(
        `UPDATE local_cash_shifts SET state='closed',version=version+1,closed_at=clock_timestamp(),
      closed_by_staff_id=$3,counted_cash_minor=$4,discrepancy_minor=$4::bigint-($6::jsonb->>'expected_cash_minor')::bigint,
      closing_reason=$5,closed_report=$6 WHERE id=$1 AND branch_id=$2`,
        [
          shiftId,
          branchId,
          actor.staff_id,
          parsed.data.counted_cash_minor,
          parsed.data.reason,
          snapshot,
        ],
      );
      await audit(client, branchId, actor.staff_id, 'cash_shift.closed', shiftId);
      return loadCashShift(client, branchId, actor, shiftId);
    },
  );
}

export function readCashShift(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  shiftId: string,
) {
  if (!UuidSchema.safeParse(shiftId).success) throw new OrderError('INVALID_REQUEST');
  return transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'read');
    await lockBranch(client, branchId);
    return loadCashShift(client, branchId, actor, shiftId);
  });
}

export function currentCashShift(pool: DatabasePool, branchId: string, auth: StaffAuth) {
  return transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'read');
    await lockBranch(client, branchId);
    const row = (
      await client.query(
        `SELECT id FROM local_cash_shifts WHERE branch_id=$1
      AND $2::uuid IS NOT NULL AND terminal_id=$3 AND state='open'`,
        [branchId, actor.staff_id, actor.terminal_id],
      )
    ).rows[0];
    const shift = row ? await loadCashShift(client, branchId, actor, row.id) : null;
    const time = (await client.query('SELECT clock_timestamp() AS time')).rows[0].time;
    return CashShiftCurrentSchema.parse({ shift, server_time: time.toISOString() });
  });
}

export function listCashShifts(pool: DatabasePool, branchId: string, auth: StaffAuth) {
  return transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'read');
    await lockBranch(client, branchId);
    const rows = await client.query(
      `SELECT id FROM local_cash_shifts WHERE branch_id=$1
      AND ($2::boolean OR (terminal_id=$4 AND $3::uuid IS NOT NULL)) ORDER BY opened_at DESC,id DESC LIMIT 50`,
      [branchId, actor.role === 'shift_manager', actor.staff_id, actor.terminal_id],
    );
    const shifts = [];
    for (const row of rows.rows) shifts.push(await loadCashShift(client, branchId, actor, row.id));
    const time = (await client.query('SELECT clock_timestamp() AS time')).rows[0].time;
    return CashShiftListSchema.parse({ shifts, server_time: time.toISOString() });
  });
}

async function drawer(client: DatabaseClient, branchId: string, shiftId: string, opening: string) {
  const rows = (
    await client.query(
      'SELECT id,staff_id,direction,amount_minor,reason,created_at FROM local_cash_movements WHERE branch_id=$1 AND shift_id=$2 ORDER BY created_at,id',
      [branchId, shiftId],
    )
  ).rows;
  return {
    expected_cash_minor: rows
      .reduce(
        (sum, row) => sum + (row.direction === 'in' ? 1n : -1n) * BigInt(row.amount_minor),
        BigInt(opening),
      )
      .toString(),
    cash_movements: rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() })),
  };
}
export function moveCash(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  key: string,
  shiftId: string,
  input: unknown,
) {
  const parsed = CashMovementInputSchema.safeParse(input);
  if (!parsed.success || !UuidSchema.safeParse(shiftId).success)
    throw new OrderError('INVALID_REQUEST');
  return command(
    pool,
    branchId,
    auth,
    'manage',
    'cash_shift.move',
    key,
    { shift_id: shiftId, ...parsed.data },
    async (client, actor) => {
      const shift = await loadCashShift(client, branchId, actor, shiftId);
      if (shift.state !== 'open') throw new OrderError('CASH_SHIFT_REQUIRED');
      if ((shift.cash_movements?.length ?? 0) >= 1000) throw new OrderError('INVALID_REQUEST');
      const amount = BigInt(parsed.data.amount_minor),
        next =
          BigInt(shift.expected_cash_minor) + (parsed.data.direction === 'in' ? amount : -amount);
      if (next < 0n || next > 9223372036854775807n) throw new OrderError('INVALID_REQUEST');
      await client.query(
        'INSERT INTO local_cash_movements(id,branch_id,shift_id,staff_id,direction,amount_minor,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          key,
          branchId,
          shiftId,
          actor.staff_id,
          parsed.data.direction,
          parsed.data.amount_minor,
          parsed.data.reason,
        ],
      );
      await audit(client, branchId, actor.staff_id, 'cash_shift.movement', key);
      return loadCashShift(client, branchId, actor, shiftId);
    },
  );
}
