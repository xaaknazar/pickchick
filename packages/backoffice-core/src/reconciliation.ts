import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DatabasePool, type DatabaseClient } from '@pickchick/database';
import { catalogHash } from '@pickchick/catalog-admin';
import { digest } from '@pickchick/commerce-core';
import { BackofficeError, parse } from './model.js';
import {
  DayString,
  MappingSchema,
  METHOD_KEYS,
  METHODS,
  RESOLUTION_STATUSES,
  REC_TIMEZONE,
  SOURCE_LABELS,
  STATEMENT_MAX_CHARS,
  STATEMENT_MAX_ROWS,
  STATES,
  dayBounds,
  factKeys,
  methodOfProvider,
  normalizeKey,
  parseStatement,
  reconcileDay,
  shiftDay,
  businessDay,
  type DayReport,
  type Fact,
  type Line,
  type MethodKey,
  type Row,
  type Source,
} from './reconciliation-model.js';
export * from './reconciliation-model.js';

/**
 * Daily payment reconciliation for the accountant (BACKOFFICE_RECONCILIATION_ENABLED, default
 * off). Reads PickChick money facts, stores only external facts and the accountant's decisions,
 * never changes a capture, refund, order or fiscal document. Requires cloud migration 071 and
 * reconciliationGrants on the API role.
 */
export const RECONCILIATION = Symbol('RECONCILIATION');
export type ReconciliationReason =
  | 'RECONCILIATION_DISABLED'
  | 'RECONCILIATION_NOT_INSTALLED'
  | 'DAY_CLOSED'
  | 'DAY_NOT_CLOSED'
  | 'DAY_NOT_FINISHED'
  | 'DIFFERENCES_OPEN'
  | 'DUPLICATE_IMPORT'
  | 'STATEMENT_INVALID'
  | 'ITEM_CHANGED'
  | 'TOTAL_EXISTS'
  | 'REVISION_CHANGED'
  | 'ASSIGNEE_UNKNOWN'
  | 'PROFILE_NAME_TAKEN';
/** BackofficeError with a reconciliation reason, like CloudStopError. */
export class ReconciliationError extends BackofficeError {
  constructor(
    code: ConstructorParameters<typeof BackofficeError>[0],
    readonly detail?: ReconciliationReason,
  ) {
    super(code);
  }
}
const fail = (
  code: ConstructorParameters<typeof BackofficeError>[0],
  detail?: ReconciliationReason,
): never => {
  throw new ReconciliationError(code, detail);
};
export interface ReconciliationOptions {
  /** BACKOFFICE_RECONCILIATION_ENABLED; also needs BACKOFFICE_ENABLED. Default off. */
  enabled?: boolean;
  /** Test seam for "is the day over"; production uses the clock. */
  now?: () => Date;
}
export function reconciliationOptions(
  env: Record<string, string | undefined> = process.env,
): ReconciliationOptions {
  const value = env['BACKOFFICE_RECONCILIATION_ENABLED'] ?? 'false';
  if (value !== 'true' && value !== 'false')
    throw new Error('BACKOFFICE_RECONCILIATION_ENABLED must be true or false');
  return { enabled: value === 'true' };
}
const reason = z.string().trim().min(3).max(500);
const signed = z.string().regex(/^-?(0|[1-9][0-9]{0,13})$/);
const revision = z.number().int().min(0).max(2147483646);
const ItemKey = z.string().regex(/^[a-z]+:[a-z0-9:_-]{1,200}$/);
const OpenState = z.enum(STATES).exclude(['matched']);
const ItemRef = z.strictObject({ key: ItemKey, state: OpenState, amount_minor: signed });
export const ReconciliationQuery = z.strictObject({ day: DayString });
export const ReconciliationPreview = z.strictObject({
  mapping: MappingSchema,
  content: z.string().min(1).max(STATEMENT_MAX_CHARS),
});
export const ReconciliationRequest = z.strictObject({
  request_id: z.uuid(),
  reason,
  command: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('profile'),
      id: z.uuid(),
      expected_revision: revision,
      name: z.string().trim().min(1).max(100),
      mapping: MappingSchema,
      archived: z.boolean().default(false),
    }),
    z.strictObject({
      type: z.literal('import'),
      id: z.uuid(),
      profile_id: z.uuid().nullable().default(null),
      mapping: MappingSchema,
      file_name: z.string().trim().min(1).max(200),
      content: z.string().min(1).max(STATEMENT_MAX_CHARS),
    }),
    z.strictObject({ type: z.literal('void_import'), id: z.uuid() }),
    z.strictObject({
      type: z.literal('total'),
      id: z.uuid(),
      day: DayString,
      method: z.enum(METHOD_KEYS),
      source: z.enum(['bank', 'kkm']),
      amount_minor: signed,
      comment: z.string().trim().min(3).max(500),
      replaces: z.uuid().nullable().default(null),
    }),
    z.strictObject({ type: z.literal('void_total'), id: z.uuid() }),
    z.strictObject({
      type: z.literal('item'),
      day: DayString,
      ...ItemRef.shape,
      status: z.enum(RESOLUTION_STATUSES),
      assignee_id: z.uuid().nullable(),
      comment: z.string().trim().max(1000),
      expected_revision: revision,
    }),
    z.strictObject({
      type: z.literal('accept'),
      day: DayString,
      comment: z.string().trim().min(3).max(1000),
      items: z.array(ItemRef).min(1).max(500),
    }),
    z.strictObject({ type: z.literal('close'), day: DayString, expected_revision: revision }),
    z.strictObject({ type: z.literal('reopen'), day: DayString, expected_revision: revision }),
  ]),
});
type Command = z.infer<typeof ReconciliationRequest>['command'];
type Role = 'manager' | 'accountant' | 'analyst';
type Actor = { id: string; organization_id: string; name: string; role: Role };
type Resolution = {
  status: (typeof RESOLUTION_STATUSES)[number];
  assignee_id: string | null;
  assignee_name: string | null;
  comment: string;
  revision: number;
  updated_at: string;
  author: string;
};
export type ReconciledRow = Row & {
  /** Decision bound to this exact state and amount; null when none or made for another one. */
  resolution: Resolution | null;
  /** A decision made for an earlier state/amount of this item (kept visible, not in force). */
  stale_resolution: Resolution | null;
  /** Stored decision revision for optimistic concurrency, whatever its state. */
  item_revision: number;
  blocking: boolean;
};
export type ReconciledReport = Omit<DayReport, 'rows'> & {
  rows: ReconciledRow[];
  open_items: number;
};
const DAY_STATES_SHOWN = 62;

