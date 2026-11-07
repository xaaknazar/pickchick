import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '@pickchick/database';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import {
  Backoffice,
  BackofficeError,
  Command,
  STOCK_SUPPLIER_KINDS,
  STOCK_WASTE_REASONS,
  StockOpsQuery,
  assertStockV2,
  designateBackoffice,
  grantBackoffice,
} from '../dist/index.js';
import * as contracts from '../../contracts/dist/index.js';

const MIGRATIONS = fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url));
/** The cloud migrations migrate() applies from `first` on (later lanes add files, e.g. 075). */
async function migrationsFrom(first) {
  const names = (await readdir(MIGRATIONS))
    .filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name) && name >= first)
    .sort();
  assert.equal(names[0], first);
  return names;
}
const is = (code, reason) => (error) =>
  error instanceof BackofficeError && error.code === code && error.reason === reason;
const meta = {
  supplier_kind: 'bakery',
  supplier_name: 'Синтетическая пекарня',
  document_date: '2026-11-18',
};

// ------------------------------------------------------------------------------ pure ----

test('stock v2 enums are verbatim copies of the cutover contract enums', () => {
  assert.deepEqual([...STOCK_WASTE_REASONS], contracts.StockWasteReasonSchema.options);
  assert.deepEqual([...STOCK_SUPPLIER_KINDS], contracts.StockSupplierKindSchema.options);
});

test('stock command schema: v1 parses as before, v2 fields are optional and strict', () => {
  const line = {
    ingredient_id: randomUUID(),
    quantity: '1',
    value_minor: '0',
    expected_revision: 0,
  };
  const v1 = { type: 'stock', kind: 'waste', reference: 'W-1', lines: [line] };
  // A v1 command parses to exactly itself: no defaulted keys, so the request digest is unchanged.
  assert.deepEqual(Command.parse(v1), v1);
  assert.deepEqual(Object.keys(Command.parse(v1)), ['type', 'kind', 'reference', 'lines']);
  for (const reason_code of STOCK_WASTE_REASONS)
    assert.equal(Command.parse({ ...v1, reason_code }).reason_code, reason_code);
  assert.deepEqual(Command.parse({ ...v1, kind: 'receipt', meta }).meta, meta);
  assert.deepEqual(
    Command.parse({
      ...v1,
      kind: 'receipt',
      meta: { supplier_kind: 'household', document_date: '2026-11-18' },
    }).meta,
    { supplier_kind: 'household', document_date: '2026-11-18' },
  );
  for (const bad of [
    { ...v1, reason_code: 'stolen' },
    { ...v1, reason_code: null },
    { ...v1, meta: { ...meta, supplier_kind: 'farm' } },
    { ...v1, meta: { ...meta, document_date: '2026-02-30' } },
    { ...v1, meta: { ...meta, document_date: '18.11.2026' } },
    { ...v1, meta: { ...meta, supplier_name: '' } },
    { ...v1, meta: { ...meta, supplier_name: 'я'.repeat(121) } },
    { ...v1, meta: { ...meta, number: '1' } },
    { ...v1, meta: { supplier_kind: 'bakery' } },
  ])
    assert.equal(Command.safeParse(bad).success, false, JSON.stringify(bad));
});

test('assertStockV2: disabled refuses v2 fields; enabled requires a waste reason', () => {
  const ok = (command, available) => assert.doesNotThrow(() => assertStockV2(command, available));
  const fails = (command, available, code, reason) =>
    assert.throws(() => assertStockV2(command, available), is(code, reason));
  for (const kind of ['receipt', 'waste', 'count']) ok({ kind }, false);
  fails({ kind: 'waste', reason_code: 'defect' }, false, 'NOT_READY', 'STOCK_V2_DISABLED');
  fails({ kind: 'receipt', meta }, false, 'NOT_READY', 'STOCK_V2_DISABLED');
  ok({ kind: 'waste', reason_code: 'defect' }, true);
  ok({ kind: 'receipt', meta }, true);
  ok({ kind: 'receipt' }, true);
  ok({ kind: 'count' }, true);
  fails({ kind: 'waste' }, true, 'INVALID_REQUEST', 'REASON_REQUIRED');
  fails({ kind: 'receipt', reason_code: 'defect' }, true, 'INVALID_REQUEST', undefined);
  fails({ kind: 'count', reason_code: 'defect' }, true, 'INVALID_REQUEST', undefined);
  fails({ kind: 'waste', reason_code: 'other', meta }, true, 'INVALID_REQUEST', undefined);
  fails({ kind: 'count', meta }, true, 'INVALID_REQUEST', undefined);
});

