import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createHttpApplication, RESOURCE, Resources } from '@pickchick/platform';
import { TestOrderController } from '../../services/api/dist/test-order-controller.js';
import test from 'node:test';
import { withSyncDatabases, running, request } from '../helpers/sync.mjs';
import {
  TestOrderFlow,
  TestFlowError,
  TEST_BRANCH_ID,
  provisionTestActor,
  revokeTestActor,
} from '../../packages/test-order-flow/dist/index.js';

const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
const { Module } = require('@nestjs/common');
const config = { enabled: true, environment: 'test' };
const code = (expected) => (error) => error instanceof TestFlowError && error.code === expected;
async function withCustomer(run) {
  await withSyncDatabases(async (ctx) => {
    await ctx.cloud.pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,'TEST-ALMATY-01','Synthetic continuation')",
      [TEST_BRANCH_ID, ctx.org, ctx.legal],
    );
    const flow = new TestOrderFlow(ctx.cloud.pool, config);
    const customer = await flow.issueSession({ channel: 'mobile' });
    const expire = (id = customer.session_id) =>
      ctx.cloud.pool.query(
        "UPDATE test_actors SET expires_at=created_at+interval '1 microsecond' WHERE id=$1",
        [id],
      );
    const make = async () => {
      const quote = await flow.quote(customer.token, randomUUID(), {
        catalog_version: 'mockup-v0.2',
        service_mode: 'takeaway',
        items: [{ product_id: 'pick-combo', quantity: 1 }],
      });
      return flow.createOrder(customer.token, randomUUID(), { quote_id: quote.quote_id });
    };
    await run({ ...ctx, flow, customer, expire, make });
  });
}
async function fulfill(ctx, created) {
  let order = await ctx.flow.simulatePayment(ctx.customer.token, randomUUID(), created.order_id, {
    expected_version: created.version,
    outcome: 'approved',
  });
  for (const station of ['prep', 'assembly']) {
    const actor = await provisionTestActor(ctx.cloud.pool, config, station);
    const task = order.tasks.find((candidate) => candidate.station === station);
    order = await ctx.flow.completeTask(actor.token, randomUUID(), order.order_id, task.task_id, {
      expected_version: order.version,
    });
    if (station === 'assembly')
      order = await ctx.flow.handoff(actor.token, randomUUID(), order.order_id, {
        expected_version: order.version,
      });
  }
  return order;
}

test('expired terminal customer continues the same identity and history without resetting quotas', async () => {
  await withCustomer(async (ctx) => {
    const fulfilled = await fulfill(ctx, await ctx.make());
    const open = await ctx.make();
    const cancelled = await ctx.flow.cancel(ctx.customer.token, randomUUID(), open.order_id, {
      expected_version: open.version,
      reason: 'Synthetic check completed',
    });
    const actorBefore = (
      await ctx.cloud.pool.query('SELECT * FROM test_actors WHERE id=$1', [ctx.customer.session_id])
    ).rows[0];
    const before = await ctx.flow.ownOrders(ctx.customer.token);
    await ctx.expire();
    await assert.rejects(ctx.flow.ownOrders(ctx.customer.token), code('UNAUTHORIZED'));
    const continued = await ctx.flow.continueSession(ctx.customer.token, {});
    assert.equal(continued.session_id, ctx.customer.session_id);
    assert.equal(continued.token, ctx.customer.token);
    assert.equal(continued.channel, 'mobile');
    assert.equal(continued.expires_at, '9999-12-31T23:59:59.999Z');
    assert.equal(
      (
        await ctx.cloud.pool.query(
          'SELECT expires_at::text AS expiry FROM test_actors WHERE id=$1',
          [ctx.customer.session_id],
        )
      ).rows[0].expiry,
      'infinity',
    );
    assert.deepEqual(await ctx.flow.ownOrders(ctx.customer.token), before);
    assert.deepEqual(
      new Set(before.orders.map((order) => order.state)),
      new Set(['fulfilled', 'cancelled']),
    );
    assert.equal(
      before.orders.find((order) => order.order_id === fulfilled.order_id).state,
      'fulfilled',
    );
    assert.equal(
      before.orders.find((order) => order.order_id === cancelled.order_id).state,
      'cancelled',
    );
    const actorAfter = (
      await ctx.cloud.pool.query('SELECT * FROM test_actors WHERE id=$1', [ctx.customer.session_id])
    ).rows[0];
    for (const field of [
      'id',
      'token_hash',
      'role',
      'channel',
      'branch_id',
      'created_at',
      'revoked_at',
    ])
      assert.deepEqual(actorAfter[field], actorBefore[field], field);
    assert.notEqual(actorAfter.token_hash, ctx.customer.token);
    const counts = (
      await ctx.cloud.pool.query(
        "SELECT (SELECT count(*) FROM test_quotes WHERE actor_id=$1) AS quotes, (SELECT count(*) FROM test_orders WHERE actor_id=$1) AS orders, (SELECT count(*) FROM test_actors WHERE role='customer') AS actors",
        [ctx.customer.session_id],
      )
    ).rows[0];
    assert.deepEqual(counts, { quotes: '2', orders: '2', actors: '1' });
    assert.equal(
      JSON.stringify(
        (await ctx.cloud.pool.query('SELECT * FROM test_command_results')).rows,
      ).includes(ctx.customer.token),
      false,
    );
  });
});

