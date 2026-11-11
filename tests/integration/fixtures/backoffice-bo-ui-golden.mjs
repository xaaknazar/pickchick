// Golden outputs of the bo-ui back office (lane bo-ui2, step 1). With every flag of the second
// wave off (BACKOFFICE_SUPPLY_ENABLED, BACKOFFICE_STOCK_REPORTS_ENABLED,
// BACKOFFICE_STAFF_ASSIGNMENT_ENABLED), lane bo-ui2 must answer exactly as the reviewed bo-ui
// result aff89ce6 did, with the bo-ui flags off and on. The same synthetic seed (fixed ids and
// times in 2031, far from the clock) is run through a Backoffice class: read() of four roles,
// the order cards, every ops view of the cloud lane and of bo-ui, the views and commands the
// second wave plans (unknown to bo-ui, so 404 and INVALID_REQUEST), a strict save with a
// second-wave payload field and a write. Outputs are reduced to canonical JSON by the canonical()
// of the cloud lane golden (made-up ids U1, U2, ..., server clock times <clock>).
// tests/integration/backoffice-p2-golden.test.mjs compares lane bo-ui2 with the committed file
// backoffice-bo-ui-golden.json, on the full schema (076) and on the bo-ui schema (075).
// Unlike the cloud lane golden, «Касса» payloads have maps keyed by edge staff ids, which derive
// from the random employee ids of pos-day-fixture.mjs: canonicalKeys() also renames ids used as
// keys and lists such maps in the order of their canonical names.
//
// To record the file again from a build of the bo-ui result (never from lane bo-ui2):
//   git worktree add /tmp/bo-ui aff89ce6a0cb77d9c56e3699b506632404b03201   (pnpm install, build)
//   node --env-file=.env tests/integration/fixtures/backoffice-bo-ui-golden.mjs \
//     /tmp/bo-ui/packages/backoffice-core/dist/index.js
// The recorder always migrates the cloud schema up to 075 only (the bo-ui schema). loadConfig
// needs the standard local database names. Every name, number and amount is synthetic.
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionCatalogManager } from '../../../packages/catalog-admin/dist/index.js';
import {
  SHIFT,
  STAFF,
  TERMINAL,
  at,
  cashierShift,
  seedDay,
} from '../../../packages/backoffice-core/tests/pos-day-fixture.mjs';
import { canonical } from './backoffice-cloud-lane-golden.mjs';