test('ops/stock query: view, calendar dates, at most 92 days, nothing else', () => {
  const q = { view: 'waste', start_date: '2026-11-19', end_date: '2026-11-19' };
  assert.deepEqual(StockOpsQuery.parse(q), q);
  assert.equal(StockOpsQuery.safeParse({ ...q, view: 'movement' }).success, true);
  assert.equal(
    StockOpsQuery.safeParse({ ...q, start_date: '2026-08-20', end_date: '2026-11-19' }).success,
    true,
  );
  for (const bad of [
    { ...q, view: 'consumption' },
    { ...q, start_date: '2026-08-19' },
    { ...q, start_date: '2026-11-20' },
    { ...q, end_date: '2026-11-31' },
    { ...q, extra: '1' },
    { view: 'waste', start_date: '2026-11-19' },
  ])
    assert.equal(StockOpsQuery.safeParse(bad).success, false, JSON.stringify(bad));
});

// ------------------------------------------------------------------------- PostgreSQL ----

const request = (command, reason = 'Synthetic stock v2') => ({
  request_id: randomUUID(),
  reason,
  command,
});
async function setup(c) {
  const manager = await provisionCatalogManager(c.cloud.pool, {
    organization_id: c.org,
    name: 'Синтетический управляющий',
    branch_ids: [c.branch],
  });
  await grantBackoffice(c.cloud.pool, manager.actor_id, c.branch, 'manager');
  const bo = new Backoffice(c.cloud.pool, true, {});
  const save = async (name, unit) => {
    const id = randomUUID();
    await bo.command(
      manager.token,
      c.branch,
      request({
        type: 'save',
        kind: 'ingredient',
        id,
        expected_revision: 0,
        payload: { name, unit, minimum: '0', active: true },
      }),
    );
    return id;
  };
  return {
    manager,
    bo,
    fillet: await save('Синтетическое филе', 'g'),
    bun: await save('Синтетическая булка', 'pcs'),
  };
}
const line = (id, quantity, revision, value_minor = '0') => ({
  ingredient_id: id,
  quantity,
  value_minor,
  expected_revision: revision,
});
const documentRow = async (c, id) =>
  (
    await c.cloud.pool.query('SELECT kind,reason_code,meta FROM bo_stock_documents WHERE id=$1', [
      id,
    ])
  ).rows[0];

test('flag off: v2 fields are refused, v1 documents keep NULL columns, ops/stock is 404', () =>
  withSyncDatabases(async (c) => {
    const s = await setup(c);
    const receipt = await s.bo.command(
      s.manager.token,
      c.branch,
      request({
        type: 'stock',
        kind: 'receipt',
        reference: 'NAK-1',
        lines: [line(s.fillet, '5000', 0, '500000')],
      }),
    );
    assert.deepEqual(Object.keys(receipt), ['id', 'kind', 'reference']);
    assert.deepEqual(await documentRow(c, receipt.id), {
      kind: 'receipt',
      reason_code: null,
      meta: null,
    });
    const waste = await s.bo.command(
      s.manager.token,
      c.branch,
      request({
        type: 'stock',
        kind: 'waste',
        reference: 'W-1',
        lines: [line(s.fillet, '100', 1)],
      }),
    );
    assert.equal((await documentRow(c, waste.id)).reason_code, null);
    const before = await s.bo.read(s.manager.token, c.branch);
    await assert.rejects(
      s.bo.command(
        s.manager.token,
        c.branch,
        request({
          type: 'stock',
          kind: 'waste',
          reference: 'W-2',
          reason_code: 'defect',
          lines: [line(s.fillet, '100', 2)],
        }),
      ),
      is('NOT_READY', 'STOCK_V2_DISABLED'),
    );
    await assert.rejects(
      s.bo.command(
        s.manager.token,
        c.branch,
        request({
          type: 'stock',
          kind: 'receipt',
          reference: 'NAK-2',
          meta,
          lines: [line(s.fillet, '1', 2, '1')],
        }),
      ),
      is('NOT_READY', 'STOCK_V2_DISABLED'),
    );
    const after = await s.bo.read(s.manager.token, c.branch);
    assert.deepEqual(after.stock, before.stock);
    assert.equal(after.documents.length, 2);
    assert.equal('stock_v2' in after.capabilities, false);
    await assert.rejects(
      s.bo.ops(s.manager.token, c.branch, 'stock', {
        view: 'waste',
        start_date: '2026-11-01',
        end_date: '2026-11-30',
      }),
      is('NOT_FOUND', 'STOCK_V2_DISABLED'),
    );
    // The previous runtime's statement (D0 index.ts) still writes on the 074 schema.
    await c.cloud.pool.query(
      'INSERT INTO bo_stock_documents(id,branch_id,actor_id,kind,reference,reason) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(), c.branch, s.manager.actor_id, 'count', 'OLD-1', 'Previous runtime'],
    );
  }));

