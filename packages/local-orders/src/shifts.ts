import { randomUUID } from 'node:crypto';
import {
  CashShiftOpenSchema,
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
    AND ($3::boolean OR (staff_id=$4 AND terminal_id=$5))`,
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
    expected_cash_minor: row.opening_cash_minor,
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
    WHERE branch_id=$1 AND terminal_id=$2 AND staff_id=$3 AND state='open' FOR UPDATE`,
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
    'checkout',
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
    'checkout',
    'cash_shift.close',
    key,
    { shift_id: shiftId, ...parsed.data },
    async (client, actor) => {
      const old = await loadCashShift(client, branchId, actor, shiftId);
      if (old.state !== 'open' || old.version !== parsed.data.expected_version)
        throw new OrderError('CONFLICT');
      const snapshot = await report(client, branchId, shiftId);
      await client.query(
        `UPDATE local_cash_shifts SET state='closed',version=version+1,closed_at=clock_timestamp(),
      closed_by_staff_id=$3,counted_cash_minor=$4,discrepancy_minor=$4::bigint-opening_cash_minor,
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
      AND staff_id=$2 AND terminal_id=$3 AND state='open'`,
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
      AND ($2::boolean OR (staff_id=$3 AND terminal_id=$4)) ORDER BY opened_at DESC,id DESC LIMIT 50`,
      [branchId, actor.role === 'shift_manager', actor.staff_id, actor.terminal_id],
    );
    const shifts = [];
    for (const row of rows.rows) shifts.push(await loadCashShift(client, branchId, actor, row.id));
    const time = (await client.query('SELECT clock_timestamp() AS time')).rows[0].time;
    return CashShiftListSchema.parse({ shifts, server_time: time.toISOString() });
  });
}
