import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DatabasePool, type DatabaseClient } from '@pickchick/database';
import { catalogHash } from '@pickchick/catalog-admin';
import { digest } from '@pickchick/commerce-core';
import { BackofficeError, parse } from './model.js';

export const FINANCE = Symbol('FINANCE');
const date = z.iso
  .date()
  .refine(
    (v) =>
      v >= '2000-01-01' &&
      v <= '2099-12-31' &&
      Number.isFinite(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
  );
const amount = z.string().regex(/^[1-9][0-9]{0,13}$/);
const text = z.string().trim().min(1).max(200);
const note = z.string().trim().max(1000);
export const centers = {
  restaurant: 'Ресторан',
  workshop: 'Цех',
  office: 'Офис',
  shared: 'Общие',
} as const;
export const groups = {
  revenue: 'Выручка',
  commission: 'Комиссии',
  cogs: 'Себестоимость продаж',
  loss: 'Потери и списания',
  payroll: 'ФОТ и социальные налоги',
  rent: 'Аренда и коммунальные услуги',
  marketing: 'Маркетинг',
  supplies: 'Упаковка и расходные материалы',
  it: 'IT и связь',
  services: 'Услуги ресторану',
  other: 'Прочие операционные расходы',
  nonoperating: 'Прочие расходы периода',
  none: 'Не влияет на прибыль',
} as const;
type Group = keyof typeof groups;
export type Category = {
  id: string;
  name: string;
  direction: 'in' | 'out';
  group: Group;
  cashflow: 'operating' | 'investing' | 'financing';
  recognition: 'optional' | 'required' | 'never';
};
const category = (
  id: string,
  name: string,
  direction: Category['direction'],
  group: Group,
  recognition: Category['recognition'] = 'optional',
  cashflow: Category['cashflow'] = 'operating',
): Category => ({ id, name, direction, group, recognition, cashflow });
// Structure from the supplied workbook; no private actuals, staff or supplier data.
export const categories: Category[] = [
  category('sales', 'Продажи ресторана', 'in', 'revenue'),
  category('yandex', 'Продажи через Яндекс', 'in', 'revenue'),
  category('glovo', 'Продажи через Glovo', 'in', 'revenue'),
  category('oil-sale', 'Продажа отработанного масла', 'in', 'revenue'),
  category('aggregator-fee', 'Комиссии агрегаторов', 'out', 'commission'),
  category('bank-fee', 'Банковские комиссии', 'out', 'commission'),
  category('ingredients', 'Закупка продуктов и ингредиентов', 'out', 'none', 'never'),
  category('cogs', 'Себестоимость проданной продукции', 'out', 'cogs', 'required'),
  category('waste', 'Порча и списания', 'out', 'loss', 'required'),
  category('salary', 'Зарплата', 'out', 'payroll'),
  category('bonus', 'Бонусы и премии', 'out', 'payroll'),
  category('staff-food', 'Питание сотрудников', 'out', 'payroll'),
  category('staff-transport', 'Развозка сотрудников', 'out', 'payroll'),
  category('social-tax', 'Социальные налоги', 'out', 'payroll'),
  category('rent', 'Аренда', 'out', 'rent'),
  category('utilities', 'Коммунальные услуги', 'out', 'rent'),
  category('bloggers', 'Блогеры и контент', 'out', 'marketing'),
  category('ads', 'Таргетированная реклама', 'out', 'marketing'),
  category('barter', 'Бартер по себестоимости', 'out', 'marketing', 'required'),
  category('print', 'Лояльность и печать', 'out', 'marketing'),
  category('packaging', 'Упаковка', 'out', 'supplies'),
  category('cleaning', 'Хозтовары и химия', 'out', 'supplies'),
  category('uniform', 'Форма сотрудников', 'out', 'supplies'),
  category('software', 'Программы и подписки', 'out', 'it'),
  category('internet', 'Интернет и связь', 'out', 'it'),
  category('maintenance', 'Обслуживание и ремонт', 'out', 'services'),
  category('logistics', 'Логистика и доставки', 'out', 'services'),
  category('hr', 'HR и подбор персонала', 'out', 'other'),
  category('development', 'Разработка новых блюд', 'out', 'other'),
  category('office', 'Расходы офиса', 'out', 'other'),
  category('other', 'Прочие расходы', 'out', 'other'),
  category('launch', 'Открытие и мероприятия', 'out', 'nonoperating'),
  category('tax', 'Прочие налоги', 'out', 'nonoperating'),
  category('depreciation', 'Амортизация', 'out', 'nonoperating', 'required'),
  category('equipment', 'Покупка оборудования', 'out', 'none', 'never', 'investing'),
  category('investment', 'Вложения собственника / заём', 'in', 'none', 'never', 'financing'),
  category('repayment', 'Возврат вложений / займа', 'out', 'none', 'never', 'financing'),
  category('advance-in', 'Полученный аванс', 'in', 'none', 'never'),
  category('advance-out', 'Выданный аванс / погашение долга', 'out', 'none', 'never'),
];
export const FinanceEntry = z
  .strictObject({
    id: z.uuid(),
    kind: z.enum(['income', 'expense', 'transfer', 'accrual_income', 'accrual_expense']),
    amount_minor: amount,
    cash_date: date.nullable(),
    recognition_date: date.nullable(),
    account_id: z.uuid().nullable(),
    to_account_id: z.uuid().nullable(),
    category_id: z.string().max(60).nullable(),
    center: z.enum(['restaurant', 'workshop', 'office', 'shared']),
    counterparty: z.string().trim().max(200),
    reference: text,
    note,
  })
  .superRefine((e, ctx) => {
    const reject = () => ctx.addIssue({ code: 'custom', message: 'Invalid accounting effects' });
    const accrual = e.kind.startsWith('accrual');
    if (
      accrual ? e.cash_date !== null || e.account_id !== null || !e.recognition_date : !e.cash_date
    )
      reject();
    if (e.kind === 'transfer') {
      if (
        !e.account_id ||
        !e.to_account_id ||
        e.to_account_id === e.account_id ||
        e.category_id !== null ||
        e.recognition_date !== null
      )
        reject();
    } else {
      const c = categories.find((c) => c.id === e.category_id);
      if (
        e.to_account_id !== null ||
        !c ||
        c.direction !== (e.kind.endsWith('income') ? 'in' : 'out')
      )
        reject();
      if (c?.recognition === 'never' && e.recognition_date) reject();
      if (c?.recognition === 'required' && (!accrual || !e.recognition_date)) reject();
    }
  });
export type Entry = z.infer<typeof FinanceEntry>;
export const FinanceRequest = z.strictObject({
  request_id: z.uuid(),
  reason: z.string().trim().min(3).max(500),
  command: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('entry'), entry: FinanceEntry }),
    z.strictObject({
      type: z.literal('account'),
      id: z.uuid(),
      name: z.string().trim().min(1).max(100),
      kind: z.enum(['cash', 'bank', 'wallet']),
      opening_date: date,
      opening_minor: z.string().regex(/^-?(0|[1-9][0-9]{0,13})$/),
    }),
    z.strictObject({ type: z.literal('void'), id: z.uuid() }),
    z.strictObject({
      type: z.literal('period'),
      month: date.refine((v) => v.endsWith('-01')),
      closed: z.boolean(),
      expected_revision: z.number().int().min(0).max(2147483646),
    }),
  ]),
});
export const FinanceQuery = z
  .strictObject({
    start_date: date,
    end_date: date,
    center: z.enum(['all', 'restaurant', 'workshop', 'office', 'shared']).default('all'),
    page: z.coerce.number().int().min(0).max(100000).default(0),
    category: z.string().max(60).default(''),
    basis: z.enum(['both', 'cash', 'pnl']).default('both'),
    search: z.string().trim().max(80).default(''),
  })
  .refine(
    (q) =>
      q.start_date <= q.end_date &&
      Date.parse(q.end_date) - Date.parse(q.start_date) <= 365 * 86400000,
  );
