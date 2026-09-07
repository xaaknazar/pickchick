import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPool, migrate } from '@pickchick/database';
import { createApi } from '@pickchick/api';
import {
  TestOrderFlow,
  TestFlowError,
  TestActorSchema,
  TestSessionSchema,
  TEST_BRANCH_ID,
  provisionTestActor,
  revokeTestActor,
  cleanupTestFlow,
} from '@pickchick/test-order-flow';
import { withSyncDatabases, running, request } from '../helpers/sync.mjs';

const marker = '9999-12-31T23:59:59.999Z';
const migration = '006_cloud_test_permanent_access.sql';
const migrationDir = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));
const config = { enabled: true, environment: 'test' };
const code = (expected) => (error) => error instanceof TestFlowError && error.code === expected;
const cart = {
  catalog_version: 'mockup-v0.2',
  service_mode: 'takeaway',
  items: [{ product_id: 'pick-combo', quantity: 1 }],
};
async function withDesk(run) {
  await withSyncDatabases(async (ctx) => {
    await ctx.cloud.pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,'TEST-ALMATY-01','Synthetic permanent access')",
      [TEST_BRANCH_ID, ctx.org, ctx.legal],
    );
    const flow = new TestOrderFlow(ctx.cloud.pool, config);
    const customer = await flow.issueSession({ channel: 'mobile' });
    const make = async (session = customer) => {
      const quote = await flow.quote(session.token, randomUUID(), cart);
      return flow.createOrder(session.token, randomUUID(), { quote_id: quote.quote_id });
    };
    await run({ ...ctx, flow, customer, make });
  });
}
async function persistedData(pool) {
  const result = {};
  for (const table of [
    'test_quotes',
    'test_orders',
    'test_kitchen_tasks',
    'test_command_results',
    'test_outbox',
  ])
    result[table] = (
      await pool.query(`SELECT to_jsonb(t) AS data FROM ${table} t ORDER BY to_jsonb(t)::text`)
    ).rows;
  return result;
}

