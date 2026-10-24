// Stage 2 integration (lane off, finding 1, PM addendum 6): the POS internet line needs one
// column grant for the edge runtime role. The reset-style runtime grant script would also drop
// grants of other guarded tools on a live cashier; cloud-link-grant.mjs adds exactly the grant.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';
import { terminalAccessGrants } from '../../infra/windows/terminal-access-grants.mjs';
import { cloudLinkGrant } from '../../infra/windows/cloud-link-grant.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pinned = JSON.parse(
  await readFile(new URL('../../infra/windows/native-edge-backup-ledger.json', import.meta.url)),
);

/** An edge schema at the first `count` repo migrations with a runtime role granted like the
 * live cashier: runtime grants, terminal access and presence (020/021), restore fence (023). */
async function cashier(count, run) {
  const config = loadConfig('edge');
  const admin = createPool(config.databaseUrl, 2);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 20);
  const schema = `cloud_link_${suffix}`;
  const roles = { runtime: `cl_runtime_${suffix}`, other: `cl_other_${suffix}` };
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-cloud-link-'));
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
const columnPrivilege = (pool, role, column) =>
  allowed(pool, "SELECT has_column_privilege($1,'fulfillment_transport_state',$2,'SELECT') ok", [
    role,
    column,
  ]);
/** What other guarded tools granted the runtime role on a live cashier (020/021/023). */
async function cashierGrants(pool, role) {
  return {
    presence: await tablePrivilege(pool, role, 'terminal_presence', 'INSERT'),
    registry: await tablePrivilege(pool, role, 'terminal_access_registry', 'SELECT'),
    pairLimits: await tablePrivilege(pool, role, 'terminal_pair_limits', 'INSERT'),
    orders: await tablePrivilege(pool, role, 'local_orders', 'INSERT'),
  };
}

for (const count of [23, 24])
  test(`schema0${count}: cloud-link-grant adds and removes exactly the two column grants; replays change nothing`, () =>
    cashier(count, async ({ pool, admin, schema, roles, branchId, grantLikeCashier }) => {
      await grantLikeCashier(roles.runtime);
      // Another role's table-level grant on the same table is neither a problem nor touched.
      await pool.query(`GRANT SELECT ON fulfillment_transport_state TO ${roles.other}`);
      const expected = { presence: true, registry: true, pairLimits: true, orders: true };
      assert.deepEqual(await cashierGrants(pool, roles.runtime), expected);
      const client = await pool.connect();
      const run = (mode, extra = {}) =>
        cloudLinkGrant(client, {
          mode,
          branchId,
          schema,
          runtimeRole: roles.runtime,
          pinned,
          ...extra,
        });
      try {
        const name = `schema0${count}`;
        assert.deepEqual(await run('inspect'), {
          mode: 'inspect',
          schema: name,
          runtimeRole: roles.runtime,
          cloudLink: false,
          changed: false,
          privilegesAdded: [],
          privilegesRemoved: [],
        });
        const entries = ['branch_id', 'last_success_at'].map(
          (c) => `${roles.runtime}|fulfillment_transport_state|${c}|SELECT`,
        );
        assert.deepEqual(await run('apply'), {
          mode: 'apply',
          schema: name,
          runtimeRole: roles.runtime,
          cloudLink: true,
          changed: true,
          privilegesAdded: entries,
          privilegesRemoved: [],
        });
        assert.equal(await columnPrivilege(pool, roles.runtime, 'last_success_at'), true);
        assert.equal(await columnPrivilege(pool, roles.runtime, 'pending_cloud'), false);
        assert.deepEqual(await cashierGrants(pool, roles.runtime), expected);
        assert.equal(
          await tablePrivilege(pool, roles.other, 'fulfillment_transport_state', 'SELECT'),
          true,
        );
        const replay = await run('apply');
        assert.equal(replay.changed, false);
        assert.equal(replay.cloudLink, true);
        assert.equal((await run('inspect')).cloudLink, true);
        assert.deepEqual((await run('revoke')).privilegesRemoved, entries);
        assert.equal(await columnPrivilege(pool, roles.runtime, 'last_success_at'), false);
        assert.deepEqual(await cashierGrants(pool, roles.runtime), expected);
        assert.equal((await run('revoke')).changed, false);

        // Refusals change nothing.
        await assert.rejects(run('apply', { branchId: randomUUID() }), /Branch differs/);
        await assert.rejects(run('apply', { pinned: pinned.slice(0, 20) }), /Pinned edge ledger/);
        await assert.rejects(run('grant'), /Invalid mode/);
        await pool.query(
          "INSERT INTO schema_migrations(scope,version,checksum) VALUES('edge','099_edge_future.sql',$1)",
          ['f'.repeat(64)],
        );
        await assert.rejects(run('apply'), /Reviewed schema023 or schema024 required/);
        await pool.query("DELETE FROM schema_migrations WHERE version='099_edge_future.sql'");
        await pool.query(
          `GRANT SELECT(branch_id) ON fulfillment_transport_state TO ${roles.runtime}`,
        );
        await assert.rejects(run('apply'), /Partial cloud link grant/);
        await pool.query(
          `REVOKE SELECT(branch_id) ON fulfillment_transport_state FROM ${roles.runtime}`,
        );
        await pool.query(`GRANT SELECT ON fulfillment_transport_state TO ${roles.runtime}`);
        await assert.rejects(run('apply'), /Unexpected table privilege/);
        await pool.query(`REVOKE SELECT ON fulfillment_transport_state FROM ${roles.runtime}`);
        await admin.query(`ALTER ROLE ${roles.runtime} CREATEDB`);
        await assert.rejects(run('apply'), /Existing restricted runtime role required/);
        await admin.query(`ALTER ROLE ${roles.runtime} NOCREATEDB`);
        assert.equal(await columnPrivilege(pool, roles.runtime, 'last_success_at'), false);
        assert.equal((await run('apply')).changed, true);
      } finally {
        client.release();
      }
    }));

test('why not the runtime grant script on a live cashier: its reset drops terminal access and presence', () =>
  cashier(24, async ({ pool, schema, roles, grantLikeCashier }) => {
    await grantLikeCashier(roles.runtime);
    assert.deepEqual(await cashierGrants(pool, roles.runtime), {
      presence: true,
      registry: true,
      pairLimits: true,
      orders: true,
    });
    // What `scripts/edge-runtime-grants.mjs <role> --cloud-link` does.
    await applyEdgeRuntimeGrants(pool, roles.runtime, { schema, cloudLink: true });
    assert.equal(await columnPrivilege(pool, roles.runtime, 'last_success_at'), true);
    assert.deepEqual(await cashierGrants(pool, roles.runtime), {
      presence: false,
      registry: false,
      pairLimits: false,
      orders: true,
    });
  }));
