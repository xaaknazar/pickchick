// Lane bo-ui2 step 2 «Закупки» in the real back office (Chromium; supply_ui.py):
//   off - supply off (roles and stock v2 on): no section, no request to ops/suppliers or
//         ops/supply-requests, #supply opens «Главная»;
//   on  - roles, stock v2 and supply on 076: a supplier and its corrected price, a request to the
//         supplier with the balance, the hint and the price, a restored draft, save and submit,
//         the text, its copy and print, a partial receipt with the difference, a cancelled draft
//         with its reason, the phone at 390 px, the shift manager, the accountant and the analyst.
// Real API and PostgreSQL behind the operator proxy, synthetic data only. Screenshots:
// .local/backoffice-supply/ at 1440x900 and 390x844.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { designateBackoffice, grantBackoffice } from '../../packages/backoffice-core/dist/index.js';

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
/** The positions of the page: a bun with a minimum and 4 in stock, fillet, salt without one. */
async function seed(ctx) {
  const run = (command) =>
    ctx.backoffice.command(ctx.manager.token, ctx.branch, {
      request_id: randomUUID(),
      reason: 'Синтетическая подготовка',
      command,
    });
  const ids = {};
  for (const [key, name, unit, minimum] of [
    ['bun', 'Синтетическая булка', 'pcs', '10'],
    ['fillet', 'Синтетическое филе', 'g', '1000'],
    ['salt', 'Синтетическая соль', 'g', '0'],
  ]) {
    ids[key] = randomUUID();
    await run({
      type: 'save',
      kind: 'ingredient',
      id: ids[key],
      expected_revision: 0,
      payload: { name, unit, minimum, active: true },
    });
  }
  await run({
    type: 'stock',
    kind: 'receipt',
    reference: 'СИН-1',
    meta: { supplier_kind: 'bakery', document_date: '2026-11-01' },
    lines: [{ ingredient_id: ids.bun, quantity: '4', value_minor: '4000', expected_revision: 0 }],
  });
  return ids;
}
async function browser(ctx, mode, extra = {}) {
  const output = new URL('../../.local/backoffice-supply/', import.meta.url);
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
        [fileURLToPath(new URL('supply_ui.py', import.meta.url)), file],
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
        if (signal) reject(new Error(`Supply browser terminated by ${signal}`));
        else resolve(code);
      });
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
const count = async (ctx, table) =>
  (await ctx.cloud.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;

test('supply off: no section, no request, #supply opens «Главная»', () =>
  withCatalog(
    async (ctx) => {
      await seed(ctx);
      assert.equal(await browser(ctx, 'off'), 0, '«Закупки» off must pass');
      for (const table of ['bo_suppliers', 'bo_supplier_prices', 'bo_supply_requests'])
        assert.equal(await count(ctx, table), 0, table);
    },
    { staticPrefix: '/backoffice', roles: true, stockV2: true },
  ));

test('supply on: suppliers, prices, a request to the receipt with the difference, roles at 1440 and 390 px', () =>
  withCatalog(
    async (ctx) => {
      const ids = await seed(ctx);
      const shift = await person(ctx, 'Синтетический начальник смены', 'shift_manager');
      const accountant = await person(ctx, 'Синтетический бухгалтер', 'accountant');
      const analyst = await person(ctx, 'Синтетический аналитик', null);
      assert.equal(
        await browser(ctx, 'on', { shift, accountant, analyst }),
        0,
        '«Закупки» in the browser must pass',
      );
      const q = async (sql, args = [ctx.branch]) => (await ctx.cloud.pool.query(sql, args)).rows;
      assert.deepEqual(
        (
          await q(
            'SELECT name,kind,active,revision FROM bo_suppliers WHERE branch_id=$1 ORDER BY name',
          )
        ).map((s) => [s.name, s.kind, s.active, s.revision]),
        [
          ['Пекарня 1', 'bakery', true, 1],
          ['Поставщик 1', 'supplier', true, 1],
        ],
      );
      const prices = await q(
        'SELECT unit,price_minor::text,source,revision FROM bo_supplier_prices WHERE branch_id=$1',
      );
      assert.deepEqual(prices, [
        { unit: 'kg', price_minor: '250000', source: 'manual', revision: 2 },
      ]);
      const requests = await q(
        'SELECT number,kind,state,lines,receipt_document_id,submitted_at IS NOT NULL submitted FROM bo_supply_requests WHERE branch_id=$1 ORDER BY number',
      );
      assert.deepEqual(
        requests.map((r) => [r.number, r.kind, r.state, r.submitted]),
        [
          [1, 'supplier', 'received', true],
          [2, 'bakery', 'cancelled', false],
          [3, 'central_kitchen', 'submitted', true],
        ],
      );
      // The submitted lines of request 1: balance and hint of the moment, the expected amount.
      assert.deepEqual(requests[0].lines, [
        {
          ingredient_id: ids.fillet,
          unit: 'g',
          qty: '1500',
          balance_at_request: '0',
          hint: '1000',
          price_minor: '375000',
        },
        { ingredient_id: ids.bun, unit: 'pcs', qty: '6', balance_at_request: '4', hint: '6' },
      ]);
      // One receipt, linked once, with what actually came.
      const receipt = await q(
        "SELECT id,kind,reference,meta FROM bo_stock_documents WHERE branch_id=$1 AND reference='НАК-7'",
      );
      assert.equal(receipt.length, 1);
      assert.equal(requests[0].receipt_document_id, receipt[0].id);
      assert.equal(receipt[0].meta.supplier_kind, 'supplier');
      assert.equal(receipt[0].meta.supplier_name, 'Поставщик 1');
      const moves = await q(
        'SELECT ingredient_id,quantity_delta::text,value_delta_minor::text FROM bo_stock_movements WHERE document_id=$1',
        [receipt[0].id],
      );
      assert.deepEqual(moves, [
        { ingredient_id: ids.fillet, quantity_delta: '1000', value_delta_minor: '250000' },
      ]);
      const audit = await q(
        "SELECT action,reason FROM bo_audit WHERE branch_id=$1 AND action LIKE 'supply%' ORDER BY created_at,id",
      );
      assert.deepEqual(
        audit.map((a) => a.action),
        [
          'supply_request_save',
          'supply_request_submit',
          'supply_request_receive',
          'supply_request_save',
          'supply_request_cancel',
          'supply_request_save',
          'supply_request_submit',
        ],
      );
      assert.equal(audit[4].reason, 'Пекарня привезёт сама');
      // Nothing was sent anywhere: no publication, no outbox row.
      for (const table of ['bo_publications', 'bo_delivery_outbox'])
        assert.equal(await count(ctx, table), 0, table);
    },
    { staticPrefix: '/backoffice', roles: true, stockV2: true, supply: true },
  ));
