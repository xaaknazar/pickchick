// Lane bo-ui2 step 3 «Импорт цен из iiko» in the real back office (Chromium;
// supplier_imports_ui.py): before any import the block says how imports come; after two runs of
// scripts/supplier-prices-import.mjs against the real API the manager reads the newest import
// with its report at 1440 and 390 px, the older one with a price corrected by hand since, and the
// analyst reads the same. Real API and PostgreSQL behind the operator proxy, synthetic data only.
// Screenshots: .local/backoffice-supplier-imports/ at 1440x900 and 390x844.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import {
  backofficeApi,
  parseProfile,
  runApply,
  runPlan,
} from '../../scripts/supplier-prices-import.mjs';
import { apiBase } from '../../scripts/catalog-menu-import.mjs';

const output = new URL('../../.local/backoffice-supplier-imports/', import.meta.url);
async function browser(ctx, phase, extra = {}) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(fileURLToPath(new URL('run-', output))),
    file = temp + '/fixture.json';
  try {
    await writeFile(
      file,
      JSON.stringify({
        url: ctx.url + '/backoffice/',
        manager: ctx.manager,
        phase,
        output: fileURLToPath(output),
        ...extra,
      }),
      { mode: 0o600 },
    );
    return await new Promise((resolve, reject) => {
      const child = spawn(
        process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
        [fileURLToPath(new URL('supplier_imports_ui.py', import.meta.url)), file],
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
        if (signal) reject(new Error(`Supplier imports browser terminated by ${signal}`));
        else resolve(code);
      });
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test('«Импорт цен из iiko»: empty, then two imports with their reports, 1440 and 390 px, the analyst', () =>
  withCatalog(
    async (ctx) => {
      const run = (command) =>
        ctx.backoffice.command(ctx.manager.token, ctx.branch, {
          request_id: randomUUID(),
          reason: 'Синтетическая подготовка закупок',
          command,
        });
      const ids = {};
      for (const [key, name, unit] of [
        ['fillet', 'Синтетическое филе', 'g'],
        ['bun', 'Синтетическая булка', 'pcs'],
      ]) {
        ids[key] = randomUUID();
        await run({
          type: 'save',
          kind: 'ingredient',
          id: ids[key],
          expected_revision: 0,
          payload: { name, unit, minimum: '0', active: true },
        });
      }
      await run({
        type: 'supplier_save',
        id: randomUUID(),
        expected_revision: 0,
        payload: { name: 'Поставщик 1', kind: 'supplier', active: true },
      });
      assert.equal(await browser(ctx, 'empty'), 0);

      // Two imports through the script itself, against the real API.
      const dir = await mkdtemp(join(fileURLToPath(output), 'files-'));
      const request = backofficeApi({ base: apiBase(ctx.upstream), token: ctx.manager.token });
      const load = async (name, lines) => {
        const file = join(dir, name);
        await writeFile(file, ['Поставщик;Товар;Ед. изм.;Цена;Дата', ...lines].join('\r\n'));
        const { plan } = await runPlan({
          file,
          branch: ctx.branch,
          request,
          profile: parseProfile('iiko'),
          planPath: file + '.plan.json',
        });
        return runApply({
          file,
          branch: ctx.branch,
          request,
          planPath: file + '.plan.json',
          expectedPlan: plan.plan_sha256,
        });
      };
      try {
        await load('prices-1.csv', [
          'Поставщик 1;Синтетическое филе;кг;2 500;01.11.2026',
          'Поставщик 2;Синтетическая булка;шт;120;01.11.2026',
        ]);
        // A price of the first import corrected by hand.
        const supplier = (
          await ctx.backoffice.ops(ctx.manager.token, ctx.branch, 'suppliers', {})
        ).suppliers.find((s) => s.name === 'Поставщик 2');
        await run({
          type: 'supplier_price_save',
          supplier_id: supplier.id,
          ingredient_id: ids.bun,
          unit: 'pcs',
          valid_from: '2026-11-01',
          price_minor: '12500',
          expected_revision: 1,
        });
        await load('prices-2.csv', [
          'Поставщик 3;Синтетическая булка;шт;130;02.11.2026',
          'Поставщик 1;Синтетическая неизвестная позиция;кг;100;01.11.2026',
          'Поставщик 1;Синтетическая булка;кг;100;01.11.2026',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      const analyst = await provisionCatalogManager(ctx.cloud.pool, {
        organization_id: ctx.org,
        name: 'Синтетический аналитик',
        branch_ids: [ctx.branch],
      });
      await grantBackoffice(ctx.cloud.pool, analyst.actor_id, ctx.branch, 'analyst');
      assert.equal(await browser(ctx, 'loaded', { analyst }), 0);
    },
    { staticPrefix: '/backoffice', roles: true, stockV2: true, supply: true },
  ));
