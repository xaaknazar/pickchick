import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';

const run = (fixture) =>
  new Promise((resolve, reject) => {
    const p = spawn(
      process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
      [fileURLToPath(new URL('reconciliation-browser.py', import.meta.url)), fixture],
      { stdio: 'inherit' },
    );
    const timer = setTimeout(() => p.kill('SIGTERM'), 150000);
    p.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

test('accountant reconciles a day in the browser at 1440 and 393 px (synthetic statement)', () =>
  withCatalog(
    async (c) => {
      const output = new URL('../../.local/reconciliation-browser/', import.meta.url);
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
        assert.equal(await run(file), 0);
        const q = async (sql) => (await c.cloud.pool.query(sql)).rows[0].n;
        assert.equal(await q('SELECT count(*)::int n FROM bo_rec_lines'), 3);
        assert.equal(await q('SELECT count(*)::int n FROM bo_rec_profiles'), 1);
        assert.equal(await q("SELECT count(*)::int n FROM bo_rec_days WHERE kind='close'"), 1);
        assert.equal(await q("SELECT count(*)::int n FROM bo_rec_days WHERE kind='reopen'"), 1);
        assert.equal(await q('SELECT count(*)::int n FROM commerce_captures'), 0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    { staticPrefix: '/backoffice', reconciliation: true },
  ));