// Owner-only historical fixtures exercise rolling windows without mutating the
// immutable quotes/orders that the runtime is forbidden to rewrite.
async function historicalFixtures(ctx, quoteCount, orderCount, hoursAgo = 25) {
  const time = (
    await ctx.cloud.pool.query("SELECT clock_timestamp()-($1 * interval '1 hour') AS created", [
      hoursAgo,
    ])
  ).rows[0].created;
  const quotes = [],
    orders = [];
  for (let index = 0; index < quoteCount; index++) {
    const quote = {
      synthetic: true,
      namespace: 'pickchick-test',
      quote_id: randomUUID(),
      branch_id: TEST_BRANCH_ID,
      catalog_version: 'mockup-v0.2',
      channel: 'mobile',
      service_mode: 'takeaway',
      currency: 'KZT',
      total_minor: '349000',
      lines: [{ ...ctx.flow.catalog().products[0], quantity: 1, line_total_minor: '349000' }],
      created_at: time.toISOString(),
      expires_at: new Date(time.getTime() + 300000).toISOString(),
    };
    await ctx.cloud.pool.query(
      'INSERT INTO test_quotes(id,actor_id,branch_id,snapshot,total_minor,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        quote.quote_id,
        ctx.customer.session_id,
        TEST_BRANCH_ID,
        quote,
        quote.total_minor,
        quote.created_at,
        quote.expires_at,
      ],
    );
    quotes.push(quote);
    if (index < orderCount) {
      const orderId = randomUUID();
      await ctx.cloud.pool.query(
        'INSERT INTO test_orders(id,actor_id,branch_id,quote_id,snapshot,total_minor,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)',
        [
          orderId,
          ctx.customer.session_id,
          TEST_BRANCH_ID,
          quote.quote_id,
          quote,
          quote.total_minor,
          quote.created_at,
        ],
      );
      orders.push(orderId);
    }
  }
  return { quotes, orders, time };
}
test('permanent customer and every staff role serialize strict ISO credentials and remain revocable after restart', async () => {
  await withDesk(async (ctx) => {
    const customer = TestSessionSchema.parse(JSON.parse(JSON.stringify(ctx.customer)));
    assert.equal(customer.expires_at, marker);
    assert.ok(Number.isFinite(Date.parse(customer.expires_at)));
    const actors = {};
    for (const role of ['prep', 'assembly', 'display', 'manager']) {
      actors[role] = TestActorSchema.parse(
        JSON.parse(JSON.stringify(await provisionTestActor(ctx.cloud.pool, config, role))),
      );
      assert.equal(actors[role].expires_at, marker);
    }
    assert.ok(
      (await ctx.cloud.pool.query('SELECT expires_at::text AS expiry FROM test_actors')).rows.every(
        (row) => row.expiry === 'infinity',
      ),
    );
    const order = await ctx.make();
    const freshPool = createPool(ctx.cloud.config.databaseUrl);
    try {
      const restarted = new TestOrderFlow(freshPool, config);
      assert.equal(
        (await restarted.readOrder(customer.token, order.order_id)).order_id,
        order.order_id,
      );
      for (const role of ['prep', 'assembly', 'manager'])
        await restarted.kitchen(actors[role].token);
      await restarted.display(actors.display.token);
      await assert.rejects(restarted.kitchen(actors.display.token), code('FORBIDDEN'));
      await revokeTestActor(freshPool, config, actors.prep.actor_id);
      await assert.rejects(restarted.kitchen(actors.prep.token), code('UNAUTHORIZED'));
      // The owner can still force a finite deadline. Infinity is not a bypass
      // around expiry checks for explicitly finite or revoked credentials.
      await freshPool.query(
        "UPDATE test_actors SET expires_at=created_at+interval '1 microsecond' WHERE id=$1",
        [actors.assembly.actor_id],
      );
      await assert.rejects(restarted.kitchen(actors.assembly.token), code('UNAUTHORIZED'));
      await revokeTestActor(freshPool, config, customer.session_id);
      await assert.rejects(
        restarted.readOrder(customer.token, order.order_id),
        code('UNAUTHORIZED'),
      );
      await assert.rejects(restarted.continueSession(customer.token, {}), code('UNAUTHORIZED'));
    } finally {
      await freshPool.end();
    }
  });
});

test('permanent metadata refresh preserves every open state and unresolved payment without issuing another identity', async () => {
  for (const state of ['awaiting_test_payment', 'preparing', 'ready', 'unknown']) {
    await withDesk(async (ctx) => {
      let order = await ctx.make();
      if (state !== 'awaiting_test_payment')
        order = await ctx.flow.simulatePayment(ctx.customer.token, randomUUID(), order.order_id, {
          expected_version: order.version,
          outcome: state === 'unknown' ? 'unknown' : 'approved',
        });
      if (state === 'ready') {
        for (const station of ['prep', 'assembly']) {
          const actor = await provisionTestActor(ctx.cloud.pool, config, station);
          const task = order.tasks.find((item) => item.station === station);
          order = await ctx.flow.completeTask(
            actor.token,
            randomUUID(),
            order.order_id,
            task.task_id,
            { expected_version: order.version },
          );
        }
      }
      const actorRows = (await ctx.cloud.pool.query('SELECT * FROM test_actors ORDER BY id')).rows;
      const before = await persistedData(ctx.cloud.pool);
      const sessions = await Promise.all([
        ctx.flow.continueSession(ctx.customer.token, {}),
        ctx.flow.continueSession(ctx.customer.token, {}),
      ]);
      assert.ok(
        sessions.every(
          (session) =>
            session.token === ctx.customer.token &&
            session.session_id === ctx.customer.session_id &&
            session.expires_at === marker,
        ),
      );
      assert.deepEqual(
        (await ctx.cloud.pool.query('SELECT * FROM test_actors ORDER BY id')).rows,
        actorRows,
        state,
      );
      assert.deepEqual(await persistedData(ctx.cloud.pool), before, state);
      assert.deepEqual(await ctx.flow.readOrder(ctx.customer.token, order.order_id), order);
      if (state === 'unknown') {
        await assert.rejects(
          ctx.flow.simulatePayment(ctx.customer.token, randomUUID(), order.order_id, {
            expected_version: order.version,
            outcome: 'approved',
          }),
          code('CONFLICT'),
        );
        await assert.rejects(
          ctx.flow.cancel(ctx.customer.token, randomUUID(), order.order_id, {
            expected_version: order.version,
            reason: 'Metadata refresh must not resolve unknown',
          }),
          code('CONFLICT'),
        );
      }
    });
  }
});

