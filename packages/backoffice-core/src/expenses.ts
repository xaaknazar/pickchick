import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DatabaseClient, type DatabasePool } from '@pickchick/database';
import { catalogHash } from '@pickchick/catalog-admin';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_GROUPS,
  EXPENSE_SOURCES,
  EXPENSE_SOURCE_CODES,
  POS_METHOD_REVENUE,
  REVENUE_TYPES,
  enterable,
  expenseCategory,
  type RevenueType,
} from './expenses-catalog.js';
import {
  COMPANY,
  cashDay,
  computePnl,
  percent,
  type CogsFact,
  type EntryFact,
  type RevenueFact,
} from './expenses-report.js';

/**
 * «Расходы» of the back office (owner request 11.11.2026; docs/operations/backoffice-expenses.md).
 * One organization per login; its branches are the points, location NULL is «Общие расходы
 * компании». Behind BACKOFFICE_EXPENSES_ENABLED (default off) and cloud077.
 *
 * Access is checked here, never only on the screen: a director (the owner: the «manager» grant on
 * every branch, or an explicit director row) closes and opens months and gives access; finance and
 * economist write; viewer reads. A closed month refuses every change (MONTH_CLOSED, and the 077
 * trigger as the last line). Every change is logged in bo_expense_log in the same transaction.
 * Days are Asia/Almaty calendar days; money is signed integer tiyn in strings.
 */
export const EXPENSES = Symbol('EXPENSES');

export type ExpensesErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'MONTH_CLOSED'
  | 'SERVICE_UNAVAILABLE';
export class ExpensesError extends Error {
  constructor(public readonly code: ExpensesErrorCode) {
    super(code);
  }
}
const fail = (code: ExpensesErrorCode): never => {
  throw new ExpensesError(code);
};
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ExpensesError('INVALID_REQUEST');
  return r.data;
}

export const EXPENSE_ROLES = ['director', 'finance', 'economist', 'viewer'] as const;
export type ExpenseRole = (typeof EXPENSE_ROLES)[number];
export const EXPENSE_PERMISSIONS: Readonly<Record<ExpenseRole, readonly string[]>> = Object.freeze({
  director: ['expenses.read', 'expenses.write', 'expenses.close', 'expenses.access'],
  finance: ['expenses.read', 'expenses.write'],
  economist: ['expenses.read', 'expenses.write'],
  viewer: ['expenses.read'],
});

/** Today in Almaty (UTC+5, no daylight saving). */
export function almatyToday(now = new Date()) {
  return new Date(now.getTime() + 5 * 3600_000).toISOString().slice(0, 10);
}
const validDay = (v: string) =>
  v >= '2000-01-01' &&
  v <= '2099-12-31' &&
  new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(validDay);
const Month = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .refine((v) => v >= '2000-01' && v <= '2099-12');
const Money = z.string().regex(/^-?(0|[1-9][0-9]{0,13})$/);
const NonZero = Money.refine((v) => BigInt(v) !== 0n);
const Location = z.union([z.uuid(), z.null()]);
const Category = z.string().refine(enterable);
const Source = z.enum(EXPENSE_SOURCE_CODES);
const Comment = z.string().trim().max(1000);
const Counterparty = z.string().trim().max(200);
const lastDay = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
};
const monthOf = (day: string) => day.slice(0, 7);
const firstOf = (month: string) => month + '-01';

/** A day of the grid or a month of the grid (monthly records, dated the last day). */
const Period = z.discriminatedUnion('period', [
  z.strictObject({ period: z.literal('day'), date: Day }),
  z.strictObject({ period: z.literal('month'), month: Month }),
]);
type Period = z.infer<typeof Period>;
const periodDate = (p: Period) =>
  p.period === 'day' ? { date: p.date, monthly: false } : { date: lastDay(p.month), monthly: true };

export const CellCommand = z.intersection(
  Period,
  z.strictObject({
    location_id: Location,
    category: Category,
    source: Source,
    /** null or '0' removes the cell. */
    amount_minor: Money.nullable(),
  }),
);
export const RowCommand = z.intersection(
  Period,
  z.strictObject({
    location_id: Location,
    category: Category,
    pl_month: Month,
    comment: Comment,
  }),
);
export const EntryCommand = z.strictObject({
  location_id: Location,
  date: Day,
  category: Category,
  source: Source,
  amount_minor: NonZero,
  pl_month: Month,
  monthly: z.boolean(),
  counterparty: Counterparty,
  comment: Comment,
});
export const CashCommand = z.strictObject({
  location_id: z.uuid(),
  date: Day,
  opening_minor: Money.nullable(),
  counted_minor: Money.nullable(),
  comment: Comment,
});
export const AccessCommand = z.strictObject({
  actor_id: z.uuid(),
  role: z.enum(EXPENSE_ROLES).nullable(),
});
const LocationFilter = z.union([z.literal('all'), z.literal('company'), z.uuid()]);
export const JournalQuery = z
  .strictObject({
    start_date: Day,
    end_date: Day,
    location: LocationFilter.default('all'),
    category: z.string().max(60).default(''),
    source: z.union([z.literal(''), Source]).default(''),
    search: z.string().trim().max(80).default(''),
    group: z.enum(['date', 'pl_month']).default('date'),
    basis: z.enum(['date', 'pl_month']).default('date'),
  })
  .refine(
    (q) =>
      q.start_date <= q.end_date &&
      Date.parse(q.end_date) - Date.parse(q.start_date) <= 400 * 86400000,
  );
export const PnlQuery = z
  .strictObject({
    from: Month,
    to: Month,
    columns: z.enum(['locations', 'months']).default('locations'),
    cogs: z.enum(['ttk', 'payments']).default('payments'),
    allocate: z.enum(['true', 'false']).default('false'),
    location: LocationFilter.default('all'),
  })
  .refine((q) => q.from <= q.to && monthsBetween(q.from, q.to).length <= 24);
export const AnalyticsQuery = z
  .strictObject({ from: Month, to: Month, location: LocationFilter.default('all') })
  .refine((q) => q.from <= q.to && monthsBetween(q.from, q.to).length <= 24);

export function monthsBetween(from: string, to: string) {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  for (let guard = 0; guard < 400; guard++) {
    const v = `${y}-${String(m).padStart(2, '0')}`;
    if (v > to) break;
    out.push(v);
    m++;
    if (m === 13) {
      m = 1;
      y++;
    }
  }
  return out;
}

