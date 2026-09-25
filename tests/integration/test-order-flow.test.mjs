import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createPool } from '@pickchick/database';
import { createHttpApplication, RESOURCE, Resources } from '@pickchick/platform';
import { withSyncDatabases, running, request } from '../helpers/sync.mjs';
import { TestOrderController } from '../../services/api/dist/test-order-controller.js';
import {
  TestOrderFlow,
  TestFlowError,
  TEST_BRANCH_ID,
  TEST_CATALOG_VERSION,
  provisionTestActor,
  revokeTestActor,
  cleanupTestFlow,
  TestOrderSchema,
} from '../../packages/test-order-flow/dist/index.js';

const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
const { Module } = require('@nestjs/common');
const config = { enabled: true, environment: 'test' };
const code = (expected) => (error) => error instanceof TestFlowError && error.code === expected;
const cart = {
  catalog_version: TEST_CATALOG_VERSION,
  service_mode: 'takeaway',
  items: [
    { product_id: 'pick-combo', quantity: 2 },
    { product_id: 'cola', quantity: 1 },
  ],
};
async function withDesk(run) {
  await withSyncDatabases(async (ctx) => {
    await ctx.cloud.pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,'TEST-ALMATY-01','Synthetic test namespace')",
      [TEST_BRANCH_ID, ctx.org, ctx.legal],
    );
    const flow = new TestOrderFlow(ctx.cloud.pool, config);
    const customer = await flow.issueSession({ channel: 'mobile' });
    const actors = {};
    for (const role of ['prep', 'assembly', 'display', 'manager'])
      actors[role] = await provisionTestActor(ctx.cloud.pool, config, role);
    const make = async (session = customer, body = cart) => {
      const quote = await flow.quote(session.token, randomUUID(), body);
      const order = await flow.createOrder(session.token, randomUUID(), {
        quote_id: quote.quote_id,
      });
      return { quote, order };
    };
    await run({ ...ctx, flow, customer, actors, make });
  });
}
const approve = (ctx, order, key = randomUUID()) =>
  ctx.flow.simulatePayment(ctx.customer.token, key, order.order_id, {
    expected_version: order.version,
    outcome: 'approved',
  });
const complete = (ctx, order, station, key = randomUUID()) => {
  const task = order.tasks.find((task) => task.station === station && task.state === 'pending');
  assert.ok(task);
  return ctx.flow.completeTask(ctx.actors[station].token, key, order.order_id, task.task_id, {
    expected_version: order.version,
  });
};