test('migration upgrades all unrevoked legacy credentials and preserves tokens, identities, orders and revoked access', async () => {
  await withDesk(async (ctx) => {
    const expiredCustomer = await ctx.flow.issueSession({ channel: 'kiosk' });
    const revokedCustomer = await ctx.flow.issueSession({ channel: 'mobile' });
    const manager = await provisionTestActor(ctx.cloud.pool, config, 'manager');
    const revokedStaff = await provisionTestActor(ctx.cloud.pool, config, 'prep');
    const open = await ctx.make();
    await ctx.flow.simulatePayment(ctx.customer.token, randomUUID(), open.order_id, {
      expected_version: open.version,
      outcome: 'unknown',
    });
    await ctx.make(expiredCustomer);
    await ctx.make(revokedCustomer);
    await revokeTestActor(ctx.cloud.pool, config, revokedCustomer.session_id);
    await revokeTestActor(ctx.cloud.pool, config, revokedStaff.actor_id);
    await ctx.cloud.pool.query(
      "UPDATE test_actors SET expires_at=clock_timestamp()+interval '1 hour'",
    );
    await ctx.cloud.pool.query(
      "UPDATE test_actors SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",
      [expiredCustomer.session_id],
    );
    const actorsBefore = (
      await ctx.cloud.pool.query('SELECT *,expires_at::text AS expiry FROM test_actors ORDER BY id')
    ).rows;
    const dataBefore = await persistedData(ctx.cloud.pool);
    // The isolated test database starts fully migrated. Recreate the pre-006
    // data, index and default state before exercising the real migration runner.
    await ctx.cloud.pool.query('DROP INDEX test_quotes_actor_created_idx');
    await ctx.cloud.pool.query('ALTER TABLE test_actors ALTER COLUMN expires_at DROP DEFAULT');
    await ctx.cloud.pool.query('DELETE FROM schema_migrations WHERE scope=$1 AND version=$2', [
      'cloud',
      migration,
    ]);
    assert.deepEqual(await migrate(ctx.cloud.pool, migrationDir, 'cloud'), [migration]);
    assert.deepEqual(await migrate(ctx.cloud.pool, migrationDir, 'cloud'), []);
    const actorsAfter = (
      await ctx.cloud.pool.query('SELECT *,expires_at::text AS expiry FROM test_actors ORDER BY id')
    ).rows;
    for (const before of actorsBefore) {
      const after = actorsAfter.find((row) => row.id === before.id);
      if (before.revoked_at) assert.deepEqual(after, before);
      else {
        assert.equal(after.expiry, 'infinity');
        for (const field of [
          'id',
          'token_hash',
          'role',
          'branch_id',
          'channel',
          'created_at',
          'revoked_at',
        ])
          assert.deepEqual(after[field], before[field], field);
      }
    }
    assert.deepEqual(await persistedData(ctx.cloud.pool), dataBefore);
    assert.equal((await ctx.flow.continueSession(ctx.customer.token, {})).expires_at, marker);
    assert.equal((await ctx.flow.ownOrders(expiredCustomer.token)).orders.length, 1);
    assert.equal((await ctx.flow.managerOrders(manager.token)).orders.length, 3);
    await assert.rejects(ctx.flow.ownOrders(revokedCustomer.token), code('UNAUTHORIZED'));
    await assert.rejects(ctx.flow.kitchen(revokedStaff.token), code('UNAUTHORIZED'));
    const storedHash = actorsAfter.find((row) => row.id === ctx.customer.session_id).token_hash;
    assert.equal(storedHash, createHash('sha256').update(ctx.customer.token).digest('hex'));
    assert.notEqual(storedHash, ctx.customer.token);
  });
});

