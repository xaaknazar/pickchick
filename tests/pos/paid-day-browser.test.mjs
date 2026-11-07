// CR client-5: one paid day of a cash desk in a real browser against the real edge with
// schema026 (paid sales, pos lane): what the cashier reads on a desk that sells. The test-mode
// day of the same screens is browser.test.mjs. On an edge without schema026 (this lane alone)
// there is nothing to sell with and the day is skipped; it runs on the integration branch. With
// edge 028 (CR pos-7) the desk is numbered 2 and the day checks «Касса 2» (CR client-5 §3.2).
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { transaction } from '@pickchick/database';
import { createEdge } from '@pickchick/edge';
import { provisionFulfillment } from '@pickchick/edge-fulfillment';
import { provisionStaff, setOrdering, setStaffPin } from '@pickchick/local-orders';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import { running, withSyncDatabases } from '../helpers/sync.mjs';
import { createPosServer } from '../../apps/pos/server.mjs';

const auth = (c) => ({ sessionId: c.session_id, token: c.token });
const edgeMigrations = fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url));
const migrations = await readdir(edgeMigrations);
const schema026 = migrations.some((name) => name.startsWith('026_'));
// Edge 028 (pos lane, CR pos-7): the operator numbers the desk; without it the desk has none.
const schema028 = migrations.some((name) => name.startsWith('028_'));