export const GOLDEN_DAY = '2031-03-14';
const WEEK_START = '2031-03-08';
export const GOLDEN_FILE = new URL('./backoffice-bo-ui-golden.json', import.meta.url);
export const MIGRATIONS = fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url));
/** The last migration of the bo-ui result: the recorder never applies anything after it. */
export const BO_UI_LAST_MIGRATION = '075_cloud_backoffice_ops.sql';
const ID = {
  bun: '0b000000-0000-4000-8000-000000000001',
  fillet: '0b000000-0000-4000-8000-000000000002',
  cook: '0b000000-0000-4000-8000-000000000003',
  recipe: '0b000000-0000-4000-8000-000000000004',
  cashierOrder: '0b000000-0000-4000-8000-000000000005',
  cloudOrder: '0b000000-0000-4000-8000-000000000006',
  discount: '0b000000-0000-4000-8000-000000000007',
  supplier: '0b000000-0000-4000-8000-000000000008',
  request: '0b000000-0000-4000-8000-000000000009',
  saved: [
    '0b000000-0000-4000-8000-000000000011',
    '0b000000-0000-4000-8000-000000000012',
    '0b000000-0000-4000-8000-000000000013',
  ],
};
/** The cloud lane flags (CC-5, CC-6, CC-7). */
export const CLOUD_FLAGS = Object.freeze({
  rolesEnabled: true,
  stockV2Enabled: true,
  salesReportEnabled: true,
});
/** Every bo-ui flag on, with the cloud lane flags its features build on. */
export const BO_UI_FLAGS = Object.freeze({
  ...CLOUD_FLAGS,
  posDayEnabled: true,
  stockAutoconsumeEnabled: true,
  managerShiftsEnabled: true,
  staffPositionsEnabled: true,
  discountsEnabled: true,
});
/** The read views the second wave plans (design-bo-ui.md «Вторая волна»), with their queries. */
export const P2_VIEWS = Object.freeze([
  ['suppliers', {}],
  ['supply-requests', { start_date: WEEK_START, end_date: GOLDEN_DAY }],
  ['stock-balances', { date: GOLDEN_DAY }],
  ['stock-turnover', { start_date: WEEK_START, end_date: GOLDEN_DAY }],
  ['order-hint', { kind: 'bakery' }],
  ['staff-assignments', { date: GOLDEN_DAY }],
]);
/** The commands the second wave plans, with plausible bodies (unknown to bo-ui). */
export const P2_COMMANDS = Object.freeze([
  [
    'supplier_save',
    {
      type: 'supplier_save',
      id: ID.supplier,
      expected_revision: 0,
      payload: { name: 'Поставщик 1', kind: 'supplier', active: true },
    },
  ],
  [
    'supplier_price_save',
    {
      type: 'supplier_price_save',
      supplier_id: ID.supplier,
      ingredient_id: ID.fillet,
      unit: 'kg',
      valid_from: GOLDEN_DAY,
      price_minor: '250000',
      expected_revision: 0,
    },
  ],
  [
    'supplier_prices_import',
    {
      type: 'supplier_prices_import',
      source: 'csv',
      file_sha256: 'a'.repeat(64),
      plan_sha256: 'b'.repeat(64),
      rows: [
        {
          supplier_name: 'Поставщик 1',
          supplier_kind: 'supplier',
          ingredient_id: ID.fillet,
          unit: 'kg',
          price_minor: '250000',
          valid_from: GOLDEN_DAY,
        },
      ],
    },
  ],
  [
    'supply_request_save',
    {
      type: 'supply_request_save',
      id: ID.request,
      expected_revision: 0,
      payload: {
        kind: 'bakery',
        supplier_id: null,
        needed_by: GOLDEN_DAY,
        note: null,
        lines: [{ ingredient_id: ID.bun, qty: '30' }],
      },
    },
  ],
  [
    'supply_request_submit',
    { type: 'supply_request_submit', id: ID.request, expected_revision: 1 },
  ],
  [
    'supply_request_cancel',
    { type: 'supply_request_cancel', id: ID.request, expected_revision: 1 },
  ],
  [
    'supply_request_receive',
    {
      type: 'supply_request_receive',
      id: ID.request,
      expected_revision: 2,
      reference: 'НАК-2',
      document_date: GOLDEN_DAY,
      lines: [{ ingredient_id: ID.bun, quantity: '30', value_minor: '30000' }],
    },
  ],
  [
    'staff_assign',
    {
      type: 'staff_assign',
      employee_id: ID.cook,
      station_code: 'fryer',
      started_at: '2031-03-14T10:00:00+05:00',
      expected_revision: 0,
    },
  ],
  [
    'staff_unassign',
    {
      type: 'staff_unassign',
      employee_id: ID.cook,
      ended_at: '2031-03-14T18:00:00+05:00',
      expected_revision: 1,
    },
  ],
]);

const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * canonical() of the cloud lane golden, then the ids used as object keys: each must already have
 * a canonical name from a value (otherwise its name would depend on a random id and the recorder
 * refuses), and an object keyed only by ids is listed by canonical name (U2 before U10).
 */
