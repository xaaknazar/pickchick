import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApi } from '@pickchick/api';
import { loadConfig } from '@pickchick/platform';
import { BACKOFFICE_P1_FLAGS } from '../../packages/platform/dist/config.js';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import {
  Backoffice,
  backofficeP1Options,
  grantBackoffice,
} from '../../packages/backoffice-core/dist/index.js';
import { request, running, withSyncDatabases } from '../helpers/sync.mjs';

/**
 * Back-office P1 flags (lane bo-ui, design-bo-ui.md section 2): loadConfig, the options of the
 * back office and GET branches/:id capabilities. With every P1 flag off the API config, the
 * back-office payloads and the ops views are those of the cloud lane result (43806cf4).
 */
const FLAGS = [
  'BACKOFFICE_POS_DAY_ENABLED',
  'BACKOFFICE_STOCK_AUTOCONSUME_ENABLED',
  'BACKOFFICE_MANAGER_SHIFTS_ENABLED',
  'BACKOFFICE_STAFF_POSITIONS_ENABLED',
  'BACKOFFICE_DISCOUNTS_ENABLED',
];
const CONFIG_KEY = {
  BACKOFFICE_POS_DAY_ENABLED: 'backofficePosDayEnabled',
  BACKOFFICE_STOCK_AUTOCONSUME_ENABLED: 'backofficeStockAutoconsumeEnabled',
  BACKOFFICE_MANAGER_SHIFTS_ENABLED: 'backofficeManagerShiftsEnabled',
  BACKOFFICE_STAFF_POSITIONS_ENABLED: 'backofficeStaffPositionsEnabled',
  BACKOFFICE_DISCOUNTS_ENABLED: 'backofficeDiscountsEnabled',
};
const OPTION = {
  backofficePosDayEnabled: 'posDayEnabled',
  backofficeStockAutoconsumeEnabled: 'stockAutoconsumeEnabled',
  backofficeManagerShiftsEnabled: 'managerShiftsEnabled',
  backofficeStaffPositionsEnabled: 'staffPositionsEnabled',
  backofficeDiscountsEnabled: 'discountsEnabled',
};
/** Capability key of each back-office option, in the order GET branches/:id lists them. */
const CAPABILITY = {
  posDayEnabled: 'pos_day',
  stockAutoconsumeEnabled: 'stock_autoconsume',
  managerShiftsEnabled: 'manager_shifts',
  staffPositionsEnabled: 'staff_positions',
  discountsEnabled: 'discounts',
};
/** GET branches/:id capabilities of the cloud lane result (roles.test.mjs D0 list + its flags). */
const CLOUD_CAPABILITIES = [
  'operational_shift_filter',
  'bank_settlement',
  'push_delivery',
  'external_reviews',
  'fiscal_shift',
  'edge_configuration_delivery',
];
const CLOUD_FLAGS = { rolesEnabled: true, stockV2Enabled: true, salesReportEnabled: true };
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
/**
 * The read without what the listed P1 capabilities add. pos_day (step 2, «Касса») also adds the
 * named cash desks of the order registry (`pos_terminals`), the cashier names of the listed shifts
 * (`pos_staff`), `paid_total_minor` of the cashier metrics and, per POS order, `terminal_id` (none
 * in these empty branches).
 */
