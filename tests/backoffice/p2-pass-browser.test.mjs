// Lane bo-ui2 step 6: one browser pass over every screen of the second wave with every flag on
// (the bo-ui flags and BACKOFFICE_SUPPLY_ENABLED, BACKOFFICE_STOCK_REPORTS_ENABLED,
// BACKOFFICE_STAFF_ASSIGNMENT_ENABLED) and every role (Chromium; p2_pass_ui.py). The manager, the
// shift manager, the accountant and the analyst open «Закупки» (the requests, a received request,
// the editor, the receipt by request, the suppliers, the prices of a supplier, the price import),
// «Остатки» («Остатки», «Движение» by position, «К заказу», the ingredient card), «Расстановка»
// (the grid and its dialog), «Табель» with the stations and the closing checklist of the manager
// shift at 1440x900 and 390x844. On every screen: no page error, no horizontal page scroll, no
// long dash, no «undefined», «NaN», «[object Object]» or raw ISO time in the text, every visible
// button and every open dialog inside the window, and the role sees exactly its buttons enabled.
// Real API and PostgreSQL behind the operator proxy, synthetic data only. The pass only looks: no
// command is sent from the browser. Screenshots: .local/backoffice-p2-pass/<role>-<screen>-<width>.png.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import {
  MANAGER_SHIFT_TEMPLATE_V1,
  designateBackoffice,
  grantBackoffice,
} from '../../packages/backoffice-core/dist/index.js';
import {
  almaty,
  noon,
  pos,
  post,
} from '../../packages/backoffice-core/tests/stock-reports-fixture.mjs';
import {
  backofficeApi,
  parseProfile,
  runApply,
  runPlan,
} from '../../scripts/supplier-prices-import.mjs';
import { apiBase } from '../../scripts/catalog-menu-import.mjs';

const FLAGS = {
  roles: true,
  stockV2: true,
  posDay: true,
  managerShifts: true,
  staffPositions: true,
  discounts: true,
  workforce: true,
  supply: true,
  stockReports: true,
  staffAssignment: true,
};
const output = new URL('../../.local/backoffice-p2-pass/', import.meta.url);
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
/**
 * HH:MM of the business day at `fraction` of the time since its start (06:00) up to now: today's
 * intervals are always in the past, whatever the hour of the run (a time before 06:00 is the
 * night after the business day).
 */
