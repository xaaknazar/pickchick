// Lane bo-ui2 step 4 stock reports in the real back office (Chromium; stock_reports_p2_ui.py):
//   off - stock reports off (roles, stock v2 and «Закупки» on): «Остатки» and «Движение» are the
//         bo-ui tabs, no «К заказу», no request to ops/stock?view=balances|reorder;
//   on  - roles, stock v2, «Закупки» and the stock reports on: «Остатки» from the server with the
//         value at the last purchase price, «Движение» by position with CSV, «К заказу» with the
//         rule in words and «Создать заявку» into the request editor, the honest banners, the
//         card fields «Откуда обычно приходит» and «Мясо», the phone at 390 px, the shift
//         manager, the accountant and the analyst.
// Real API and PostgreSQL behind the operator proxy; the history of 20 days is posted by SQL
// with the effect of the stock command (stock-reports-fixture.mjs). Synthetic data only.
// Screenshots: .local/backoffice-stock-reports/ at 1440x900 and 390x844.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { designateBackoffice, grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import {
  almaty,
  noon,
  pos,
  post,
} from '../../packages/backoffice-core/tests/stock-reports-fixture.mjs';

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
/**
 * Fillet (meat, minimum 2 kg, 3 ₸ a gram) used 1 kg a day by production and sold 0.5 kg a day for
 * 14 days: 3.3 kg left, target 3 days = 4.5 kg, order 1.2 kg. Buns (minimum 10, 10 ₸ each) sold 3
 * a day: 8 left, order 2. Boxes (minimum 100) well stocked, with a waste and its storno.
 */
async function seed(ctx, meat) {
  const run = (command) =>
    ctx.backoffice.command(ctx.manager.token, ctx.branch, {
      request_id: randomUUID(),
      reason: 'Синтетическая подготовка',
      command,
    });
  const ids = {};
  for (const [key, name, unit, minimum, extra] of [
    ['fillet', 'Синтетическое филе', 'g', '2000', meat ? { meat: true } : {}],
    ['bun', 'Синтетическая булка', 'pcs', '10', {}],
    ['box', 'Синтетическая коробка', 'pcs', '100', {}],
    ['breaded', 'Синтетическая заготовка', 'g', '0', {}],
  ]) {
    ids[key] = randomUUID();
    await run({
      type: 'save',
      kind: 'ingredient',
      id: ids[key],
      expected_revision: 0,
      payload: { name, unit, minimum, active: true, ...extra },
    });
  }
  const actor = ctx.manager.actor_id;
  await post(ctx, actor, noon(-20), 'receipt', [
    [ids.fillet, '24300', '7290000'],
    [ids.bun, '50', '50000'],
    [ids.box, '500', '250000'],
  ]);
  for (let d = -14; d <= -1; d++) {
    await post(ctx, actor, noon(d), 'production', {
      inputs: [[ids.fillet, '1000']],
      output: [ids.breaded, '900'],
    });
    await post(
      ctx,
      actor,
      noon(d, 13),
      'consumption',
      [
        [ids.fillet, '500'],
        [ids.bun, '3'],
      ],
      {
        source_ref: pos(),
      },
    );
  }
  const waste = await post(ctx, actor, noon(-3, 15), 'waste', [[ids.box, '10']]);
  await post(ctx, actor, noon(-2, 15), 'reversal', { of: waste });
  return ids;
}
async function browser(ctx, mode, extra = {}) {
  const output = new URL('../../.local/backoffice-stock-reports/', import.meta.url);
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
        start: almaty(-20),
        ...extra,
      }),
      { mode: 0o600 },
    );
    return await new Promise((resolve, reject) => {
      const child = spawn(
        process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
        [fileURLToPath(new URL('stock_reports_p2_ui.py', import.meta.url)), file],
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
        if (signal) reject(new Error(`Stock reports browser terminated by ${signal}`));
        else resolve(code);
      });
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test('stock reports off: the bo-ui stock page, no «К заказу», no request to the new views', () =>
  withCatalog(
    async (ctx) => {
      const ids = await seed(ctx, false);
      assert.equal(await browser(ctx, 'off', ids), 0, 'stock reports off must pass');
    },
    { staticPrefix: '/backoffice', roles: true, stockV2: true, supply: true },
  ));

test('stock reports on: balances, movement by position, «К заказу» to a request, roles at 1440 and 390 px', () =>
  withCatalog(
    async (ctx) => {
      const ids = await seed(ctx, true);
      const shift = await person(ctx, 'Синтетический начальник смены', 'shift_manager');
      const accountant = await person(ctx, 'Синтетический бухгалтер', 'accountant');
      const analyst = await person(ctx, 'Синтетический аналитик', null);
      assert.equal(
        await browser(ctx, 'on', { ...ids, shift, accountant, analyst }),
        0,
        'stock reports in the browser must pass',
      );
      const q = async (sql, args = [ctx.branch]) => (await ctx.cloud.pool.query(sql, args)).rows;
      // «Создать заявку» saved a draft to a supplier with the suggested fillet line.
      const requests = await q(
        'SELECT kind,state,lines FROM bo_supply_requests WHERE branch_id=$1 ORDER BY number',
      );
      assert.equal(requests.length, 1);
      assert.equal(requests[0].kind, 'supplier');
      assert.equal(requests[0].state, 'draft');
      assert.deepEqual(
        requests[0].lines.map((l) => [l.ingredient_id, l.qty]),
        [[ids.fillet, '1200']],
      );
      // The card of the bun now says where it comes from; the fillet stays meat.
      const cards = Object.fromEntries(
        (await q("SELECT id,payload FROM bo_records WHERE branch_id=$1 AND kind='ingredient'")).map(
          (r) => [r.id, r.payload],
        ),
      );
      assert.equal(cards[ids.bun].supply_kind, 'bakery');
      assert.equal(cards[ids.fillet].meat, true);
    },
    {
      staticPrefix: '/backoffice',
      roles: true,
      stockV2: true,
      supply: true,
      stockReports: true,
    },
  ));
