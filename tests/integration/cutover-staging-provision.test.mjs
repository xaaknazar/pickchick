import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '../../packages/database/dist/index.js';
import { backofficeGrants } from '../../infra/staging/backoffice-grants.mjs';
import {
  POS_SALES_RELATIONS,
  assertCloudPosSalesPrivileges,
  cloudPosSalesGrants,
} from '../../infra/staging/pos-sales-grants.mjs';
import {
  SALES_REPORT_TABLES,
  assertBackofficeCutoverPrivileges,
  backofficeCutoverGrants,
} from '../../infra/staging/backoffice-cutover-grants.mjs';
import {
  AUTOCONSUME_READ_TABLES,
  BACKOFFICE_P1_RELATIONS,
  POS_DAY_TABLES,
  assertBackofficeP1Privileges,
  backofficeP1Grants,
} from '../../infra/staging/backoffice-p1-grants.mjs';
import { loadConfig } from '../../packages/platform/dist/index.js';

// Cutover 19.11 (CR cloud-2 section 2, CR cloud-3 section 1, CR cloud-4 section 1): the staging
// provision grants of the cloud073 posSales projection and the cloud074 back-office cutover. The
// block between the cutover:integration markers of infra/staging/provision.mjs runs here as is
// (only the role name is replaced), after backofficeGrants as in the provision transaction, on a
// migrated cloud schema, for every combination of the five switches.
// Lane bo-ui (CR bo-ui-1 section 1, CR bo-ui-5 section 2, CR bo-ui-6 section 1): the block between
// the cutover:bo-ui markers (cloud075 back-office P1, the last statement of the transaction) runs
// the same way after the cutover block, with the config loadConfig('api') makes of the P1 flags,
// for every combination of the seven P1 switches.

const connection =
  process.env.CLOUD_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55432/pickchick_cloud';
const checked = new URL(connection);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(checked.hostname), 'Local PostgreSQL only');
assert.equal(checked.pathname, '/pickchick_cloud');

const source = readFileSync(new URL('../../infra/staging/provision.mjs', import.meta.url), 'utf8');
const BEGIN = '// cutover:integration begin';
const END = '// cutover:integration end';
const block = source.slice(source.indexOf(BEGIN), source.indexOf(END));
const P1_BEGIN = '// cutover:bo-ui begin';
const P1_END = '// cutover:bo-ui end';
const p1Block = source.slice(source.indexOf(P1_BEGIN), source.indexOf(P1_END));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
/**
 * The provision block for `role`; the returned function runs it with the switches of `flags` on
 * `schema`. provision.mjs migrates into public and calls the helpers without a schema (their
 * default is public); here the helpers get the test schema as that default.
 */
function provisionBlock(role, schema) {
  const body = block.replaceAll("'pickchick_app'", `'${role}'`);
  assert.ok(!body.includes('pickchick_app'));
  for (const helper of [
    'cloudPosSalesGrants',
    'backofficeCutoverGrants',
    'assertCloudPosSalesPrivileges',
    'assertBackofficeCutoverPrivileges',
  ])
    assert.doesNotMatch(body, new RegExp(`${helper}\\([^)]*'public'`));
  const run = new AsyncFunction(
    'client',
    'config',
    'process',
    'cloudPosSalesGrants',
    'backofficeCutoverGrants',
    'assertCloudPosSalesPrivileges',
    'assertBackofficeCutoverPrivileges',
    body,
  );
  return (client, flags) =>
    run(
      client,
      {
        ...(flags.receiver ? { posSalesSyncEnabled: true } : {}),
        ...(flags.backoffice ? { backofficeEnabled: true } : {}),
      },
      {
        env: {
          BACKOFFICE_ROLES_ENABLED: String(flags.roles),
          BACKOFFICE_STOCK_V2_ENABLED: String(flags.stockV2),
          BACKOFFICE_SALES_REPORT_ENABLED: String(flags.salesReport),
        },
      },
      (name, options) => cloudPosSalesGrants(name, options, schema),
      (name, options) => backofficeCutoverGrants(name, options, schema),
      (db, name, options) => assertCloudPosSalesPrivileges(db, name, options, schema),
      (db, name, options) => assertBackofficeCutoverPrivileges(db, name, options, schema),
    );
}

async function cloudSchema(
  run,
  directory = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url)),
) {
  const schema = 'cutover_provision_' + randomUUID().replaceAll('-', '');
  const admin = createPool(connection, 1);
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.toString(), 2);
    await migrate(pool, directory, 'cloud');
    await run(pool, schema);
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

