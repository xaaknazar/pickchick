// Offline stand finding (stage 2, 24.10): staff could not tell "no internet" from "no local
// network". The edge reports its last confirmed cloud contact; the POS shows it.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool } from '@pickchick/database';
import { EdgeCloudLinkSchema } from '@pickchick/contracts';
import { readCloudLink, CLOUD_LINK_FRESH_SECONDS } from '@pickchick/local-orders';
import { fixture } from '../../packages/edge-fulfillment/tests/fixture.mjs';
import {
  applyEdgeRuntimeGrants,
  edgeRuntimeGrantSql,
  runtimeGrantCliOptions,
} from '../../infra/windows/edge-runtime-grants.mjs';
import { createEdge } from '../../services/edge/dist/index.js';

const headers = (c) => ({ Authorization: `Bearer ${c.token}`, 'X-Staff-Session-Id': c.session_id });

async function runtime(ctx, options, run) {
  const role = 'edge_runtime_' + randomUUID().replaceAll('-', '');
  const password = randomBytes(32).toString('hex');
  let pool;
  try {
    await ctx.admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    await applyEdgeRuntimeGrants(ctx.pool, role, {
      schema: ctx.schema,
      fulfillment: true,
      ...options,
    });
    const url = new URL(ctx.url);
    url.username = role;
    url.password = password;
    pool = createPool(url.toString(), 2);
    await run(pool);
  } finally {
    if (pool) await pool.end();
    await ctx.admin.query(`DROP OWNED BY ${role}`);
    await ctx.admin.query(`DROP ROLE ${role}`);
  }
}

test('cloud link: staff only, unknown before the first sync, online after a cloud answer, offline after the window', async () => {
  await fixture(async (ctx) => {
    const app = await createEdge({
      service: 'edge',
      environment: 'test',
      databaseUrl: ctx.url,
      branchId: ctx.scope.branchId,
      edgeDeviceId: ctx.scope.deviceId,
      edgeFulfillmentEnabled: true,
      port: 0,
    });
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    try {
      const get = (h = {}) =>
        fetch(url + '/edge/v1/cloud-link', { headers: h, signal: AbortSignal.timeout(5000) });
      assert.equal((await get()).status, 401);
      assert.equal(
        (await get({ ...headers(ctx.cashier), Authorization: 'Bearer ' + '0'.repeat(64) })).status,
        401,
      );
      const read = async (who = ctx.cashier) => {
        const response = await get(headers(who));
        assert.equal(response.status, 200);
        return EdgeCloudLinkSchema.parse(await response.json());
      };
      let link = await read();
      assert.equal(link.state, 'unknown');
      assert.equal(link.last_contact_at, null);
      await ctx.pool.query(
        'INSERT INTO fulfillment_transport_state(branch_id,last_success_at) VALUES($1,clock_timestamp())',
        [ctx.scope.branchId],
      );
      link = await read();
      assert.equal(link.state, 'online');
      assert.ok(Date.parse(link.last_contact_at) <= Date.parse(link.checked_at));
      // Any signed-in staff on the LAN API may read it (the kitchen screen too).
      assert.equal((await read(ctx.cook)).state, 'online');
      await ctx.pool.query(
        `UPDATE fulfillment_transport_state SET last_error='NETWORK_UNKNOWN',
        last_success_at=clock_timestamp()-make_interval(secs => $1)`,
        [CLOUD_LINK_FRESH_SECONDS + 1],
      );
      link = await read();
      assert.equal(link.state, 'offline');
      assert.ok(link.last_contact_at);
      // The worker runs but never reached the cloud: offline, never online.
      await ctx.pool.query('UPDATE fulfillment_transport_state SET last_success_at=NULL');
      link = await read();
      assert.deepEqual([link.state, link.last_contact_at], ['offline', null]);
    } finally {
      await app.close();
    }
  });
});

test('least-privileged edge runtime: unknown without the opt-in grant, the real state with it', async () => {
  await fixture(async (ctx) => {
    await ctx.pool.query(
      'INSERT INTO fulfillment_transport_state(branch_id,last_success_at) VALUES($1,clock_timestamp())',
      [ctx.scope.branchId],
    );
    await runtime(ctx, {}, async (pool) => {
      // The default (no grant) is answered without a refused statement: no permission error
      // in the cashier's PostgreSQL log on every POS poll.
      const refused = [];
      const watched = {
        connect: () => pool.connect(),
        query: (...args) =>
          pool.query(...args).catch((error) => {
            refused.push(error.code);
            throw error;
          }),
      };
      assert.equal(
        (await readCloudLink(watched, ctx.scope.branchId, ctx.cashier.auth)).state,
        'unknown',
      );
      assert.deepEqual(refused, []);
    });
    await runtime(ctx, { cloudLink: true }, async (pool) => {
      assert.equal(
        (await readCloudLink(pool, ctx.scope.branchId, ctx.cashier.auth)).state,
        'online',
      );
      // Two columns only: the grant does not expose the pending cloud command or the lease.
      await assert.rejects(pool.query('SELECT pending_cloud FROM fulfillment_transport_state'), {
        code: '42501',
      });
    });
    await assert.rejects(
      readCloudLink(ctx.pool, ctx.scope.branchId, { ...ctx.cashier.auth, token: '0'.repeat(64) }),
      {
        code: 'UNAUTHORIZED',
      },
    );
  });
});

test('runtime grant SQL: cloud link is opt-in and column limited', () => {
  const sql = edgeRuntimeGrantSql('edge_runtime', { cloudLink: true });
  assert.match(
    sql,
    /GRANT SELECT\(branch_id, last_success_at\) ON "public"\."fulfillment_transport_state" TO "edge_runtime";/,
  );
  assert.doesNotMatch(edgeRuntimeGrantSql('edge_runtime', {}), /fulfillment_transport_state/);
  assert.throws(() => edgeRuntimeGrantSql('edge_runtime', { cloudLink: 'yes' }));
});

test('runtime grant command line: --cloud-link is the only way to opt in, typos are refused', () => {
  const role = 'pickchick_edge_runtime';
  assert.deepEqual(runtimeGrantCliOptions([role]), {
    role,
    options: { fulfillment: false, cloudLink: false },
  });
  assert.deepEqual(runtimeGrantCliOptions([role, '--cloud-link', '--fulfillment']), {
    role,
    options: { fulfillment: true, cloudLink: true },
  });
  assert.deepEqual(runtimeGrantCliOptions([role, '--cloud-link']).options, {
    fulfillment: false,
    cloudLink: true,
  });
  for (const args of [
    [],
    ['--cloud-link'],
    [role, '--cloudLink'],
    [role, '--cloud-link', '--cloud-link'],
    [role, '--fulfillment', 'extra'],
  ])
    assert.throws(() => runtimeGrantCliOptions(args));
});