test('test flow persists priced snapshot, two kitchen stations, display and staff handoff in PostgreSQL', async () => {
  await withDesk(async (ctx) => {
    const { quote, order: created } = await ctx.make();
    assert.equal(quote.total_minor, '767000');
    assert.equal(created.state, 'awaiting_test_payment');
    assert.equal(created.payment_state, 'not_started');
    assert.equal(created.fiscal_state, 'not_applicable');
    assert.deepEqual(created.tasks, []);
    assert.deepEqual((await ctx.flow.kitchen(ctx.actors.prep.token)).orders, []);
    let order = await approve(ctx, created);
    assert.equal(order.payment_state, 'simulated_approved');
    assert.equal(order.tasks.length, 2);
    assert.equal((await ctx.flow.kitchen(ctx.actors.prep.token)).orders.length, 1);
    assert.equal(
      (await ctx.flow.display(ctx.actors.display.token)).preparing[0].number,
      order.number,
    );
    await assert.rejects(complete(ctx, order, 'assembly'), code('CONFLICT'));
    order = await complete(ctx, order, 'prep');
    assert.equal(order.state, 'preparing');
    order = await complete(ctx, order, 'assembly');
    assert.equal(order.state, 'ready');
    const display = await ctx.flow.display(ctx.actors.display.token);
    assert.deepEqual(display.ready, [{ number: order.number, channel: 'mobile' }]);
    assert.equal(JSON.stringify(display).includes(order.order_id), false);
    const freshPool = createPool(ctx.cloud.config.databaseUrl);
    try {
      assert.deepEqual(
        await new TestOrderFlow(freshPool, config).readOrder(ctx.customer.token, order.order_id),
        order,
      );
    } finally {
      await freshPool.end();
    }
    order = await ctx.flow.handoff(ctx.actors.assembly.token, randomUUID(), order.order_id, {
      expected_version: order.version,
    });
    assert.equal(order.state, 'fulfilled');
    assert.deepEqual((await ctx.flow.display(ctx.actors.display.token)).ready, []);
    assert.equal((await ctx.flow.ownOrders(ctx.customer.token)).orders[0].state, 'fulfilled');
    assert.deepEqual(order.snapshot, quote);
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*) FROM test_outbox')).rows[0].count,
      '5',
    );
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*) FROM outbox_events')).rows[0].count,
      '0',
    );
  });
});
test('immutable server pricing rejects tampering, duplicate lines, missing products and expired quote', async () => {
  await withDesk(async (ctx) => {
    for (const body of [
      { ...cart, total_minor: '1' },
      { ...cart, items: [...cart.items, cart.items[0]] },
      { ...cart, items: [{ product_id: 'missing', quantity: 1 }] },
      { ...cart, items: [{ product_id: 'cola', quantity: 0 }] },
      { ...cart, catalog_version: 'future' },
    ])
      await assert.rejects(
        async () => ctx.flow.quote(ctx.customer.token, randomUUID(), body),
        code('INVALID_REQUEST'),
      );
    const { quote, order } = await ctx.make();
    await assert.rejects(
      ctx.cloud.pool.query('UPDATE test_quotes SET total_minor=1 WHERE id=$1', [quote.quote_id]),
    );
    await assert.rejects(
      ctx.cloud.pool.query('UPDATE test_orders SET total_minor=1,version=2 WHERE id=$1', [
        order.order_id,
      ]),
    );
    const qid = randomUUID();
    const expired = {
      ...quote,
      quote_id: qid,
      created_at: '2026-01-01T00:00:00Z',
      expires_at: '2026-01-01T00:05:00Z',
    };
    await ctx.cloud.pool.query(
      'INSERT INTO test_quotes(id,actor_id,branch_id,snapshot,total_minor,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        qid,
        ctx.customer.session_id,
        TEST_BRANCH_ID,
        expired,
        expired.total_minor,
        expired.created_at,
        expired.expires_at,
      ],
    );
    await assert.rejects(
      ctx.flow.createOrder(ctx.customer.token, randomUUID(), { quote_id: qid }),
      code('QUOTE_EXPIRED'),
    );
  });
});
test('customer ownership, station scopes, token hashing, expiry and revocation fail closed', async () => {
  await withDesk(async (ctx) => {
    const other = await ctx.flow.issueSession({ channel: 'kiosk' });
    const { quote, order: created } = await ctx.make();
    await assert.rejects(ctx.flow.readOrder(other.token, created.order_id), code('NOT_FOUND'));
    await assert.rejects(
      ctx.flow.createOrder(other.token, randomUUID(), { quote_id: quote.quote_id }),
      code('NOT_FOUND'),
    );
    for (const action of [
      () => ctx.flow.kitchen(ctx.customer.token),
      () => ctx.flow.display(ctx.customer.token),
      () => ctx.flow.managerOrders(ctx.actors.prep.token),
      () => ctx.flow.quote(ctx.actors.prep.token, randomUUID(), cart),
    ])
      await assert.rejects(action(), code('FORBIDDEN'));
    const order = await approve(ctx, created);
    const prep = order.tasks.find((task) => task.station === 'prep');
    await assert.rejects(
      ctx.flow.completeTask(ctx.actors.assembly.token, randomUUID(), order.order_id, prep.task_id, {
        expected_version: order.version,
      }),
      code('FORBIDDEN'),
    );
    const stored = (
      await ctx.cloud.pool.query('SELECT token_hash FROM test_actors WHERE id=$1', [
        ctx.customer.session_id,
      ])
    ).rows[0].token_hash;
    assert.equal(stored, createHash('sha256').update(ctx.customer.token).digest('hex'));
    assert.notEqual(stored, ctx.customer.token);
    await ctx.cloud.pool.query(
      "UPDATE test_actors SET created_at=clock_timestamp()-interval '3 hours',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [ctx.customer.session_id],
    );
    await assert.rejects(
      ctx.flow.readOrder(ctx.customer.token, created.order_id),
      code('UNAUTHORIZED'),
    );
    await revokeTestActor(ctx.cloud.pool, config, ctx.actors.prep.actor_id);
    await assert.rejects(ctx.flow.kitchen(ctx.actors.prep.token), code('UNAUTHORIZED'));
    await assert.rejects(ctx.flow.kitchen(''), code('UNAUTHORIZED'));
  });
});
test('JSON null cannot bypass immutable test snapshot identity, money or synthetic namespace constraints', async () => {
  await withDesk(async (ctx) => {
    const { quote } = await ctx.make();
    for (const field of ['quote_id', 'branch_id', 'total_minor', 'synthetic', 'namespace']) {
      const quoteId = randomUUID();
      const snapshot = { ...quote, quote_id: quoteId, [field]: null };
      await assert.rejects(
        ctx.cloud.pool.query(
          'INSERT INTO test_quotes(id,actor_id,branch_id,snapshot,total_minor,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            quoteId,
            ctx.customer.session_id,
            TEST_BRANCH_ID,
            snapshot,
            quote.total_minor,
            quote.created_at,
            quote.expires_at,
          ],
        ),
        (error) => error.code === '23514',
      );
    }
  });
});
test('concurrent retries return identical outcomes; stale commands and changed idempotency payload conflict', async () => {
  await withDesk(async (ctx) => {
    const key = randomUUID();
    const [qa, qb] = await Promise.all([
      ctx.flow.quote(ctx.customer.token, key, cart),
      ctx.flow.quote(ctx.customer.token, key, cart),
    ]);
    assert.deepEqual(qa, qb);
    await assert.rejects(
      ctx.flow.quote(ctx.customer.token, key, { ...cart, service_mode: 'dine_in' }),
      code('CONFLICT'),
    );
    const orderKey = randomUUID();
    const create = () =>
      ctx.flow.createOrder(ctx.customer.token, orderKey, { quote_id: qa.quote_id });
    const [a, b] = await Promise.all([create(), create()]);
    assert.deepEqual(a, b);
    const paymentKey = randomUUID();
    const [paidA, paidB] = await Promise.all([
      approve(ctx, a, paymentKey),
      approve(ctx, a, paymentKey),
    ]);
    assert.deepEqual(paidA, paidB);
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*) FROM test_kitchen_tasks')).rows[0].count,
      '2',
    );
    const taskKey = randomUUID();
    const [doneA, doneB] = await Promise.all([
      complete(ctx, paidA, 'prep', taskKey),
      complete(ctx, paidA, 'prep', taskKey),
    ]);
    assert.deepEqual(doneA, doneB);
    const oldTask = paidA.tasks.find((task) => task.station === 'assembly');
    await assert.rejects(
      ctx.flow.completeTask(
        ctx.actors.assembly.token,
        randomUUID(),
        paidA.order_id,
        oldTask.task_id,
        { expected_version: paidA.version },
      ),
      code('CONFLICT'),
    );
    assert.deepEqual(await approve(ctx, a, paymentKey), paidA);
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*) FROM test_orders')).rows[0].count,
      '1',
    );
  });
});
test('unknown simulated payment blocks another attempt, cancellation and another order until trusted resolution', async () => {
  await withDesk(async (ctx) => {
    const { order } = await ctx.make();
    const pending = await ctx.flow.simulatePayment(
      ctx.customer.token,
      randomUUID(),
      order.order_id,
      { expected_version: order.version, outcome: 'unknown' },
    );
    await assert.rejects(approve(ctx, pending), code('CONFLICT'));
    await assert.rejects(
      ctx.flow.cancel(ctx.customer.token, randomUUID(), order.order_id, {
        expected_version: pending.version,
        reason: 'Test cancellation',
      }),
      code('CONFLICT'),
    );
    await assert.rejects(
      ctx.flow.resolvePayment(ctx.customer.token, randomUUID(), order.order_id, {
        expected_version: pending.version,
        outcome: 'approved',
      }),
      code('FORBIDDEN'),
    );
    const another = await ctx.flow.quote(ctx.customer.token, randomUUID(), cart);
    await assert.rejects(
      ctx.flow.createOrder(ctx.customer.token, randomUUID(), { quote_id: another.quote_id }),
      code('CONFLICT'),
    );
    const resolved = await ctx.flow.resolvePayment(
      ctx.actors.manager.token,
      randomUUID(),
      order.order_id,
      { expected_version: pending.version, outcome: 'approved' },
    );
    assert.equal(resolved.payment_attempt_id, pending.payment_attempt_id);
    assert.equal(resolved.tasks.length, 2);
    assert.equal(resolved.payment_state, 'simulated_approved');
  });
});
test('different commands racing on one order version accept exactly one transition', async () => {
  await withDesk(async (ctx) => {
    const { order } = await ctx.make();
    const results = await Promise.allSettled([
      approve(ctx, order),
      ctx.flow.cancel(ctx.customer.token, randomUUID(), order.order_id, {
        expected_version: 1,
        reason: 'Concurrent test cancellation',
      }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected.reason.code, 'CONFLICT');
    const current = await ctx.flow.readOrder(ctx.customer.token, order.order_id);
    assert.equal(current.version, 2);
    assert.equal(current.tasks.length, current.state === 'cancelled' ? 0 : 2);
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*) FROM test_outbox')).rows[0].count,
      '2',
    );
  });
});
test('quote quota is durable while idempotent quote replay does not consume another slot', async () => {
  await withDesk(async (ctx) => {
    const key = randomUUID();
    const original = await ctx.flow.quote(ctx.customer.token, key, cart);
    for (let i = 1; i < 40; i++) await ctx.flow.quote(ctx.customer.token, randomUUID(), cart);
    assert.deepEqual(await ctx.flow.quote(ctx.customer.token, key, cart), original);
    await assert.rejects(
      ctx.flow.quote(ctx.customer.token, randomUUID(), cart),
      code('RATE_LIMITED'),
    );
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*) FROM test_quotes')).rows[0].count,
      '40',
    );
  });
});
test('outbox failure rolls back simulated approval, kitchen admission and command so exact retry is safe', async () => {
  await withDesk(async (ctx) => {
    const { order } = await ctx.make();
    const key = randomUUID();
    await ctx.cloud.pool.query(
      "CREATE FUNCTION fail_test_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='test.payment.simulated' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER test_failure BEFORE INSERT ON test_outbox FOR EACH ROW EXECUTE FUNCTION fail_test_outbox()",
    );
    await assert.rejects(approve(ctx, order, key));
    assert.equal(
      (await ctx.flow.readOrder(ctx.customer.token, order.order_id)).payment_state,
      'not_started',
    );
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*) FROM test_kitchen_tasks')).rows[0].count,
      '0',
    );
    assert.equal(
      (
        await ctx.cloud.pool.query(
          'SELECT count(*) FROM test_command_results WHERE idempotency_key=$1',
          [key],
        )
      ).rows[0].count,
      '0',
    );
    await ctx.cloud.pool.query('DROP TRIGGER test_failure ON test_outbox');
    assert.equal((await approve(ctx, order, key)).tasks.length, 2);
  });
});
test('cancellation removes queued/ready test order without fabricating refund, and terminal states cannot resurrect', async () => {
  await withDesk(async (ctx) => {
    let { order } = await ctx.make();
    order = await approve(ctx, order);
    order = await complete(ctx, order, 'prep');
    order = await complete(ctx, order, 'assembly');
    const key = randomUUID();
    const body = { expected_version: order.version, reason: 'Synthetic test cancelled' };
    const cancel = () => ctx.flow.cancel(ctx.customer.token, key, order.order_id, body);
    const [a, b] = await Promise.all([cancel(), cancel()]);
    assert.deepEqual(a, b);
    assert.equal(a.state, 'cancelled');
    assert.equal(a.payment_state, 'simulated_approved');
    assert.equal(a.fiscal_state, 'not_applicable');
    assert.deepEqual((await ctx.flow.display(ctx.actors.display.token)).ready, []);
    await assert.rejects(
      ctx.flow.handoff(ctx.actors.assembly.token, randomUUID(), a.order_id, {
        expected_version: a.version,
      }),
      code('CONFLICT'),
    );
    await assert.rejects(
      ctx.cloud.pool.query(
        "UPDATE test_orders SET state='preparing',version=version+1,cancellation_reason=NULL WHERE id=$1",
        [a.order_id],
      ),
    );
  });
});
test('durable recent-session, daily-session and rolling order quotas cannot be bypassed by restarting service', async () => {
  await withDesk(async (ctx) => {
    await ctx.cloud.pool.query(
      "INSERT INTO test_actors(id,branch_id,token_hash,role,channel,expires_at) SELECT gen_random_uuid(),$1,encode(sha256(n::text::bytea),'hex'),'customer','mobile',clock_timestamp()+interval '1 hour' FROM generate_series(1,99)n",
      [TEST_BRANCH_ID],
    );
    await assert.rejects(
      new TestOrderFlow(ctx.cloud.pool, config).issueSession({ channel: 'kiosk' }),
      code('RATE_LIMITED'),
    );
    await ctx.cloud.pool.query(
      "UPDATE test_actors SET revoked_at=clock_timestamp() WHERE role='customer' AND id<>$1",
      [ctx.customer.session_id],
    );
    for (let i = 0; i < 20; i++) await ctx.make();
    const q = await ctx.flow.quote(ctx.customer.token, randomUUID(), cart);
    await assert.rejects(
      ctx.flow.createOrder(ctx.customer.token, randomUUID(), { quote_id: q.quote_id }),
      code('RATE_LIMITED'),
    );
    await ctx.cloud.pool.query(
      "INSERT INTO test_actors(id,branch_id,token_hash,role,channel,revoked_at,expires_at) SELECT gen_random_uuid(),$1,encode(sha256(('daily'||n)::bytea),'hex'),'customer','kiosk',clock_timestamp(),clock_timestamp()+interval '1 hour' FROM generate_series(1,100)n",
      [TEST_BRANCH_ID],
    );
    await assert.rejects(ctx.flow.issueSession({ channel: 'mobile' }), code('RATE_LIMITED'));
  });
});
test('targeted retention removes only test actors expired seven days ago and test cascades, not foundation data', async () => {
  await withDesk(async (ctx) => {
    await ctx.make();
    await ctx.cloud.pool.query(
      "UPDATE test_actors SET created_at=clock_timestamp()-interval '9 days',expires_at=clock_timestamp()-interval '8 days' WHERE id=$1",
      [ctx.customer.session_id],
    );
    const cleaned = await cleanupTestFlow(ctx.cloud.pool, config);
    assert.equal(cleaned.removed_actors, 1);
    for (const table of ['test_orders', 'test_quotes', 'test_command_results', 'test_outbox'])
      assert.equal(
        (await ctx.cloud.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count,
        '0',
      );
    assert.equal((await ctx.cloud.pool.query('SELECT count(*) FROM branches')).rows[0].count, '2');
    assert.equal((await ctx.flow.managerOrders(ctx.actors.manager.token)).orders.length, 0);
  });
});
test('HTTP refuses public staff issuance and unauthorized kitchen, validates bodies, and never labels simulation as real payment', async () => {
  await withDesk(async (ctx) => {
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
      for (const path of ['actors', 'staff', 'staff/sessions'])
        assert.equal(
          (
            await request(`${api.url}/v1/test/${path}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            })
          ).status,
          404,
        );
      assert.equal((await request(`${api.url}/v1/test/kitchen`)).status, 401);
      const headers = {
        Authorization: `Bearer ${ctx.customer.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      };
      assert.equal((await request(`${api.url}/v1/test/kitchen`, { headers })).status, 403);
      const qr = await request(`${api.url}/v1/test/quotes`, {
        method: 'POST',
        headers,
        body: JSON.stringify(cart),
      });
      assert.equal(qr.status, 201);
      const q = await qr.json();
      const created = await request(`${api.url}/v1/test/orders`, {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ quote_id: q.quote_id }),
      });
      assert.equal(created.status, 201);
      const order = TestOrderSchema.parse(await created.json());
      assert.equal(order.synthetic, true);
      assert.equal(order.payment_state, 'not_started');
      assert.equal(order.fiscal_state, 'not_applicable');
      const tamper = await request(`${api.url}/v1/test/quotes`, {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ ...cart, total_minor: '1' }),
      });
      assert.equal(tamper.status, 400);
      const legacyCatalog = await (await request(`${api.url}/v1/test/catalog`)).json();
      assert.equal(legacyCatalog.catalog_version, 'mockup-v0.2');
      assert.equal(legacyCatalog.products.length, 11);
      assert.deepEqual(
        Object.keys(legacyCatalog.products[0]).sort(),
        [
          'id',
          'name',
          'description',
          'category',
          'price_minor',
          'image_id',
          'prep_required',
        ].sort(),
      );
      assert.equal(legacyCatalog.products[0].price_minor, '349000');
      const completeCatalog = await (
        await request(`${api.url}/v1/test/catalog?catalog_version=mockup-v0.3`)
      ).json();
      assert.equal(completeCatalog.products.length, 24);
      assert.equal(completeCatalog.catalog_version, 'mockup-v0.3');
      assert.equal(completeCatalog.products[0].price_minor, '419000');
      assert.equal(
        (await request(`${api.url}/v1/test/catalog?catalog_version=future`)).status,
        400,
      );
      assert.equal(
        (
          await request(
            `${api.url}/v1/test/catalog?catalog_version=mockup-v0.3&catalog_version=mockup-v0.2`,
          )
        ).status,
        400,
      );
      const newQuote = await (
        await request(`${api.url}/v1/test/quotes?catalog_version=mockup-v0.3`, {
          method: 'POST',
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({
            catalog_version: 'mockup-v0.3',
            service_mode: 'takeaway',
            payment_method: 'kaspi',
            items: [
              {
                product_id: 'sauce',
                quantity: 1,
                selections: [{ group_id: 'size', option_id: 'size-2', quantity: 1 }],
              },
            ],
          }),
        })
      ).json();
      assert.equal(newQuote.catalog_version, 'mockup-v0.3');
      assert.equal(newQuote.total_minor, '149000');
      const newOrder = await (
        await request(`${api.url}/v1/test/orders?catalog_version=mockup-v0.3`, {
          method: 'POST',
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({ quote_id: newQuote.quote_id }),
        })
      ).json();
      const legacyRead = await (
        await request(`${api.url}/v1/test/orders/${newOrder.order_id}`, { headers })
      ).json();
      assert.equal(legacyRead.snapshot.catalog_version, 'mockup-v0.2');
      assert.equal(legacyRead.snapshot.lines[0].price_minor, '149000');
      assert.ok(legacyRead.snapshot.lines[0].name.includes('0,4 л'));
      assert.deepEqual(Object.keys(legacyRead.snapshot).sort(), Object.keys(q).sort());
      assert.deepEqual(
        Object.keys(legacyRead.snapshot.lines[0]).sort(),
        Object.keys(q.lines[0]).sort(),
      );
      const mixedLegacy = await (await request(`${api.url}/v1/test/orders`, { headers })).json();
      assert.ok(
        mixedLegacy.orders.every((item) => item.snapshot.catalog_version === 'mockup-v0.2'),
      );
      const oldOnNewClient = await (
        await request(`${api.url}/v1/test/orders/${order.order_id}?catalog_version=mockup-v0.3`, {
          headers,
        })
      ).json();
      assert.deepEqual(oldOnNewClient, order);
      const actual = await ctx.flow.readOrder(ctx.customer.token, newOrder.order_id);
      assert.deepEqual(actual.snapshot, newQuote);
    } finally {
      await api.app.close();
    }
  });
});
test('disabled or production config and non-synthetic branch binding cannot enable test flow', async () => {
  await withDesk(async (ctx) => {
    for (const c of [
      { enabled: false, environment: 'test' },
      { enabled: true, environment: 'production' },
    ])
      await assert.rejects(
        new TestOrderFlow(ctx.cloud.pool, c).issueSession({ channel: 'mobile' }),
        code('DISABLED'),
      );
    await ctx.cloud.pool.query(
      "UPDATE branches SET code='REAL',ordering_enabled=true WHERE id=$1",
      [TEST_BRANCH_ID],
    );
    await assert.rejects(ctx.flow.issueSession({ channel: 'mobile' }), code('BRANCH_UNAVAILABLE'));
  });
});