type Actor = {
  id: string;
  name: string;
  organization_id: string;
  role: ExpenseRole;
  branches: { id: string; name: string }[];
};
type Db = Pick<DatabaseClient, 'query'>;
const NIL = '00000000-0000-0000-0000-000000000000';
const big = (v: unknown) => BigInt(String(v ?? '0'));
/** Columns of a record, dates as text (never a JS Date of a calendar day). */
const cols = (t = '') =>
  `${t}id,${t}organization_id,${t}location_id,${t}date::text date,${t}category,${t}source,${t}amount_minor::text amount_minor,` +
  `to_char(${t}pl_month,'YYYY-MM') pl_month,${t}monthly,${t}cell,${t}counterparty,${t}comment,${t}revision,${t}created_at,${t}updated_at,${t}author_id,${t}updated_by`;

export class Expenses {
  constructor(
    private pool: DatabasePool,
    private enabled = false,
    private now: () => Date = () => new Date(),
  ) {}

  private async scope(db: Db, token: string, permission: string): Promise<Actor> {
    if (!this.enabled) fail('SERVICE_UNAVAILABLE');
    if (!/^[a-f0-9]{64}$/.test(token)) fail('UNAUTHORIZED');
    const m = (
      await db.query<{ id: string; name: string; organization_id: string }>(
        'SELECT id,name,organization_id FROM catalog_managers WHERE token_hash=$1 AND revoked_at IS NULL',
        [catalogHash(token)],
      )
    ).rows[0];
    if (!m) return fail('UNAUTHORIZED');
    const branches = (
      await db.query<{ id: string; name: string }>(
        'SELECT id,name FROM branches WHERE organization_id=$1 ORDER BY name,id',
        [m.organization_id],
      )
    ).rows;
    const role = await this.roleOf(db, m.id, m.organization_id, branches.length);
    if (!role || !EXPENSE_PERMISSIONS[role].includes(permission)) fail('FORBIDDEN');
    return { ...m, role: role!, branches };
  }

  /** The latest access row; without one, the director is the manager of every branch. */
  private async roleOf(db: Db, actor: string, org: string, branchCount: number) {
    const row = (
      await db.query<{ role: ExpenseRole | null }>(
        'SELECT role FROM bo_expense_access WHERE organization_id=$1 AND actor_id=$2 ORDER BY id DESC LIMIT 1',
        [org, actor],
      )
    ).rows[0];
    if (row) return row.role;
    if (branchCount === 0) return null;
    const managed = (
      await db.query<{ n: number }>(
        `SELECT count(DISTINCT g.branch_id)::int n FROM bo_access_grants g JOIN branches b ON b.id=g.branch_id
         WHERE g.actor_id=$1 AND g.role='manager' AND b.organization_id=$2`,
        [actor, org],
      )
    ).rows[0]!.n;
    return managed === branchCount ? ('director' as const) : null;
  }

