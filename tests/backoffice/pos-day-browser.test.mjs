// Lane bo-ui «Касса» and the new «Главная» in the real back office (Chromium), with
// BACKOFFICE_POS_DAY_ENABLED off (cabinet unchanged: no section, old registry) and on (with the
// sales report). The synthetic day of pos-day-fixture.mjs is seeded on today's Almaty date so the
// «Сегодня» block has data. See pos_day_ui.py. Screenshots: .local/backoffice-pos-day/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
import {
  SHIFT,
  STAFF,
  TERMINAL,
  at,
  cashierShift,
  seedDay,
} from '../../packages/backoffice-core/tests/pos-day-fixture.mjs';

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date());

async function browser(ctx, mode, day) {
  const output = new URL('../../.local/backoffice-pos-day/', import.meta.url);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(fileURLToPath(new URL('run-', output))),
    file = temp + '/fixture.json';
  try {
    await writeFile(
      file,
      JSON.stringify({
        url: ctx.url + '/backoffice/',
        manager: ctx.manager,
        day,
        mode,
        output: fileURLToPath(output),
      }),
      { mode: 0o600 },
    );
    return await new Promise((resolve, reject) => {
      const child = spawn(
        process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
        [fileURLToPath(new URL('pos_day_ui.py', import.meta.url)), file],
        { stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32' },
      );
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, 240000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (signal) reject(new Error(`POS day browser terminated by ${signal}`));
        else resolve(code);
      });
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** Two POS orders №1 of two cash desks in the cashier reports (registry rows, audit F10). */
async function registry(c, day) {
  await cashierShift(c, {
    shift: SHIFT.one,
    terminal: TERMINAL.one,
    staff: STAFF.cashier,
    opened: at(day, '09:00:00'),
    opening: '1000000',
    cash_sales: '0',
    expected: '1000000',
  });
  for (const [shift, number, time, total] of [
    [SHIFT.one, '1', '10:00:00', '250000'],
    [SHIFT.two, '1', '11:00:00', '120000'],
  ]) {
    const id = randomUUID();
    const payload = {
      order_id: id,
      cash_shift_id: shift,
      created_at: at(day, time).toISOString(),
      total_minor: total,
      state: 'paid',
      version: 1,
      execution_mode: 'pos_sale',
      kitchen_state: 'handed_over',
      display_number: number,
      lines: [
        {
          variant_id: randomUUID(),
          name: { ru: 'Синтетический бургер', kk: '' },
          quantity: 1,
          unit_price_minor: total,
          total_minor: total,
        },
      ],
    };
    await c.cloud.pool.query(
      `INSERT INTO cloud_cashier_orders(id,branch_id,device_id,cash_shift_id,created_at,sequence,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, c.branch, c.device, shift, payload.created_at, 5000 + Number(time.slice(0, 2)), payload],
    );
  }
}

test('«Касса» flag off: no section, «Главная» and the registry as before', () =>
  withCatalog(
    async (ctx) => {
      const day = today();
      await seedDay(ctx, day);
      await registry(ctx, day);
      assert.equal(await browser(ctx, 'off', day), 0, 'Cabinet without the flag must pass');
    },
    { staticPrefix: '/backoffice' },
  ));

test('«Касса» in the browser: shifts and Z, receipts, Webkassa, CSV, «Главная», registry, phone', () =>
  withCatalog(
    async (ctx) => {
      const day = today();
      await seedDay(ctx, day);
      await registry(ctx, day);
      assert.equal(await browser(ctx, 'on', day), 0, 'Browser «Касса» flow must pass');
    },
    { staticPrefix: '/backoffice', posDay: true, salesReport: true },
  ));
