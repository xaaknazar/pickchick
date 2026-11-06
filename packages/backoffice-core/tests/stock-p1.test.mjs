import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@pickchick/database';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import {
  BACKOFFICE_P1_PERMISSIONS,
  BACKOFFICE_PERMISSIONS,
  Backoffice,
  BackofficeError,
  Command,
  IngredientP1,
  P1Request,
  P1_ROLE_PERMISSIONS,
  QuickWasteSchema,
  REVERSIBLE_KINDS,
  Request,
  can,
  designateBackoffice,
  grantBackoffice,
  permissionsOf,
  readStockOps,
  readStockOpsP1,
} from '../dist/index.js';
import { backofficeGrants } from '../../../infra/staging/backoffice-grants.mjs';
import { backofficeP1Grants } from '../../../infra/staging/backoffice-p1-grants.mjs';

/**
 * Stock P1 of lane bo-ui (stock-p1.ts; design-bo-ui.md 2, 5.2, 5.4): storno of a whole document,
 * quick waste tiles of the ingredient card, counted_at of a count, the waste report net of storno,
 * capabilities.stock_p1 and the P1 permission stock.reverse. Everything behind the existing
 * BACKOFFICE_STOCK_V2_ENABLED and cloud075 with its rights; synthetic data only.
 */
const MIGRATIONS = fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url));
const is = (code, reason) => (error) =>
  error instanceof BackofficeError && error.code === code && error.reason === reason;
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date());
const request = (command, reason = 'Синтетическая проверка склада P1') => ({
  request_id: randomUUID(),
  reason,
  command,
});
const V2 = { stockV2Enabled: true, rolesEnabled: true };

// ------------------------------------------------------------------------------ pure ----

test('P1 schemas: storno and quick waste are strict, the shared Command never takes them', () => {
  const reverse = {
    type: 'stock_reverse',
    document_id: randomUUID(),
    expected_balances: { [randomUUID()]: 3 },
  };
  const envelope = { request_id: randomUUID(), reason: 'Ошибочный документ', command: reverse };
  assert.deepEqual(P1Request.parse(envelope), envelope);
  assert.equal(Command.safeParse(reverse).success, false);
  assert.equal(Request.safeParse(envelope).success, false);
  for (const bad of [
    { ...reverse, document_id: 'x' },
    { ...reverse, expected_balances: { x: 1 } },
    { ...reverse, expected_balances: { [randomUUID()]: -1 } },
    { ...reverse, extra: true },
    { type: 'stock_reverse', document_id: randomUUID() },
  ])
    assert.equal(P1Request.safeParse({ ...envelope, command: bad }).success, false);
  assert.equal(P1Request.safeParse({ ...envelope, reason: 'ok' }).success, false);
  assert.deepEqual(QuickWasteSchema.parse({ label: '  Фингерсы из шкафа ', quantity: '5' }), {
    label: 'Фингерсы из шкафа',
    quantity: '5',
  });
  for (const bad of [
    { label: '', quantity: '5' },
    { label: 'я'.repeat(41), quantity: '5' },
    { label: 'Фри', quantity: '0' },
    { label: 'Фри', quantity: '1.5' },
    { label: 'Фри', quantity: 5 },
    { label: 'Фри', quantity: '5', color: 'red' },
  ])
    assert.equal(QuickWasteSchema.safeParse(bad).success, false, JSON.stringify(bad));
  const ingredient = { name: 'Синтетические фингерсы', unit: 'pcs', minimum: '0', active: true };
  assert.deepEqual(IngredientP1.parse(ingredient), ingredient);
  assert.equal(
    IngredientP1.safeParse({ ...ingredient, quick_waste: { label: 'Фингерсы', quantity: '5' } })
      .success,
    true,
  );
  assert.equal(IngredientP1.safeParse({ ...ingredient, count_daily: true }).success, false);
  assert.deepEqual([...REVERSIBLE_KINDS], ['receipt', 'waste', 'production', 'consumption']);
});

