// Lane bo-ui step 7 «Скидки» in the real back office (Chromium; discounts_ui.py):
//   off - every flag off: no section, no request to ops/discounts, #discounts opens «Главная»;
//   on  - roles and the discount editor on cloud075 with a published synthetic catalog: the banner
//         that the POS does not apply discounts yet, validation in words, create with categories,
//         products, channels, period, weekdays and hours, a draft that survives a reload, a taken
//         name, switch on, an edit back to draft, the history, the archive, the editor at 390 px,
//         the shift manager at 390 px and the analyst without buttons.
// Real API and PostgreSQL behind the operator proxy, synthetic data only. Screenshots:
// .local/backoffice-discounts/ at 1440x900 and 390x844.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { designateBackoffice, grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import { publishDiscountCatalog } from '../../packages/backoffice-core/tests/discounts-fixture.mjs';

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
async function browser(ctx, mode, extra = {}) {
  const output = new URL('../../.local/backoffice-discounts/', import.meta.url);
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
        [fileURLToPath(new URL('discounts_ui.py', import.meta.url)), file],
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
        if (signal) reject(new Error(`Discounts browser terminated by ${signal}`));
        else resolve(code);
      });
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test('discounts, every flag off: no section, no request, #discounts opens «Главная»', () =>
  withCatalog(
    async (ctx) => {
      await publishDiscountCatalog(ctx);
      assert.equal(await browser(ctx, 'off'), 0, '«Скидки» with every flag off must pass');
      assert.equal(
        (await ctx.cloud.pool.query('SELECT count(*)::int n FROM bo_discounts')).rows[0].n,
        0,
      );
    },
    { staticPrefix: '/backoffice' },
  ));

test('discounts on: banner, editor, validation, draft, name, switch on, history, archive, roles at 1440 and 390 px', () =>
  withCatalog(
    async (ctx) => {
      await publishDiscountCatalog(ctx);
      const shift = await person(ctx, 'Синтетический начальник смены', 'shift_manager');
      const analyst = await person(ctx, 'Синтетический аналитик', null);
      assert.equal(
        await browser(ctx, 'on', { shift, analyst }),
        0,
        'Discounts in the browser must pass',
      );
      const rows = (
        await ctx.cloud.pool.query(
          `SELECT name,kind,percent_bp,value_minor::text,scope,schedule,requires_manager_pin,combinable,state,revision
           FROM bo_discounts WHERE branch_id=$1 ORDER BY name`,
          [ctx.branch],
        )
      ).rows;
      assert.deepEqual(
        rows.map((r) => [r.name, r.kind, r.percent_bp, r.value_minor, r.state, r.revision]),
        [
          ['Обед будни', 'percent', 1500, null, 'draft', 3],
          ['Ужин 500', 'amount', null, '50000', 'archived', 2],
        ],
      );
      assert.deepEqual(rows[0].scope, {
        categories: ['chicken'],
        products: ['cola'],
        channels: ['hall', 'yandex_eda'],
      });
      assert.deepEqual(rows[0].schedule, {
        start_at: '2099-11-19T19:00:00.000Z',
        end_at: '2099-11-30T19:00:00.000Z',
        weekdays: [1, 2, 3, 4, 5],
        hours: [{ from: '12:00', to: '15:00' }],
      });
      assert.equal(rows[0].requires_manager_pin, true);
      assert.equal(rows[0].combinable, false);
      assert.deepEqual(rows[1].scope.channels, [
        'hall',
        'yandex_eda',
        'glovo',
        'chocofood',
        'mobile',
        'kiosk',
      ]);
      assert.equal(rows[1].combinable, true);
      const audit = (
        await ctx.cloud.pool.query(
          "SELECT action,reason FROM bo_audit WHERE branch_id=$1 AND action LIKE 'discount%' ORDER BY created_at,id",
          [ctx.branch],
        )
      ).rows;
      assert.deepEqual(
        audit.map((a) => a.action),
        ['discount_save', 'discount_save', 'discount_state', 'discount_save', 'discount_state'],
      );
      assert.equal(audit[3].reason, 'Скидка на обед 15 % по решению владельца');
      // Nothing reached the edge or the menu.
      for (const table of ['bo_publications', 'bo_delivery_outbox'])
        assert.equal(
          (await ctx.cloud.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
          0,
          table,
        );
      assert.equal(
        (await ctx.cloud.pool.query('SELECT count(*)::int n FROM catalog_publications')).rows[0].n,
        1,
      );
    },
    { staticPrefix: '/backoffice', roles: true, discounts: true },
  ));
