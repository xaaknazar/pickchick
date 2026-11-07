import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { URLSearchParams } from 'node:url';
import { createApi } from '@pickchick/api';
import { loadConfig } from '@pickchick/platform';
import { BACKOFFICE_P1_FLAGS, BACKOFFICE_P2_FLAGS } from '../../packages/platform/dist/config.js';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import {
  Backoffice,
  backofficeP1Options,
  backofficeP2Options,
  grantBackoffice,
} from '../../packages/backoffice-core/dist/index.js';
import { request, running, withSyncDatabases } from '../helpers/sync.mjs';
import { P2_VIEWS } from './fixtures/backoffice-bo-ui-golden.mjs';

/**
 * Back-office second wave (lane bo-ui2, design-bo-ui.md «Вторая волна»): loadConfig, the options
 * of the back office and GET branches/:id capabilities. With the three flags off the API config,
 * the back-office payloads and the ops views are those of the bo-ui result (aff89ce6; the byte
 * proof against its recorded outputs is backoffice-p2-golden.test.mjs).
 */
const FLAGS = [
  'BACKOFFICE_SUPPLY_ENABLED',
  'BACKOFFICE_STOCK_REPORTS_ENABLED',
  'BACKOFFICE_STAFF_ASSIGNMENT_ENABLED',
];
const CONFIG_KEY = {
  BACKOFFICE_SUPPLY_ENABLED: 'backofficeSupplyEnabled',
  BACKOFFICE_STOCK_REPORTS_ENABLED: 'backofficeStockReportsEnabled',
  BACKOFFICE_STAFF_ASSIGNMENT_ENABLED: 'backofficeStaffAssignmentEnabled',
};
/** What each flag builds on (loadConfig refuses it alone). */
const NEEDS = {
  BACKOFFICE_SUPPLY_ENABLED: { BACKOFFICE_STOCK_V2_ENABLED: 'true' },
  // Step 4: the reports are views of the stock v2 page (GET .../ops/stock).
  BACKOFFICE_STOCK_REPORTS_ENABLED: { BACKOFFICE_STOCK_V2_ENABLED: 'true' },
  BACKOFFICE_STAFF_ASSIGNMENT_ENABLED: { BACKOFFICE_STAFF_POSITIONS_ENABLED: 'true' },
};
const OPTION = {
  backofficeSupplyEnabled: 'supplyEnabled',
  backofficeStockReportsEnabled: 'stockReportsEnabled',
  backofficeStaffAssignmentEnabled: 'staffAssignmentEnabled',
};
/** Capability key of each option, in the order GET branches/:id lists them (after bo-ui). */
const CAPABILITY = {
  supplyEnabled: 'supply',
  stockReportsEnabled: 'stock_reports',
  staffAssignmentEnabled: 'staff_assignment',
};
/** The options each second-wave option builds on (its key is false without them). */
const BASE = {
  supplyEnabled: { stockV2Enabled: true },
  stockReportsEnabled: { stockV2Enabled: true },
  staffAssignmentEnabled: { staffPositionsEnabled: true },
};
/** Every bo-ui flag on, with the cloud lane flags its features build on. */
const BO_UI = Object.freeze({
  rolesEnabled: true,
  stockV2Enabled: true,
  salesReportEnabled: true,
  posDayEnabled: true,
  stockAutoconsumeEnabled: true,
  managerShiftsEnabled: true,
  staffPositionsEnabled: true,
  discountsEnabled: true,
});
const env = (extra = {}) => ({
  APP_ENV: 'test',
  CLOUD_DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:55432/pickchick_cloud',
  REDIS_URL: 'redis://127.0.0.1:56379',
  BACKOFFICE_ENABLED: 'true',
  CATALOG_ADMIN_ENABLED: 'true',
  ...extra,
});
const allOff = Object.fromEntries(FLAGS.map((name) => [name, 'false']));
/** The read of GET branches/:id without the fields that follow the clock. */
const stable = (state) => {
  const copy = { ...state };
  for (const key of ['as_of', 'period_start', 'period_end', 'trace_id']) delete copy[key];
  return copy;
};
const withoutKeys = (state, keys) => {
  const capabilities = { ...state.capabilities };
  for (const key of keys) delete capabilities[key];
  return { ...state, capabilities };
};