  private location(actor: Actor, id: string | null) {
    if (id !== null && !actor.branches.some((b) => b.id === id)) fail('INVALID_REQUEST');
    return id;
  }
  private notFuture(day: string) {
    if (day > almatyToday(this.now())) fail('INVALID_REQUEST');
  }
  private async open(db: Db, org: string, months: string[]) {
    const closed = (
      await db.query(
        'SELECT 1 FROM bo_expense_months WHERE organization_id=$1 AND month=ANY($2::date[])',
        [org, [...new Set(months)].map(firstOf)],
      )
    ).rows.length;
    if (closed) fail('MONTH_CLOSED');
  }
  private async log(
    db: Db,
    actor: Actor,
    action: string,
    location: string | null,
    date: string | null,
    before: unknown,
    after: unknown,
  ) {
    await db.query(
      'INSERT INTO bo_expense_log(organization_id,actor_id,action,location_id,date,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        actor.organization_id,
        actor.id,
        action,
        location,
        date,
        JSON.stringify(before),
        JSON.stringify(after),
      ],
    );
  }
  private async write<T>(token: string, permission: string, fn: (db: Db, a: Actor) => Promise<T>) {
    return transaction(this.pool, async (db) => {
      const actor = await this.scope(db, token, permission);
      // One writer per organization: the cell upsert, month closing and logging stay ordered.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'expenses:' + actor.organization_id,
      ]);
      return fn(db, actor);
    });
  }
  private async read<T>(token: string, fn: (db: Db, a: Actor) => Promise<T>) {
    return transaction(this.pool, async (db) => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return fn(db, await this.scope(db, token, 'expenses.read'));
    });
  }

  async meta(token: string) {
    return this.read(token, async (db, a) => ({
      schema_version: 1,
      organization_id: a.organization_id,
      role: a.role,
      permissions: EXPENSE_PERMISSIONS[a.role],
      today: almatyToday(this.now()),
      groups: EXPENSE_GROUPS,
      categories: EXPENSE_CATEGORIES,
      sources: EXPENSE_SOURCES,
      revenue_types: REVENUE_TYPES,
      locations: a.branches,
      closed_months: (
        await db.query(
          `SELECT to_char(m.month,'YYYY-MM') AS month,m.closed_at,c.name closed_by FROM bo_expense_months m
           JOIN catalog_managers c ON c.id=m.closed_by WHERE m.organization_id=$1 ORDER BY m.month DESC`,
          [a.organization_id],
        )
      ).rows,
      revenue_available: await posReadable(db),
      cogs_available: await cogsReadable(db),
    }));
  }

  /** PUT /cell: one amount per day (or month), place, article and source; empty removes it. */
  async cell(token: string, input: unknown) {
    const c = parse(CellCommand, input);
    return this.write(token, 'expenses.write', async (db, a) => {
      const location = this.location(a, c.location_id);
      const { date, monthly } = periodDate(c);
      if (c.period === 'day') this.notFuture(date);
      else if (c.month > monthOf(almatyToday(this.now()))) fail('INVALID_REQUEST');
      if (location === null && !expenseCategory(c.category)!.company) fail('INVALID_REQUEST');
      const key = [a.organization_id, location ?? NIL, date, monthly, c.category, c.source];
      const current = (
        await db.query(
          `SELECT ${cols()} FROM bo_expense_entries WHERE cell AND organization_id=$1 AND coalesce(location_id,'${NIL}'::uuid)=$2
           AND date=$3 AND monthly=$4 AND category=$5 AND source=$6`,
          key,
        )
      ).rows[0];
      const row = (
        await db.query(
          "SELECT to_char(pl_month,'YYYY-MM') pl_month,comment FROM bo_expense_rows WHERE organization_id=$1 AND location_key=$2 AND date=$3 AND monthly=$4 AND category=$5",
          key.slice(0, 5),
        )
      ).rows[0];
      const plMonth = monthly ? monthOf(date) : (row?.pl_month ?? monthOf(date));
      const amount = c.amount_minor === null ? 0n : BigInt(c.amount_minor);
      await this.open(db, a.organization_id, [
        monthOf(date),
        plMonth,
        ...(current ? [current.pl_month] : []),
      ]);
      if (amount === 0n) {
        if (!current) return { id: null, deleted: false };
        await db.query('DELETE FROM bo_expense_entries WHERE id=$1', [current.id]);
        await this.log(db, a, 'entry.delete', location, date, entryOut(current), null);
        return { id: current.id, deleted: true };
      }
      if (current) {
        const updated = (
          await db.query(
            `UPDATE bo_expense_entries SET amount_minor=$2,updated_by=$3,updated_at=clock_timestamp(),revision=revision+1 WHERE id=$1 RETURNING ${cols()}`,
            [current.id, String(amount), a.id],
          )
        ).rows[0];
        await this.log(db, a, 'entry.update', location, date, entryOut(current), entryOut(updated));
        return { id: current.id, revision: updated.revision };
      }
      const id = randomUUID();
      const created = (
        await db.query(
          `INSERT INTO bo_expense_entries(id,organization_id,location_id,date,category,source,amount_minor,pl_month,monthly,cell,comment,author_id,updated_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$11) RETURNING ${cols()}`,
          [
            id,
            a.organization_id,
            location,
            date,
            c.category,
            c.source,
            String(amount),
            firstOf(plMonth),
            monthly,
            row?.comment ?? '',
            a.id,
          ],
        )
      ).rows[0];
      await this.log(db, a, 'entry.create', location, date, null, entryOut(created));
      return { id, revision: 1 };
    });
  }

  /** PUT /row: the P&L month and the comment of a grid row; its cells change with it. */
  async row(token: string, input: unknown) {
    const c = parse(RowCommand, input);
    return this.write(token, 'expenses.write', async (db, a) => {
      const location = this.location(a, c.location_id);
      const { date, monthly } = periodDate(c);
      if (c.period === 'day') this.notFuture(date);
      const plMonth = monthly ? monthOf(date) : c.pl_month;
      const key = [a.organization_id, location ?? NIL, date, monthly, c.category];
      const cells = (
        await db.query(
          `SELECT ${cols()} FROM bo_expense_entries WHERE cell AND organization_id=$1 AND coalesce(location_id,'${NIL}'::uuid)=$2 AND date=$3 AND monthly=$4 AND category=$5`,
          key,
        )
      ).rows;
      await this.open(db, a.organization_id, [
        monthOf(date),
        plMonth,
        ...cells.map((e) => e.pl_month as string),
      ]);
      const before = (
        await db.query(
          "SELECT to_char(pl_month,'YYYY-MM') pl_month,comment FROM bo_expense_rows WHERE organization_id=$1 AND location_key=$2 AND date=$3 AND monthly=$4 AND category=$5",
          key,
        )
      ).rows[0];
      await db.query(
        `INSERT INTO bo_expense_rows(organization_id,location_key,date,monthly,category,pl_month,comment,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(organization_id,location_key,date,monthly,category) DO UPDATE SET pl_month=excluded.pl_month,comment=excluded.comment,updated_by=excluded.updated_by,updated_at=clock_timestamp()`,
        [...key, firstOf(plMonth), c.comment, a.id],
      );
      await db.query(
        `UPDATE bo_expense_entries SET pl_month=$6,comment=$7,updated_by=$8,updated_at=clock_timestamp(),revision=revision+1
         WHERE cell AND organization_id=$1 AND coalesce(location_id,'${NIL}'::uuid)=$2 AND date=$3 AND monthly=$4 AND category=$5`,
        [...key, firstOf(plMonth), c.comment, a.id],
      );
      await this.log(db, a, 'row', location, date, before ?? null, {
        category: c.category,
        monthly,
        pl_month: plMonth,
        comment: c.comment,
      });
      return { pl_month: plMonth, comment: c.comment, cells: cells.length };
    });
  }

  /** POST /entries: a record «с контрагентом» (several payments of one article). */
  async createEntry(token: string, input: unknown) {
    const c = parse(EntryCommand, input);
    return this.write(token, 'expenses.write', async (db, a) => {
      const e = this.entryValues(a, c);
      await this.open(db, a.organization_id, [monthOf(e.date), e.pl_month]);
      const id = randomUUID();
      const created = (
        await db.query(
          `INSERT INTO bo_expense_entries(id,organization_id,location_id,date,category,source,amount_minor,pl_month,monthly,cell,counterparty,comment,author_id,updated_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11,$12,$12) RETURNING ${cols()}`,
          [
            id,
            a.organization_id,
            e.location,
            e.date,
            c.category,
            c.source,
            c.amount_minor,
            firstOf(e.pl_month),
            c.monthly,
            c.counterparty,
            c.comment,
            a.id,
          ],
        )
      ).rows[0];
      await this.log(db, a, 'entry.create', e.location, e.date, null, entryOut(created));
      return entryOut(created);
    });
  }
  private entryValues(a: Actor, c: z.infer<typeof EntryCommand>) {
    const location = this.location(a, c.location_id);
    if (location === null && !expenseCategory(c.category)!.company) fail('INVALID_REQUEST');
    // A monthly record is dated the last day of its month and belongs to that month.
    const date = c.monthly ? lastDay(monthOf(c.date)) : c.date;
    const pl_month = c.monthly ? monthOf(c.date) : c.pl_month;
    if (c.monthly) {
      if (monthOf(c.date) > monthOf(almatyToday(this.now()))) fail('INVALID_REQUEST');
    } else this.notFuture(date);
    return { location, date, pl_month };
  }

  /** PUT /entries/:id: change any field of a record (a cell or a record with a counterparty). */
  async updateEntry(token: string, id: string, input: unknown) {
    parse(z.uuid(), id);
    const c = parse(EntryCommand, input);
    return this.write(token, 'expenses.write', async (db, a) => {
      const current = await this.entry(db, a, id);
      const e = this.entryValues(a, c);
      await this.open(db, a.organization_id, [
        monthOf(current.date),
        current.pl_month,
        monthOf(e.date),
        e.pl_month,
      ]);
      let updated;
      try {
        updated = (
          await db.query(
            `UPDATE bo_expense_entries SET location_id=$2,date=$3,category=$4,source=$5,amount_minor=$6,pl_month=$7,monthly=$8,counterparty=$9,comment=$10,
             updated_by=$11,updated_at=clock_timestamp(),revision=revision+1 WHERE id=$1 RETURNING ${cols()}`,
            [
              id,
              e.location,
              e.date,
              c.category,
              c.source,
              c.amount_minor,
              firstOf(e.pl_month),
              c.monthly,
              c.counterparty,
              c.comment,
              a.id,
            ],
          )
        ).rows[0];
      } catch (error) {
        // Moving a cell onto an occupied cell of the grid.
        if ((error as { code?: string }).code === '23505') fail('CONFLICT');
        throw error;
      }
      await this.log(
        db,
        a,
        'entry.update',
        e.location,
        e.date,
        entryOut(current),
        entryOut(updated),
      );
      return entryOut(updated);
    });
  }
  async deleteEntry(token: string, id: string) {
    parse(z.uuid(), id);
    return this.write(token, 'expenses.write', async (db, a) => {
      const current = await this.entry(db, a, id);
      await this.open(db, a.organization_id, [monthOf(current.date), current.pl_month]);
      await db.query('DELETE FROM bo_expense_entries WHERE id=$1', [id]);
      await this.log(
        db,
        a,
        'entry.delete',
        current.location_id,
        current.date,
        entryOut(current),
        null,
      );
      return { id, deleted: true };
    });
  }
  private async entry(db: Db, a: Actor, id: string) {
    const row = (
      await db.query(
        `SELECT ${cols()} FROM bo_expense_entries WHERE id=$1 AND organization_id=$2 FOR UPDATE`,
        [id, a.organization_id],
      )
    ).rows[0];
    return row ?? fail('NOT_FOUND');
  }

  /** PUT /cash: the opening (empty: the previous day's count) and the cashier's count. */
  async cash(token: string, input: unknown) {
    const c = parse(CashCommand, input);
    return this.write(token, 'expenses.write', async (db, a) => {
      this.location(a, c.location_id);
      this.notFuture(c.date);
      await this.open(db, a.organization_id, [monthOf(c.date)]);
      const before = (
        await db.query(
          'SELECT opening_minor::text,counted_minor::text,comment FROM bo_expense_cash WHERE location_id=$1 AND date=$2',
          [c.location_id, c.date],
        )
      ).rows[0];
      await db.query(
        `INSERT INTO bo_expense_cash(organization_id,location_id,date,opening_minor,counted_minor,comment,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(location_id,date) DO UPDATE SET opening_minor=excluded.opening_minor,counted_minor=excluded.counted_minor,comment=excluded.comment,
         updated_by=excluded.updated_by,updated_at=clock_timestamp()`,
        [
          a.organization_id,
          c.location_id,
          c.date,
          c.opening_minor,
          c.counted_minor,
          c.comment,
          a.id,
        ],
      );
      await this.log(db, a, 'cash', c.location_id, c.date, before ?? null, {
        opening_minor: c.opening_minor,
        counted_minor: c.counted_minor,
        comment: c.comment,
      });
      return (await this.cashDays(db, a, [c.location_id], c.date, c.date)).get(
        c.location_id + ':' + c.date,
      )!;
    });
  }

  /** Cash reconciliation of the branches for every day of [start, end]. */
  private async cashDays(db: Db, a: Actor, locations: string[], start: string, end: string) {
    const cashRows = (
      await db.query<{
        location_id: string;
        date: string;
        opening_minor: string | null;
        counted_minor: string | null;
        comment: string;
      }>(
        `SELECT location_id,date::text,opening_minor::text,counted_minor::text,comment FROM bo_expense_cash
         WHERE organization_id=$1 AND location_id=ANY($2::uuid[]) AND date BETWEEN $3 AND $4`,
        [a.organization_id, locations, start, end],
      )
    ).rows;
    const previous = (
      await db.query<{ location_id: string; date: string; counted_minor: string }>(
        `SELECT DISTINCT ON (location_id) location_id,date::text,counted_minor::text FROM bo_expense_cash
         WHERE organization_id=$1 AND location_id=ANY($2::uuid[]) AND date<$3 AND counted_minor IS NOT NULL ORDER BY location_id,date DESC`,
        [a.organization_id, locations, start],
      )
    ).rows;
    const money = (
      await db.query<{
        location_id: string;
        date: string;
        category: string;
        source: string;
        amount: string;
      }>(
        `SELECT location_id,date::text,category,source,sum(amount_minor)::text amount FROM bo_expense_entries
         WHERE organization_id=$1 AND location_id=ANY($2::uuid[]) AND date BETWEEN $3 AND $4 GROUP BY 1,2,3,4`,
        [a.organization_id, locations, start, end],
      )
    ).rows;
    const revenue = await revenueByDay(db, locations, start, end);
    const out = new Map<
      string,
      ReturnType<typeof cashDay> & {
        location_id: string;
        date: string;
        comment: string;
        previous_date: string | null;
      }
    >();
    const last = new Map(previous.map((p) => [p.location_id, p]));
    for (const day of daysBetween(start, end))
      for (const l of locations) {
        const sums = { rev: 0n, inc: 0n, wd: 0n, exp: 0n, col: 0n };
        sums.rev += revenue.get(l)?.get(day)?.get('cash') ?? 0n;
        for (const m of money) {
          if (m.location_id !== l || m.date !== day) continue;
          const cat = expenseCategory(m.category);
          const v = big(m.amount);
          if (m.category === 'cash_withdrawal') sums.wd += v;
          else if (m.category === 'cash_collection') sums.col += v;
          else if (m.source !== 'cash') continue;
          else if (cat?.kind === 'income' && m.category === 'rev_manual') sums.rev += v;
          else if (cat?.kind === 'income') sums.inc += v;
          else if (cat?.kind === 'expense') sums.exp += v;
        }
        const row = cashRows.find((r) => r.location_id === l && r.date === day);
        const prev = last.get(l);
        const result = cashDay({
          opening_minor: row?.opening_minor == null ? null : big(row.opening_minor),
          previous_counted_minor: prev ? big(prev.counted_minor) : null,
          cash_revenue_minor: sums.rev,
          cash_income_minor: sums.inc,
          withdrawal_minor: sums.wd,
          cash_expenses_minor: sums.exp,
          collection_minor: sums.col,
          counted_minor: row?.counted_minor == null ? null : big(row.counted_minor),
        });
        out.set(l + ':' + day, {
          ...result,
          location_id: l,
          date: day,
          comment: row?.comment ?? '',
          previous_date: prev?.date ?? null,
        });
        if (row?.counted_minor != null)
          last.set(l, { location_id: l, date: day, counted_minor: row.counted_minor });
      }
    return out;
  }

  /**
   * GET /entry: everything the «Ввод» screen needs for a day (or a month): every place with its
   * status, records, row defaults, revenue by type, cost by the technological cards, cash.
   */
  async entryScreen(token: string, input: unknown) {
    const p = parse(Period, input);
    return this.read(token, async (db, a) => {
      const { date, monthly } = periodDate(p);
      const start = p.period === 'day' ? p.date : firstOf(p.month);
      const ids = a.branches.map((b) => b.id);
      const entries = (
        await db.query(
          `SELECT ${cols('e.')},m.name author FROM bo_expense_entries e JOIN catalog_managers m ON m.id=e.author_id
           WHERE e.organization_id=$1 AND e.date=$2 AND e.monthly=$3 ORDER BY e.created_at,e.id`,
          [a.organization_id, date, monthly],
        )
      ).rows.map((r) => ({ ...entryOut(r), author: r.author }));
      const rows = (
        await db.query(
          "SELECT location_key,category,to_char(pl_month,'YYYY-MM') pl_month,comment FROM bo_expense_rows WHERE organization_id=$1 AND date=$2 AND monthly=$3",
          [a.organization_id, date, monthly],
        )
      ).rows.map((r) => ({
        location_id: r.location_key === NIL ? null : r.location_key,
        category: r.category,
        pl_month: r.pl_month,
        comment: r.comment,
      }));
      const revenue = await revenueByDay(db, ids, start, date);
      const cogs = await cogsByDay(db, ids, start, date);
      const cash = p.period === 'day' ? await this.cashDays(db, a, ids, date, date) : new Map();
      const places = [
        ...a.branches.map((b) => ({ id: b.id as string | null, name: b.name })),
        { id: null, name: 'Общие расходы компании' },
      ];
      const locations = places.map((place) => {
        const own = entries.filter((e) => e.location_id === place.id);
        const bySource: Record<string, string> = {};
        let expenses = 0n,
          manual = 0n;
        for (const e of own) {
          const cat = expenseCategory(e.category);
          if (cat?.kind === 'expense') {
            expenses += big(e.amount_minor);
            bySource[e.source] = String(big(bySource[e.source]) + big(e.amount_minor));
          }
          if (e.category === 'rev_manual') manual += big(e.amount_minor);
        }
        const types: Record<string, string> = {};
        let revenueTotal = manual;
        if (place.id)
          for (const [, day] of revenue.get(place.id) ??
            new Map<string, Map<RevenueType, bigint>>())
            for (const [t, v] of day) {
              types[t] = String(big(types[t]) + v);
              revenueTotal += v;
            }
        let cogsTotal: bigint | null = null;
        if (place.id && cogs) {
          cogsTotal = 0n;
          for (const [, v] of cogs.get(place.id) ?? new Map<string, bigint>()) cogsTotal += v;
        }
        const cashDayValue = place.id ? (cash.get(place.id + ':' + date) ?? null) : null;
        return {
          id: place.id,
          name: place.name,
          filled: own.length > 0,
          entries: own,
          rows: rows.filter((r) => r.location_id === place.id),
          revenue: place.id
            ? { by_type: types, manual_minor: String(manual), total_minor: String(revenueTotal) }
            : null,
          cogs_ttk_minor: cogsTotal === null ? null : String(cogsTotal),
          foodcost_percent: cogsTotal === null ? '' : percent(cogsTotal, revenueTotal),
          expenses_minor: String(expenses),
          expenses_by_source: bySource,
          expense_percent: percent(expenses, revenueTotal),
          cash: cashDayValue,
          status: cashDayValue?.mismatch ? 'mismatch' : own.length ? 'filled' : 'empty',
        };
      });
      const months = [monthOf(date)];
      const closed =
        (
          await db.query(
            'SELECT 1 FROM bo_expense_months WHERE organization_id=$1 AND month=ANY($2::date[])',
            [a.organization_id, months.map(firstOf)],
          )
        ).rows.length > 0;
      return {
        period: p,
        date,
        monthly,
        closed,
        role: a.role,
        filled: locations.filter((l) => l.id !== null && l.filled).length,
        total: a.branches.length,
        locations,
      };
    });
  }

  /** GET /journal: every record with filters, newest first, at most 2000. */
  async journal(token: string, input: unknown) {
    const q = parse(JournalQuery, input);
    return this.read(token, async (db, a) => {
      const where = [`e.organization_id=$1`];
      const args: unknown[] = [a.organization_id];
      const arg = (v: unknown) => (args.push(v), '$' + args.length);
      if (q.basis === 'date')
        where.push(`e.date BETWEEN ${arg(q.start_date)} AND ${arg(q.end_date)}`);
      else
        where.push(
          `e.pl_month BETWEEN date_trunc('month',${arg(q.start_date)}::date) AND ${arg(q.end_date)}`,
        );
      if (q.location === 'company') where.push('e.location_id IS NULL');
      else if (q.location !== 'all') where.push(`e.location_id=${arg(q.location)}`);
      if (q.category) where.push(`e.category=ANY(${arg(q.category.split(','))}::text[])`);
      if (q.source) where.push(`e.source=${arg(q.source)}`);
      if (q.search)
        where.push(
          `strpos(lower(concat_ws(' ',e.comment,e.counterparty,m.name,u.name)),lower(${arg(q.search)}))>0`,
        );
      const rows = (
        await db.query(
          `SELECT ${cols('e.')},m.name author,u.name updated_by_name FROM bo_expense_entries e JOIN catalog_managers m ON m.id=e.author_id
           JOIN catalog_managers u ON u.id=e.updated_by WHERE ${where.join(' AND ')}
           ORDER BY ${q.group === 'pl_month' ? 'e.pl_month DESC,' : ''}e.date DESC,e.created_at DESC,e.id LIMIT 2001`,
          args,
        )
      ).rows;
      const total = rows.slice(0, 2000).reduce((s, r) => s + big(r.amount_minor), 0n);
      return {
        query: q,
        truncated: rows.length > 2000,
        total_minor: String(total),
        entries: rows
          .slice(0, 2000)
          .map((r) => ({ ...entryOut(r), author: r.author, updated_by_name: r.updated_by_name })),
      };
    });
  }

  /** P&L facts of [from, to]: records by P&L month, revenue and cost by the cards by month. */
  private async facts(db: Db, a: Actor, from: string, to: string, location: string) {
    const ids = a.branches.map((b) => b.id).filter((id) => location === 'all' || location === id);
    const start = firstOf(from),
      end = lastDay(to);
    const entries: EntryFact[] = (
      await db.query<{ location: string | null; month: string; category: string; amount: string }>(
        `SELECT location_id location,to_char(pl_month,'YYYY-MM') AS month,category,sum(amount_minor)::text amount FROM bo_expense_entries
         WHERE organization_id=$1 AND pl_month BETWEEN $2 AND $3 GROUP BY 1,2,3`,
        [a.organization_id, start, firstOf(to)],
      )
    ).rows
      .filter((r) =>
        location === 'all'
          ? true
          : location === 'company'
            ? r.location === null
            : r.location === location,
      )
      .map((r) => ({
        location: r.location ?? COMPANY,
        month: r.month,
        category: r.category,
        amount_minor: big(r.amount),
      }));
    const revenue: RevenueFact[] = [];
    if (location !== 'company')
      for (const [l, days] of await revenueByDay(db, ids, start, end))
        for (const [day, types] of days)
          for (const [type, v] of types)
            revenue.push({ location: l, month: monthOf(day), type, amount_minor: v });
    const cogsDays = location === 'company' ? new Map() : await cogsByDay(db, ids, start, end);
    const cogs: CogsFact[] | null = cogsDays ? [] : null;
    if (cogsDays && cogs)
      for (const [l, days] of cogsDays)
        for (const [day, v] of days)
          cogs.push({ location: l, month: monthOf(day), amount_minor: v });
    return { entries, revenue, cogs, ids };
  }

  /** GET /pnl: the P&L (ОПУ) by branches or by months. */
  async pnl(token: string, input: unknown) {
    const q = parse(PnlQuery, input);
    return this.read(token, async (db, a) => {
      const months = monthsBetween(q.from, q.to);
      const f = await this.facts(db, a, q.from, q.to, q.location);
      const report = computePnl(f.entries, f.revenue, f.cogs, {
        columns: q.columns,
        cogs: q.cogs,
        allocate: q.allocate === 'true',
        locations: f.ids,
        months,
      });
      return {
        query: q,
        months,
        locations: a.branches,
        cogs_available: f.cogs !== null && f.cogs.length > 0,
        dishes:
          q.location === 'company'
            ? []
            : await dishFoodcost(db, f.ids, firstOf(q.from), lastDay(q.to)),
        ...report,
      };
    });
  }

  /** GET /analytics: series by month, structure by article, branches, money by source. */
  async analytics(token: string, input: unknown) {
    const q = parse(AnalyticsQuery, input);
    return this.read(token, async (db, a) => {
      const months = monthsBetween(q.from, q.to);
      const f = await this.facts(db, a, q.from, q.to, q.location);
      const series = months.map((month) => {
        const s = { month, cogs: 0n, payroll: 0n, location: 0n, commissions: 0n, other: 0n };
        for (const e of f.entries) {
          if (e.month !== month) continue;
          const cat = expenseCategory(e.category);
          if (cat?.kind === 'expense' && cat.series) s[cat.series] += e.amount_minor;
        }
        return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, String(v)]));
      });
      const structure = new Map<string, bigint>();
      for (const e of f.entries)
        if (expenseCategory(e.category)?.kind === 'expense')
          structure.set(e.category, (structure.get(e.category) ?? 0n) + e.amount_minor);
      const pnl = computePnl(f.entries, f.revenue, f.cogs, {
        columns: 'locations',
        cogs: 'payments',
        allocate: false,
        locations: f.ids,
        months,
      });
      const pick = (key: string) => pnl.lines.find((l) => l.key === key)!.values;
      const compare = pnl.columns
        .filter((c) => c !== 'total')
        .map((col) => ({
          location: col,
          revenue_minor: pick('revenue')[col],
          cogs_minor: pick('cogs')[col],
          expenses_minor: pick('expenses')[col],
          ebitda_minor: pick('ebitda')[col],
          margin_percent: pick('margin')[col],
        }));
      // Money by source for the last month of the period, by the date of payment.
      const last = months[months.length - 1]!;
      const flows = (
        await db.query<{ source: string; category: string; amount: string }>(
          `SELECT source,category,sum(amount_minor)::text amount FROM bo_expense_entries WHERE organization_id=$1 AND date BETWEEN $2 AND $3
           AND ($4='all' OR ($4='company' AND location_id IS NULL) OR location_id::text=$4) GROUP BY 1,2`,
          [a.organization_id, firstOf(last), lastDay(last), q.location],
        )
      ).rows;
      const sources = EXPENSE_SOURCES.map((s) => {
        let income = 0n,
          out = 0n,
          movementIn = 0n,
          movementOut = 0n;
        for (const r of flows) {
          if (r.source !== s.code) continue;
          const cat = expenseCategory(r.category);
          const v = big(r.amount);
          if (cat?.kind === 'income') income += v;
          else if (cat?.kind === 'expense') out += v;
          else if (r.category === 'cash_withdrawal') movementOut += v;
          else if (r.category === 'cash_collection') movementIn += v;
        }
        return {
          source: s.code,
          income_minor: String(income),
          expenses_minor: String(out),
          withdrawal_minor: String(movementOut),
          collection_minor: String(movementIn),
        };
      });
      return {
        query: q,
        months,
        locations: a.branches,
        series,
        structure: [...structure]
          .sort((x, y) => (x[1] > y[1] ? -1 : 1))
          .map(([category, v]) => ({ category, amount_minor: String(v) })),
        compare,
        sources_month: last,
        sources,
      };
    });
  }

  /** POST /months/:month/close and /open: the director only. */
  async month(token: string, month: string, closed: boolean) {
    parse(Month, month);
    return this.write(token, 'expenses.close', async (db, a) => {
      const current = (
        await db.query(
          'SELECT closed_at FROM bo_expense_months WHERE organization_id=$1 AND month=$2',
          [a.organization_id, firstOf(month)],
        )
      ).rows[0];
      if (closed === !!current) fail('CONFLICT');
      if (closed)
        await db.query(
          'INSERT INTO bo_expense_months(organization_id,month,closed_by) VALUES($1,$2,$3)',
          [a.organization_id, firstOf(month), a.id],
        );
      else
        await db.query('DELETE FROM bo_expense_months WHERE organization_id=$1 AND month=$2', [
          a.organization_id,
          firstOf(month),
        ]);
      await this.log(db, a, closed ? 'month.close' : 'month.open', null, firstOf(month), null, {
        month,
      });
      return { month, closed };
    });
  }

  /** GET /access and PUT /access: the director gives and takes the access to the section. */
  async access(token: string) {
    return this.read(token, async (db, a) => {
      if (a.role !== 'director') fail('FORBIDDEN');
      const people = (
        await db.query<{ id: string; name: string }>(
          'SELECT id,name FROM catalog_managers WHERE organization_id=$1 AND revoked_at IS NULL ORDER BY name,id',
          [a.organization_id],
        )
      ).rows;
      const out = [];
      for (const p of people)
        out.push({
          actor_id: p.id,
          name: p.name,
          role: await this.roleOf(db, p.id, a.organization_id, a.branches.length),
        });
      return { people: out };
    });
  }
  async setAccess(token: string, input: unknown) {
    const c = parse(AccessCommand, input);
    return this.write(token, 'expenses.access', async (db, a) => {
      const person = (
        await db.query(
          'SELECT id FROM catalog_managers WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL',
          [c.actor_id, a.organization_id],
        )
      ).rows[0];
      if (!person) fail('NOT_FOUND');
      // A director never takes away his own access: the organization would have no director.
      if (c.actor_id === a.id && c.role !== 'director') fail('CONFLICT');
      const before = await this.roleOf(db, c.actor_id, a.organization_id, a.branches.length);
      await db.query(
        'INSERT INTO bo_expense_access(organization_id,actor_id,role,granted_by) VALUES($1,$2,$3,$4)',
        [a.organization_id, c.actor_id, c.role, a.id],
      );
      await this.log(
        db,
        a,
        'access',
        null,
        null,
        { actor_id: c.actor_id, role: before },
        { actor_id: c.actor_id, role: c.role },
      );
      return { actor_id: c.actor_id, role: c.role };
    });
  }

  /** GET /log: the latest actions of the organization. */
  async actions(token: string, input: unknown) {
    const q = parse(
      z.strictObject({ page: z.coerce.number().int().min(0).max(10000).default(0) }),
      input,
    );
    return this.read(token, async (db, a) => ({
      page: q.page,
      actions: (
        await db.query(
          `SELECT l.id::text,l.action,l.location_id,l.date::text,l.before_value,l.after_value,l.created_at,m.name author
           FROM bo_expense_log l JOIN catalog_managers m ON m.id=l.actor_id WHERE l.organization_id=$1 ORDER BY l.id DESC LIMIT 200 OFFSET $2`,
          [a.organization_id, q.page * 200],
        )
      ).rows,
    }));
  }
}

