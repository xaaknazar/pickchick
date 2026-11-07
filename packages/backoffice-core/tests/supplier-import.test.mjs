import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { backofficeGrants } from '../../../infra/staging/backoffice-grants.mjs';
import { backofficeSupplyGrants } from '../../../infra/staging/backoffice-supply-grants.mjs';
import {
  Backoffice,
  BackofficeError,
  IMPORT_COUNT_KEYS,
  IMPORT_REPORT_SCHEMA,
  IMPORT_SUMMARY_BYTES,
} from '../dist/index.js';
import { people } from './consumption-fixture.mjs';

/**
 * The price import command and view of lane bo-ui2 step 3 (supplier-import.ts; design-bo-ui.md
 * §9.4) on PostgreSQL: flag off = no view and no command; a plan in two parts makes one batch
 * with its report, new suppliers and import prices; repeats, parts out of order, stale plans and
 * bad bodies; nothing is ever deleted or overwritten; the view of the batches with their parts,
 * totals and later corrections; the role matrix; the API role with exactly the 076 helper rights.
 * Synthetic names and amounts only.
 */
const ON = Object.freeze({ rolesEnabled: true, stockV2Enabled: true, supplyEnabled: true });
const DAY = '2026-11-01';
const is = (code, reason) => (error) =>
  error instanceof BackofficeError && error.code === code && error.reason === reason;
const request = (command, reason = 'Синтетический импорт цен') => ({
  request_id: randomUUID(),
  reason,
  command,
});
const count = async (c, table) =>
  (await c.cloud.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
const rows = async (c, sql, args = [c.branch]) => (await c.cloud.pool.query(sql, args)).rows;
const hex = (ch) => ch.repeat(64);
const counts = (extra = {}) => ({
  ...Object.fromEntries(IMPORT_COUNT_KEYS.map((k) => [k, 0])),
  rows: 4,
  ...extra,
});
/** The report part 1 carries (what the script stores). */
const summary = (parts, extra = {}) => ({
  schema: IMPORT_REPORT_SCHEMA,
  file_name: 'prices.csv',
  profile: 'iiko',
  parts,
  counts: counts({ matched: 3, new_prices: 3, new_suppliers: 1, not_found: 1 }),
  issues: [
    {
      line: 5,
      code: 'NOT_FOUND',
      supplier: 'Поставщик 2',
      name: 'Синтетическая соль',
      text: 'нет позиции с таким названием',
    },
  ],
  issues_total: 1,
  ...extra,
});
/** One part of a plan. */
const part = (plan, n, parts, { suppliers = [], prices, summary: report } = {}) => ({
  type: 'supplier_prices_import',
  batch_id: plan.batch,
  source: 'iiko_export',
  file_sha256: plan.file,
  plan_sha256: plan.plan,
  row_count: 4,
  part: n,
  parts,
  ...(n === 1 ? { summary: report ?? summary(parts) } : {}),
  suppliers,
  prices,
});
const price = (supplier, ingredient, unit, value, day = DAY) => ({
  supplier_id: supplier,
  ingredient_id: ingredient,
  unit,
  price_minor: value,
  valid_from: day,
});
const newPlan = (file = hex('a'), plan = hex('b')) => ({ batch: randomUUID(), file, plan });
/** The ingredients of the tests and one existing supplier with one manual price. */
async function seed(bo, token, c) {
  const run = (command, reason) => bo.command(token, c.branch, request(command, reason));
  const save = async (name, unit, active = true) => {
    const id = randomUUID();
    await run(
      {
        type: 'save',
        kind: 'ingredient',
        id,
        expected_revision: 0,
        payload: { name, unit, minimum: '0', active },
      },
      'Синтетическая позиция',
    );
    return id;
  };
  const s = {
    fillet: await save('Синтетическое филе', 'g'),
    bun: await save('Синтетическая булка', 'pcs'),
    oil: await save('Синтетическое масло', 'ml'),
    old: await save('Синтетическая старая позиция', 'pcs', false),
    supplier: randomUUID(),
  };
  await run({
    type: 'supplier_save',
    id: s.supplier,
    expected_revision: 0,
    payload: { name: 'Поставщик 1', kind: 'supplier', active: true },
  });
  await run({
    type: 'supplier_price_save',
    supplier_id: s.supplier,
    ingredient_id: s.fillet,
    unit: 'kg',
    valid_from: DAY,
    price_minor: '250000',
    expected_revision: 0,
  });
  return s;
}

test('flag off: no import view, no import command, nothing written', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const s = await seed(new Backoffice(c.cloud.pool, true, ON), manager.token, c);
    const plan = newPlan();
    const body = part(plan, 1, 1, { prices: [price(s.supplier, s.bun, 'pcs', '12000')] });
    const audit = await count(c, 'bo_audit');
    for (const options of [
      {},
      { rolesEnabled: true, stockV2Enabled: true },
      { rolesEnabled: true, stockV2Enabled: true, stockReportsEnabled: true },
    ]) {
      const off = new Backoffice(c.cloud.pool, true, options);
      for (const input of [{}, { id: plan.batch }])
        await assert.rejects(
          off.ops(manager.token, c.branch, 'supplier-imports', input),
          is('NOT_FOUND'),
        );
      await assert.rejects(
        off.command(manager.token, c.branch, request(body)),
        is('INVALID_REQUEST'),
      );
    }
    // The flag without stock v2 (loadConfig refuses it): NOT_READY view, unknown command.
    const alone = new Backoffice(c.cloud.pool, true, { rolesEnabled: true, supplyEnabled: true });
    await assert.rejects(
      alone.ops(manager.token, c.branch, 'supplier-imports', {}),
      is('NOT_READY'),
    );
    await assert.rejects(
      alone.command(manager.token, c.branch, request(body)),
      is('INVALID_REQUEST'),
    );
    assert.equal(await count(c, 'bo_supplier_price_imports'), 0);
    assert.equal(await count(c, 'bo_audit'), audit);
  }));