export function canonicalKeys(value, known) {
  const names = new Map();
  const collect = (v, raw) => {
    if (Array.isArray(v)) v.forEach((x, i) => collect(x, raw?.[i]));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) collect(x, raw?.[k]);
    else if (typeof v === 'string' && typeof raw === 'string' && UUID_KEY.test(raw))
      names.set(raw.toLowerCase(), v);
  };
  const raw = JSON.parse(JSON.stringify(value));
  const named = canonical(raw, known);
  for (const [name, id] of Object.entries(known)) names.set(id.toLowerCase(), name);
  collect(named, raw);
  const order = (name) => (/^U\d+$/.test(name) ? [1, Number(name.slice(1))] : [0, name]);
  const byName = (a, b) => {
    const [x, y] = [order(a), order(b)];
    return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0);
  };
  const walk = (v, key = null) => {
    // pos-day lists the cashiers of a shift as a set sorted by raw id (pos-day.ts).
    if (Array.isArray(v) && key === 'cashier_staff_ids') return v.map((x) => walk(x)).sort(byName);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    // A calendar day before the seed year comes from the server clock (the 7 days of the
    // consumption coverage), like the ISO times canonical() turns into <clock>.
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && v < '2031-01-01')
      return '<clock day>';
    if (!v || typeof v !== 'object') return v;
    const entries = Object.entries(v).map(([k, x]) => {
      if (!UUID_KEY.test(k)) return [k, walk(x, k)];
      const name = names.get(k.toLowerCase());
      if (!name) throw new Error(`An id used only as a key has no stable name: ${k}`);
      return [name, walk(x)];
    });
    if (entries.length && Object.keys(v).every((k) => UUID_KEY.test(k)))
      entries.sort(([a], [b]) => byName(a, b));
    return Object.fromEntries(entries);
  };
  return walk(named);
}
const settle = async (promise) => {
  try {
    return { ok: await promise };
  } catch (error) {
    return { error: { code: error?.code ?? null, reason: error?.reason ?? null } };
  }
};
/** A paid app order of the seed day (commerce, triggers off on one owner connection). */
async function cloudOrder(c) {
  const db = await c.cloud.pool.connect();
  try {
    await db.query('SET session_replication_role = replica');
    await db.query(
      `INSERT INTO commerce_orders(id,organization_id,branch_id,principal_id,quote_id,fiscal_account_id,
        snapshot,total_minor,currency,quote_digest,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,450000,'KZT',$8,$9)`,
      [
        ID.cloudOrder,
        c.org,
        c.branch,
        '0b000000-0000-4000-8000-0000000000a1',
        '0b000000-0000-4000-8000-0000000000a2',
        '0b000000-0000-4000-8000-0000000000a3',
        JSON.stringify({ channel: 'mobile', lines: [] }),
        'a'.repeat(64),
        at(GOLDEN_DAY, '12:30:00'),
      ],
    );
    await db.query(
      `INSERT INTO commerce_captures(id,order_id,attempt_id,account_id,operation_id,amount_minor,occurred_at)
       VALUES($1,$2,$3,$4,$5,450000,$6)`,
      [
        '0b000000-0000-4000-8000-0000000000a4',
        ID.cloudOrder,
        '0b000000-0000-4000-8000-0000000000a5',
        '0b000000-0000-4000-8000-0000000000a3',
        'synthetic:golden-p2',
        at(GOLDEN_DAY, '12:31:00'),
      ],
    );
  } finally {
    await db.query('SET session_replication_role = DEFAULT');
    db.release();
  }
}

/**
 * The golden outputs of `B` (a backoffice-core module: Backoffice, grantBackoffice,
 * designateBackoffice) on a fresh synthetic database `c`. `extra` are options added to every
 * instance (lane bo-ui2: every second-wave flag off, backofficeP2Options({})).
 */