test('permanent retention keeps active history and prunes only old revoked or finite-expired credentials', async () => {
  await withDesk(async (ctx) => {
    const activeOrder = await ctx.make();
    const oldRevoked = await ctx.flow.issueSession({ channel: 'mobile' });
    const recentRevoked = await ctx.flow.issueSession({ channel: 'kiosk' });
    const oldFinite = await ctx.flow.issueSession({ channel: 'mobile' });
    await ctx.make(oldRevoked);
    await ctx.cloud.pool.query(
      "UPDATE test_actors SET created_at=clock_timestamp()-interval '20 days'",
    );
    await revokeTestActor(ctx.cloud.pool, config, oldRevoked.session_id);
    await revokeTestActor(ctx.cloud.pool, config, recentRevoked.session_id);
    await ctx.cloud.pool.query(
      "UPDATE test_actors SET revoked_at=clock_timestamp()-interval '8 days' WHERE id=$1",
      [oldRevoked.session_id],
    );
    await ctx.cloud.pool.query(
      "UPDATE test_actors SET expires_at=clock_timestamp()-interval '8 days' WHERE id=$1",
      [oldFinite.session_id],
    );
    const result = await cleanupTestFlow(ctx.cloud.pool, config);
    assert.equal(result.removed_actors, 2);
    const survivors = (await ctx.cloud.pool.query('SELECT id FROM test_actors')).rows
      .map((row) => row.id)
      .sort();
    assert.deepEqual(survivors, [ctx.customer.session_id, recentRevoked.session_id].sort());
    assert.equal(
      (await ctx.flow.readOrder(ctx.customer.token, activeOrder.order_id)).order_id,
      activeOrder.order_id,
    );
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*) AS count FROM test_orders')).rows[0].count,
      '1',
    );
    assert.equal((await cleanupTestFlow(ctx.cloud.pool, config)).removed_actors, 0);
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*) AS count FROM branches')).rows[0].count,
      '2',
    );
  });
});

test('permanent issuance uses recent and UTC-day windows rather than all historical active actors', async () => {
  await withDesk(async (ctx) => {
    await ctx.cloud.pool.query(
      "INSERT INTO test_actors(id,branch_id,token_hash,role,channel,created_at,expires_at) SELECT gen_random_uuid(),$1,encode(sha256(('older-permanent-'||n)::bytea),'hex'),'customer','mobile',clock_timestamp()-interval '25 hours','infinity' FROM generate_series(1,101)n",
      [TEST_BRANCH_ID],
    );
    const next = await ctx.flow.issueSession({ channel: 'mobile' });
    assert.equal(next.expires_at, marker);
    await ctx.cloud.pool.query(
      "INSERT INTO test_actors(id,branch_id,token_hash,role,channel,expires_at) SELECT gen_random_uuid(),$1,encode(sha256(('recent-permanent-'||n)::bytea),'hex'),'customer','mobile','infinity' FROM generate_series(1,98)n",
      [TEST_BRANCH_ID],
    );
    await assert.rejects(ctx.flow.issueSession({ channel: 'mobile' }), code('RATE_LIMITED'));
    await ctx.cloud.pool.query(
      "UPDATE test_actors SET created_at=clock_timestamp()-interval '3 hours' WHERE id<>$1 AND id<>$2 AND created_at>clock_timestamp()-interval '2 hours'",
      [ctx.customer.session_id, next.session_id],
    );
    assert.equal((await ctx.flow.issueSession({ channel: 'kiosk' })).expires_at, marker);
    assert.equal(
      (await ctx.flow.continueSession(ctx.customer.token, {})).session_id,
      ctx.customer.session_id,
    );
  });
  await withDesk(async (ctx) => {
    // Revocation frees recent concurrent issuance capacity, not the UTC-day
    // abuse budget. These rows stay inside the freshly isolated test schema.
    await ctx.cloud.pool.query(
      "INSERT INTO test_actors(id,branch_id,token_hash,role,channel,expires_at,revoked_at) SELECT gen_random_uuid(),$1,encode(sha256(('revoked-today-'||n)::bytea),'hex'),'customer','mobile','infinity',clock_timestamp() FROM generate_series(1,200)n",
      [TEST_BRANCH_ID],
    );
    await assert.rejects(ctx.flow.issueSession({ channel: 'mobile' }), code('RATE_LIMITED'));
    assert.equal(
      (await ctx.flow.continueSession(ctx.customer.token, {})).session_id,
      ctx.customer.session_id,
    );
  });
});

