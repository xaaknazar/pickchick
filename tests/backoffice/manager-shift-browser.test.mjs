// Lane bo-ui step 6 «Смена менеджера» and staff positions in the real back office (Chromium;
// manager_shift_ui.py):
//   off - every flag off: no manager shift block, no request to ops/manager-shifts or
//         ops/staff-roster, the cloud lane's team columns, the old journal writable;
//   on  - roles, manager shifts and staff positions on cloud075, with today's cash desks in the
//         cloud073 tables: open with the checklist, the card with the automatic checks (closed
//         desks with -500 ₸, an unrecorded Webkassa receipt), the closing wizard with comments
//         and the handover, the checklist template, the old journal read only, positions on a
//         card and «Доступы», the roster download, the positions list, the shift manager at
//         390 px and the analyst without buttons.
// Real API and PostgreSQL behind the operator proxy, synthetic data only. Screenshots:
// .local/backoffice-manager-shift/ at 1440x900 and 390x844.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import {
  designateBackoffice,
  edgeStaffId,
  grantBackoffice,
} from '../../packages/backoffice-core/dist/index.js';
import { at, sale, zReport } from '../../packages/backoffice-core/tests/pos-day-fixture.mjs';

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date());
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
async function employee(ctx, name, extra = {}) {
  const id = randomUUID();
  await ctx.cloud.pool.query(
    `INSERT INTO bo_records(id,branch_id,organization_id,kind,revision,payload)
     VALUES($1,$2,$3,'employee',1,$4)`,
    [id, ctx.branch, ctx.org, { name, role: 'cashier', active: true, note: '', ...extra }],
  );
  return id;
}
async function browser(ctx, mode, extra = {}) {
  const output = new URL('../../.local/backoffice-manager-shift/', import.meta.url);
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
        [fileURLToPath(new URL('manager_shift_ui.py', import.meta.url)), file],
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
        if (signal) reject(new Error(`Manager shift browser terminated by ${signal}`));
        else resolve(code);
      });
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test('manager shift and positions, every flag off: the cloud lane «Смены» page', () =>
  withCatalog(
    async (ctx) => {
      await employee(ctx, 'Синтетическая кассир');
      assert.equal(await browser(ctx, 'off'), 0, '«Смены» with every flag off must pass');
    },
    { staticPrefix: '/backoffice', workforce: true },
  ));

test('manager shift and positions on: checklist, checks, wizard, template, roster, roles at 1440 and 390 px', () =>
  withCatalog(
    async (ctx) => {
      const D = today();
      const cashier = await employee(ctx, 'Синтетическая кассир');
      const managerCard = await employee(ctx, 'Синтетический менеджер смены', {
        role: 'manager',
      });
      // Today's two cash desks: both closed, desk 1 counted 500 ₸ short; one receipt waits for
      // Webkassa (11 670 ₸).
      const one = randomUUID(),
        two = randomUUID(),
        shiftTwo = randomUUID();
      const now = Date.now();
      const earlier = (minutes) => new Date(now - minutes * 60000);
      const opened = earlier(60) < at(D, '00:00:01') ? at(D, '00:00:01') : earlier(60);
      await zReport(ctx, {
        shift: randomUUID(),
        terminal: one,
        opened,
        closed: new Date(opened.getTime() + 60000),
        opening: '500000',
        cash_sales: '0',
        cash_refunds: '0',
        expected: '500000',
        counted: '450000',
        methods: [],
      });
      await zReport(ctx, {
        shift: shiftTwo,
        terminal: two,
        opened: new Date(opened.getTime() + 1000),
        closed: new Date(opened.getTime() + 120000),
        opening: '300000',
        cash_sales: '0',
        cash_refunds: '0',
        expected: '300000',
        counted: '300000',
        methods: [],
      });
      await sale(ctx, {
        shift: shiftTwo,
        terminal: two,
        number: 1,
        at: new Date(opened.getTime() + 30000),
        tenders: [['kaspi_terminal', '1167000']],
        receipt: { state: 'pending' },
      });
      const shift = await person(ctx, 'Синтетический начальник смены', 'shift_manager');
      const analyst = await person(ctx, 'Синтетический аналитик', null);
      assert.equal(
        await browser(ctx, 'on', { shift, analyst, cashier, managerCard }),
        0,
        'Manager shift and positions in the browser must pass',
      );
      const shifts = (
        await ctx.cloud.pool.query(
          'SELECT state,business_date::text,manager_employee_id,opening,closing,template_version FROM bo_manager_shifts WHERE branch_id=$1 ORDER BY opened_at',
          [ctx.branch],
        )
      ).rows;
      assert.equal(shifts.length, 2);
      assert.deepEqual(
        shifts.map((s) => [s.state, s.business_date, s.template_version]),
        [
          ['closed', D, 1],
          ['open', D, 2],
        ],
      );
      assert.equal(shifts[0].manager_employee_id, managerCard);
      assert.equal(shifts[0].closing.handover, 'Касса 1 сдала на 500 ₸ меньше, разбор утром.');
      const cashComment = shifts[0].closing.items.find((i) => i.code === 'cash_shifts');
      assert.equal(cashComment.comment, 'Касса 1: недостача 500 ₸, кассир пояснила');
      assert.equal(cashComment.check.status, 'problem');
      const card = (
        await ctx.cloud.pool.query(
          "SELECT payload FROM bo_records WHERE branch_id=$1 AND kind='employee' AND id=$2",
          [ctx.branch, cashier],
        )
      ).rows[0].payload;
      assert.deepEqual(
        [card.position_code, card.extra_position_codes, card.pos_access],
        ['cashier', ['issue'], 'cashier'],
      );
      const templates = (
        await ctx.cloud.pool.query(
          'SELECT kind,version FROM bo_branch_templates WHERE branch_id=$1 ORDER BY kind,version',
          [ctx.branch],
        )
      ).rows;
      assert.deepEqual(templates, [
        { kind: 'manager_shift', version: 2 },
        { kind: 'staff_positions', version: 2 },
      ]);
      assert.equal(typeof edgeStaffId(cashier, 'cashier'), 'string');
    },
    {
      staticPrefix: '/backoffice',
      roles: true,
      workforce: true,
      posDay: true,
      managerShifts: true,
      staffPositions: true,
    },
  ));