export function entryOut(r: Record<string, unknown>) {
  return {
    id: r['id'] as string,
    location_id: (r['location_id'] as string | null) ?? null,
    date: String(r['date']),
    category: r['category'] as string,
    source: r['source'] as string,
    amount_minor: String(r['amount_minor']),
    pl_month: String(r['pl_month']),
    monthly: r['monthly'] === true,
    cell: r['cell'] === true,
    counterparty: (r['counterparty'] as string) ?? '',
    comment: (r['comment'] as string) ?? '',
    revision: Number(r['revision']),
    created_at:
      r['created_at'] instanceof Date ? (r['created_at'] as Date).toISOString() : r['created_at'],
    updated_at:
      r['updated_at'] instanceof Date ? (r['updated_at'] as Date).toISOString() : r['updated_at'],
  };
}

export function daysBetween(start: string, end: string) {
  const out: string[] = [];
  for (
    let t = Date.parse(start + 'T00:00:00Z');
    t <= Date.parse(end + 'T00:00:00Z') && out.length < 400;
    t += 86400000
  )
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

async function readable(db: Db, tables: readonly string[]) {
  const r = await db.query<{ ok: boolean }>(
    `SELECT bool_and(to_regclass(t) IS NOT NULL AND has_table_privilege(to_regclass(t),'SELECT')) ok FROM unnest($1::text[]) t`,
    [tables],
  );
  return r.rows[0]?.ok === true;
}
const POS_TABLES = [
  'cloud_pos_sales',
  'cloud_pos_tenders',
  'cloud_pos_refunds',
  'cloud_pos_refund_tenders',
];
const CLOUD_TABLES = ['commerce_orders', 'commerce_captures', 'commerce_refund_effects'];
const COGS_TABLES = ['bo_stock_documents', 'bo_stock_movements'];
const posReadable = (db: Db) => readable(db, POS_TABLES);
const cogsReadable = (db: Db) => readable(db, COGS_TABLES);

/**
 * Revenue by branch, Almaty day and type: cashier tenders of revenue sales by their business day,
 * minus voids and refunds by the day they were made (as the sales report counts them), plus the
 * cloud orders (app, kiosk) paid online, minus their refunds. Staff meals and marketing are never
 * revenue. Without the cashier tables there is only the cloud part.
 */
export async function revenueByDay(db: Db, branches: string[], start: string, end: string) {
  const out = new Map<string, Map<string, Map<RevenueType, bigint>>>();
  const put = (l: string, day: string, type: RevenueType | null | undefined, v: bigint) => {
    if (!type) return;
    let days = out.get(l);
    if (!days) out.set(l, (days = new Map()));
    let types = days.get(day);
    if (!types) days.set(day, (types = new Map()));
    types.set(type, (types.get(type) ?? 0n) + v);
  };
  if (!branches.length) return out;
  const window = [branches, start + 'T00:00:00+05:00', addDay(end) + 'T00:00:00+05:00'];
  if (await posReadable(db)) {
    for (const r of (
      await db.query<{ branch_id: string; day: string; method: string; amount: string }>(
        `SELECT s.branch_id,s.business_date::text AS day,t.method,sum(t.amount_minor)::text amount
         FROM cloud_pos_tenders t JOIN cloud_pos_sales s ON s.order_id=t.order_id AND s.branch_id=t.branch_id
         WHERE s.branch_id=ANY($1::uuid[]) AND s.business_date BETWEEN $2::date AND $3::date AND s.revenue_kind='revenue' GROUP BY 1,2,3`,
        [branches, start, end],
      )
    ).rows)
      put(r.branch_id, r.day, POS_METHOD_REVENUE[r.method] ?? 'other', big(r.amount));
    for (const r of (
      await db.query<{ branch_id: string; day: string; method: string; amount: string }>(
        `SELECT r.branch_id,(r.created_at AT TIME ZONE 'Asia/Almaty')::date::text AS day,p.method,sum(p.amount_minor)::text amount
         FROM cloud_pos_refund_tenders p JOIN cloud_pos_refunds r ON r.refund_id=p.refund_id AND r.branch_id=p.branch_id
         JOIN cloud_pos_sales s ON s.order_id=r.order_id AND s.branch_id=r.branch_id
         WHERE r.branch_id=ANY($1::uuid[]) AND r.created_at>=$2 AND r.created_at<$3 AND s.revenue_kind='revenue' GROUP BY 1,2,3`,
        window,
      )
    ).rows)
      put(r.branch_id, r.day, POS_METHOD_REVENUE[r.method] ?? 'other', -big(r.amount));
  }
  if (await readable(db, CLOUD_TABLES)) {
    for (const r of (
      await db.query<{ branch_id: string; day: string; amount: string }>(
        `SELECT o.branch_id,(c.occurred_at AT TIME ZONE 'Asia/Almaty')::date::text AS day,sum(c.amount_minor)::text amount
         FROM commerce_captures c JOIN commerce_orders o ON o.id=c.order_id
         WHERE o.branch_id=ANY($1::uuid[]) AND o.snapshot->>'channel' IN ('mobile','kiosk') AND c.occurred_at>=$2 AND c.occurred_at<$3 GROUP BY 1,2`,
        window,
      )
    ).rows)
      put(r.branch_id, r.day, 'card', big(r.amount));
    for (const r of (
      await db.query<{ branch_id: string; day: string; amount: string }>(
        `SELECT o.branch_id,(e.occurred_at AT TIME ZONE 'Asia/Almaty')::date::text AS day,sum(e.amount_minor)::text amount
         FROM commerce_refund_effects e JOIN commerce_orders o ON o.id=e.order_id
         WHERE o.branch_id=ANY($1::uuid[]) AND o.snapshot->>'channel' IN ('mobile','kiosk') AND e.occurred_at>=$2 AND e.occurred_at<$3 GROUP BY 1,2`,
        window,
      )
    ).rows)
      put(r.branch_id, r.day, 'card', -big(r.amount));
  }
  return out;
}
const addDay = (day: string) =>
  new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);

