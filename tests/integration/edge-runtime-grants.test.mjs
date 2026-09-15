import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool } from '@pickchick/database';
import {
  createQuote,
  createLocalOrder,
  cancelLocalOrder,
  readSession,
  setOrdering,
  setStop,
} from '@pickchick/local-orders';
import { EdgeFulfillment } from '@pickchick/edge-fulfillment';
import { applyMenu, hashJson } from '@pickchick/menu-sync';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { fixture } from '../../packages/edge-fulfillment/tests/fixture.mjs';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';
import { createEdge } from '../../services/edge/dist/index.js';

const denied = (error) => error.code === '42501';

async function runtime(ctx, run) {
  const role = 'edge_runtime_' + randomUUID().replaceAll('-', '');
  const password = randomBytes(32).toString('hex');
  let pool;
  try {
    await ctx.admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    const options = { schema: ctx.schema, fulfillment: true };
    await applyEdgeRuntimeGrants(ctx.pool, role, options);
    const url = new URL(ctx.url);
    url.username = role;
    url.password = password;
    url.searchParams.set('options', `-c search_path=${ctx.schema}`);
    pool = createPool(url.toString(), 2);
    assert.equal((await pool.query('SELECT current_user')).rows[0].current_user, role);
    assert.equal((await pool.query('SELECT session_user')).rows[0].session_user, role);
    await run(pool, role, options, url.toString());
  } finally {
    if (pool) await pool.end();
    await ctx.admin.query(`DROP OWNED BY ${role}`);
    await ctx.admin.query(`DROP ROLE ${role}`);
  }
}

test('real edge runtime executes POS, row locks and kitchen lifecycle without setup authority', async () => {
  await fixture(async (ctx) => {
    const menu = { ...fixtureMenu, release_id: randomUUID(), branch_id: ctx.scope.branchId };
    await applyMenu(ctx.pool, ctx.scope.branchId, {
      event_id: randomUUID(),
      producer_id: randomUUID(),
      producer_sequence: '1',
      branch_id: ctx.scope.branchId,
      aggregate_type: 'menu_release',
      aggregate_id: menu.release_id,
      aggregate_version: 1,
      schema_version: 1,
      event_type: 'menu.published',
      payload: { menu, checksum: hashJson(menu) },
      occurred_at: new Date().toISOString(),
      correlation_id: randomUUID(),
      causation_id: null,
    });
    const accepted = await ctx.accepted(); // Trusted synthetic setup in this temporary schema only.
    await runtime(ctx, async (pool) => {
      const branch = ctx.scope.branchId;
      assert.equal((await readSession(pool, branch, ctx.cashier.auth)).role, 'cashier');
      const quote = await createQuote(pool, branch, ctx.cashier.auth, {
        release_id: menu.release_id,
        service_mode: 'takeaway',
        items: [{ variant_id: menu.items[0].variant_id, quantity: 2 }],
      });
      const key = randomUUID();
      const order = await createLocalOrder(pool, branch, ctx.cashier.auth, key, {
        quote_id: quote.quote_id,
      });
      assert.equal(order.fulfillment_state, 'blocked');
      assert.equal(
        (await createLocalOrder(pool, branch, ctx.cashier.auth, key, { quote_id: quote.quote_id }))
          .order_id,
        order.order_id,
      );
      assert.equal(
        (
          await cancelLocalOrder(pool, branch, ctx.cashier.auth, randomUUID(), order.order_id, {
            expected_version: 1,
            reason: 'Synthetic grant acceptance',
          })
        ).state,
        'cancelled',
      );
      await setStop(pool, branch, ctx.manager.auth, randomUUID(), {
        variant_id: menu.items[0].variant_id,
        expected_version: 0,
        stopped: true,
        reason: 'Synthetic stop',
      });
      await setStop(pool, branch, ctx.manager.auth, randomUUID(), {
        variant_id: menu.items[0].variant_id,
        expected_version: 1,
        stopped: false,
        reason: 'Synthetic return',
      });
      await setOrdering(pool, branch, ctx.manager.auth, randomUUID(), false, {
        expected_version: 1,
      });
      const repo = new EdgeFulfillment(pool);
      const page = await repo.listKitchen(branch, ctx.cook.auth, { stationId: ctx.prep });
      assert.equal(page.items.length, 1);
      let current = await repo.readOrder(branch, ctx.cook.auth, accepted.order.orderId, {
        stationId: ctx.prep,
      });
      for (const task of current.tasks) {
        for (const [action, expectedTaskVersion] of [
          ['start_task', task.version],
          ['complete_task', task.version + 1],
        ]) {
          current = await repo.act(branch, ctx.cook.auth, {
            commandId: randomUUID(),
            orderId: current.orderId,
            expectedVersion: current.version,
            action,
            taskId: task.id,
            expectedTaskVersion,
          });
        }
      }
      for (const action of ['ready', 'handoff'])
        current = await repo.act(branch, ctx.packer.auth, {
          commandId: randomUUID(),
          orderId: current.orderId,
          expectedVersion: current.version,
          action,
        });
      assert.equal(current.state, 'handed_over');
      for (const sql of [
        `UPDATE local_staff SET role='shift_manager' WHERE id='${ctx.cook.staff_id}'`,
        'UPDATE staff_sessions SET expires_at=now()',
        'UPDATE local_terminals SET active=false',
        'DELETE FROM fulfillment_station_grants',
        'UPDATE fulfillment_station_grants SET station_id=station_id',
        'INSERT INTO local_staff(id) VALUES(gen_random_uuid())',
        'DELETE FROM local_orders',
        'UPDATE menu_snapshots SET payload=payload',
        'UPDATE fulfillment_routing SET payload=payload',
        'UPDATE fulfillment_config SET device_id=device_id',
        'UPDATE fulfillment_stations SET kind=kind',
        'SELECT 1 FROM fulfillment_release_results',
        'INSERT INTO fulfillment_release_results(producer_id) VALUES(gen_random_uuid())',
        'UPDATE fulfillment_reservations SET snapshot=snapshot',
        'UPDATE fulfillment_outbox SET acknowledged_at=now()',
        'CREATE TABLE should_not_exist(id int)',
      ])
        await assert.rejects(pool.query(sql), denied, sql);
      await assert.rejects(
        pool.query('UPDATE local_staff SET lock_anchor=true'),
        (error) => error.code === '23514',
      );
      await setOrdering(pool, branch, ctx.manager.auth, randomUUID(), true, {
        expected_version: 2,
      });
      await assert.rejects(repo.acceptCloud(ctx.scope, ctx.admission()), denied);
    });
  });
});

