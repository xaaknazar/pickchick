import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
test('full backoffice browser uses real PostgreSQL, scoped manager and durable commands', () =>
  withCatalog(
    async (c) => {
      await c.service.seed(c.manager.token, c.branch, {
        request_id: randomUUID(),
        expected_revision: 0,
      });
      const shiftId = randomUUID();
      const cashierOrderId = randomUUID();
      const openedAt = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
      const orderedAt = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
      const shift = {
        shift_id: shiftId,
        terminal_id: randomUUID(),
        staff_id: randomUUID(),
        state: 'open',
        opened_at: openedAt,
        closed_at: null,
        opening_cash_minor: '100000',
        cash_in_minor: '25000',
        cash_out_minor: '10000',
        expected_cash_minor: '115000',
        counted_cash_minor: null,
        discrepancy_minor: null,
      };
      await c.cloud.pool.query(
        'INSERT INTO cloud_cashier_shifts(id,branch_id,device_id,sequence,payload) VALUES($1,$2,$3,1,$4)',
        [shiftId, c.branch, c.device, shift],
      );
      await c.cloud.pool.query(
        'INSERT INTO cloud_cashier_orders(id,branch_id,device_id,cash_shift_id,created_at,sequence,payload) VALUES($1,$2,$3,$4,$5,2,$6)',
        [
          cashierOrderId,
          c.branch,
          c.device,
          shiftId,
          orderedAt,
          {
            order_id: cashierOrderId,
            cash_shift_id: shiftId,
            created_at: orderedAt,
            total_minor: '149000',
            state: 'awaiting_payment',
            version: 1,
            execution_mode: 'unpaid_service',
            kitchen_state: null,
            display_number: '42',
            lines: [
              {
                variant_id: randomUUID(),
                name: { ru: 'Synthetic shift combo', kk: '' },
                quantity: 1,
                unit_price_minor: '149000',
                total_minor: '149000',
              },
            ],
          },
        ],
      );
      const output = new URL('../../.local/backoffice-full/', import.meta.url);
      await mkdir(output, { recursive: true });
      const temp = await mkdtemp(fileURLToPath(new URL('run-', output))),
        file = temp + '/fixture.json';
      try {
        await writeFile(
          file,
          JSON.stringify({
            url: c.url + '/backoffice/',
            manager: c.manager,
            branch: c.branch,
            shiftId,
            output: fileURLToPath(output),
          }),
          { mode: 0o600 },
        );
        const code = await new Promise((resolve, reject) => {
          const p = spawn(
            process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
            [fileURLToPath(new URL('browser_operations.py', import.meta.url)), file],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
          p.stdout.on('data', (d) => process.stdout.write(d));
          p.stderr.on('data', (d) => process.stderr.write(d));
          p.on('error', reject);
          p.on('exit', resolve);
        });
        assert.equal(code, 0);
        const state = await c.backoffice.read(c.manager.token, c.branch);
        assert.equal(state.stock[0].quantity, '800');
        assert.equal(state.stock[0].value_minor, '280000');
        assert.equal(state.documents.length, 3);
        assert.ok(state.audit.length >= 7);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
    { staticPrefix: '/backoffice' },
  ));
