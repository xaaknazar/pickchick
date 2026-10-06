import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
test('accountant browser workflow uses real finance HTTP and durable PostgreSQL', () =>
  withCatalog(
    async (c) => {
      const output = new URL('../../.local/finance-browser/', import.meta.url);
      await mkdir(output, { recursive: true });
      const dir = await mkdtemp(fileURLToPath(new URL('run-', output))),
        file = dir + '/fixture.json';
      try {
        await writeFile(
          file,
          JSON.stringify({
            url: c.url + '/backoffice/',
            manager: c.manager,
            output: fileURLToPath(output),
          }),
          { mode: 0o600 },
        );
        const exit = await new Promise((resolve, reject) => {
          const p = spawn(
            process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
            [fileURLToPath(new URL('finance-browser.py', import.meta.url)), file],
            { stdio: 'inherit' },
          );
          const timer = setTimeout(() => p.kill('SIGTERM'), 120000);
          p.once('error', (e) => {
            clearTimeout(timer);
            reject(e);
          });
          p.once('exit', (code) => {
            clearTimeout(timer);
            resolve(code);
          });
        });
        assert.equal(exit, 0);
        assert.equal(
          (await c.cloud.pool.query('SELECT count(*)::int n FROM bo_finance_entries')).rows[0].n,
          1,
        );
        assert.equal(
          (await c.cloud.pool.query('SELECT count(*)::int n FROM bo_finance_voids')).rows[0].n,
          1,
        );
        assert.equal(
          (await c.cloud.pool.query('SELECT count(*)::int n FROM commerce_captures')).rows[0].n,
          0,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    { staticPrefix: '/backoffice' },
  ));