test('rolling quote and order budgets retain previous-day history and replay under the same permanent actor', async () => {
  await withDesk(async (ctx) => {
    await ctx.cloud.pool.query(
      "UPDATE test_actors SET created_at=clock_timestamp()-interval '3 days' WHERE id=$1",
      [ctx.customer.session_id],
    );
    const history = await historicalFixtures(ctx, 40, 20);
    for (const orderId of history.orders)
      await ctx.flow.cancel(ctx.customer.token, randomUUID(), orderId, {
        expected_version: 1,
        reason: 'Previous-day synthetic history fixture',
      });
    const replay = history.quotes[0];
    const replayKey = randomUUID();
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ type: 'quote.create', input: cart }))
      .digest('hex');
    await ctx.cloud.pool.query(
      'INSERT INTO test_command_results(actor_id,idempotency_key,request_hash,result,created_at) VALUES($1,$2,$3,$4,$5)',
      [ctx.customer.session_id, replayKey, requestHash, replay, history.time],
    );
    const fresh = await ctx.flow.quote(ctx.customer.token, randomUUID(), cart);
    const order = await ctx.flow.createOrder(ctx.customer.token, randomUUID(), {
      quote_id: fresh.quote_id,
    });
    assert.equal(order.state, 'awaiting_test_payment');
    const visible = await ctx.flow.ownOrders(ctx.customer.token);
    assert.equal(visible.orders.length, 20);
    assert.equal(visible.orders[0].order_id, order.order_id);
    assert.deepEqual(await ctx.flow.quote(ctx.customer.token, replayKey, cart), replay);
    const counts = (
      await ctx.cloud.pool.query(
        "SELECT (SELECT count(*) FROM test_quotes WHERE actor_id=$1) AS quotes,(SELECT count(*) FROM test_orders WHERE actor_id=$1) AS orders,(SELECT count(*) FROM test_actors WHERE id=$1 AND expires_at='infinity') AS actors",
        [ctx.customer.session_id],
      )
    ).rows[0];
    assert.deepEqual(counts, { quotes: '41', orders: '21', actors: '1' });
  });
});