test('flag on: waste needs a reason, receipts keep supplier and date, nothing half-written', () =>
  withSyncDatabases(async (c) => {
    const s = await setup(c);
    const v2 = new Backoffice(c.cloud.pool, true, { stockV2Enabled: true, rolesEnabled: true });
    assert.equal((await v2.read(s.manager.token, c.branch)).capabilities.stock_v2, true);
    const receipt = request({
      type: 'stock',
      kind: 'receipt',
      reference: 'NAK-77',
      meta,
      lines: [line(s.fillet, '5000', 0, '500000'), line(s.bun, '40', 0, '40000')],
    });
    const done = await v2.command(s.manager.token, c.branch, receipt);
    assert.deepEqual(await v2.command(s.manager.token, c.branch, receipt), done);
    assert.deepEqual(await documentRow(c, done.id), { kind: 'receipt', reason_code: null, meta });
    // A receipt without meta stays valid (old cabinet, manual entry).
    await v2.command(
      s.manager.token,
      c.branch,
      request({
        type: 'stock',
        kind: 'receipt',
        reference: 'NAK-78',
        lines: [line(s.bun, '10', 1, '10000')],
      }),
    );
    const before = await v2.read(s.manager.token, c.branch);
    const bad = [
      [
        { kind: 'waste', lines: [line(s.fillet, '100', 1)] },
        is('INVALID_REQUEST', 'REASON_REQUIRED'),
      ],
      [
        { kind: 'receipt', reason_code: 'defect', lines: [line(s.fillet, '1', 1, '1')] },
        is('INVALID_REQUEST', undefined),
      ],
      [
        { kind: 'waste', reason_code: 'defect', meta, lines: [line(s.fillet, '1', 1)] },
        is('INVALID_REQUEST', undefined),
      ],
      [{ kind: 'count', meta, lines: [line(s.fillet, '1', 1)] }, is('INVALID_REQUEST', undefined)],
    ];
    for (const [command, error] of bad)
      await assert.rejects(
        v2.command(
          s.manager.token,
          c.branch,
          request({ type: 'stock', reference: 'BAD', ...command }),
        ),
        error,
      );
    const after = await v2.read(s.manager.token, c.branch);
    assert.deepEqual(after.stock, before.stock);
    assert.equal(after.documents.length, before.documents.length);
    assert.equal(after.audit.length, before.audit.length);
    for (const [reason_code, id, quantity, revision] of [
      ['hot_cabinet_expired', s.fillet, '300', 1],
      ['meat_expired', s.fillet, '200', 2],
      ['damaged', s.bun, '2', 2],
      ['other', s.bun, '1', 3],
    ]) {
      const waste = await v2.command(
        s.manager.token,
        c.branch,
        request(
          {
            type: 'stock',
            kind: 'waste',
            reference: 'W-' + reason_code,
            reason_code,
            lines: [line(id, quantity, revision)],
          },
          reason_code === 'other' ? 'Уронили при разгрузке' : 'Списание по регламенту',
        ),
      );
      assert.equal((await documentRow(c, waste.id)).reason_code, reason_code);
    }
    // A shift manager wastes with a reason as well (roles and stock v2 together).
    const shift = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Синтетический начальник смены',
      branch_ids: [c.branch],
    });
    await grantBackoffice(c.cloud.pool, shift.actor_id, c.branch, 'analyst');
    await designateBackoffice(c.cloud.pool, shift.actor_id, c.branch, 'shift_manager', 'Т7: смена');
    await v2.command(
      shift.token,
      c.branch,
      request({
        type: 'stock',
        kind: 'waste',
        reference: 'W-SHIFT',
        reason_code: 'defect',
        lines: [line(s.bun, '3', 4)],
      }),
    );
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date());
    const report = await v2.ops(shift.token, c.branch, 'stock', {
      view: 'waste',
      start_date: today,
      end_date: today,
    });
    assert.equal(report.view, 'waste');
    assert.equal(report.timezone, 'Asia/Almaty');
    assert.equal(report.totals.documents, 5);
    assert.deepEqual(
      report.summary.by_reason.map((r) => [r.reason_code, r.documents]),
      [
        ['damaged', 1],
        ['defect', 1],
        ['hot_cabinet_expired', 1],
        ['meat_expired', 1],
        ['other', 1],
      ],
    );
    // Waste value at the moving average: 500000 tiyn per 5000 g of fillet, 1000 per bun.
    const value = Object.fromEntries(
      report.summary.by_reason.map((r) => [r.reason_code, r.value_minor]),
    );
    assert.deepEqual(value, {
      hot_cabinet_expired: '30000',
      meat_expired: '20000',
      damaged: '2000',
      other: '1000',
      defect: '3000',
    });
    assert.equal(report.totals.value_minor, '56000');
    assert.deepEqual(
      report.summary.by_ingredient.map((r) => [r.name, r.unit, r.quantity, r.value_minor]),
      [
        ['Синтетическое филе', 'g', '500', '50000'],
        ['Синтетическая булка', 'pcs', '6', '6000'],
      ],
    );
    // On 075 stock v2 carries stock P1 (lane bo-ui, stock-p1.ts): every waste row also counts the
    // storno documents of the window (none here); stock-p1.test.mjs pins the cloud lane answer.
    assert.deepEqual(report.summary.by_day, [
      { day: today, documents: 5, reversals: 0, value_minor: '56000' },
    ]);
    assert.deepEqual(
      report.summary.by_author.map((r) => [r.actor_name, r.documents, r.value_minor]),
      [
        ['Синтетический начальник смены', 1, '3000'],
        ['Синтетический управляющий', 4, '53000'],
      ],
    );
    assert.equal(report.documents.length, 5);
    assert.equal(
      report.documents.every((d) => d.kind === 'waste'),
      true,
    );
    assert.equal(report.truncated, false);
    const movement = await v2.ops(s.manager.token, c.branch, 'stock', {
      view: 'movement',
      start_date: today,
      end_date: today,
    });
    assert.equal(movement.totals.documents, 7);
    assert.deepEqual(
      movement.summary.by_kind.map((r) => [r.kind, r.documents, r.value_delta_minor]),
      [
        ['receipt', 2, '550000'],
        ['waste', 5, '-56000'],
      ],
    );
    const nak = movement.documents.find((d) => d.reference === 'NAK-77');
    assert.deepEqual(nak.meta, meta);
    assert.equal(nak.reason_code, null);
    assert.equal(nak.lines.length, 2);
    // Another day of the window is empty; a bad window or an unknown view is refused.
    const empty = await v2.ops(s.manager.token, c.branch, 'stock', {
      view: 'waste',
      start_date: '2026-01-01',
      end_date: '2026-01-31',
    });
    assert.equal(empty.totals.documents, 0);
    assert.deepEqual(empty.summary.by_reason, []);
    await assert.rejects(
      v2.ops(s.manager.token, c.branch, 'stock', { view: 'waste', start_date: today }),
      is('INVALID_REQUEST', undefined),
    );
    await assert.rejects(
      v2.ops(s.manager.token, c.branch, 'sales', {
        view: 'waste',
        start_date: today,
        end_date: today,
      }),
      is('NOT_FOUND', undefined),
    );
    await assert.rejects(
      v2.ops('0'.repeat(64), c.branch, 'stock', {
        view: 'waste',
        start_date: today,
        end_date: today,
      }),
      is('UNAUTHORIZED', undefined),
    );
    // The D0 list in GET branches/:id keeps its keys and order; on 075 stock P1 (lane bo-ui)
    // appends the reason, the receipt details and the storno links (without 075: the D0 keys,
    // stock-p1.test.mjs).
    const state = await v2.read(s.manager.token, c.branch);
    assert.deepEqual(Object.keys(state.documents[0]), [
      'id',
      'kind',
      'reference',
      'reason',
      'order_id',
      'created_at',
      'actor_id',
      'actor_name',
      'lines',
      'reason_code',
      'meta',
      'source_ref',
      'reverses_document_id',
      'reversed_by',
      'reversed_at',
      'reverses',
    ]);
  }));