export async function goldenOutputs(B, c, extra = {}) {
  const person = async (name, role, designation = null) => {
    const p = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name,
      branch_ids: [c.branch],
    });
    await B.grantBackoffice(c.cloud.pool, p.actor_id, c.branch, role);
    if (designation)
      await B.designateBackoffice(
        c.cloud.pool,
        p.actor_id,
        c.branch,
        designation,
        'Синтетическое назначение',
      );
    return p;
  };
  const manager = await person('Синтетический управляющий', 'manager');
  const analyst = await person('Синтетический аналитик', 'analyst');
  const shift = await person('Синтетический начальник смены', 'analyst', 'shift_manager');
  const accountant = await person('Синтетический бухгалтер', 'analyst', 'accountant');
  // The seed uses the bo-ui features, so both builds store the same P1 rows.
  const seed = new B.Backoffice(c.cloud.pool, true, { ...BO_UI_FLAGS, ...extra });
  const command = (body, reason = 'Синтетическая подготовка') =>
    seed.command(manager.token, c.branch, { request_id: randomUUID(), reason, command: body });
  await command({
    type: 'save',
    kind: 'ingredient',
    id: ID.bun,
    expected_revision: 0,
    payload: {
      name: 'Синтетическая булка',
      unit: 'pcs',
      minimum: '10',
      active: true,
      quick_waste: { label: 'Булка', quantity: '1' },
      group: 'raw',
    },
  });
  await command({
    type: 'save',
    kind: 'ingredient',
    id: ID.fillet,
    expected_revision: 0,
    payload: {
      name: 'Синтетическое филе',
      unit: 'g',
      minimum: '1000',
      active: true,
      count_daily: true,
    },
  });
  await command({
    type: 'stock',
    kind: 'receipt',
    reference: 'НАК-1',
    meta: { supplier_kind: 'bakery', supplier_name: 'Пекарня 1', document_date: GOLDEN_DAY },
    lines: [
      { ingredient_id: ID.bun, quantity: '20', value_minor: '20000', expected_revision: 0 },
      { ingredient_id: ID.fillet, quantity: '5000', value_minor: '1167000', expected_revision: 0 },
    ],
  });
  const waste = await command({
    type: 'stock',
    kind: 'waste',
    reference: 'СП-1',
    reason_code: 'defect',
    lines: [{ ingredient_id: ID.bun, quantity: '2', value_minor: '0', expected_revision: 1 }],
  });
  await command(
    { type: 'stock_reverse', document_id: waste.id, expected_balances: { [ID.bun]: 2 } },
    'Синтетическое сторно',
  );
  await command({
    type: 'stock',
    kind: 'count',
    reference: 'ИНВ-1',
    lines: [{ ingredient_id: ID.fillet, quantity: '4900', value_minor: '0', expected_revision: 1 }],
  });
  await command({
    type: 'save',
    kind: 'employee',
    id: ID.cook,
    expected_revision: 0,
    payload: {
      name: 'Синтетический повар',
      role: 'cook',
      active: true,
      note: '',
      position_code: 'fryer',
      pos_access: 'none',
    },
  });
  await command({
    type: 'save',
    kind: 'recipe',
    id: ID.recipe,
    expected_revision: 0,
    payload: {
      name: 'Синтетический фарш',
      product_id: 'ttk:syn-golden-p2',
      output_ingredient_id: ID.fillet,
      yield_quantity: '1000',
      lines: [{ ingredient_id: ID.bun, quantity: '1' }],
    },
  });
  await command({
    type: 'discount_save',
    id: ID.discount,
    expected_revision: 0,
    payload: {
      name: 'Синтетическая скидка',
      kind: 'percent',
      percent_bp: 1000,
      value_minor: null,
      scope: { categories: [], products: [], channels: ['hall'] },
      schedule: {
        // 01.03.2031 00:00 Almaty (the discount instant is UTC only).
        start_at: '2031-02-28T19:00:00Z',
        end_at: null,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        hours: [],
      },
      requires_manager_pin: true,
      combinable: false,
    },
  });
  await seedDay(c, GOLDEN_DAY);
  await cashierShift(c, {
    shift: SHIFT.one,
    terminal: TERMINAL.one,
    staff: STAFF.cashier,
    opened: at(GOLDEN_DAY, '09:00:00'),
    opening: '1000000',
    cash_sales: '0',
    expected: '1000000',
  }).catch(() => undefined);
  const created = at(GOLDEN_DAY, '10:00:00').toISOString();
  await c.cloud.pool.query(
    'INSERT INTO cloud_cashier_orders(id,branch_id,device_id,cash_shift_id,created_at,sequence,payload) VALUES($1,$2,$3,$4,$5,9001,$6)',
    [
      ID.cashierOrder,
      c.branch,
      c.device,
      SHIFT.one,
      created,
      {
        order_id: ID.cashierOrder,
        cash_shift_id: SHIFT.one,
        created_at: created,
        total_minor: '250000',
        state: 'paid',
        version: 1,
        execution_mode: 'pos_sale',
        kitchen_state: 'handed_over',
        display_number: '1',
        lines: [],
      },
    ],
  );
  await cloudOrder(c);

  const out = {};
  const windows = {
    day: { period: 'custom', start_date: GOLDEN_DAY, end_date: GOLDEN_DAY },
    week: { period: 'custom', start_date: WEEK_START, end_date: GOLDEN_DAY },
  };
  const sets = { 'all off': {}, 'cloud flags': CLOUD_FLAGS, 'bo-ui flags': BO_UI_FLAGS };
  let saved = 0;
  for (const [label, options] of Object.entries(sets)) {
    const bo = new B.Backoffice(c.cloud.pool, true, { ...options, ...extra });
    const set = (out[label] = {});
    for (const [who, token, names] of [
      ['manager', manager.token, ['day', 'week']],
      ['analyst', analyst.token, ['day']],
      ['shift manager', shift.token, ['day']],
      ['accountant', accountant.token, ['day']],
    ])
      for (const name of names)
        set[`read ${who} ${name}`] = await settle(bo.read(token, c.branch, windows[name]));
    for (const [name, id] of [
      ['cashier', ID.cashierOrder],
      ['app', ID.cloudOrder],
    ])
      set[`order ${name}`] = await settle(bo.order(manager.token, c.branch, id));
    for (const [view, input] of [
      ['sales', { start_date: GOLDEN_DAY, end_date: GOLDEN_DAY }],
      ['stock', { view: 'waste', start_date: WEEK_START, end_date: GOLDEN_DAY }],
      ['stock', { view: 'movement', start_date: WEEK_START, end_date: GOLDEN_DAY }],
      ['pos-day', { date: GOLDEN_DAY }],
      ['orders', { start_date: GOLDEN_DAY, end_date: GOLDEN_DAY }],
      ['menu-links', {}],
      ['consumption', { date: GOLDEN_DAY }],
      ['manager-shifts', { date: GOLDEN_DAY }],
      ['staff-roster', {}],
      ['discounts', {}],
      ...P2_VIEWS,
      ['bogus', {}],
    ])
      set[`ops ${view}${input.view ? ' ' + input.view : ''}`] = await settle(
        bo.ops(manager.token, c.branch, view, input),
      );
    // A shift manager on the second-wave views (still unknown views).
    set['ops shift manager staff-assignments'] = await settle(
      bo.ops(shift.token, c.branch, 'staff-assignments', { date: GOLDEN_DAY }),
    );
    const env = (body) => ({
      request_id: randomUUID(),
      reason: 'Синтетическая проверка',
      command: body,
    });
    for (const [name, body] of [
      ['storno', { type: 'stock_reverse', document_id: ID.recipe, expected_balances: {} }],
      ...P2_COMMANDS,
      [
        'save with a P2 field',
        {
          type: 'save',
          kind: 'ingredient',
          id: ID.bun,
          expected_revision: 1,
          payload: {
            name: 'Синтетическая булка',
            unit: 'pcs',
            minimum: '10',
            active: true,
            supply_kind: 'bakery',
          },
        },
      ],
      [
        'save a new ingredient',
        {
          type: 'save',
          kind: 'ingredient',
          id: ID.saved[saved++],
          expected_revision: 0,
          payload: { name: 'Синтетический лук ' + label, unit: 'g', minimum: '0', active: true },
        },
      ],
    ])
      set[`command ${name}`] = await settle(bo.command(manager.token, c.branch, env(body)));
    set['command shift manager staff_assign'] = await settle(
      bo.command(shift.token, c.branch, env(P2_COMMANDS.find(([n]) => n === 'staff_assign')[1])),
    );
  }
  return stableRoster(
    canonicalKeys(out, {
      BRANCH: c.branch,
      ORG: c.org,
      DEVICE: c.device,
      MANAGER: manager.actor_id,
      ANALYST: analyst.actor_id,
      SHIFT_MANAGER: shift.actor_id,
      ACCOUNTANT: accountant.actor_id,
      ...Object.fromEntries(
        Object.entries(ID)
          .filter(([, v]) => typeof v === 'string')
          .map(([k, v]) => [k.toUpperCase(), v]),
      ),
      SAVED_1: ID.saved[0],
      SAVED_2: ID.saved[1],
      SAVED_3: ID.saved[2],
    }),
  );
}

