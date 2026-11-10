import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withCatalog } from '../backoffice/helpers.mjs';
import { backofficeApi, runApply } from '../../scripts/supplier-prices-import.mjs';
import { apiBase } from '../../scripts/catalog-menu-import.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { grantBackoffice } from '../../packages/backoffice-core/dist/index.js';

/**
 * Lane bo-ui2 step 3 end to end: scripts/supplier-prices-import.mjs against the real back-office
 * API (its 100 KiB body limit included) and PostgreSQL. A synthetic «iiko export» of 1213 rows:
 * matched rows, new suppliers and every report category; the dry run writes nothing; a wrong hash
 * is refused; --apply in parts with a lost answer in the middle, the repeat, the same file again
 * (nothing to load), a stale plan, a role without the right; the view of the batch.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/supplier-prices-import.mjs', import.meta.url));
function cli(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { timeout: 120000, env: { ...process.env, NODE_OPTIONS: '' }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (error.code ?? 1) : 0,
          stdout,
          out: (() => {
            try {
              return JSON.parse(stdout.trim().split('\n').at(-1));
            } catch {
              return null;
            }
          })(),
          err: stderr,
        }),
    );
  });
}
const command = (ctx, cmd, reason = 'Синтетическая подготовка закупок') =>
  ctx.backoffice.command(ctx.manager.token, ctx.branch, {
    request_id: randomUUID(),
    reason,
    command: cmd,
  });

test('supplier prices from an export: dry run, wrong hash, parts, lost answer, repeats, stale plan', () =>
  withCatalog(
    async (ctx) => {
      const dir = await mkdtemp(join(tmpdir(), 'pickchick-supplier-prices-'));
      const q = async (sql, args = [ctx.branch]) => (await ctx.cloud.pool.query(sql, args)).rows;
      const n = async (table) =>
        (await q(`SELECT count(*)::int n FROM ${table} WHERE branch_id=$1`))[0].n;
      try {
        // 1200 grams positions, the bun, the oil; «Поставщик 1» with one manual price.
        const items = [];
        const save = async (name, unit) => {
          const id = randomUUID();
          await command(ctx, {
            type: 'save',
            kind: 'ingredient',
            id,
            expected_revision: 0,
            payload: { name, unit, minimum: '0', active: true },
          });
          return id;
        };
        for (let i = 1; i <= 1200; i++)
          items.push(await save(`Синтетическая позиция ${String(i).padStart(4, '0')}`, 'g'));
        const bun = await save('Синтетическая булка', 'pcs');
        await save('Синтетическое масло', 'ml');
        const supplier = randomUUID();
        await command(ctx, {
          type: 'supplier_save',
          id: supplier,
          expected_revision: 0,
          payload: { name: 'Поставщик 1', kind: 'supplier', active: true },
        });
        for (const [unit, price] of [
          ['kg', '150050'],
          ['g', '150'],
        ])
          await command(ctx, {
            type: 'supplier_price_save',
            supplier_id: supplier,
            ingredient_id: items[0],
            unit,
            valid_from: '2026-11-01',
            price_minor: price,
            expected_revision: 0,
          });
        const rows = [
          'Поставщик;Товар;Ед. изм.;Цена;Дата;Артикул',
          // 1200 prices over «Поставщик 1» (existing) and four new suppliers; row 2 is unchanged.
          ...Array.from(
            { length: 1200 },
            (_, i) =>
              `${i % 5 === 0 ? 'Поставщик 1' : `Поставщик ${10 + (i % 5)}`};Синтетическая позиция ${String(i + 1).padStart(4, '0')};кг;${i === 0 ? '1 500,50' : `${1000 + i},25`};01.11.2026;A${i}`,
          ),
          'Поставщик 10;Синтетическая булка;шт;120;02.11.2026;B1',
          'Поставщик 10;Синтетическая булка;шт;120;02.11.2026;B1',
          'Поставщик 10;Синтетическая неизвестная позиция;кг;100;01.11.2026;B2',
          'Поставщик 10;Синтетическое масло;кг;100;01.11.2026;B3',
          'Поставщик 1;Синтетическая позиция 0001;г;1,60;01.11.2026;B4',
          'Поставщик 11;Синтетическая булка;шт;0,555;01.11.2026;B5',
          ';Синтетическая булка;шт;100;01.11.2026;B6',
          'Поставщик 12;Синтетическая булка;уп;100;01.11.2026;B7',
          'Поставщик 13;Синтетическая булка;шт;100;31.02.2026;B8',
          `Поставщик 13;Синтетическая булка;шт;100;01.11.2026;B9`,
          'Поставщик 14;Синтетическая булка;шт;130;03.11.2026;C1',
          'Поставщик 14;Синтетическая булка;шт;140;03.11.2026;C2',
          'Поставщик 14;Синтетическая булка;шт;150;04.11.2026;C3',
        ];
        const file = join(dir, 'iiko-prices.csv');
        await writeFile(file, '﻿' + rows.join('\r\n') + '\r\n');
        const token = join(dir, 'credential.json');
        await writeFile(token, JSON.stringify(ctx.manager), { mode: 0o600 });
        const base = ['--file', file, '--branch', ctx.branch, '--token-file', token];
        const api = ['--api', ctx.upstream];
        const state = async () => ({
          suppliers: await n('bo_suppliers'),
          prices: await n('bo_supplier_prices'),
          batches: await n('bo_supplier_price_imports'),
        });
        const start = await state();
        assert.deepEqual(start, { suppliers: 1, prices: 2, batches: 0 });

        // Dry run: the Russian report and the plan file; nothing is written.
        const report = await cli([...base, ...api]);
        assert.equal(report.code, 0, report.err);
        for (const words of [
          'Импорт цен поставщиков - проверка, в PickChick ничего не записано.',
          'Сопоставлено строк: 1203',
          'Новых поставщиков: 5',
          'позиция не найдена: 1',
          'единица не подходит: 2',
          'повторы в файле: 3',
          'на этот день уже другая цена: 1',
          'ошибка в строке: 3',
          'Не используются колонки: Артикул',
        ])
          assert.ok(report.stdout.includes(words), words);
        const planned = await cli([...base, ...api, '--json']);
        assert.equal(planned.code, 0, planned.err);
        assert.equal(planned.out.event, 'supplier_prices_import_planned');
        assert.match(planned.out.plan_sha256, /^[0-9a-f]{64}$/);
        assert.equal(planned.out.plan_file, file + '.plan.json');
        assert.deepEqual(planned.out.counts, {
          rows: 1213,
          matched: 1203,
          new_prices: 1202,
          unchanged: 1,
          new_suppliers: 5,
          not_found: 1,
          ambiguous: 0,
          unit_mismatch: 2,
          duplicates: 3,
          conflicts: 1,
          inactive: 0,
          invalid: 3,
          notes: 0,
        });
        assert.deepEqual(planned.out.new_suppliers, [
          'Поставщик 11',
          'Поставщик 12',
          'Поставщик 13',
          'Поставщик 14',
          'Поставщик 10',
        ]);
        assert.ok(planned.out.parts >= 3, String(planned.out.parts));
        assert.deepEqual(planned.out.ignored_columns, ['Артикул']);
        assert.deepEqual(await state(), start);
        const plan = JSON.parse(await readFile(file + '.plan.json', 'utf8'));
        const hash = plan.plan_sha256;
        assert.equal(hash, planned.out.plan_sha256);

        // --apply with another hash: refused before any request.
        const wrong = await cli([...base, ...api, '--apply', '--expected-plan', 'f'.repeat(64)]);
        assert.equal(wrong.code, 1);
        assert.match(wrong.err, /PLAN_MISMATCH/);
        assert.deepEqual(await state(), start);

        // Part 2 goes through, then its answer is lost: the run stops after it.
        const http = backofficeApi({ base: apiBase(ctx.upstream), token: ctx.manager.token });
        const flaky = async (path, body) => {
          const result = await http(path, body);
          if (body?.command?.part === 2)
            throw Object.assign(new Error('API не ответил'), { code: 'API_UNREACHABLE' });
          return result;
        };
        await assert.rejects(
          runApply({
            file,
            branch: ctx.branch,
            request: flaky,
            planPath: file + '.plan.json',
            expectedPlan: hash,
          }),
          { code: 'API_UNREACHABLE' },
        );
        const view = () =>
          ctx.backoffice.ops(ctx.manager.token, ctx.branch, 'supplier-imports', {});
        let imports = await view();
        assert.deepEqual(
          [imports.imports.length, imports.import.parts_applied, imports.import.complete],
          [1, [1, 2], false],
        );

        // The same command again sends the rest and checks every price.
        const applied = await cli([...base, ...api, '--apply', '--expected-plan', hash, '--json']);
        assert.equal(applied.code, 0, applied.err);
        assert.deepEqual(applied.out, {
          event: 'supplier_prices_import_applied',
          plan_sha256: hash,
          batch_id: plan.batch_id,
          parts: plan.parts.length,
          sent: plan.parts.length - 2,
          skipped: 2,
          already_applied: false,
          verified: true,
        });
        assert.deepEqual(await state(), { suppliers: 6, prices: 1204, batches: 1 });
        // The prices are import prices of the batch at their exact tiyn; the manual one stays.
        assert.deepEqual(
          await q(
            `SELECT p.source,count(*)::int n,sum(p.price_minor)::text total FROM bo_supplier_prices p
             WHERE p.branch_id=$1 GROUP BY p.source ORDER BY p.source`,
          ),
          [
            {
              source: 'import',
              n: 1202,
              total: String(
                Array.from({ length: 1199 }, (_, i) => (1000 + i + 1) * 100 + 25).reduce(
                  (a, b) => a + b,
                  0,
                ) +
                  12000 +
                  10000 +
                  15000,
              ),
            },
            { source: 'manual', n: 2, total: '150200' },
          ],
        );
        assert.deepEqual(
          (
            await q(
              "SELECT name,kind,active,revision FROM bo_suppliers WHERE branch_id=$1 AND name<>'Поставщик 1' ORDER BY name",
            )
          ).map((s) => [s.name, s.kind, s.active, s.revision]),
          [10, 11, 12, 13, 14].map((k) => [`Поставщик ${k}`, 'supplier', true, 1]),
        );
        // The bun of «Поставщик 14»: the agreeing day loaded, the two prices of 03.11 not.
        assert.deepEqual(
          await q(
            `SELECT p.valid_from::text,p.price_minor::text FROM bo_supplier_prices p
             JOIN bo_suppliers s ON s.id=p.supplier_id WHERE p.branch_id=$1 AND s.name='Поставщик 14'
               AND p.ingredient_id=$2`,
            [ctx.branch, bun],
          ),
          [{ valid_from: '2026-11-04', price_minor: '15000' }],
        );
        // The view for the manager: complete, with the report of the file.
        imports = await view();
        const batch = imports.import;
        assert.deepEqual(
          [
            batch.complete,
            batch.parts,
            batch.prices_created,
            batch.unchanged,
            batch.suppliers_created,
          ],
          // The unchanged row of the plan is not sent: the report keeps it (summary.counts).
          [true, plan.parts.length, 1202, 0, 5],
        );
        assert.equal(batch.file_name, 'iiko-prices.csv');
        assert.deepEqual(batch.summary.counts, planned.out.counts);
        assert.deepEqual(
          batch.summary.issues.map((i) => [i.line, i.code]),
          [
            [1203, 'DUPLICATE'],
            [1204, 'NOT_FOUND'],
            [1205, 'UNIT_MISMATCH'],
            [1206, 'PRICE_EXISTS'],
            [1207, 'PRICE_INVALID'],
            [1208, 'SUPPLIER_REQUIRED'],
            [1209, 'UNIT_UNKNOWN'],
            [1210, 'DATE_INVALID'],
            [1212, 'DUPLICATE_CONFLICT'],
            [1213, 'DUPLICATE_CONFLICT'],
          ],
        );
        assert.deepEqual(
          batch.suppliers.map((s) => [s.name, s.created]),
          [['Поставщик 1', false], ...[10, 11, 12, 13, 14].map((k) => [`Поставщик ${k}`, true])],
        );

        // A repeat of the apply: nothing sent; the same file planned again: nothing to load.
        const again = await cli([...base, ...api, '--apply', '--expected-plan', hash, '--json']);
        assert.equal(again.code, 0, again.err);
        assert.deepEqual([again.out.sent, again.out.already_applied], [0, true]);
        const replan = await cli([...base, ...api, '--json', '--plan', join(dir, 'replan.json')]);
        assert.equal(replan.code, 0, replan.err);
        assert.equal(replan.out.plan_sha256, null);
        assert.deepEqual(
          [
            replan.out.counts.new_prices,
            replan.out.counts.unchanged,
            replan.out.counts.new_suppliers,
          ],
          [0, 1203, 0],
        );
        const nothing = await cli([...base, ...api, '--plan', join(dir, 'replan.json')]);
        assert.match(
          nothing.stdout,
          /Загружать нечего: все сопоставленные цены уже есть в PickChick/,
        );
        const empty = await cli([
          ...base,
          ...api,
          '--plan',
          join(dir, 'replan.json'),
          '--apply',
          '--expected-plan',
          'f'.repeat(64),
        ]);
        assert.equal(empty.code, 1);
        assert.match(empty.err, /PLAN_EMPTY/);
        assert.deepEqual(await state(), { suppliers: 6, prices: 1204, batches: 1 });

        // A stale plan: after it, somebody enters another price for its row by hand.
        const late = join(dir, 'late.csv');
        await writeFile(
          late,
          'Поставщик;Товар;Ед.;Цена;Дата\r\nПоставщик 1;Синтетическая булка;шт;125;05.11.2026\r\n',
        );
        const lateBase = ['--file', late, '--branch', ctx.branch, '--token-file', token, ...api];
        const latePlan = await cli([...lateBase, '--json']);
        assert.equal(latePlan.code, 0, latePlan.err);
        await command(ctx, {
          type: 'supplier_price_save',
          supplier_id: supplier,
          ingredient_id: bun,
          unit: 'pcs',
          valid_from: '2026-11-05',
          price_minor: '13000',
          expected_revision: 0,
        });
        const stale = await cli([
          ...lateBase,
          '--apply',
          '--expected-plan',
          latePlan.out.plan_sha256,
        ]);
        assert.equal(stale.code, 1);
        assert.match(stale.err, /STALE_PLAN/);
        assert.equal(await n('bo_supplier_price_imports'), 1);

        // An analyst may not import: refused at the dry run.
        const analyst = await provisionCatalogManager(ctx.cloud.pool, {
          organization_id: ctx.org,
          name: 'Синтетический аналитик',
          branch_ids: [ctx.branch],
        });
        await grantBackoffice(ctx.cloud.pool, analyst.actor_id, ctx.branch, 'analyst');
        const analystToken = join(dir, 'analyst.json');
        await writeFile(analystToken, JSON.stringify(analyst), { mode: 0o600 });
        const refused = await cli([
          '--file',
          late,
          '--branch',
          ctx.branch,
          '--token-file',
          analystToken,
          ...api,
        ]);
        assert.equal(refused.code, 1);
        assert.match(refused.err, /FORBIDDEN/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    { roles: true, stockV2: true, supply: true },
  ));

test('supplier prices with the supply flag off: the dry run is refused, nothing written', () =>
  withCatalog(
    async (ctx) => {
      const dir = await mkdtemp(join(tmpdir(), 'pickchick-supplier-prices-off-'));
      try {
        const file = join(dir, 'prices.csv');
        await writeFile(file, 'Поставщик;Товар;Ед.;Цена;Дата\r\nПоставщик 1;Х;шт;1;01.11.2026\r\n');
        const token = join(dir, 'credential.json');
        await writeFile(token, JSON.stringify(ctx.manager), { mode: 0o600 });
        const out = await cli([
          '--file',
          file,
          '--branch',
          ctx.branch,
          '--token-file',
          token,
          '--api',
          ctx.upstream,
        ]);
        assert.equal(out.code, 1);
        assert.match(out.err, /SUPPLY_OFF/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    { roles: true, stockV2: true },
  ));
