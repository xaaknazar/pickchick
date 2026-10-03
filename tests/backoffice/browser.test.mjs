import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
test('browser editor uses real HTTP manager/revision backend: 24 SKU, forms, immutable retry, conflict, publish and source layout', async () =>
  withCatalog(
    async (ctx) => {
      const output = new URL('../../.local/backoffice-browser/', import.meta.url);
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
            [fileURLToPath(new URL('browser_ui.py', import.meta.url)), file],
            { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' },
          );
          child.stdout.on('data', (data) => process.stdout.write(data));
          child.stderr.on('data', (data) => process.stderr.write(data));
          console.log('[backoffice browser] Python child started');
          child.once('exit', (code, signal) => {
            console.log('[backoffice browser] Python exited', { code, signal });
            // Only this detached child's group: drain pipes held by orphan driver/browser descendants.
            if (process.platform !== 'win32') {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch {
                /* group already closed */
              }
            }
          });
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            console.error('[backoffice browser] hard timeout after 120s');
            if (process.platform !== 'win32') {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch {
                child.kill('SIGKILL');
              }
            } else child.kill('SIGKILL');
          }, 120000);
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('close', (code, signal) => {
            clearTimeout(timer);
            if (timedOut) reject(new Error('Backoffice Python browser exceeded 120s hard timeout'));
            else if (signal) reject(new Error(`Backoffice Python browser terminated by ${signal}`));
            else resolve(code);
          });
        });
        assert.equal(exit, 0, 'Browser catalog flow must pass');
        assert.equal(
          (await ctx.cloud.pool.query('SELECT count(*) FROM catalog_publications')).rows[0].count,
          '1',
        );
        assert.equal(
          (await ctx.service.publicCatalog(ctx.branch)).payload.products[0].price_minor,
          '525017',
        );
        assert.equal(
          (await ctx.cloud.pool.query('SELECT count(*) FROM test_orders')).rows[0].count,
          '0',
        );
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
    { staticPrefix: '/backoffice' },
  ));