/**
 * GET ops/staff-roster lists the cards by their raw employee id and hashes the raw content, and
 * the cashier cards of pos-day-fixture.mjs have random ids: the list is ordered by canonical id
 * and the hash, after a format check, is masked (bo-ui's staff-positions tests pin it).
 */
function stableRoster(sets) {
  for (const set of Object.values(sets)) {
    const roster = set['ops staff-roster']?.ok;
    if (!roster) continue;
    if (!/^[0-9a-f]{64}$/.test(roster.sha256)) throw new Error('Unexpected roster hash');
    roster.sha256 = '<sha256>';
    roster.staff.sort((a, b) => (a.employee_id < b.employee_id ? -1 : 1));
  }
  return sets;
}

/** A copy of the cloud migrations up to `last` (inclusive) for withSyncDatabases. */
export async function migrationsUpTo(last, run) {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-cloud-upto-'));
  try {
    for (const file of await readdir(MIGRATIONS))
      if (/^\d{3}_[a-z_]+\.sql$/.test(file) && file <= last)
        await cp(join(MIGRATIONS, file), join(directory, file));
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Recording: node tests/integration/fixtures/backoffice-bo-ui-golden.mjs <bo-ui dist> [out.json]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) throw new Error('Usage: backoffice-bo-ui-golden.mjs <bo-ui dist/index.js> [out]');
  const output = process.argv[3] ? new URL(`file://${process.argv[3]}`) : GOLDEN_FILE;
  const B = await import(target);
  const { withSyncDatabases } = await import('../../helpers/sync.mjs');
  await migrationsUpTo(BO_UI_LAST_MIGRATION, (directory) =>
    withSyncDatabases(
      async (c) => {
        const golden = await goldenOutputs(B, c);
        // Written as the repository formats JSON (pnpm format:check).
        const prettier = await import('prettier');
        const options = (await prettier.resolveConfig(fileURLToPath(GOLDEN_FILE))) ?? {};
        await writeFile(
          output,
          await prettier.format(JSON.stringify(golden), { ...options, parser: 'json' }),
        );
        console.log(`Golden outputs of ${target} written to ${fileURLToPath(output)}`);
      },
      { cloudMigrationDirectory: directory },
    ),
  );
}
