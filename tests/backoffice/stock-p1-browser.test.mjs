// Lane bo-ui stock P1 in the real back office (Chromium; see stock_p1_ui.py):
//   off - every flag off: the cloud lane's stock page (no sales notice, no storno, no tiles);
//   on  - BACKOFFICE_STOCK_V2_ENABLED with roles on cloud075: the sales notice and «Последний
//         подсчёт», quick waste tiles, storno of a receipt and of a waste (with a concurrent
//         document in between), «Списания» and «Движение» with CSV, the ingredient's tile, the
//         accountant's storno at 390 px and the shift manager without it.
// Real API and PostgreSQL behind the operator proxy, synthetic data only. Screenshots:
// .local/backoffice-stock-p1/ at 1440x900 and 390x844.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import {
  Backoffice,
  designateBackoffice,
  grantBackoffice,
} from '../../packages/backoffice-core/dist/index.js';

const request = (command) => ({
  request_id: randomUUID(),
  reason: 'Синтетическая подготовка',
  command,
});
async function revisions(ctx) {
  return Object.fromEntries(
    (
      await ctx.cloud.pool.query(
        'SELECT ingredient_id,revision FROM bo_stock_balances WHERE branch_id=$1',
        [ctx.branch],
      )
    ).rows.map((r) => [r.ingredient_id, r.revision]),
  );
}
async function stock(bo, ctx, kind, reference, lines, extra = {}) {
  const now = await revisions(ctx);
  return bo.command(
    ctx.manager.token,
    ctx.branch,
    request({
      type: 'stock',
      kind,
      reference,
      lines: lines.map(([id, quantity, value = '0']) => ({
        ingredient_id: id,
        quantity,
        value_minor: value,
        expected_revision: now[id],
      })),
      ...extra,
    }),
  );
}
/**
 * Two ingredients with quick waste tiles (p1), a receipt of both, an old waste without a reason
 * (the cloud lane runtime), a count of the fillet and three later bun receipts to reverse.
 */