const fail = (code: ConstructorParameters<typeof BackofficeError>[0]): never => {
  throw new BackofficeError(code);
};
type Actor = { id: string; organization_id: string; role: 'manager' | 'analyst' };

export class Finance {
  constructor(
    private pool: DatabasePool,
    private enabled = false,
  ) {}
  private async scope(
    db: DatabaseClient,
    token: string,
    branch: string,
    write = false,
  ): Promise<Actor> {
    if (!this.enabled) fail('SERVICE_UNAVAILABLE');
    parse(z.uuid(), branch);
    if (!/^[a-f0-9]{64}$/.test(token)) fail('UNAUTHORIZED');
    const actor = (
      await db.query<Actor>(
        `SELECT m.id,m.organization_id,g.role FROM catalog_managers m JOIN catalog_manager_branches s ON s.actor_id=m.id AND s.organization_id=m.organization_id JOIN bo_access_grants g ON g.actor_id=m.id AND g.branch_id=s.branch_id WHERE m.token_hash=$1 AND m.revoked_at IS NULL AND s.branch_id=$2 FOR SHARE OF m,s,g`,
        [catalogHash(token), branch],
      )
    ).rows[0];
    if (!actor || (write && actor.role !== 'manager')) return fail('FORBIDDEN');
    return actor;
  }
  private async unlocked(db: DatabaseClient, branch: string, dates: (string | null)[]) {
    for (const d of new Set(
      dates.filter((v): v is string => !!v).map((v) => v.slice(0, 7) + '-01'),
    )) {
      if (
        (
          await db.query(
            'SELECT 1 FROM bo_finance_periods WHERE branch_id=$1 AND month=$2 AND closed',
            [branch, d],
          )
        ).rows.length
      )
        fail('CONFLICT');
    }
  }
  async command(token: string, branch: string, input: unknown) {
    const r = parse(FinanceRequest, input),
      hash = digest({ branch, request: r });
    return transaction(this.pool, async (db) => {
      const actor = await this.scope(db, token, branch, true);
      // Actor/request and branch locks serialize retries, period closing and posting.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'finance-request:' + actor.id + ':' + r.request_id,
      ]);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'finance-branch:' + branch,
      ]);
      const prior = (
        await db.query(
          'SELECT digest,result FROM bo_finance_commands WHERE actor_id=$1 AND request_id=$2',
          [actor.id, r.request_id],
        )
      ).rows[0];
      if (prior) {
        if (prior.digest !== hash) fail('CONFLICT');
        return prior.result;
      }
      const c = r.command;
      let before: unknown = null,
        result: Record<string, unknown>;
      if (c.type === 'account') {
        await this.unlocked(db, branch, [c.opening_date]);
        if (
          (
            await db.query(
              'SELECT 1 FROM bo_finance_accounts WHERE id=$1 OR (branch_id=$2 AND name=$3)',
              [c.id, branch, c.name],
            )
          ).rows.length
        )
          fail('CONFLICT');
        await db.query(
          'INSERT INTO bo_finance_accounts(id,branch_id,name,kind,opening_date,opening_minor,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [c.id, branch, c.name, c.kind, c.opening_date, c.opening_minor, actor.id],
        );
        result = { id: c.id };
      } else if (c.type === 'entry') {
        const e = c.entry;
        await this.unlocked(db, branch, [e.cash_date, e.recognition_date]);
        if ((await db.query('SELECT 1 FROM bo_finance_entries WHERE id=$1', [e.id])).rows.length)
          fail('CONFLICT');
        for (const id of [e.account_id, e.to_account_id].filter(Boolean)) {
          const account = (
            await db.query(
              'SELECT opening_date::text FROM bo_finance_accounts WHERE branch_id=$1 AND id=$2',
              [branch, id],
            )
          ).rows[0];
          if (!account || !e.cash_date || account.opening_date > e.cash_date)
            fail('INVALID_REQUEST');
        }
        await db.query(
          'INSERT INTO bo_finance_entries(id,branch_id,actor_id,cash_date,recognition_date,payload) VALUES($1,$2,$3,$4,$5,$6)',
          [e.id, branch, actor.id, e.cash_date, e.recognition_date, JSON.stringify(e)],
        );
        result = { id: e.id };
      } else if (c.type === 'void') {
        const entry = (
          await db.query('SELECT payload FROM bo_finance_entries WHERE branch_id=$1 AND id=$2', [
            branch,
            c.id,
          ])
        ).rows[0];
        if (!entry) fail('NOT_FOUND');
        const e = parse(FinanceEntry, entry!.payload);
        await this.unlocked(db, branch, [e.cash_date, e.recognition_date]);
        if (
          (await db.query('SELECT 1 FROM bo_finance_voids WHERE entry_id=$1', [c.id])).rows.length
        )
          fail('CONFLICT');
        await db.query(
          'INSERT INTO bo_finance_voids(entry_id,branch_id,actor_id,reason) VALUES($1,$2,$3,$4)',
          [c.id, branch, actor.id, r.reason],
        );
        before = e;
        result = { id: c.id, voided: true };
      } else {
        const current = (
          await db.query(
            'SELECT closed,revision FROM bo_finance_periods WHERE branch_id=$1 AND month=$2',
            [branch, c.month],
          )
        ).rows[0];
        if ((current?.revision ?? 0) !== c.expected_revision) fail('CONFLICT');
        before = current ?? null;
        await db.query(
          'INSERT INTO bo_finance_periods(branch_id,month,closed,revision) VALUES($1,$2,$3,1) ON CONFLICT(branch_id,month) DO UPDATE SET closed=excluded.closed,revision=bo_finance_periods.revision+1',
          [branch, c.month, c.closed],
        );
        result = { month: c.month, closed: c.closed, revision: c.expected_revision + 1 };
      }
      await db.query(
        'INSERT INTO bo_audit(id,branch_id,organization_id,actor_id,request_id,action,entity_id,reason,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          randomUUID(),
          branch,
          actor.organization_id,
          actor.id,
          r.request_id,
          'finance.' + c.type,
          result.id ?? null,
          r.reason,
          JSON.stringify(before),
          JSON.stringify(c),
        ],
      );
      await db.query(
        'INSERT INTO bo_finance_commands(actor_id,request_id,branch_id,digest,result) VALUES($1,$2,$3,$4,$5)',
        [actor.id, r.request_id, branch, hash, JSON.stringify(result)],
      );
      return result;
    });
  }
  async read(token: string, branch: string, input: unknown) {
    const q = parse(FinanceQuery, input);
    return transaction(this.pool, async (db) => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const actor = await this.scope(db, token, branch);
      const active = `FROM bo_finance_entries e WHERE e.branch_id=$1 AND NOT EXISTS(SELECT 1 FROM bo_finance_voids v WHERE v.entry_id=e.id)`;
      const rows = async (sql: string, args: unknown[]) => (await db.query(sql, args)).rows;
      const accounts = await rows(
        `SELECT a.id,a.name,a.kind,a.opening_date::text,a.opening_minor::text FROM bo_finance_accounts a WHERE a.branch_id=$1 ORDER BY a.created_at,a.id`,
        [branch],
      );
      const effects = await rows(
        `WITH effects AS (
    SELECT (payload->>'account_id')::uuid account_id,cash_date,
     (payload->>'amount_minor')::numeric * CASE WHEN payload->>'kind'='income' THEN 1 ELSE -1 END delta ${active} AND cash_date<=$3::date
    UNION ALL SELECT (payload->>'to_account_id')::uuid,cash_date,(payload->>'amount_minor')::numeric ${active} AND payload->>'kind'='transfer' AND cash_date<=$3::date)
    SELECT account_id,coalesce(sum(delta) FILTER(WHERE cash_date<$2::date),0)::text before_minor,
     coalesce(sum(delta) FILTER(WHERE cash_date>=$2::date AND delta>0),0)::text in_minor,
     coalesce(sum(-delta) FILTER(WHERE cash_date>=$2::date AND delta<0),0)::text out_minor FROM effects GROUP BY account_id`,
        [branch, q.start_date, q.end_date],
      );
      const balances = accounts.map((a) => {
        const e = effects.find((e) => e.account_id === a.id);
        const opening =
          BigInt(a.opening_date <= q.start_date ? a.opening_minor : '0') +
          BigInt(e?.before_minor ?? '0');
        const introduced =
          a.opening_date > q.start_date && a.opening_date <= q.end_date
            ? BigInt(a.opening_minor)
            : 0n;
        return {
          ...a,
          before_minor: String(opening),
          introduced_minor: String(introduced),
          in_minor: e?.in_minor ?? '0',
          out_minor: e?.out_minor ?? '0',
          after_minor: String(
            opening + introduced + BigInt(e?.in_minor ?? '0') - BigInt(e?.out_minor ?? '0'),
          ),
        };
      });
      const summaries = await rows(
        `SELECT payload->>'category_id' category_id,payload->>'center' center,
    coalesce(sum((payload->>'amount_minor')::numeric) FILTER(WHERE cash_date BETWEEN $2::date AND $3::date),0)::text cash_minor,
    coalesce(sum((payload->>'amount_minor')::numeric) FILTER(WHERE recognition_date BETWEEN $2::date AND $3::date),0)::text pnl_minor,
    count(*)::int entries ${active} AND payload->>'kind'<>'transfer' AND ($4='all' OR payload->>'center'=$4)
    AND (cash_date BETWEEN $2::date AND $3::date OR recognition_date BETWEEN $2::date AND $3::date)
    GROUP BY payload->>'category_id',payload->>'center'`,
        [branch, q.start_date, q.end_date, q.center],
      );
      // Aggregate the complete period, independently of journal pagination/search.
      // Cash and recognition dates belong to separate series; transfers affect neither.
      const timeline = await rows(
        `WITH dated AS (
          SELECT cash_date date,'cash' basis,payload ${active}
          AND cash_date BETWEEN $2::date AND $3::date
          UNION ALL
          SELECT recognition_date,'pnl',payload ${active}
          AND recognition_date BETWEEN $2::date AND $3::date)
        SELECT date::text,basis,
          coalesce(sum((payload->>'amount_minor')::numeric) FILTER(WHERE payload->>'kind' IN ('income','accrual_income')),0)::text in_minor,
          coalesce(sum((payload->>'amount_minor')::numeric) FILTER(WHERE payload->>'kind' IN ('expense','accrual_expense')),0)::text out_minor
        FROM dated WHERE payload->>'kind'<>'transfer' AND ($4='all' OR payload->>'center'=$4)
        GROUP BY date,basis ORDER BY date,basis`,
        [branch, q.start_date, q.end_date, q.center],
      );
      const unassigned = (
        await rows(
          `SELECT count(*)::int entries,
          coalesce(sum((payload->>'amount_minor')::numeric) FILTER(WHERE payload->>'kind'='income'),0)::text in_minor,
          coalesce(sum((payload->>'amount_minor')::numeric) FILTER(WHERE payload->>'kind'='expense'),0)::text out_minor
        ${active} AND cash_date BETWEEN $2::date AND $3::date AND payload->>'account_id' IS NULL`,
          [branch, q.start_date, q.end_date],
        )
      )[0];
      const where = `e.branch_id=$1 AND (($6<>'pnl' AND e.cash_date BETWEEN $2::date AND $3::date) OR ($6<>'cash' AND e.recognition_date BETWEEN $2::date AND $3::date)) AND ($4='all' OR e.payload->>'center'=$4) AND ($5='' OR e.payload->>'category_id'=$5) AND ($7='' OR strpos(lower(concat_ws(' ',e.payload->>'reference',e.payload->>'counterparty',e.payload->>'note')),lower($7))>0)`;
      const args = [branch, q.start_date, q.end_date, q.center, q.category, q.basis, q.search];
      const journal = await rows(
        `SELECT e.id,e.payload,e.created_at,m.name author,v.reason void_reason,vm.name void_author,v.created_at voided_at FROM bo_finance_entries e JOIN catalog_managers m ON m.id=e.actor_id LEFT JOIN bo_finance_voids v ON v.entry_id=e.id LEFT JOIN catalog_managers vm ON vm.id=v.actor_id WHERE ${where} ORDER BY coalesce(e.cash_date,e.recognition_date) DESC,e.created_at DESC,e.id DESC LIMIT 100 OFFSET $8`,
        [...args, q.page * 100],
      );
      const count = (
        await rows(`SELECT count(*)::int total FROM bo_finance_entries e WHERE ${where}`, args)
      )[0]!.total;
      const periods = await rows(
        'SELECT month::text,closed,revision FROM bo_finance_periods WHERE branch_id=$1 ORDER BY month DESC',
        [branch],
      );
      return {
        schema_version: 1,
        branch_id: branch,
        role: actor.role,
        as_of: new Date().toISOString(),
        query: q,
        categories,
        centers,
        groups,
        accounts: balances,
        summaries,
        timeline,
        unassigned,
        journal,
        total: count,
        periods,
      };
    });
  }
}