test('a plan in two parts: one batch with its report, new suppliers, import prices, repeats', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const s = await seed(bo, manager.token, c);
    const run = (body) => bo.command(manager.token, c.branch, body);
    const plan = newPlan();
    const fresh = randomUUID();
    // The same price as the manual one is unchanged; the others are new.
    const one = request(
      part(plan, 1, 2, {
        suppliers: [{ id: fresh, name: 'Поставщик 2', kind: 'bakery' }],
        prices: [price(s.supplier, s.fillet, 'kg', '250000'), price(fresh, s.bun, 'pcs', '12000')],
      }),
    );
    const two = request(part(plan, 2, 2, { prices: [price(s.supplier, s.oil, 'l', '180050')] }));
    // Part 2 before part 1: the batch is not there yet.
    await assert.rejects(run(two), is('CONFLICT', 'IMPORT_STALE'));
    const first = await run(one);
    assert.deepEqual(first, {
      batch_id: plan.batch,
      part: 1,
      parts: 2,
      supplier_ids: [fresh],
      suppliers_created: 1,
      prices_created: 1,
      unchanged: 1,
    });
    // The view of an unfinished import says so.
    let view = await bo.ops(manager.token, c.branch, 'supplier-imports', {});
    assert.equal(view.view, 'supplier-imports');
    assert.deepEqual(
      [view.imports.length, view.imports[0].parts_applied, view.imports[0].complete],
      [1, [1], false],
    );
    const second = await run(two);
    assert.deepEqual([second.part, second.prices_created, second.unchanged], [2, 1, 0]);
    // The same requests again: the same answers, nothing new.
    assert.deepEqual(await run(one), first);
    assert.deepEqual(await run(two), second);
    // The same parts under other request ids: already applied, nothing written.
    for (const [n, body] of [
      [1, one.command],
      [2, two.command],
    ])
      await assert.rejects(run(request(body)), is('CONFLICT', 'IMPORT_ALREADY_APPLIED'), n);
    // Another body under a used request id: CONFLICT without a reason (the envelope).
    await assert.rejects(
      run({ ...two, command: { ...two.command, prices: [price(s.supplier, s.bun, 'pcs', '1')] } }),
      is('CONFLICT', undefined),
    );
    // What is in the database.
    const batch = (await rows(c, 'SELECT * FROM bo_supplier_price_imports WHERE branch_id=$1'))[0];
    assert.deepEqual(
      [batch.id, batch.source, batch.file_sha256, batch.plan_sha256, batch.row_count],
      [plan.batch, 'iiko_export', plan.file, plan.plan, 4],
    );
    assert.deepEqual(batch.summary, summary(2));
    assert.equal(batch.actor_id, manager.actor_id);
    const supplier = (await rows(c, 'SELECT * FROM bo_suppliers WHERE id=$1', [fresh]))[0];
    assert.deepEqual(
      [supplier.name, supplier.kind, supplier.active, supplier.revision, supplier.created_by],
      ['Поставщик 2', 'bakery', true, 1, manager.actor_id],
    );
    assert.deepEqual(
      await rows(
        c,
        `SELECT s.name,p.unit,p.price_minor::text,p.source,p.import_batch_id::text batch,p.revision
         FROM bo_supplier_prices p JOIN bo_suppliers s ON s.id=p.supplier_id
         WHERE p.branch_id=$1 ORDER BY s.name,p.unit`,
      ),
      [
        {
          name: 'Поставщик 1',
          unit: 'kg',
          price_minor: '250000',
          source: 'manual',
          batch: null,
          revision: 1,
        },
        {
          name: 'Поставщик 1',
          unit: 'l',
          price_minor: '180050',
          source: 'import',
          batch: plan.batch,
          revision: 1,
        },
        {
          name: 'Поставщик 2',
          unit: 'pcs',
          price_minor: '12000',
          source: 'import',
          batch: plan.batch,
          revision: 1,
        },
      ],
    );
    // Two audit rows, one per part, with the batch as the entity and the result as after_value.
    const audit = await rows(
      c,
      "SELECT entity_id::text,reason,before_value,after_value FROM bo_audit WHERE branch_id=$1 AND action='supplier_prices_import' ORDER BY created_at,id",
    );
    assert.deepEqual(
      audit.map((a) => [a.entity_id, a.before_value, a.after_value.part]),
      [
        [plan.batch, null, 1],
        [plan.batch, null, 2],
      ],
    );
    // The view: the batch is complete, with its totals, report and suppliers.
    view = await bo.ops(manager.token, c.branch, 'supplier-imports', {});
    const row = view.imports[0];
    assert.deepEqual(
      [
        row.id,
        row.file_name,
        row.profile,
        row.parts,
        row.parts_applied,
        row.complete,
        row.suppliers_created,
        row.prices_created,
        row.unchanged,
        row.actor_name,
      ],
      [plan.batch, 'prices.csv', 'iiko', 2, [1, 2], true, 1, 2, 1, 'Синтетический управляющий'],
    );
    assert.deepEqual(row.counts, summary(2).counts);
    assert.equal(view.import.id, plan.batch);
    assert.deepEqual(view.import.summary, summary(2));
    assert.deepEqual(
      view.import.suppliers.map((x) => [x.name, x.kind, x.created, x.prices]),
      [
        ['Поставщик 1', 'supplier', false, 1],
        ['Поставщик 2', 'bakery', true, 1],
      ],
    );
    assert.deepEqual([view.import.prices_kept, view.import.prices_corrected], [2, 0]);
    assert.deepEqual(view.truncated, { imports: false });
    // A correction by hand makes the price manual; the view counts it as corrected.
    await run(
      request({
        type: 'supplier_price_save',
        supplier_id: fresh,
        ingredient_id: s.bun,
        unit: 'pcs',
        valid_from: DAY,
        price_minor: '12500',
        expected_revision: 1,
      }),
    );
    view = await bo.ops(manager.token, c.branch, 'supplier-imports', { id: plan.batch });
    assert.deepEqual([view.import.prices_kept, view.import.prices_corrected], [1, 1]);
    assert.deepEqual(
      view.import.suppliers.map((x) => [x.name, x.created, x.prices]),
      [
        ['Поставщик 1', false, 1],
        ['Поставщик 2', true, 0],
      ],
    );
    // The supplier view lists the import of its prices with the file and counts only.
    const detail = await bo.ops(manager.token, c.branch, 'suppliers', { id: s.supplier });
    assert.deepEqual(
      detail.imports.map((i) => [i.id, i.file_name, i.counts?.new_prices, 'summary' in i]),
      [[plan.batch, 'prices.csv', 3, false]],
    );
    await assert.rejects(
      bo.ops(manager.token, c.branch, 'supplier-imports', { id: randomUUID() }),
      is('NOT_FOUND'),
    );
    await assert.rejects(
      bo.ops(manager.token, c.branch, 'supplier-imports', { id: 'x' }),
      is('INVALID_REQUEST'),
    );
    await assert.rejects(
      bo.ops(manager.token, c.branch, 'supplier-imports', { q: '1' }),
      is('INVALID_REQUEST'),
    );
    // The database keeps the batch: never changed or deleted, also not by the owner.
    for (const sql of [
      'UPDATE bo_supplier_price_imports SET row_count=5',
      'DELETE FROM bo_supplier_price_imports',
    ])
      await assert.rejects(c.cloud.pool.query(sql), (e) => e.code === '23514', sql);
  }));