test('P1 permission: storno by the manager and the accountant, listed only when asked for', () => {
  assert.deepEqual([...BACKOFFICE_P1_PERMISSIONS], ['stock.reverse']);
  assert.equal(BACKOFFICE_PERMISSIONS.includes('stock.reverse'), false);
  assert.deepEqual(
    Object.fromEntries(
      ['manager', 'shift_manager', 'accountant', 'analyst'].map((r) => [
        r,
        can(r, 'stock.reverse'),
      ]),
    ),
    { manager: true, shift_manager: false, accountant: true, analyst: false },
  );
  assert.deepEqual([...P1_ROLE_PERMISSIONS.accountant], ['stock.reverse']);
  // Without P1 features permissions[] is the cloud lane's list.
  assert.deepEqual(permissionsOf('manager'), [...BACKOFFICE_PERMISSIONS]);
  assert.deepEqual(permissionsOf('manager', ['stock.reverse']), [
    ...BACKOFFICE_PERMISSIONS,
    'stock.reverse',
  ]);
  assert.deepEqual(permissionsOf('accountant', ['stock.reverse']), [
    ...permissionsOf('accountant'),
    'stock.reverse',
  ]);
  assert.deepEqual(
    permissionsOf('shift_manager', ['stock.reverse']),
    permissionsOf('shift_manager'),
  );
  assert.deepEqual(permissionsOf('analyst', ['stock.reverse']), permissionsOf('analyst'));
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
  const accountant = await person(c, 'Синтетический бухгалтер', 'analyst');
  const shift = await person(c, 'Синтетический начальник смены', 'analyst');
  const analyst = await person(c, 'Синтетический аналитик', 'analyst');
  await designateBackoffice(
    c.cloud.pool,
    accountant.actor_id,
    c.branch,
    'accountant',
    'Т7: назначение',
  );
  await designateBackoffice(
    c.cloud.pool,
    shift.actor_id,
    c.branch,
    'shift_manager',
    'Т7: назначение',
  );
  return { manager, accountant, shift, analyst };
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
  // counted_at exists from cloud075 on; on an older schema the rows simply have none.
  const counted = (
    await c.cloud.pool.query(
      "SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('bo_stock_balances') AND attname='counted_at') ok",
    )
  ).rows[0].ok;
  return Object.fromEntries(
    (
      await c.cloud.pool.query(
        `SELECT ingredient_id,quantity::text,value_minor::text,revision${counted ? ',counted_at' : ''} FROM bo_stock_balances WHERE branch_id=$1`,
        [c.branch],
      )
    ).rows.map((r) => [r.ingredient_id, r]),
  );
}
async function revisions(c) {
  return Object.fromEntries(Object.entries(await balances(c)).map(([id, b]) => [id, b.revision]));
}
/** One stock document through the command; lines are [ingredient, quantity, value]. */
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
const reverse = async (c, document_id) =>
  request({ type: 'stock_reverse', document_id, expected_balances: await revisions(c) });
const counts = async (c) =>
  (
    await c.cloud.pool.query(
      `SELECT (SELECT count(*)::int FROM bo_stock_documents) documents,
         (SELECT count(*)::int FROM bo_stock_movements) movements,
         (SELECT count(*)::int FROM bo_audit) audit,
         (SELECT count(*)::int FROM bo_commands) commands`,
    )
  ).rows[0];
const D0_DOCUMENT_KEYS = [
  'id',
  'kind',
  'reference',
  'reason',
  'order_id',
  'created_at',
  'actor_id',
  'actor_name',
  'lines',
];
const P1_DOCUMENT_KEYS = [
  ...D0_DOCUMENT_KEYS,
  'reason_code',
  'meta',
  'source_ref',
  'reverses_document_id',
  'reversed_by',
  'reversed_at',
  'reverses',
];

test('flag off: no stock_p1, storno is an unknown command, quick waste is refused, counts leave counted_at', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    for (const options of [{}, { rolesEnabled: true }]) {
      const off = new Backoffice(c.cloud.pool, true, options);
      const suffix = options.rolesEnabled ? ' 2' : ' 1';
      const bun = await ingredient(off, manager.token, c, 'Синтетическая булка' + suffix, 'pcs');
      const receipt = await stock(off, manager.token, c, 'receipt', [[bun, '10', '10000']]);
      await stock(off, manager.token, c, 'count', [[bun, '9']]);
      assert.equal((await balances(c))[bun].counted_at, null);
      const before = await counts(c);
      await assert.rejects(
        off.command(manager.token, c.branch, await reverse(c, receipt.id)),
        is('INVALID_REQUEST', undefined),
      );
      await assert.rejects(
        ingredient(off, manager.token, c, 'Синтетический фри' + suffix, 'g', {
          quick_waste: { label: 'Фри', quantity: '150' },
        }),
        is('INVALID_REQUEST', undefined),
      );
      assert.deepEqual(await counts(c), before);
      const state = await off.read(manager.token, c.branch);
      assert.equal('stock_p1' in state.capabilities, false);
      assert.deepEqual(Object.keys(state.stock[0]), [
        'id',
        'payload',
        'quantity',
        'value_minor',
        'revision',
      ]);
      assert.deepEqual(Object.keys(state.documents[0]), D0_DOCUMENT_KEYS);
      if (options.rolesEnabled) assert.deepEqual(state.permissions, [...BACKOFFICE_PERMISSIONS]);
    }
  }));

