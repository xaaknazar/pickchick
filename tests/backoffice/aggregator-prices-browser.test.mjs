// Cutover CC-3: the real back-office editor (Chromium) keeps every product field on edit and
// shows the aggregator price fields only while they are in use. See aggregator_prices_ui.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';

test('aggregator price fields: round trip keeps every product field, flag off blocks publication', () =>
  withCatalog(
    async (ctx) => {
      const output = new URL('../../.local/backoffice-aggregator-prices/', import.meta.url);
      await mkdir(output, { recursive: true, mode: 0o700 });
      const temp = await mkdtemp(fileURLToPath(new URL('run-', output))),
        file = temp + '/fixture.json';
      try {
        await writeFile(
          file,
          JSON.stringify({
            url: ctx.url + '/backoffice/',
            apiUrl: ctx.url,
            manager: ctx.manager,
            branch: ctx.branch,
            output: fileURLToPath(output),
          }),
          { mode: 0o600 },
        );
        const exit = await new Promise((resolve, reject) => {
          const child = spawn(
            process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
            [fileURLToPath(new URL('aggregator_prices_ui.py', import.meta.url)), file],
            { stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32' },
          );
          const timer = setTimeout(() => {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          }, 150000);
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('close', (code, signal) => {
            clearTimeout(timer);
            if (signal) reject(new Error(`Aggregator prices browser terminated by ${signal}`));
            else resolve(code);
          });
        });
        assert.equal(exit, 0, 'Browser aggregator price flow must pass');
        // Nothing was published: the refusal happened in the browser.
        assert.equal(
          (await ctx.cloud.pool.query('SELECT count(*)::int n FROM catalog_publications')).rows[0]
            .n,
          0,
        );
        const draft = (
          await ctx.cloud.pool.query(
            'SELECT d.payload FROM catalog_branch_heads h JOIN catalog_draft_versions d ON d.branch_id=h.branch_id AND d.revision=h.draft_revision WHERE h.branch_id=$1',
            [ctx.branch],
          )
        ).rows[0].payload;
        const product = (id) => draft.products.find((p) => p.id === id);
        assert.deepEqual(product('pick-combo').channel_prices_minor, { yandex_eda: '469000' });
        assert.equal(product('pick-combo').kitchen_route, 'prep');
        assert.deepEqual(product('pick-combo').combo_components, [
          { product_id: 'fingers', quantity: 3 },
        ]);
        assert.equal(product('pick-combo').modifier_groups[0].options[0].linked_product_id, 'cola');
        assert.equal(product('pick-combo').modifier_groups[0].options[1].nutrition_multiplier, 1.5);
        assert.deepEqual(product('burger').channel_prices_minor, { glovo: '279000' });
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
    { staticPrefix: '/backoffice' },
  ));
