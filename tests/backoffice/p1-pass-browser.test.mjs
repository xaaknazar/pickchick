// Lane bo-ui step 8: one browser pass over every new or changed screen of the P1 back office with
// every flag on and every role (Chromium; p1_pass_ui.py). The manager, the shift manager, the
// accountant and the analyst open «Главная», «Касса» (three tabs), «Заказы», «Остатки» (every
// tab, including «Расхождения подсчёта», «Расход по продажам» and «Списание по продажам»),
// «Смены» («Смена менеджера» and «Сотрудники»), «Скидки» and «Журнал аудита» at 1440x900 and
// 390x844. On every screen: no page error, no horizontal page scroll, no long dash, no
// «undefined», «NaN», «[object Object]» or raw ISO time in the text, every visible button inside
// the window, and the role sees exactly its buttons («Подсчёт на закрытии», «Сторно», «Новая
// скидка», «Открыть смену» / «Закрыть смену»).
// Real API and PostgreSQL behind the operator proxy, synthetic data only. Screenshots:
// .local/backoffice-p1-pass/<role>-<screen>-<width>.png.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withCatalog } from './helpers.mjs';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import {
  MANAGER_SHIFT_TEMPLATE_V1,
  designateBackoffice,
  grantBackoffice,
  runStockConsumption,
} from '../../packages/backoffice-core/dist/index.js';
import { seedDay } from '../../packages/backoffice-core/tests/pos-day-fixture.mjs';
import {
  balances,
  kitchen,
  linkFixture,
  posSale,
  publishMenuFixture,
  stockFixture,
} from '../../packages/backoffice-core/tests/consumption-fixture.mjs';

