import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

// Cutover 19.11 (CR cloud-2 section 2, CR cloud-3 section 1, CR cloud-4 section 1): the staging
// provision grants of the cloud073 posSales projection and the cloud074 back-office cutover. The
// block between the cutover:integration markers of infra/staging/provision.mjs runs here as is
// (only the role name is replaced), after backofficeGrants as in the provision transaction, on a
// migrated cloud schema, for every combination of the five switches.

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

async function cloudSchema(run) {
  const schema = 'cutover_provision_' + randomUUID().replaceAll('-', '');
  const admin = createPool(connection, 1);
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.toString(), 2);
    await migrate(
      pool,
      fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url)),
      'cloud',
    );
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
  // The block is inside the one provision transaction, after every other grant helper.
  const tail = source.slice(source.indexOf(END));
  assert.doesNotMatch(tail, /Grants\(/);
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