const without = (state, keys) => {
  const capabilities = { ...state.capabilities };
  for (const key of keys) delete capabilities[key];
  const copy = { ...state, capabilities };
  // stock_p1 (stock P1 under the existing BACKOFFICE_STOCK_V2_ENABLED, step 4) also adds
  // counted_at to the stock rows and the storno keys to the documents (none in these branches).
  if (keys.includes('stock_p1')) {
    assert.deepEqual(copy.stock, [], 'no stock rows in these branches');
    assert.deepEqual(copy.documents, [], 'no documents in these branches');
  }
  // stock_autoconsume (step 5) also lists its two P1 permissions while it can run.
  if (
    keys.includes('stock_autoconsume') &&
    state.capabilities.stock_autoconsume === true &&
    Array.isArray(copy.permissions)
  ) {
    assert.deepEqual(copy.permissions.slice(-2), ['stock.settings', 'consumption.write']);
    copy.permissions = copy.permissions.slice(0, -2);
  }
  // ... and the branch mode of the stock page (no settings row: off).
  if (keys.includes('stock_autoconsume') && state.capabilities.stock_autoconsume === true) {
    assert.deepEqual(copy.stock_settings, { autoconsume_mode: 'off', start_at: null, revision: 0 });
    delete copy.stock_settings;
  }
  if (keys.includes('pos_day')) {
    assert.ok(Array.isArray(copy.pos_terminals), 'pos_day adds pos_terminals');
    assert.deepEqual(copy.pos_staff, {}, 'pos_day adds pos_staff');
    assert.equal(typeof copy.cashier_metrics.paid_total_minor, 'string');
    delete copy.pos_terminals;
    delete copy.pos_staff;
    copy.cashier_metrics = { ...copy.cashier_metrics };
    delete copy.cashier_metrics.paid_total_minor;
  }
  return copy;
};

