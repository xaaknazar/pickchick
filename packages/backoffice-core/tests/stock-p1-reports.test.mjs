import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import {
  Backoffice,
  BackofficeError,
  INGREDIENT_GROUPS,
  IngredientP1,
  STOCK_P1_VIEWS,
  StockOpsQueryP1,
  designateBackoffice,
  grantBackoffice,
  readStockOps,
  readStockOpsP1,
} from '../dist/index.js';

/**
 * Stock P1 of lane bo-ui, step 8 (design-bo-ui.md 5.2, 5.4, 5.6): the report views
 * «Расхождения подсчёта» (view=variance) and «Расход по продажам» (view=consumption), the
 * ingredient fields count_daily and group, the closing count of the key positions in the manager
 * shift, and RECIPE_POLICY_EXPLODE on produce. Behind BACKOFFICE_STOCK_V2_ENABLED with cloud075
 * and its rights, like the rest of stock P1; synthetic data only.
 */
const is = (code, reason) => (error) =>
  error instanceof BackofficeError && error.code === code && error.reason === reason;
const almaty = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(d);
const today = () => almaty(new Date());
const request = (command, reason = 'Синтетическая проверка отчётов склада') => ({
  request_id: randomUUID(),
  reason,
  command,
});
const V2 = { stockV2Enabled: true, rolesEnabled: true };

// ------------------------------------------------------------------------------ pure ----

test('P1 schemas: the report views, count_daily and group of an ingredient', () => {
  assert.deepEqual(STOCK_P1_VIEWS, ['waste', 'movement', 'variance', 'consumption']);
  assert.deepEqual(INGREDIENT_GROUPS, ['raw', 'semi', 'packaging', 'drink', 'household', 'other']);
  const ok = (q) => StockOpsQueryP1.safeParse(q).success;
  for (const view of STOCK_P1_VIEWS)
    assert.equal(ok({ view, start_date: '2026-11-13', end_date: '2026-11-19' }), true, view);
  assert.equal(ok({ view: 'sales', start_date: '2026-11-13', end_date: '2026-11-19' }), false);
  assert.equal(ok({ view: 'variance', start_date: '2026-11-20', end_date: '2026-11-19' }), false);
  assert.equal(ok({ view: 'variance', start_date: '2026-08-01', end_date: '2026-11-19' }), false);
  assert.equal(ok({ view: 'variance', start_date: '2026-11-19' }), false);
  const card = { name: 'Синтетическая булка', unit: 'pcs', minimum: '0', active: true };
  assert.equal(IngredientP1.safeParse({ ...card, count_daily: true, group: 'raw' }).success, true);
  assert.equal(IngredientP1.safeParse({ ...card, count_daily: 'yes' }).success, false);
  assert.equal(IngredientP1.safeParse({ ...card, group: 'meat' }).success, false);
});

// ------------------------------------------------------------------------- PostgreSQL ----

