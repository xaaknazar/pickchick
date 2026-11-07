// Lane bo-ui2 step 5 «Расстановка» in the real back office (Chromium; assignment_ui.py):
//   off - roles, positions, the manager shift and the time sheet on, the staff assignment off: no
//         «Расстановка» in the menu, #assignment opens «Главная», no request to
//         ops/staff-assignments, the time sheet and the closing checklist are bo-ui's;
//   on  - the staff assignment on as well: an interval left open yesterday is ended first,
//         «Поставить на станцию», «Переставить», a station outside the position with the
//         manager's reason, «Закончить», the history of the day, the shift manager (no override,
//         the reason in words), the accountant and the analyst (read only), the phone at 390 px,
//         «Расстановка заполнена» in the closing checklist and the stations in «Табель».
// Real API and PostgreSQL behind the operator proxy. Synthetic data only.
// Screenshots: .local/backoffice-assignment/ at 1440x900 and 390x844.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import {
  MANAGER_SHIFT_TEMPLATE_V1,
  designateBackoffice,
  grantBackoffice,
} from '../../packages/backoffice-core/dist/index.js';

async function person(ctx, name, designation) {
  const login = await provisionCatalogManager(ctx.cloud.pool, {
    organization_id: ctx.org,
    name,
    branch_ids: [ctx.branch],
  });
  await grantBackoffice(ctx.cloud.pool, login.actor_id, ctx.branch, 'analyst');
  if (designation)
    await designateBackoffice(
      ctx.cloud.pool,
      login.actor_id,
      ctx.branch,
      designation,
      'Синтетическое назначение',
    );
  return login;
}
const run = (ctx, command) =>
  ctx.backoffice.command(ctx.manager.token, ctx.branch, {
    request_id: randomUUID(),
    reason: 'Синтетическая подготовка',
    command,
  });
/** Cards with positions, an open manager shift and (with the feature) yesterday's open interval. */
async function seed(ctx, on) {
  const ids = {};
  for (const [key, name, position, extra] of [
    ['assembler', 'Синтетический сборщик', 'assembler', ['issue']],
    ['cashier', 'Синтетический кассир', 'cashier', []],
    ['fryer', 'Синтетический жарщик', 'fryer', []],
  ]) {
    ids[key] = randomUUID();
    await run(ctx, {
      type: 'save',
      kind: 'employee',
      id: ids[key],
      expected_revision: 0,
      payload: {
        name,
        role: 'staff',
        active: true,
        note: '',
        position_code: position,
        ...(extra.length ? { extra_position_codes: extra } : {}),
        pos_access: 'none',
      },
    });
  }
  await run(ctx, {
    type: 'manager_shift_open',
    id: randomUUID(),
    manager_employee_id: null,
    items: MANAGER_SHIFT_TEMPLATE_V1.opening.map((i) => ({
      code: i.code,
      status: 'done',
      comment: null,
    })),
    expected_revision: 0,
  });
  const [{ today, yesterday, month }] = (
    await ctx.cloud.pool.query(
      `SELECT d::text AS today,(d - 1)::text AS yesterday,
         to_char(d,'YYYY-MM') = to_char(clock_timestamp() AT TIME ZONE 'Asia/Almaty','YYYY-MM') AS month
       FROM (SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Almaty') - interval '6 hours')::date AS d) t`,
    )
  ).rows;
  if (on)
    // The cashier was left on the cash desk yesterday: ended first in the browser.
    await run(ctx, {
      type: 'staff_assign',
      employee_id: ids.cashier,
      station_code: 'cashier',
      business_date: yesterday,
      time: '12:00',
      expected_revision: 0,
    });
  return { ...ids, today, yesterday, month };
}
async function browser(ctx, mode, extra = {}) {
  const output = new URL('../../.local/backoffice-assignment/', import.meta.url);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(fileURLToPath(new URL('run-', output))),
    file = temp + '/fixture.json';
  try {
    await writeFile(
      file,
      JSON.stringify({
        url: ctx.url + '/backoffice/',
        branch: ctx.branch,
        manager: ctx.manager,
        mode,
        output: fileURLToPath(output),
        ...extra,
      }),
      { mode: 0o600 },
    );
    return await new Promise((resolve, reject) => {
      const child = spawn(
        process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
        [fileURLToPath(new URL('assignment_ui.py', import.meta.url)), file],
        { stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32' },
      );
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, 300000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (signal) reject(new Error(`Assignment browser terminated by ${signal}`));
        else resolve(code);
      });
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
const OPTIONS = {
  staticPrefix: '/backoffice',
  roles: true,
  staffPositions: true,
  managerShifts: true,
  workforce: true,
};

test('staff assignment off: no «Расстановка», no request to its view, bo-ui shift and time sheet', () =>
  withCatalog(async (ctx) => {
    const ids = await seed(ctx, false);
    assert.equal(await browser(ctx, 'off', ids), 0, 'staff assignment off must pass');
  }, OPTIONS));

test('staff assignment on: place, move, override, end, roles, phone, checklist and time sheet', () =>
  withCatalog(
    async (ctx) => {
      const ids = await seed(ctx, true);
      const shift = await person(ctx, 'Синтетический начальник смены', 'shift_manager');
      const accountant = await person(ctx, 'Синтетический бухгалтер', 'accountant');
      const analyst = await person(ctx, 'Синтетический аналитик', null);
      assert.equal(
        await browser(ctx, 'on', { ...ids, shift, accountant, analyst }),
        0,
        'the staff assignment in the browser must pass',
      );
      const q = async (sql, args = [ctx.branch]) => (await ctx.cloud.pool.query(sql, args)).rows;
      // Yesterday's interval ended at 23:00 of its own day; today: the assembler on the hall
      // table, moved to the issue and ended; the fryer by the shift manager; the cashier on the
      // fryer station with the manager's reason.
      const rows = await q(
        `SELECT a.employee_id::text e,a.station_code s,a.business_date::text d,
           (a.ended_at AT TIME ZONE 'Asia/Almaty')::text ended
         FROM bo_staff_assignments a WHERE a.branch_id=$1 ORDER BY a.started_at,a.set_at`,
      );
      assert.deepEqual(
        rows.filter((r) => r.d === ids.yesterday).map((r) => [r.e, r.s, r.ended?.slice(11, 16)]),
        [[ids.cashier, 'cashier', '23:00']],
      );
      const today = rows.filter((r) => r.d === ids.today);
      assert.deepEqual(
        today.map((r) => [r.e, r.s]).sort(),
        [
          [ids.assembler, 'assembly_hall'],
          [ids.assembler, 'issue'],
          [ids.cashier, 'fryer'],
          [ids.fryer, 'fryer'],
        ].sort(),
      );
      assert.equal(
        today.filter((r) => r.e === ids.assembler).every((r) => r.ended !== null),
        true,
      );
      const audit = await q(
        `SELECT after_value->'assignment'->>'override_reason' r FROM bo_audit
         WHERE branch_id=$1 AND action='staff_assign' AND after_value->'assignment'->>'override_reason' IS NOT NULL`,
      );
      assert.deepEqual(
        audit.map((r) => r.r),
        ['Жарщик заболел, кассир помогает'],
      );
    },
    { ...OPTIONS, staffAssignment: true },
  ));
