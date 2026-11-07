// Golden outputs of the cloud lane back office (review BOUI-R4). With every back-office P1 flag
// off, lane bo-ui must answer exactly as the cloud lane result 43806cf4 did. The same synthetic
// seed (fixed ids and times in 2031, far from the clock) is run through a Backoffice class and its
// read(), order(), ops() and a few commands are reduced to canonical JSON: the ids the database or
// the server makes up become U1, U2, ... in order of appearance, server clock times become
// <clock>, the snapshot time is dropped. tests/integration/backoffice-p1-golden.test.mjs compares
// this lane with the committed file backoffice-cloud-lane-golden.json.
//
// To record the file again from a build of the cloud lane (never from this lane):
//   git worktree add /tmp/cloud-lane 43806cf412c1f1acb02c995de7f61cc1ed951e4c   (and build it)
//   node --env-file=.env tests/integration/fixtures/backoffice-cloud-lane-golden.mjs \
//     /tmp/cloud-lane/packages/backoffice-core/dist/index.js
// Every name, number and amount is synthetic.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
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

/** The seed day: far from the clock, so a fixed time is never confused with a server time. */
export const GOLDEN_DAY = '2031-03-14';
const WEEK_START = '2031-03-08';
const SEED_FROM = Date.parse('2031-01-01T00:00:00Z');
export const GOLDEN_FILE = new URL('./backoffice-cloud-lane-golden.json', import.meta.url);
const ID = {
  bun: '0a000000-0000-4000-8000-000000000001',
  fillet: '0a000000-0000-4000-8000-000000000002',
  cook: '0a000000-0000-4000-8000-000000000003',
  recipe: '0a000000-0000-4000-8000-000000000004',
  cashierOrder: '0a000000-0000-4000-8000-000000000005',
  cloudOrder: '0a000000-0000-4000-8000-000000000006',
  saved: ['0a000000-0000-4000-8000-000000000007', '0a000000-0000-4000-8000-000000000008'],
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const VOLATILE = new Set(['as_of', 'trace_id']);

/** Canonical JSON: made-up ids by order of appearance, server clock times as <clock>. */
export function canonical(value, known) {
  const names = new Map(Object.entries(known).map(([name, id]) => [id.toLowerCase(), name]));
  let next = 0;
  const id = (raw) => {
    const key = raw.toLowerCase();
    if (!names.has(key)) names.set(key, `U${++next}`);
    return names.get(key);
  };
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(([k]) => !VOLATILE.has(k))
          .map(([k, x]) => [k, walk(x)]),
      );
    if (typeof v !== 'string') return v;
    if (ISO.test(v)) return Date.parse(v) >= SEED_FROM ? new Date(v).toISOString() : '<clock>';
    return v.replace(UUID, id);
  };
  return walk(JSON.parse(JSON.stringify(value)));
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
        '0a000000-0000-4000-8000-0000000000a1',
        '0a000000-0000-4000-8000-0000000000a2',
        '0a000000-0000-4000-8000-0000000000a3',
        JSON.stringify({ channel: 'mobile', lines: [] }),
        'a'.repeat(64),
        at(GOLDEN_DAY, '12:30:00'),
      ],
    );
    await db.query(
      `INSERT INTO commerce_captures(id,order_id,attempt_id,account_id,operation_id,amount_minor,occurred_at)
       VALUES($1,$2,$3,$4,$5,450000,$6)`,
      [
        '0a000000-0000-4000-8000-0000000000a4',
        ID.cloudOrder,
        '0a000000-0000-4000-8000-0000000000a5',
        '0a000000-0000-4000-8000-0000000000a3',
        'synthetic:golden',
        at(GOLDEN_DAY, '12:31:00'),
      ],
    );
  } finally {
    await db.query('SET session_replication_role = DEFAULT');
    db.release();
  }
}

/**
 * The golden outputs of `B` (a backoffice-core module: Backoffice, grantBackoffice) on a fresh
 * synthetic database `c`. `extra` are options added to every instance (this lane: every P1 flag
 * off, backofficeP1Options({})).
 */
