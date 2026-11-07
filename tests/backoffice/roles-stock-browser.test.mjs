// Cutover CC-5/CC-6: the real back office (Chromium) with BACKOFFICE_ROLES_ENABLED and
// BACKOFFICE_STOCK_V2_ENABLED: waste reason, receipt details, stock report, shift manager menus.
// See roles_stock_ui.py. Run twice: on the cloud lane schema (074, its stock page) and on 075,
// where stock v2 carries lane bo-ui's stock P1 («Списания» and «Движение» instead of one tab).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { designateBackoffice, grantBackoffice } from '../../packages/backoffice-core/dist/index.js';

const MIGRATIONS = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));
const flow = (p1, cloudMigrationDirectory) =>
  withCatalog(
    async (ctx) => {
      const ingredient = randomUUID();
      await ctx.backoffice.command(ctx.manager.token, ctx.branch, {
        request_id: randomUUID(),
        reason: 'Synthetic setup',
        command: {
          type: 'save',
          kind: 'ingredient',
          id: ingredient,
          expected_revision: 0,
          payload: { name: 'Синтетическая булка', unit: 'pcs', minimum: '0', active: true },
        },
      });
      await ctx.backoffice.command(ctx.manager.token, ctx.branch, {
        request_id: randomUUID(),
        reason: 'Synthetic setup',
        command: {
          type: 'stock',
          kind: 'receipt',
          reference: 'НАК-0',
          lines: [
            {
              ingredient_id: ingredient,
              quantity: '20',
              value_minor: '20000',
              expected_revision: 0,
            },
          ],
        },
      });
      const shift = await provisionCatalogManager(ctx.cloud.pool, {
        organization_id: ctx.org,
        name: 'Синтетический начальник смены',
        branch_ids: [ctx.branch],
      });
      await grantBackoffice(ctx.cloud.pool, shift.actor_id, ctx.branch, 'analyst');
      await designateBackoffice(
        ctx.cloud.pool,
        shift.actor_id,
        ctx.branch,
        'shift_manager',
        'Т7: начальник смены',
      );
      const output = new URL('../../.local/backoffice-roles-stock/', import.meta.url);
      await mkdir(output, { recursive: true, mode: 0o700 });
      const temp = await mkdtemp(fileURLToPath(new URL('run-', output))),
        file = temp + '/fixture.json';
      try {
        await writeFile(
          file,
          JSON.stringify({
            url: ctx.url + '/backoffice/',
            manager: ctx.manager,
            shift,
            ingredient,
            p1,
            output: fileURLToPath(output),
          }),
          { mode: 0o600 },
        );
        const exit = await new Promise((resolve, reject) => {
          const child = spawn(
            process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
            [fileURLToPath(new URL('roles_stock_ui.py', import.meta.url)), file],
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
            if (signal) reject(new Error(`Roles and stock browser terminated by ${signal}`));
            else resolve(code);
          });
        });
        assert.equal(exit, 0, 'Browser roles and stock v2 flow must pass');
        const documents = (
          await ctx.cloud.pool.query(
            `SELECT d.kind,d.reference,d.reason_code,d.meta,m.name actor FROM bo_stock_documents d
             JOIN catalog_managers m ON m.id=d.actor_id WHERE d.branch_id=$1 ORDER BY d.created_at`,
            [ctx.branch],
          )
        ).rows;
        assert.deepEqual(documents, [
          {
            kind: 'receipt',
            reference: 'НАК-0',
            reason_code: null,
            meta: null,
            actor: 'Синтетический управляющий',
          },
          {
            kind: 'waste',
            reference: 'СП-1',
            reason_code: 'hot_cabinet_expired',
            meta: null,
            actor: 'Синтетический управляющий',
          },
          {
            kind: 'receipt',
            reference: 'НАК-5',
            reason_code: null,
            meta: {
              supplier_kind: 'bakery',
              supplier_name: 'Синтетическая пекарня',
              document_date: '2026-11-18',
            },
            actor: 'Синтетический управляющий',
          },
          {
            kind: 'waste',
            reference: 'СП-2',
            reason_code: 'defect',
            meta: null,
            actor: 'Синтетический начальник смены',
          },
        ]);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
    {
      staticPrefix: '/backoffice',
      roles: true,
      stockV2: true,
      ...(cloudMigrationDirectory ? { cloudMigrationDirectory } : {}),
    },
  );

test('stock v2 and roles in the browser on the cloud lane schema (074): its stock page', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-cloud-074-browser-'));
  try {
    for (const file of await readdir(MIGRATIONS))
      if (/^\d{3}_[a-z_]+\.sql$/.test(file) && file < '075')
        await cp(join(MIGRATIONS, file), join(directory, file));
    await flow(false, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stock v2 and roles in the browser on 075: reasons, invoice details, P1 report tabs', () =>
  flow(true));