test('stock v2 without 075: the cloud lane answers, storno is NOT_READY, quick waste refused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-cloud-074-p1-'));
  try {
    for (const file of await readdir(MIGRATIONS))
      if (/^\d{3}_[a-z_]+\.sql$/.test(file) && file < '075')
        await cp(join(MIGRATIONS, file), join(directory, file));
    await withSyncDatabases(
      async (c) => {
        const { manager } = await people(c);
        const v2 = new Backoffice(c.cloud.pool, true, V2);
        const bun = await ingredient(v2, manager.token, c, 'Синтетическая булка', 'pcs');
        const receipt = await stock(v2, manager.token, c, 'receipt', [[bun, '10', '10000']]);
        await stock(v2, manager.token, c, 'count', [[bun, '9']]);
        await assert.rejects(
          v2.command(manager.token, c.branch, await reverse(c, receipt.id)),
          is('NOT_READY', 'STOCK_V2_DISABLED'),
        );
        await assert.rejects(
          ingredient(v2, manager.token, c, 'Синтетический фри', 'g', {
            quick_waste: { label: 'Фри', quantity: '150' },
          }),
          is('INVALID_REQUEST', undefined),
        );
        const state = await v2.read(manager.token, c.branch);
        assert.equal(state.capabilities.stock_v2, true);
        assert.equal('stock_p1' in state.capabilities, false);
        assert.deepEqual(state.permissions, [...BACKOFFICE_PERMISSIONS]);
        assert.deepEqual(Object.keys(state.documents[0]), D0_DOCUMENT_KEYS);
        const report = await v2.ops(manager.token, c.branch, 'stock', {
          view: 'movement',
          start_date: today(),
          end_date: today(),
        });
        assert.equal('reversed_by' in report.documents[0], false);
      },
      { cloudMigrationDirectory: directory },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('storno: exact opposite movements, once per document, never below zero, roles, idempotency', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, V2);
    const token = p.manager.token;
    const fillet = await ingredient(bo, token, c, 'Синтетическое филе', 'g');
    const bun = await ingredient(bo, token, c, 'Синтетическая булка', 'pcs');
    const state0 = await bo.read(token, c.branch);
    assert.equal(state0.capabilities.stock_p1, true);
    assert.equal(Object.keys(state0.capabilities).at(-1), 'stock_p1');
    assert.deepEqual(state0.permissions, [...BACKOFFICE_PERMISSIONS, 'stock.reverse']);
    assert.deepEqual((await bo.read(p.accountant.token, c.branch)).permissions, [
      ...permissionsOf('accountant'),
      'stock.reverse',
    ]);
    assert.deepEqual(
      (await bo.read(p.shift.token, c.branch)).permissions,
      permissionsOf('shift_manager'),
    );

    // A receipt of two lines is reversed by one document with exactly opposite movements.
    const r1 = await stock(
      bo,
      token,
      c,
      'receipt',
      [
        [fillet, '5000', '500000'],
        [bun, '40', '40000'],
      ],
      { reference: 'NAK-1' },
    );
    const storno = await reverse(c, r1.id);
    const result = await bo.command(token, c.branch, storno);
    assert.deepEqual(Object.keys(result), ['id', 'kind', 'reference', 'reverses_document_id']);
    assert.deepEqual(
      { ...result, id: null },
      { id: null, kind: 'reversal', reference: 'NAK-1', reverses_document_id: r1.id },
    );
    let b = await balances(c);
    assert.deepEqual(
      [b[fillet].quantity, b[fillet].value_minor, b[bun].quantity, b[bun].value_minor],
      ['0', '0', '0', '0'],
    );
    const moves = async (id) =>
      (
        await c.cloud.pool.query(
          'SELECT ingredient_id,quantity_delta::text,value_delta_minor::text,balance_after::text,value_after_minor::text FROM bo_stock_movements WHERE document_id=$1 ORDER BY ingredient_id',
          [id],
        )
      ).rows;
    const original = await moves(r1.id);
    assert.deepEqual(
      (await moves(result.id)).map((m) => [m.ingredient_id, m.quantity_delta, m.value_delta_minor]),
      original.map((m) => [m.ingredient_id, '-' + m.quantity_delta, '-' + m.value_delta_minor]),
    );
    const row = (
      await c.cloud.pool.query(
        'SELECT kind,reference,reason,reverses_document_id,reason_code,order_id,actor_id FROM bo_stock_documents WHERE id=$1',
        [result.id],
      )
    ).rows[0];
    assert.deepEqual(row, {
      kind: 'reversal',
      reference: 'NAK-1',
      reason: 'Синтетическая проверка склада P1',
      reverses_document_id: r1.id,
      reason_code: null,
      order_id: null,
      actor_id: p.manager.actor_id,
    });
    // The original stays in history; both are in GET branches/:id with their links.
    const listed = (await bo.read(token, c.branch)).documents;
    assert.deepEqual(Object.keys(listed[0]), P1_DOCUMENT_KEYS);
    const r1Listed = listed.find((d) => d.id === r1.id);
    const stornoListed = listed.find((d) => d.id === result.id);
    assert.equal(r1Listed.reversed_by, result.id);
    assert.ok(r1Listed.reversed_at instanceof Date);
    assert.equal(r1Listed.reverses, null);
    assert.equal(stornoListed.reversed_by, null);
    assert.equal(stornoListed.reverses_document_id, r1.id);
    assert.deepEqual(
      { ...stornoListed.reverses, created_at: typeof stornoListed.reverses.created_at },
      { kind: 'receipt', reference: 'NAK-1', reason_code: null, created_at: 'string' },
    );
    assert.ok(
      Math.abs(Date.parse(stornoListed.reverses.created_at) - r1Listed.created_at.getTime()) <= 1,
    );
    // Audit and the exact replay.
    const audit = (
      await c.cloud.pool.query(
        "SELECT action,entity_id,reason,actor_id FROM bo_audit WHERE action='stock_reverse'",
      )
    ).rows;
    assert.deepEqual(audit, [
      {
        action: 'stock_reverse',
        entity_id: result.id,
        reason: 'Синтетическая проверка склада P1',
        actor_id: p.manager.actor_id,
      },
    ]);
    const settled = await counts(c);
    assert.deepEqual(await bo.command(token, c.branch, storno), result);
    assert.deepEqual(await counts(c), settled);
    await assert.rejects(
      bo.command(token, c.branch, { ...storno, reason: 'Другая причина того же запроса' }),
      is('CONFLICT', undefined),
    );
    // Once per document; a storno and a count are never reversed.
    await assert.rejects(
      bo.command(token, c.branch, await reverse(c, r1.id)),
      is('CONFLICT', 'ALREADY_REVERSED'),
    );
    await assert.rejects(
      bo.command(token, c.branch, await reverse(c, result.id)),
      is('INVALID_REQUEST', 'REVERSAL_NOT_ALLOWED'),
    );
    const count = await stock(bo, token, c, 'count', [[bun, '0']]);
    await assert.rejects(
      bo.command(token, c.branch, await reverse(c, count.id)),
      is('INVALID_REQUEST', 'REVERSAL_NOT_ALLOWED'),
    );
    await assert.rejects(
      bo.command(token, c.branch, await reverse(c, randomUUID())),
      is('NOT_FOUND', undefined),
    );
    // A document of another branch is not found here.
    const other = randomUUID();
    await c.cloud.pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,'SYN2','Synthetic 2')",
      [other, c.org, c.legal],
    );
    const foreign = randomUUID();
    await c.cloud.pool.query(
      "INSERT INTO bo_stock_documents(id,branch_id,actor_id,kind,reference,reason) VALUES($1,$2,$3,'receipt','X','Синтетический чужой документ')",
      [foreign, other, p.manager.actor_id],
    );
    await assert.rejects(
      bo.command(token, c.branch, await reverse(c, foreign)),
      is('NOT_FOUND', undefined),
    );
    assert.equal((await counts(c)).documents, settled.documents + 2);

    // Never below zero: a received item that was partly wasted cannot be reversed; the waste
    // first, then the receipt.
    const r2 = await stock(bo, token, c, 'receipt', [[bun, '10', '10000']], { reference: 'NAK-2' });
    const w1 = await stock(bo, token, c, 'waste', [[bun, '8']], { reason_code: 'defect' });
    let before = await counts(c);
    await assert.rejects(
      bo.command(token, c.branch, await reverse(c, r2.id)),
      is('INSUFFICIENT_STOCK', undefined),
    );
    assert.deepEqual(await counts(c), before);
    // A stale balance revision is a CONFLICT, nothing is written.
    const stale = await reverse(c, w1.id);
    stale.command.expected_balances[bun] -= 1;
    await assert.rejects(bo.command(token, c.branch, stale), is('CONFLICT', undefined));
    const missing = await reverse(c, w1.id);
    delete missing.command.expected_balances[bun];
    await assert.rejects(bo.command(token, c.branch, missing), is('CONFLICT', undefined));
    assert.deepEqual(await counts(c), before);
    await bo.command(token, c.branch, await reverse(c, w1.id));
    b = await balances(c);
    assert.deepEqual([b[bun].quantity, b[bun].value_minor], ['10', '10000']);
    await bo.command(token, c.branch, await reverse(c, r2.id));
    b = await balances(c);
    assert.deepEqual([b[bun].quantity, b[bun].value_minor], ['0', '0']);

    // The moving average: after a later receipt and a waste the exact opposite of either receipt
    // would leave no quantity with a value (or a negative value): refused, not rounded away.
    const r4 = await stock(bo, token, c, 'receipt', [[bun, '10', '1000']], { reference: 'NAK-4' });
    const r5 = await stock(bo, token, c, 'receipt', [[bun, '10', '3000']], { reference: 'NAK-5' });
    await stock(bo, token, c, 'waste', [[bun, '10']], { reason_code: 'other' });
    b = await balances(c);
    assert.deepEqual([b[bun].quantity, b[bun].value_minor], ['10', '2000']);
    before = await counts(c);
    for (const id of [r4.id, r5.id])
      await assert.rejects(
        bo.command(token, c.branch, await reverse(c, id)),
        is('INSUFFICIENT_STOCK', undefined),
      );
    assert.deepEqual(await counts(c), before);

    // A count after the document holds the physical truth: no storno (COUNTED_AFTER_DOCUMENT).
    const r3 = await stock(bo, token, c, 'receipt', [[fillet, '1000', '100000']]);
    const fCount = await stock(bo, token, c, 'count', [[fillet, '900']]);
    await assert.rejects(
      bo.command(token, c.branch, await reverse(c, r3.id)),
      is('CONFLICT', 'COUNTED_AFTER_DOCUMENT'),
    );
    const countedAt = (
      await c.cloud.pool.query('SELECT created_at FROM bo_stock_documents WHERE id=$1', [fCount.id])
    ).rows[0].created_at;
    assert.equal((await balances(c))[fillet].counted_at.getTime(), countedAt.getTime());

    // Production: the output goes back out, the raw materials come back.
    const flour = await ingredient(bo, token, c, 'Синтетическая мука', 'g');
    const dough = await ingredient(bo, token, c, 'Синтетическое тесто', 'g');
    await stock(bo, token, c, 'receipt', [[flour, '1000', '10000']]);
    const recipe = randomUUID();
    await bo.command(
      token,
      c.branch,
      request({
        type: 'save',
        kind: 'recipe',
        id: recipe,
        expected_revision: 0,
        payload: {
          name: 'Синтетическое тесто',
          product_id: 'ttk:syn-1',
          output_ingredient_id: dough,
          yield_quantity: '500',
          lines: [{ ingredient_id: flour, quantity: '400' }],
        },
      }),
    );
    const produced = await bo.command(
      token,
      c.branch,
      request({
        type: 'produce',
        recipe_id: recipe,
        recipe_revision: 1,
        batches: 2,
        expected_balances: await revisions(c),
        reference: 'PR-1',
      }),
    );
    b = await balances(c);
    assert.deepEqual(
      [b[flour].quantity, b[flour].value_minor, b[dough].quantity, b[dough].value_minor],
      ['200', '2000', '1000', '8000'],
    );
    await bo.command(token, c.branch, await reverse(c, produced.id));
    b = await balances(c);
    assert.deepEqual(
      [b[flour].quantity, b[flour].value_minor, b[dough].quantity, b[dough].value_minor],
      ['1000', '10000', '0', '0'],
    );

    // Roles: the accountant reverses, the shift manager and the analyst do not.
    const r6 = await stock(bo, token, c, 'receipt', [[flour, '100', '1000']], {
      reference: 'NAK-6',
    });
    before = await counts(c);
    await assert.rejects(
      bo.command(p.shift.token, c.branch, await reverse(c, r6.id)),
      is('FORBIDDEN', 'ROLE_FORBIDDEN'),
    );
    await assert.rejects(
      bo.command(p.analyst.token, c.branch, await reverse(c, r6.id)),
      is('FORBIDDEN', undefined),
    );
    assert.deepEqual(await counts(c), before);
    const byAccountant = await bo.command(p.accountant.token, c.branch, await reverse(c, r6.id));
    assert.equal(byAccountant.reverses_document_id, r6.id);
    // Without BACKOFFICE_ROLES_ENABLED the grant decides: the manager reverses, an analyst not.
    const noRoles = new Backoffice(c.cloud.pool, true, { stockV2Enabled: true });
    const r7 = await stock(noRoles, token, c, 'receipt', [[flour, '100', '1000']]);
    await assert.rejects(
      noRoles.command(p.accountant.token, c.branch, await reverse(c, r7.id)),
      is('FORBIDDEN', undefined),
    );
    await noRoles.command(token, c.branch, await reverse(c, r7.id));
    assert.equal('permissions' in (await noRoles.read(token, c.branch)), false);
  }));