test('loadConfig: the five P1 flags default off, add a key only when on, and are validated', () => {
  assert.deepEqual([...BACKOFFICE_P1_FLAGS], FLAGS);
  const base = loadConfig('api', env());
  assert.deepEqual(loadConfig('api', env(allOff)), base);
  // An existing cloud flag adds nothing to the config (the back office reads it itself).
  assert.deepEqual(loadConfig('api', env({ BACKOFFICE_STOCK_V2_ENABLED: 'true' })), base);
  for (const name of FLAGS) {
    const extra =
      name === 'BACKOFFICE_STOCK_AUTOCONSUME_ENABLED'
        ? { BACKOFFICE_STOCK_V2_ENABLED: 'true' }
        : {};
    assert.deepEqual(loadConfig('api', env({ ...allOff, ...extra, [name]: 'true' })), {
      ...base,
      [CONFIG_KEY[name]]: true,
    });
    for (const bad of ['1', 'TRUE', 'yes', '', 'on'])
      assert.throws(() => loadConfig('api', env({ [name]: bad })), new RegExp(name));
    // Only the cloud API with the back office.
    assert.throws(
      () => loadConfig('api', env({ ...extra, BACKOFFICE_ENABLED: 'false', [name]: 'true' })),
      new RegExp(name),
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
  assert.throws(
    () => loadConfig('api', env({ BACKOFFICE_STOCK_AUTOCONSUME_ENABLED: 'true' })),
    /requires BACKOFFICE_STOCK_V2_ENABLED/,
  );
  assert.throws(
    () =>
      loadConfig(
        'api',
        env({ BACKOFFICE_STOCK_AUTOCONSUME_ENABLED: 'true', BACKOFFICE_STOCK_V2_ENABLED: 'false' }),
      ),
    /requires BACKOFFICE_STOCK_V2_ENABLED/,
  );
  // The edge keeps working with every P1 flag off.
  const edge = loadConfig('edge', {
    APP_ENV: 'local',
    EDGE_DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:55433/pickchick_edge',
    EDGE_BRANCH_ID: randomUUID(),
    ...allOff,
  });
  for (const key of Object.values(CONFIG_KEY)) assert.equal(key in edge, false, key);
});

test('backofficeP1Options: a back-office option only for a flag that is on', () => {
  assert.deepEqual(backofficeP1Options({}), {});
  assert.deepEqual(backofficeP1Options(loadConfig('api', env(allOff))), {});
  const on = loadConfig(
    'api',
    env({
      ...Object.fromEntries(FLAGS.map((name) => [name, 'true'])),
      BACKOFFICE_STOCK_V2_ENABLED: 'true',
    }),
  );
  assert.deepEqual(backofficeP1Options(on), {
    posDayEnabled: true,
    stockAutoconsumeEnabled: true,
    managerShiftsEnabled: true,
    staffPositionsEnabled: true,
    discountsEnabled: true,
  });
  for (const [key, option] of Object.entries(OPTION))
    assert.deepEqual(backofficeP1Options({ [key]: true }), { [option]: true });
  assert.deepEqual(backofficeP1Options({ backofficeDiscountsEnabled: false }), {});
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
/** One row in every cloud075 table: the flag-off payloads must not see any of them. */
async function p1Rows(c, actor) {
  const q = (sql, args) => c.cloud.pool.query(sql, args);
  await q(
    "INSERT INTO bo_stock_settings(branch_id,autoconsume_mode,start_at,revision,updated_by) VALUES($1,'dry_run','2026-11-19T00:00:00+05:00',1,$2)",
    [c.branch, actor],
  );
  await q(
    "INSERT INTO bo_menu_stock_links(branch_id,catalog_key,product_slug,effect,lines,revision,updated_by) VALUES($1,'pick-water','pick-water','none','[]',1,$2)",
    [c.branch, actor],
  );
  await q(
    "INSERT INTO bo_consumption_items(branch_id,source,order_id,sold_at,trigger_kind,revision) VALUES($1,'pos',$2,now(),'kitchen_started',1)",
    [c.branch, randomUUID()],
  );
  await q(
    "INSERT INTO bo_manager_shifts(id,branch_id,business_date,opened_at,template_version,revision,opened_by) VALUES($1,$2,(now() AT TIME ZONE 'Asia/Almaty')::date,now(),1,1,$3)",
    [randomUUID(), c.branch, actor],
  );
  await q(
    "INSERT INTO bo_discounts(id,branch_id,name,kind,percent_bp,revision,created_by,updated_by) VALUES($1,$2,'Синтетическая','percent',1000,1,$3,$3)",
    [randomUUID(), c.branch, actor],
  );
}

test('flags off: GET branches/:id and the ops views are the cloud lane result, 075 rows never leak', () =>
  withSyncDatabases(async (c) => {
    const p = await manager(c);
    const offOptions = backofficeP1Options(loadConfig('api', env(allOff)));
    for (const cloud of [{}, CLOUD_FLAGS]) {
      const lane = new Backoffice(c.cloud.pool, true, cloud);
      const off = new Backoffice(c.cloud.pool, true, { ...cloud, ...offOptions });
      const before = stable(await lane.read(p.token, c.branch));
      // With stock v2 on and 075 with its rights, stock P1 rides the existing flag (design-bo-ui
      // 2, step 4): its key comes last; without 075 the key is absent (stock-p1.test.mjs).
      assert.deepEqual(Object.keys(before.capabilities), [
        ...CLOUD_CAPABILITIES,
        ...(cloud.rolesEnabled ? ['roles', 'stock_v2', 'sales_report', 'stock_p1'] : []),
      ]);
      if (cloud.stockV2Enabled)
        assert.deepEqual(Object.keys(without(before, ['stock_p1']).capabilities), [
          ...CLOUD_CAPABILITIES,
          'roles',
          'stock_v2',
          'sales_report',
        ]);
      assert.deepEqual(stable(await off.read(p.token, c.branch)), before);
      if (cloud.rolesEnabled) continue;
      await p1Rows(c, p.actor_id);
      assert.deepEqual(stable(await off.read(p.token, c.branch)), before);
      assert.deepEqual(stable(await lane.read(p.token, c.branch)), before);
    }
    // The P1 views do not exist while their flags are off: exactly the 404 of an unknown view.
    // menu-links is a stock P1 view (step 5): it rides BACKOFFICE_STOCK_V2_ENABLED like the
    // storno (design-bo-ui 8 q5), so it is unknown only while stock v2 is off.
    for (const cloud of [CLOUD_FLAGS, {}]) {
      const off = new Backoffice(c.cloud.pool, true, { ...cloud, ...offOptions });
      for (const view of [
        'pos-day',
        'consumption',
        ...(cloud.stockV2Enabled ? [] : ['menu-links']),
        'manager-shifts',
        'discounts',
        'bogus',
      ])
        await assert.rejects(
          off.ops(p.token, c.branch, view, {}),
          (error) => error.code === 'NOT_FOUND' && error.reason === undefined,
        );
    }
  }));

test('each P1 flag adds only its capability key (pos_day also the registry fields), after the cloud lane keys', () =>
  withSyncDatabases(async (c) => {
    const p = await manager(c);
    for (const cloud of [{}, CLOUD_FLAGS]) {
      const off = stable(await new Backoffice(c.cloud.pool, true, cloud).read(p.token, c.branch));
      for (const [option, key] of Object.entries(CAPABILITY)) {
        const state = stable(
          await new Backoffice(c.cloud.pool, true, { ...cloud, [option]: true }).read(
            p.token,
            c.branch,
          ),
        );
        // P1 keys in the order of design-bo-ui 2: stock_p1 (stock v2 with 075) stays last.
        const offKeys = Object.keys(off.capabilities).filter((k) => k !== 'stock_p1');
        assert.deepEqual(Object.keys(state.capabilities), [
          ...offKeys,
          key,
          ...(cloud.stockV2Enabled ? ['stock_p1'] : []),
        ]);
        assert.deepEqual(without(state, [key]), off);
        // Autoconsume consumes by the stock v2 links: without stock v2 it cannot run.
        assert.equal(
          state.capabilities[key],
          option === 'stockAutoconsumeEnabled' ? cloud.stockV2Enabled === true : true,
          key,
        );
      }
      const all = stable(
        await new Backoffice(c.cloud.pool, true, {
          ...cloud,
          ...Object.fromEntries(Object.keys(CAPABILITY).map((o) => [o, true])),
        }).read(p.token, c.branch),
      );
      assert.deepEqual(Object.keys(all.capabilities), [
        ...Object.keys(off.capabilities).filter((k) => k !== 'stock_p1'),
        'pos_day',
        'stock_autoconsume',
        'manager_shifts',
        'staff_positions',
        'discounts',
        ...(cloud.stockV2Enabled ? ['stock_p1'] : []),
      ]);
    }
  }));

test('HTTP: the API maps the config flags; flag-off bodies are the cloud lane bodies', () =>
  withSyncDatabases(async (c) => {
    const p = await manager(c);
    const base = { ...c.cloud.config, backofficeEnabled: true, catalogAdminEnabled: true };
    const read = async (config) => {
      const api = await running(createApi, config);
      try {
        const get = async (path) => {
          const response = await request(
            `${api.url}/v1/admin/backoffice/branches/${c.branch}${path}`,
            {
              headers: { Authorization: `Bearer ${p.token}` },
            },
          );
          return { status: response.status, body: await response.json() };
        };
        return {
          branch: await get(''),
          posDay: await get('/ops/pos-day?date=2026-11-19'),
          bogus: await get('/ops/bogus'),
        };
      } finally {
        await api.app.close();
      }
    };
    const off = await read(base);
    assert.equal(off.branch.status, 200);
    assert.deepEqual(Object.keys(off.branch.body.capabilities), CLOUD_CAPABILITIES);
    for (const key of Object.values(CAPABILITY))
      assert.equal(JSON.stringify(off.branch.body.capabilities).includes(key), false, key);
    // A P1 view while off answers exactly like an unknown view.
    assert.equal(off.posDay.status, 404);
    assert.deepEqual(stable(off.posDay.body), stable(off.bogus.body));
    // The same config with every P1 field explicitly false is the same API.
    const explicit = await read({
      ...base,
      ...Object.fromEntries(Object.keys(OPTION).map((key) => [key, false])),
    });
    assert.deepEqual(stable(explicit.branch.body), stable(off.branch.body));
    const on = await read({
      ...base,
      backofficePosDayEnabled: true,
      backofficeManagerShiftsEnabled: true,
      backofficeStaffPositionsEnabled: true,
      backofficeDiscountsEnabled: true,
    });
    assert.deepEqual(on.branch.body.capabilities, {
      ...off.branch.body.capabilities,
      pos_day: true,
      manager_shifts: true,
      staff_positions: true,
      discounts: true,
    });
    assert.deepEqual(
      stable(
        without(on.branch.body, ['pos_day', 'manager_shifts', 'staff_positions', 'discounts']),
      ),
      stable(off.branch.body),
    );
  }));
