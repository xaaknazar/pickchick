// Cutover CC-7: the sales report page of the real back office (Chromium), with
// BACKOFFICE_SALES_REPORT_ENABLED off (reports page unchanged) and on. See sales_report_ui.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
import { D, seed } from '../../packages/backoffice-core/tests/sales-report-fixture.mjs';

async function browser(ctx, mode) {
  const output = new URL('../../.local/backoffice-sales-report/', import.meta.url);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(fileURLToPath(new URL('run-', output))),
    file = temp + '/fixture.json';
  try {
    await writeFile(
      file,
      JSON.stringify({
        url: ctx.url + '/backoffice/',
        manager: ctx.manager,
        day: D,
        mode,
        output: fileURLToPath(output),
      }),
      { mode: 0o600 },
    );
    return await new Promise((resolve, reject) => {
      const child = spawn(
        process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
        [fileURLToPath(new URL('sales_report_ui.py', import.meta.url)), file],
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
        if (signal) reject(new Error(`Sales report browser terminated by ${signal}`));
        else resolve(code);
      });
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test('sales report flag off: the reports page has no sales block', () =>
  withCatalog(
    async (ctx) => {
      await seed(ctx, { manager: ctx.manager });
      assert.equal(await browser(ctx, 'off'), 0, 'Reports page without the flag must pass');
    },
    { staticPrefix: '/backoffice' },
  ));

test('sales report in the browser: channels, eight methods, refunds, no revenue, CSV, phone', () =>
  withCatalog(
    async (ctx) => {
      await seed(ctx, { manager: ctx.manager });
      assert.equal(await browser(ctx, 'on'), 0, 'Browser sales report flow must pass');
    },
    { staticPrefix: '/backoffice', salesReport: true },
  ));