test('quick waste tile and counted_at: stored with stock P1, a count moves counted_at forward only', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, V2);
    const fingers = await ingredient(bo, manager.token, c, 'Синтетические фингерсы', 'pcs', {
      quick_waste: { label: ' Фингерсы из шкафа ', quantity: '5' },
    });
    const fries = await ingredient(bo, manager.token, c, 'Синтетический фри', 'g');
    const record = (await bo.read(manager.token, c.branch)).records.find((r) => r.id === fingers);
    assert.deepEqual(record.payload.quick_waste, { label: 'Фингерсы из шкафа', quantity: '5' });
    for (const quick_waste of [
      { label: '', quantity: '5' },
      { label: 'Фингерсы', quantity: '0' },
      { label: 'Фингерсы', quantity: '5', extra: 1 },
    ])
      await assert.rejects(
        ingredient(bo, manager.token, c, 'Синтетика ' + randomUUID().slice(0, 4), 'pcs', {
          quick_waste,
        }),
        is('INVALID_REQUEST', undefined),
      );
    // Removing the tile is a save without the key.
    await bo.command(
      manager.token,
      c.branch,
      request({
        type: 'save',
        kind: 'ingredient',
        id: fries,
        expected_revision: 1,
        payload: {
          name: 'Синтетический фри',
          unit: 'g',
          minimum: '0',
          active: true,
          quick_waste: { label: 'Фри', quantity: '150' },
        },
      }),
    );
    await bo.command(
      manager.token,
      c.branch,
      request({
        type: 'save',
        kind: 'ingredient',
        id: fries,
        expected_revision: 2,
        payload: { name: 'Синтетический фри', unit: 'g', minimum: '0', active: true },
      }),
    );
    assert.equal(
      'quick_waste' in
        (await bo.read(manager.token, c.branch)).records.find((r) => r.id === fries).payload,
      false,
    );

    await stock(bo, manager.token, c, 'receipt', [
      [fingers, '50', '50000'],
      [fries, '3000', '30000'],
    ]);
    let b = await balances(c);
    assert.equal(b[fingers].counted_at, null);
    const first = await stock(bo, manager.token, c, 'count', [[fingers, '48']]);
    b = await balances(c);
    const at = async (id) =>
      (await c.cloud.pool.query('SELECT created_at FROM bo_stock_documents WHERE id=$1', [id]))
        .rows[0].created_at;
    assert.equal(b[fingers].counted_at.getTime(), (await at(first.id)).getTime());
    assert.equal(b[fries].counted_at, null, 'only the counted ingredients');
    const revisionAfterCount = b[fingers].revision;
    // A waste or a receipt does not move it; a later count does.
    await stock(bo, manager.token, c, 'waste', [[fingers, '5']], {
      reason_code: 'hot_cabinet_expired',
    });
    b = await balances(c);
    assert.equal(b[fingers].counted_at.getTime(), (await at(first.id)).getTime());
    assert.equal(b[fingers].revision, revisionAfterCount + 1);
    const second = await stock(bo, manager.token, c, 'count', [
      [fingers, '43'],
      [fries, '2900'],
    ]);
    b = await balances(c);
    assert.equal(b[fingers].counted_at.getTime(), (await at(second.id)).getTime());
    assert.equal(b[fries].counted_at.getTime(), (await at(second.id)).getTime());
    // GET branches/:id reports it per stock row (after the cloud lane keys).
    const state = await bo.read(manager.token, c.branch);
    const row = state.stock.find((r) => r.id === fingers);
    assert.deepEqual(Object.keys(row), [
      'id',
      'payload',
      'quantity',
      'value_minor',
      'revision',
      'counted_at',
    ]);
    assert.equal(row.counted_at.getTime(), (await at(second.id)).getTime());
    // The trigger keeps it from moving back even for the owner.
    await assert.rejects(
      c.cloud.pool.query(
        "UPDATE bo_stock_balances SET counted_at=counted_at - interval '1 hour' WHERE ingredient_id=$1",
        [fingers],
      ),
      { code: '23514' },
    );
  }));