test('complete catalog prices distinct combo variants, snapshots choices and dispatches them independently', async () => {
  await withDesk(async (ctx) => {
    const catalog = ctx.flow.catalog('mockup-v0.3');
    assert.equal(catalog.products.length, 24);
    const selections = [
      { group_id: 'drink', option_id: 'lemonade', quantity: 1 },
      { group_id: 'sauce', option_id: 'hot', quantity: 1 },
      { group_id: 'extras', option_id: 'fingers', quantity: 2 },
      { group_id: 'extras', option_id: 'toast', quantity: 1 },
    ];
    const body = {
      catalog_version: 'mockup-v0.3',
      service_mode: 'dine_in',
      payment_method: 'card',
      items: [
        { product_id: 'pick-combo', quantity: 2, selections },
        {
          product_id: 'pick-combo',
          quantity: 1,
          selections: [
            { group_id: 'drink', option_id: 'cola-bottle', quantity: 1 },
            { group_id: 'sauce', option_id: 'pick', quantity: 1 },
          ],
        },
      ],
    };
    const { quote, order: created } = await ctx.make(ctx.customer, body);
    assert.equal(quote.lines[0].base_price_minor, '419000');
    assert.equal(quote.lines[0].price_minor, '616000');
    assert.equal(quote.total_minor, '1651000');
    assert.equal(quote.payment_method, 'card');
    assert.deepEqual(quote.estimated_minutes, { min: 10, max: 10 });
    assert.notEqual(quote.lines[0].line_id, quote.lines[1].line_id);
    assert.equal(
      quote.lines[0].selections.find((item) => item.option_id === 'fingers').quantity,
      2,
    );
    let order = await approve(ctx, created);
    const prep = order.tasks.filter((task) => task.station === 'prep');
    assert.equal(prep.length, 2);
    assert.ok(
      prep.some(
        (task) =>
          task.title.includes('Фирменный лимонад') &&
          task.title.includes('Фингерс, 1 шт × 2') &&
          task.title.includes('Острый соус'),
      ),
    );
    assert.ok(prep.some((task) => task.title.includes('Coca-Cola 0.5 л, бутылка')));
    await assert.rejects(complete(ctx, order, 'assembly'), code('CONFLICT'));
    order = await complete(ctx, order, 'prep');
    await assert.rejects(complete(ctx, order, 'assembly'), code('CONFLICT'));
    order = await complete(ctx, order, 'prep');
    order = await complete(ctx, order, 'assembly');
    assert.equal(order.state, 'ready');
    assert.deepEqual(order.snapshot, quote);
    const persisted = (
      await ctx.cloud.pool.query('SELECT snapshot FROM test_orders WHERE id=$1', [order.order_id])
    ).rows[0].snapshot;
    assert.deepEqual(persisted, quote);
    await assert.rejects(
      ctx.cloud.pool.query(
        "UPDATE test_quotes SET snapshot=jsonb_set(snapshot,'{lines,0,selections,0,option_label}','\"Forged\"') WHERE id=$1",
        [quote.quote_id],
      ),
    );
    await assert.rejects(
      ctx.cloud.pool.query(
        "UPDATE test_orders SET snapshot=jsonb_set(snapshot,'{lines,0,selections,0,option_label}','\"Forged\"'),version=version+1 WHERE id=$1",
        [order.order_id],
      ),
    );
  });
});