test('continuation is naturally idempotent for concurrent callers and lost-response retry', async () => {
  await withCustomer(async (ctx) => {
    const unchanged = await ctx.flow.continueSession(ctx.customer.token, {});
    assert.deepEqual(unchanged, ctx.customer);
    await ctx.expire();
    const [first, duplicate] = await Promise.all([
      ctx.flow.continueSession(ctx.customer.token, {}),
      ctx.flow.continueSession(ctx.customer.token, {}),
    ]);
    assert.deepEqual(first, duplicate);
    // The first response can be lost; a later request with the old token returns
    // exactly the same new expiry without creating a new actor or credential.
    assert.deepEqual(await ctx.flow.continueSession(ctx.customer.token, {}), first);
  });
});

test('legacy finite access with a nonterminal state or unknown result denies continuation until staff completes the order', async () => {
  for (const state of ['awaiting_test_payment', 'preparing', 'ready', 'unknown']) {
    await withCustomer(async (ctx) => {
      let order = await ctx.make();
      const actors = {};
      if (state !== 'awaiting_test_payment')
        order = await ctx.flow.simulatePayment(ctx.customer.token, randomUUID(), order.order_id, {
          expected_version: order.version,
          outcome: state === 'unknown' ? 'unknown' : 'approved',
        });
      if (state === 'ready')
        for (const station of ['prep', 'assembly']) {
          actors[station] = await provisionTestActor(ctx.cloud.pool, config, station);
          const task = order.tasks.find((candidate) => candidate.station === station);
          order = await ctx.flow.completeTask(
            actors[station].token,
            randomUUID(),
            order.order_id,
            task.task_id,
            { expected_version: order.version },
          );
        }
      await ctx.expire();
      await assert.rejects(
        ctx.flow.continueSession(ctx.customer.token, {}),
        code('CONFLICT'),
        state,
      );
      await assert.rejects(ctx.flow.ownOrders(ctx.customer.token), code('UNAUTHORIZED'));
      const manager = await provisionTestActor(ctx.cloud.pool, config, 'manager');
      if (state === 'unknown')
        order = await ctx.flow.resolvePayment(manager.token, randomUUID(), order.order_id, {
          expected_version: order.version,
          outcome: 'declined',
        });
      order = await ctx.flow.cancel(manager.token, randomUUID(), order.order_id, {
        expected_version: order.version,
        reason: 'Operator finished synthetic check',
      });
      assert.equal(order.state, 'cancelled');
      await ctx.flow.continueSession(ctx.customer.token, {});
      assert.equal((await ctx.flow.ownOrders(ctx.customer.token)).orders[0].state, 'cancelled');
    });
  }
});

test('staff, revoked, invalid token, nonempty body, production and wrong branch fail closed', async () => {
  await withCustomer(async (ctx) => {
    const staff = await provisionTestActor(ctx.cloud.pool, config, 'manager');
    await ctx.expire(staff.actor_id);
    await assert.rejects(ctx.flow.continueSession(staff.token, {}), code('FORBIDDEN'));
    for (const body of [undefined, null, [], { role: 'customer' }, { expires_at: 'tomorrow' }])
      await assert.rejects(
        ctx.flow.continueSession(ctx.customer.token, body),
        code('INVALID_REQUEST'),
      );
    for (const token of ['', 'x'.repeat(64), 'f'.repeat(64)])
      await assert.rejects(ctx.flow.continueSession(token, {}), code('UNAUTHORIZED'));
    await assert.rejects(
      new TestOrderFlow(ctx.cloud.pool, {
        enabled: true,
        environment: 'production',
      }).continueSession(ctx.customer.token, {}),
      code('DISABLED'),
    );
    await assert.rejects(
      new TestOrderFlow(ctx.cloud.pool, { enabled: false, environment: 'staging' }).continueSession(
        ctx.customer.token,
        {},
      ),
      code('DISABLED'),
    );
    await ctx.cloud.pool.query('UPDATE branches SET ordering_enabled=true WHERE id=$1', [
      TEST_BRANCH_ID,
    ]);
    await assert.rejects(
      ctx.flow.continueSession(ctx.customer.token, {}),
      code('BRANCH_UNAVAILABLE'),
    );
    await ctx.cloud.pool.query('UPDATE branches SET ordering_enabled=false WHERE id=$1', [
      TEST_BRANCH_ID,
    ]);
    await revokeTestActor(ctx.cloud.pool, config, ctx.customer.session_id);
    await assert.rejects(ctx.flow.continueSession(ctx.customer.token, {}), code('UNAUTHORIZED'));
  });
});