test('without storno the P1 report is the cloud lane report plus zero storno counts and null links', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, V2);
    const off = new Backoffice(c.cloud.pool, true, {});
    const token = manager.token;
    const bun = await ingredient(bo, token, c, 'Синтетическая булка', 'pcs');
    const fillet = await ingredient(bo, token, c, 'Синтетическое филе', 'g');
    await stock(bo, token, c, 'receipt', [
      [bun, '30', '30000'],
      [fillet, '2000', '200000'],
    ]);
    await stock(off, token, c, 'waste', [[bun, '2']]);
    await stock(bo, token, c, 'waste', [[bun, '3']], { reason_code: 'defect' });
    await stock(bo, token, c, 'waste', [[fillet, '150']], { reason_code: 'meat_expired' });
    await stock(bo, token, c, 'count', [[fillet, '1800']]);
    const now = new Date();
    for (const view of ['waste', 'movement']) {
      const input = { view, start_date: today(), end_date: today() };
      const lane = await readStockOps(c.cloud.pool, c.branch, input, now);
      const p1 = await readStockOpsP1(c.cloud.pool, c.branch, input, now);
      const zero = (row) => {
        if (view !== 'waste') return row;
        assert.equal(row.reversals, 0);
        const copy = { ...row };
        delete copy.reversals;
        return copy;
      };
      const stripped = {
        ...p1,
        totals: zero(p1.totals),
        summary: Object.fromEntries(
          Object.entries(p1.summary).map(([key, rows]) => [
            key,
            key === 'by_ingredient' ? rows : rows.map(zero),
          ]),
        ),
        documents: p1.documents.map((d) => {
          const copy = { ...d };
          for (const key of [
            'source_ref',
            'reverses_document_id',
            'reversed_by',
            'reversed_at',
            'reverses',
          ]) {
            assert.equal(copy[key], null, key);
            delete copy[key];
          }
          return copy;
        }),
      };
      assert.deepEqual(stripped, lane, view);
    }
    // ops/stock answers the P1 report while stock_p1 is there.
    const served = await bo.ops(token, c.branch, 'stock', {
      view: 'waste',
      start_date: today(),
      end_date: today(),
    });
    assert.equal(served.totals.reversals, 0);
  }));