/** Operator-only: designate (or withdraw) an analyst of a branch as its reconciliation accountant. */
export async function grantReconciliationAccountant(
  pool: DatabasePool,
  actorId: string,
  branchId: string,
  enabled: boolean,
) {
  parse(z.uuid(), actorId);
  parse(z.uuid(), branchId);
  parse(z.boolean(), enabled);
  await transaction(pool, async (db) => {
    if (
      enabled &&
      !(
        await db.query(
          'SELECT 1 FROM bo_access_grants g JOIN catalog_manager_branches s ON s.actor_id=g.actor_id AND s.branch_id=g.branch_id WHERE g.actor_id=$1 AND g.branch_id=$2',
          [actorId, branchId],
        )
      ).rowCount
    )
      fail('FORBIDDEN');
    await db.query('INSERT INTO bo_rec_accountants(actor_id,branch_id,enabled) VALUES($1,$2,$3)', [
      actorId,
      branchId,
      enabled,
    ]);
  });
}

export class Reconciliation {
  private now: () => Date;
  constructor(
    private pool: DatabasePool,
    private enabled = false,
    options: Pick<ReconciliationOptions, 'now'> = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }
  private async scope(db: DatabaseClient, token: string, branch: string, write = false) {
    if (!this.enabled) fail('SERVICE_UNAVAILABLE', 'RECONCILIATION_DISABLED');
    parse(z.uuid(), branch);
    if (!/^[a-f0-9]{64}$/.test(token)) fail('UNAUTHORIZED');
    if (!(await db.query("SELECT to_regclass('bo_rec_days') IS NOT NULL ok")).rows[0].ok)
      fail('SERVICE_UNAVAILABLE', 'RECONCILIATION_NOT_INSTALLED');
    const known = (
      await db.query<{ id: string; organization_id: string; name: string }>(
        'SELECT id,organization_id,name FROM catalog_managers WHERE token_hash=$1 AND revoked_at IS NULL FOR SHARE',
        [catalogHash(token)],
      )
    ).rows[0];
    if (!known) return fail('UNAUTHORIZED');
    const grant = (
      await db.query<{ role: 'manager' | 'analyst'; accountant: boolean }>(
        `SELECT g.role,coalesce((SELECT a.enabled FROM bo_rec_accountants a WHERE a.actor_id=g.actor_id
          AND a.branch_id=g.branch_id ORDER BY a.id DESC LIMIT 1),false) accountant
         FROM bo_access_grants g JOIN catalog_manager_branches s ON s.actor_id=g.actor_id AND s.branch_id=g.branch_id
         WHERE g.actor_id=$1 AND g.branch_id=$2 AND s.organization_id=$3 FOR SHARE OF g,s`,
        [known.id, branch, known.organization_id],
      )
    ).rows[0];
    if (!grant) return fail('FORBIDDEN');
    const role: Role =
      grant.role === 'manager' ? 'manager' : grant.accountant ? 'accountant' : 'analyst';
    if (write && role === 'analyst') fail('FORBIDDEN');
    return { ...known, role } as Actor;
  }
  private async last(db: DatabaseClient, branch: string, day: string) {
    return (
      await db.query(
        `SELECT d.revision,d.kind,d.snapshot,d.fingerprint,d.reason,d.created_at,m.name author
         FROM bo_rec_days d JOIN catalog_managers m ON m.id=d.actor_id
         WHERE d.branch_id=$1 AND d.business_day=$2 ORDER BY d.revision DESC LIMIT 1`,
        [branch, day],
      )
    ).rows[0] as
      | {
          revision: number;
          kind: 'close' | 'reopen';
          snapshot: ReconciledReport | null;
          fingerprint: string | null;
          reason: string;
          created_at: Date;
          author: string;
        }
      | undefined;
  }
  private async closedDays(db: DatabaseClient, branch: string, days: string[]) {
    if (!days.length) return [];
    return (
      await db.query<{ day: string; kind: string }>(
        `SELECT DISTINCT ON(business_day) business_day::text AS day,kind FROM bo_rec_days
         WHERE branch_id=$1 AND business_day=ANY($2::date[]) ORDER BY business_day,revision DESC`,
        [branch, days],
      )
    ).rows
      .filter((r) => r.kind === 'close')
      .map((r) => r.day);
  }
  private async assertOpen(db: DatabaseClient, branch: string, days: string[]) {
    if ((await this.closedDays(db, branch, days)).length) fail('CONFLICT', 'DAY_CLOSED');
  }
  private async assignees(db: DatabaseClient, branch: string) {
    return (
      await db.query<{ id: string; name: string; role: string }>(
        `SELECT m.id,m.name,CASE WHEN g.role='manager' THEN 'manager' WHEN coalesce((SELECT a.enabled
          FROM bo_rec_accountants a WHERE a.actor_id=m.id AND a.branch_id=g.branch_id ORDER BY a.id DESC LIMIT 1),false)
          THEN 'accountant' ELSE 'analyst' END AS role
         FROM bo_access_grants g JOIN catalog_manager_branches s ON s.actor_id=g.actor_id AND s.branch_id=g.branch_id
         JOIN catalog_managers m ON m.id=g.actor_id AND m.organization_id=s.organization_id
         WHERE g.branch_id=$1 AND m.revoked_at IS NULL ORDER BY m.name,m.id`,
        [branch],
      )
    ).rows;
  }
  /** Optional sources (other modules' tables) are read only when installed and granted. */
  private async readable(db: DatabaseClient, table: string, columns: string[]) {
    const exists = await db.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL ok', [
      table,
    ]);
    if (exists.rows[0]?.ok !== true) return false;
    const r = await db.query<{ ok: boolean }>(
      `SELECT bool_and(has_column_privilege(current_user,$1::text,c,'SELECT')) ok FROM unnest($2::text[]) c`,
      [table, columns],
    );
    return r.rows[0]?.ok === true;
  }
  /** Live report of a business day: PickChick facts vs external facts, plus stored decisions. */
  private async compute(
    db: DatabaseClient,
    branch: string,
    day: string,
  ): Promise<ReconciledReport> {
    const rows = async <T = Record<string, unknown>>(sql: string, args: unknown[]) =>
      (await db.query(sql, args)).rows as T[];
    const { start, end } = dayBounds(day);
    const from = shiftDay(day, -1),
      to = shiftDay(day, 1);
    const wStart = dayBounds(from).start,
      wEnd = dayBounds(to).end;
    type LineRow = {
      id: string;
      import_id: string;
      imported_at: Date;
      row_number: number;
      source: Source;
      method: MethodKey | null;
      amount_minor: string;
      fee_minor: string;
      occurred_at: Date;
      day: string;
      time_precision: Line['time_precision'];
      operation_id: string | null;
      reference: string | null;
      description: string;
      window_seconds: number;
    };
    const lineSql = `SELECT l.id,l.import_id,i.created_at imported_at,l.row_number,l.source,l.method,l.amount_minor::text,
      l.fee_minor::text,l.occurred_at,l.business_day::text AS day,l.time_precision,l.operation_id,l.reference,l.description,l.window_seconds
      FROM bo_rec_lines l JOIN bo_rec_imports i ON i.id=l.import_id AND i.branch_id=l.branch_id
      WHERE l.branch_id=$1 AND NOT EXISTS(SELECT 1 FROM bo_rec_import_voids v WHERE v.import_id=l.import_id) AND `;
    const lineRows = await rows<LineRow>(lineSql + 'l.business_day BETWEEN $2::date AND $3::date', [
      branch,
      from,
      to,
    ]);
    const lineKeysToday = [
      ...new Set(
        lineRows
          .filter((l) => l.day === day)
          .flatMap((l) => [l.operation_id, l.reference])
          .filter((v): v is string => !!v)
          .map(normalizeKey),
      ),
    ];
    const invoices = await this.readable(db, 'commerce_kaspi_invoices', [
      'attempt_id',
      'reference',
      'operation_id',
    ]);
    type FactRow = {
      id: string;
      kind: 'capture' | 'refund';
      order_id: string;
      amount_minor: string;
      occurred_at: Date;
      operation_id: string;
      provider: string;
      day: string;
      gift_minor: string | null;
      reference: string | null;
      invoice_operation: string | null;
    };
    const factRows = await rows<FactRow>(
      `SELECT 'c-'||c.id id,'capture' kind,c.order_id,c.amount_minor::text,c.occurred_at,c.operation_id,p.provider,
        (c.occurred_at AT TIME ZONE '${REC_TIMEZONE}')::date::text AS day,o.snapshot->'comboGift'->>'discountMinor' gift_minor,
        ${invoices ? 'i.reference' : 'NULL::text'} AS reference,${invoices ? 'i.operation_id' : 'NULL::text'} AS invoice_operation
       FROM commerce_captures c JOIN commerce_orders o ON o.id=c.order_id JOIN commerce_provider_accounts p ON p.id=c.account_id
       ${invoices ? 'LEFT JOIN commerce_kaspi_invoices i ON i.attempt_id=c.attempt_id' : ''}
       WHERE o.branch_id=$1 AND ((c.occurred_at>=$2 AND c.occurred_at<$3)
        OR upper(regexp_replace(c.operation_id,'^(kaspi|manual):','')) = ANY($4::text[])
        ${invoices ? 'OR upper(i.reference)=ANY($4::text[]) OR i.operation_id=ANY($4::text[])' : ''})
       UNION ALL
       SELECT 'r-'||e.id,'refund',e.order_id,(-e.amount_minor)::text,e.occurred_at,e.operation_id,p.provider,
        (e.occurred_at AT TIME ZONE '${REC_TIMEZONE}')::date::text,NULL,NULL,NULL
       FROM commerce_refund_effects e JOIN commerce_orders o ON o.id=e.order_id JOIN commerce_provider_accounts p ON p.id=e.account_id
       WHERE o.branch_id=$1 AND ((e.occurred_at>=$2 AND e.occurred_at<$3)
        OR upper(regexp_replace(e.operation_id,'^(kaspi|manual):','')) = ANY($4::text[]))`,
      [branch, wStart, wEnd, lineKeysToday],
    );
    const facts: Fact[] = factRows.map((f) => {
      const manual = f.kind === 'refund' && f.operation_id.startsWith('manual:');
      return {
        id: f.id,
        kind: f.kind,
        method: manual ? 'manual_refund' : methodOfProvider(f.provider),
        amount_minor: BigInt(f.amount_minor),
        occurred_at: new Date(f.occurred_at).toISOString(),
        day: f.day,
        order_id: f.order_id,
        operation_id: f.operation_id,
        keys: factKeys(f.operation_id, [f.reference, f.invoice_operation]),
        gift_minor: /^\d{1,15}$/.test(f.gift_minor ?? '') ? BigInt(f.gift_minor!) : 0n,
      };
    });
    // Lines of other days that carry an identifier of today's facts (late bank operations).
    const factKeysToday = [...new Set(facts.filter((f) => f.day === day).flatMap((f) => f.keys))];
    const known = new Set(lineRows.map((l) => l.id));
    if (factKeysToday.length)
      for (const l of await rows<LineRow>(
        lineSql + '(upper(l.operation_id)=ANY($2::text[]) OR upper(l.reference)=ANY($2::text[]))',
        [branch, factKeysToday],
      ))
        if (!known.has(l.id)) lineRows.push(l);
    const imports = [
      ...new Set(lineRows.map((l) => l.imported_at.toISOString() + '|' + l.import_id)),
    ].sort();
    const lines: Line[] = lineRows.map((l) => ({
      id: l.id,
      import_id: l.import_id,
      import_seq: imports.indexOf(new Date(l.imported_at).toISOString() + '|' + l.import_id),
      row_number: l.row_number,
      source: l.source,
      method: l.method,
      amount_minor: BigInt(l.amount_minor),
      fee_minor: BigInt(l.fee_minor),
      occurred_at: new Date(l.occurred_at).toISOString(),
      day: l.day,
      time_precision: l.time_precision,
      operation_id: l.operation_id,
      reference: l.reference,
      description: l.description,
      window_seconds: l.window_seconds,
    }));
    const totals = (
      await rows<{
        id: string;
        method: MethodKey;
        source: 'bank' | 'kkm';
        amount_minor: string;
        comment: string;
        created_at: Date;
        author: string;
      }>(
        `SELECT t.id,t.method,t.source,t.amount_minor::text,t.comment,t.created_at,m.name author FROM bo_rec_totals t
         JOIN catalog_managers m ON m.id=t.actor_id WHERE t.branch_id=$1 AND t.business_day=$2
         AND NOT EXISTS(SELECT 1 FROM bo_rec_total_voids v WHERE v.total_id=t.id) ORDER BY t.created_at,t.id`,
        [branch, day],
      )
    ).map((t) => ({
      ...t,
      amount_minor: BigInt(t.amount_minor),
      created_at: new Date(t.created_at).toISOString(),
    }));
    const paidToday = [
      ...new Set(facts.filter((f) => f.day === day && f.kind === 'capture').map((f) => f.order_id)),
    ];
    const orders = paidToday.length
      ? (
          await rows<{
            order_id: string;
            total_minor: string;
            captured_minor: string;
            refunded_minor: string;
            last_capture_day: string;
            provider: string;
          }>(
            `SELECT o.id order_id,o.total_minor::text,
              (SELECT sum(x.amount_minor) FROM commerce_captures x WHERE x.order_id=o.id)::text captured_minor,
              (SELECT coalesce(sum(r.amount_minor),0) FROM commerce_refund_effects r WHERE r.order_id=o.id)::text refunded_minor,
              (SELECT (max(x.occurred_at) AT TIME ZONE '${REC_TIMEZONE}')::date::text FROM commerce_captures x WHERE x.order_id=o.id) last_capture_day,
              (SELECT p.provider FROM commerce_captures x JOIN commerce_provider_accounts p ON p.id=x.account_id
                WHERE x.order_id=o.id ORDER BY x.occurred_at DESC,x.id DESC LIMIT 1) provider
             FROM commerce_orders o WHERE o.branch_id=$1 AND o.id=ANY($2::uuid[])`,
            [branch, paidToday],
          )
        ).map((o) => ({
          order_id: o.order_id,
          method: methodOfProvider(o.provider),
          total_minor: BigInt(o.total_minor),
          captured_minor: BigInt(o.captured_minor),
          refunded_minor: BigInt(o.refunded_minor),
          last_capture_day: o.last_capture_day,
        }))
      : [];
    const shifts = (await this.readable(db, 'cloud_cashier_shifts', ['id', 'branch_id', 'payload']))
      ? (
          await rows<{ id: string; closed_at: string; discrepancy: string | null }>(
            `SELECT id,payload->>'closed_at' closed_at,payload->>'discrepancy_minor' discrepancy FROM cloud_cashier_shifts
             WHERE branch_id=$1 AND payload->>'state'='closed' AND (payload->>'closed_at')::timestamptz>=$2
             AND (payload->>'closed_at')::timestamptz<$3 ORDER BY id`,
            [branch, start, end],
          )
        ).map((s) => ({
          shift_id: s.id,
          closed_at: new Date(s.closed_at).toISOString(),
          day: businessDay(s.closed_at),
          discrepancy_minor: /^-?\d{1,19}$/.test(s.discrepancy ?? '') ? BigInt(s.discrepancy!) : 0n,
        }))
      : [];
    const gift = (
      await rows<{ orders: number; discount: string }>(
        `SELECT count(*)::int orders,coalesce(sum((snapshot->'comboGift'->>'discountMinor')::numeric),0)::text discount
         FROM commerce_orders WHERE branch_id=$1 AND total_minor=0 AND created_at>=$2 AND created_at<$3`,
        [branch, start, end],
      )
    )[0]!;
    const unknown: Partial<Record<MethodKey, number>> = {};
    for (const u of await rows<{ provider: string; n: number }>(
      `SELECT p.provider,count(*)::int n FROM commerce_payment_attempts a JOIN commerce_orders o ON o.id=a.order_id
       JOIN commerce_provider_accounts p ON p.id=a.account_id WHERE o.branch_id=$1 AND a.state='unknown'
       AND a.created_at>=$2 AND a.created_at<$3 GROUP BY p.provider`,
      [branch, start, end],
    )) {
      const m = methodOfProvider(u.provider);
      unknown[m] = (unknown[m] ?? 0) + u.n;
    }
    const report = reconcileDay({
      day,
      facts,
      lines,
      totals,
      orders,
      shifts,
      gifts: { orders: gift.orders, discount_minor: BigInt(gift.discount.split('.')[0]!) },
      unknown_attempts: unknown,
    });
    const items = new Map(
      (
        await rows<{
          item_key: string;
          state: string;
          amount_minor: string;
          status: Resolution['status'];
          assignee_id: string | null;
          assignee_name: string | null;
          comment: string;
          revision: number;
          updated_at: Date;
          author: string;
        }>(
          `SELECT i.item_key,i.state,i.amount_minor::text,i.status,i.assignee_id,a.name assignee_name,i.comment,i.revision,
            i.updated_at,m.name author FROM bo_rec_items i JOIN catalog_managers m ON m.id=i.actor_id
            LEFT JOIN catalog_managers a ON a.id=i.assignee_id WHERE i.branch_id=$1 AND i.business_day=$2`,
          [branch, day],
        )
      ).map((i) => [i.item_key, i]),
    );
    const merged: ReconciledRow[] = report.rows.map((row) => {
      const item = items.get(row.key);
      const resolution: Resolution | null = item
        ? {
            status: item.status,
            assignee_id: item.assignee_id,
            assignee_name: item.assignee_name,
            comment: item.comment,
            revision: item.revision,
            updated_at: new Date(item.updated_at).toISOString(),
            author: item.author,
          }
        : null;
      const current = !!item && item.state === row.state && item.amount_minor === row.amount_minor;
      return {
        ...row,
        resolution: current ? resolution : null,
        stale_resolution: item && !current ? resolution : null,
        item_revision: item?.revision ?? 0,
        blocking:
          row.state !== 'matched' && !(current && ['resolved', 'accepted'].includes(item!.status)),
      };
    });
    return {
      ...report,
      rows: merged,
      open_items: merged.filter((r) => r.blocking).length,
    };
  }
  async read(token: string, branch: string, input: unknown) {
    const q = parse(ReconciliationQuery, input);
    return transaction(this.pool, async (db) => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const actor = await this.scope(db, token, branch);
      const now = this.now();
      const { end } = dayBounds(q.day);
      if (q.day > businessDay(now)) fail('INVALID_REQUEST');
      const live = await this.compute(db, branch, q.day);
      const last = await this.last(db, branch, q.day);
      const closed = last?.kind === 'close';
      const report = closed ? last!.snapshot! : live;
      const rows = async <T = Record<string, unknown>>(sql: string, args: unknown[]) =>
        (await db.query(sql, args)).rows as T[];
      const tiptoppay = (await this.readable(db, 'commerce_tiptoppay_test_payments', [
        'branch_id',
        'amount_minor',
        'state',
        'updated_at',
      ]))
        ? (
            await rows<{ payments: number; amount_minor: string }>(
              `SELECT count(*)::int payments,coalesce(sum(amount_minor),0)::text amount_minor FROM commerce_tiptoppay_test_payments
               WHERE branch_id=$1 AND state='paid' AND updated_at>=$2 AND updated_at<$3`,
              [branch, dayBounds(q.day).start, end],
            )
          )[0]
        : null;
      return {
        schema_version: 1,
        branch_id: branch,
        day: q.day,
        timezone: REC_TIMEZONE,
        as_of: now.toISOString(),
        role: actor.role,
        writable: actor.role !== 'analyst',
        actor_id: actor.id,
        day_finished: now.getTime() >= end.getTime(),
        state: closed ? 'closed' : 'open',
        revision: last?.revision ?? 0,
        closed: closed
          ? {
              at: new Date(last!.created_at).toISOString(),
              by: last!.author,
              fingerprint: last!.fingerprint,
            }
          : null,
        // A closed day is frozen. Facts that arrive later (a late capture, a new statement line)
        // show up here; the day must be reopened with a reason to account for them.
        drift: closed ? live.fingerprint !== last!.fingerprint : false,
        report,
        live_open_items: live.open_items,
        tiptoppay_test: tiptoppay ?? null,
        totals: await rows(
          `SELECT t.id,t.method,t.source,t.amount_minor::text,t.comment,t.created_at,m.name author,v.reason void_reason,
            v.created_at voided_at FROM bo_rec_totals t JOIN catalog_managers m ON m.id=t.actor_id
            LEFT JOIN bo_rec_total_voids v ON v.total_id=t.id WHERE t.branch_id=$1 AND t.business_day=$2
            ORDER BY t.created_at,t.id`,
          [branch, q.day],
        ),
        imports: await rows(
          `SELECT i.id,i.file_name,i.source,i.line_count,i.skipped_count,i.duplicate_count,i.created_at,m.name author,
            v.reason void_reason,v.created_at voided_at,
            (SELECT array_agg(DISTINCT l.business_day::text) FROM bo_rec_lines l WHERE l.import_id=i.id) days
           FROM bo_rec_imports i JOIN catalog_managers m ON m.id=i.actor_id LEFT JOIN bo_rec_import_voids v ON v.import_id=i.id
           WHERE i.branch_id=$1 AND (EXISTS(SELECT 1 FROM bo_rec_lines l WHERE l.import_id=i.id AND l.business_day=$2)
            OR i.created_at>=$3) ORDER BY i.created_at DESC,i.id LIMIT 50`,
          [branch, q.day, new Date(now.getTime() - 7 * 86400000)],
        ),
        profiles: await rows(
          `SELECT id,name,revision,mapping,archived,updated_at FROM bo_rec_profiles WHERE branch_id=$1 ORDER BY archived,name,id`,
          [branch],
        ),
        assignees: await this.assignees(db, branch),
        history: await rows(
          `SELECT d.revision,d.kind,d.reason,d.created_at,m.name author FROM bo_rec_days d JOIN catalog_managers m ON m.id=d.actor_id
           WHERE d.branch_id=$1 AND d.business_day=$2 ORDER BY d.revision`,
          [branch, q.day],
        ),
        days: await rows(
          `SELECT DISTINCT ON(business_day) business_day::text AS day,kind,revision FROM bo_rec_days WHERE branch_id=$1
           AND business_day BETWEEN $2::date AND $3::date ORDER BY business_day DESC,revision DESC`,
          [branch, shiftDay(q.day, -DAY_STATES_SHOWN), shiftDay(q.day, DAY_STATES_SHOWN)],
        ),
        methods: METHOD_KEYS.map((m) => ({ key: m, ...METHODS[m] })),
        sources: SOURCE_LABELS,
        limits: {
          statement_max_chars: STATEMENT_MAX_CHARS,
          statement_max_rows: STATEMENT_MAX_ROWS,
        },
        capabilities: {
          statement_import: true,
          manual_totals: true,
          bank_api: false,
          cashier_payments: false,
          chiki_payments: false,
        },
      };
    });
  }
  /** Parse a statement without storing it: errors, days, first lines, already imported lines. */
  async preview(token: string, branch: string, input: unknown) {
    const p = parse(ReconciliationPreview, input);
    return transaction(this.pool, async (db) => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await this.scope(db, token, branch, true);
      const parsed = parseStatement(p.content, p.mapping);
      const days = [...new Set(parsed.lines.map((l) => l.business_day))].sort();
      const closed = await this.closedDays(db, branch, days);
      const fresh = await this.fresh(db, branch, p.mapping.source, parsed.lines);
      const sameFile = (
        await db.query(
          `SELECT i.id FROM bo_rec_imports i WHERE i.branch_id=$1 AND i.file_digest=$2
           AND NOT EXISTS(SELECT 1 FROM bo_rec_import_voids v WHERE v.import_id=i.id) LIMIT 1`,
          [branch, parsed.digest],
        )
      ).rows[0];
      return {
        digest: parsed.digest,
        rows: parsed.rows,
        valid: parsed.errors.length === 0 && parsed.lines.length > 0,
        errors: parsed.errors,
        skipped: parsed.skipped,
        lines: parsed.lines.length,
        already_imported: parsed.lines.length - fresh.length,
        duplicate_import: sameFile?.id ?? null,
        days: days.map((d) => {
          const own = parsed.lines.filter((l) => l.business_day === d);
          return {
            day: d,
            lines: own.length,
            // Lines this import would store; a closed day blocks the import only when > 0.
            new_lines: fresh.filter((l) => l.business_day === d).length,
            amount_minor: String(own.reduce((a, l) => a + BigInt(l.amount_minor), 0n)),
            closed: closed.includes(d),
          };
        }),
        sample: parsed.lines.slice(0, 20),
      };
    });
  }
  /** Lines of a statement that are not stored yet (see `repeated`). */
  private async fresh<
    T extends { operation_id: string | null; amount_minor: string; occurred_at: string },
  >(db: DatabaseClient, branch: string, source: Source, lines: T[]) {
    const repeated = await this.repeated(db, branch, source, lines);
    return lines.filter(
      (l) =>
        !(
          l.operation_id &&
          repeated.has(normalizeKey(l.operation_id) + '|' + l.amount_minor + '|' + l.occurred_at)
        ),
    );
  }
  /** Lines already stored from an earlier statement: same source, id, amount and time. */
  private async repeated(
    db: DatabaseClient,
    branch: string,
    source: Source,
    lines: { operation_id: string | null; amount_minor: string; occurred_at: string }[],
  ) {
    const keys = [
      ...new Set(
        lines
          .map((l) => l.operation_id)
          .filter((v): v is string => !!v)
          .map(normalizeKey),
      ),
    ];
    if (!keys.length) return new Set<string>();
    const existing = new Set(
      (
        await db.query<{ k: string }>(
          `SELECT upper(l.operation_id)||'|'||l.amount_minor::text||'|'||to_char(l.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') k
           FROM bo_rec_lines l WHERE l.branch_id=$1 AND l.source=$2 AND upper(l.operation_id)=ANY($3::text[])
           AND NOT EXISTS(SELECT 1 FROM bo_rec_import_voids v WHERE v.import_id=l.import_id)`,
          [branch, source, keys],
        )
      ).rows.map((r) => r.k),
    );
    return new Set(
      lines
        .map((l) =>
          l.operation_id
            ? normalizeKey(l.operation_id) + '|' + l.amount_minor + '|' + l.occurred_at
            : '',
        )
        .filter((k) => k && existing.has(k)),
    );
  }
  async command(token: string, branch: string, input: unknown) {
    const r = parse(ReconciliationRequest, input),
      hash = digest({ branch, request: r });
    try {
      return await transaction(this.pool, async (db) => {
        const actor = await this.scope(db, token, branch, true);
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'reconciliation-request:' + actor.id + ':' + r.request_id,
        ]);
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'reconciliation-branch:' + branch,
        ]);
        const prior = (
          await db.query(
            'SELECT digest,result FROM bo_rec_commands WHERE actor_id=$1 AND request_id=$2',
            [actor.id, r.request_id],
          )
        ).rows[0];
        if (prior) {
          if (prior.digest !== hash) fail('CONFLICT');
          return prior.result;
        }
        const { result, entity, before, after } = await this.apply(
          db,
          actor,
          branch,
          r.command,
          r.reason,
        );
        await db.query(
          'INSERT INTO bo_audit(id,branch_id,organization_id,actor_id,request_id,action,entity_id,reason,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            randomUUID(),
            branch,
            actor.organization_id,
            actor.id,
            r.request_id,
            'reconciliation.' + r.command.type,
            entity,
            r.reason,
            JSON.stringify(before),
            JSON.stringify(after),
          ],
        );
        await db.query(
          'INSERT INTO bo_rec_commands(actor_id,request_id,branch_id,digest,result) VALUES($1,$2,$3,$4,$5)',
          [actor.id, r.request_id, branch, hash, JSON.stringify(result)],
        );
        return result;
      });
    } catch (error) {
      if (error instanceof BackofficeError) throw error;
      const code = (error as { code?: unknown } | null)?.code;
      if (code === '23505') fail('CONFLICT');
      if (code === '23503' || code === '23514' || code === '22003') fail('INVALID_REQUEST');
      if (code === '40001' || code === '40P01') fail('SERVICE_UNAVAILABLE');
      throw error;
    }
  }
  private async apply(
    db: DatabaseClient,
    actor: Actor,
    branch: string,
    c: Command,
    reasonText: string,
  ): Promise<{
    result: Record<string, unknown>;
    entity: string | null;
    before: unknown;
    after: unknown;
  }> {
    const one = async (sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];
    if (c.type === 'profile') {
      const current = await one(
        'SELECT revision,name,mapping,archived FROM bo_rec_profiles WHERE branch_id=$1 AND id=$2',
        [branch, c.id],
      );
      if ((current?.revision ?? 0) !== c.expected_revision) fail('CONFLICT', 'REVISION_CHANGED');
      if (
        await one('SELECT 1 FROM bo_rec_profiles WHERE branch_id=$1 AND name=$2 AND id<>$3', [
          branch,
          c.name,
          c.id,
        ])
      )
        fail('CONFLICT', 'PROFILE_NAME_TAKEN');
      if (!current && (await one('SELECT 1 FROM bo_rec_profiles WHERE id=$1', [c.id])))
        fail('CONFLICT');
      if (current)
        await db.query(
          'UPDATE bo_rec_profiles SET revision=revision+1,name=$3,mapping=$4,archived=$5,actor_id=$6,updated_at=clock_timestamp() WHERE branch_id=$1 AND id=$2',
          [branch, c.id, c.name, JSON.stringify(c.mapping), c.archived, actor.id],
        );
      else
        await db.query(
          'INSERT INTO bo_rec_profiles(id,branch_id,revision,name,mapping,archived,actor_id) VALUES($1,$2,1,$3,$4,$5,$6)',
          [c.id, branch, c.name, JSON.stringify(c.mapping), c.archived, actor.id],
        );
      return {
        result: { id: c.id, revision: c.expected_revision + 1 },
        entity: c.id,
        before: current ?? null,
        after: { name: c.name, mapping: c.mapping, archived: c.archived },
      };
    }
    if (c.type === 'import') {
      const parsed = parseStatement(c.content, c.mapping);
      if (parsed.errors.length || !parsed.lines.length)
        fail('INVALID_REQUEST', 'STATEMENT_INVALID');
      if (await one('SELECT 1 FROM bo_rec_imports WHERE id=$1', [c.id])) fail('CONFLICT');
      if (
        await one(
          `SELECT 1 FROM bo_rec_imports i WHERE i.branch_id=$1 AND i.file_digest=$2
           AND NOT EXISTS(SELECT 1 FROM bo_rec_import_voids v WHERE v.import_id=i.id)`,
          [branch, parsed.digest],
        )
      )
        fail('CONFLICT', 'DUPLICATE_IMPORT');
      // Overlapping statements: lines stored earlier are skipped, so only the days that get new
      // lines must be open (a closed day never changes).
      const fresh = await this.fresh(db, branch, c.mapping.source, parsed.lines);
      const days = [...new Set(fresh.map((l) => l.business_day))].sort();
      await this.assertOpen(db, branch, days);
      await db.query(
        'INSERT INTO bo_rec_imports(id,branch_id,profile_id,mapping,source,file_name,file_digest,line_count,skipped_count,duplicate_count,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          c.id,
          branch,
          c.profile_id,
          JSON.stringify(c.mapping),
          c.mapping.source,
          c.file_name,
          parsed.digest,
          fresh.length,
          parsed.skipped.length,
          parsed.lines.length - fresh.length,
          actor.id,
        ],
      );
      if (fresh.length)
        await db.query(
          `INSERT INTO bo_rec_lines(id,branch_id,import_id,row_number,source,method,business_day,occurred_at,time_precision,
            amount_minor,fee_minor,operation_id,reference,description,window_seconds)
           SELECT gen_random_uuid(),$1,$2,x.row_number,$3,x.method,x.day::date,x.occurred_at::timestamptz,x.time_precision,
            x.amount::bigint,x.fee::bigint,x.operation_id,x.reference,x.description,$4
           FROM unnest($5::int[],$6::text[],$7::text[],$8::text[],$9::text[],$10::text[],$11::text[],$12::text[],$13::text[],$14::text[])
            AS x(row_number,method,day,occurred_at,time_precision,amount,fee,operation_id,reference,description)`,
          [
            branch,
            c.id,
            c.mapping.source,
            c.mapping.window_minutes * 60,
            fresh.map((l) => l.row_number),
            fresh.map((l) => l.method),
            fresh.map((l) => l.business_day),
            fresh.map((l) => l.occurred_at),
            fresh.map((l) => l.time_precision),
            fresh.map((l) => l.amount_minor),
            fresh.map((l) => l.fee_minor),
            fresh.map((l) => l.operation_id),
            fresh.map((l) => l.reference),
            fresh.map((l) => l.description),
          ],
        );
      const result = {
        id: c.id,
        lines: fresh.length,
        already_imported: parsed.lines.length - fresh.length,
        skipped: parsed.skipped.length,
        days,
      };
      return {
        result,
        entity: c.id,
        before: null,
        after: {
          file_name: c.file_name,
          digest: parsed.digest,
          profile_id: c.profile_id,
          mapping: c.mapping,
          ...result,
        },
      };
    }
    if (c.type === 'void_import') {
      const current = await one(
        `SELECT i.id,i.file_name,i.file_digest,(SELECT 1 FROM bo_rec_import_voids v WHERE v.import_id=i.id) voided
         FROM bo_rec_imports i WHERE i.branch_id=$1 AND i.id=$2`,
        [branch, c.id],
      );
      if (!current) fail('NOT_FOUND');
      if (current.voided) fail('CONFLICT');
      const days = (
        await db.query<{ day: string }>(
          'SELECT DISTINCT business_day::text AS day FROM bo_rec_lines WHERE import_id=$1',
          [c.id],
        )
      ).rows.map((d) => d.day);
      await this.assertOpen(db, branch, days);
      await db.query(
        'INSERT INTO bo_rec_import_voids(import_id,branch_id,actor_id,reason) VALUES($1,$2,$3,$4)',
        [c.id, branch, actor.id, reasonText],
      );
      return { result: { id: c.id, voided: true }, entity: c.id, before: current, after: null };
    }
    if (c.type === 'total' || c.type === 'void_total') {
      const target = c.type === 'void_total' ? c.id : c.replaces;
      let before: Record<string, unknown> | null = null;
      if (target) {
        before =
          (await one(
            `SELECT t.id,t.business_day::text AS day,t.method,t.source,t.amount_minor::text,t.comment,
              (SELECT 1 FROM bo_rec_total_voids v WHERE v.total_id=t.id) voided
             FROM bo_rec_totals t WHERE t.branch_id=$1 AND t.id=$2`,
            [branch, target],
          )) ?? null;
        if (!before) fail('NOT_FOUND');
        if (before!.voided) fail('CONFLICT');
        if (
          c.type === 'total' &&
          (before!.day !== c.day || before!.method !== c.method || before!.source !== c.source)
        )
          fail('INVALID_REQUEST');
        await this.assertOpen(db, branch, [String(before!.day)]);
        await db.query(
          'INSERT INTO bo_rec_total_voids(total_id,branch_id,actor_id,reason) VALUES($1,$2,$3,$4)',
          [target, branch, actor.id, reasonText],
        );
      }
      if (c.type === 'void_total')
        return { result: { id: c.id, voided: true }, entity: c.id, before, after: null };
      await this.assertOpen(db, branch, [c.day]);
      if (
        await one(
          `SELECT 1 FROM bo_rec_totals t WHERE t.branch_id=$1 AND t.business_day=$2 AND t.method=$3 AND t.source=$4
           AND NOT EXISTS(SELECT 1 FROM bo_rec_total_voids v WHERE v.total_id=t.id)`,
          [branch, c.day, c.method, c.source],
        )
      )
        fail('CONFLICT', 'TOTAL_EXISTS');
      await db.query(
        'INSERT INTO bo_rec_totals(id,branch_id,business_day,method,source,amount_minor,comment,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [c.id, branch, c.day, c.method, c.source, c.amount_minor, c.comment, actor.id],
      );
      return {
        result: { id: c.id, ...(c.replaces ? { replaced_id: c.replaces } : {}) },
        entity: c.id,
        before,
        after: c,
      };
    }
    if (c.type === 'item' || c.type === 'accept') {
      await this.assertOpen(db, branch, [c.day]);
      const report = await this.compute(db, branch, c.day);
      const people = await this.assignees(db, branch);
      const refs =
        c.type === 'item'
          ? [{ key: c.key, state: c.state, amount_minor: c.amount_minor }]
          : c.items;
      if (new Set(refs.map((x) => x.key)).size !== refs.length) fail('INVALID_REQUEST');
      const changes: { key: string; before: unknown; after: unknown }[] = [];
      for (const ref of refs) {
        const row = report.rows.find((x) => x.key === ref.key);
        if (!row || row.state !== ref.state || row.amount_minor !== ref.amount_minor)
          fail('CONFLICT', 'ITEM_CHANGED');
        const stored = await one(
          `SELECT revision,state,amount_minor::text,status,assignee_id,comment FROM bo_rec_items
           WHERE branch_id=$1 AND business_day=$2 AND item_key=$3`,
          [branch, c.day, ref.key],
        );
        const status = c.type === 'item' ? c.status : 'accepted';
        const assignee = c.type === 'item' ? c.assignee_id : (stored?.assignee_id ?? actor.id);
        const comment = c.comment;
        if (c.type === 'item' && (stored?.revision ?? 0) !== c.expected_revision)
          fail('CONFLICT', 'REVISION_CHANGED');
        if (assignee !== null && !people.some((p) => p.id === assignee))
          fail('INVALID_REQUEST', 'ASSIGNEE_UNKNOWN');
        if (['resolved', 'accepted'].includes(status) && comment.trim().length < 3)
          fail('INVALID_REQUEST');
        await db.query(
          `INSERT INTO bo_rec_items(branch_id,business_day,item_key,revision,state,amount_minor,status,assignee_id,comment,actor_id)
           VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9) ON CONFLICT(branch_id,business_day,item_key) DO UPDATE SET
           revision=bo_rec_items.revision+1,state=excluded.state,amount_minor=excluded.amount_minor,status=excluded.status,
           assignee_id=excluded.assignee_id,comment=excluded.comment,actor_id=excluded.actor_id,updated_at=clock_timestamp()`,
          [
            branch,
            c.day,
            ref.key,
            ref.state,
            ref.amount_minor,
            status,
            assignee,
            comment,
            actor.id,
          ],
        );
        changes.push({
          key: ref.key,
          before: stored ?? null,
          after: {
            state: ref.state,
            amount_minor: ref.amount_minor,
            status,
            assignee_id: assignee,
            comment,
          },
        });
      }
      return {
        result:
          c.type === 'item'
            ? { day: c.day, key: c.key, revision: c.expected_revision + 1 }
            : { day: c.day, accepted: refs.length },
        entity: null,
        before: changes.map((x) => ({ key: x.key, value: x.before })),
        after: { day: c.day, items: changes.map((x) => ({ key: x.key, value: x.after })) },
      };
    }
    // Close / reopen: append-only event chain with optimistic revision.
    const last = await this.last(db, branch, c.day);
    if ((last?.revision ?? 0) !== c.expected_revision) fail('CONFLICT', 'REVISION_CHANGED');
    if (c.type === 'close') {
      if (last?.kind === 'close') fail('CONFLICT', 'DAY_CLOSED');
      if (this.now().getTime() < dayBounds(c.day).end.getTime())
        fail('CONFLICT', 'DAY_NOT_FINISHED');
      const report = await this.compute(db, branch, c.day);
      if (report.open_items) fail('CONFLICT', 'DIFFERENCES_OPEN');
      await db.query(
        'INSERT INTO bo_rec_days(branch_id,business_day,revision,kind,snapshot,fingerprint,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          branch,
          c.day,
          c.expected_revision + 1,
          'close',
          JSON.stringify(report),
          report.fingerprint,
          reasonText,
          actor.id,
        ],
      );
      return {
        result: { day: c.day, state: 'closed', revision: c.expected_revision + 1 },
        entity: null,
        before: { day: c.day, revision: c.expected_revision },
        after: { day: c.day, state: 'closed', fingerprint: report.fingerprint },
      };
    }
    if (last?.kind !== 'close') fail('CONFLICT', 'DAY_NOT_CLOSED');
    await db.query(
      'INSERT INTO bo_rec_days(branch_id,business_day,revision,kind,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
      [branch, c.day, c.expected_revision + 1, 'reopen', reasonText, actor.id],
    );
    return {
      result: { day: c.day, state: 'open', revision: c.expected_revision + 1 },
      entity: null,
      before: { day: c.day, state: 'closed', fingerprint: last!.fingerprint },
      after: { day: c.day, state: 'open' },
    };
  }
}