test('loadConfig: the three second-wave flags default off, add a key only when on, and are validated', () => {
  assert.deepEqual([...BACKOFFICE_P2_FLAGS], FLAGS);
  // The bo-ui list is unchanged.
  assert.deepEqual(
    [...BACKOFFICE_P1_FLAGS],
    [
      'BACKOFFICE_POS_DAY_ENABLED',
      'BACKOFFICE_STOCK_AUTOCONSUME_ENABLED',
      'BACKOFFICE_MANAGER_SHIFTS_ENABLED',
      'BACKOFFICE_STAFF_POSITIONS_ENABLED',
      'BACKOFFICE_DISCOUNTS_ENABLED',
    ],
  );
  const base = loadConfig('api', env());
  assert.deepEqual(loadConfig('api', env(allOff)), base);
  for (const name of FLAGS) {
    const needs = NEEDS[name];
    const needsConfig = loadConfig('api', env(needs));
    assert.deepEqual(loadConfig('api', env({ ...allOff, ...needs, [name]: 'true' })), {
      ...needsConfig,
      [CONFIG_KEY[name]]: true,
    });
    for (const bad of ['1', 'TRUE', 'yes', '', 'on'])
      assert.throws(() => loadConfig('api', env({ ...needs, [name]: bad })), new RegExp(name));
    // Only the cloud API with the back office (checked before what the flag builds on).
    assert.throws(
      () => loadConfig('api', env({ BACKOFFICE_ENABLED: 'false', [name]: 'true' })),
      new RegExp(`${name} requires the cloud backoffice`),
    );
    assert.throws(
      () =>
        loadConfig('edge', {
          APP_ENV: 'local',
          EDGE_DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:55433/pickchick_edge',
          EDGE_BRANCH_ID: randomUUID(),
          [name]: 'true',
        }),
      new RegExp(name),
    );
  }
  // Supply receipts are stock v2 receipts; the stations are the staff positions.
  assert.throws(
    () => loadConfig('api', env({ BACKOFFICE_SUPPLY_ENABLED: 'true' })),
    /BACKOFFICE_SUPPLY_ENABLED requires BACKOFFICE_STOCK_V2_ENABLED/,
  );
  assert.throws(
    () =>
      loadConfig(
        'api',
        env({ BACKOFFICE_SUPPLY_ENABLED: 'true', BACKOFFICE_STOCK_V2_ENABLED: 'false' }),
      ),
    /requires BACKOFFICE_STOCK_V2_ENABLED/,
  );
  assert.throws(
    () => loadConfig('api', env({ BACKOFFICE_STOCK_REPORTS_ENABLED: 'true' })),
    /BACKOFFICE_STOCK_REPORTS_ENABLED requires BACKOFFICE_STOCK_V2_ENABLED/,
  );
  assert.throws(
    () => loadConfig('api', env({ BACKOFFICE_STAFF_ASSIGNMENT_ENABLED: 'true' })),
    /BACKOFFICE_STAFF_ASSIGNMENT_ENABLED requires BACKOFFICE_STAFF_POSITIONS_ENABLED/,
  );
  // All three together with what they build on: exactly three more keys.
  const together = {
    ...NEEDS.BACKOFFICE_SUPPLY_ENABLED,
    ...NEEDS.BACKOFFICE_STAFF_ASSIGNMENT_ENABLED,
  };
  assert.deepEqual(
    loadConfig('api', env({ ...together, ...Object.fromEntries(FLAGS.map((n) => [n, 'true'])) })),
    {
      ...loadConfig('api', env(together)),
      backofficeSupplyEnabled: true,
      backofficeStockReportsEnabled: true,
      backofficeStaffAssignmentEnabled: true,
    },
  );
  // The edge keeps working with every second-wave flag off.
  const edge = loadConfig('edge', {
    APP_ENV: 'local',
    EDGE_DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:55433/pickchick_edge',
    EDGE_BRANCH_ID: randomUUID(),
    ...allOff,
  });
  for (const key of Object.values(CONFIG_KEY)) assert.equal(key in edge, false, key);
});

test('backofficeP2Options: a back-office option only for a flag that is on, apart from the bo-ui ones', () => {
  assert.deepEqual(backofficeP2Options({}), {});
  assert.deepEqual(backofficeP2Options(loadConfig('api', env(allOff))), {});
  const on = loadConfig(
    'api',
    env({
      ...Object.fromEntries(FLAGS.map((name) => [name, 'true'])),
      BACKOFFICE_STOCK_V2_ENABLED: 'true',
      BACKOFFICE_STAFF_POSITIONS_ENABLED: 'true',
    }),
  );
  assert.deepEqual(backofficeP2Options(on), {
    supplyEnabled: true,
    stockReportsEnabled: true,
    staffAssignmentEnabled: true,
  });
  // The bo-ui mapping does not see them.
  assert.deepEqual(backofficeP1Options(on), { staffPositionsEnabled: true });
  for (const [key, option] of Object.entries(OPTION))
    assert.deepEqual(backofficeP2Options({ [key]: true }), { [option]: true });
  assert.deepEqual(backofficeP2Options({ backofficeSupplyEnabled: false }), {});
});

