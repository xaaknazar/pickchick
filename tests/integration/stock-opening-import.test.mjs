import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withCatalog } from '../backoffice/helpers.mjs';
import { backofficeApi, runApply } from '../../scripts/stock-opening-import.mjs';
import { apiBase } from '../../scripts/catalog-menu-import.mjs';

/**
 * Cutover CC-8 end to end: the operator command against the real back-office API and
 * PostgreSQL. 18.11 inventory of 130 synthetic items plus one with a test balance; dry run;
 * --apply with the reviewed hash; a lost answer in the middle; repeats; a stale plan.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/stock-opening-import.mjs', import.meta.url));
function cli(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { timeout: 120000, env: { ...process.env, NODE_OPTIONS: '' } },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (error.code ?? 1) : 0,
          out: stdout.trim() ? JSON.parse(stdout.trim().split('\n').at(-1)) : null,
          err: stderr,
        }),
    );
  });
}
const command = (c, ctx, cmd, reason = 'Синтетическая подготовка склада') =>
  ctx.backoffice.command(c ?? ctx.manager.token, ctx.branch, {
    request_id: randomUUID(),
    reason,
    command: cmd,
  });

test('opening stock: dry run, reviewed apply in chunks, lost answer, repeats, stale plan', () =>
  withCatalog(async (ctx) => {
    const dir = await mkdtemp(join(tmpdir(), 'pickchick-opening-'));
    try {
      // 130 counted items, one bun with a balance from a test receipt, one untouched onion.
      const items = [];
      for (let i = 1; i <= 130; i++) {
        const id = randomUUID();
        const unit = i % 3 === 0 ? 'ml' : i % 3 === 1 ? 'g' : 'pcs';
        await command(null, ctx, {
          type: 'save',
          kind: 'ingredient',
          id,
          expected_revision: 0,
          payload: {
            name: `Синтетическая позиция ${String(i).padStart(3, '0')}`,
            unit,
            minimum: '0',
            active: true,
          },
        });
        items.push({ id, unit, i });
      }
      const bun = randomUUID();
      const onion = randomUUID();
      for (const [id, name, unit] of [
        [bun, 'Синтетическая булка', 'pcs'],
        [onion, 'Синтетический лук', 'g'],
      ])
        await command(null, ctx, {
          type: 'save',
          kind: 'ingredient',
          id,
          expected_revision: 0,
          payload: { name, unit, minimum: '0', active: true },
        });
      for (const [id, quantity, value] of [
        [bun, '12', '12000'],
        [onion, '800', '40000'],
      ])
        await command(null, ctx, {
          type: 'stock',
          kind: 'receipt',
          reference: 'ТЕСТ-ПРИХОД',
          lines: [{ ingredient_id: id, quantity, value_minor: value, expected_revision: 0 }],
        });
      const unitText = { g: 'кг', ml: 'л', pcs: 'шт' };
      const rows = [
        'Наименование;Количество;Ед;Сумма;Группа iiko',
        ...items.map(
          ({ unit, i }) =>
            `Синтетическая позиция ${String(i).padStart(3, '0')};${unit === 'pcs' ? i : `${i},5`};${unitText[unit]};${i} ${String(i % 1000).padStart(3, '0')},${String(i % 100).padStart(2, '0')};Склад`,
        ),
        'Синтетическая булка;40;шт;4 000,00;Склад',
        // iiko had a negative balance here: it is not transferred.
        'Синтетическая позиция 999;-2;шт;-100;Склад',
      ];
      await command(null, ctx, {
        type: 'save',
        kind: 'ingredient',
        id: randomUUID(),
        expected_revision: 0,
        payload: { name: 'Синтетическая позиция 999', unit: 'pcs', minimum: '0', active: true },
      });
      const csv = join(dir, 'inventory-18-11.csv');
      await writeFile(csv, '﻿' + rows.join('\r\n') + '\r\n');
      const token = join(dir, 'credential.json');
      await writeFile(token, JSON.stringify(ctx.manager), { mode: 0o600 });
      const base = ['--csv', csv, '--branch', ctx.branch, '--token-file', token];
      const api = ['--api', ctx.upstream];
      const documents = async () =>
        (
          await ctx.cloud.pool.query(
            'SELECT kind,reference,reason FROM bo_stock_documents WHERE branch_id=$1 ORDER BY created_at,id',
            [ctx.branch],
          )
        ).rows;
      assert.equal((await documents()).length, 2);

      // Dry run without --zero-existing: the bun's balance is refused, nothing is written.
      const refused = await cli([...base, ...api]);
      assert.equal(refused.code, 1);
      assert.equal(refused.out.ok, false);
      assert.deepEqual(
        refused.out.errors.map((e) => [e.line, e.code]),
        [[132, 'EXISTING_BALANCE']],
      );
      assert.equal(refused.out.plan_file, null);

      // Dry run with --zero-existing: the plan file and its hash; still nothing written.
      const planned = await cli([...base, ...api, '--zero-existing']);
      assert.equal(planned.code, 0, planned.err);
      assert.equal(planned.out.ok, true);
      assert.match(planned.out.plan_sha256, /^[0-9a-f]{64}$/);
      assert.equal(planned.out.plan_file, csv + '.plan.json');
      assert.deepEqual(
        [
          planned.out.summary.rows,
          planned.out.summary.set,
          planned.out.summary.zero_then_set,
          planned.out.summary.unchanged,
          planned.out.summary.negative_not_transferred,
          planned.out.summary.zero_documents,
          planned.out.summary.opening_documents,
        ],
        [132, 130, 1, 1, 1, 1, 2],
      );
      assert.deepEqual(planned.out.not_in_file, ['Синтетический лук']);
      assert.deepEqual(planned.out.ignored_columns, ['Группа iiko']);
      assert.equal(planned.out.issues[0].code, 'NEGATIVE_NOT_TRANSFERRED');
      assert.equal((await documents()).length, 2);
      const plan = JSON.parse(await readFile(csv + '.plan.json', 'utf8'));
      assert.equal(plan.plan_sha256, planned.out.plan_sha256);
      const hash = plan.plan_sha256;

      // --apply with another hash, or with a changed CSV: refused before any request.
      const wrong = await cli([...base, ...api, '--apply', '--expected-plan', 'f'.repeat(64)]);
      assert.equal(wrong.code, 1);
      assert.match(wrong.err, /PLAN_MISMATCH/);
      assert.equal((await documents()).length, 2);

      // The first opening document goes through, then its answer is lost.
      const http = backofficeApi({ base: apiBase(ctx.upstream), token: ctx.manager.token });
      let sentOpening = 0;
      const flaky = async (path, body) => {
        const result = await http(path, body);
        if (body?.command?.reference.startsWith('Начальные остатки') && ++sentOpening === 1)
          throw Object.assign(new Error('API не ответил'), { code: 'API_UNREACHABLE' });
        return result;
      };
      await assert.rejects(
        runApply({
          csv,
          branch: ctx.branch,
          request: flaky,
          planPath: csv + '.plan.json',
          expectedPlan: hash,
        }),
        { code: 'API_UNREACHABLE' },
      );
      assert.deepEqual(
        (await documents()).slice(2).map((d) => [d.kind, d.reference]),
        [
          [
            'count',
            `Обнуление перед начальными остатками ${plan.plan_core_sha256.slice(0, 12)} 1/1`,
          ],
          ['count', `Начальные остатки ${plan.plan_core_sha256.slice(0, 12)} 1/2`],
        ],
      );

      // The same command again finishes the rest and verifies every balance.
      const applied = await cli([...base, ...api, '--apply', '--expected-plan', hash]);
      assert.equal(applied.code, 0, applied.err);
      assert.deepEqual(applied.out, {
        event: 'stock_opening_applied',
        plan_sha256: hash,
        sent: 1,
        skipped: 2,
        documents: 3,
        verified: true,
      });
      const after = await documents();
      assert.equal(after.length, 5);
      assert.match(after[3].reason, new RegExp(`SHA-256 ${plan.csv_sha256}`));
      const balances = new Map(
        (
          await ctx.cloud.pool.query(
            'SELECT ingredient_id,quantity::text,value_minor::text FROM bo_stock_balances WHERE branch_id=$1',
            [ctx.branch],
          )
        ).rows.map((r) => [r.ingredient_id, [r.quantity, r.value_minor]]),
      );
      for (const { id, unit, i } of items) {
        const quantity = unit === 'pcs' ? String(i) : String(i * 1000 + 500);
        const tenge = `${i}${String(i % 1000).padStart(3, '0')}`;
        assert.deepEqual(
          balances.get(id),
          [quantity, `${tenge}${String(i % 100).padStart(2, '0')}`.replace(/^0+(?=\d)/, '')],
          `item ${i}`,
        );
      }
      // The bun: counted to 0 first, then set at the inventory value (not the old average).
      assert.deepEqual(balances.get(bun), ['40', '400000']);
      assert.deepEqual(balances.get(onion), ['800', '40000'], 'not in the file: untouched');

      // Repeats change nothing; a new plan of the same file has nothing left to do.
      const again = await cli([...base, ...api, '--apply', '--expected-plan', hash]);
      assert.equal(again.code, 0, again.err);
      assert.equal(again.out.sent, 0);
      const replan = await cli([...base, ...api, '--plan', join(dir, 'replan.json')]);
      assert.equal(replan.code, 0, replan.err);
      assert.equal(replan.out.summary.documents, 0);
      assert.equal(replan.out.summary.unchanged, 132);
      assert.equal((await documents()).length, 5);
      const audit = await ctx.cloud.pool.query(
        "SELECT count(*)::int n FROM bo_audit WHERE branch_id=$1 AND action LIKE 'stock%'",
        [ctx.branch],
      );
      assert.ok(audit.rows[0].n >= 5);

      // A plan made before somebody else's waste is refused before anything is sent.
      await writeFile(
        join(dir, 'second.csv'),
        'name;quantity;unit;total_value_tenge\r\nСинтетический лук;1;кг;500\r\n',
      );
      const second = [
        '--csv',
        join(dir, 'second.csv'),
        '--branch',
        ctx.branch,
        '--token-file',
        token,
        ...api,
      ];
      const secondPlan = await cli([...second, '--zero-existing']);
      assert.equal(secondPlan.code, 0, secondPlan.err);
      await command(null, ctx, {
        type: 'stock',
        kind: 'waste',
        reference: 'СП-1',
        lines: [{ ingredient_id: onion, quantity: '100', value_minor: '0', expected_revision: 1 }],
      });
      const stale = await cli([
        ...second,
        '--apply',
        '--expected-plan',
        secondPlan.out.plan_sha256,
      ]);
      assert.equal(stale.code, 1);
      assert.match(stale.err, /STALE_PLAN/);
      assert.equal((await documents()).length, 6);
      // The token never reaches the output.
      for (const run of [refused, planned, wrong, applied, again, replan, secondPlan, stale])
        assert.equal(
          JSON.stringify(run).includes(ctx.manager.token),
          false,
          'token must not be printed',
        );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }));

test('opening stock: an analyst cannot plan, a credential readable by others is refused', () =>
  withCatalog(async (ctx) => {
    const dir = await mkdtemp(join(tmpdir(), 'pickchick-opening-'));
    try {
      const csv = join(dir, 'inventory.csv');
      await writeFile(csv, 'name;quantity;unit;total_value_tenge\r\nx;1;шт;1\r\n');
      const token = join(dir, 'credential.json');
      await writeFile(token, JSON.stringify(ctx.manager), { mode: 0o644 });
      const open = await cli([
        '--csv',
        csv,
        '--branch',
        ctx.branch,
        '--token-file',
        token,
        '--api',
        ctx.upstream,
      ]);
      assert.equal(open.code, 1);
      assert.match(open.err, /chmod 600/);
      const { grantBackoffice } = await import('../../packages/backoffice-core/dist/index.js');
      await grantBackoffice(ctx.cloud.pool, ctx.manager.actor_id, ctx.branch, 'analyst');
      await writeFile(join(dir, 'private.json'), JSON.stringify(ctx.manager), { mode: 0o600 });
      const analyst = await cli([
        '--csv',
        csv,
        '--branch',
        ctx.branch,
        '--token-file',
        join(dir, 'private.json'),
        '--api',
        ctx.upstream,
      ]);
      assert.equal(analyst.code, 1);
      assert.match(analyst.err, /FORBIDDEN/);
      const usage = await cli(['--csv', csv]);
      assert.equal(usage.code, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }));
