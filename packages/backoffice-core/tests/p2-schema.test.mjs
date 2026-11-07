import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '@pickchick/database';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import { Backoffice, grantBackoffice } from '../dist/index.js';

/**
 * cloud076 (lane bo-ui2, design-bo-ui.md «Вторая волна»): upgrade from 075 with existing data,
 * every CHECK, index and trigger of the new schema, and the bo-ui runtime on top of it. The bo-ui
 * runtime is this build with every second-wave flag off: tests/integration/backoffice-p2-golden
 * proves it answers byte for byte like the bo-ui result aff89ce6.
 */
const MIGRATIONS = fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url));
const P2 = '076_cloud_backoffice_supply.sql';
const P2_TABLES = [
  'bo_staff_assignments',
  'bo_supplier_price_imports',
  'bo_supplier_prices',
  'bo_suppliers',
  'bo_supply_requests',
];
const P2_FUNCTIONS = [
  'guard_bo_staff_assignment',
  'guard_bo_supplier_price',
  'guard_bo_supply_request',
];
const fails = (code) => (error) => error?.code === code;
const CHECK = fails('23514');
const UNIQUE = fails('23505');
const FK = fails('23503');
/** Every bo-ui flag on (with the cloud lane flags its features build on). */
const BO_UI = Object.freeze({
  rolesEnabled: true,
  stockV2Enabled: true,
  salesReportEnabled: true,
  posDayEnabled: true,
  stockAutoconsumeEnabled: true,
  managerShiftsEnabled: true,
  staffPositionsEnabled: true,
  discountsEnabled: true,
});
const VOLATILE = new Set(['as_of', 'generated_at', 'trace_id']);
const stable = (value) =>
  JSON.parse(JSON.stringify(value), (key, v) => (VOLATILE.has(key) ? undefined : v));

async function people(c) {
  const manager = await provisionCatalogManager(c.cloud.pool, {
    organization_id: c.org,
    name: 'Синтетический управляющий',
    branch_ids: [c.branch],
  });
  await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
  return { manager };
}
const envelope = (command, reason = 'Синтетическая проверка 076') => ({
  request_id: randomUUID(),
  reason,
  command,
});
async function save(bo, token, branch, kind, payload, id = randomUUID()) {
  await bo.command(
    token,
    branch,
    envelope({ type: 'save', kind, id, expected_revision: 0, payload }),
  );
  return id;
}
const ingredient = (bo, token, branch, name, unit = 'g') =>
  save(bo, token, branch, 'ingredient', { name, unit, minimum: '0', active: true });
const employee = (bo, token, branch, name) =>
  save(bo, token, branch, 'employee', { name, role: 'cook', active: true, note: '' });