export async function goldenOutputs(B, c, extra = {}) {
  const person = async (name, role) => {
    const p = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name,
      branch_ids: [c.branch],
    });
    await B.grantBackoffice(c.cloud.pool, p.actor_id, c.branch, role);
    return p;
  };
  const manager = await person('Синтетический управляющий', 'manager');
  const analyst = await person('Синтетический аналитик', 'analyst');
  const seed = new B.Backoffice(c.cloud.pool, true, { ...extra });
  const command = (body, reason = 'Синтетическая подготовка') =>
    seed.command(manager.token, c.branch, { request_id: randomUUID(), reason, command: body });
  for (const [id, name, unit] of [
    [ID.bun, 'Синтетическая булка', 'pcs'],
    [ID.fillet, 'Синтетическое филе', 'g'],
  ])
    await command({
      type: 'save',
      kind: 'ingredient',
      id,
      expected_revision: 0,
      payload: { name, unit, minimum: '0', active: true },
    });
  await command({
    type: 'stock',
    kind: 'receipt',
    reference: 'НАК-1',
    lines: [
      { ingredient_id: ID.bun, quantity: '20', value_minor: '20000', expected_revision: 0 },
      { ingredient_id: ID.fillet, quantity: '5000', value_minor: '1167000', expected_revision: 0 },
    ],
  });
  await command({
    type: 'stock',
    kind: 'waste',
    reference: 'СП-1',
    lines: [{ ingredient_id: ID.bun, quantity: '2', value_minor: '0', expected_revision: 1 }],
  });
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
    payload: { name: 'Синтетический повар', role: 'cook', active: true, note: '' },
  });
  await command({
    type: 'save',
    kind: 'recipe',
    id: ID.recipe,
    expected_revision: 0,
    payload: {
      name: 'Синтетический фарш',
      product_id: 'ttk:syn-golden',
      output_ingredient_id: ID.fillet,
      yield_quantity: '1000',
      lines: [{ ingredient_id: ID.bun, quantity: '1' }],
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
  const sets = {
    'all off': {},
    'roles and sales report': { rolesEnabled: true, salesReportEnabled: true },
  };
  let saved = 0;
  for (const [label, options] of Object.entries(sets)) {
    const bo = new B.Backoffice(c.cloud.pool, true, { ...options, ...extra });
    const set = (out[label] = {});
    for (const [who, token] of [
      ['manager', manager.token],
      ['analyst', analyst.token],
    ])
      for (const [name, input] of Object.entries(windows))
        set[`read ${who} ${name}`] = await settle(bo.read(token, c.branch, input));
    for (const [name, id] of [
      ['cashier', ID.cashierOrder],
      ['app', ID.cloudOrder],
    ])
      set[`order ${name}`] = await settle(bo.order(manager.token, c.branch, id));
    for (const [view, input] of [
      ['sales', { start_date: GOLDEN_DAY, end_date: GOLDEN_DAY }],
      ['stock', { view: 'waste', start_date: GOLDEN_DAY, end_date: GOLDEN_DAY }],
      ['pos-day', { date: GOLDEN_DAY }],
      ['orders', { start_date: GOLDEN_DAY, end_date: GOLDEN_DAY }],
      ['menu-links', {}],
      ['consumption', {}],
      ['manager-shifts', {}],
      ['staff-roster', {}],
      ['discounts', {}],
      ['bogus', {}],
    ])
      set[`ops ${view}`] = await settle(bo.ops(manager.token, c.branch, view, input));
    const env = (body) => ({
      request_id: randomUUID(),
      reason: 'Синтетическая проверка',
      command: body,
    });
    for (const [name, body] of [
      ['storno', { type: 'stock_reverse', document_id: ID.recipe, expected_balances: {} }],
      ['discount', { type: 'discount_save', id: ID.recipe, expected_revision: 0 }],
      [
        'save with a P1 field',
        {
          type: 'save',
          kind: 'ingredient',
          id: ID.bun,
          expected_revision: 99,
          payload: {
            name: 'Синтетическая булка',
            unit: 'pcs',
            minimum: '0',
            active: true,
            quick_waste: { label: 'Булка', quantity: '1' },
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
  }
  return canonical(out, {
    BRANCH: c.branch,
    ORG: c.org,
    DEVICE: c.device,
    MANAGER: manager.actor_id,
    ANALYST: analyst.actor_id,
    ...Object.fromEntries(
      Object.entries(ID)
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => [k.toUpperCase(), v]),
    ),
    SAVED_1: ID.saved[0],
    SAVED_2: ID.saved[1],
  });
}

// Recording: node tests/integration/fixtures/backoffice-cloud-lane-golden.mjs <cloud lane dist>.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target)
    throw new Error('Usage: backoffice-cloud-lane-golden.mjs <cloud lane dist/index.js>');
  const B = await import(target);
  const { withSyncDatabases } = await import('../../helpers/sync.mjs');
  await withSyncDatabases(async (c) => {
    const golden = await goldenOutputs(B, c);
    // Written as the repository formats JSON (pnpm format:check).
    const prettier = await import('prettier');
    const options = (await prettier.resolveConfig(fileURLToPath(GOLDEN_FILE))) ?? {};
    await writeFile(
      GOLDEN_FILE,
      await prettier.format(JSON.stringify(golden), { ...options, parser: 'json' }),
    );
    console.log(`Golden outputs of ${target} written to ${fileURLToPath(GOLDEN_FILE)}`);
  });
}