test('concurrent continuation upgrades existing finite identities without consuming issuance slots', async () => {
  await withCustomer(async (ctx) => {
    const other = await ctx.flow.issueSession({ channel: 'kiosk' });
    await ctx.expire();
    await ctx.expire(other.session_id);
    await ctx.cloud.pool.query(
      "INSERT INTO test_actors(id,branch_id,token_hash,role,channel,expires_at) SELECT gen_random_uuid(),$1,md5('quota-'||n::text)||md5('other-'||n::text),'customer','mobile',clock_timestamp()+interval '1 hour' FROM generate_series(1,99) n",
      [TEST_BRANCH_ID],
    );
    const actorsBefore = (
      await ctx.cloud.pool.query('SELECT id,token_hash,created_at FROM test_actors ORDER BY id')
    ).rows;
    const continued = await Promise.all([
      ctx.flow.continueSession(ctx.customer.token, {}),
      ctx.flow.continueSession(other.token, {}),
    ]);
    for (const [index, session] of continued.entries()) {
      const original = index === 0 ? ctx.customer : other;
      assert.equal(session.session_id, original.session_id);
      assert.equal(session.token, original.token);
      assert.equal(session.expires_at, '9999-12-31T23:59:59.999Z');
      assert.deepEqual(await ctx.flow.continueSession(session.token, {}), session);
    }
    assert.deepEqual(
      (await ctx.cloud.pool.query('SELECT id,token_hash,created_at FROM test_actors ORDER BY id'))
        .rows,
      actorsBefore,
    );

    const counts = (
      await ctx.cloud.pool.query(
        "SELECT count(*) FILTER (WHERE expires_at>clock_timestamp()) AS active,count(*) AS total FROM test_actors WHERE role='customer'",
      )
    ).rows[0];
    assert.deepEqual(counts, { active: '101', total: '101' });
  });
});

test('HTTP continuation accepts only customer bearer with an empty JSON body and returns test session', async () => {
  await withCustomer(async (ctx) => {
    const factory = async () => {
      class TestModule {}
      Module({
        controllers: [TestOrderController],
        providers: [
          {
            provide: RESOURCE,
            useFactory: () => new Resources({ ...ctx.cloud.config, testOrderFlowEnabled: true }),
          },
        ],
      })(TestModule);
      return createHttpApplication(TestModule);
    };
    const api = await running(factory, ctx.cloud.config);
    try {
      await ctx.expire();
      const url = `${api.url}/v1/test/sessions/continue`;
      const headers = {
        Authorization: `Bearer ${ctx.customer.token}`,
        'Content-Type': 'application/json',
      };
      assert.equal(
        (
          await request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
        ).status,
        401,
      );
      assert.equal(
        (await request(url, { method: 'POST', headers, body: '{"role":"manager"}' })).status,
        400,
      );
      assert.equal((await request(url, { method: 'GET', headers })).status, 404);
      const response = await request(url, { method: 'POST', headers, body: '{}' });
      assert.equal(response.status, 200);
      const continued = await response.json();
      assert.equal(continued.synthetic, true);
      assert.equal(continued.namespace, 'pickchick-test');
      assert.equal(continued.expires_at, '9999-12-31T23:59:59.999Z');
      assert.equal(continued.session_id, ctx.customer.session_id);
      assert.equal(continued.token, ctx.customer.token);
      assert.deepEqual(
        await (await request(url, { method: 'POST', headers, body: '{}' })).json(),
        continued,
      );
      const staff = await provisionTestActor(ctx.cloud.pool, config, 'manager');
      assert.equal(
        (
          await request(url, {
            method: 'POST',
            headers: { ...headers, Authorization: `Bearer ${staff.token}` },
            body: '{}',
          })
        ).status,
        403,
      );
    } finally {
      await api.app.close();
    }
  });
});