async function balanceRevision(c, id) {
  return (
    (
      await c.cloud.pool.query(
        'SELECT revision FROM bo_stock_balances WHERE branch_id=$1 AND ingredient_id=$2',
        [c.branch, id],
      )
    ).rows[0]?.revision ?? 0
  );
}
async function stock(bo, c, token, kind, id, extra = {}, quantity = '100', value = '1000') {
  return bo.command(
    token,
    c.branch,
    envelope({
      type: 'stock',
      kind,
      reference: 'SYN-' + kind,
      lines: [
        {
          ingredient_id: id,
          quantity,
          value_minor: value,
          expected_revision: await balanceRevision(c, id),
        },
      ],
      ...extra,
    }),
  );
}
async function olderSchema(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-cloud-075-'));
  try {
    for (const file of await readdir(MIGRATIONS))
      if (/^\d{3}_[a-z_]+\.sql$/.test(file) && file < '076')
        await cp(join(MIGRATIONS, file), join(directory, file));
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
/** A second branch of the same organization (cross-branch references must fail). */
async function otherBranch(c) {
  const id = randomUUID();
  await c.cloud.pool.query(
    "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,$4,'Synthetic 2')",
    [id, c.org, c.legal, 'SYN' + id.slice(0, 6).toUpperCase()],
  );
  return id;
}
/**
 * The catalog of the current schema: every relation with its columns, defaults, constraints,
 * indexes, triggers and rights, and every function body. Used to prove that 076 changes nothing
 * that exists.
 */
async function catalog(c) {
  const relations = (
    await c.cloud.pool.query(`
      SELECT c.relname, c.relkind, coalesce(c.relacl::text,'') acl,
        (SELECT jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid,a.atttypmod),
            a.attnotnull, pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
           FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
          WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) columns,
        (SELECT jsonb_agg(jsonb_build_array(conname, pg_get_constraintdef(oid), convalidated) ORDER BY conname)
           FROM pg_constraint WHERE conrelid=c.oid) constraints,
        (SELECT jsonb_agg(pg_get_indexdef(indexrelid) ORDER BY pg_get_indexdef(indexrelid))
           FROM pg_index WHERE indrelid=c.oid) indexes,
        (SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname)
           FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) triggers
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','S','i')
      ORDER BY c.relname`)
  ).rows;
  const functions = (
    await c.cloud.pool.query(`
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' name,
        md5(p.prosrc) body, p.prosecdef, coalesce(p.proconfig::text,'') config
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=current_schema() ORDER BY 1`)
  ).rows;
  return {
    relations: Object.fromEntries(relations.map((r) => [r.relname, r])),
    functions: Object.fromEntries(functions.map((f) => [f.name, f])),
  };
}
/** Every row of every table of the schema except the migration ledger, in a stable order. */
async function rows(c) {
  const tables = (
    await c.cloud.pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename<>'schema_migrations' ORDER BY 1",
    )
  ).rows.map((r) => r.tablename);
  const out = {};
  for (const table of tables)
    out[table] = (
      await c.cloud.pool.query(`SELECT to_jsonb(t) r FROM ${table} t ORDER BY to_jsonb(t)::text`)
    ).rows.map((r) => r.r);
  return out;
}

test('076 is applied by migrate(): no digit after the prefix, new relations only, no grants', async () => {
  const files = (await readdir(MIGRATIONS)).filter((name) => name.startsWith('076'));
  assert.deepEqual(files, [P2]);
  // packages/database migrate() silently skips any other name (contracts R11).
  assert.match(P2, /^\d{3}_[a-z_]+\.sql$/);
  const sql = await readFile(join(MIGRATIONS, P2), 'utf8');
  assert.doesNotMatch(
    sql,
    /DROP\s+(COLUMN|TABLE|INDEX|TRIGGER|FUNCTION|CONSTRAINT)|DELETE\s+FROM|TRUNCATE|UPDATE\s+bo_|INSERT\s+INTO\s+bo_[a-z_]+\s*\(/i,
  );
  // Nothing that exists is altered: no ALTER at all, every table and index is new.
  assert.doesNotMatch(sql, /\bALTER\s+(TABLE|INDEX|TYPE|FUNCTION)\b/i);
  assert.doesNotMatch(sql, /CREATE\s+(OR\s+REPLACE)/i);
  const created = [...sql.matchAll(/^CREATE TABLE (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(created, P2_TABLES);
  for (const [, table] of sql.matchAll(/^CREATE (?:UNIQUE )?INDEX \w+ ON (\w+)/gm))
    assert.ok(P2_TABLES.includes(table), `index on ${table}`);
  for (const [, table] of sql.matchAll(/^CREATE TRIGGER \w+ [^\n]* ON (\w+)/gm))
    assert.ok(P2_TABLES.includes(table), `trigger on ${table}`);
  assert.doesNotMatch(sql, /REFERENCES\s+cloud_pos_/i);
  assert.doesNotMatch(sql, /\bGRANT\b|\bREVOKE\b|SECURITY\s+DEFINER/);
  assert.doesNotMatch(sql, /[—–]/);
});

test('upgrade from 075 with data: no existing relation changes, every row and every bo-ui payload stays', () =>
  olderSchema((directory) =>
    withSyncDatabases(
      async (c) => {
        const { manager } = await people(c);
        const token = manager.token;
        const off = new Backoffice(c.cloud.pool, true, {});
        const bo = new Backoffice(c.cloud.pool, true, BO_UI);
        // bo-ui data in the 017/074/075 tables.
        const flour = await ingredient(bo, token, c.branch, 'Синтетическая мука');
        const bun = await ingredient(bo, token, c.branch, 'Синтетическая булка', 'pcs');
        const cook = await employee(bo, token, c.branch, 'Синтетический повар');
        await stock(bo, c, token, 'receipt', flour, {
          meta: {
            supplier_kind: 'bakery',
            supplier_name: 'Пекарня 1',
            document_date: '2026-11-18',
          },
        });
        await stock(bo, c, token, 'receipt', bun, {}, '40', '40000');
        const waste = await stock(
          bo,
          c,
          token,
          'waste',
          flour,
          { reason_code: 'defect' },
          '5',
          '0',
        );
        await bo.command(
          token,
          c.branch,
          envelope({
            type: 'stock_reverse',
            document_id: waste.id,
            expected_balances: { [flour]: await balanceRevision(c, flour) },
          }),
        );
        await stock(bo, c, token, 'count', bun, {}, '38', '0');
        await bo.command(
          token,
          c.branch,
          envelope({
            type: 'discount_save',
            id: randomUUID(),
            expected_revision: 0,
            payload: {
              name: 'Синтетическая скидка',
              kind: 'amount',
              percent_bp: null,
              value_minor: '50000',
              scope: { categories: [], products: [], channels: ['hall'] },
              schedule: { start_at: null, end_at: null, weekdays: [1, 2, 3, 4, 5], hours: [] },
              requires_manager_pin: true,
              combinable: false,
            },
          }),
        );
        // The last 30 Almaty days (the documents were written just now).
        const day = (offset) =>
          new Date(Date.now() + 5 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
        const window = { start_date: day(-30), end_date: day(0) };
        const views = [
          ['stock', { view: 'waste', ...window }],
          ['stock', { view: 'movement', ...window }],
          ['discounts', {}],
          ['staff-roster', {}],
          ['menu-links', {}],
          ['consumption', {}],
          ['manager-shifts', {}],
        ];
        const snapshot = async () => ({
          readOff: stable(await off.read(token, c.branch)),
          read: stable(await bo.read(token, c.branch)),
          ops: await Promise.all(
            views.map(async ([v, q]) => stable(await bo.ops(token, c.branch, v, q))),
          ),
          rows: await rows(c),
        });
        const before = await snapshot();
        const catalogBefore = await catalog(c);
        assert.ok(
          before.rows.bo_discounts.length === 1 && before.rows.bo_stock_documents.length === 5,
        );
        assert.equal(before.read.capabilities.stock_p1, true);

        assert.deepEqual(await migrate(c.cloud.pool, MIGRATIONS, 'cloud'), [P2]);
        const catalogAfter = await catalog(c);
        // Every relation and function of 075 is exactly as it was: columns, defaults,
        // constraints (validated), indexes, triggers, rights and bodies.
        for (const [name, relation] of Object.entries(catalogBefore.relations))
          assert.deepEqual(catalogAfter.relations[name], relation, name);
        for (const [name, fn] of Object.entries(catalogBefore.functions))
          assert.deepEqual(catalogAfter.functions[name], fn, name);
        const addedTables = Object.values(catalogAfter.relations)
          .filter((r) => !(r.relname in catalogBefore.relations) && r.relkind === 'r')
          .map((r) => r.relname)
          .sort();
        assert.deepEqual(addedTables, P2_TABLES);
        const addedFunctions = Object.keys(catalogAfter.functions)
          .filter((name) => !(name in catalogBefore.functions))
          .sort();
        assert.deepEqual(
          addedFunctions,
          P2_FUNCTIONS.map((name) => name + '()'),
        );
        // Every row and every payload of the bo-ui runtime is the same after 076; the new
        // tables are empty.
        const after = await snapshot();
        for (const table of P2_TABLES) {
          assert.deepEqual(after.rows[table], [], table);
          delete after.rows[table];
        }
        assert.deepEqual(after, before);

        // The bo-ui runtime keeps writing on 076: the same commands, the same results.
        await stock(bo, c, token, 'receipt', flour);
        const second = await stock(
          bo,
          c,
          token,
          'waste',
          bun,
          { reason_code: 'damaged' },
          '1',
          '0',
        );
        await bo.command(
          token,
          c.branch,
          envelope({
            type: 'stock_reverse',
            document_id: second.id,
            expected_balances: { [bun]: await balanceRevision(c, bun) },
          }),
        );
        await assert.rejects(stock(bo, c, token, 'waste', bun, {}, '1', '0'), {
          code: 'INVALID_REQUEST',
          reason: 'REASON_REQUIRED',
        });
        await bo.command(
          token,
          c.branch,
          envelope({
            type: 'save',
            kind: 'employee',
            id: cook,
            expected_revision: 1,
            payload: {
              name: 'Синтетический повар',
              role: 'cook',
              active: true,
              note: '',
              position_code: 'fryer',
              pos_access: 'none',
            },
          }),
        );
        const state = stable(await bo.read(token, c.branch));
        assert.deepEqual(Object.keys(state), Object.keys(before.read));
        assert.deepEqual(Object.keys(state.capabilities), Object.keys(before.read.capabilities));
        assert.equal(state.documents.length, 8);
        // Applying the directory again is a no-op.
        assert.deepEqual(await migrate(c.cloud.pool, MIGRATIONS, 'cloud'), []);
      },
      { cloudMigrationDirectory: directory },
    ),
  ));

test('bo_suppliers: name, kind, one live name per branch regardless of case, revisions, never deleted', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const actor = manager.actor_id;
    const insert = (fields = {}) =>
      c.cloud.pool.query(
        `INSERT INTO bo_suppliers(id,branch_id,name,kind,revision,created_by,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$6)`,
        [
          fields.id ?? randomUUID(),
          fields.branch ?? c.branch,
          fields.name ?? 'Поставщик 1',
          fields.kind ?? 'supplier',
          fields.revision ?? 1,
          actor,
        ],
      );
    for (const name of ['', ' Поставщик', 'Поставщик ', 'Поставщик\t2', 'П'.repeat(121)])
      await assert.rejects(insert({ name }), CHECK, JSON.stringify(name));
    await assert.rejects(insert({ kind: 'household' }), CHECK);
    await assert.rejects(insert({ revision: 2 }), CHECK);
    await assert.rejects(insert({ branch: randomUUID() }), FK);
    const id = randomUUID();
    await insert({ id, name: 'П'.repeat(120) });
    await insert({ name: 'Поставщик 1' });
    await assert.rejects(insert({ name: 'поставщик 1', kind: 'bakery' }), UNIQUE);
    // Another branch may use the same name.
    await insert({ name: 'Поставщик 1', branch: await otherBranch(c) });
    const update = (sql, args = []) => c.cloud.pool.query(sql, [id, ...args]);
    await update("UPDATE bo_suppliers SET name='Цех 1',revision=2 WHERE id=$1");
    // The revision grows by exactly one.
    await assert.rejects(
      update('UPDATE bo_suppliers SET active=false,revision=2 WHERE id=$1'),
      CHECK,
    );
    await assert.rejects(
      update('UPDATE bo_suppliers SET active=false,revision=4 WHERE id=$1'),
      CHECK,
    );
    // Kind and creation are immutable.
    await assert.rejects(
      update("UPDATE bo_suppliers SET kind='bakery',revision=3 WHERE id=$1"),
      CHECK,
    );
    await assert.rejects(
      update(
        "UPDATE bo_suppliers SET created_at=created_at - interval '1 day',revision=3 WHERE id=$1",
      ),
      CHECK,
    );
    await update('UPDATE bo_suppliers SET active=false,revision=3 WHERE id=$1');
    await assert.rejects(c.cloud.pool.query('DELETE FROM bo_suppliers WHERE id=$1', [id]), CHECK);
  }));

test('bo_supplier_price_imports: hashes, source, row count, one application of a plan, immutable', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const insert = (fields = {}) =>
      c.cloud.pool.query(
        `INSERT INTO bo_supplier_price_imports(id,branch_id,source,file_sha256,plan_sha256,row_count,summary,actor_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          fields.id ?? randomUUID(),
          fields.branch ?? c.branch,
          fields.source ?? 'iiko_export',
          fields.file ?? 'a'.repeat(64),
          fields.plan ?? 'b'.repeat(64),
          fields.rows ?? 10,
          fields.summary ?? '{}',
          manager.actor_id,
        ],
      );
    await assert.rejects(insert({ source: 'excel' }), CHECK);
    await assert.rejects(insert({ file: 'A'.repeat(64) }), CHECK);
    await assert.rejects(insert({ plan: 'b'.repeat(63) }), CHECK);
    await assert.rejects(insert({ rows: 0 }), CHECK);
    await assert.rejects(insert({ rows: 5001 }), CHECK);
    await assert.rejects(insert({ summary: '[]' }), CHECK);
    const id = (await insert()).rows[0].id;
    // The same plan is applied once per branch; another branch may apply it.
    await assert.rejects(insert({ file: 'c'.repeat(64) }), UNIQUE);
    await insert({ branch: await otherBranch(c) });
    await assert.rejects(
      c.cloud.pool.query('UPDATE bo_supplier_price_imports SET row_count=11 WHERE id=$1', [id]),
      CHECK,
    );
    await assert.rejects(
      c.cloud.pool.query('DELETE FROM bo_supplier_price_imports WHERE id=$1', [id]),
      CHECK,
    );
  }));

test('bo_supplier_prices: unit that measures the ingredient, positive tiyn, source and batch, revisions', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const actor = manager.actor_id;
    const bo = new Backoffice(c.cloud.pool, true, {});
    const fillet = await ingredient(bo, manager.token, c.branch, 'Синтетическое филе', 'g');
    const milk = await ingredient(bo, manager.token, c.branch, 'Синтетическое молоко', 'ml');
    const bun = await ingredient(bo, manager.token, c.branch, 'Синтетическая булка', 'pcs');
    const supplier = randomUUID();
    await c.cloud.pool.query(
      "INSERT INTO bo_suppliers(id,branch_id,name,kind,revision,created_by,updated_by) VALUES($1,$2,'Поставщик 1','supplier',1,$3,$3)",
      [supplier, c.branch, actor],
    );
    const second = await otherBranch(c);
    const foreign = randomUUID();
    await c.cloud.pool.query(
      "INSERT INTO bo_suppliers(id,branch_id,name,kind,revision,created_by,updated_by) VALUES($1,$2,'Поставщик 2','supplier',1,$3,$3)",
      [foreign, second, actor],
    );
    const batch = randomUUID();
    await c.cloud.pool.query(
      `INSERT INTO bo_supplier_price_imports(id,branch_id,source,file_sha256,plan_sha256,row_count,summary,actor_id)
       VALUES($1,$2,'csv',$3,$4,1,'{}',$5)`,
      [batch, c.branch, 'a'.repeat(64), 'b'.repeat(64), actor],
    );
    const foreignBatch = randomUUID();
    await c.cloud.pool.query(
      `INSERT INTO bo_supplier_price_imports(id,branch_id,source,file_sha256,plan_sha256,row_count,summary,actor_id)
       VALUES($1,$2,'csv',$3,$4,1,'{}',$5)`,
      [foreignBatch, second, 'a'.repeat(64), 'b'.repeat(64), actor],
    );
    const insert = (fields = {}) =>
      c.cloud.pool.query(
        `INSERT INTO bo_supplier_prices(branch_id,supplier_id,ingredient_id,unit,price_minor,valid_from,
           source,import_batch_id,revision,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          fields.branch ?? c.branch,
          fields.supplier ?? supplier,
          fields.ingredient ?? fillet,
          fields.unit ?? 'kg',
          fields.price ?? 250000,
          fields.from ?? '2026-11-19',
          fields.source ?? 'manual',
          fields.batch ?? null,
          fields.revision ?? 1,
          actor,
        ],
      );
    await assert.rejects(insert({ unit: 'box' }), CHECK);
    await assert.rejects(insert({ price: 0 }), CHECK);
    await assert.rejects(insert({ price: -1 }), CHECK);
    await assert.rejects(insert({ from: '2023-12-31' }), CHECK);
    await assert.rejects(insert({ from: '2100-01-01' }), CHECK);
    await assert.rejects(insert({ source: 'import' }), CHECK);
    await assert.rejects(insert({ batch }), CHECK);
    await assert.rejects(insert({ source: 'excel' }), CHECK);
    await assert.rejects(insert({ revision: 2 }), CHECK);
    // The unit must measure the ingredient.
    for (const [id, bad] of [
      [fillet, 'l'],
      [fillet, 'ml'],
      [fillet, 'pcs'],
      [milk, 'kg'],
      [milk, 'g'],
      [bun, 'g'],
    ])
      await assert.rejects(insert({ ingredient: id, unit: bad }), CHECK, bad);
    for (const [id, unit] of [
      [fillet, 'kg'],
      [fillet, 'g'],
      [milk, 'l'],
      [milk, 'ml'],
      [bun, 'pcs'],
    ])
      await insert({ ingredient: id, unit });
    // One price per supplier, ingredient, unit and day; the next day is a new row.
    await assert.rejects(insert(), UNIQUE);
    await insert({ from: '2026-11-20', source: 'import', batch });
    // Same-branch references only: supplier, ingredient (an existing card) and batch.
    await assert.rejects(insert({ supplier: foreign, from: '2026-11-21' }), FK);
    await assert.rejects(insert({ ingredient: randomUUID(), unit: 'kg', from: '2026-11-21' }), FK);
    await assert.rejects(insert({ from: '2026-11-21', source: 'import', batch: foreignBatch }), FK);
    const key = [supplier, fillet, 'kg', '2026-11-19'];
    const update = (set, revision) =>
      c.cloud.pool.query(
        `UPDATE bo_supplier_prices SET ${set},revision=${revision} WHERE supplier_id=$1 AND ingredient_id=$2 AND unit=$3 AND valid_from=$4`,
        key,
      );
    await update('price_minor=260000', 2);
    await assert.rejects(update('price_minor=270000', 2), CHECK);
    await assert.rejects(update("valid_from='2026-11-22'", 3), CHECK);
    await assert.rejects(update("unit='g'", 3), CHECK);
    await update(`source='import',import_batch_id='${batch}'`, 3);
    await assert.rejects(update('import_batch_id=NULL', 4), CHECK);
    await assert.rejects(
      c.cloud.pool.query('DELETE FROM bo_supplier_prices WHERE supplier_id=$1', [supplier]),
      CHECK,
    );
  }));

test('bo_supply_requests: draft first, numbered, lines frozen once submitted, received with one receipt, final states', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const actor = manager.actor_id;
    const bo = new Backoffice(c.cloud.pool, true, {});
    const bun = await ingredient(bo, manager.token, c.branch, 'Синтетическая булка', 'pcs');
    const receipt = (await stock(bo, c, manager.token, 'receipt', bun)).id;
    const receipt2 = (await stock(bo, c, manager.token, 'receipt', bun)).id;
    const waste = (await stock(bo, c, manager.token, 'waste', bun, {}, '1', '0')).id;
    const supplier = async (kind, branch = c.branch) => {
      const id = randomUUID();
      await c.cloud.pool.query(
        'INSERT INTO bo_suppliers(id,branch_id,name,kind,revision,created_by,updated_by) VALUES($1,$2,$3,$4,1,$5,$5)',
        [id, branch, 'Поставщик ' + id.slice(0, 8), kind, actor],
      );
      return id;
    };
    const vendor = await supplier('supplier');
    const bakery = await supplier('bakery');
    const kitchen = await supplier('central_kitchen');
    const line = (extra = {}) => ({
      ingredient_id: bun,
      unit: 'pcs',
      qty: '30',
      balance_at_request: '12',
      hint: '8',
      ...extra,
    });
    let number = 0;
    const insert = (fields = {}) =>
      c.cloud.pool.query(
        `INSERT INTO bo_supply_requests(id,branch_id,number,kind,state,supplier_id,needed_by,note,lines,
           revision,created_by,updated_by,submitted_by,submitted_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13) RETURNING id`,
        [
          fields.id ?? randomUUID(),
          fields.branch ?? c.branch,
          fields.number ?? ++number,
          fields.kind ?? 'bakery',
          fields.state ?? 'draft',
          fields.supplier ?? null,
          fields.needed_by ?? null,
          fields.note ?? null,
          JSON.stringify(fields.lines ?? [line()]),
          fields.revision ?? 1,
          actor,
          fields.submitted ? actor : null,
          fields.submitted ? new Date() : null,
        ],
      );
    // A request starts as a draft with revision 1.
    for (const state of ['submitted', 'received', 'cancelled'])
      await assert.rejects(
        insert({ state, needed_by: '2026-11-19', submitted: true }),
        CHECK,
        state,
      );
    await assert.rejects(insert({ revision: 2 }), CHECK);
    await assert.rejects(insert({ kind: 'bar' }), CHECK);
    await assert.rejects(insert({ number: 0 }), CHECK);
    await assert.rejects(insert({ note: ' ' }), CHECK);
    await assert.rejects(insert({ needed_by: '2023-01-01' }), CHECK);
    // A draft may be empty; numbers are unique per branch.
    await insert({ number: 100, lines: [] });
    await assert.rejects(insert({ number: 100 }), UNIQUE);
    await insert({ number: 100, branch: await otherBranch(c) });
    // Lines: an array of at most 100 objects of whole units and whole tiyn.
    await assert.rejects(insert({ lines: {} }), CHECK);
    await insert({ lines: Array.from({ length: 100 }, () => line()) });
    await assert.rejects(insert({ lines: Array.from({ length: 101 }, () => line()) }), CHECK);
    for (const bad of [
      [5],
      [null],
      [[]],
      [{}],
      [line({ ingredient_id: bun.toUpperCase() })],
      [line({ ingredient_id: 7 })],
      [line({ unit: 'kg' })],
      [line({ unit: 5 })],
      [line({ qty: '0' })],
      [line({ qty: '1.5' })],
      [line({ qty: 30 })],
      [line({ balance_at_request: '-1' })],
      [line({ balance_at_request: undefined })],
      [line({ hint: 8 })],
      [line({ hint: '-1' })],
    ])
      await assert.rejects(insert({ lines: bad }), CHECK, JSON.stringify(bad));
    await insert({ lines: [line({ hint: null }), line({ hint: undefined }), line({ hint: '0' })] });
    // price_minor (whole tiyn of the line) only with a supplier.
    await assert.rejects(insert({ lines: [line({ price_minor: '30000' })] }), CHECK);
    await insert({ kind: 'bakery', supplier: bakery, lines: [line({ price_minor: '30000' })] });
    for (const price of ['0', '1.5', 30000, '-5'])
      await assert.rejects(
        insert({ kind: 'bakery', supplier: bakery, lines: [line({ price_minor: price })] }),
        CHECK,
        String(price),
      );
    // The central kitchen and the bakery deliver their own requests, suppliers the others.
    await insert({ kind: 'central_kitchen', supplier: kitchen });
    await insert({ kind: 'household', supplier: vendor });
    await insert({ kind: 'supplier', supplier: vendor });
    for (const [kind, who] of [
      ['bakery', vendor],
      ['bakery', kitchen],
      ['central_kitchen', bakery],
      ['household', bakery],
      ['supplier', kitchen],
    ])
      await assert.rejects(insert({ kind, supplier: who }), CHECK, kind);
    await assert.rejects(insert({ supplier: await supplier('bakery', await otherBranch(c)) }), FK);

    // Transitions of one request.
    const id = (await insert({ kind: 'supplier', lines: [] })).rows[0].id;
    let revision = 1;
    const update = (set, args = []) =>
      c.cloud.pool.query(
        `UPDATE bo_supply_requests SET ${set},revision=${revision + 1},updated_at=clock_timestamp() WHERE id=$1`,
        [id, ...args],
      );
    const step = async (set, args) => {
      await update(set, args);
      revision++;
    };
    const submit = `state='submitted',submitted_by='${actor}',submitted_at=clock_timestamp()`;
    // Submitting needs lines, the day it is needed and, for a supplier request, the supplier.
    await assert.rejects(update(`${submit},needed_by='2026-11-19'`), CHECK);
    await step(`lines=$2`, [JSON.stringify([line()])]);
    await assert.rejects(update(submit), CHECK);
    await assert.rejects(update(`${submit},needed_by='2026-11-19'`), CHECK);
    await assert.rejects(update("state='submitted',needed_by='2026-11-19'"), CHECK);
    await step(`supplier_id=$2,lines=$3`, [
      vendor,
      JSON.stringify([line({ price_minor: '36000' })]),
    ]);
    // A draft is never received directly.
    await assert.rejects(
      update(`state='received',receipt_document_id=$2,closed_by=$3,closed_at=clock_timestamp()`, [
        receipt,
        actor,
      ]),
      CHECK,
    );
    await step(`${submit},needed_by='2026-11-19'`);
    // Submitted: the lines, supplier, day and note are frozen; no way back to draft.
    await assert.rejects(update(`lines=$2`, [JSON.stringify([line({ qty: '31' })])]), CHECK);
    await assert.rejects(update(`needed_by='2026-11-20'`), CHECK);
    await assert.rejects(update(`note='Позвонить'`), CHECK);
    await assert.rejects(update(`supplier_id=NULL`), CHECK);
    await assert.rejects(update(`state='draft',submitted_by=NULL,submitted_at=NULL`), CHECK);
    await assert.rejects(update(`submitted_at=clock_timestamp()`), CHECK);
    // Received <=> a receipt document of the branch, with who closed it.
    await assert.rejects(
      update(`state='received',closed_by=$2,closed_at=clock_timestamp()`, [actor]),
      CHECK,
    );
    await assert.rejects(update(`receipt_document_id=$2`, [receipt]), CHECK);
    await assert.rejects(
      update(`state='received',receipt_document_id=$2,closed_by=$3,closed_at=clock_timestamp()`, [
        waste,
        actor,
      ]),
      CHECK,
    );
    // A missing document or one of another branch is no receipt of this branch (the trigger
    // refuses it before the foreign key would).
    const foreignReceipt = randomUUID();
    const second = await otherBranch(c);
    await c.cloud.pool.query(
      "INSERT INTO bo_stock_documents(id,branch_id,actor_id,kind,reference,reason) VALUES($1,$2,$3,'receipt','SYN-2','Синтетический приход')",
      [foreignReceipt, second, actor],
    );
    for (const doc of [randomUUID(), foreignReceipt])
      await assert.rejects(
        update(`state='received',receipt_document_id=$2,closed_by=$3,closed_at=clock_timestamp()`, [
          doc,
          actor,
        ]),
        CHECK,
      );
    await assert.rejects(
      update(`state='received',receipt_document_id=$2,closed_at=clock_timestamp()`, [receipt]),
      CHECK,
    );
    await step(`state='received',receipt_document_id=$2,closed_by=$3,closed_at=clock_timestamp()`, [
      receipt,
      actor,
    ]);
    // Final: nothing changes, the receipt is never replaced, nothing is deleted.
    await assert.rejects(update(`receipt_document_id=$2`, [receipt2]), CHECK);
    await assert.rejects(update(`state='cancelled'`), CHECK);
    await assert.rejects(update(`updated_by=$2`, [actor]), CHECK);
    await assert.rejects(
      c.cloud.pool.query('DELETE FROM bo_supply_requests WHERE id=$1', [id]),
      CHECK,
    );
    // One receipt document receives one request.
    const other = (await insert({ kind: 'bakery' })).rows[0].id;
    await c.cloud.pool.query(
      `UPDATE bo_supply_requests SET ${submit},needed_by='2026-11-19',revision=2 WHERE id=$1`,
      [other],
    );
    await assert.rejects(
      c.cloud.pool.query(
        `UPDATE bo_supply_requests SET state='received',receipt_document_id=$2,closed_by=$3,closed_at=clock_timestamp(),revision=3 WHERE id=$1`,
        [other, receipt, actor],
      ),
      UNIQUE,
    );
    // Cancelled is final, from a draft or a submitted request; it needs who and when.
    await assert.rejects(
      c.cloud.pool.query("UPDATE bo_supply_requests SET state='cancelled',revision=3 WHERE id=$1", [
        other,
      ]),
      CHECK,
    );
    await c.cloud.pool.query(
      "UPDATE bo_supply_requests SET state='cancelled',closed_by=$2,closed_at=clock_timestamp(),revision=3 WHERE id=$1",
      [other, actor],
    );
    await assert.rejects(
      c.cloud.pool.query(
        "UPDATE bo_supply_requests SET state='submitted',closed_by=NULL,closed_at=NULL,revision=4 WHERE id=$1",
        [other],
      ),
      CHECK,
    );
    const draft = (await insert()).rows[0].id;
    await c.cloud.pool.query(
      "UPDATE bo_supply_requests SET state='cancelled',closed_by=$2,closed_at=clock_timestamp(),revision=2 WHERE id=$1",
      [draft, actor],
    );
    // Identity columns never change; the revision grows by exactly one.
    const third = (await insert()).rows[0].id;
    for (const set of [
      "kind='household'",
      'number=9999',
      "created_at=created_at - interval '1 hour'",
    ])
      await assert.rejects(
        c.cloud.pool.query(`UPDATE bo_supply_requests SET ${set},revision=2 WHERE id=$1`, [third]),
        CHECK,
        set,
      );
    await assert.rejects(
      c.cloud.pool.query("UPDATE bo_supply_requests SET note='Позвонить',revision=3 WHERE id=$1", [
        third,
      ]),
      CHECK,
    );
    await c.cloud.pool.query(
      "UPDATE bo_supply_requests SET note='Позвонить',revision=2 WHERE id=$1",
      [third],
    );
  }));