async function seed(ctx, p1) {
  const bun = randomUUID(),
    fillet = randomUUID();
  for (const [id, name, unit, tile] of [
    [bun, 'Синтетическая булка', 'pcs', { label: 'Булки из шкафа', quantity: '2' }],
    [fillet, 'Синтетическое филе', 'g', { label: 'Мясо', quantity: '500' }],
  ])
    await ctx.backoffice.command(
      ctx.manager.token,
      ctx.branch,
      request({
        type: 'save',
        kind: 'ingredient',
        id,
        expected_revision: 0,
        payload: { name, unit, minimum: '0', active: true, ...(p1 ? { quick_waste: tile } : {}) },
      }),
    );
  const lane = new Backoffice(ctx.cloud.pool, true, {});
  await stock(lane, ctx, 'receipt', 'НАК-0', [
    [bun, '20', '20000'],
    [fillet, '5000', '1167000'],
  ]);
  await stock(lane, ctx, 'waste', 'СП-СТАРОЕ', [[bun, '1']]);
  await stock(ctx.backoffice, ctx, 'count', 'ИНВ-1', [[fillet, '4800']]);
  for (const reference of ['НАК-1', 'НАК-2'])
    await stock(
      ctx.backoffice,
      ctx,
      'receipt',
      reference,
      [[bun, '10', '10000']],
      p1 ? { meta: { supplier_kind: 'bakery', document_date: '2026-11-05' } } : {},
    );
  const ids = Object.fromEntries(
    (
      await ctx.cloud.pool.query('SELECT reference,id FROM bo_stock_documents WHERE branch_id=$1', [
        ctx.branch,
      ])
    ).rows.map((r) => [r.reference, r.id]),
  );
  return { bun, fillet, docs: ids };
}
async function person(ctx, name, designation) {
  const login = await provisionCatalogManager(ctx.cloud.pool, {
    organization_id: ctx.org,
    name,
    branch_ids: [ctx.branch],
  });
  await grantBackoffice(ctx.cloud.pool, login.actor_id, ctx.branch, 'analyst');
  await designateBackoffice(
    ctx.cloud.pool,
    login.actor_id,
    ctx.branch,
    designation,
    'Синтетическое назначение',
  );
  return login;
}
async function browser(ctx, mode, extra) {
  const output = new URL('../../.local/backoffice-stock-p1/', import.meta.url);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(fileURLToPath(new URL('run-', output))),
    file = temp + '/fixture.json';
  try {
    await writeFile(
      file,
      JSON.stringify({
        url: ctx.url + '/backoffice/',
        branch: ctx.branch,
        manager: ctx.manager,
        mode,
        output: fileURLToPath(output),
        ...extra,
      }),
      { mode: 0o600 },
    );
    return await new Promise((resolve, reject) => {
      const child = spawn(
        process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
        [fileURLToPath(new URL('stock_p1_ui.py', import.meta.url)), file],
        { stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32' },
      );
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, 300000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (signal) reject(new Error(`Stock P1 browser terminated by ${signal}`));
        else resolve(code);
      });
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
const documents = async (ctx) =>
  (
    await ctx.cloud.pool.query(
      `SELECT d.kind,d.reference,d.reason_code,o.reference reverses,m.name actor
       FROM bo_stock_documents d JOIN catalog_managers m ON m.id=d.actor_id
       LEFT JOIN bo_stock_documents o ON o.id=d.reverses_document_id
       WHERE d.branch_id=$1 ORDER BY d.created_at`,
      [ctx.branch],
    )
  ).rows;
const balance = async (ctx, id) =>
  (
    await ctx.cloud.pool.query(
      'SELECT quantity::text,value_minor::text FROM bo_stock_balances WHERE branch_id=$1 AND ingredient_id=$2',
      [ctx.branch, id],
    )
  ).rows[0];

test('stock P1, every flag off: the cloud lane stock page, nothing posted', () =>
  withCatalog(
    async (ctx) => {
      const ids = await seed(ctx, false);
      const before = await documents(ctx);
      assert.equal(await browser(ctx, 'off', ids), 0, 'Stock page with every flag off must pass');
      assert.deepEqual(await documents(ctx), before);
    },
    { staticPrefix: '/backoffice' },
  ));

test('stock P1 on 075: notice, last count, tiles, storno with a conflict, reports and CSV, roles', () =>
  withCatalog(
    async (ctx) => {
      const ids = await seed(ctx, true);
      const accountant = await person(ctx, 'Синтетический бухгалтер', 'accountant');
      const shift = await person(ctx, 'Синтетический начальник смены', 'shift_manager');
      assert.equal(
        await browser(ctx, 'on', { ...ids, accountant, shift }),
        0,
        'Stock P1 in the browser must pass',
      );
      const rows = await documents(ctx);
      assert.deepEqual(rows.slice(5), [
        // The manager's quick waste: two presses of «Булки из шкафа» (2 pcs each).
        {
          kind: 'waste',
          reference: 'СП-БЫСТРО',
          reason_code: 'hot_cabinet_expired',
          reverses: null,
          actor: 'Синтетический управляющий',
        },
        {
          kind: 'reversal',
          reference: 'НАК-1',
          reason_code: null,
          reverses: 'НАК-1',
          actor: 'Синтетический управляющий',
        },
        // Posted by the API while the storno dialog of the waste was open.
        {
          kind: 'waste',
          reference: 'ПАР-1',
          reason_code: 'damaged',
          reverses: null,
          actor: 'Синтетический управляющий',
        },
        {
          kind: 'reversal',
          reference: 'СП-БЫСТРО',
          reason_code: null,
          reverses: 'СП-БЫСТРО',
          actor: 'Синтетический управляющий',
        },
        {
          kind: 'reversal',
          reference: 'НАК-2',
          reason_code: null,
          reverses: 'НАК-2',
          actor: 'Синтетический бухгалтер',
        },
      ]);
      // 20 - 1 + 10 + 10 - 4 (tiles) - 10 (storno НАК-1) - 1 (ПАР-1) + 4 (storno) - 10 (НАК-2).
      assert.deepEqual(await balance(ctx, ids.bun), { quantity: '18', value_minor: '18000' });
      const tile = (
        await ctx.cloud.pool.query(
          "SELECT payload->'quick_waste' tile FROM bo_records WHERE id=$1 AND kind='ingredient'",
          [ids.fillet],
        )
      ).rows[0].tile;
      assert.deepEqual(tile, { label: 'Мясо в шкафу', quantity: '250' });
      const audit = (
        await ctx.cloud.pool.query(
          "SELECT count(*)::int n FROM bo_audit WHERE branch_id=$1 AND action='stock_reverse'",
          [ctx.branch],
        )
      ).rows[0].n;
      assert.equal(audit, 3);
    },
    { staticPrefix: '/backoffice', roles: true, stockV2: true },
  ));