test('flag on without 074: plain stock commands work as v1, v2 fields and ops/stock are refused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-cloud-073-'));
  try {
    for (const file of await readdir(MIGRATIONS))
      if (file.endsWith('.sql') && file < '074')
        await cp(join(MIGRATIONS, file), join(directory, file));
    await withSyncDatabases(
      async (c) => {
        const s = await setup(c);
        const v2 = new Backoffice(c.cloud.pool, true, { stockV2Enabled: true });
        assert.equal((await v2.read(s.manager.token, c.branch)).capabilities.stock_v2, false);
        await v2.command(
          s.manager.token,
          c.branch,
          request({
            type: 'stock',
            kind: 'receipt',
            reference: 'NAK-1',
            lines: [line(s.bun, '10', 0, '1000')],
          }),
        );
        await v2.command(
          s.manager.token,
          c.branch,
          request({ type: 'stock', kind: 'waste', reference: 'W-1', lines: [line(s.bun, '1', 1)] }),
        );
        await assert.rejects(
          v2.command(
            s.manager.token,
            c.branch,
            request({
              type: 'stock',
              kind: 'waste',
              reference: 'W-2',
              reason_code: 'defect',
              lines: [line(s.bun, '1', 2)],
            }),
          ),
          is('NOT_READY', 'STOCK_V2_DISABLED'),
        );
        await assert.rejects(
          v2.ops(s.manager.token, c.branch, 'stock', {
            view: 'waste',
            start_date: '2026-11-01',
            end_date: '2026-11-30',
          }),
          is('NOT_FOUND', 'STOCK_V2_DISABLED'),
        );
        // 074 (and every later file) applied under the running runtime: the next command may
        // carry a reason.
        assert.deepEqual(
          await migrate(c.cloud.pool, MIGRATIONS, 'cloud'),
          await migrationsFrom('074_cloud_backoffice_cutover.sql'),
        );
        const waste = await v2.command(
          s.manager.token,
          c.branch,
          request({
            type: 'stock',
            kind: 'waste',
            reference: 'W-3',
            reason_code: 'defect',
            lines: [line(s.bun, '1', 2)],
          }),
        );
        assert.equal((await documentRow(c, waste.id)).reason_code, 'defect');
        // Old documents keep NULL columns and the immutability of 017.
        assert.equal(
          (
            await c.cloud.pool.query(
              'SELECT count(*)::int n FROM bo_stock_documents WHERE reason_code IS NULL',
            )
          ).rows[0].n,
          2,
        );
        await assert.rejects(
          c.cloud.pool.query("UPDATE bo_stock_documents SET reason_code='other'"),
          {
            message: /immutable/,
          },
        );
        await assert.rejects(
          c.cloud.pool.query(
            "INSERT INTO bo_stock_documents(id,branch_id,actor_id,kind,reference,reason,reason_code) VALUES($1,$2,$3,'waste','X','Synthetic','stolen')",
            [randomUUID(), c.branch, s.manager.actor_id],
          ),
          { code: '23514' },
        );
        await assert.rejects(
          c.cloud.pool.query(
            "INSERT INTO bo_stock_documents(id,branch_id,actor_id,kind,reference,reason,meta) VALUES($1,$2,$3,'receipt','X','Synthetic','[]'::jsonb)",
            [randomUUID(), c.branch, s.manager.actor_id],
          ),
          { code: '23514' },
        );
      },
      { cloudMigrationDirectory: directory },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