async function manager(c) {
  const p = await provisionCatalogManager(c.cloud.pool, {
    organization_id: c.org,
    name: 'Синтетический управляющий',
    branch_ids: [c.branch],
  });
  await grantBackoffice(c.cloud.pool, p.actor_id, c.branch, 'manager');
  return p;
}
/** The cards the 076 rows refer to (ordinary records, written before the first read). */
async function cards(c) {
  const q = (sql, args) => c.cloud.pool.query(sql, args);
  const ingredient = randomUUID();
  const employee = randomUUID();
  await q(
    "INSERT INTO bo_records(id,branch_id,organization_id,kind,revision,payload) VALUES($1,$2,$3,'ingredient',1,$4)",
    [
      ingredient,
      c.branch,
      c.org,
      { name: 'Синтетическая булка', unit: 'pcs', minimum: '10', active: true },
    ],
  );
  await q(
    "INSERT INTO bo_records(id,branch_id,organization_id,kind,revision,payload) VALUES($1,$2,$3,'employee',1,$4)",
    [
      employee,
      c.branch,
      c.org,
      { name: 'Синтетический повар', role: 'cook', active: true, note: '' },
    ],
  );
  return { ingredient, employee };
}
/** One row in every cloud076 table: the flag-off payloads must not see any of them. */
async function p2Rows(c, actor, { ingredient, employee }) {
  const q = (sql, args) => c.cloud.pool.query(sql, args);
  const supplier = randomUUID();
  await q(
    "INSERT INTO bo_suppliers(id,branch_id,name,kind,revision,created_by,updated_by) VALUES($1,$2,'Поставщик 1','supplier',1,$3,$3)",
    [supplier, c.branch, actor],
  );
  const batch = randomUUID();
  await q(
    `INSERT INTO bo_supplier_price_imports(id,branch_id,source,file_sha256,plan_sha256,row_count,summary,actor_id)
     VALUES($1,$2,'csv',$3,$4,1,'{}',$5)`,
    [batch, c.branch, 'a'.repeat(64), 'b'.repeat(64), actor],
  );
  await q(
    `INSERT INTO bo_supplier_prices(branch_id,supplier_id,ingredient_id,unit,price_minor,valid_from,source,import_batch_id,revision,updated_by)
     VALUES($1,$2,$3,'pcs',10000,'2026-11-19','import',$4,1,$5)`,
    [c.branch, supplier, ingredient, batch, actor],
  );
  await q(
    `INSERT INTO bo_supply_requests(id,branch_id,number,kind,supplier_id,lines,revision,created_by,updated_by)
     VALUES($1,$2,1,'supplier',$3,$4,1,$5,$5)`,
    [
      randomUUID(),
      c.branch,
      supplier,
      JSON.stringify([
        { ingredient_id: ingredient, unit: 'pcs', qty: '30', balance_at_request: '0', hint: '10' },
      ]),
      actor,
    ],
  );
  await q(
    `INSERT INTO bo_staff_assignments(id,branch_id,business_date,employee_id,station_code,started_at,set_by,revision)
     VALUES($1,$2,(now() AT TIME ZONE 'Asia/Almaty')::date,$3,'fryer',now(),$4,1)`,
    [randomUUID(), c.branch, employee, actor],
  );
}

test('flags off: GET branches/:id and the ops views are the bo-ui result, 076 rows never leak', () =>
  withSyncDatabases(async (c) => {
    const p = await manager(c);
    const refs = await cards(c);
    const offOptions = backofficeP2Options(loadConfig('api', env(allOff)));
    assert.deepEqual(offOptions, {});
    const before = {};
    for (const [label, options] of Object.entries({ none: {}, 'bo-ui': BO_UI })) {
      const lane = new Backoffice(c.cloud.pool, true, options);
      const off = new Backoffice(c.cloud.pool, true, { ...options, ...offOptions });
      before[label] = stable(await lane.read(p.token, c.branch));
      for (const key of Object.values(CAPABILITY))
        assert.equal(key in before[label].capabilities, false, key);
      assert.deepEqual(stable(await off.read(p.token, c.branch)), before[label]);
    }
    await p2Rows(c, p.actor_id, refs);
    for (const [label, options] of Object.entries({ none: {}, 'bo-ui': BO_UI })) {
      const off = new Backoffice(c.cloud.pool, true, { ...options, ...offOptions });
      // A row in every 076 table changes nothing of the read.
      assert.deepEqual(stable(await off.read(p.token, c.branch)), before[label], label);
      // The second-wave views do not exist while their flags are off: exactly the 404 of an
      // unknown view.
      for (const [view, input] of [...P2_VIEWS, ['bogus', {}]])
        await assert.rejects(
          off.ops(p.token, c.branch, view, input),
          (error) => error.code === 'NOT_FOUND' && error.reason === undefined,
          `${label}: ${view}`,
        );
    }
  }));