async function person(c, name, grant) {
  const p = await provisionCatalogManager(c.cloud.pool, {
    organization_id: c.org,
    name,
    branch_ids: [c.branch],
  });
  await grantBackoffice(c.cloud.pool, p.actor_id, c.branch, grant);
  return p;
}
async function people(c) {
  const manager = await person(c, 'Синтетический управляющий', 'manager');
  const shift = await person(c, 'Синтетический начальник смены', 'analyst');
  await designateBackoffice(
    c.cloud.pool,
    shift.actor_id,
    c.branch,
    'shift_manager',
    'Т7: назначение',
  );
  return { manager, shift };
}
async function ingredient(bo, token, c, name, unit, extra = {}) {
  const id = randomUUID();
  await bo.command(
    token,
    c.branch,
    request({
      type: 'save',
      kind: 'ingredient',
      id,
      expected_revision: 0,
      payload: { name, unit, minimum: '0', active: true, ...extra },
    }),
  );
  return id;
}
async function balances(c) {
  return Object.fromEntries(
    (
      await c.cloud.pool.query(
        'SELECT ingredient_id,quantity::text,value_minor::text,revision FROM bo_stock_balances WHERE branch_id=$1',
        [c.branch],
      )
    ).rows.map((r) => [r.ingredient_id, r]),
  );
}
async function stock(bo, token, c, kind, lines, extra = {}) {
  const now = await balances(c);
  return bo.command(
    token,
    c.branch,
    request({
      type: 'stock',
      kind,
      reference: extra.reference ?? 'SYN-' + kind,
      lines: lines.map(([id, quantity, value = '0']) => ({
        ingredient_id: id,
        quantity,
        value_minor: value,
        expected_revision: now[id].revision,
      })),
      ...(extra.reason_code ? { reason_code: extra.reason_code } : {}),
    }),
  );
}
/** An automatic consumption of one POS sale as the worker writes it (raw owner rows). */
async function posConsumption(c, actor, ingredientId, quantity, at) {
  const b = (await balances(c))[ingredientId];
  const q = BigInt(b.quantity),
    v = BigInt(b.value_minor),
    n = BigInt(quantity),
    dv = (v * -n) / q;
  const id = randomUUID();
  await c.cloud.pool.query(
    "INSERT INTO bo_stock_documents(id,branch_id,actor_id,kind,reference,reason,source_ref,created_at) VALUES($1,$2,$3,'consumption',$4,'Автоматически по продаже кассы',$5,$6)",
    [id, c.branch, actor, 'POS-' + id.slice(0, 4), 'pos:' + randomUUID(), at],
  );
  await c.cloud.pool.query(
    'INSERT INTO bo_stock_movements(document_id,branch_id,ingredient_id,quantity_delta,value_delta_minor,balance_after,value_after_minor) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      id,
      c.branch,
      ingredientId,
      (-n).toString(),
      dv.toString(),
      (q - n).toString(),
      (v + dv).toString(),
    ],
  );
  await c.cloud.pool.query(
    'UPDATE bo_stock_balances SET quantity=$3,value_minor=$4,revision=revision+1 WHERE branch_id=$1 AND ingredient_id=$2',
    [c.branch, ingredientId, (q - n).toString(), (v + dv).toString()],
  );
  return { id, value: (-dv).toString() };
}
/** The movements of the count documents, straight from the table, to compare the view with. */
async function countMovements(c) {
  return (
    await c.cloud.pool.query(
      `SELECT m.ingredient_id,m.quantity_delta::text,m.value_delta_minor::text,m.balance_after::text,d.created_at
       FROM bo_stock_movements m JOIN bo_stock_documents d ON d.id=m.document_id
       WHERE d.branch_id=$1 AND d.kind='count' ORDER BY d.created_at,d.id`,
      [c.branch],
    )
  ).rows;
}

test('flag off and the cloud lane query: variance and consumption are not views', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const off = new Backoffice(c.cloud.pool, true, {});
    const range = { start_date: today(), end_date: today() };
    for (const view of ['variance', 'consumption']) {
      // Stock v2 off: the cloud lane answer, the view is not there at all.
      await assert.rejects(
        off.ops(manager.token, c.branch, 'stock', { view, ...range }),
        is('NOT_FOUND', 'STOCK_V2_DISABLED'),
      );
      // Stock v2 on without stock P1: the cloud lane query refuses the view.
      await assert.rejects(
        readStockOps(c.cloud.pool, c.branch, { view, ...range }, new Date()),
        is('INVALID_REQUEST', undefined),
      );
    }
    // The ingredient fields of step 8 need stock P1 like the quick waste tile.
    await assert.rejects(
      ingredient(off, manager.token, c, 'Синтетическая булка', 'pcs', { count_daily: true }),
      is('INVALID_REQUEST', undefined),
    );
    await assert.rejects(
      ingredient(off, manager.token, c, 'Синтетическая булка', 'pcs', { group: 'raw' }),
      is('INVALID_REQUEST', undefined),
    );
  }));