test('stale plans and bad bodies: nothing of the part is written', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const s = await seed(bo, manager.token, c);
    const run = (command) => bo.command(manager.token, c.branch, request(command));
    const archived = randomUUID();
    await run({
      type: 'supplier_save',
      id: archived,
      expected_revision: 0,
      payload: { name: 'Поставщик 3', kind: 'supplier', active: false },
    });
    const before = {
      batches: await count(c, 'bo_supplier_price_imports'),
      prices: await count(c, 'bo_supplier_prices'),
      suppliers: await count(c, 'bo_suppliers'),
    };
    const stale = [
      // Another price on that day is already there: never overwritten.
      { prices: [price(s.supplier, s.fillet, 'kg', '260000')] },
      // A new supplier whose name is taken (regardless of case and spaces).
      {
        suppliers: [{ id: randomUUID(), name: 'поставщик 1', kind: 'supplier' }],
        prices: [price(s.supplier, s.bun, 'pcs', '12000')],
      },
      // An archived supplier, an unknown supplier, a switched-off or unknown ingredient.
      { prices: [price(archived, s.bun, 'pcs', '12000')] },
      { prices: [price(randomUUID(), s.bun, 'pcs', '12000')] },
      { prices: [price(s.supplier, s.old, 'pcs', '12000')] },
      { prices: [price(s.supplier, randomUUID(), 'pcs', '12000')] },
    ];
    for (const body of stale)
      await assert.rejects(
        run(part(newPlan(), 1, 1, body)),
        is('CONFLICT', 'IMPORT_STALE'),
        JSON.stringify(body),
      );
    // The unit must measure the ingredient.
    await assert.rejects(
      run(part(newPlan(), 1, 1, { prices: [price(s.supplier, s.bun, 'kg', '12000')] })),
      is('INVALID_REQUEST', 'PRICE_UNIT_MISMATCH'),
    );
    // Bodies the schema refuses.
    const ok = part(newPlan(), 1, 1, { prices: [price(s.supplier, s.bun, 'pcs', '12000')] });
    const { summary: report, ...withoutSummary } = ok;
    const big = {
      ...report,
      issues: Array.from({ length: 200 }, (_, i) => ({
        line: i + 2,
        code: 'NOT_FOUND',
        supplier: 'Поставщик 1',
        name: 'Синтетическая позиция с длинным названием '.repeat(4).slice(0, 200),
        text: 'нет позиции с таким названием',
      })),
      issues_total: 200,
    };
    assert.ok(Buffer.byteLength(JSON.stringify(big)) > IMPORT_SUMMARY_BYTES);
    for (const body of [
      withoutSummary,
      { ...ok, part: 2, parts: 1 },
      { ...ok, summary: { ...report, parts: 2 } },
      { ...ok, summary: { ...report, counts: { ...report.counts, rows: 5 } } },
      { ...ok, summary: { ...report, issues_total: 0 } },
      { ...ok, summary: { ...report, issues: [{ ...report.issues[0], code: 'GUESSED' }] } },
      { ...ok, summary: { ...report, issues: [{ ...report.issues[0], text: 'a\u0007b' }] } },
      { ...ok, summary: big },
      { ...ok, prices: [] },
      { ...ok, prices: [ok.prices[0], { ...ok.prices[0], price_minor: '13000' }] },
      { ...ok, prices: [{ ...ok.prices[0], price_minor: '0' }] },
      { ...ok, prices: [{ ...ok.prices[0], price_minor: '12.5' }] },
      { ...ok, prices: [{ ...ok.prices[0], valid_from: '2023-12-31' }] },
      { ...ok, source: 'excel' },
      { ...ok, row_count: 0 },
      { ...ok, plan_sha256: 'B'.repeat(64) },
      { ...ok, suppliers: [{ id: randomUUID(), name: '', kind: 'supplier' }] },
      { ...ok, suppliers: [{ id: randomUUID(), name: 'Поставщик 9', kind: 'household' }] },
      { ...ok, extra: true },
    ])
      await assert.rejects(run(body), is('INVALID_REQUEST'), JSON.stringify(body).slice(0, 120));
    // Two plans with one batch id: the second is stale.
    const plan = newPlan();
    await run(part(plan, 1, 1, { prices: [price(s.supplier, s.bun, 'pcs', '12000')] }));
    await assert.rejects(
      run(
        part({ ...plan, plan: hex('c') }, 1, 1, {
          prices: [price(s.supplier, s.oil, 'ml', '200')],
        }),
      ),
      is('CONFLICT', 'IMPORT_STALE'),
    );
    assert.deepEqual(
      {
        batches: await count(c, 'bo_supplier_price_imports'),
        prices: await count(c, 'bo_supplier_prices'),
        suppliers: await count(c, 'bo_suppliers'),
      },
      { batches: before.batches + 1, prices: before.prices + 1, suppliers: before.suppliers },
    );
  }));