test('each second-wave flag adds only its capability key, after every bo-ui key', () =>
  withSyncDatabases(async (c) => {
    const p = await manager(c);
    for (const cloud of [{}, BO_UI]) {
      for (const [option, key] of Object.entries(CAPABILITY)) {
        const base = { ...cloud, ...BASE[option] };
        const off = stable(await new Backoffice(c.cloud.pool, true, base).read(p.token, c.branch));
        const state = stable(
          await new Backoffice(c.cloud.pool, true, { ...base, [option]: true }).read(
            p.token,
            c.branch,
          ),
        );
        assert.deepEqual(Object.keys(state.capabilities), [...Object.keys(off.capabilities), key]);
        assert.equal(state.capabilities[key], true, key);
        // Step 2: with roles on, supply also lists its rights in permissions[], after the rest.
        const expected =
          option === 'supplyEnabled' && Array.isArray(off.permissions)
            ? {
                ...off,
                permissions: [
                  ...off.permissions,
                  'suppliers.write',
                  'supply.write',
                  'supply.close',
                ],
              }
            : off;
        assert.deepEqual(withoutKeys(state, [key]), expected);
        // Without the flag it builds on, the key is there and false.
        if (Object.keys(BASE[option]).length) {
          const alone = stable(
            await new Backoffice(c.cloud.pool, true, { [option]: true }).read(p.token, c.branch),
          );
          assert.equal(alone.capabilities[key], false, key);
        }
      }
      const all = stable(
        await new Backoffice(c.cloud.pool, true, {
          ...cloud,
          stockV2Enabled: true,
          staffPositionsEnabled: true,
          ...Object.fromEntries(Object.keys(CAPABILITY).map((o) => [o, true])),
        }).read(p.token, c.branch),
      );
      const keys = Object.keys(all.capabilities);
      assert.deepEqual(keys.slice(-3), ['supply', 'stock_reports', 'staff_assignment']);
      // After every bo-ui key, stock_p1 included.
      if (cloud.stockV2Enabled) assert.equal(keys.at(-4), 'stock_p1');
    }
  }));

test('HTTP: the API maps the config flags; flag-off bodies are the bo-ui bodies', () =>
  withSyncDatabases(async (c) => {
    const p = await manager(c);
    const base = { ...c.cloud.config, backofficeEnabled: true, catalogAdminEnabled: true };
    const read = async (config) => {
      const api = await running(createApi, config);
      try {
        const get = async (path) => {
          const response = await request(
            `${api.url}/v1/admin/backoffice/branches/${c.branch}${path}`,
            { headers: { Authorization: `Bearer ${p.token}` } },
          );
          return { status: response.status, body: await response.json() };
        };
        const views = {};
        for (const [view, input] of P2_VIEWS)
          views[view] = await get(`/ops/${view}?${new URLSearchParams(input)}`);
        return { branch: await get(''), views, bogus: await get('/ops/bogus') };
      } finally {
        await api.app.close();
      }
    };
    const previous = process.env.BACKOFFICE_STOCK_V2_ENABLED;
    // Supply builds on stock v2, which the API reads from its environment (cloud lane flag).
    process.env.BACKOFFICE_STOCK_V2_ENABLED = 'true';
    try {
      const off = await read({ ...base, backofficeStaffPositionsEnabled: true });
      assert.equal(off.branch.status, 200);
      for (const key of Object.values(CAPABILITY))
        assert.equal(key in off.branch.body.capabilities, false, key);
      // A second-wave view while off answers exactly like an unknown view.
      for (const [view, answer] of Object.entries(off.views)) {
        assert.equal(answer.status, 404, view);
        assert.deepEqual(stable(answer.body), stable(off.bogus.body), view);
      }
      // The same config with every second-wave field explicitly false is the same API.
      const explicit = await read({
        ...base,
        backofficeStaffPositionsEnabled: true,
        ...Object.fromEntries(Object.keys(OPTION).map((key) => [key, false])),
      });
      assert.deepEqual(stable(explicit.branch.body), stable(off.branch.body));
      const on = await read({
        ...base,
        backofficeStaffPositionsEnabled: true,
        ...Object.fromEntries(Object.keys(OPTION).map((key) => [key, true])),
      });
      assert.deepEqual(on.branch.body.capabilities, {
        ...off.branch.body.capabilities,
        supply: true,
        stock_reports: true,
        staff_assignment: true,
      });
      assert.deepEqual(
        stable(withoutKeys(on.branch.body, ['supply', 'stock_reports', 'staff_assignment'])),
        stable(off.branch.body),
      );
    } finally {
      if (previous === undefined) delete process.env.BACKOFFICE_STOCK_V2_ENABLED;
      else process.env.BACKOFFICE_STOCK_V2_ENABLED = previous;
    }
  }));