/** Runs `operation` in a transaction with a fresh NOLOGIN role, always rolled back. */
async function withRole(pool, operation) {
  const client = await pool.connect();
  const role = 'cutover_api_' + randomUUID().replaceAll('-', '').slice(0, 24);
  try {
    await client.query('BEGIN');
    await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    return await operation(client, role);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** Table-level SELECT/INSERT of `role` on the 073 tables and on bo_role_designations. */
async function tableRights(client, role) {
  const names = [...Object.keys(POS_SALES_RELATIONS), 'bo_role_designations'];
  const rows = (
    await client.query(
      `SELECT t, has_table_privilege($1, t::regclass, 'SELECT') AS s,
         has_table_privilege($1, t::regclass, 'INSERT') AS i,
         has_table_privilege($1, t::regclass, 'DELETE') AS d,
         has_table_privilege($1, t::regclass, 'TRUNCATE') AS tr
       FROM unnest($2::text[]) t ORDER BY t`,
      [role, names],
    )
  ).rows;
  return Object.fromEntries(
    rows.map((row) => {
      assert.equal(row.d, false, `${row.t} DELETE`);
      assert.equal(row.tr, false, `${row.t} TRUNCATE`);
      return [row.t, (row.s ? 'S' : '') + (row.i ? 'I' : '')];
    }),
  );
}

function expectedRights({ receiver, backoffice, roles }) {
  const rights = {};
  // The back-office read set of 073 (every table but the inbox) covers the report tables that
  // the 074 helper adds, so the exact 073 set holds after both helpers.
  for (const name of SALES_REPORT_TABLES) assert.ok(name in POS_SALES_RELATIONS);
  for (const name of Object.keys(POS_SALES_RELATIONS))
    rights[name] = receiver ? 'SI' : backoffice && name !== 'cloud_pos_sale_inbox' ? 'S' : '';
  rights.bo_role_designations = backoffice && roles ? 'S' : '';
  return rights;
}

const combinations = [];
for (let mask = 0; mask < 32; mask += 1)
  combinations.push({
    receiver: Boolean(mask & 1),
    backoffice: Boolean(mask & 2),
    roles: Boolean(mask & 4),
    stockV2: Boolean(mask & 8),
    salesReport: Boolean(mask & 16),
  });

test('provision.mjs: the 073 reset, then the 074 helper, then both exact checks, after backofficeGrants', () => {
  assert.ok(source.indexOf(BEGIN) > 0 && source.indexOf(END) > source.indexOf(BEGIN));
  const at = (text) => {
    const index = source.indexOf(text);
    assert.ok(index > 0, text);
    assert.equal(source.indexOf(text, index + 1), -1, `${text} once`);
    return index;
  };
  const order = [
    "backofficeGrants('pickchick_app', config.backofficeEnabled === true)",
    BEGIN,
    "cloudPosSalesGrants('pickchick_app', posSales)",
    "backofficeCutoverGrants('pickchick_app', cutover)",
    "assertCloudPosSalesPrivileges(client, 'pickchick_app', posSales)",
    "assertBackofficeCutoverPrivileges(client, 'pickchick_app', {",
    END,
  ].map(at);
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  // Both helpers take the same back-office switch (CR cloud-4 section 1).
  assert.match(block, /backoffice: config\.backofficeEnabled === true,/);
  assert.match(block, /backoffice: posSales\.backoffice,/);
  // The block is inside the one provision transaction, after every other grant helper but the
  // bo-ui P1 helper, which is the last statement of the transaction (CR bo-ui-1 section 1).
  const between = source.slice(source.indexOf(END), source.indexOf(P1_BEGIN));
  assert.doesNotMatch(between, /Grants\(/);
  assert.match(between, /GRANT INSERT ON bo_records TO pickchick_app/);
  const p1Order = [
    P1_BEGIN,
    "backofficeP1Grants('pickchick_app', p1)",
    "assertBackofficeP1Privileges(client, 'pickchick_app', p1)",
    P1_END,
  ].map(at);
  assert.deepEqual(
    p1Order,
    [...p1Order].sort((a, b) => a - b),
  );
  assert.ok(order.at(-1) < p1Order[0]);
  const tail = source.slice(source.indexOf(P1_END));
  assert.doesNotMatch(tail, /Grants\(|Privileges\(|client\.query/);
  assert.match(tail, /^\/\/ cutover:bo-ui end\n {4}\}\);\n/);
  // The P1 helper takes the same back-office switch as the 073 reset (CR bo-ui-5 section 2).
  assert.match(p1Block, /backoffice: config\.backofficeEnabled === true,/);
  assert.ok(source.indexOf('await transaction(pool, async (client) => {') < order[0]);
});

test('every switch combination: exact 073 and 074 rights or a refused provision', () =>
  cloudSchema(async (pool, schema) => {
    for (const flags of combinations) {
      // Back-office flags without BACKOFFICE_ENABLED are a configuration mistake: the exact checks
      // refuse it and the provision transaction rolls back, the API keeps its previous rights.
      const refused =
        (flags.stockV2 && !flags.backoffice) ||
        (flags.salesReport && !flags.backoffice && !flags.receiver);
      await withRole(pool, async (client, role) => {
        await client.query(backofficeGrants(role, flags.backoffice));
        await client.query('SAVEPOINT provision');
        const run = provisionBlock(role, schema)(client, flags);
        if (refused) {
          await assert.rejects(run, /not writable|not readable/, JSON.stringify(flags));
          await client.query('ROLLBACK TO SAVEPOINT provision');
          return;
        }
        await run;
        assert.deepEqual(
          await tableRights(client, role),
          expectedRights(flags),
          JSON.stringify(flags),
        );
      });
    }
  }));

test('flags switched off again: a second provision leaves no 073 or 074 right', () =>
  cloudSchema((pool, schema) =>
    withRole(pool, async (client, role) => {
      const on = {
        receiver: true,
        backoffice: true,
        roles: true,
        stockV2: true,
        salesReport: true,
      };
      const off = {
        receiver: false,
        backoffice: false,
        roles: false,
        stockV2: false,
        salesReport: false,
      };
      await client.query(backofficeGrants(role, true));
      await provisionBlock(role, schema)(client, on);
      assert.deepEqual(await tableRights(client, role), expectedRights(on));
      // Receiver off, back office on: the read set of the report only.
      const report = { ...on, receiver: false };
      await provisionBlock(role, schema)(client, report);
      assert.deepEqual(await tableRights(client, role), expectedRights(report));
      await client.query(backofficeGrants(role, false));
      await provisionBlock(role, schema)(client, off);
      const none = await tableRights(client, role);
      assert.deepEqual(none, expectedRights(off));
      assert.ok(Object.values(none).every((rights) => rights === ''));
      // No column right survives the reset either.
      const columns = (
        await client.query(
          `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
           WHERE grantee = $1 AND table_name = ANY($2::text[])`,
          [role, [...Object.keys(POS_SALES_RELATIONS), 'bo_role_designations']],
        )
      ).rows;
      assert.deepEqual(columns, []);
    }),
  ));

// ---------------------------------------------------- lane bo-ui: the cloud075 P1 block ----

/** The cutover:bo-ui block for `role`, run with a loadConfig('api') config and an environment. */
function provisionP1Block(role, schema) {
  const body = p1Block.replaceAll("'pickchick_app'", `'${role}'`);
  assert.ok(!body.includes('pickchick_app'));
  for (const helper of ['backofficeP1Grants', 'assertBackofficeP1Privileges'])
    assert.doesNotMatch(body, new RegExp(`${helper}\\([^)]*'public'`));
  const run = new AsyncFunction(
    'client',
    'config',
    'process',
    'backofficeP1Grants',
    'assertBackofficeP1Privileges',
    body,
  );
  return (client, config, env) =>
    run(
      client,
      config,
      { env },
      (name, options) => backofficeP1Grants(name, options, schema),
      (db, name, options) => assertBackofficeP1Privileges(db, name, options, schema),
    );
}

/** The seven P1 switches of provision.mjs and the API environment key of each. */
const P1_ENV = Object.freeze({
  backoffice: 'BACKOFFICE_ENABLED',
  posDay: 'BACKOFFICE_POS_DAY_ENABLED',
  stockV2: 'BACKOFFICE_STOCK_V2_ENABLED',
  autoconsume: 'BACKOFFICE_STOCK_AUTOCONSUME_ENABLED',
  managerShifts: 'BACKOFFICE_MANAGER_SHIFTS_ENABLED',
  staffPositions: 'BACKOFFICE_STAFF_POSITIONS_ENABLED',
  discounts: 'BACKOFFICE_DISCOUNTS_ENABLED',
});
const P1_SWITCHES = Object.keys(P1_ENV);
/** The API environment of `flags`; provision.mjs reads it through loadConfig('api'). */
const p1Environment = (flags) => ({
  APP_ENV: 'local',
  CLOUD_DATABASE_URL: connection,
  REDIS_URL: 'redis://127.0.0.1:56379/0',
  CATALOG_ADMIN_ENABLED: 'true',
  ...Object.fromEntries(P1_SWITCHES.map((name) => [P1_ENV[name], String(flags[name])])),
});
/** The provision tail for `flags`: the cutover block (073/074, receiver and roles off), then P1. */
async function provisionP1(client, role, schema, flags, between = async () => {}) {
  await provisionBlock(role, schema)(client, {
    receiver: false,
    backoffice: flags.backoffice,
    roles: false,
    stockV2: flags.stockV2,
    salesReport: false,
  });
  await between();
  await provisionP1Block(role, schema)(client, loadConfig('api', p1Environment(flags)), {
    BACKOFFICE_STOCK_V2_ENABLED: String(flags.stockV2),
  });
}

/** CR bo-ui-1 section 1, bo-ui-5 section 2, bo-ui-6 section 1, bo-ui-7 section 1, stated again. */
function expectedP1(flags) {
  const on = flags.backoffice;
  const consume = on && flags.stockV2 && flags.autoconsume;
  return {
    bo_stock_settings: consume ? 'SELECT,INSERT,UPDATE' : '',
    bo_menu_stock_links: on && flags.stockV2 ? 'SELECT,INSERT,UPDATE' : '',
    bo_consumption_items: consume ? 'SELECT,INSERT,UPDATE' : '',
    bo_manager_shifts: on && flags.managerShifts ? 'SELECT,INSERT,UPDATE' : '',
    bo_branch_templates: on && (flags.managerShifts || flags.staffPositions) ? 'SELECT,INSERT' : '',
    bo_discounts: on && flags.discounts ? 'SELECT,INSERT,UPDATE' : '',
    bo_discount_revisions: on && flags.discounts ? 'SELECT' : '',
  };
}
const EVERY_PRIVILEGE = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
];
/** Every table right of `role` on each 075 relation ('' when it has none or it is missing). */
async function p1Rights(client, role, schema) {
  const rows = (
    await client.query(
      `SELECT r.name, coalesce(string_agg(p.privilege, ',' ORDER BY p.n), '') AS rights
       FROM unnest($2::text[]) r(name)
       LEFT JOIN unnest($3::text[]) WITH ORDINALITY p(privilege, n)
         ON to_regclass($4 || '.' || r.name) IS NOT NULL
        AND has_table_privilege($1, ($4 || '.' || r.name)::regclass, p.privilege)
       GROUP BY r.name`,
      [role, Object.keys(BACKOFFICE_P1_RELATIONS), EVERY_PRIVILEGE, schema],
    )
  ).rows;
  return Object.fromEntries(
    Object.keys(BACKOFFICE_P1_RELATIONS).map((name) => [
      name,
      rows.find((row) => row.name === name).rights,
    ]),
  );
}
const READ_TABLES = [...new Set([...POS_DAY_TABLES, ...AUTOCONSUME_READ_TABLES])].sort();
/** SELECT of `role` on the tables outside 075 that the P1 helper may add a read on. */
async function p1Reads(client, role, schema) {
  const rows = (
    await client.query(
      `SELECT t, has_table_privilege($1, ($3 || '.' || t)::regclass, 'SELECT') AS s
       FROM unnest($2::text[]) t ORDER BY t`,
      [role, READ_TABLES, schema],
    )
  ).rows;
  return Object.fromEntries(rows.map((row) => [row.t, row.s]));
}

test('bo-ui P1 block: every combination of the seven P1 switches gives the exact 075 rights and only the declared reads, or provision is refused', () =>
  cloudSchema(async (pool, schema) => {
    let provisioned = 0;
    for (let mask = 0; mask < 2 ** P1_SWITCHES.length; mask += 1) {
      const flags = Object.fromEntries(
        P1_SWITCHES.map((name, i) => [name, Boolean(mask & (1 << i))]),
      );
      const label = JSON.stringify(flags);
      const p1On = P1_SWITCHES.some(
        (name) => !['backoffice', 'stockV2'].includes(name) && flags[name],
      );
      // loadConfig refuses a P1 flag without the back office and autoconsume without stock v2:
      // neither the API nor provision starts, the API keeps its previous rights.
      if ((p1On && !flags.backoffice) || (flags.autoconsume && !flags.stockV2)) {
        assert.throws(() => loadConfig('api', p1Environment(flags)), /BACKOFFICE_/, label);
        continue;
      }
      await withRole(pool, async (client, role) => {
        await client.query(backofficeGrants(role, flags.backoffice));
        let before = null;
        await client.query('SAVEPOINT provision');
        const refused = await provisionP1(client, role, schema, flags, async () => {
          before = await p1Reads(client, role, schema);
        }).then(
          () => false,
          (error) => {
            assert.match(String(error.message), /not writable|not readable/, label);
            return true;
          },
        );
        if (refused) {
          // Stock v2 without the back office: the cutover block refuses before the P1 block.
          assert.ok(flags.stockV2 && !flags.backoffice, label);
          return;
        }
        provisioned += 1;
        assert.deepEqual(await p1Rights(client, role, schema), expectedP1(flags), label);
        // Outside 075 only the declared SELECTs are added (CR bo-ui-1 section 1, bo-ui-5 section 2).
        const declared = new Set(
          flags.backoffice
            ? [
                ...(flags.posDay ? POS_DAY_TABLES : []),
                ...(flags.stockV2 && flags.autoconsume ? AUTOCONSUME_READ_TABLES : []),
              ]
            : [],
        );
        const after = await p1Reads(client, role, schema);
        for (const table of READ_TABLES)
          assert.equal(after[table], before[table] || declared.has(table), `${label} ${table}`);
        // The exact 073 set of the cutover block still holds after the P1 reads.
        await assertCloudPosSalesPrivileges(
          client,
          role,
          { receiver: false, backoffice: flags.backoffice },
          schema,
        );
        await assertBackofficeP1Privileges(
          client,
          role,
          {
            backoffice: flags.backoffice,
            posDay: flags.posDay,
            stockV2: flags.stockV2,
            autoconsume: flags.autoconsume,
            managerShifts: flags.managerShifts,
            staffPositions: flags.staffPositions,
            discounts: flags.discounts,
          },
          schema,
        );
      });
    }
    // 2 back-office states x the valid P1 sets: 1 without the back office (stock v2 refused),
    // 48 with it (64 sets minus the 16 with autoconsume and no stock v2).
    assert.equal(provisioned, 49);
  }));

test('bo-ui P1 block: P1 switches off again leave no right on any 075 relation and no column right', () =>
  cloudSchema((pool, schema) =>
    withRole(pool, async (client, role) => {
      const all = Object.fromEntries(P1_SWITCHES.map((name) => [name, true]));
      const none = { ...Object.fromEntries(P1_SWITCHES.map((name) => [name, false])) };
      await client.query(backofficeGrants(role, true));
      await provisionP1(client, role, schema, all);
      assert.deepEqual(await p1Rights(client, role, schema), expectedP1(all));
      await provisionP1(client, role, schema, { ...none, backoffice: true });
      assert.ok(Object.values(await p1Rights(client, role, schema)).every((rights) => !rights));
      await client.query(backofficeGrants(role, false));
      await provisionP1(client, role, schema, none);
      assert.ok(Object.values(await p1Rights(client, role, schema)).every((rights) => !rights));
      const columns = (
        await client.query(
          `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
           WHERE grantee = $1 AND table_name = ANY($2::text[])`,
          [role, Object.keys(BACKOFFICE_P1_RELATIONS)],
        )
      ).rows;
      assert.deepEqual(columns, []);
    }),
  ));

test('bo-ui P1 block before 075: every P1 switch on is accepted and grants nothing on 075', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cutover-provision-074-'));
  try {
    const migrations = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));
    for (const file of await readdir(migrations))
      if (/^\d{3}_[a-z_]+\.sql$/.test(file) && Number(file.slice(0, 3)) <= 74)
        await copyFile(join(migrations, file), join(directory, file));
    await cloudSchema(
      (pool, schema) =>
        withRole(pool, async (client, role) => {
          const all = Object.fromEntries(P1_SWITCHES.map((name) => [name, true]));
          await client.query(backofficeGrants(role, true));
          await provisionP1(client, role, schema, all);
          const missing = (
            await client.query(
              `SELECT count(*)::int AS n FROM unnest($1::text[]) t
               WHERE to_regclass($2 || '.' || t) IS NOT NULL`,
              [Object.keys(BACKOFFICE_P1_RELATIONS), schema],
            )
          ).rows[0].n;
          assert.equal(missing, 0, 'no 075 relation on a 074 schema');
          assert.ok(Object.values(await p1Rights(client, role, schema)).every((rights) => !rights));
        }),
      directory,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