test('complete catalog enforces required selection quantities, availability, option limits and server-only prices', async () => {
  await withDesk(async (ctx) => {
    const base = {
      catalog_version: 'mockup-v0.3',
      service_mode: 'takeaway',
      items: [
        {
          product_id: 'pick-combo',
          quantity: 1,
          selections: [
            { group_id: 'drink', option_id: 'cola-bottle', quantity: 1 },
            { group_id: 'sauce', option_id: 'pick', quantity: 1 },
          ],
        },
      ],
    };
    const withSelections = (selections) => ({ ...base, items: [{ ...base.items[0], selections }] });
    for (const input of [
      withSelections([]),
      withSelections([
        ...base.items[0].selections,
        { group_id: 'drink', option_id: 'lemonade', quantity: 1 },
      ]),
      withSelections([
        { group_id: 'drink', option_id: 'fuse-watermelon', quantity: 1 },
        base.items[0].selections[1],
      ]),
      withSelections([
        ...base.items[0].selections,
        { group_id: 'extras', option_id: 'fingers', quantity: 11 },
      ]),
      withSelections([
        ...base.items[0].selections,
        { group_id: 'not-a-group', option_id: 'pick', quantity: 1 },
      ]),
      withSelections([
        ...base.items[0].selections,
        { group_id: 'sauce', option_id: 'not-an-option', quantity: 1 },
      ]),
      withSelections([...base.items[0].selections, { ...base.items[0].selections[1] }]),
      withSelections([
        { ...base.items[0].selections[0], price_delta_minor: '1' },
        base.items[0].selections[1],
      ]),
      { ...base, items: [{ ...base.items[0], price_minor: '1' }] },
      {
        ...base,
        items: [
          ...base.items,
          { ...base.items[0], selections: [...base.items[0].selections].reverse() },
        ],
      },
      {
        ...base,
        items: [{ product_id: 'finger-duo', quantity: 1, selections: base.items[0].selections }],
      },
      { ...base, payment_method: 'real-kaspi' },
    ])
      await assert.rejects(
        async () => ctx.flow.quote(ctx.customer.token, randomUUID(), input),
        code('INVALID_REQUEST'),
      );
    // All published fixtures have enough available defaults and can be priced.
    for (const product of ctx.flow.catalog('mockup-v0.3').products) {
      const selections = product.modifier_groups.flatMap((group) =>
        group.options
          .filter((option) => option.default_quantity)
          .map((option) => ({
            group_id: group.id,
            option_id: option.id,
            quantity: option.default_quantity,
          })),
      );
      const quote = await ctx.flow.quote(ctx.customer.token, randomUUID(), {
        ...base,
        items: [{ product_id: product.id, quantity: 1, selections }],
      });
      assert.equal(quote.total_minor, product.price_minor, product.id);
      assert.equal(quote.payment_method, 'kaspi');
      assert.equal(quote.lines[0].nutrition_provenance, 'source_mockup');
      assert.ok(quote.lines[0].description.length > 15);
      assert.equal(quote.lines[0].nutrition.basis, 'per_serving');
    }
  });
});

