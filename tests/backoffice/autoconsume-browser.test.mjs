// Lane bo-ui step 5 «Списание по продажам» in the real back office (Chromium; autoconsume_ui.py):
//   off - every flag off: no tab, no request to ops/menu-links or ops/consumption;
//   on  - stock v2, roles and BACKOFFICE_STOCK_AUTOCONSUME_ENABLED on cloud075: the mode line,
//         the coverage warning, the queue with a blocked and an applied sale, approval of a
//         draft link, «Повторить» that writes the sale off, a new link in the editor, the mode
//         dialog, the shift manager's skip at 390 px and the analyst without actions.
// Real API and PostgreSQL behind the operator proxy, synthetic data only. Screenshots:
// .local/backoffice-autoconsume/ at 1440x900 and 390x844.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import {
  designateBackoffice,
  grantBackoffice,
  runStockConsumption,
} from '../../packages/backoffice-core/dist/index.js';
import {
  consumptionDocuments,
  items,
  kitchen,
  linkFixture,
  posSale,
  publishMenuFixture,
  request,
  stockFixture,
} from '../../packages/backoffice-core/tests/consumption-fixture.mjs';

const ago = (minutes) => new Date(Date.now() - minutes * 60000);
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
  const output = new URL('../../.local/backoffice-autoconsume/', import.meta.url);
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
        [fileURLToPath(new URL('autoconsume_ui.py', import.meta.url)), file],
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
        if (signal) reject(new Error(`Autoconsume browser terminated by ${signal}`));
        else resolve(code);
      });
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test('autoconsume, every flag off: no tab and no request to the new views', () =>
  withCatalog(
    async (ctx) => {
      assert.equal(await browser(ctx, 'off'), 0, 'Stock page with every flag off must pass');
    },
    { staticPrefix: '/backoffice' },
  ));

test('autoconsume on: mode, coverage, queue, approval, retry, editor, roles at 1440 and 390 px', () =>
  withCatalog(
    async (ctx) => {
      const token = ctx.manager.token;
      const bo = ctx.backoffice;
      const { release } = await publishMenuFixture(ctx);
      const s = await stockFixture(bo, token, ctx);
      await linkFixture(bo, token, ctx, s);
      // The cheese option goes back to draft; duo gets a draft link of its own.
      await bo.command(
        token,
        ctx.branch,
        request({
          type: 'menu_link_save',
          catalog_ref: { product_id: 'burger', group_id: 'extra', option_id: 'cheese' },
          effect: 'consume',
          lines: [{ ingredient_id: s.cheese, quantity: '2' }],
          expected_revision: 2,
        }),
      );
      await bo.command(
        token,
        ctx.branch,
        request({
          type: 'menu_link_save',
          catalog_ref: { product_id: 'duo' },
          effect: 'consume',
          lines: [{ ingredient_id: s.potato, quantity: '200' }],
          expected_revision: 0,
        }),
      );
      await bo.command(
        token,
        ctx.branch,
        request({
          type: 'stock_settings',
          autoconsume_mode: 'on',
          start_at: ago(180).toISOString(),
          expected_revision: 0,
        }),
      );
      const fries = await posSale(ctx, release, { at: ago(50), number: 71, lines: [['fries', 1]] });
      const cheese = await posSale(ctx, release, {
        at: ago(40),
        number: 72,
        lines: [['burger', 1, [['extra', 'cheese']]]],
      });
      const duo = await posSale(ctx, release, { at: ago(30), number: 73, lines: [['duo', 1]] });
      for (const order of [fries, cheese, duo]) await kitchen(ctx, order, 'in_production');
      const tick = await runStockConsumption(ctx.cloud.pool, {
        stockV2Enabled: true,
        rolesEnabled: true,
        stockAutoconsumeEnabled: true,
      });
      assert.deepEqual(tick.states, { applied: 1, blocked: 2 });
      const shift = await person(ctx, 'Синтетический начальник смены', 'shift_manager');
      const analyst = await person(ctx, 'Синтетический аналитик', null);
      assert.equal(
        await browser(ctx, 'on', { shift, analyst, cheese, duo, can: s.can }),
        0,
        'Autoconsume in the browser must pass',
      );
      const queue = Object.fromEntries((await items(ctx)).map((i) => [i.order_id, i]));
      assert.equal(queue[fries].state, 'applied');
      // Approved in the browser and written off by «Повторить».
      assert.equal(queue[cheese].state, 'applied');
      assert.equal(queue[duo].state, 'skipped');
      assert.equal(queue[duo].reason, 'Дуо отдали взамен, расход внесён списанием');
      assert.deepEqual(
        (await consumptionDocuments(ctx)).map((d) => d.source_ref),
        [`pos:${fries}`, `pos:${cheese}`],
      );
      const cola = (
        await ctx.cloud.pool.query(
          "SELECT effect,lines,status FROM bo_menu_stock_links WHERE branch_id=$1 AND catalog_key='combo:drink:cola'",
          [ctx.branch],
        )
      ).rows[0];
      assert.deepEqual(cola, {
        effect: 'consume',
        lines: [{ quantity: '1', ingredient_id: s.can }],
        status: 'draft',
      });
      const mode = (
        await ctx.cloud.pool.query(
          'SELECT autoconsume_mode,revision FROM bo_stock_settings WHERE branch_id=$1',
          [ctx.branch],
        )
      ).rows[0];
      assert.deepEqual(mode, { autoconsume_mode: 'dry_run', revision: 2 });
      const audit = (
        await ctx.cloud.pool.query(
          "SELECT action FROM bo_audit WHERE branch_id=$1 AND action IN ('menu_links_approve','consumption_retry','consumption_skip','stock_settings') ORDER BY created_at",
          [ctx.branch],
        )
      ).rows.map((r) => r.action);
      assert.deepEqual(audit, [
        'menu_links_approve',
        'stock_settings',
        'menu_links_approve',
        'consumption_retry',
        'stock_settings',
        'consumption_skip',
      ]);
    },
    {
      staticPrefix: '/backoffice',
      stockV2: true,
      roles: true,
      autoconsume: true,
    },
  ));
