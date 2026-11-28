// Kitchen timer norms (owner 27.11): the edge runtime reads the station norms of the applied
// station plan. station-plan-read-grant.mjs adds exactly two table grants on a live cashier,
// never resets the role, and the station list works with and without them.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';
import { terminalAccessGrants } from '../../infra/windows/terminal-access-grants.mjs';
import { stationPlanReadGrant } from '../../infra/windows/station-plan-read-grant.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** An edge schema at the first `count` repo migrations with a runtime role granted like the
 * live cashier: runtime grants, terminal access and presence (020/021), restore fence (023). */
async function cashier(count, run) {
  const config = loadConfig('edge');
  const admin = createPool(config.databaseUrl, 2);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 20);
  const schema = `plan_read_${suffix}`;
  const roles = { runtime: `pr_runtime_${suffix}`, other: `pr_other_${suffix}` };
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-plan-read-'));
  let pool;
  try {
    const names = (await readdir(join(root, 'db/edge/migrations')))
      .filter((n) => n.endsWith('.sql'))
      .sort()
      .slice(0, count);
    for (const name of names)
      await copyFile(join(root, 'db/edge/migrations', name), join(dir, name));
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(config.databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.toString(), 3);
    await migrate(pool, dir, 'edge');
    const branchId = randomUUID();
    await pool.query(
      "INSERT INTO branch_config(id,code,name,timezone) VALUES ($1,'LINK','Synthetic','Asia/Almaty')",
      [branchId],
    );
    for (const role of Object.values(roles))
      await admin.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT`);
    await run({ pool, admin, schema, roles, branchId, grantLikeCashier });
  } finally {
    if (pool) {
      for (const role of Object.values(roles))
        await pool.query(`DROP OWNED BY ${role}`).catch(() => {});
      await pool.end();
    }
    for (const role of Object.values(roles))
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
  async function grantLikeCashier(target) {
    await applyEdgeRuntimeGrants(pool, target, { schema });
    await pool.query(terminalAccessGrants(target, schema, { presence: true }));
  }
}

const allowed = async (pool, sql, args) => (await pool.query(sql, args)).rows[0].ok;
const tablePrivilege = (pool, role, table, privilege) =>
  allowed(pool, 'SELECT has_table_privilege($1,$2,$3) ok', [role, table, privilege]);
/** What other guarded tools granted the runtime role on a live cashier (020/021/023). */
async function cashierGrants(pool, role) {
  return {
    presence: await tablePrivilege(pool, role, 'terminal_presence', 'INSERT'),
    registry: await tablePrivilege(pool, role, 'terminal_access_registry', 'SELECT'),
    pairLimits: await tablePrivilege(pool, role, 'terminal_pair_limits', 'INSERT'),
    orders: await tablePrivilege(pool, role, 'local_orders', 'INSERT'),
  };
}

test('station-plan-read-grant adds and removes exactly two table grants; replays change nothing', () =>
  cashier(24, async ({ pool, admin, schema, roles, branchId, grantLikeCashier }) => {
    await grantLikeCashier(roles.runtime);
    await pool.query(`GRANT SELECT ON station_plan_active TO ${roles.other}`);
    const expected = { presence: true, registry: true, pairLimits: true, orders: true };
    assert.deepEqual(await cashierGrants(pool, roles.runtime), expected);
    const client = await pool.connect();
    const run = (mode, extra = {}) =>
      stationPlanReadGrant(client, {
        mode,
        branchId,
        schema,
        runtimeRole: roles.runtime,
        ...extra,
      });
    const entries = ['station_plan_active', 'station_plan_snapshots'].map(
      (t) => `${roles.runtime}|${t}||SELECT`,
    );
    try {
      assert.deepEqual(await run('inspect'), {
        mode: 'inspect',
        runtimeRole: roles.runtime,
        stationPlanRead: false,
        changed: false,
        privilegesAdded: [],
        privilegesRemoved: [],
      });
      assert.deepEqual(await run('apply'), {
        mode: 'apply',
        runtimeRole: roles.runtime,
        stationPlanRead: true,
        changed: true,
        privilegesAdded: entries,
        privilegesRemoved: [],
      });
      assert.equal(
        await tablePrivilege(pool, roles.runtime, 'station_plan_active', 'SELECT'),
        true,
      );
      assert.equal(
        await tablePrivilege(pool, roles.runtime, 'station_plan_snapshots', 'INSERT'),
        false,
      );
      assert.equal(
        await tablePrivilege(pool, roles.runtime, 'station_plan_receipts', 'SELECT'),
        false,
      );
      assert.deepEqual(await cashierGrants(pool, roles.runtime), expected);
      assert.equal((await run('apply')).changed, false);
      assert.equal((await run('inspect')).stationPlanRead, true);
      assert.deepEqual((await run('revoke')).privilegesRemoved, entries);
      assert.equal(
        await tablePrivilege(pool, roles.runtime, 'station_plan_active', 'SELECT'),
        false,
      );
      assert.equal(await tablePrivilege(pool, roles.other, 'station_plan_active', 'SELECT'), true);
      assert.deepEqual(await cashierGrants(pool, roles.runtime), expected);
      assert.equal((await run('revoke')).changed, false);

      // Refusals change nothing.
      await assert.rejects(run('apply', { branchId: randomUUID() }), /Branch differs/);
      await assert.rejects(run('grant'), /Invalid mode/);
      await pool.query(`GRANT SELECT ON station_plan_active TO ${roles.runtime}`);
      await assert.rejects(run('apply'), /Partial station plan grant/);
      await pool.query(`REVOKE SELECT ON station_plan_active FROM ${roles.runtime}`);
      await pool.query(`GRANT INSERT ON station_plan_snapshots TO ${roles.runtime}`);
      await assert.rejects(run('apply'), /Unexpected privilege on the station plan/);
      await pool.query(`REVOKE INSERT ON station_plan_snapshots FROM ${roles.runtime}`);
      await admin.query(`ALTER ROLE ${roles.runtime} CREATEDB`);
      await assert.rejects(run('apply'), /Existing restricted runtime role required/);
      await admin.query(`ALTER ROLE ${roles.runtime} NOCREATEDB`);
      assert.equal(
        await tablePrivilege(pool, roles.runtime, 'station_plan_active', 'SELECT'),
        false,
      );
      assert.equal((await run('apply')).changed, true);
    } finally {
      client.release();
    }
  }));

test('station-plan-read-grant refuses an edge without station plans (before schema024)', () =>
  cashier(23, async ({ pool, schema, roles, branchId, grantLikeCashier }) => {
    await grantLikeCashier(roles.runtime);
    const client = await pool.connect();
    try {
      await assert.rejects(
        stationPlanReadGrant(client, {
          mode: 'apply',
          branchId,
          schema,
          runtimeRole: roles.runtime,
        }),
        /Station plan schema024 required/,
      );
    } finally {
      client.release();
    }
  }));