test('bounded visible TEST order history retains selected compositions without copying the entire option directory', async (t) => {
  await withDesk(async (ctx) => {
    const product = ctx.flow
      .catalog('mockup-v0.3')
      .products.find((item) => item.id === 'pick-combo');
    const selections = product.modifier_groups.flatMap((group) =>
      group.options
        .filter((option) => group.id === 'extras' || option.default_quantity)
        .map((option) => ({
          group_id: group.id,
          option_id: option.id,
          quantity: group.id === 'extras' ? option.max_quantity : option.default_quantity,
        })),
    );
    // Eleven distinct variants with every paid extra selected: the largest
    // visible per-customer response contains 20 orders × 11 such lines.
    const body = {
      catalog_version: 'mockup-v0.3',
      service_mode: 'takeaway',
      items: Array.from({ length: 11 }, (_, fingers) => ({
        product_id: product.id,
        quantity: 20,
        selections: selections
          .map((selection) =>
            selection.group_id === 'extras' && selection.option_id === 'fingers'
              ? { ...selection, quantity: fingers }
              : selection,
          )
          .filter((selection) => selection.quantity > 0),
      })),
    };
    for (let index = 0; index < 20; index++) await ctx.make(ctx.customer, body);
    const history = await ctx.flow.ownOrders(ctx.customer.token);
    const bytes = Buffer.byteLength(JSON.stringify(history));
    t.diagnostic(`20 orders × 11 detailed variants: ${bytes} UTF-8 JSON bytes`);
    assert.equal(history.orders.length, 20);
    assert.ok(bytes < 1024 * 1024, `Customer history ${bytes} bytes exceeds 1MiB safety budget`);
    assert.equal(history.orders[0].snapshot.lines.length, 11);
    for (const order of history.orders)
      for (const line of order.snapshot.lines) {
        assert.equal('modifier_groups' in line, false);
        assert.equal('ingredients' in line, false);
        assert.equal(line.nutrition_provenance, 'source_mockup');
        assert.ok(
          line.selections.some(
            (selection) =>
              selection.option_id === 'toast' &&
              selection.quantity === 10 &&
              selection.price_delta_minor === '39000',
          ),
        );
        assert.ok(
          line.selections.every((selection) => selection.group_label && selection.option_label),
        );
      }
    assert.ok(
      product.modifier_groups.find((group) => group.id === 'drink').options.length > 10,
      'Full choices remain available in the fresh catalog',
    );
    assert.ok(
      !JSON.stringify(history).includes('Fuse Tea Арбуз'),
      'Unselected catalog choices must not leak into every historical line',
    );
  });
});