test('roles: the manager and the accountant import, the shift manager and the analyst read', () =>
  withSyncDatabases(async (c) => {
    const { manager, shift, accountant, analyst } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, ON);
    const s = await seed(bo, manager.token, c);
    const body = () =>
      part(newPlan(hex('a'), randomUUID().replaceAll('-', '').repeat(2)), 1, 1, {
        prices: [price(s.supplier, s.bun, 'pcs', '12000')],
      });
    await assert.rejects(
      bo.command(shift.token, c.branch, request(body())),
      is('FORBIDDEN', 'ROLE_FORBIDDEN'),
    );
    await assert.rejects(
      bo.command(analyst.token, c.branch, request(body())),
      is('FORBIDDEN', undefined),
    );
    const done = await bo.command(accountant.token, c.branch, request(body()));
    assert.equal(done.prices_created, 1);
    for (const who of [manager, shift, accountant, analyst]) {
      const view = await bo.ops(who.token, c.branch, 'supplier-imports', {});
      assert.equal(view.imports.length, 1);
      assert.equal(view.imports[0].actor_name, 'Синтетический бухгалтер');
    }
    // Without roles the grant decides: the analyst may not import.
    const plain = new Backoffice(c.cloud.pool, true, { stockV2Enabled: true, supplyEnabled: true });
    await assert.rejects(
      plain.command(analyst.token, c.branch, request(body())),
      is('FORBIDDEN', undefined),
    );
  }));

