import { z } from 'zod';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { transaction } from '@pickchick/database';
import { digest } from '@pickchick/edge-fulfillment';
import { TransportError } from './errors.js';
const uuid = z.uuid();
const amount = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const signed = z.string().regex(/^-?(0|[1-9][0-9]{0,29})$/);
const time = z.iso.datetime({ offset: true });
export const CashierReportSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    eventId: uuid,
    sequence: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .refine((v) => BigInt(v) <= 9223372036854775807n),
    entityId: uuid,
    kind: z.literal('shift'),
    payload: z.strictObject({
      shift_id: uuid,
      terminal_id: uuid,
      staff_id: uuid,
      state: z.enum(['open', 'closed']),
      opened_at: time,
      closed_at: time.nullable(),
      opening_cash_minor: amount,
      cash_in_minor: amount,
      cash_out_minor: amount,
      expected_cash_minor: amount,
      counted_cash_minor: amount.nullable(),
      discrepancy_minor: signed.nullable(),
    }),
  }),
  z.strictObject({
    eventId: uuid,
    sequence: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .refine((v) => BigInt(v) <= 9223372036854775807n),
    entityId: uuid,
    kind: z.literal('order'),
    payload: z.strictObject({
      order_id: uuid,
      cash_shift_id: uuid.nullable(),
      created_at: time,
      total_minor: amount,
      state: z.enum(['awaiting_payment', 'cancelled']),
      version: z.int().positive(),
      execution_mode: z.enum(['payment_required', 'unpaid_service']),
      kitchen_state: z
        .enum([
          'held',
          'accepted',
          'in_production',
          'ready',
          'handed_over',
          'cancel_requested',
          'cancelled',
          'released',
        ])
        .nullable(),
      display_number: amount.nullable(),
      lines: z
        .array(
          z.strictObject({
            variant_id: uuid,
            name: z.strictObject({ ru: z.string().max(200), kk: z.string().max(200) }),
            quantity: z.int().min(1).max(99),
            unit_price_minor: amount,
            total_minor: amount,
          }),
        )
        .min(1)
        .max(50),
    }),
  }),
]);
export const CashierReportsSchema = z
  .array(CashierReportSchema)
  .min(1)
  .max(25)
  .refine(
    (events) =>
      new Set(events.map((e) => e.eventId)).size === events.length &&
      new Set(events.map((e) => e.sequence)).size === events.length,
  )
  .refine((events) => Buffer.byteLength(JSON.stringify(events)) <= 48 * 1024);