test('concurrent storno of one document: exactly one reversal, the other is ALREADY_REVERSED', () =>
  withSyncDatabases(async (c) => {
    const { manager, accountant } = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, V2);
    const bun = await ingredient(bo, manager.token, c, 'Синтетическая булка', 'pcs');
    const receipt = await stock(bo, manager.token, c, 'receipt', [[bun, '10', '10000']]);
    const results = await Promise.allSettled([
      bo.command(manager.token, c.branch, await reverse(c, receipt.id)),
      bo.command(accountant.token, c.branch, await reverse(c, receipt.id)),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const failed = results.find((r) => r.status === 'rejected');
    assert.ok(is('CONFLICT', 'ALREADY_REVERSED')(failed.reason), String(failed.reason));
    const rows = (
      await c.cloud.pool.query(
        "SELECT count(*)::int n FROM bo_stock_documents WHERE kind='reversal' AND reverses_document_id=$1",
        [receipt.id],
      )
    ).rows[0];
    assert.equal(rows.n, 1);
    const b = (await balances(c))[bun];
    assert.deepEqual([b.quantity, b.value_minor], ['0', '0']);
  }));

/** A waste written as the 074 runtime would have, on an earlier Almaty day (raw owner rows). */
async function pastWaste(c, actor, ingredient, quantity, at, reason_code) {
  const b = (
    await c.cloud.pool.query(
      'SELECT quantity,value_minor FROM bo_stock_balances WHERE branch_id=$1 AND ingredient_id=$2',
      [c.branch, ingredient],
    )
  ).rows[0];
  const q = BigInt(b.quantity),
    v = BigInt(b.value_minor),
    n = BigInt(quantity),
    dv = (v * -n) / q;
  const id = randomUUID();
  await c.cloud.pool.query(
    "INSERT INTO bo_stock_documents(id,branch_id,actor_id,kind,reference,reason,reason_code,created_at) VALUES($1,$2,$3,'waste','W-PAST','Синтетическое списание прошлого дня',$4,$5)",
    [id, c.branch, actor, reason_code, at],
  );
  await c.cloud.pool.query(
    'INSERT INTO bo_stock_movements(document_id,branch_id,ingredient_id,quantity_delta,value_delta_minor,balance_after,value_after_minor) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      id,
      c.branch,
      ingredient,
      (-n).toString(),
      dv.toString(),
      (q - n).toString(),
      (v + dv).toString(),
    ],
  );
  await c.cloud.pool.query(
    'UPDATE bo_stock_balances SET quantity=$3,value_minor=$4,revision=revision+1 WHERE branch_id=$1 AND ingredient_id=$2',
    [c.branch, ingredient, (q - n).toString(), (v + dv).toString()],
  );
  return id;
}