/** A NOLOGIN role like pickchick_app with backofficeGrants, and a pool that acts as it. */
async function withRole(c, run) {
  const schema = c.cloud.schema;
  const role = 'bo_si_' + randomUUID().replaceAll('-', '');
  let pool;
  await c.cloud.admin.query(
    `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  try {
    await c.cloud.pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await c.cloud.pool.query(backofficeGrants(role, true));
    const url = new URL(c.cloud.config.databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
    pool = createPool(url.toString());
    await run({ role, schema, pool });
  } finally {
    await pool?.end();
    await c.cloud.admin.query(`DROP OWNED BY ${role}`);
    await c.cloud.admin.query(`DROP ROLE ${role}`);
  }
}
const SUPPLY_OFF = { backoffice: true, supply: false, stockReports: false, staffAssignment: false };

test('API role: NOT_READY without the 076 helper rights, the import with exactly them', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const s = await seed(new Backoffice(c.cloud.pool, true, ON), manager.token, c);
    await withRole(c, async ({ role, schema, pool }) => {
      const bo = new Backoffice(pool, true, ON);
      const plan = newPlan();
      const fresh = randomUUID();
      const body = part(plan, 1, 1, {
        suppliers: [{ id: fresh, name: 'Поставщик 2', kind: 'supplier' }],
        prices: [price(fresh, s.bun, 'pcs', '12000'), price(s.supplier, s.fillet, 'kg', '250000')],
      });
      await assert.rejects(
        bo.ops(manager.token, c.branch, 'supplier-imports', {}),
        is('NOT_READY'),
      );
      await assert.rejects(bo.command(manager.token, c.branch, request(body)), is('NOT_READY'));
      await c.cloud.pool.query(
        backofficeSupplyGrants(role, { ...SUPPLY_OFF, supply: true }, schema),
      );
      const done = await bo.command(manager.token, c.branch, request(body));
      assert.deepEqual([done.suppliers_created, done.prices_created, done.unchanged], [1, 1, 1]);
      const view = await bo.ops(manager.token, c.branch, 'supplier-imports', {});
      assert.equal(view.imports[0].complete, true);
      // The role can neither change nor delete a batch.
      await assert.rejects(
        pool.query('UPDATE bo_supplier_price_imports SET row_count=2'),
        (e) => e?.code === '42501',
      );
      await assert.rejects(
        pool.query('DELETE FROM bo_supplier_price_imports'),
        (e) => e?.code === '42501',
      );
    });
  }));
