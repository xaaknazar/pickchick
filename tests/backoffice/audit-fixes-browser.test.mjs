// Lane bo-ui audit fixes in the real back office (Chromium, audit F01-F20; see audit_fixes_ui.py):
//   off   - every flag off: the cloud lane's cabinet (Esc closes, the period on every page, codes);
//   stock - BACKOFFICE_STOCK_V2_ENABLED only: the stock dialog fixes (F01 drafts and questions,
//           F02 a concurrent document refreshes the balances in place, F17 names);
//   on    - BACKOFFICE_POS_DAY_ENABLED with roles, stock v2 and workforce: every audit fix and
//           the four roles (F03, F05-F09, F14-F20).
// Real API and PostgreSQL behind the operator proxy, synthetic data only. Screenshots:
// .local/backoffice-audit-fixes/ at 1440x900 and 390x844.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { designateBackoffice, grantBackoffice } from '../../packages/backoffice-core/dist/index.js';

async function command(ctx, body) {
  return ctx.backoffice.command(ctx.manager.token, ctx.branch, {
    request_id: randomUUID(),
    reason: 'Синтетическая подготовка',
    command: body,
  });
}
/** Two ingredients with stock, an overdue urgent ticket; returns the ids the browser needs. */
async function seed(ctx) {
  const bun = randomUUID(),
    fillet = randomUUID();
  for (const [id, name, unit] of [
    [bun, 'Синтетическая булка', 'pcs'],
    [fillet, 'Синтетическое филе', 'g'],
  ])
    await command(ctx, {
      type: 'save',
      kind: 'ingredient',
      id,
      expected_revision: 0,
      payload: { name, unit, minimum: '0', active: true },
    });
  await command(ctx, {
    type: 'stock',
    kind: 'receipt',
    reference: 'НАК-0',
    lines: [
      { ingredient_id: bun, quantity: '20', value_minor: '20000', expected_revision: 0 },
      { ingredient_id: fillet, quantity: '5000', value_minor: '1167000', expected_revision: 0 },
    ],
  });
  await command(ctx, {
    type: 'save',
    kind: 'ticket',
    id: randomUUID(),
    expected_revision: 0,
    payload: {
      name: 'Долго ждали заказ в зале',
      order_id: null,
      category: 'complaint',
      priority: 'urgent',
      assignee_id: null,
      due_at: new Date(Date.now() - 3600000).toISOString(),
      status: 'new',
      description: 'Синтетическое обращение',
      resolution: '',
    },
  });
  return { bun, fillet };
}
async function person(ctx, name, designation) {
  const login = await provisionCatalogManager(ctx.cloud.pool, {
    organization_id: ctx.org,
    name,
    branch_ids: [ctx.branch],
  });
  await grantBackoffice(ctx.cloud.pool, login.actor_id, ctx.branch, 'analyst');
  if (designation)
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
  const output = new URL('../../.local/backoffice-audit-fixes/', import.meta.url);
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
        [fileURLToPath(new URL('audit_fixes_ui.py', import.meta.url)), file],
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
        if (signal) reject(new Error(`Audit fixes browser terminated by ${signal}`));
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
      `SELECT kind,reference FROM bo_stock_documents WHERE branch_id=$1 ORDER BY created_at,reference`,
      [ctx.branch],
    )
  ).rows;

test('audit fixes, every flag off: the cloud lane cabinet (Esc closes, period everywhere, codes)', () =>
  withCatalog(
    async (ctx) => {
      const ids = await seed(ctx);
      assert.equal(await browser(ctx, 'off', ids), 0, 'Cabinet with every flag off must pass');
      // Nothing was posted from the browser: Esc and «Закрыть» only closed the dialogs.
      assert.deepEqual(await documents(ctx), [{ kind: 'receipt', reference: 'НАК-0' }]);
    },
    { staticPrefix: '/backoffice' },
  ));

test('audit fixes with stock v2 only: drafts, questions and the conflict retry of a stock document', () =>
  withCatalog(
    async (ctx) => {
      const ids = await seed(ctx);
      assert.equal(await browser(ctx, 'stock', ids), 0, 'Stock dialog fixes must pass');
      assert.deepEqual(await documents(ctx), [
        { kind: 'receipt', reference: 'НАК-0' },
        { kind: 'waste', reference: 'ПАР-1' },
        { kind: 'waste', reference: 'СП-КОНФЛИКТ' },
      ]);
      const balance = (
        await ctx.cloud.pool.query(
          'SELECT quantity::text FROM bo_stock_balances WHERE branch_id=$1 AND ingredient_id=$2',
          [ctx.branch, ids.bun],
        )
      ).rows[0];
      assert.equal(balance.quantity, '17', '20 - 1 (concurrent) - 2 (retried document)');
    },
    { staticPrefix: '/backoffice', stockV2: true },
  ));

test('audit fixes with the cutover back office: every fix and the four roles', () =>
  withCatalog(
    async (ctx) => {
      const ids = await seed(ctx);
      const accountant = await person(ctx, 'Синтетический бухгалтер', 'accountant');
      const shift = await person(ctx, 'Синтетический начальник смены', 'shift_manager');
      const analyst = await person(ctx, 'Синтетический аналитик', null);
      assert.equal(
        await browser(ctx, 'on', { ...ids, accountant, shift, analyst }),
        0,
        'Cabinet with the audit fixes must pass',
      );
      // F03: the accountant's operation is in the ledger under her name.
      const entry = (
        await ctx.cloud.pool.query(
          `SELECT m.name FROM bo_audit a JOIN catalog_managers m ON m.id=a.actor_id
           WHERE a.branch_id=$1 AND a.action='finance.entry'`,
          [ctx.branch],
        )
      ).rows;
      assert.deepEqual(entry, [{ name: 'Синтетический бухгалтер' }]);
    },
    {
      staticPrefix: '/backoffice',
      posDay: true,
      roles: true,
      stockV2: true,
      workforce: true,
    },
  ));