test('bounded customer history keeps an older unresolved order ahead of more than twenty newer terminal orders', async () => {
  await withDesk(async (ctx) => {
    const older = await historicalFixtures(ctx, 1, 1, 48);
    const newer = await historicalFixtures(ctx, 25, 25, 25);
    for (const orderId of newer.orders)
      await ctx.flow.cancel(ctx.customer.token, randomUUID(), orderId, {
        expected_version: 1,
        reason: 'Synthetic terminal history fixture',
      });
    const unknown = await ctx.flow.simulatePayment(
      ctx.customer.token,
      randomUUID(),
      older.orders[0],
      { expected_version: 1, outcome: 'unknown' },
    );
    const visible = await ctx.flow.ownOrders(ctx.customer.token);
    assert.equal(visible.orders.length, 20);
    assert.deepEqual(visible.orders[0], unknown);
    assert.ok(visible.orders.slice(1).every((order) => order.state === 'cancelled'));
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*) AS count FROM test_orders')).rows[0].count,
      '26',
    );
    const omitted = newer.orders.find(
      (id) => !visible.orders.some((order) => order.order_id === id),
    );
    assert.ok(omitted);
    assert.equal((await ctx.flow.readOrder(ctx.customer.token, omitted)).state, 'cancelled');
    const manager = await provisionTestActor(ctx.cloud.pool, config, 'manager');
    assert.equal(
      (await ctx.flow.managerOrders(manager.token)).orders[0].order_id,
      unknown.order_id,
    );
    assert.deepEqual(await ctx.flow.continueSession(ctx.customer.token, {}), ctx.customer);
    await assert.rejects(
      ctx.flow.simulatePayment(ctx.customer.token, randomUUID(), unknown.order_id, {
        expected_version: unknown.version,
        outcome: 'approved',
      }),
      code('CONFLICT'),
    );
  });
});

test('twenty active orders from previous days still block admission until one is explicitly finished', async () => {
  await withDesk(async (ctx) => {
    const history = await historicalFixtures(ctx, 20, 20, 25);
    const quote = await ctx.flow.quote(ctx.customer.token, randomUUID(), cart);
    const key = randomUUID();
    await assert.rejects(
      ctx.flow.createOrder(ctx.customer.token, key, { quote_id: quote.quote_id }),
      code('RATE_LIMITED'),
    );
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*) AS count FROM test_orders')).rows[0].count,
      '20',
    );
    assert.equal((await ctx.flow.ownOrders(ctx.customer.token)).orders.length, 20);
    await ctx.flow.cancel(ctx.customer.token, randomUUID(), history.orders[0], {
      expected_version: 1,
      reason: 'Owner finishes one synthetic order',
    });
    const accepted = await ctx.flow.createOrder(ctx.customer.token, key, {
      quote_id: quote.quote_id,
    });
    const visible = await ctx.flow.ownOrders(ctx.customer.token);
    assert.equal(visible.orders.length, 20);
    assert.ok(visible.orders.every((order) => order.state === 'awaiting_test_payment'));
    assert.ok(visible.orders.some((order) => order.order_id === accepted.order_id));
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*) AS count FROM test_orders')).rows[0].count,
      '21',
    );
  });
});

test('public TEST session creation and metadata refresh keep the strict existing JSON shape', async () => {
  await withDesk(async (ctx) => {
    const api = await running(createApi, { ...ctx.cloud.config, testOrderFlowEnabled: true });
    try {
      const response = await request(`${api.url}/v1/test/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"channel":"mobile"}',
      });
      assert.equal(response.status, 201);
      const session = TestSessionSchema.parse(await response.json());
      assert.equal(session.expires_at, marker);
      assert.deepEqual(
        Object.keys(session).sort(),
        ['synthetic', 'namespace', 'session_id', 'token', 'expires_at', 'channel'].sort(),
      );
      const refresh = await request(
        `${api.url}/v1/test/sessions/continue?catalog_version=mockup-v0.3`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
          body: '{}',
        },
      );
      assert.equal(refresh.status, 200);
      assert.deepEqual(TestSessionSchema.parse(await refresh.json()), session);
      assert.equal(
        (
          await ctx.cloud.pool.query(
            'SELECT expires_at::text AS expiry FROM test_actors WHERE id=$1',
            [session.session_id],
          )
        ).rows[0].expiry,
        'infinity',
      );
    } finally {
      await api.app.close();
    }
  });
});