/**
 * Cost of what was sold by the technological cards: the stock value of the automatic consumption
 * documents (cloud075, one per sold order), by the Almaty day the document was made, minus their
 * storno. Null when the stock tables are not readable; an empty map when nothing was consumed.
 */
export async function cogsByDay(db: Db, branches: string[], start: string, end: string) {
  if (!(await cogsReadable(db))) return null;
  const out = new Map<string, Map<string, bigint>>();
  if (!branches.length) return out;
  const reversals = (
    await db.query<{ ok: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='bo_stock_documents' AND column_name='reverses_document_id' AND table_schema=ANY(current_schemas(false))) ok",
    )
  ).rows[0]?.ok;
  const sql = `SELECT d.branch_id,(d.created_at AT TIME ZONE 'Asia/Almaty')::date::text AS day,sum(-m.value_delta_minor)::text amount
    FROM bo_stock_documents d JOIN bo_stock_movements m ON m.document_id=d.id AND m.branch_id=d.branch_id
    WHERE d.branch_id=ANY($1::uuid[]) AND d.created_at>=$2 AND d.created_at<$3 AND (d.kind='consumption'
    ${reversals ? "OR (d.kind='reversal' AND EXISTS(SELECT 1 FROM bo_stock_documents x WHERE x.id=d.reverses_document_id AND x.branch_id=d.branch_id AND x.kind='consumption'))" : ''})
    GROUP BY 1,2`;
  for (const r of (
    await db.query<{ branch_id: string; day: string; amount: string }>(sql, [
      branches,
      start + 'T00:00:00+05:00',
      addDay(end) + 'T00:00:00+05:00',
    ])
  ).rows) {
    let days = out.get(r.branch_id);
    if (!days) out.set(r.branch_id, (days = new Map()));
    days.set(r.day, big(r.amount));
  }
  return out;
}