test('view=variance: every count of the window, the last expected and counted, shortage and surplus', () =>
  withSyncDatabases(async (c) => {
    const { manager, shift } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, V2);
    const bun = await ingredient(bo, manager.token, c, 'Синтетическая булка', 'pcs', {
      count_daily: true,
      group: 'semi',
    });
    const fillet = await ingredient(bo, manager.token, c, 'Синтетическое филе', 'g', {
      group: 'raw',
    });
    const record = (await bo.read(manager.token, c.branch)).records.find((r) => r.id === bun);
    assert.equal(record.payload.count_daily, true);
    assert.equal(record.payload.group, 'semi');
    await stock(bo, manager.token, c, 'receipt', [
      [bun, '10', '1000'],
      [fillet, '5000', '25000'],
    ]);
    // A shift manager counts: two buns short, the fillet as expected; later one bun found.
    await stock(bo, shift.token, c, 'count', [
      [bun, '8'],
      [fillet, '5000'],
    ]);
    await stock(bo, shift.token, c, 'count', [[bun, '9']], { reference: 'SYN-count-2' });
    const moves = await countMovements(c);
    assert.equal(moves.length, 3);
    const value = (rows) => rows.reduce((n, r) => n + BigInt(r.value_delta_minor), 0n);
    const short = moves.filter((m) => BigInt(m.value_delta_minor) < 0n);
    const surplus = moves.filter((m) => BigInt(m.value_delta_minor) > 0n);
    assert.equal(short.length, 1);
    assert.equal(surplus.length, 1);

    const r = await bo.ops(manager.token, c.branch, 'stock', {
      view: 'variance',
      start_date: today(),
      end_date: today(),
    });
    assert.equal(r.view, 'variance');
    assert.deepEqual(r.totals, {
      documents: 2,
      items: 2,
      lines_with_difference: 2,
      shortage_value_minor: (-value(short)).toString(),
      surplus_value_minor: value(surplus).toString(),
      delta_value_minor: value(moves).toString(),
    });
    // Rows: the biggest shortage first; the bun shows its last count (8 expected, 9 counted).
    assert.deepEqual(
      r.summary.rows.map((row) => [
        row.name,
        row.unit,
        row.counts,
        row.expected,
        row.counted,
        row.delta_quantity,
      ]),
      [
        ['Синтетическая булка', 'pcs', 2, '8', '9', '-1'],
        ['Синтетическое филе', 'g', 1, '5000', '5000', '0'],
      ],
    );
    assert.equal(
      r.summary.rows[0].delta_value_minor,
      value(moves.filter((m) => m.ingredient_id === bun)).toString(),
    );
    assert.equal(typeof r.summary.rows[0].last_counted_at, 'string');
    assert.deepEqual(
      r.summary.by_day.map((d) => [d.day, d.documents, d.items, d.lines_with_difference]),
      [[today(), 2, 2, 2]],
    );
    assert.deepEqual(
      r.documents.map((d) => [d.kind, d.reference, d.lines.length]),
      [
        ['count', 'SYN-count-2', 1],
        ['count', 'SYN-count', 2],
      ],
    );
    // An empty window is zeros, not nulls.
    const empty = await bo.ops(manager.token, c.branch, 'stock', {
      view: 'variance',
      start_date: '2026-01-01',
      end_date: '2026-01-07',
    });
    assert.deepEqual(empty.totals, {
      documents: 0,
      items: 0,
      lines_with_difference: 0,
      shortage_value_minor: '0',
      surplus_value_minor: '0',
      delta_value_minor: '0',
    });
    assert.deepEqual([empty.summary.rows, empty.summary.by_day, empty.documents], [[], [], []]);
  }));

test('view=consumption: automatic consumption by source and day, net of storno on the storno day', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, V2);
    const bun = await ingredient(bo, manager.token, c, 'Синтетическая булка', 'pcs');
    await stock(bo, manager.token, c, 'receipt', [[bun, '20', '2000']]);
    const yesterday = new Date(Date.now() - 86400000);
    const first = await posConsumption(c, manager.actor_id, bun, '2', yesterday);
    const second = await posConsumption(c, manager.actor_id, bun, '3', new Date());
    // The second sale was written off by mistake: storno today.
    const now = await balances(c);
    await bo.command(
      manager.token,
      c.branch,
      request({
        type: 'stock_reverse',
        document_id: second.id,
        expected_balances: { [bun]: now[bun].revision },
      }),
    );
    // A waste is not a consumption.
    await stock(bo, manager.token, c, 'waste', [[bun, '1']], { reason_code: 'damaged' });
    const r = await bo.ops(manager.token, c.branch, 'stock', {
      view: 'consumption',
      start_date: almaty(yesterday),
      end_date: today(),
    });
    assert.equal(r.view, 'consumption');
    assert.deepEqual(r.totals, { documents: 2, value_minor: first.value, reversals: 1 });
    assert.deepEqual(r.summary.by_source, [
      { source: 'pos', documents: 2, reversals: 1, value_minor: first.value },
    ]);
    assert.deepEqual(
      r.summary.by_day,
      almaty(yesterday) === today()
        ? [{ day: today(), documents: 2, reversals: 1, value_minor: first.value }]
        : [
            { day: almaty(yesterday), documents: 1, reversals: 0, value_minor: first.value },
            { day: today(), documents: 1, reversals: 1, value_minor: '0' },
          ],
    );
    assert.deepEqual(
      r.summary.by_ingredient.map((v) => [v.name, v.quantity, v.value_minor]),
      [['Синтетическая булка', '2', first.value]],
    );
    assert.deepEqual(
      r.documents.map((d) => [d.kind, d.source_ref?.slice(0, 4) ?? null]),
      [
        ['reversal', null],
        ['consumption', 'pos:'],
        ['consumption', 'pos:'],
      ],
    );
    assert.equal(r.documents[0].reverses.kind, 'consumption');
    // The other views do not change: the waste report has only the waste, movement every kind.
    const waste = await readStockOpsP1(
      c.cloud.pool,
      c.branch,
      { view: 'waste', start_date: almaty(yesterday), end_date: today() },
      new Date(),
    );
    assert.equal(waste.totals.documents, 1);
    assert.equal(waste.totals.reversals, 0);
    const movement = await readStockOpsP1(
      c.cloud.pool,
      c.branch,
      { view: 'movement', start_date: almaty(yesterday), end_date: today() },
      new Date(),
    );
    assert.deepEqual(
      movement.summary.by_kind.map((k) => [k.kind, k.documents]),
      [
        ['consumption', 2],
        ['receipt', 1],
        ['reversal', 1],
        ['waste', 1],
      ],
    );
  }));