test('waste report with storno: a negative entry on the storno day under the waste reason and author', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    const bo = new Backoffice(c.cloud.pool, true, V2);
    const off = new Backoffice(c.cloud.pool, true, {});
    const token = p.manager.token;
    const bun = await ingredient(bo, token, c, 'Синтетическая булка', 'pcs');
    const fillet = await ingredient(bo, token, c, 'Синтетическое филе', 'g');
    await stock(bo, token, c, 'receipt', [
      [bun, '100', '100000'],
      [fillet, '5000', '500000'],
    ]);
    // Yesterday (Almaty): a damaged-bun waste of 4 pcs by the manager.
    const day = today();
    const yesterday = new Date(Date.parse(`${day}T12:00:00+05:00`) - 86400000);
    const yDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(yesterday);
    const past = await pastWaste(c, p.manager.actor_id, bun, '4', yesterday, 'damaged');
    // Today: an old-style waste without a reason (cloud lane runtime with stock v2 off), two
    // wastes with reasons by the shift manager and the manager, then two storno documents by the
    // accountant: of yesterday's waste and of today's fillet waste.
    await stock(off, token, c, 'waste', [[bun, '1']]);
    await stock(bo, p.shift.token, c, 'waste', [[bun, '5']], { reason_code: 'defect' });
    const wFillet = await stock(bo, token, c, 'waste', [[fillet, '300']], {
      reason_code: 'meat_expired',
    });
    const s1 = await bo.command(p.accountant.token, c.branch, await reverse(c, past));
    const s2 = await bo.command(p.accountant.token, c.branch, await reverse(c, wFillet.id));
    // A storno of a receipt is not a waste entry.
    const rx = await stock(bo, token, c, 'receipt', [[bun, '1', '1000']]);
    await bo.command(token, c.branch, await reverse(c, rx.id));

    const report = (start, end) =>
      bo.ops(token, c.branch, 'stock', { view: 'waste', start_date: start, end_date: end });
    const todayReport = await report(day, day);
    assert.deepEqual(todayReport.totals, { documents: 3, value_minor: '2000', reversals: 2 });
    // 1 bun without a reason 1000, 5 buns defect 5000, fillet 300 g meat_expired 30000 reversed
    // (-30000), yesterday's 4 damaged buns reversed today (-4000): 2000 net.
    assert.deepEqual(
      todayReport.summary.by_reason.map((r) => [
        r.reason_code,
        r.documents,
        r.reversals,
        r.value_minor,
      ]),
      [
        ['damaged', 0, 1, '-4000'],
        ['defect', 1, 0, '5000'],
        ['meat_expired', 1, 1, '0'],
        [null, 1, 0, '1000'],
      ],
    );
    assert.deepEqual(todayReport.summary.by_day, [
      { day, documents: 3, reversals: 2, value_minor: '2000' },
    ]);
    assert.deepEqual(
      todayReport.summary.by_ingredient.map((r) => [r.name, r.quantity, r.value_minor]),
      [
        ['Синтетическая булка', '2', '2000'],
        ['Синтетическое филе', '0', '0'],
      ],
    );
    // The storno counts for the author of the waste, not for the accountant who made it.
    assert.deepEqual(
      todayReport.summary.by_author.map((r) => [
        r.actor_name,
        r.documents,
        r.reversals,
        r.value_minor,
      ]),
      [
        ['Синтетический начальник смены', 1, 0, '5000'],
        ['Синтетический управляющий', 2, 2, '-3000'],
      ],
    );
    const s1Doc = todayReport.documents.find((d) => d.id === s1.id);
    assert.equal(s1Doc.kind, 'reversal');
    assert.equal(s1Doc.reverses.kind, 'waste');
    assert.equal(s1Doc.reverses.reason_code, 'damaged');
    assert.equal(s1Doc.actor_name, 'Синтетический бухгалтер');
    const wDoc = todayReport.documents.find((d) => d.id === wFillet.id);
    assert.equal(wDoc.reversed_by, s2.id);
    assert.ok(todayReport.documents.every((d) => d.kind === 'waste' || d.kind === 'reversal'));
    assert.equal(todayReport.documents.length, 5);
    assert.deepEqual(Object.keys(todayReport.documents[0]), [
      'id',
      'kind',
      'reference',
      'reason',
      'reason_code',
      'meta',
      'order_id',
      'created_at',
      'actor_id',
      'actor_name',
      'lines',
      'source_ref',
      'reverses_document_id',
      'reversed_by',
      'reversed_at',
      'reverses',
    ]);
    // Yesterday keeps its waste; the two days add up to the period.
    const yReport = await report(yDay, yDay);
    assert.deepEqual(yReport.totals, { documents: 1, value_minor: '4000', reversals: 0 });
    assert.equal(yReport.documents[0].reversed_by, s1.id);
    const both = await report(yDay, day);
    assert.deepEqual(both.totals, { documents: 4, value_minor: '6000', reversals: 2 });
    assert.deepEqual(
      both.summary.by_reason.find((r) => r.reason_code === 'damaged'),
      { reason_code: 'damaged', documents: 1, reversals: 1, value_minor: '0' },
    );
    assert.deepEqual(
      both.summary.by_day.map((r) => [r.day, r.value_minor]),
      [
        [yDay, '4000'],
        [day, '2000'],
      ],
    );
    // The movement view lists storno documents as their own kind.
    const movement = await bo.ops(token, c.branch, 'stock', {
      view: 'movement',
      start_date: day,
      end_date: day,
    });
    assert.deepEqual(
      movement.summary.by_kind.map((r) => [r.kind, r.documents, r.value_delta_minor]),
      [
        ['receipt', 2, '601000'],
        ['reversal', 3, '33000'],
        ['waste', 3, '-36000'],
      ],
    );
    assert.equal(movement.totals.documents, 8);
    assert.equal(movement.totals.value_delta_minor, '598000');
  }));

