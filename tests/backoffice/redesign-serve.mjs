// Manual helper (not a test): the back office with every cutover flag on, a seeded catalog and one
// cashier order, on a real API and PostgreSQL. Writes .local/redesign/fixture.json and keeps
// serving until killed, so redesign_shots.py can photograph every section.
// Run: node --env-file=.env tests/backoffice/redesign-serve.mjs
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';

const output = new URL('../../.local/redesign/', import.meta.url);
await withCatalog(
  async (c) => {
    await c.service.seed(c.manager.token, c.branch, {
      request_id: randomUUID(),
      expected_revision: 0,
    });
    const shiftId = randomUUID();
    const openedAt = new Date(Date.now() - 3 * 3600000).toISOString();
    await c.cloud.pool.query(
      'INSERT INTO cloud_cashier_shifts(id,branch_id,device_id,sequence,payload) VALUES($1,$2,$3,1,$4)',
      [
        shiftId,
        c.branch,
        c.device,
        {
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
        },
      ],
    );
    for (let i = 0; i < 6; i++) {
      const id = randomUUID();
      const at = new Date(Date.now() - (i + 1) * 1500000).toISOString();
      const total = String(150000 + i * 23000);
      await c.cloud.pool.query(
        'INSERT INTO cloud_cashier_orders(id,branch_id,device_id,cash_shift_id,created_at,sequence,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          c.branch,
          c.device,
          shiftId,
          at,
          i + 2,
          {
            order_id: id,
            cash_shift_id: shiftId,
            created_at: at,
            total_minor: total,
            state: i % 3 ? 'paid' : 'awaiting_payment',
            version: 1,
            execution_mode: 'unpaid_service',
            kitchen_state: null,
            display_number: String(40 + i),
            lines: [
              {
                variant_id: randomUUID(),
                name: { ru: 'Комбо с крыльями', kk: '' },
                quantity: 1,
                unit_price_minor: total,
                total_minor: total,
              },
            ],
          },
        ],
      );
    }
    await mkdir(output, { recursive: true });
    await writeFile(
      new URL('fixture.json', output),
      JSON.stringify({ url: c.url + '/backoffice/', manager: c.manager, branch: c.branch }),
      { mode: 0o600 },
    );
    console.log('ready', c.url + '/backoffice/', fileURLToPath(output));
    await new Promise(() => {});
  },
  {
    staticPrefix: '/backoffice',
    roles: true,
    stockV2: true,
    salesReport: true,
    posDay: true,
    autoconsume: true,
    managerShifts: true,
    staffPositions: true,
    discounts: true,
    supply: true,
    stockReports: true,
    staffAssignment: true,
    workforce: true,
    reconciliation: true,
    expenses: true,
    remoteStops: true,
    stationPlans: true,
  },
);