test('bo_staff_assignments: one open interval per employee, no overlap, Almaty business day, closing only', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const actor = manager.actor_id;
    const bo = new Backoffice(c.cloud.pool, true, {});
    const cook = await employee(bo, manager.token, c.branch, 'Синтетический повар');
    const runner = await employee(bo, manager.token, c.branch, 'Синтетический раннер');
    const flour = await ingredient(bo, manager.token, c.branch, 'Синтетическая мука');
    const insert = (fields = {}) =>
      c.cloud.pool.query(
        `INSERT INTO bo_staff_assignments(id,branch_id,business_date,employee_id,station_code,started_at,
           ended_at,set_by,ended_by,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          fields.id ?? randomUUID(),
          fields.branch ?? c.branch,
          fields.day ?? '2026-11-19',
          fields.employee ?? cook,
          fields.station ?? 'fryer',
          fields.start ?? '2026-11-19T10:00:00+05:00',
          fields.end ?? null,
          actor,
          fields.end ? actor : null,
          fields.revision ?? 1,
        ],
      );
    for (const station of ['Fryer', '1', 'f', 'fryer-2', 'f'.repeat(41)])
      await assert.rejects(insert({ station }), CHECK, station);
    await assert.rejects(insert({ employee: flour }), FK);
    await assert.rejects(insert({ employee: randomUUID() }), FK);
    await assert.rejects(insert({ revision: 2 }), CHECK);
    await assert.rejects(insert({ end: '2026-11-19T09:59:59+05:00' }), CHECK);
    // The business day: the Almaty day of the start or the day before (after midnight).
    await assert.rejects(insert({ day: '2026-11-20' }), CHECK);
    await assert.rejects(insert({ day: '2026-11-17' }), CHECK);
    await assert.rejects(
      insert({
        day: '2026-11-19',
        start: '2026-11-18T23:59:00+05:00',
        end: '2026-11-19T00:00:00+05:00',
      }),
      CHECK,
    );
    await insert({
      employee: runner,
      day: '2026-11-18',
      start: '2026-11-19T00:30:00+05:00',
      end: '2026-11-19T01:30:00+05:00',
    });
    // ended_at and ended_by together.
    await assert.rejects(
      c.cloud.pool.query(
        `INSERT INTO bo_staff_assignments(id,branch_id,business_date,employee_id,station_code,started_at,ended_at,set_by,revision)
         VALUES($1,$2,'2026-11-19',$3,'fryer','2026-11-19T08:00:00+05:00','2026-11-19T09:00:00+05:00',$4,1)`,
        [randomUUID(), c.branch, cook, actor],
      ),
      CHECK,
    );
    const open = (await insert()).rows[0].id;
    // One open interval per employee: the overlap trigger refuses a second one, and the partial
    // unique index holds even with triggers off (a race past the trigger).
    await assert.rejects(insert({ start: '2026-11-19T11:00:00+05:00', station: 'prep' }), CHECK);
    const raw = await c.cloud.pool.connect();
    try {
      await raw.query('SET session_replication_role = replica');
      await assert.rejects(
        raw.query(
          `INSERT INTO bo_staff_assignments(id,branch_id,business_date,employee_id,station_code,started_at,set_by,revision)
           VALUES($1,$2,'2026-11-19',$3,'prep','2026-11-19T11:00:00+05:00',$4,1)`,
          [randomUUID(), c.branch, cook, actor],
        ),
        UNIQUE,
      );
    } finally {
      await raw.query('RESET session_replication_role');
      raw.release();
    }
    // Another employee may stand at the same station.
    await insert({ employee: runner, station: 'fryer' });
    // No overlap with an open or closed interval, touching is fine, zero length is fine.
    await assert.rejects(
      insert({ start: '2026-11-19T12:00:00+05:00', end: '2026-11-19T13:00:00+05:00' }),
      CHECK,
    );
    await insert({ start: '2026-11-19T08:00:00+05:00', end: '2026-11-19T10:00:00+05:00' });
    await assert.rejects(
      insert({
        start: '2026-11-19T09:00:00+05:00',
        end: '2026-11-19T09:30:00+05:00',
        station: 'prep',
      }),
      CHECK,
    );
    await insert({ start: '2026-11-19T07:00:00+05:00', end: '2026-11-19T07:00:00+05:00' });
    // A reassignment closes the open interval at the start of the new one.
    const close = (id, end, revision = 2, extra = '') =>
      c.cloud.pool.query(
        `UPDATE bo_staff_assignments SET ended_at=$2,ended_by=$3,revision=$4${extra} WHERE id=$1`,
        [id, end, actor, revision],
      );
    await assert.rejects(close(open, '2026-11-19T09:00:00+05:00'), CHECK);
    await assert.rejects(
      c.cloud.pool.query('UPDATE bo_staff_assignments SET revision=2 WHERE id=$1', [open]),
      CHECK,
    );
    await assert.rejects(
      close(open, '2026-11-19T13:30:00+05:00', 2, ",station_code='prep'"),
      CHECK,
    );
    await assert.rejects(
      close(open, '2026-11-19T13:30:00+05:00', 2, ",started_at='2026-11-19T10:05:00+05:00'"),
      CHECK,
    );
    await close(open, '2026-11-19T13:30:00+05:00');
    await insert({ start: '2026-11-19T13:30:00+05:00', station: 'prep' });
    // A closed interval never changes and nothing is deleted.
    await assert.rejects(close(open, '2026-11-19T14:00:00+05:00', 3), CHECK);
    await assert.rejects(
      c.cloud.pool.query('DELETE FROM bo_staff_assignments WHERE id=$1', [open]),
      CHECK,
    );
    // An employee of another branch is not assignable here.
    await assert.rejects(
      insert({
        branch: await otherBranch(c),
        start: '2026-11-20T10:00:00+05:00',
        day: '2026-11-20',
      }),
      FK,
    );
  }));