/**
 * Food cost by dish: revenue of the cashier lines of each product and the cost of their orders by
 * the cards, the cost of an order shared among its lines by their amounts. Empty without data.
 */
export async function dishFoodcost(db: Db, branches: string[], start: string, end: string) {
  if (!branches.length || !(await posReadable(db)) || !(await cogsReadable(db))) return [];
  const has = (
    await db.query<{ ok: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='bo_stock_documents' AND column_name='source_ref' AND table_schema=ANY(current_schemas(false))) ok",
    )
  ).rows[0]?.ok;
  if (!has) return [];
  const rows = (
    await db.query<{ product_id: string; name: string; revenue: string; cost: string }>(
      `WITH lines AS (
         SELECT s.order_id,s.branch_id,l->>'product_id' product_id,coalesce(l->'name'->>'ru','') name,
           coalesce((l->>'total_minor')::numeric,0) amount
         FROM cloud_pos_sales s CROSS JOIN LATERAL jsonb_array_elements(s.lines) l
         WHERE s.branch_id=ANY($1::uuid[]) AND s.business_date BETWEEN $2::date AND $3::date AND s.revenue_kind='revenue' AND s.voided_at IS NULL),
       orders AS (SELECT order_id,branch_id,sum(amount) total FROM lines GROUP BY 1,2),
       costs AS (
         SELECT d.branch_id,substr(d.source_ref,5)::uuid order_id,sum(-m.value_delta_minor) cost
         FROM bo_stock_documents d JOIN bo_stock_movements m ON m.document_id=d.id AND m.branch_id=d.branch_id
         WHERE d.branch_id=ANY($1::uuid[]) AND d.kind='consumption' AND d.source_ref LIKE 'pos:%' GROUP BY 1,2)
       SELECT l.product_id,max(l.name) name,round(sum(l.amount))::text revenue,
         round(sum(CASE WHEN o.total>0 THEN c.cost*l.amount/o.total ELSE 0 END))::text cost
       FROM lines l JOIN orders o USING(order_id,branch_id) JOIN costs c USING(order_id,branch_id)
       WHERE l.product_id IS NOT NULL GROUP BY 1 ORDER BY sum(l.amount) DESC LIMIT 300`,
      [branches, start, end],
    )
  ).rows;
  return rows.map((r) => ({
    product_id: r.product_id,
    name: r.name,
    revenue_minor: r.revenue,
    cogs_minor: r.cost,
    foodcost_percent: percent(big(r.cost), big(r.revenue)),
  }));
}