test('least privilege: stock_p1 needs the P1 grants helper with stock v2; storno and counts as the API role', () =>
  withSyncDatabases(async (c) => {
    const { manager } = await people(c);
    const schema = c.cloud.schema;
    const role = 'bo_p1s_' + randomUUID().replaceAll('-', '');
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
      const bo = new Backoffice(pool, true, V2);
      const bun = await ingredient(bo, manager.token, c, 'Синтетическая булка', 'pcs');
      const receipt = await stock(bo, manager.token, c, 'receipt', [[bun, '10', '10000']]);
      // 075 alone (table rights of backofficeGrants) is not enough: no key, NOT_READY.
      let state = await bo.read(manager.token, c.branch);
      assert.equal('stock_p1' in state.capabilities, false);
      assert.deepEqual(state.permissions, [...BACKOFFICE_PERMISSIONS]);
      await assert.rejects(
        bo.command(manager.token, c.branch, await reverse(c, receipt.id)),
        is('NOT_READY', 'STOCK_V2_DISABLED'),
      );
      const P1 = {
        backoffice: true,
        posDay: false,
        stockV2: true,
        autoconsume: false,
        managerShifts: false,
        discounts: false,
      };
      await c.cloud.pool.query(backofficeP1Grants(role, P1, schema));
      state = await bo.read(manager.token, c.branch);
      assert.equal(state.capabilities.stock_p1, true);
      await stock(bo, manager.token, c, 'count', [[bun, '9']]);
      assert.notEqual((await balances(c))[bun].counted_at, null);
      await assert.rejects(
        bo.command(manager.token, c.branch, await reverse(c, receipt.id)),
        is('CONFLICT', 'COUNTED_AFTER_DOCUMENT'),
      );
      const second = await stock(bo, manager.token, c, 'receipt', [[bun, '5', '5000']]);
      await bo.command(manager.token, c.branch, await reverse(c, second.id));
      // The reset without stock v2 takes the key away again.
      await c.cloud.pool.query(backofficeP1Grants(role, { ...P1, stockV2: false }, schema));
      state = await bo.read(manager.token, c.branch);
      assert.equal('stock_p1' in state.capabilities, false);
    } finally {
      await pool?.end();
      await c.cloud.admin.query(`DROP OWNED BY ${role}`);
      await c.cloud.admin.query(`DROP ROLE ${role}`);
    }
  }));