test('kitchen HTTP uses restricted runtime credentials for config locks, stations and commands', async () => {
  await fixture(async (ctx) => {
    const accepted = await ctx.accepted();
    await runtime(ctx, async (_pool, _role, _options, databaseUrl) => {
      const app = await createEdge({
        service: 'edge',
        environment: 'test',
        databaseUrl,
        branchId: ctx.scope.branchId,
        edgeDeviceId: ctx.scope.deviceId,
        edgeFulfillmentEnabled: true,
        port: 0,
      });
      try {
        await app.listen(0, '127.0.0.1');
        const base = await app.getUrl();
        const call = async (path, actor, body) => {
          const response = await fetch(base + '/edge/v1/fulfillment' + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              Authorization: 'Bearer ' + actor.token,
              'X-Staff-Session-Id': actor.session_id,
              'X-Terminal-Id': actor.terminal_id,
              'Idempotency-Key': randomUUID(),
              'Content-Type': 'application/json',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(5000),
          });
          return { status: response.status, body: await response.json() };
        };
        for (const [path, actor] of [
          ['/stations', ctx.cook],
          ['/kitchen?stationId=' + ctx.prep, ctx.cook],
          ['/display', ctx.cook],
          ['/orders/' + accepted.order.orderId + '?stationId=' + ctx.prep, ctx.cook],
        ])
          assert.equal((await call(path, actor)).status, 200, path);
        assert.equal((await call('/kitchen?stationId=' + ctx.assembly, ctx.cook)).status, 403);
        assert.equal((await call('/display', ctx.cashier)).status, 403);
        const current = await ctx.read(accepted.order.orderId);
        const task = current.tasks[0];
        const action = await call('/orders/' + current.orderId + '/actions', ctx.cook, {
          action: 'start_task',
          expectedVersion: current.version,
          taskId: task.id,
          expectedTaskVersion: task.version,
        });
        assert.equal(action.status, 200);
        assert.equal(action.body.state, 'in_production');
      } finally {
        await app.close();
      }
    });
  });
});

test('reapplying runtime grants removes old column permissions and disabled kitchen access', async () => {
  await fixture(async (ctx) =>
    runtime(ctx, async (pool, role, options) => {
      await ctx.pool.query(`GRANT UPDATE(role) ON local_staff TO ${role}`);
      await applyEdgeRuntimeGrants(ctx.pool, role, options);
      await assert.rejects(pool.query("UPDATE local_staff SET role='cashier'"), denied);
      await applyEdgeRuntimeGrants(ctx.pool, role, { ...options, fulfillment: false });
      await assert.rejects(pool.query('SELECT 1 FROM fulfillment_reservations'), denied);
      assert.equal((await readSession(pool, ctx.scope.branchId, ctx.cashier.auth)).role, 'cashier');
      const owner = (await ctx.pool.query('SELECT current_user')).rows[0].current_user;
      await assert.rejects(applyEdgeRuntimeGrants(ctx.pool, owner, options));
      await ctx.pool.query('GRANT UPDATE(role) ON local_staff TO PUBLIC');
      await assert.rejects(applyEdgeRuntimeGrants(ctx.pool, role, options));
      await ctx.pool.query('REVOKE UPDATE(role) ON local_staff FROM PUBLIC');
      await applyEdgeRuntimeGrants(ctx.pool, role, options);
    }),
  );
});