function businessTime(fraction) {
  const now = new Date(Date.now() + 5 * 3600000); // Almaty clock as UTC fields
  const minutes = (now.getUTCHours() * 60 + now.getUTCMinutes() - 360 + 1440) % 1440;
  const at = (360 + Math.floor(minutes * fraction)) % 1440;
  return `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
}
/**
 * Every second-wave screen with data: 20 days of stock history (meat used by production and sold,
 * buns sold, boxes with a waste and its storno), suppliers with prices and two price imports
 * through the script, requests in every state, staff cards with positions, today's intervals
 * (one moved, one outside the position with the manager's reason) and an open manager shift.
 */
async function seed(ctx) {
  const command = (c, reason = 'Синтетическая подготовка прохода') =>
    ctx.backoffice.command(ctx.manager.token, ctx.branch, {
      request_id: randomUUID(),
      reason,
      command: c,
    });
  const ids = {};
  for (const [key, name, unit, minimum, extra] of [
    ['fillet', 'Синтетическое филе', 'g', '2000', { meat: true, supply_kind: 'supplier' }],
    ['bun', 'Синтетическая булка', 'pcs', '10', { supply_kind: 'bakery' }],
    ['box', 'Синтетическая коробка', 'pcs', '100', { supply_kind: 'household' }],
    ['breaded', 'Синтетическая заготовка', 'g', '0', { supply_kind: 'central_kitchen' }],
    ['salt', 'Синтетическая соль', 'g', '500', {}],
  ]) {
    ids[key] = randomUUID();
    await command({
      type: 'save',
      kind: 'ingredient',
      id: ids[key],
      expected_revision: 0,
      payload: { name, unit, minimum, active: true, ...extra },
    });
  }
  const actor = ctx.manager.actor_id;
  await post(ctx, actor, noon(-20), 'receipt', [
    [ids.fillet, '24300', '7290000'],
    [ids.bun, '50', '50000'],
    [ids.box, '500', '250000'],
  ]);
  for (let d = -14; d <= -1; d++) {
    await post(ctx, actor, noon(d), 'production', {
      inputs: [[ids.fillet, '1000']],
      output: [ids.breaded, '900'],
    });
    await post(
      ctx,
      actor,
      noon(d, 13),
      'consumption',
      [
        [ids.fillet, '500'],
        [ids.bun, '3'],
      ],
      { source_ref: pos() },
    );
  }
  const waste = await post(ctx, actor, noon(-3, 15), 'waste', [[ids.box, '10']]);
  await post(ctx, actor, noon(-2, 15), 'reversal', { of: waste });

  // Suppliers of every kind, one archived, prices in force.
  const suppliers = {};
  for (const [key, name, kind, active] of [
    ['p1', 'Поставщик 1', 'supplier', true],
    ['bakery', 'Пекарня 1', 'bakery', true],
    ['kitchen', 'Цех 1', 'central_kitchen', true],
    ['old', 'Поставщик 9', 'supplier', false],
  ]) {
    suppliers[key] = randomUUID();
    await command({
      type: 'supplier_save',
      id: suppliers[key],
      expected_revision: 0,
      payload: { name, kind, active: true },
    });
    if (!active)
      await command({
        type: 'supplier_save',
        id: suppliers[key],
        expected_revision: 1,
        payload: { name, kind, active: false },
      });
  }
  const today = almaty(0);
  for (const [supplier, ingredient, unit, price] of [
    [suppliers.p1, ids.fillet, 'kg', '250000'],
    [suppliers.p1, ids.box, 'pcs', '45000'],
    [suppliers.bakery, ids.bun, 'pcs', '10000'],
  ])
    await command({
      type: 'supplier_price_save',
      supplier_id: supplier,
      ingredient_id: ingredient,
      unit,
      valid_from: almaty(-10),
      price_minor: price,
      expected_revision: 0,
    });

  // Two price imports through the script against the real API, the second with a report.
  const files = await mkdtemp(join(fileURLToPath(output), 'files-'));
  const request = backofficeApi({ base: apiBase(ctx.upstream), token: ctx.manager.token });
  const load = async (name, lines) => {
    const file = join(files, name);
    await writeFile(file, ['Поставщик;Товар;Ед. изм.;Цена;Дата', ...lines].join('\r\n'));
    const { plan } = await runPlan({
      file,
      branch: ctx.branch,
      request,
      profile: parseProfile('iiko'),
      planPath: file + '.plan.json',
    });
    return runApply({
      file,
      branch: ctx.branch,
      request,
      planPath: file + '.plan.json',
      expectedPlan: plan.plan_sha256,
    });
  };
  try {
    await load('prices-1.csv', [
      'Поставщик 1;Синтетическая соль;кг;180;01.11.2026',
      'Поставщик 2;Синтетическая булка;шт;120;01.11.2026',
    ]);
    await load('prices-2.csv', [
      'Поставщик 3;Синтетическая булка;шт;130;02.11.2026',
      'Поставщик 1;Синтетическая неизвестная позиция;кг;100;01.11.2026',
      'Поставщик 1;Синтетическая булка;кг;100;01.11.2026',
    ]);
  } finally {
    await rm(files, { recursive: true, force: true });
  }

  // Requests: a submitted one to the supplier (received in the pass by nobody), a draft to the
  // bakery, a received one from the central kitchen and a cancelled one.
  const req = async (kind, supplier, lines, note = null) => {
    const id = randomUUID();
    await command({
      type: 'supply_request_save',
      id,
      expected_revision: 0,
      payload: {
        kind,
        supplier_id: supplier,
        needed_by: almaty(1),
        note,
        lines: lines.map(([ingredient_id, qty]) => ({ ingredient_id, qty })),
      },
    });
    return id;
  };
  const submitted = await req(
    'supplier',
    suppliers.p1,
    [
      [ids.fillet, '1500'],
      [ids.box, '50'],
      [ids.salt, '1000'],
    ],
    'К утру, до 09:00',
  );
  await command({ type: 'supply_request_submit', id: submitted, expected_revision: 1 });
  await req('bakery', suppliers.bakery, [[ids.bun, '20']]);
  const received = await req('central_kitchen', suppliers.kitchen, [[ids.breaded, '2000']]);
  await command({ type: 'supply_request_submit', id: received, expected_revision: 1 });
  const breaded = (
    await ctx.cloud.pool.query(
      'SELECT revision FROM bo_stock_balances WHERE branch_id=$1 AND ingredient_id=$2',
      [ctx.branch, ids.breaded],
    )
  ).rows[0];
  await command({
    type: 'supply_request_receive',
    id: received,
    expected_revision: 2,
    reference: 'НАК-ПРОХОД-1',
    document_date: today,
    lines: [
      {
        ingredient_id: ids.breaded,
        quantity: '1800',
        value_minor: '540000',
        expected_revision: breaded.revision,
      },
    ],
  });
  const cancelled = await req('household', null, [[ids.box, '100']]);
  await command(
    { type: 'supply_request_cancel', id: cancelled, expected_revision: 1 },
    'Коробки привезут со следующей поставкой',
  );

  // Staff with positions, an open manager shift and today's intervals.
  for (const [key, name, position, extra] of [
    ['assembler', 'Синтетический сборщик', 'assembler', ['issue']],
    ['cashier', 'Синтетическая кассир', 'cashier', []],
    ['fryer', 'Синтетический жарщик', 'fryer', []],
    ['runner', 'Синтетический раннер', 'runner', []],
  ]) {
    ids[key] = randomUUID();
    await command({
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
  await command({
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
  const day = (
    await ctx.cloud.pool.query(
      `SELECT (((clock_timestamp() AT TIME ZONE 'Asia/Almaty') - interval '6 hours')::date)::text d`,
    )
  ).rows[0].d;
  const assign = (employee, station, time, revision = 0, override) =>
    command({
      type: 'staff_assign',
      employee_id: employee,
      station_code: station,
      business_date: day,
      time,
      expected_revision: revision,
      ...(override ? { override_reason: override } : {}),
    });
  await assign(ids.assembler, 'assembly_hall', businessTime(0.2));
  await assign(ids.assembler, 'issue', businessTime(0.5), 1);
  await assign(ids.cashier, 'cashier', businessTime(0.3));
  await assign(ids.fryer, 'cashier', businessTime(0.4), 0, 'Кассир на перерыве, жарщик подменяет');
  return { ...ids, start: almaty(-20) };
}
async function browser(ctx, extra) {
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
        output: fileURLToPath(output),
        ...extra,
      }),
      { mode: 0o600 },
    );
    return await new Promise((resolve, reject) => {
      const child = spawn(
        process.env.BACKOFFICE_TEST_PYTHON ?? 'python3',
        [fileURLToPath(new URL('p2_pass_ui.py', import.meta.url)), file],
        { stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32' },
      );
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, 540000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (signal) reject(new Error(`P2 pass browser terminated by ${signal}`));
        else resolve(code);
      });
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test(
  'P2 pass: every second-wave screen, every role, 1440 and 390 px, every flag on',
  { timeout: 600000 },
  () =>
    withCatalog(
      async (ctx) => {
        await mkdir(output, { recursive: true, mode: 0o700 });
        const ids = await seed(ctx);
        const shift = await person(ctx, 'Синтетический начальник смены', 'shift_manager');
        const accountant = await person(ctx, 'Синтетический бухгалтер', 'accountant');
        const analyst = await person(ctx, 'Синтетический аналитик', null);
        const count = async () =>
          (await ctx.cloud.pool.query('SELECT count(*)::int n FROM bo_commands')).rows[0].n;
        const before = await count();
        assert.equal(
          await browser(ctx, { ...ids, shift, accountant, analyst }),
          0,
          'The P2 pass in the browser must pass',
        );
        // The pass only looks: no command was sent from the browser.
        assert.equal(await count(), before);
      },
      { staticPrefix: '/backoffice', ...FLAGS },
    ),
);
