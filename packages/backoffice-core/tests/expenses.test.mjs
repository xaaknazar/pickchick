import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import { grantBackoffice } from '../dist/index.js';
import { Expenses } from '../dist/expenses.js';
import { backofficeGrants } from '../../../infra/staging/backoffice-grants.mjs';
import {
  BACKOFFICE_EXPENSES_RELATIONS,
  backofficeExpensesGrants,
} from '../../../infra/staging/backoffice-expenses-grants.mjs';
import { posSale, at } from './sales-report-fixture.mjs';

// «Расходы» (cloud077, owner request 11.11.2026). The clock is fixed at 20.11.2026 12:00 Almaty.
const NOW = () => new Date('2026-11-20T07:00:00Z');
const code = (name) => (e) => e?.code === name;

async function setup(c) {
  const second = randomUUID();
  const legal = (
    await c.cloud.pool.query('SELECT legal_entity_id FROM branches WHERE id=$1', [c.branch])
  ).rows[0].legal_entity_id;
  await c.cloud.pool.query(
    "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,'SYNC2','Synthetic second')",
    [second, c.org, legal],
  );
  const person = async (name, branches) =>
    provisionCatalogManager(c.cloud.pool, { organization_id: c.org, name, branch_ids: branches });
  const owner = await person('Synthetic owner', [c.branch, second]);
  for (const b of [c.branch, second])
    await grantBackoffice(c.cloud.pool, owner.actor_id, b, 'manager');
  const finance = await person('Synthetic finance', [c.branch]);
  const branchManager = await person('Synthetic branch manager', [c.branch]);
  await grantBackoffice(c.cloud.pool, branchManager.actor_id, c.branch, 'manager');
  return { second, owner, finance, branchManager };
}
/** A NOLOGIN role like the API role, with backofficeGrants and the 077 grants. */
async function withRole(c, input, run) {
  const role = 'bo_exp_' + randomUUID().replaceAll('-', '');
  let pool;
  await c.cloud.admin.query(
    `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  try {
    await c.cloud.pool.query(`GRANT USAGE ON SCHEMA ${c.cloud.schema} TO ${role}`);
    await c.cloud.pool.query(backofficeGrants(role, true));
    await c.cloud.pool.query(backofficeExpensesGrants(role, input, c.cloud.schema));
    const url = new URL(c.cloud.config.databaseUrl);
    url.searchParams.set('options', `-c search_path=${c.cloud.schema} -c role=${role}`);
    pool = createPool(url.toString());
    await run(pool, role);
  } finally {
    await pool?.end();
    await c.cloud.admin.query(`DROP OWNED BY ${role}`);
    await c.cloud.admin.query(`DROP ROLE ${role}`);
  }
}

test('access is checked on the server: director by the manager grant of every branch, granted roles, flag off', () =>
  withSyncDatabases(async (c) => {
    const p = await setup(c);
    await assert.rejects(
      new Expenses(c.cloud.pool, false, NOW).meta(p.owner.token),
      code('SERVICE_UNAVAILABLE'),
    );
    const x = new Expenses(c.cloud.pool, true, NOW);
    await assert.rejects(x.meta('0'.repeat(64)), code('UNAUTHORIZED'));
    const meta = await x.meta(p.owner.token);
    assert.equal(meta.role, 'director');
    assert.equal(meta.locations.length, 2);
    assert.ok(meta.categories.some((v) => v.code === 'rent'));
    // A manager of one branch only and a login without a grant have no access.
    await assert.rejects(x.meta(p.branchManager.token), code('FORBIDDEN'));
    await assert.rejects(x.meta(p.finance.token), code('FORBIDDEN'));
    await assert.rejects(
      x.setAccess(p.branchManager.token, { actor_id: p.finance.actor_id, role: 'finance' }),
      code('FORBIDDEN'),
    );
    await x.setAccess(p.owner.token, { actor_id: p.finance.actor_id, role: 'viewer' });
    assert.equal((await x.meta(p.finance.token)).role, 'viewer');
    const cell = {
      period: 'day',
      date: '2026-11-19',
      location_id: c.branch,
      category: 'rent',
      source: 'bank',
      amount_minor: '100',
    };
    await assert.rejects(x.cell(p.finance.token, cell), code('FORBIDDEN'));
    await x.setAccess(p.owner.token, { actor_id: p.finance.actor_id, role: 'finance' });
    await x.cell(p.finance.token, cell);
    await assert.rejects(x.month(p.finance.token, '2026-11', true), code('FORBIDDEN'));
    await assert.rejects(x.access(p.finance.token), code('FORBIDDEN'));
    await assert.rejects(
      x.setAccess(p.owner.token, { actor_id: p.owner.actor_id, role: null }),
      code('CONFLICT'),
    );
    await x.setAccess(p.owner.token, { actor_id: p.finance.actor_id, role: null });
    await assert.rejects(x.meta(p.finance.token), code('FORBIDDEN'));
    const people = (await x.access(p.owner.token)).people;
    assert.equal(people.find((v) => v.actor_id === p.owner.actor_id).role, 'director');
    assert.equal(people.find((v) => v.actor_id === p.finance.actor_id).role, null);
  }));

test('cells, rows, records with a counterparty, validation, journal and the action log', () =>
  withSyncDatabases(async (c) => {
    const p = await setup(c);
    const x = new Expenses(c.cloud.pool, true, NOW);
    const t = p.owner.token;
    const cell = (patch) =>
      x.cell(t, {
        period: 'day',
        date: '2026-11-19',
        location_id: c.branch,
        category: 'rent',
        source: 'bank',
        amount_minor: '100000',
        ...patch,
      });
    const first = await cell({});
    assert.equal(first.revision, 1);
    assert.equal((await cell({ amount_minor: '150000' })).revision, 2);
    await cell({ source: 'cash', category: 'taxi', amount_minor: '2000' });
    await cell({ location_id: null, category: 'pay_office', amount_minor: '500000' });
    // Validation: unknown article or source, automatic revenue, a future day, a foreign branch,
    // manual revenue of the company, not a number.
    for (const bad of [
      { category: 'nope' },
      { source: 'visa' },
      { category: 'rev_cash' },
      { date: '2026-11-21' },
      { location_id: randomUUID() },
      { location_id: null, category: 'rev_manual' },
      { amount_minor: '12,5' },
      { date: '2026-02-30' },
    ])
      await assert.rejects(cell(bad), code('INVALID_REQUEST'), JSON.stringify(bad));
    // A row moves its cells to another P&L month and gives its comment to new cells.
    const row = await x.row(t, {
      period: 'day',
      date: '2026-11-19',
      location_id: c.branch,
      category: 'rent',
      pl_month: '2026-10',
      comment: 'Аренда за октябрь',
    });
    assert.equal(row.cells, 1);
    await cell({ source: 'kaspi', amount_minor: '1000' });
    const screen = await x.entryScreen(t, { period: 'day', date: '2026-11-19' });
    const place = screen.locations.find((l) => l.id === c.branch);
    const rent = place.entries.filter((e) => e.category === 'rent');
    assert.deepEqual(rent.map((e) => [e.source, e.amount_minor, e.pl_month, e.comment]).sort(), [
      ['bank', '150000', '2026-10', 'Аренда за октябрь'],
      ['kaspi', '1000', '2026-10', 'Аренда за октябрь'],
    ]);
    assert.equal(place.expenses_minor, '153000');
    assert.equal(place.status, 'filled');
    assert.equal(screen.filled, 1);
    assert.equal(screen.total, 2);
    assert.equal(screen.locations.find((l) => l.id === null).expenses_minor, '500000');
    // Empty removes the cell.
    assert.deepEqual(await cell({ source: 'kaspi', amount_minor: null }), {
      id: rent.find((e) => e.source === 'kaspi').id,
      deleted: true,
    });
    // Two payments of one article: records with a counterparty, plus a monthly record.
    const supplier = await x.createEntry(t, {
      location_id: c.branch,
      date: '2026-11-18',
      category: 'suppliers',
      source: 'halyk',
      amount_minor: '30000',
      pl_month: '2026-11',
      monthly: false,
      counterparty: 'ТОО Синтетика',
      comment: '',
    });
    await x.createEntry(t, {
      location_id: c.branch,
      date: '2026-11-18',
      category: 'suppliers',
      source: 'halyk',
      amount_minor: '-5000',
      pl_month: '2026-11',
      monthly: false,
      counterparty: 'ТОО Синтетика',
      comment: 'Возврат',
    });
    const monthly = await x.createEntry(t, {
      location_id: c.branch,
      date: '2026-11-03',
      category: 'utilities',
      source: 'bank',
      amount_minor: '70000',
      pl_month: '2026-09',
      monthly: true,
      counterparty: '',
      comment: '',
    });
    assert.equal(monthly.date, '2026-11-30');
    assert.equal(monthly.pl_month, '2026-11');
    await assert.rejects(
      x.createEntry(t, {
        location_id: c.branch,
        date: '2026-12-01',
        category: 'utilities',
        source: 'bank',
        amount_minor: '1',
        pl_month: '2026-12',
        monthly: true,
        counterparty: '',
        comment: '',
      }),
      code('INVALID_REQUEST'),
    );
    const changed = await x.updateEntry(t, supplier.id, {
      location_id: c.branch,
      date: '2026-11-17',
      category: 'workshop',
      source: 'cash',
      amount_minor: '31000',
      pl_month: '2026-11',
      monthly: false,
      counterparty: 'Цех',
      comment: 'Мясо',
    });
    assert.equal(changed.revision, 2);
    assert.equal(changed.category, 'workshop');
    const journal = await x.journal(t, {
      start_date: '2026-11-01',
      end_date: '2026-11-30',
      search: 'синтетика',
    });
    assert.equal(journal.entries.length, 1);
    assert.equal(journal.entries[0].amount_minor, '-5000');
    const company = await x.journal(t, {
      start_date: '2026-11-01',
      end_date: '2026-11-30',
      location: 'company',
    });
    assert.deepEqual(
      company.entries.map((e) => e.category),
      ['pay_office'],
    );
    const byPl = await x.journal(t, {
      start_date: '2026-10-01',
      end_date: '2026-10-31',
      basis: 'pl_month',
    });
    assert.deepEqual(
      byPl.entries.map((e) => e.category),
      ['rent'],
    );
    await x.deleteEntry(t, supplier.id);
    await assert.rejects(x.deleteEntry(t, supplier.id), code('NOT_FOUND'));
    const log = (await x.actions(t, {})).actions.map((a) => a.action);
    for (const a of ['entry.create', 'entry.update', 'entry.delete', 'row'])
      assert.ok(log.includes(a), a);
  }));

test('revenue by payment type, the cash reconciliation and the «!» status', () =>
  withSyncDatabases(async (c) => {
    const p = await setup(c);
    const x = new Expenses(c.cloud.pool, true, NOW);
    const t = p.owner.token;
    const db = c.cloud.pool;
    const shift = randomUUID();
    await posSale(db, c, {
      number: 1,
      shift,
      at: at('2026-11-19', '12:00:00'),
      tenders: [['cash', '50000']],
    });
    await posSale(db, c, {
      number: 2,
      shift,
      at: at('2026-11-19', '13:00:00'),
      tenders: [
        ['kaspi_terminal', '30000'],
        ['cash', '1000'],
      ],
    });
    await posSale(db, c, {
      number: 3,
      shift,
      at: at('2026-11-19', '14:00:00'),
      channel: 'glovo',
      ref: 'GLV-0001',
      tenders: [['aggregator_glovo', '20000']],
    });
    await posSale(db, c, {
      number: 4,
      shift,
      at: at('2026-11-19', '15:00:00'),
      kind: 'staff_meal',
      beneficiary: 'Сотрудник',
      reason: 'Обед',
      tenders: [['staff_meal', '9000']],
    });
    const day = { period: 'day', date: '2026-11-19' };
    let place = (await x.entryScreen(t, day)).locations.find((l) => l.id === c.branch);
    assert.deepEqual(place.revenue.by_type, { cash: '51000', card: '30000', glovo: '20000' });
    assert.equal(place.revenue.total_minor, '101000');
    // Yesterday's count 10 000; today: cash revenue 51 000, other income 2 000, withdrawal 5 000,
    // cash expenses 3 000 (an expense paid by card does not count), collection 40 000.
    await x.cash(t, {
      location_id: c.branch,
      date: '2026-11-18',
      opening_minor: null,
      counted_minor: '10000',
      comment: '',
    });
    const put = (category, source, amount) =>
      x.cell(t, { ...day, location_id: c.branch, category, source, amount_minor: amount });
    await put('other_income', 'cash', '2000');
    await put('cash_withdrawal', 'bank', '5000');
    await put('taxi', 'cash', '3000');
    await put('taxi', 'kaspi', '7000');
    await put('cash_collection', 'cash', '40000');
    const cash = await x.cash(t, {
      location_id: c.branch,
      date: '2026-11-19',
      opening_minor: null,
      counted_minor: '24000',
      comment: '',
    });
    assert.equal(cash.opening_source, 'previous');
    assert.equal(cash.expected_minor, '25000');
    assert.equal(cash.difference_minor, '-1000');
    place = (await x.entryScreen(t, day)).locations.find((l) => l.id === c.branch);
    assert.equal(place.status, 'mismatch');
    // The shortage booked as an expense paid in cash closes the difference.
    await put('cash_shortage', 'cash', '1000');
    place = (await x.entryScreen(t, day)).locations.find((l) => l.id === c.branch);
    assert.equal(place.cash.difference_minor, '0');
    assert.equal(place.status, 'filled');
    // A manual opening wins over yesterday's count.
    const manual = await x.cash(t, {
      location_id: c.branch,
      date: '2026-11-19',
      opening_minor: '11000',
      counted_minor: '24000',
      comment: 'Пересчёт',
    });
    assert.equal(manual.opening_source, 'manual');
    assert.equal(manual.difference_minor, '-1000');
  }));

test('P&L by the P&L month with company expenses shared by revenue, and analytics', () =>
  withSyncDatabases(async (c) => {
    const p = await setup(c);
    const x = new Expenses(c.cloud.pool, true, NOW);
    const t = p.owner.token;
    await posSale(c.cloud.pool, c, {
      number: 1,
      shift: randomUUID(),
      at: at('2026-11-10', '12:00:00'),
      tenders: [['cash', '300000']],
    });
    const put = (location_id, date, category, amount, source = 'bank') =>
      x.cell(t, { period: 'day', date, location_id, category, source, amount_minor: amount });
    await put(p.second, '2026-11-10', 'rev_manual', '100000', 'cash');
    await put(c.branch, '2026-11-10', 'suppliers', '90000');
    await put(c.branch, '2026-11-10', 'pay_site', '60000');
    await put(null, '2026-11-10', 'pay_office', '40000');
    // Paid in November for October: in the October P&L.
    await put(c.branch, '2026-11-03', 'rent', '50000');
    await x.row(t, {
      period: 'day',
      date: '2026-11-03',
      location_id: c.branch,
      category: 'rent',
      pl_month: '2026-10',
      comment: '',
    });
    const nov = await x.pnl(t, { from: '2026-11', to: '2026-11' });
    const v = (r, key) => r.lines.find((l) => l.key === key).values;
    assert.equal(v(nov, 'revenue')[c.branch], '300000');
    assert.equal(v(nov, 'revenue')[p.second], '100000');
    assert.equal(v(nov, 'cat:rent')[c.branch], '0');
    assert.equal(v(nov, 'cat:pay_office').company, '40000');
    assert.equal(v(nov, 'ebitda').total, String(400000 - 90000 - 60000 - 40000));
    const shared = await x.pnl(t, { from: '2026-11', to: '2026-11', allocate: 'true' });
    assert.equal(v(shared, 'cat:pay_office')[c.branch], '30000');
    assert.equal(v(shared, 'cat:pay_office')[p.second], '10000');
    assert.ok(!shared.columns.includes('company'));
    const both = await x.pnl(t, { from: '2026-10', to: '2026-11', columns: 'months' });
    assert.equal(v(both, 'cat:rent')['2026-10'], '50000');
    assert.equal(both.tiles.rent_percent, '12.5');
    assert.equal(
      (await x.pnl(t, { from: '2026-11', to: '2026-11', cogs: 'ttk' })).cogs_available,
      false,
    );
    const a = await x.analytics(t, { from: '2026-10', to: '2026-11' });
    assert.deepEqual(
      a.series.map((s) => [s.month, s.cogs, s.payroll, s.location]),
      [
        ['2026-10', '0', '0', '50000'],
        ['2026-11', '90000', '100000', '0'],
      ],
    );
    assert.equal(a.structure[0].category, 'suppliers');
    assert.equal(a.sources.find((s) => s.source === 'bank').expenses_minor, '240000');
  }));

test('a closed month refuses every change, on the server and in the database; the director reopens it', () =>
  withSyncDatabases(async (c) => {
    const p = await setup(c);
    const x = new Expenses(c.cloud.pool, true, NOW);
    const t = p.owner.token;
    const cell = (patch = {}) =>
      x.cell(t, {
        period: 'day',
        date: '2026-10-15',
        location_id: c.branch,
        category: 'rent',
        source: 'bank',
        amount_minor: '100',
        ...patch,
      });
    const created = await cell();
    await x.month(t, '2026-10', true);
    await assert.rejects(x.month(t, '2026-10', true), code('CONFLICT'));
    assert.equal((await x.entryScreen(t, { period: 'day', date: '2026-10-15' })).closed, true);
    await assert.rejects(cell({ amount_minor: '200' }), code('MONTH_CLOSED'));
    await assert.rejects(cell({ amount_minor: null }), code('MONTH_CLOSED'));
    await assert.rejects(x.deleteEntry(t, created.id), code('MONTH_CLOSED'));
    await assert.rejects(
      x.cash(t, {
        location_id: c.branch,
        date: '2026-10-15',
        opening_minor: null,
        counted_minor: '1',
        comment: '',
      }),
      code('MONTH_CLOSED'),
    );
    // November paid, October P&L: refused too.
    await assert.rejects(
      x.createEntry(t, {
        location_id: c.branch,
        date: '2026-11-03',
        category: 'rent',
        source: 'bank',
        amount_minor: '1',
        pl_month: '2026-10',
        monthly: false,
        counterparty: '',
        comment: '',
      }),
      code('MONTH_CLOSED'),
    );
    // The database refuses it too, whoever writes.
    await assert.rejects(
      c.cloud.pool.query('DELETE FROM bo_expense_entries WHERE id=$1', [created.id]),
      /The month is closed/,
    );
    await x.month(t, '2026-10', false);
    await cell({ amount_minor: '200' });
    const log = (await x.actions(t, {})).actions.map((a) => a.action);
    assert.ok(log.includes('month.close') && log.includes('month.open'));
  }));

test('least privilege: the API role works with the 077 grants and has nothing without the flag', () =>
  withSyncDatabases(async (c) => {
    const p = await setup(c);
    await withRole(c, { backoffice: true, expenses: true }, async (pool) => {
      const x = new Expenses(pool, true, NOW);
      await x.cell(p.owner.token, {
        period: 'day',
        date: '2026-11-19',
        location_id: c.branch,
        category: 'rent',
        source: 'bank',
        amount_minor: '1',
      });
      await x.cell(p.owner.token, {
        period: 'day',
        date: '2026-11-19',
        location_id: c.branch,
        category: 'rent',
        source: 'bank',
        amount_minor: null,
      });
      await x.month(p.owner.token, '2026-09', true);
      await x.month(p.owner.token, '2026-09', false);
      await x.pnl(p.owner.token, { from: '2026-11', to: '2026-11' });
      await assert.rejects(pool.query('DELETE FROM bo_expense_log'), (e) => e.code === '42501');
      await assert.rejects(pool.query('TRUNCATE bo_expense_entries'), (e) => e.code === '42501');
    });
    await withRole(c, { backoffice: true, expenses: false }, async (pool, role) => {
      for (const name of BACKOFFICE_EXPENSES_RELATIONS)
        assert.equal(
          (await c.cloud.pool.query(`SELECT has_table_privilege($1,$2,'SELECT') ok`, [role, name]))
            .rows[0].ok,
          false,
          name,
        );
      await assert.rejects(
        new Expenses(pool, true, NOW).meta(p.owner.token),
        (e) => e.code === '42501',
      );
    });
  }));