test('produce: a recipe marked explode is refused with stock P1, allowed with stock or no policy', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, V2);
    const off = new Backoffice(c.cloud.pool, true, {});
    const token = manager.token;
    const flour = await ingredient(bo, token, c, 'Синтетическая мука', 'g');
    const dough = await ingredient(bo, token, c, 'Синтетическое тесто', 'g');
    await stock(bo, token, c, 'receipt', [[flour, '10000', '100000']]);
    const recipe = async (stock_policy) => {
      const id = randomUUID();
      await bo.command(
        token,
        c.branch,
        request({
          type: 'save',
          kind: 'recipe',
          id,
          expected_revision: 0,
          payload: {
            name: 'Синтетическое тесто ' + (stock_policy ?? 'без политики'),
            product_id: 'ttk:syn-' + id.slice(0, 6),
            output_ingredient_id: dough,
            yield_quantity: '500',
            lines: [{ ingredient_id: flour, quantity: '400' }],
            ...(stock_policy ? { stock_policy } : {}),
          },
        }),
      );
      return id;
    };
    const produce = async (backoffice, id) => {
      const b = await balances(c);
      return backoffice.command(
        token,
        c.branch,
        request({
          type: 'produce',
          recipe_id: id,
          recipe_revision: 1,
          batches: 1,
          expected_balances: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.revision])),
          reference: 'PR-' + id.slice(0, 4),
        }),
      );
    };
    const explode = await recipe('explode');
    const before = (
      await c.cloud.pool.query(
        'SELECT count(*)::int n FROM bo_stock_documents WHERE branch_id=$1',
        [c.branch],
      )
    ).rows[0].n;
    await assert.rejects(produce(bo, explode), is('INVALID_REQUEST', 'RECIPE_POLICY_EXPLODE'));
    assert.equal(
      (
        await c.cloud.pool.query(
          'SELECT count(*)::int n FROM bo_stock_documents WHERE branch_id=$1',
          [c.branch],
        )
      ).rows[0].n,
      before,
    );
    assert.equal((await produce(bo, await recipe('stock'))).kind, 'production');
    assert.equal((await produce(bo, await recipe(undefined))).kind, 'production');
    // Stock P1 rolled back (flag off): the cloud lane rule, production is allowed again.
    assert.equal((await produce(off, explode)).kind, 'production');
  }));

test('manager shift: the key count follows the count_daily positions of the day', () =>
  withSyncDatabases(async (c) => {
    const { manager, shift } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, { ...V2, managerShiftsEnabled: true });
    const view = async () =>
      (await bo.ops(manager.token, c.branch, 'manager-shifts', {})).checks.key_count;
    // No key positions: as before, any count of the day.
    const fries = await ingredient(bo, manager.token, c, 'Синтетический фри', 'g');
    assert.deepEqual(await view(), {
      status: 'no_data',
      facts: { documents: 0, items: 0, last_at: null },
    });
    const bun = await ingredient(bo, manager.token, c, 'Синтетическая булка', 'pcs', {
      count_daily: true,
    });
    const meat = await ingredient(bo, manager.token, c, 'Синтетическое мясо', 'g', {
      count_daily: true,
    });
    // An unused key position is not asked for.
    await ingredient(bo, manager.token, c, 'Синтетика не в работе', 'pcs', { active: false });
    await stock(bo, manager.token, c, 'receipt', [
      [bun, '10', '1000'],
      [meat, '1000', '5000'],
      [fries, '1000', '1000'],
    ]);
    let check = await view();
    assert.equal(check.status, 'problem');
    assert.deepEqual(
      [check.facts.key_items, check.facts.key_counted, check.facts.key_missing_count],
      [2, 0, 2],
    );
    assert.deepEqual(check.facts.key_missing, ['Синтетическая булка', 'Синтетическое мясо']);
    // A count of other positions does not close it.
    await stock(bo, shift.token, c, 'count', [
      [fries, '900'],
      [bun, '10'],
    ]);
    check = await view();
    assert.equal(check.status, 'problem');
    assert.deepEqual(check.facts.key_missing, ['Синтетическое мясо']);
    await stock(bo, shift.token, c, 'count', [[meat, '950']], { reference: 'Подсчёт на закрытии' });
    check = await view();
    assert.equal(check.status, 'ok');
    assert.deepEqual(
      [
        check.facts.documents,
        check.facts.key_items,
        check.facts.key_counted,
        check.facts.key_missing,
      ],
      [2, 2, 2, []],
    );
  }));