const FLAGS = {
  roles: true,
  stockV2: true,
  salesReport: true,
  posDay: true,
  autoconsume: true,
  managerShifts: true,
  staffPositions: true,
  discounts: true,
  workforce: true,
};
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date());
const ago = (minutes) => new Date(Date.now() - minutes * 60000);
const request = (command, reason = 'Синтетическая подготовка прохода') => ({
  request_id: randomUUID(),
  reason,
  command,
});
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
/** Every P1 screen with data: stock with counts and consumption, a cash day, a shift, a discount. */
async function seed(ctx) {
  const bo = ctx.backoffice,
    token = ctx.manager.token,
    command = (c, reason) => bo.command(token, ctx.branch, request(c, reason));
  const { release } = await publishMenuFixture(ctx);
  const s = await stockFixture(bo, token, ctx);
  await linkFixture(bo, token, ctx, s);
  // Key positions of the closing count, groups and one quick waste tile.
  const cards = (
    await ctx.cloud.pool.query(
      "SELECT id,revision,payload FROM bo_records WHERE branch_id=$1 AND kind='ingredient'",
      [ctx.branch],
    )
  ).rows;
  const extra = {
    [s.bun]: { count_daily: true, group: 'semi', quick_waste: { label: 'Булки', quantity: '2' } },
    [s.meat]: { count_daily: true, group: 'raw' },
    [s.can]: { count_daily: true, group: 'drink' },
    [s.potato]: { group: 'raw' },
  };
  for (const card of cards)
    if (extra[card.id])
      await command({
        type: 'save',
        kind: 'ingredient',
        id: card.id,
        expected_revision: card.revision,
        payload: { ...card.payload, ...extra[card.id] },
      });
  // Automatic consumption on from three hours ago: one sale written off, one blocked.
  await command({
    type: 'stock_settings',
    autoconsume_mode: 'on',
    start_at: ago(180).toISOString(),
    expected_revision: 0,
  });
  const fries = await posSale(ctx, release, { at: ago(50), number: 71, lines: [['fries', 2]] });
  const duo = await posSale(ctx, release, { at: ago(40), number: 72, lines: [['duo', 1]] });
  for (const order of [fries, duo]) await kitchen(ctx, order, 'in_production');
  await runStockConsumption(ctx.cloud.pool, {
    stockV2Enabled: true,
    rolesEnabled: true,
    stockAutoconsumeEnabled: true,
  });
  // A count with a shortage and a waste of the day.
  let b = await balances(ctx);
  await command({
    type: 'stock',
    kind: 'count',
    reference: 'ИНВ-ПРОХОД',
    lines: [
      [s.bun, '96'],
      [s.can, '48'],
    ].map(([id, quantity]) => ({
      ingredient_id: id,
      quantity,
      value_minor: '0',
      expected_revision: b[id].revision,
    })),
  });
  b = await balances(ctx);
  await command({
    type: 'stock',
    kind: 'waste',
    reference: 'СП-ПРОХОД',
    reason_code: 'damaged',
    lines: [
      {
        ingredient_id: s.cheese,
        quantity: '2',
        value_minor: '0',
        expected_revision: b[s.cheese].revision,
      },
    ],
  });
  // Today's cash day of two desks (Z, receipts, refunds, Webkassa).
  await seedDay(ctx, today());
  // A card with a position and POS access.
  await command({
    type: 'save',
    kind: 'employee',
    id: randomUUID(),
    expected_revision: 0,
    payload: {
      name: 'Синтетическая кассир с должностью',
      role: 'cashier',
      active: true,
      note: '',
      position_code: 'cashier',
      extra_position_codes: ['issue'],
      pos_access: 'cashier',
    },
  });
  // The manager shift of the day is open.
  await command(
    {
      type: 'manager_shift_open',
      id: randomUUID(),
      manager_employee_id: null,
      items: MANAGER_SHIFT_TEMPLATE_V1.opening.map((i) => ({
        code: i.code,
        status: 'done',
        comment: 'Проверено при открытии',
      })),
      expected_revision: 0,
    },
    'Синтетическое открытие смены',
  );
  // One draft and one live discount.
  const discount = (name, extraPayload = {}) => ({
    name,
    kind: 'percent',
    percent_bp: 1000,
    value_minor: null,
    scope: { categories: [], products: [], channels: ['hall', 'yandex_eda'] },
    schedule: { start_at: null, end_at: null, weekdays: [1, 2, 3, 4, 5, 6, 7], hours: [] },
    requires_manager_pin: true,
    combinable: false,
    ...extraPayload,
  });
  await command({
    type: 'discount_save',
    id: randomUUID(),
    expected_revision: 0,
    payload: discount('Синтетическая скидка 10 %'),
  });
  const live = randomUUID();
  await command({
    type: 'discount_save',
    id: live,
    expected_revision: 0,
    payload: discount('Синтетический обед', {
      kind: 'amount',
      percent_bp: null,
      value_minor: '50000',
      schedule: {
        start_at: null,
        end_at: null,
        weekdays: [1, 2, 3, 4, 5],
        hours: [{ from: '12:00', to: '15:00' }],
      },
    }),
  });
  await command({ type: 'discount_state', id: live, state: 'active', expected_revision: 1 });
}
async function browser(ctx, extra) {
  const output = new URL('../../.local/backoffice-p1-pass/', import.meta.url);
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
        [fileURLToPath(new URL('p1_pass_ui.py', import.meta.url)), file],
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
        if (signal) reject(new Error(`P1 pass browser terminated by ${signal}`));
        else resolve(code);
      });
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test(
  'P1 pass: every new screen, every role, 1440 and 390 px, every flag on',
  { timeout: 600000 },
  () =>
    withCatalog(
      async (ctx) => {
        await seed(ctx);
        const shift = await person(ctx, 'Синтетический начальник смены', 'shift_manager');
        const accountant = await person(ctx, 'Синтетический бухгалтер', 'accountant');
        const analyst = await person(ctx, 'Синтетический аналитик', null);
        const before = (await ctx.cloud.pool.query('SELECT count(*)::int n FROM bo_commands'))
          .rows[0].n;
        assert.equal(
          await browser(ctx, { shift, accountant, analyst }),
          0,
          'The P1 pass in the browser must pass',
        );
        // The pass only looks: no command was sent from the browser.
        assert.equal(
          (await ctx.cloud.pool.query('SELECT count(*)::int n FROM bo_commands')).rows[0].n,
          before,
        );
      },
      { staticPrefix: '/backoffice', ...FLAGS },
    ),
);