test('unpaid TEST order dispatches atomically, preserves money state and follows whole-ticket kitchen statuses', async () => {
  await withDesk(async (ctx) => {
    const body = { ...cart, items: [...cart.items, { product_id: 'cheese-burger', quantity: 1 }] };
    // Use two distinct hot products from the actual test catalog.
    const products = ctx.flow.catalog().products.filter((p) => p.prep_required);
    body.items = products.slice(0, 2).map((p) => ({ product_id: p.id, quantity: 1 }));
    const quote = await ctx.flow.quote(ctx.customer.token, randomUUID(), body);
    const key = randomUUID();
    const input = { quote_id: quote.quote_id, execution_mode: 'unpaid_test' };
    const [created, replay] = await Promise.all([
      ctx.flow.createOrder(ctx.customer.token, key, input),
      ctx.flow.createOrder(ctx.customer.token, key, input),
    ]);
    assert.deepEqual(created, replay);
    assert.equal(created.state, 'preparing');
    assert.equal(created.payment_state, 'not_started');
    assert.equal(created.payment_attempt_id, null);
    assert.equal(created.fiscal_state, 'not_applicable');
    assert.equal(
      (await ctx.flow.kitchen(ctx.actors.prep.token)).orders[0].order_id,
      created.order_id,
    );
    await assert.rejects(approve(ctx, created), code('CONFLICT'));
    const prep = created.tasks.find((t) => t.station === 'prep');
    const assembly = created.tasks.find((t) => t.station === 'assembly');
    const command = { expected_version: created.version, complete_station: true };
    await assert.rejects(
      ctx.flow.completeTask(
        ctx.actors.assembly.token,
        randomUUID(),
        created.order_id,
        assembly.task_id,
        command,
      ),
      code('CONFLICT'),
    );
    await assert.rejects(
      ctx.flow.completeTask(
        ctx.customer.token,
        randomUUID(),
        created.order_id,
        prep.task_id,
        command,
      ),
      code('FORBIDDEN'),
    );
    await assert.rejects(
      ctx.flow.completeTask(
        ctx.actors.assembly.token,
        randomUUID(),
        created.order_id,
        prep.task_id,
        command,
      ),
      code('FORBIDDEN'),
    );
    const prepKey = randomUUID();
    const prepared = await ctx.flow.completeTask(
      ctx.actors.prep.token,
      prepKey,
      created.order_id,
      prep.task_id,
      command,
    );
    assert.ok(prepared.tasks.filter((t) => t.station === 'prep').every((t) => t.state === 'done'));
    assert.deepEqual(
      await ctx.flow.completeTask(
        ctx.actors.prep.token,
        prepKey,
        created.order_id,
        prep.task_id,
        command,
      ),
      prepared,
    );
    assert.equal(
      (await ctx.flow.readOrder(ctx.customer.token, created.order_id)).version,
      prepared.version,
    );
    const ready = await ctx.flow.completeTask(
      ctx.actors.assembly.token,
      randomUUID(),
      created.order_id,
      assembly.task_id,
      { expected_version: prepared.version, complete_station: true },
    );
    assert.equal(ready.state, 'ready');
    assert.equal((await ctx.flow.display(ctx.actors.display.token)).ready[0].number, ready.number);
    const done = await ctx.flow.handoff(ctx.actors.assembly.token, randomUUID(), created.order_id, {
      expected_version: ready.version,
    });
    assert.equal(
      (await ctx.flow.readOrder(ctx.customer.token, created.order_id)).state,
      'fulfilled',
    );
    assert.equal(done.payment_state, 'not_started');
    assert.equal(done.payment_attempt_id, null);
    assert.equal((await ctx.flow.display(ctx.actors.display.token)).ready.length, 0);
    await assert.rejects(
      ctx.cloud.pool.query(
        "UPDATE test_orders SET execution_mode='simulated_payment',version=version+1 WHERE id=$1",
        [created.order_id],
      ),
    );
  });
});

test('unpaid dispatch and tasks roll back together when durable outbox fails', async () => {
  await withDesk(async (ctx) => {
    const quote = await ctx.flow.quote(ctx.customer.token, randomUUID(), cart);
    await ctx.cloud.pool.query(
      "CREATE FUNCTION reject_unpaid_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='test.order.submitted_unpaid' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_unpaid BEFORE INSERT ON test_outbox FOR EACH ROW EXECUTE FUNCTION reject_unpaid_event()",
    );
    const key = randomUUID(),
      body = { quote_id: quote.quote_id, execution_mode: 'unpaid_test' };
    await assert.rejects(ctx.flow.createOrder(ctx.customer.token, key, body));
    for (const table of ['test_orders', 'test_kitchen_tasks', 'test_outbox'])
      assert.equal(
        (await ctx.cloud.pool.query('SELECT count(*)::int n FROM ' + table)).rows[0].n,
        0,
      );
    await ctx.cloud.pool.query('DROP TRIGGER reject_unpaid ON test_outbox');
    assert.equal((await ctx.flow.createOrder(ctx.customer.token, key, body)).state, 'preparing');
  });
});