export const CashierReportReceiptSchema = z.strictObject({
  eventIds: z.array(uuid).min(1).max(25),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export async function receiveCashierReports(
  db: DatabaseClient,
  branch: string,
  device: string,
  input: z.infer<typeof CashierReportsSchema>,
) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'cashier-report:' + branch,
  ]);
  for (const event of input) {
    const p = event.payload;
    if (
      event.entityId !== (event.kind === 'shift' ? event.payload.shift_id : event.payload.order_id)
    )
      throw new TransportError('INVALID_REQUEST');
    if (event.kind === 'shift') {
      const s = event.payload;
      if (
        [s.opening_cash_minor, s.expected_cash_minor, s.counted_cash_minor].some(
          (value) => value !== null && BigInt(value) > 9223372036854775807n,
        )
      )
        throw new TransportError('INVALID_REQUEST');
      if (
        BigInt(s.opening_cash_minor) + BigInt(s.cash_in_minor) - BigInt(s.cash_out_minor) !==
          BigInt(s.expected_cash_minor) ||
        (s.state === 'open'
          ? s.closed_at !== null || s.counted_cash_minor !== null || s.discrepancy_minor !== null
          : s.closed_at === null ||
            Date.parse(s.closed_at) < Date.parse(s.opened_at) ||
            s.counted_cash_minor === null ||
            s.discrepancy_minor === null ||
            BigInt(s.counted_cash_minor) - BigInt(s.expected_cash_minor) !==
              BigInt(s.discrepancy_minor))
      )
        throw new TransportError('INVALID_REQUEST');
    } else {
      const o = event.payload;
      if (
        o.version !== (o.state === 'awaiting_payment' ? 1 : 2) ||
        BigInt(o.total_minor) > 9223372036854775807n
      )
        throw new TransportError('INVALID_REQUEST');
      if (
        o.lines.some(
          (l) => BigInt(l.unit_price_minor) * BigInt(l.quantity) !== BigInt(l.total_minor),
        ) ||
        o.lines.reduce((sum, l) => sum + BigInt(l.total_minor), 0n) !== BigInt(o.total_minor)
      )
        throw new TransportError('INVALID_REQUEST');
    }
    const hash = digest(event);
    const prior = (
      await db.query(
        'SELECT * FROM cloud_cashier_report_inbox WHERE event_id=$1 OR (device_id=$2 AND sequence=$3)',
        [event.eventId, device, event.sequence],
      )
    ).rows;
    if (prior.length) {
      if (
        prior.length !== 1 ||
        prior[0].event_id !== event.eventId ||
        prior[0].branch_id !== branch ||
        prior[0].device_id !== device ||
        prior[0].payload_hash !== hash
      )
        throw new TransportError('CONFLICT');
      continue;
    }
    const table = event.kind === 'shift' ? 'cloud_cashier_shifts' : 'cloud_cashier_orders';
    const old = (await db.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [event.entityId]))
      .rows[0];
    if (old && (old.branch_id !== branch || old.device_id !== device))
      throw new TransportError('CONFLICT');
    if (old) {
      const identity =
        event.kind === 'shift'
          ? ['shift_id', 'terminal_id', 'staff_id', 'opened_at', 'opening_cash_minor']
          : ['order_id', 'cash_shift_id', 'created_at', 'total_minor', 'execution_mode', 'lines'];
      if (
        identity.some((k) => digest(old.payload[k]) !== digest((p as Record<string, unknown>)[k]))
      )
        throw new TransportError('CONFLICT');
      if (
        BigInt(event.sequence) > BigInt(old.sequence) &&
        event.kind === 'shift' &&
        old.payload.state === 'closed' &&
        digest(old.payload) !== digest(p)
      )
        throw new TransportError('CONFLICT');
      if (
        BigInt(event.sequence) > BigInt(old.sequence) &&
        event.kind === 'order' &&
        old.payload.state === 'cancelled' &&
        event.payload.state !== 'cancelled'
      )
        throw new TransportError('CONFLICT');
    }
    await db.query(
      'INSERT INTO cloud_cashier_report_inbox(event_id,branch_id,device_id,sequence,payload_hash) VALUES($1,$2,$3,$4,$5)',
      [event.eventId, branch, device, event.sequence, hash],
    );
    if (!old || BigInt(event.sequence) > BigInt(old.sequence)) {
      if (event.kind === 'shift')
        await db.query(
          `INSERT INTO cloud_cashier_shifts(id,branch_id,device_id,sequence,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET sequence=EXCLUDED.sequence,payload=EXCLUDED.payload,observed_at=clock_timestamp()`,
          [event.entityId, branch, device, event.sequence, p],
        );
      else
        await db.query(
          `INSERT INTO cloud_cashier_orders(id,branch_id,device_id,cash_shift_id,created_at,sequence,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET sequence=EXCLUDED.sequence,payload=EXCLUDED.payload,observed_at=clock_timestamp()`,
          [
            event.entityId,
            branch,
            device,
            event.payload.cash_shift_id,
            event.payload.created_at,
            event.sequence,
            p,
          ],
        );
    }
  }
  return { eventIds: input.map((e) => e.eventId), requestHash: digest(input) };
}
export async function pendingCashierReports(pool: DatabasePool, branch: string) {
  if (
    !(
      await pool.query(
        "SELECT 1 FROM schema_migrations WHERE scope='edge' AND version='016_edge_cashier_reports.sql'",
      )
    ).rowCount
  )
    return [];
  const rows = (
    await pool.query(
      "SELECT * FROM cashier_report_outbox WHERE branch_id=$1 AND acknowledged_at IS NULL AND last_error IS DISTINCT FROM 'INVALID_REPORT_SOURCE' ORDER BY sequence LIMIT 25",
      [branch],
    )
  ).rows;
  const events: z.infer<typeof CashierReportSchema>[] = [];
  for (const row of rows) {
    const parsed = CashierReportSchema.safeParse({
      eventId: row.event_id,
      sequence: row.sequence,
      kind: row.kind,
      entityId: row.entity_id,
      payload: row.payload,
    });
    if (!parsed.success) {
      await pool.query(
        "UPDATE cashier_report_outbox SET attempts=attempts+1,last_error='INVALID_REPORT_SOURCE' WHERE event_id=$1 AND acknowledged_at IS NULL",
        [row.event_id],
      );
      continue;
    }
    const event = parsed.data;
    if (Buffer.byteLength(JSON.stringify([event])) > 48 * 1024) {
      await pool.query(
        "UPDATE cashier_report_outbox SET attempts=attempts+1,last_error='INVALID_REPORT_SOURCE' WHERE event_id=$1 AND acknowledged_at IS NULL",
        [row.event_id],
      );
      continue;
    }
    if (Buffer.byteLength(JSON.stringify([...events, event])) > 48 * 1024) break;
    events.push(event);
  }
  return events;
}
export async function acknowledgeCashierReports(
  pool: DatabasePool,
  branch: string,
  reports: z.infer<typeof CashierReportsSchema>,
  receipt: z.infer<typeof CashierReportReceiptSchema>,
) {
  if (
    receipt.requestHash !== digest(reports) ||
    JSON.stringify(receipt.eventIds) !== JSON.stringify(reports.map((r) => r.eventId))
  )
    throw new TransportError('CONFLICT');
  await transaction(pool, async (db) => {
    for (const event of reports) {
      const r = await db.query(
        'UPDATE cashier_report_outbox SET acknowledged_at=coalesce(acknowledged_at,clock_timestamp()),last_error=NULL WHERE branch_id=$1 AND event_id=$2 AND sequence=$3 AND payload=$4::jsonb RETURNING event_id',
        [branch, event.eventId, event.sequence, event.payload],
      );
      if (r.rowCount !== 1) throw new TransportError('CONFLICT');
    }
  });
}