/** The operator's switch (scripts/pos-sales-setup.mjs), with the audit row the edge requires. */
async function audited(pool, branch, subject, before, after, change) {
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO pos_sales_setting_changes(change_id,branch_id,subject,before,after,actor,reason)
       VALUES($1,$2,$3,$4,$5,'operator','Синтетический платный день')`,
      [randomUUID(), branch, subject, before, after],
    );
    await change(client);
  });
}

test(
  'paid desk day in the browser: no test-mode text, desk number, receipt states, «Чек», version',
  { skip: !schema026 && 'edge without schema026 (pos lane): runs on the integration branch' },
  async () => {
    await withSyncDatabases(async (ctx) => {
      const category = randomUUID();
      const item = {
        product_id: randomUUID(),
        variant_id: randomUUID(),
        category_id: category,
        name: { ru: 'Синтетическое комбо', kk: 'Синтетическое комбо' },
        currency: 'KZT',
        price_minor: '349000',
      };
      const menu = {
        schema_version: 1,
        release_id: randomUUID(),
        branch_id: ctx.branch,
        version: 1,
        published_at: new Date().toISOString(),
        items: [item],
      };
      const pool = ctx.edge.pool;
      await applyMenu(pool, ctx.branch, await publishMenu(ctx.cloud.pool, menu));
      const terminal = randomUUID();
      const staff = async (role, name, pin) => {
        const setup = { staff_id: randomUUID(), terminal_id: terminal, name, role };
        // Enrolling a PIN revokes the bootstrap session; the desk then gets a fresh one.
        await setStaffPin(
          pool,
          ctx.branch,
          auth(await provisionStaff(pool, ctx.branch, setup)),
          pin,
        );
        return provisionStaff(pool, ctx.branch, setup);
      };
      const manager = await staff('shift_manager', 'Синтетический начальник', '2468');
      await staff('cashier', 'Синтетический кассир', '1357');
      const prep = randomUUID(),
        assembly = randomUUID();
      await provisionFulfillment(pool, {
        branchId: ctx.branch,
        organizationId: ctx.org,
        deviceId: ctx.device,
        producerId: randomUUID(),
        stations: [
          { id: prep, kind: 'prep', name: 'Кухня' },
          { id: assembly, kind: 'assembly', name: 'Сборка' },
        ],
        routing: {
          version: 1,
          assemblyStationId: assembly,
          routes: [{ productId: item.product_id, stationId: prep, kind: 'prep' }],
        },
      });
      await setOrdering(pool, ctx.branch, auth(manager), randomUUID(), true, {
        expected_version: 1,
      });
      // pos_sale with cash (receipt in Webkassa) and ChocoFood (no receipt), no shift open yet.
      const { pos_service_mode: from } = (
        await pool.query('SELECT pos_service_mode FROM branch_config WHERE id=$1', [ctx.branch])
      ).rows[0];
      await audited(
        pool,
        ctx.branch,
        'pos_service_mode',
        { pos_service_mode: from },
        { pos_service_mode: 'pos_sale' },
        (c) =>
          c.query("UPDATE branch_config SET pos_service_mode='pos_sale' WHERE id=$1", [ctx.branch]),
      );
      for (const method of ['cash', 'chocofood']) {
        const old = (
          await pool.query(
            'SELECT enabled,fiscal_policy FROM pos_payment_methods WHERE branch_id=$1 AND code=$2',
            [ctx.branch, method],
          )
        ).rows[0];
        await audited(pool, ctx.branch, method, old, { ...old, enabled: true }, (c) =>
          c.query('UPDATE pos_payment_methods SET enabled=true WHERE branch_id=$1 AND code=$2', [
            ctx.branch,
            method,
          ]),
        );
      }
      // `pos-sales-setup.mjs desk --number 2` on an edge with 028: this desk is «Касса 2».
      const deskNumber = schema028 ? 2 : null;
      if (deskNumber)
        await audited(
          pool,
          ctx.branch,
          'desk_number',
          { terminal_id: terminal, desk_number: null },
          { terminal_id: terminal, desk_number: deskNumber },
          (c) =>
            c.query('UPDATE local_terminals SET desk_number=$1 WHERE id=$2', [
              deskNumber,
              terminal,
            ]),
        );
      const edge = await running(createEdge, {
        ...ctx.edge.config,
        edgeFulfillmentEnabled: true,
        edgeDeviceId: ctx.device,
      });
      const pos = createPosServer({
        edgePort: Number(new URL(edge.url).port),
        branchLabel: 'Абая 62',
        categories: { [category]: 'Комбо' },
        terminalId: terminal,
        // As pos-desktop 0.5.0 sends it in /config.json.
        appVersion: '0.5.0',
      });
      await new Promise((r) => pos.listen(0, '127.0.0.1', r));
      const output = new URL('../../.local/pos-paid-day/', import.meta.url);
      await mkdir(output, { recursive: true, mode: 0o700 });
      const temp = await mkdtemp(fileURLToPath(new URL('run-', output)));
      try {
        const file = temp + '/fixture.json';
        await writeFile(
          file,
          JSON.stringify({
            url: `http://127.0.0.1:${pos.address().port}`,
            output: fileURLToPath(output),
            desk_number: deskNumber,
          }),
          { mode: 0o600 },
        );
        const exit = await new Promise((resolve, reject) => {
          const child = spawn(
            process.env.POS_TEST_PYTHON ?? 'python3',
            [fileURLToPath(new URL('paid_day_ui.py', import.meta.url)), file],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
          child.stdout.on('data', (d) => process.stdout.write(d));
          child.stderr.on('data', (d) => process.stderr.write(d));
          child.on('error', reject);
          child.on('exit', resolve);
        });
        assert.equal(exit, 0, 'Browser scenarios must pass');
        // The edge sold and booked exactly what the screens said.
        const sales = (
          await pool.query(
            `SELECT f.state,f.receipt_number,t.method FROM pos_fiscal_receipts f
             JOIN pos_sale_tenders t ON t.order_id=f.order_id WHERE f.kind='sale' ORDER BY f.created_at`,
          )
        ).rows;
        assert.deepEqual(sales, [
          { state: 'recorded', receipt_number: 'WK-5', method: 'cash' },
          { state: 'not_required', receipt_number: null, method: 'chocofood' },
          { state: 'pending', receipt_number: null, method: 'cash' },
        ]);
        const shifts = (
          await pool.query('SELECT state,sales_mode,closing_reason FROM local_cash_shifts')
        ).rows;
        assert.deepEqual(shifts, [
          { state: 'closed', sales_mode: true, closing_reason: 'Закрытие смены' },
        ]);
        assert.equal(
          (await pool.query('SELECT count(*)::int AS n FROM local_orders')).rows[0].n,
          3,
          'no unpaid order was created',
        );
      } finally {
        await new Promise((r) => pos.close(r));
        await edge.app.close();
        await rm(temp, { recursive: true, force: true });
      }
    });
  },
);
